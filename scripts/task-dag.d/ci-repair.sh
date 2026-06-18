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
