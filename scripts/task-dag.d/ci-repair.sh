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
                 noop-unknown | noop-green-nochain | noop-blocked
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

    # --for-sha must be a full, immutable commit SHA that is present locally.
    # This command is driven by CI event SHAs, so we reject anything else
    # (abbreviated SHAs, HEAD, branch/tag names, remote-only or junk values):
    # an ambiguous/mutable ref must never be the basis for a currency or chain
    # decision, nor be stored as Current-Head.
    if ! printf '%s' "$for_sha" | grep -Eq '^[0-9a-f]{40,64}$'; then
        echo "Error: --for-sha must be a full commit SHA (got '$for_sha')" >&2
        return 1
    fi
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
    # The read→decide→write CAS invariant requires that we actually READ the
    # prior chain commit. If origin advertises a chain SHA we could not
    # materialise (a transient fetch failure on a shallow/cold checkout), its
    # fields parse as empty and an open red chain would look like "none open" —
    # we'd wrongly decide 'open', re-anchor First-Red, and emit a duplicate
    # ticket hint. Fail closed instead (deepen history / fetch and retry).
    if [ -n "$old" ] && ! git cat-file -e "${old}^{commit}" 2>/dev/null; then
        echo "Error: chain state $ref=$old is unavailable locally; cannot classify safely (fetch/deepen and retry)" >&2
        return 4
    fi
    # chain_open: an active red streak accepting plain continuations.
    # chain_blocked: a chain parked by the tree-fix escalation threshold
    # (design §3) — still ACTIVE (a green must close it) but NOT repairable, so
    # a fresh red must NOT silently open a second chain over it.
    local prior_state="" prior_first_red="" chain_open=false chain_blocked=false
    if [ -n "$old" ]; then
        prior_state="$(_cichain_field "$old" State)"
        prior_first_red="$(_cichain_field "$old" First-Red)"
        [ "$prior_state" = "red" ] && chain_open=true
        [ "$prior_state" = "blocked" ] && chain_blocked=true
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
            elif [ "$chain_blocked" = true ]; then
                # The chain was parked by the tree-fix escalation threshold:
                # a human is already paged. A further red must NOT reopen a new
                # chain (that would un-block it); stand down.
                action="noop-blocked"
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
            elif [ "$chain_open" = true ] || [ "$chain_blocked" = true ]; then
                # Close the chain: green AND current (design §4). Green recovers
                # an escalation-BLOCKED chain too, clearing the repair fields.
                action="close"
                ticket="close"
                write_args=(--state=green --last-green="$for_sha"
                            --set First-Red= --set Repair-Mode=
                            --set Repair-Issue= --set Repair-Attempt=
                            --set Fail-Signature= --set Same-Sig-Count=)
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
# tree-fix-outcome  (CI broken-master auto-repair, design §3)
#
# The TREE-FIX-AWARE outcome handler. The classifier dispatch is EXCLUSIVE: an
# ordinary master commit goes to `classify` (§2); a commit carrying the Tree-Fix
# / Tree-Fix-Chain / Tree-Fix-Mode trailers (a worker's repair attempt) goes
# HERE instead, so the chain head is advanced exactly once per commit and the
# idempotency guard below ("already the chain head") is unambiguous. This command
# applies the design §3 escalation table:
#
#   | tree-fix outcome              | action                                  |
#   |-------------------------------|-----------------------------------------|
#   | master now GREEN              | close the chain + clear repair fields;  |
#   |                               | caller closes the repair ticket.        |
#   | RED, parent still in the chain| SAME chain; Repair-Mode=continue,       |
#   | (continuation)                | Repair-Attempt++; caller files a new    |
#   |                               | CONTINUE-mode repair task (no first-red |
#   |                               | back-off). State stays red.             |
#   | RED, parent was GREEN         | NEW regression: open a fresh initial    |
#   | (no open chain)               | chain anchored at the tree-fix commit.  |
#   | repeated continue failures    | after a small threshold, State=blocked  |
#   | with the SAME signature       | + page once; stop churning continue     |
#   |                               | tasks (a human takes over).             |
#
# Like `classify`, this command is PURE: it only drives the durable chain state
# (CAS-bound, currency- and stale-safe) and REPORTS hints. It never touches
# GitHub or pages directly — it reports ticketAction (open|close|update|block|
# none), taskAction (initial|continue|none) and page (true|false) so the
# GitHub-side caller (`repair-ticket`) files the one ticket / continue task and
# the operator-pager acts on them idempotently (same separation as classify).
#
# The design's ESCALATED state is represented as State=red + Repair-Mode=continue
# + Repair-Attempt++ (NOT a distinct State value), so the existing classify /
# repair-ticket / verify-target consumers keep treating the chain as an open,
# repairable red streak. Only the threshold BLOCK persists State=blocked, which
# those consumers now understand as "active but not repairable" (a green still
# closes it; a fresh red does not reopen it).
#
# Same-signature thresholding (design §3) needs to know whether successive
# failures are "the same". The CLI cannot read CI logs, so the caller passes the
# failure signature (e.g. a hash of the failing required-gate / test set) via
# --signature; we persist it (Fail-Signature) plus the consecutive same-signature
# count (Same-Sig-Count) on the chain and BLOCK when the count reaches
# --threshold (default 3).
#
# Usage:
#   task-dag tree-fix-outcome <owner/repo> <branch> --for-sha=<commit>
#       (--result=green|red|unknown | --gate=<conclusion> [--gate=...])
#       --signature=<sig>        (REQUIRED when the result is red)
#       [--threshold=<n>] [--current-head=<sha>] [--allow-stale]
#       [--dry-run] [--json] [--no-fetch]
#
# Exit codes:
#   0  handled; the resulting action was applied (or a valid no-op)
#   1  argument error / <for-sha> is not a tree-fix commit
#   2  malformed Tree-Fix* trailers on <for-sha>
#   4  git/origin error
#   5  lost the chain-write CAS race
#   6  superseded/stale: ignored relative to the current branch HEAD / chain
# ---------------------------------------------------------------------------
cmd_tree_fix_outcome() {
    local repo="" branch="" for_sha="" result="" current_head="" signature=""
    local threshold=3 allow_stale=false dry_run=false json=false do_fetch=true
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
            --signature=*) signature="${1#*=}"; shift ;;
            --threshold=*) threshold="${1#*=}"; shift ;;
            --current-head=*) current_head="${1#*=}"; shift ;;
            --allow-stale) allow_stale=true; shift ;;
            --dry-run) dry_run=true; shift ;;
            --json) json=true; shift ;;
            --no-fetch) do_fetch=false; shift ;;
            --help | -h)
                cat <<EOF
Usage: task-dag tree-fix-outcome <owner/repo> <branch> --for-sha=<commit> \\
         (--result=green|red|unknown | --gate=<conclusion> [--gate=...]) \\
         --signature=<sig> [options]

CI broken-master auto-repair tree-fix outcome handler (design §3). Interprets
the result of a commit carrying Tree-Fix* trailers and drives the §3 escalation:
green closes the chain; a continuation red escalates to Repair-Mode=continue
(Repair-Attempt++) and asks the caller to file a continue-mode repair task; a
red whose parent was green opens a fresh initial chain; repeated same-signature
continue failures BLOCK the chain + page after --threshold. Pure: drives chain
state + reports hints, never touches GitHub.

Result (pick one):
  --result=<v>         green | red | unknown (precomputed aggregate)
  --gate=<conclusion>  a required-gate conclusion (repeatable); aggregated as
                       red (any failure) > unknown (any pending/other) > green

Options:
  --for-sha=<commit>   REQUIRED; the tree-fix commit this CI run is about
  --signature=<sig>    REQUIRED when the result is red; identifies the failure
                       so repeated SAME-signature continue failures can block
  --threshold=<n>      same-signature continue failures before BLOCK (def 3)
  --current-head=<sha> the live branch tip (default: origin ls-remote)
  --allow-stale        act even when --for-sha is superseded by the branch tip
  --dry-run            compute + report without writing chain state
  --json               machine-readable result
  --no-fetch           skip fetching the prior chain ref / branch tip object

Reported action: close | continue | block | open-regression | noop-blocked |
                 noop-already-open | noop-already-processed | noop-green-nochain |
                 noop-green-noncurrent | noop-green-otherchain | noop-stale |
                 noop-stale-otherchain | noop-unknown
Ticket hint:     open | close | update | block | none
Task hint:       initial | continue | none

Exit: 0 applied/no-op  1 args/not-tree-fix  2 malformed trailers
      4 git/origin  5 CAS race  6 superseded/stale.
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
    if ! printf '%s' "$threshold" | grep -Eq '^[0-9]+$' || [ "$threshold" -lt 1 ]; then
        echo "Error: --threshold must be a positive integer (got '$threshold')" >&2
        return 1
    fi

    # Resolve --for-sha to a full local commit object (same contract as classify).
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
    if [ "$result" = "red" ]; then
        case "$signature" in
            "" )
                echo "Error: --signature is required for a red tree-fix outcome (same-signature thresholding)" >&2
                return 1 ;;
            *$'\n'* | *$'\r'* )
                # The signature is persisted into a single-line chain-state
                # commit field; a newline would corrupt the message format.
                echo "Error: --signature must be a single-line value" >&2
                return 1 ;;
        esac
    fi

    # ── This MUST be a tree-fix commit (design §3 applies only to those) ───
    local tf_json tf_rc=0
    tf_json="$(cmd_parse_tree_fix "$for_sha" --json 2>/dev/null)" || tf_rc=$?
    if [ "$tf_rc" -eq 2 ]; then
        echo "Error: $for_sha carries malformed Tree-Fix* trailers; cannot interpret its outcome" >&2
        return 2
    fi
    if ! printf '%s' "$tf_json" | grep -q '"treeFix":true'; then
        echo "Error: $for_sha is not a tree-fix commit (no Tree-Fix trailers); use 'classify' for ordinary commits" >&2
        return 1
    fi
    local tf_chain tf_mode
    tf_chain="$(printf '%s' "$tf_json" | sed -E 's/.*"chain":"([^"]*)".*/\1/;t;d')"
    tf_mode="$(printf '%s' "$tf_json" | sed -E 's/.*"mode":"([^"]*)".*/\1/;t;d')"

    # ── Currency (design §4): act relative to the current branch HEAD ──────
    # (identical model to classify: act only on the live tip; fail closed if it
    # cannot be established; superseded SHAs are ignored unless --allow-stale.)
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
    local p_head="" p_state="" p_first_red="" p_attempt="" p_sig="" p_count=""
    if [ -n "$old" ]; then
        p_head="$(_cichain_field "$old" Current-Head)"
        p_state="$(_cichain_field "$old" State)"
        p_first_red="$(_cichain_field "$old" First-Red)"
        p_attempt="$(_cichain_field "$old" Repair-Attempt)"
        p_sig="$(_cichain_field "$old" Fail-Signature)"
        p_count="$(_cichain_field "$old" Same-Sig-Count)"
    fi
    # Sanitise the persisted counters before any arithmetic (set -e would abort
    # on a non-numeric `$(( ))`); a malformed field is treated as unset.
    printf '%s' "$p_attempt" | grep -Eq '^[0-9]+$' || p_attempt=""
    printf '%s' "$p_count" | grep -Eq '^[0-9]+$' || p_count=""
    local chain_active=false ours=false
    { [ "$p_state" = "red" ] || [ "$p_state" = "blocked" ]; } && chain_active=true
    [ -n "$p_first_red" ] && [ "$p_first_red" = "$tf_chain" ] && ours=true

    # ── Decide the action ─────────────────────────────────────────────────
    local action="" ticket="none" task="none" page=false
    local new_attempt="$p_attempt" new_sig="$p_sig" new_count="$p_count"
    local -a write_args=()
    case "$result" in
        unknown)
            # A transient unknown must never open/close/escalate a chain.
            action="noop-unknown"
            ;;
        green)
            if [ "$is_current" = false ] && [ "$allow_stale" = false ]; then
                action="noop-green-noncurrent"
            elif [ "$chain_active" = true ] && [ "$ours" = true ]; then
                # The fix worked: close OUR chain + clear repair/signature fields.
                action="close"; ticket="close"
                write_args=(--state=green --last-green="$for_sha"
                            --set First-Red= --set Repair-Mode=
                            --set Repair-Issue= --set Repair-Attempt=
                            --set Fail-Signature= --set Same-Sig-Count=)
            elif [ "$chain_active" = true ]; then
                # Green, current, but a DIFFERENT chain is open: never close
                # someone else's streak (stale/race).
                action="noop-green-otherchain"
            else
                # Nothing open: record the green watermark (idempotent).
                action="noop-green-nochain"
                write_args=(--state=green --last-green="$for_sha")
            fi
            ;;
        red)
            if [ "$is_current" = false ] && [ "$allow_stale" = false ]; then
                action="noop-stale"
            elif [ "$p_state" = "blocked" ] && [ "$ours" = true ]; then
                # Already parked by the threshold; a human is paged. Stand down.
                action="noop-blocked"
            elif [ "$p_state" = "red" ] && [ "$ours" = true ] && [ "$p_head" = "$for_sha" ]; then
                # This exact tree-fix outcome is already the chain head: a
                # re-delivered/duplicate CI run. Do NOT increment the attempt /
                # same-signature count again (that would inflate the counters
                # and could falsely trip the block threshold without any new
                # repair attempt). Idempotent no-op.
                action="noop-already-processed"
            elif [ "$p_state" = "red" ] && [ "$ours" = true ]; then
                # ── Continuation of OUR red chain: escalate or block ───────
                if [ -n "$p_sig" ] && [ "$signature" = "$p_sig" ]; then
                    new_count=$(( ${p_count:-0} + 1 ))
                else
                    new_count=1
                fi
                new_sig="$signature"
                new_attempt=$(( ${p_attempt:-1} + 1 ))
                if [ "$new_count" -ge "$threshold" ]; then
                    # Repeated same-signature failures: BLOCK + page once,
                    # instead of churning continue tasks forever (design §3).
                    action="block"; ticket="block"; task="none"; page=true
                    write_args=(--state=blocked --repair-mode=continue
                                --repair-attempt="$new_attempt"
                                --set "Fail-Signature=$new_sig"
                                --set "Same-Sig-Count=$new_count")
                else
                    # Escalate the SAME chain to continue-mode (no first-red
                    # back-off). State stays red so the existing consumers keep
                    # treating it as an open, repairable streak.
                    action="continue"; ticket="update"; task="continue"
                    write_args=(--state=red --repair-mode=continue
                                --repair-attempt="$new_attempt"
                                --set "Fail-Signature=$new_sig"
                                --set "Same-Sig-Count=$new_count")
                fi
            elif [ "$chain_active" = false ]; then
                # No open chain (parent was green / chain already closed): this
                # is a NEW regression, not "more failures remain". Open a fresh
                # initial-mode chain anchored at the tree-fix commit.
                action="open-regression"; ticket="open"; task="initial"
                new_attempt=1; new_sig=""; new_count=""
                write_args=(--state=red --first-red="$for_sha"
                            --repair-mode=initial --repair-attempt=1
                            --set Fail-Signature= --set Same-Sig-Count=)
            elif [ "$p_state" = "red" ] && [ "$p_first_red" = "$for_sha" ]; then
                # A concurrent run already opened this regression as the chain
                # anchor; idempotent no-op (don't double-open).
                action="noop-already-open"
            else
                # A DIFFERENT chain is active and this fix did not target it:
                # refuse to clobber it / open a second chain (stale/race).
                action="noop-stale-otherchain"
            fi
            ;;
    esac

    # ── Report ────────────────────────────────────────────────────────────
    _tfo_report() { # <rc> <applied:true|false>
        local rc="$1" applied="$2" tk="$ticket" tsk="$task" pg="$page"
        if [ "$applied" != true ]; then tk="none"; tsk="none"; pg=false; fi
        if [ "$json" = true ]; then
            printf '{"result":"%s","action":"%s","ticket":"%s","task":"%s","page":%s,"current":%s,"applied":%s,"ref":"%s","forSha":"%s","chain":"%s","mode":"%s","firstRed":"%s","priorState":"%s","repairAttempt":"%s","failSignature":"%s","sameSigCount":"%s","threshold":%s,"rc":%s}\n' \
                "$result" "$action" "$tk" "$tsk" "$pg" "$is_current" "$applied" \
                "$(_cichain_jstr "$ref")" "$for_sha" "$(_cichain_jstr "$tf_chain")" \
                "$(_cichain_jstr "$tf_mode")" "$(_cichain_jstr "${p_first_red:-}")" \
                "$(_cichain_jstr "${p_state:-}")" "$(_cichain_jstr "${new_attempt:-}")" \
                "$(_cichain_jstr "${new_sig:-}")" "$(_cichain_jstr "${new_count:-}")" \
                "$threshold" "$rc"
        else
            printf "${BOLD}tree-fix-outcome %s@%s${RESET} result=%s action=%s ticket=%s task=%s page=%s (current=%s applied=%s rc=%s)\n" \
                "$repo" "$branch" "$result" "$action" "$tk" "$tsk" "$pg" "$is_current" "$applied" "$rc"
        fi
    }

    # Stale red relative to the live HEAD: ignore (design §4).
    if [ "$action" = "noop-stale" ]; then
        [ "$json" = false ] && printf "${YELLOW}Superseded CI run: %s is not the current %s HEAD — ignoring (design §4).${RESET}\n" "$for_sha" "$branch" >&2
        _tfo_report 6 false
        return 6
    fi
    if [ "$action" = "noop-stale-otherchain" ]; then
        [ "$json" = false ] && printf "${YELLOW}Tree-fix targets chain %s but %s@%s has a different active chain (first-red %s) — refusing to clobber it.${RESET}\n" "$tf_chain" "$repo" "$branch" "$p_first_red" >&2
        _tfo_report 6 false
        return 6
    fi

    # Pure no-ops (nothing to persist).
    if [ "${#write_args[@]}" -eq 0 ]; then
        _tfo_report 0 false
        return 0
    fi

    if [ "$dry_run" = true ]; then
        [ "$json" = false ] && printf "${BLUE}(dry-run: would chain-write %s)${RESET}\n" "${write_args[*]}" >&2
        _tfo_report 0 false
        return 0
    fi

    # ── Apply via the CAS/stale-safe primitive ────────────────────────────
    local -a extra=(--expect-old="$old")
    [ "$allow_stale" = true ] && extra+=(--allow-stale)
    local wrc=0 wout
    wout="$(cmd_chain_write "$repo" "$branch" --for-sha="$for_sha" --json \
        "${extra[@]}" "${write_args[@]}" 2>&1)" || wrc=$?
    if [ "$wrc" -ne 0 ]; then
        if [ "$json" = false ]; then
            printf "${RED}tree-fix-outcome: chain-write failed (rc=%s) for %s@%s action=%s${RESET}\n" \
                "$wrc" "$repo" "$branch" "$action" >&2
            printf '%s\n' "$wout" >&2
        else
            _tfo_report "$wrc" false
        fi
        return "$wrc"
    fi

    _tfo_report 0 true
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
    local rt_exit=0
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

    # Ensure EXACTLY ONE actionable continue-mode repair task exists for the
    # current attempt (design §3: "one repair issue per chain plus new
    # actionable tasks per failed attempt"). The comment is INTENTIONALLY
    # ingestable: its first non-blank line is prose (no leading "<!--") and the
    # dedup marker is NOT a `task-dag:` marker, so the comment->task sync mints
    # it as a fresh pickable continue task — unlike the body refresh (an edit,
    # which the sync ignores) and unlike status comments (which it skips).
    #
    # Concurrency: the dedup (read comments, post if the per-(first-red,attempt)
    # marker is absent) is idempotent for SERIAL reruns. It relies on the
    # classifier's per-repo/branch Actions concurrency group (design §4,
    # cancel-in-progress:false) serialising repair-ticket runs for one chain; it
    # is not independently safe against two truly-parallel runners. It FAILS
    # CLOSED if the comment lookup errors (rc 4), so a transient GitHub failure
    # can never be mistaken for "no task yet" and post a duplicate.
    _rt_ensure_continue_task() { # <ticket> <first_red> <cur_head> <attempt>
        local tnum="$1" fr="$2" head="$3" att="$4"
        local cmark="<!-- ci-repair-continue:v1 first-red=${fr} attempt=${att} -->"
        if [ "$_rt_dry" = true ]; then
            echo "(dry-run) would ensure continue-mode task comment on #$tnum (attempt $att)" >&2
            return 0
        fi
        local existing view_rc=0
        existing="$(gh issue view "$tnum" --repo "$repo" --json comments \
            --jq '.comments[].body' 2>/dev/null)" || view_rc=$?
        if [ "$view_rc" -ne 0 ]; then
            echo "Error: failed to read comments for repair ticket #$tnum on $repo (failing closed, not posting)" >&2
            return 4
        fi
        if printf '%s' "$existing" | grep -qF "$cmark"; then
            return 0
        fi
        local cbody ctf
        cbody="$(cat <<EOF
Repair attempt ${att} for \`${repo}@${branch}\`: the previous tree-fix did **not** turn \`${branch}\` green — additional failures remain. Repair the **current red \`${branch}\` tip** (do NOT apply the first-red back-off heuristic).

${cmark}

- First red: \`${fr}\`
- Current head: \`${head}\`
- Repair mode: \`continue\`
- Repair attempt: \`${att}\`
- Repair ticket: #${tnum}

Before working, confirm this chain is still yours:
\`task-dag verify-target ${repo} ${branch} --target-sha=${fr} --mode=continue --attempt=${att}\`

Stamp the fix commit with these trailers so the classifier interprets the outcome:

\`\`\`text
Tree-Fix: ${repo}#${tnum}
Tree-Fix-Chain: ${fr}
Tree-Fix-Mode: continue
\`\`\`
EOF
)"
        ctf="$(mktemp)"
        printf '%s' "$cbody" > "$ctf"
        local post_rc=0
        gh issue comment "$tnum" --repo "$repo" --body-file "$ctf" >/dev/null 2>&1 || post_rc=$?
        rm -f "$ctf"
        if [ "$post_rc" -ne 0 ]; then
            echo "Warning: failed to post continue-mode task comment on #$tnum (will retry next reconcile)" >&2
            return 4
        fi
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

        # Escalated chains (Repair-Mode=continue, attempt >= 2) get one fresh
        # actionable continue-mode task per attempt; an initial chain (attempt
        # 1) needs none — the repair ticket itself is the initial task. A
        # failure here is non-fatal to the ticket reconcile but is surfaced so
        # the workflow reruns (idempotent) until the task is filed.
        if [ -n "$ticket_number" ] && [ "$mode" = "continue" ] \
           && printf '%s' "$attempt" | grep -Eq '^[0-9]+$' && [ "$attempt" -ge 2 ]; then
            _rt_ensure_continue_task "$ticket_number" "$first_red" "$cur_head" "$attempt" \
                || rt_exit=4
        fi
    elif [ "$state" = "blocked" ]; then
        # ── Escalation threshold tripped (design §3): the chain is parked ──
        # awaiting a human. Stop the pickable repair task churning: close the
        # auto-repair ticket(s) with a status-markered comment explaining a
        # human has been paged. A later green reopens nothing (classify/
        # tree-fix-outcome clear State on recovery).
        local all=("${current[@]}" "${stale[@]}") c
        if [ "${#all[@]}" -eq 0 ]; then
            action="noop-blocked-no-ticket"
        else
            for c in "${all[@]}"; do
                _rt_close "$c" "CI repair for \`${repo}@${branch}\` (first-red ${first_red}) is **BLOCKED**: repeated same-signature tree-fix attempts failed (attempt ${attempt:-?}), so the auto-repair chain was parked and a human was paged. This auto-filed repair task is closed to stop churn; resolve the break manually, then a green \`${branch}\` will clear the chain."
            done
            action="closed-blocked"
        fi
        # Clear the stale ticket cache either way (no pickable ticket on a
        # parked chain).
        if [ "$dry_run" = false ] && [ -n "$cache_issue" ]; then
            cmd_chain_write "$repo" "$branch" --for-sha="$cur_head" \
                --expect-old="$sha" --set "Repair-Issue=" >/dev/null 2>&1 || true
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
    return "$rt_exit"
}
