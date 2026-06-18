# shellcheck shell=bash
# task-dag extension: CI-driven broken-master auto-repair (virusdave/task-dag#1,
# dev-loop epic virusdave/top-level#26 phase 2). Authoritative design:
# virusdave/top-level:docs/designs/ci-broken-master-auto-repair.md.
#
# This module is sourced by scripts/task-dag (see the task-dag.d loader). It
# hosts the CLI surface for the auto-repair subsystem; commands are registered
# in main()'s case statement in the parent script.
#
# Implemented so far:
#   * parse-tree-fix  — parse Tree-Fix / Tree-Fix-Chain / Tree-Fix-Mode commit
#                       trailers (design section 3) via `git interpret-trailers`.
# (Chain-state, classifier core, ticket/escalation, worker verifier, and the
#  reusable workflow are the other leaves of #1.)

# ---------------------------------------------------------------------------
# parse-tree-fix
#
# A repair worker marks its fix commit with trailers the classifier interprets:
#
#   Tree-Fix: owner/repo#123          # the repair ticket
#   Tree-Fix-Chain: <first-red-full-sha>
#   Tree-Fix-Mode: initial            # or: continue
#
# This parser extracts and validates them. It is pure and side-effect-free:
# it reads a commit message (from a commit-ish, default HEAD, or from --stdin)
# and writes only to stdout/stderr; it mutates no refs.
#
# Trailers are parsed with `git interpret-trailers --parse` (NOT freeform grep),
# so it honours the same trailer grammar `git` itself uses.
#
# Exit codes:
#   0  parsed successfully (whether or not the commit is a tree-fix; check the
#      treeFix flag / output)
#   2  malformed tree-fix commit (a Tree-Fix trailer is present but the trio is
#      incomplete, a value is invalid, or a trailer is duplicated)
#   1  usage / resolution error
# ---------------------------------------------------------------------------
cmd_parse_tree_fix() {
    local commitish="" use_stdin=false as_json=false

    while [ $# -gt 0 ]; do
        case "$1" in
            --stdin) use_stdin=true; shift ;;
            --json) as_json=true; shift ;;
            --help|-h)
                cat <<'EOF'
Usage: task-dag parse-tree-fix [<commit-ish>] [--stdin] [--json]

Parse the Tree-Fix / Tree-Fix-Chain / Tree-Fix-Mode trailers of a commit
message (broken-master auto-repair, design section 3), using
`git interpret-trailers`. Pure: reads a message, mutates nothing.

Sources (pick one):
  <commit-ish>   read the message of this commit (default: HEAD)
  --stdin        read the raw commit message from stdin instead

Options:
  --json         emit machine-readable JSON

Output (human): "not a tree-fix commit", or the three trailer lines.
Output (--json): {"treeFix":false} or
                 {"treeFix":true,"ticket":"owner/repo#N","chain":"<sha>","mode":"initial|continue"}

Exit: 0 parsed (tree-fix or not); 2 malformed tree-fix; 1 usage/resolve error.
EOF
                return 0
                ;;
            -*)
                echo "Unknown option: $1" >&2
                return 1
                ;;
            *)
                if [ -z "$commitish" ]; then
                    commitish="$1"
                else
                    echo "Error: unexpected extra argument '$1'" >&2
                    return 1
                fi
                shift
                ;;
        esac
    done

    # Obtain the commit message.
    local message
    if [ "$use_stdin" = true ]; then
        if [ -n "$commitish" ]; then
            echo "Error: pass either <commit-ish> or --stdin, not both" >&2
            return 1
        fi
        message="$(cat)"
    else
        local sha
        sha="$(resolve_sha "${commitish:-HEAD}")" || return 1
        message="$(git log -1 --format='%B' "$sha")"
    fi

    # Extract only the trailer block. `--parse` emits one "Key: value" line per
    # recognised trailer (folding multi-line values), and nothing else.
    local trailers
    trailers="$(printf '%s\n' "$message" | git interpret-trailers --parse 2>/dev/null)"

    # Count + collect each key (case-insensitive on the token, as git does).
    local key
    local -A count=()
    local fix="" chain="" mode=""
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        key="${line%%:*}"
        local val="${line#*: }"
        case "$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')" in
            tree-fix)       count[fix]=$(( ${count[fix]:-0} + 1 ));       fix="$val" ;;
            tree-fix-chain) count[chain]=$(( ${count[chain]:-0} + 1 ));   chain="$val" ;;
            tree-fix-mode)  count[mode]=$(( ${count[mode]:-0} + 1 ));     mode="$val" ;;
        esac
    done <<< "$trailers"

    # No Tree-Fix trailer at all: this is simply not a tree-fix commit.
    if [ "${count[fix]:-0}" -eq 0 ]; then
        # A stray chain/mode without a Tree-Fix is malformed, not "absent".
        if [ "${count[chain]:-0}" -gt 0 ] || [ "${count[mode]:-0}" -gt 0 ]; then
            echo "Error: Tree-Fix-Chain/Tree-Fix-Mode present without a Tree-Fix trailer" >&2
            return 2
        fi
        if [ "$as_json" = true ]; then
            echo '{"treeFix":false}'
        else
            echo "not a tree-fix commit"
        fi
        return 0
    fi

    # A tree-fix commit MUST carry exactly one of each of the three trailers.
    if [ "${count[fix]:-0}" -gt 1 ] || [ "${count[chain]:-0}" -gt 1 ] || [ "${count[mode]:-0}" -gt 1 ]; then
        echo "Error: duplicate Tree-Fix* trailer(s) (fix=${count[fix]:-0} chain=${count[chain]:-0} mode=${count[mode]:-0})" >&2
        return 2
    fi
    if [ "${count[chain]:-0}" -ne 1 ] || [ "${count[mode]:-0}" -ne 1 ]; then
        echo "Error: a Tree-Fix commit must carry Tree-Fix, Tree-Fix-Chain and Tree-Fix-Mode" >&2
        return 2
    fi

    # Validate each value's shape.
    if ! printf '%s' "$fix" | grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+#[0-9]+$'; then
        echo "Error: Tree-Fix must be 'owner/repo#N' (got '$fix')" >&2
        return 2
    fi
    if ! printf '%s' "$chain" | grep -Eq '^[0-9a-f]{40,64}$'; then
        echo "Error: Tree-Fix-Chain must be a full commit SHA (got '$chain')" >&2
        return 2
    fi
    if [ "$mode" != "initial" ] && [ "$mode" != "continue" ]; then
        echo "Error: Tree-Fix-Mode must be 'initial' or 'continue' (got '$mode')" >&2
        return 2
    fi

    if [ "$as_json" = true ]; then
        printf '{"treeFix":true,"ticket":"%s","chain":"%s","mode":"%s"}\n' "$fix" "$chain" "$mode"
    else
        printf 'Tree-Fix: %s\nTree-Fix-Chain: %s\nTree-Fix-Mode: %s\n' "$fix" "$chain" "$mode"
    fi
    return 0
}

# ---------------------------------------------------------------------------
# classify  (CI broken-master auto-repair, design §2 + §4)
#
# The classifier CORE: given a CI result for one commit on <owner/repo>@<branch>,
# classify the aggregate required-gate result as green/red/unknown and drive the
# repair-chain state machine on top of the chain-read/chain-write primitives:
#
#   * RED, no chain open      -> OPEN one chain anchored at First-Red=<for-sha>
#                                (Repair-Mode=initial, Repair-Attempt=1). The
#                                caller should now file exactly ONE repair
#                                ticket (action=open).
#   * RED, chain already open -> CONTINUATION: advance Current-Head to <for-sha>
#                                (First-Red unchanged). One chain per red streak.
#   * GREEN, and <for-sha> is the CURRENT branch HEAD -> CLOSE the open chain
#                                (State=green, Last-Green=<for-sha>, clear the
#                                repair fields). The caller closes the ticket
#                                (action=close).
#   * GREEN, but NOT current  -> do nothing: a newer commit may yet be red, so
#                                we "close green only when current" (design §4).
#   * UNKNOWN                  -> leave chain state untouched (a transient
#                                unknown must not close an open red chain).
#
# Design §4 race/stale handling. We act RELATIVE TO THE CURRENT origin/<branch>
# HEAD and IGNORE SUPERSEDED SHAs:
#   - currency is established against the live branch tip (origin ls-remote, or
#     --current-head for offline/deterministic callers). We act ONLY when
#     <for-sha> IS that tip; any other SHA is a run the branch has already
#     moved on from and is treated as superseded;
#   - if the tip cannot be established we FAIL CLOSED (exit 4) rather than
#     mutate chain state off an unknown HEAD (override: --allow-stale);
#   - a RED that is not current is a superseded/out-of-order CI run and is
#     IGNORED (exit 6) unless --allow-stale;
#   - a GREEN that is not current never closes (or records on) a chain;
#   - every mutating write is CAS-bound to the chain state this command read
#     (chain-write --expect-old) AND rides chain-write's own ancestry stale
#     guard, so a concurrent classifier or an out-of-order run can never
#     clobber newer chain state (it loses the CAS and returns 5).
#
# This command owns ONLY the classification + chain open/update/close decision.
# Filing/closing the actual GitHub repair ticket and the tree-fix continue-mode
# escalation are separate leaves of #1; this command reports the required ticket
# action (open|close|none) so its caller can perform it idempotently.
#
# Usage:
#   task-dag classify <owner/repo> <branch> --for-sha=<commit>
#       (--result=green|red|unknown | --gate=<conclusion> [--gate=...])
#       [--current-head=<sha>] [--repair-issue=<n>] [--allow-stale]
#       [--dry-run] [--json] [--no-fetch]
#
# Exit codes:
#   0  classified; the resulting action was applied (or a valid no-op)
#   1  argument error
#   4  git/origin error (unreachable, or a write could not be confirmed)
#   5  lost the chain-write CAS race (a concurrent writer won)
#   6  superseded/stale: ignored relative to the current branch HEAD
# ---------------------------------------------------------------------------

# Aggregate individual required-gate conclusions into green/red/unknown.
# Red dominates (any failing required gate => red); otherwise any gate that is
# neither clearly-passing nor clearly-failing (pending/empty/stale/...) makes
# the aggregate unknown; only an all-passing set is green.
_ci_aggregate_gates() {
    local c lc any_unknown=false saw=false
    for c in "$@"; do
        saw=true
        lc="$(printf '%s' "$c" | tr '[:upper:]' '[:lower:]')"
        case "$lc" in
            failure|cancelled|timed_out|action_required|startup_failure)
                printf 'red'; return 0 ;;
            success|skipped|neutral) ;;
            *) any_unknown=true ;;
        esac
    done
    if [ "$saw" = false ] || [ "$any_unknown" = true ]; then
        printf 'unknown'
    else
        printf 'green'
    fi
}

cmd_classify() {
    local repo="" branch="" for_sha="" result="" current_head="" repair_issue=""
    local allow_stale=false dry_run=false json=false do_fetch=true
    local -a gates=()

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --for-sha=*) for_sha="${1#*=}"; shift ;;
            --result=*) result="${1#*=}"; shift ;;
            --gate=*) gates+=("${1#*=}"); shift ;;
            --gate)
                shift
                [ $# -gt 0 ] || { echo "Error: --gate requires a value" >&2; return 1; }
                gates+=("$1"); shift ;;
            --current-head=*) current_head="${1#*=}"; shift ;;
            --repair-issue=*) repair_issue="${1#*=}"; shift ;;
            --allow-stale) allow_stale=true; shift ;;
            --dry-run) dry_run=true; shift ;;
            --json) json=true; shift ;;
            --no-fetch) do_fetch=false; shift ;;
            --help | -h)
                cat <<EOF
Usage: task-dag classify <owner/repo> <branch> --for-sha=<commit> \\
         (--result=green|red|unknown | --gate=<conclusion> [--gate=...]) [options]

CI broken-master auto-repair classifier core (design §2 + §4). Classifies a
commit's aggregate required-gate result and drives the repair-chain state
machine (open one chain per red streak anchored at First-Red, advance
Current-Head on continuation reds, close on green only when current). Acts
relative to the current origin/<branch> HEAD and ignores superseded SHAs.

Result (pick one):
  --result=<v>         green | red | unknown (precomputed aggregate)
  --gate=<conclusion>  a required-gate conclusion (repeatable); aggregated as
                       red (any failure) > unknown (any pending/other) > green

Options:
  --for-sha=<commit>   REQUIRED; the commit this CI run is about
  --current-head=<sha> the live branch tip (default: origin ls-remote)
  --repair-issue=<n>   record the repair ticket number on a freshly-opened chain
  --allow-stale        act even when --for-sha is superseded by the branch tip
  --dry-run            compute + report the action without writing chain state
  --json               machine-readable result
  --no-fetch           skip fetching the prior chain ref / branch tip object

Reported action: open | continue | close | noop-green-noncurrent |
                 noop-unknown | noop-green-nochain
Ticket hint:     open (file ONE repair ticket) | close (close it) | none

Exit: 0 applied/no-op  1 args  4 git/origin  5 CAS race  6 superseded/stale.
EOF
                return 0
                ;;
            -*) echo "Unknown option: $1" >&2; return 1 ;;
            *)
                if [ -z "$repo" ]; then repo="$1"
                elif [ -z "$branch" ]; then branch="$1"
                else echo "Unexpected argument: $1" >&2; return 1
                fi
                shift
                ;;
        esac
    done

    if [ -z "$repo" ] || [ -z "$branch" ]; then
        echo "Error: <owner/repo> and <branch> are required" >&2
        return 1
    fi
    if [ -z "$for_sha" ]; then
        echo "Error: --for-sha=<commit> is required" >&2
        return 1
    fi
    if [ -z "$result" ] && [ "${#gates[@]}" -eq 0 ]; then
        echo "Error: pass --result=<v> or at least one --gate=<conclusion>" >&2
        return 1
    fi
    if [ -n "$result" ] && [ "${#gates[@]}" -gt 0 ]; then
        echo "Error: pass either --result or --gate(s), not both" >&2
        return 1
    fi

    # Resolve --for-sha to a full local commit object (same contract as
    # chain-write: junk/abbreviated/remote-only SHAs are rejected up front so
    # they can never poison Current-Head or the ancestry checks below).
    local for_sha_full
    if ! for_sha_full="$(git rev-parse --verify --quiet "${for_sha}^{commit}" 2>/dev/null)"; then
        echo "Error: --for-sha must resolve to a commit object present locally (got '$for_sha')" >&2
        return 1
    fi
    for_sha="$for_sha_full"

    # Aggregate the classification.
    if [ -z "$result" ]; then
        result="$(_ci_aggregate_gates "${gates[@]}")"
    fi
    case "$result" in
        green | red | unknown) ;;
        *) echo "Error: --result must be green|red|unknown (got '$result')" >&2; return 1 ;;
    esac

    # ── Currency (design §4): act relative to the current branch HEAD ──────
    # Establish the LIVE branch tip so we can tell a current run from a stale,
    # superseded one. Prefer an explicit --current-head (offline/deterministic
    # callers + tests); otherwise read it from origin. We act ONLY on the
    # commit that is the current tip: any other --for-sha is, by definition, a
    # run the branch has already moved on from (out-of-order / superseded), so
    # it is ignored unless --allow-stale. This is the fail-closed reading of
    # "act relative to the current origin/<branch> HEAD; ignore superseded
    # SHAs": we never mutate chain state off a tip we could not establish.
    local tip="" tip_known=false
    if [ -n "$current_head" ]; then
        tip="$(git rev-parse --verify --quiet "${current_head}^{commit}" 2>/dev/null || true)"
        if [ -z "$tip" ]; then
            if printf '%s' "$current_head" | grep -Eq '^[0-9a-f]{40,64}$'; then
                tip="$current_head"
            else
                echo "Error: --current-head must resolve to a commit or be a full SHA (got '$current_head')" >&2
                return 1
            fi
        fi
        tip_known=true
    else
        local lsr
        if lsr="$(git ls-remote origin "refs/heads/${branch}" 2>/dev/null)"; then
            tip="$(printf '%s' "$lsr" | awk '{print $1; exit}')"
            [ -n "$tip" ] && tip_known=true
        fi
    fi

    # is_current: for_sha IS the live branch tip. If the tip is indeterminate
    # (origin unreachable, branch absent) we cannot prove currency: fail closed
    # (refuse to act) unless the operator forces it with --allow-stale. Note
    # is_current stays the pure currency fact; --allow-stale is applied in the
    # decision below so it can force a non-current write through deliberately.
    local is_current=false
    if [ "$tip_known" = true ]; then
        [ "$tip" = "$for_sha" ] && is_current=true
    elif [ "$allow_stale" = false ]; then
        echo "Error: cannot determine the live HEAD of $repo@$branch; pass --current-head or --allow-stale" >&2
        return 4
    fi

    # ── Prior chain state ─────────────────────────────────────────────────
    local ref old=""
    ref="$(_cichain_ref "$repo" "$branch")"
    if [ "$do_fetch" = true ]; then
        if old="$(_cichain_remote_sha "$ref")"; then
            [ -n "$old" ] && _cichain_fetch "$ref"
        else
            old="$(git rev-parse --verify --quiet "$ref" 2>/dev/null || true)"
        fi
    else
        old="$(git rev-parse --verify --quiet "$ref" 2>/dev/null || true)"
    fi
    local prior_state="" prior_first_red="" chain_open=false
    if [ -n "$old" ]; then
        prior_state="$(_cichain_field "$old" State)"
        prior_first_red="$(_cichain_field "$old" First-Red)"
        [ "$prior_state" = "red" ] && chain_open=true
    fi

    # ── Decide the action ─────────────────────────────────────────────────
    # Every mutating decision is CAS-bound to the chain SHA we just read
    # (--expect-old="$old"): if a concurrent classifier moves the chain between
    # our read and our write, chain-write returns 5 and we surface it (the
    # caller retries from fresh state) rather than clobbering it. This is what
    # keeps "one chain per red streak / one repair ticket" true under races.
    local action="" ticket="none"
    local -a write_args=()
    case "$result" in
        red)
            if [ "$is_current" = false ] && [ "$allow_stale" = false ]; then
                # Superseded / out-of-order run: the branch already moved past
                # this SHA. Ignore it (design §4) unless --allow-stale.
                action="noop-stale"
            elif [ "$chain_open" = true ]; then
                # Continuation red: advance Current-Head, keep the chain + its
                # First-Red. One chain per red streak.
                action="continue"
                write_args=(--state=red)
            else
                # Fresh red streak: open ONE chain anchored at First-Red here.
                action="open"
                ticket="open"
                write_args=(--state=red --first-red="$for_sha"
                            --repair-mode=initial --repair-attempt=1)
                [ -n "$repair_issue" ] && write_args+=(--repair-issue="$repair_issue")
            fi
            ;;
        green)
            if [ "$is_current" = false ] && [ "$allow_stale" = false ]; then
                # Green but not current: a newer commit may be red; never close
                # or record off a stale green. "Close green only when current."
                action="noop-green-noncurrent"
            elif [ "$chain_open" = true ]; then
                # Close the chain: green AND current (design §4).
                action="close"
                ticket="close"
                write_args=(--state=green --last-green="$for_sha"
                            --set First-Red= --set Repair-Mode=
                            --set Repair-Issue= --set Repair-Attempt=)
            else
                # No open chain, current green: record the green watermark.
                action="noop-green-nochain"
                write_args=(--state=green --last-green="$for_sha")
            fi
            ;;
        unknown)
            # Unknown classification: never opens, advances, or closes a chain.
            action="noop-unknown"
            ;;
    esac

    # ── Report ────────────────────────────────────────────────────────────
    # NB: the ticket hint (open|close) is valid ONLY when applied=true (the
    # chain transition actually landed). A failed/aborted write reports
    # ticket=none + applied=false so a ticket leaf that parses JSON can never
    # file/close off a write that did not happen.
    _classify_report() { # <rc> <applied:true|false>
        local rc="$1" applied="$2" tk="$ticket"
        [ "$applied" = true ] || tk="none"
        if [ "$json" = true ]; then
            printf '{"result":"%s","action":"%s","ticket":"%s","current":%s,"applied":%s,"ref":"%s","forSha":"%s","firstRed":"%s","priorState":"%s","rc":%s}\n' \
                "$result" "$action" "$tk" "$is_current" "$applied" \
                "$(_cichain_jstr "$ref")" "$for_sha" \
                "$(_cichain_jstr "${prior_first_red:-}")" "$(_cichain_jstr "${prior_state:-}")" "$rc"
        else
            printf "${BOLD}classify %s@%s${RESET} result=%s action=%s ticket=%s (current=%s applied=%s rc=%s)\n" \
                "$repo" "$branch" "$result" "$action" "$tk" "$is_current" "$applied" "$rc"
        fi
    }

    if [ "$action" = "noop-stale" ]; then
        [ "$json" = false ] && printf "${YELLOW}Superseded CI run: %s is not the current %s HEAD — ignoring (design §4).${RESET}\n" "$for_sha" "$branch" >&2
        _classify_report 6 false
        return 6
    fi

    # Pure no-ops (nothing to persist): unknown, and green-but-not-current.
    if [ "${#write_args[@]}" -eq 0 ]; then
        _classify_report 0 false
        return 0
    fi

    if [ "$dry_run" = true ]; then
        [ "$json" = false ] && printf "${BLUE}(dry-run: would chain-write %s)${RESET}\n" "${write_args[*]}" >&2
        _classify_report 0 false
        return 0
    fi

    # ── Apply via the CAS/stale-safe primitive ────────────────────────────
    # --expect-old binds this write to the state we read; --allow-stale (when
    # set) additionally bypasses chain-write's own ancestry stale guard.
    local -a extra=(--expect-old="$old")
    [ "$allow_stale" = true ] && extra+=(--allow-stale)
    local wrc=0 wout
    wout="$(cmd_chain_write "$repo" "$branch" --for-sha="$for_sha" --json \
        "${extra[@]}" "${write_args[@]}" 2>&1)" || wrc=$?

    if [ "$wrc" -ne 0 ]; then
        # Map chain-write's exit codes through unchanged (5 race/expect-mismatch,
        # 6 stale, 4 git). applied=false => ticket hint suppressed.
        if [ "$json" = false ]; then
            printf "${RED}classify: chain-write failed (rc=%s) for %s@%s action=%s${RESET}\n" \
                "$wrc" "$repo" "$branch" "$action" >&2
            printf '%s\n' "$wout" >&2
        else
            _classify_report "$wrc" false
        fi
        return "$wrc"
    fi

    _classify_report 0 true
    return 0
}

# ---------------------------------------------------------------------------
# verify-target  (CI broken-master auto-repair, design §6 + §7)
#
# The WORKER VERIFIER: a read-only, fail-closed preflight a repair worker runs
# BEFORE it spends effort fixing a broken master. It answers exactly one
# question — "is my target still the current, first-red, unclaimed chain head?"
# — so a worker never hand-implements the §6 currency contract and never burns
# work on a chain that has since closed, escalated, or been claimed by a peer.
#
# It is PURE: it reads the authoritative chain-state ref on origin (and, when
# asked, the authoritative claim ref) and mutates nothing. Origin is the source
# of truth; if origin cannot be reached it FAILS CLOSED (a worker must not act
# on a stale local view of whether its target is still live).
#
# A repair worker's "target" is the chain it was dispatched to fix, identified
# by the chain anchor First-Red (the same value its eventual fix commit records
# as `Tree-Fix-Chain:`). The gate passes only when ALL of these hold:
#
#   * a chain exists for <owner/repo>@<branch>;
#   * State == red             (the chain is still OPEN — not closed green);
#   * First-Red == --target-sha (it is the SAME chain, still anchored here —
#                                not a fresh chain opened after a close);
#   * Repair-Issue  == --repair-issue   (if given: same repair ticket);
#   * Repair-Mode   == --mode           (if given: initial vs continue);
#   * Repair-Attempt== --attempt        (if given: not superseded by a retry);
#   * no active claim exists for --task  (if given: nobody else owns it).
#
# Any failure means the worker MUST NOT proceed: its target is no longer the
# current first-red unclaimed chain head.
#
# Usage:
#   task-dag verify-target <owner/repo> <branch> --target-sha=<sha>
#       [--repair-issue=<n>] [--mode=initial|continue] [--attempt=<n>]
#       [--task=<task-sha>] [--json] [--no-fetch]
#
# Exit codes:
#   0  verified — the target is the current first-red unclaimed chain head
#   1  argument error
#   3  no chain state exists for this repo/branch (nothing to repair)
#   4  origin unreachable / git error — fail closed
#   5  the repair task is already claimed by another worker
#   6  not the current first-red head (closed, escalated, or wrong chain)
# ---------------------------------------------------------------------------
cmd_verify_target() {
    local repo="" branch="" target="" repair_issue="" mode="" attempt="" task=""
    local json=false do_fetch=true

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --target-sha=*) target="${1#*=}"; shift ;;
            --repair-issue=*) repair_issue="${1#*=}"; shift ;;
            --mode=*) mode="${1#*=}"; shift ;;
            --attempt=*) attempt="${1#*=}"; shift ;;
            --task=*) task="${1#*=}"; shift ;;
            --json) json=true; shift ;;
            --no-fetch) do_fetch=false; shift ;;
            --help | -h)
                cat <<EOF
Usage: task-dag verify-target <owner/repo> <branch> --target-sha=<sha> [options]

CI broken-master auto-repair WORKER VERIFIER (design §6 + §7). A read-only,
fail-closed preflight a repair worker runs before fixing a broken master: it
confirms its target is still the current, first-red, unclaimed chain head.
Origin is the source of truth; mutates nothing; fails closed if unreachable.

Required:
  --target-sha=<sha>   the chain anchor (First-Red) the worker is repairing

Options (each, when given, must match the live chain state):
  --repair-issue=<n>   the repair ticket recorded on the chain
  --mode=<m>           expected Repair-Mode: initial | continue
  --attempt=<n>        expected Repair-Attempt (catches a superseding retry)
  --task=<task-sha>    repair task SHA; fail if another worker holds its claim
  --json               machine-readable result
  --no-fetch           read the last-known LOCAL chain ref (no origin round-trip)

Passes (exit 0) only when: a chain exists, State=red, First-Red=target, and
every supplied --repair-issue/--mode/--attempt matches and --task is unclaimed.

Exit: 0 verified  1 args  3 no chain  4 origin/git (fail closed)
      5 claimed by another worker  6 not the current first-red head.
EOF
                return 0
                ;;
            -*) echo "Unknown option: $1" >&2; return 1 ;;
            *)
                if [ -z "$repo" ]; then repo="$1"
                elif [ -z "$branch" ]; then branch="$1"
                else echo "Unexpected argument: $1" >&2; return 1
                fi
                shift
                ;;
        esac
    done

    if [ -z "$repo" ] || [ -z "$branch" ]; then
        echo "Error: <owner/repo> and <branch> are required" >&2
        return 1
    fi
    if [ -z "$target" ]; then
        echo "Error: --target-sha=<sha> is required" >&2
        return 1
    fi
    if [ -n "$mode" ] && [ "$mode" != "initial" ] && [ "$mode" != "continue" ]; then
        echo "Error: --mode must be 'initial' or 'continue' (got '$mode')" >&2
        return 1
    fi

    # Normalise the target to a full commit SHA when the object is present
    # locally (same contract as classify/chain-write); otherwise accept a bare
    # full SHA literally so a worker on a shallow checkout can still verify.
    local target_full
    if target_full="$(git rev-parse --verify --quiet "${target}^{commit}" 2>/dev/null)"; then
        target="$target_full"
    elif ! printf '%s' "$target" | grep -Eq '^[0-9a-f]{40,64}$'; then
        echo "Error: --target-sha must resolve to a commit object or be a full SHA (got '$target')" >&2
        return 1
    fi

    # ── Read the authoritative chain state ────────────────────────────────
    # Origin is the source of truth. Fail closed if it cannot be reached:
    # a worker must never decide it is still the live target from stale local
    # state. --no-fetch is the explicit "read my last-known local ref" override.
    local ref sha=""
    ref="$(_cichain_ref "$repo" "$branch")"
    if [ "$do_fetch" = true ]; then
        if sha="$(_cichain_remote_sha "$ref")"; then
            [ -n "$sha" ] && _cichain_fetch "$ref"
        else
            if [ "$json" = true ]; then
                printf '{"ok":false,"reason":"origin-error","repo":"%s","branch":"%s","ref":"%s","rc":4}\n' \
                    "$(_cichain_jstr "$repo")" "$(_cichain_jstr "$branch")" "$(_cichain_jstr "$ref")"
            else
                printf "${RED}verify-target: cannot reach origin for %s@%s — failing closed.${RESET}\n" "$repo" "$branch" >&2
            fi
            return 4
        fi
    else
        sha="$(git rev-parse --verify --quiet "$ref" 2>/dev/null || true)"
    fi

    # Fields (empty when the chain is absent).
    local state="" first_red="" current_head="" last_green=""
    local r_issue="" r_mode="" r_attempt=""
    if [ -n "$sha" ]; then
        state="$(_cichain_field "$sha" State)"
        first_red="$(_cichain_field "$sha" First-Red)"
        current_head="$(_cichain_field "$sha" Current-Head)"
        last_green="$(_cichain_field "$sha" Last-Green)"
        r_issue="$(_cichain_field "$sha" Repair-Issue)"
        r_mode="$(_cichain_field "$sha" Repair-Mode)"
        r_attempt="$(_cichain_field "$sha" Repair-Attempt)"
    fi

    # ── Claim state (optional) ────────────────────────────────────────────
    # Claims live at refs/heads/tasks/active/<short> on origin (origin is
    # authoritative; local refs may lag). A present claim means another worker
    # already owns the repair task.
    local claimed=false claim_short=""
    if [ -n "$task" ]; then
        claim_short="${task:0:7}"
        if [ "$(task_is_claimed_on_remote "$claim_short")" = "yes" ]; then
            claimed=true
        fi
    fi

    # ── Verdict ───────────────────────────────────────────────────────────
    local ok=false reason="" rc=0
    if [ -z "$sha" ]; then
        reason="no-chain"; rc=3
    elif [ "$state" != "red" ]; then
        reason="not-red"; rc=6
    elif [ "$first_red" != "$target" ]; then
        reason="not-first-red"; rc=6
    elif [ -n "$repair_issue" ] && [ "$r_issue" != "$repair_issue" ]; then
        reason="repair-issue-mismatch"; rc=6
    elif [ -n "$mode" ] && [ "$r_mode" != "$mode" ]; then
        reason="repair-mode-mismatch"; rc=6
    elif [ -n "$attempt" ] && [ "$r_attempt" != "$attempt" ]; then
        reason="repair-attempt-mismatch"; rc=6
    elif [ "$claimed" = true ]; then
        reason="claimed"; rc=5
    else
        ok=true; reason="current-first-red-unclaimed"; rc=0
    fi

    if [ "$json" = true ]; then
        printf '{"ok":%s,"reason":"%s","repo":"%s","branch":"%s","ref":"%s","targetSha":"%s","chainCommit":"%s","state":"%s","firstRed":"%s","currentHead":"%s","lastGreen":"%s","repairIssue":"%s","repairMode":"%s","repairAttempt":"%s","claimed":%s,"rc":%s}\n' \
            "$ok" "$reason" \
            "$(_cichain_jstr "$repo")" "$(_cichain_jstr "$branch")" "$(_cichain_jstr "$ref")" \
            "$target" "${sha:-}" \
            "$(_cichain_jstr "$state")" "$(_cichain_jstr "$first_red")" \
            "$(_cichain_jstr "$current_head")" "$(_cichain_jstr "$last_green")" \
            "$(_cichain_jstr "$r_issue")" "$(_cichain_jstr "$r_mode")" "$(_cichain_jstr "$r_attempt")" \
            "$claimed" "$rc"
    else
        if [ "$ok" = true ]; then
            printf "${GREEN}✓ verify-target %s@%s${RESET} target=%s is the current first-red unclaimed chain head (mode=%s attempt=%s issue=%s)\n" \
                "$repo" "$branch" "$target" "$r_mode" "$r_attempt" "$r_issue"
        else
            printf "${YELLOW}✗ verify-target %s@%s${RESET} target=%s NOT the current first-red unclaimed chain head: %s (state=%s firstRed=%s claimed=%s rc=%s)\n" \
                "$repo" "$branch" "$target" "$reason" "${state:-none}" "${first_red:-none}" "$claimed" "$rc" >&2
        fi
    fi
    return "$rc"
}

# ---------------------------------------------------------------------------
# repair-ticket  (CI broken-master auto-repair, design §4 item: idempotent
# repair ticket — scope item #4 of virusdave/task-dag#1)
#
# Reconcile the GitHub repair TICKET with the current CI repair-chain state
# for <owner/repo>@<branch>, so that there is EXACTLY ONE open
# `ci-broken-master` + `priority:high` ticket per open red chain. Creating
# that issue is the ingestion point: the existing issue-to-task sync mints it
# as a pickable task. This command is the side of the subsystem that touches
# GitHub; `classify` (§2) only drives the durable chain state and reports a
# ticket hint (open|close), it never calls GitHub itself.
#
# It is fully IDEMPOTENT and self-contained — safe to run repeatedly and
# concurrently. The chain ref (origin) is the source of truth for desired
# state; GitHub (queried by label + a hidden chain marker) is the authority
# for which ticket already exists. The chain's Repair-Issue field is only a
# best-effort cache + a compare-and-set CREATE LEASE; it is never trusted on
# its own (classify clears it on green, and a cached write can fail), so a
# lost cache write can never duplicate or strand a ticket.
#
# Dedup / binding. A ticket is bound to a chain by TWO hidden HTML-comment
# markers in its body:
#   <!-- ci-repair-slot:v1 repo=<owner/repo> branch=<encoded> -->  (the slot)
#   <!-- ci-repair-first-red:<full-sha> -->                        (the chain)
# The slot marker is stable across red streaks (so green can close whatever
# is open for this repo/branch); the first-red marker identifies the specific
# red streak (so a fresh red opens a NEW ticket instead of silently reusing a
# prior streak's ticket that failed to close).
#
# Behaviour, driven by the chain State:
#   red:
#     - close any open slot ticket from a PRIOR first-red (stale streak);
#     - 0 current-streak tickets  -> acquire a CAS create-lease on the chain
#       (Repair-Issue=creating@<ts>, --expect-old) so only ONE concurrent
#       runner creates; the winner files the issue (both labels + markers)
#       and caches Repair-Issue=<n>;
#     - 1 current-streak ticket   -> refresh its body (NOT a comment, to avoid
#       the comment->task ingestion loop) and cache its number;
#     - >1 current-streak tickets -> keep the oldest, close the extras.
#   green / anything-not-red:
#     - close every open slot ticket (any first-red) and clear the cache.
#
# Loop safety. The ONLY thing that should mint a pickable task is the initial
# issue creation. Updates edit the body (issues:edited is create-only in the
# sync). Every comment this command posts (duplicate/stale/green closes)
# begins with the `<!-- task-dag:status -->` marker so the comment sync skips
# it instead of minting a new task.
#
# Usage:
#   task-dag repair-ticket <owner/repo> <branch>
#       [--title=<t>] [--lease-ttl=<secs>] [--dry-run] [--json] [--no-fetch]
#
# Exit codes:
#   0  reconciled (created/updated/closed/no-op)
#   1  argument error
#   4  origin/gh error (could not establish state or a mutation failed)
#   5  lost the create-lease CAS race (another runner is creating) — benign;
#      rerun reconciles
# ---------------------------------------------------------------------------

# Default time after which a stuck "creating@<ts>" lease may be stolen.
_RT_LEASE_TTL_DEFAULT=300

# Build the deterministic, automation-owned issue body.
_rt_ticket_body() { # <repo> <branch> <slot> <frmark> <first_red> <cur_head> <mode> <attempt>
    local repo="$1" branch="$2" slot="$3" frmark="$4" first_red="$5"
    local cur_head="$6" mode="$7" attempt="$8"
    cat <<EOF
$slot
$frmark

# CI repair needed for \`${repo}@${branch}\`

The required CI gate suite is **red** on \`${branch}\`. File a fix; this
ticket is the single pickable repair task for this red streak.

- First red: \`${first_red}\`
- Current head: \`${cur_head}\`
- Repair mode: \`${mode:-initial}\`
- Repair attempt: \`${attempt:-1}\`

When landing the fix, stamp the fix commit with these trailers so the
classifier can interpret the outcome (design §3):

\`\`\`text
Tree-Fix: ${repo}#<this-ticket-number>
Tree-Fix-Chain: ${first_red}
Tree-Fix-Mode: ${mode:-initial}
\`\`\`

<sub>Maintained automatically by \`task-dag repair-ticket\`; edits to this
body are overwritten on the next reconcile.</sub>
EOF
}

cmd_repair_ticket() {
    local repo="" branch="" title="" lease_ttl="$_RT_LEASE_TTL_DEFAULT"
    local dry_run=false json=false do_fetch=true

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --title=*) title="${1#*=}"; shift ;;
            --lease-ttl=*) lease_ttl="${1#*=}"; shift ;;
            --dry-run) dry_run=true; shift ;;
            --json) json=true; shift ;;
            --no-fetch) do_fetch=false; shift ;;
            --help | -h)
                cat <<EOF
Usage: task-dag repair-ticket <owner/repo> <branch> [options]

Reconcile the GitHub repair ticket with the CI repair-chain state so there is
EXACTLY ONE open ci-broken-master + priority:high ticket per open red chain
(scope #4 of #1). Idempotent + concurrency-safe. The chain ref is the desired
state; GitHub (label + hidden chain marker) is the authority for what exists;
Repair-Issue is a best-effort cache + CAS create-lease.

Options:
  --title=<t>        override the generated issue title
  --lease-ttl=<s>    seconds before a stuck create-lease may be stolen (def $_RT_LEASE_TTL_DEFAULT)
  --dry-run          print intended GitHub mutations, change nothing
  --json             machine-readable result on stdout (logs go to stderr)
  --no-fetch         read last-known local chain state (offline/test)

Exit: 0 reconciled  1 args  4 origin/gh error  5 lost create-lease race.
EOF
                return 0
                ;;
            -*) echo "Unknown option: $1" >&2; return 1 ;;
            *)
                if [ -z "$repo" ]; then repo="$1"
                elif [ -z "$branch" ]; then branch="$1"
                else echo "Unexpected argument: $1" >&2; return 1
                fi
                shift
                ;;
        esac
    done

    if [ -z "$repo" ] || [ -z "$branch" ]; then
        echo "Error: <owner/repo> and <branch> are required" >&2
        return 1
    fi
    if ! printf '%s' "$lease_ttl" | grep -Eq '^[0-9]+$'; then
        echo "Error: --lease-ttl must be a non-negative integer (got '$lease_ttl')" >&2
        return 1
    fi

    # A small mutation wrapper honouring --dry-run. Read-only `gh issue list`
    # is NOT routed through here (it always runs). Returns gh's own status.
    local _rt_dry="$dry_run"
    _rt_gh() {
        if [ "$_rt_dry" = true ]; then
            echo "(dry-run) gh $*" >&2
            return 0
        fi
        gh "$@"
    }

    # ── Current chain state (origin is the source of truth) ───────────────
    local ref sha=""
    ref="$(_cichain_ref "$repo" "$branch")"
    if [ "$do_fetch" = true ]; then
        if sha="$(_cichain_remote_sha "$ref")"; then
            [ -n "$sha" ] && _cichain_fetch "$ref"
        else
            # A mutating reconcile must not act off stale local state when it
            # cannot confirm origin: fail closed.
            echo "Error: cannot reach origin to read chain state for $repo@$branch" >&2
            return 4
        fi
    else
        sha="$(git rev-parse --verify --quiet "$ref" 2>/dev/null || true)"
    fi

    # No chain ref at all: nothing has ever gone red here -> nothing to do.
    if [ -z "$sha" ]; then
        if [ "$json" = true ]; then
            printf '{"action":"noop-nochain","repo":"%s","branch":"%s","ref":"%s"}\n' \
                "$(_cichain_jstr "$repo")" "$(_cichain_jstr "$branch")" "$(_cichain_jstr "$ref")"
        else
            printf "${YELLOW}No CI chain state for %s@%s — no repair ticket to reconcile.${RESET}\n" "$repo" "$branch" >&2
        fi
        return 0
    fi

    local state first_red cur_head mode attempt cache_issue
    state="$(_cichain_field "$sha" State)"
    first_red="$(_cichain_field "$sha" First-Red)"
    cur_head="$(_cichain_field "$sha" Current-Head)"
    mode="$(_cichain_field "$sha" Repair-Mode)"
    attempt="$(_cichain_field "$sha" Repair-Attempt)"
    cache_issue="$(_cichain_field "$sha" Repair-Issue)"

    # ── Markers (slot = repo/branch lineage; first-red = this red streak) ──
    local enc slot frmark
    enc="$(_cichain_encode "$branch")"
    slot="<!-- ci-repair-slot:v1 repo=${repo} branch=${enc} -->"
    frmark="<!-- ci-repair-first-red:${first_red} -->"

    # ── Enumerate the open slot tickets on GitHub (authority for what is) ──
    # Output lines "<number>\t<true|false>" (whether the body carries the
    # CURRENT first-red marker), oldest-first. body=null is treated as "".
    local listing list_rc=0
    listing="$(gh issue list --repo "$repo" --state open \
        --label ci-broken-master --label priority:high \
        --limit 1000 --json number,body,createdAt 2>/dev/null \
        | jq -r --arg slot "$slot" --arg fr "$frmark" '
            [ .[] | select((.body // "") | contains($slot)) ]
            | sort_by(.createdAt, .number)
            | .[] | "\(.number)\t\((.body // "") | contains($fr))"')" || list_rc=$?
    if [ "$list_rc" -ne 0 ]; then
        echo "Error: failed to list repair tickets for $repo (gh/jq error)" >&2
        return 4
    fi

    local -a current=() stale=()
    local n flag
    while IFS=$'\t' read -r n flag; do
        [ -n "$n" ] || continue
        if [ "$flag" = "true" ]; then current+=("$n"); else stale+=("$n"); fi
    done <<< "$listing"

    local action="" ticket_number=""

    # Close one issue with a task-dag:status-markered comment (loop-safe).
    _rt_close() { # <number> <reason>
        local num="$1" reason="$2" body
        body="$(printf '<!-- task-dag:status -->\n%s' "$reason")"
        _rt_gh issue close "$num" --repo "$repo" --comment "$body" >/dev/null 2>&1 \
            || echo "Warning: failed to close repair ticket #$num on $repo" >&2
    }

    if [ "$state" = "red" ]; then
        # Stale prior-streak tickets must be closed so a fresh streak is not
        # silently mistaken for a continuation (and so "one per chain" holds).
        local s
        for s in "${stale[@]}"; do
            _rt_close "$s" "Superseded: a newer red streak (first-red ${first_red}) is now open for \`${repo}@${branch}\`; closing this stale repair ticket."
            action="closed-stale${action:+,$action}"
        done

        local body
        body="$(_rt_ticket_body "$repo" "$branch" "$slot" "$frmark" "$first_red" "$cur_head" "$mode" "$attempt")"
        local def_title="CI broken: ${repo}@${branch} (first-red ${first_red:0:12})"
        [ -n "$title" ] && def_title="$title"

        if [ "${#current[@]}" -eq 0 ]; then
            # ── Create path, guarded by a CAS create-lease ────────────────
            # If a recent "creating@<ts>" lease is held by another runner,
            # stand down (it will create); only steal a lease older than TTL.
            local now lease_ts age
            now="$(date +%s)"
            if printf '%s' "$cache_issue" | grep -Eq '^creating@[0-9]+$'; then
                lease_ts="${cache_issue#creating@}"
                age=$(( now - lease_ts ))
                if [ "$age" -lt "$lease_ttl" ]; then
                    if [ "$json" = true ]; then
                        printf '{"action":"create-in-progress","repo":"%s","branch":"%s","leaseAge":%s}\n' \
                            "$(_cichain_jstr "$repo")" "$(_cichain_jstr "$branch")" "$age"
                    else
                        printf "${YELLOW}Repair ticket creation already in progress for %s@%s (lease age %ss < TTL %ss); standing down.${RESET}\n" \
                            "$repo" "$branch" "$age" "$lease_ttl" >&2
                    fi
                    return 0
                fi
            fi

            if [ "$dry_run" = true ]; then
                echo "(dry-run) would acquire create-lease + gh issue create on $repo with title: $def_title" >&2
                action="created${action:+,$action}"
            else
                # Acquire the lease: CAS Repair-Issue=creating@<now> bound to
                # the chain commit we read. A loser (rc 5) means a concurrent
                # runner won the lease — benign, rerun reconciles.
                local lease_rc=0
                cmd_chain_write "$repo" "$branch" --for-sha="$cur_head" \
                    --expect-old="$sha" --set "Repair-Issue=creating@${now}" \
                    >/dev/null 2>&1 || lease_rc=$?
                if [ "$lease_rc" -ne 0 ]; then
                    if [ "$json" = true ]; then
                        printf '{"action":"lease-lost","repo":"%s","branch":"%s","rc":%s}\n' \
                            "$(_cichain_jstr "$repo")" "$(_cichain_jstr "$branch")" "$lease_rc"
                    else
                        printf "${YELLOW}Lost the repair-ticket create-lease for %s@%s (another runner is creating); rerun reconciles.${RESET}\n" \
                            "$repo" "$branch" >&2
                    fi
                    return 5
                fi

                # We own the lease. File the issue.
                local lease_sha created_url
                lease_sha="$(_cichain_remote_sha "$ref" 2>/dev/null || true)"
                if ! created_url="$(gh issue create --repo "$repo" \
                        --title "$def_title" --body "$body" \
                        --label ci-broken-master --label priority:high 2>&1)"; then
                    echo "Error: gh issue create failed for $repo: $created_url" >&2
                    return 4
                fi
                ticket_number="$(printf '%s' "$created_url" | grep -oE '[0-9]+$' | tail -1)"

                # Cache the number (best-effort, CAS-bound to the lease commit).
                # If the cache write loses (chain moved), reconcile: only undo
                # the creation if the chain is no longer this red streak.
                local cache_rc=0
                cmd_chain_write "$repo" "$branch" --for-sha="$cur_head" \
                    --expect-old="$lease_sha" --set "Repair-Issue=${ticket_number}" \
                    >/dev/null 2>&1 || cache_rc=$?
                if [ "$cache_rc" -ne 0 ]; then
                    local now_sha now_state now_fr
                    now_sha="$(_cichain_remote_sha "$ref" 2>/dev/null || true)"
                    [ -n "$now_sha" ] && _cichain_fetch "$ref"
                    now_state="$(_cichain_field "$now_sha" State)"
                    now_fr="$(_cichain_field "$now_sha" First-Red)"
                    if [ "$now_state" != "red" ] || [ "$now_fr" != "$first_red" ]; then
                        _rt_close "$ticket_number" "CI chain for \`${repo}@${branch}\` changed during ticket creation; this repair ticket is no longer current and is closed automatically."
                        action="created-then-closed${action:+,$action}"
                        ticket_number=""
                    else
                        echo "Warning: created ticket #$ticket_number but could not cache its number (chain raced); next reconcile will cache it." >&2
                        action="created${action:+,$action}"
                    fi
                else
                    action="created${action:+,$action}"
                fi
            fi
        else
            # ── One-or-more current-streak tickets: keep oldest, refresh ──
            ticket_number="${current[0]}"
            local extra
            for extra in "${current[@]:1}"; do
                _rt_close "$extra" "Duplicate of #${ticket_number} for the same red streak (first-red ${first_red}); closing to keep exactly one repair ticket per chain."
                action="closed-dup${action:+,$action}"
            done
            # Refresh the canonical ticket's body (edit, NOT a comment).
            if [ "$dry_run" = true ]; then
                echo "(dry-run) would gh issue edit #$ticket_number on $repo (refresh body)" >&2
            else
                local bf
                bf="$(mktemp)"
                printf '%s' "$body" > "$bf"
                gh issue edit "$ticket_number" --repo "$repo" --body-file "$bf" >/dev/null 2>&1 \
                    || echo "Warning: failed to refresh repair ticket #$ticket_number body" >&2
                rm -f "$bf"
                # Re-cache the number if the chain still records something else.
                if [ "$cache_issue" != "$ticket_number" ]; then
                    cmd_chain_write "$repo" "$branch" --for-sha="$cur_head" \
                        --expect-old="$sha" --set "Repair-Issue=${ticket_number}" \
                        >/dev/null 2>&1 || true
                fi
            fi
            action="updated${action:+,$action}"
        fi
    else
        # ── Not red (green/unknown/closed): close every open slot ticket ──
        local all=("${current[@]}" "${stale[@]}") c
        if [ "${#all[@]}" -eq 0 ]; then
            action="noop-no-open-ticket"
        else
            for c in "${all[@]}"; do
                _rt_close "$c" "CI is green again on \`${repo}@${branch}\`; the broken-master repair chain is closed, so this repair ticket is resolved automatically."
            done
            action="closed"
            # Clear the cache if it still points anywhere (best-effort).
            if [ "$dry_run" = false ] && [ -n "$cache_issue" ]; then
                cmd_chain_write "$repo" "$branch" --for-sha="$cur_head" \
                    --expect-old="$sha" --set "Repair-Issue=" >/dev/null 2>&1 || true
            fi
        fi
    fi

    if [ "$json" = true ]; then
        printf '{"action":"%s","state":"%s","repo":"%s","branch":"%s","firstRed":"%s","ticket":"%s","dryRun":%s}\n' \
            "$(_cichain_jstr "$action")" "$(_cichain_jstr "$state")" \
            "$(_cichain_jstr "$repo")" "$(_cichain_jstr "$branch")" \
            "$(_cichain_jstr "$first_red")" "$(_cichain_jstr "$ticket_number")" "$dry_run"
    else
        printf "${BOLD}repair-ticket %s@%s${RESET} state=%s action=%s ticket=%s\n" \
            "$repo" "$branch" "$state" "$action" "${ticket_number:-<none>}"
    fi
    return 0
}
