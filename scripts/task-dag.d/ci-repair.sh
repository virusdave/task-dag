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
