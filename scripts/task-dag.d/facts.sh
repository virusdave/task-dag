# shellcheck shell=bash
# ═══════════════════════════════════════════════════════════════════════
# task-dag DERIVED FACTS: done / satisfied from master completion history
# (issue #13 north-star — the read-only fact layer beneath the reconciler)
#
# This module carries ONLY the derivation of the two primitive FACTS the
# north-star dependency graph is built on, both computed PURELY FROM
# `master`'s completion history and cached IN MEMORY for the life of one
# process (zero per-fact refs — that is the bounded-ref invariant):
#
#   • done(node)          — is a node's completion a durable git fact on
#                           master? (a completion/close merge)
#   • satisfied(edge)     — is an active dependency edge satisfied? i.e.
#                           is the edge's TARGET (`to`) done?
#
# It deliberately implements NOTHING beyond those raw facts. The AGGREGATION
# that turns facts into behavior — complete()/leaf-readiness over
# requires=all, supersede propagation over satisfies=any, epic auto-close,
# graph mutation/pruning, the cross-repo mailbox, and the `graph --explain`
# resolver — are SEPARATE sibling tasks and are NOT implemented here. Do not
# grow this module into them without their own reviews.
#
# ─────────────────────────────────────────────────────────────────────
# THE FACTS (the contract consumers rely on)
#
#   done(node) — authoritative from THIS repo's master history, scoped to the
#     current repo (a node's identity is owner/repo + object-id, and the
#     local history is only authoritative for the current repo):
#       task:<cur-repo>@<sha>   done ⟺ a tree-equal commit on master's
#           FIRST-PARENT spine records <sha> as a non-primary parent AND
#           <sha> is an empty-tree task commit. The spine restriction excludes
#           structural/dependency parent tokens reachable through task commits.
#       issue:<cur-repo>#<N>    done ⟺ a merge reachable from the master tip
#           carries a `Closes-Epic: #<N>` TRAILER. `Closes-Epic` stores only
#           the number (no owner/repo), so this fact MUST be scoped to the
#           current repo — otherwise a foreign issue#N would false-positive
#           against a local close of #N.
#       FOREIGN node (repo != current)  → not locally derivable ⇒ NOT done
#           (rc 1). The cross-repo hint/backstop siblings carry those.
#
#   satisfied(edge) = done(edge.to), for BOTH relations. An edge is satisfied
#     the moment its target completes. The requires=all (readiness) vs
#     satisfies=any (supersede) PROPAGATION is the reconciler sibling's job;
#     here every edge gets the same edge-local boolean.
#
# FRESHNESS is consistent between the two inputs (edges + master facts):
#   • online (default): sync BOTH the graph index (via the reader) AND
#     origin/master before deriving; fail closed if either is indeterminate,
#   • --no-fetch: read BOTH from local refs only (fully offline).
# The fact cache is keyed on the RESOLVED tip OID, so a fetch / complete /
# HEAD move in the same process transparently re-derives.
# ═══════════════════════════════════════════════════════════════════════

# The canonical empty tree — also defined in the main script; define a
# fallback so this module is correct even when sourced standalone (tests).
: "${EMPTY_TREE:=4b825dc642cb6eb9a060e54bf8d69288fbee4904}"

# In-memory fact caches (module-global; O(open+history-scan) memory, ZERO
# refs). Keyed on the resolved master tip OID they were derived against.
declare -gA TASKDAG_DONE_TASKS=()
declare -gA TASKDAG_CLOSED_ISSUES=()
TASKDAG_FACTS_TIP_OID=""

# taskdag_current_repo: the current repo's canonical (lowercased) owner/repo,
# used to SCOPE done facts (local master is authoritative only for this repo).
# Resolution order (offline seams first, so tests + the fact layer never
# depend on network):
#   1. env TASKDAG_CURRENT_REPO  (explicit override / test seam)
#   2. git-config taskdag.current-repo  (offline, deterministic)
#   3. _xrepo_current_repo  (the cross-repo helper: gh, else origin URL)
# Prints the canonical owner/repo; returns non-zero if it cannot be resolved
# (fail loud — done facts must never be silently mis-scoped).
taskdag_current_repo() {
    local r=""
    if [ -n "${TASKDAG_CURRENT_REPO:-}" ]; then
        r="$TASKDAG_CURRENT_REPO"
    else
        r=$(git config --get taskdag.current-repo 2>/dev/null || true)
        if [ -z "$r" ] && declare -F _xrepo_current_repo >/dev/null 2>&1; then
            r=$(_xrepo_current_repo 2>/dev/null || true)
        fi
    fi
    [ -n "$r" ] || return 1
    taskdag_norm_owner_repo "$r"
}

# taskdag_resolve_facts_tip: print the OID of the tip whose completion
# history defines the facts. Prefers origin/master (the shared source of
# truth) over the local master branch over HEAD. Returns non-zero if none
# resolve (fail loud — never derive facts from thin air).
taskdag_resolve_facts_tip() {
    local t oid
    for t in refs/remotes/origin/master refs/heads/master HEAD; do
        if oid=$(git rev-parse --verify -q "${t}^{commit}" 2>/dev/null); then
            printf '%s\n' "$oid"
            return 0
        fi
    done
    return 2
}

# taskdag_sync_master: fetch origin/master so the online fact view is fresh.
# TRI-STATE, mirroring the reader's graph-ref sync so an online read never
# derives facts from a stale local view without saying so:
#   0 -> refs/remotes/origin/master is now current (or origin has no master,
#        in which case we fall back to whatever local tip resolves)
#   2 -> INDETERMINATE: origin unreachable / transport error (fail closed)
# Updates only the remote-tracking ref, never the checked-out local branch.
taskdag_sync_master() {
    local rc
    git ls-remote --exit-code origin refs/heads/master >/dev/null 2>&1; rc=$?
    case "$rc" in
        0)
            git fetch --quiet --no-tags origin \
                '+refs/heads/master:refs/remotes/origin/master' 2>/dev/null || return 2
            return 0
            ;;
        2)
            # origin has no master branch — nothing to sync; local tip stands.
            return 0
            ;;
        *)
            return 2
            ;;
    esac
}

# taskdag__scan_closed_issues <tip>: emit (one per line) every issue number N
# for which a merge reachable from <tip> carries a `Closes-Epic: #N` TRAILER.
# Uses git's own trailer parser (%(trailers:key=…)) so arbitrary body prose
# mentioning "Closes-Epic:" cannot forge a close fact, and restricts to
# --merges (the close commit shape). Only positive decimals are accepted.
taskdag__scan_closed_issues() {
    local tip="$1"
    git log "$tip" --merges --no-color \
        --format='%(trailers:key=Closes-Epic,valueonly,separator=%x0A)' 2>/dev/null \
        | sed 's/^#//' \
        | grep -E '^[1-9][0-9]*$' || true
}

# taskdag_load_facts: derive the done/closed caches from the current master
# tip, ONCE per resolved tip OID (idempotent memoization). Re-derives if the
# tip has moved. Returns non-zero (2) only if no tip can be resolved.
taskdag_load_facts() {
    local want_oid
    want_oid=$(taskdag_resolve_facts_tip) || {
        echo "Error: cannot resolve a master/HEAD tip to derive done/satisfied facts" >&2
        return 2
    }
    if [ -n "$TASKDAG_FACTS_TIP_OID" ] && [ "$want_oid" = "$TASKDAG_FACTS_TIP_OID" ]; then
        return 0
    fi

    # Reset before repopulating (a stale key must never survive a re-derive).
    TASKDAG_DONE_TASKS=()
    TASKDAG_CLOSED_ISSUES=()

    # done-set: non-primary empty-tree task parents of tree-equal commits on
    # master's first-parent spine. Walking arbitrary ancestry would encounter
    # task commits themselves and falsely mark their structural/dependency
    # parents done. Build once so each done() query remains O(1).
    local commit first rest sha commit_tree first_tree scan
    scan=$(git rev-list --first-parent --parents "$want_oid" 2>/dev/null) || return 2
    while read -r commit first rest; do
        [ -n "$commit" ] && [ -n "$first" ] && [ -n "$rest" ] || continue
        commit_tree=$(git rev-parse "$commit^{tree}" 2>/dev/null || true)
        first_tree=$(git rev-parse "$first^{tree}" 2>/dev/null || true)
        [ -n "$commit_tree" ] && [ "$commit_tree" = "$first_tree" ] || continue
        for sha in $rest; do
            [ "$(git rev-parse "$sha^{tree}" 2>/dev/null || true)" = "$EMPTY_TREE" ] \
                && TASKDAG_DONE_TASKS["$sha"]=1
        done
    done <<< "$scan"

    # closed-issue set: Closes-Epic trailers on reachable merges.
    local n
    while IFS= read -r n; do
        [ -n "$n" ] && TASKDAG_CLOSED_ISSUES["$n"]=1
    done < <(taskdag__scan_closed_issues "$want_oid")

    TASKDAG_FACTS_TIP_OID="$want_oid"
    return 0
}

# taskdag_node_done <node>: is <node> a durable completion fact on master?
#   rc 0 -> done
#   rc 1 -> not done (incl. foreign-repo nodes, not locally derivable)
#   rc 2 -> invalid node, unresolvable current repo, or unresolvable tip
taskdag_node_done() {
    local node
    node=$(taskdag_normalize_node "$1") || { echo "Error: invalid node: $1" >&2; return 2; }
    taskdag_load_facts || return 2
    local cur
    cur=$(taskdag_current_repo) || { echo "Error: cannot resolve current repo to scope done facts" >&2; return 2; }

    local rest or ref
    case "$node" in
        task:*)
            rest="${node#task:}"; or="${rest%@*}"; ref="${rest##*@}"
            [ "$or" = "$cur" ] || return 1                      # foreign repo
            [ -n "${TASKDAG_DONE_TASKS[$ref]:-}" ] || return 1
            # A done task node MUST be an empty-tree task commit: excludes an
            # implementation SHA that only appeared as a first parent.
            local tree
            tree=$(git rev-parse -q --verify "${ref}^{tree}" 2>/dev/null) || return 1
            [ "$tree" = "$EMPTY_TREE" ] || return 1
            return 0
            ;;
        issue:*)
            rest="${node#issue:}"; or="${rest%#*}"; ref="${rest##*#}"
            [ "$or" = "$cur" ] || return 1                      # foreign repo
            [ -n "${TASKDAG_CLOSED_ISSUES[$ref]:-}" ]
            ;;
    esac
}

# taskdag_edges_with_facts [--no-fetch]: read the active edge set and annotate
# each edge with `satisfied` = done(.to). Emits a compact JSON array (same
# shape as the reader, plus a boolean `satisfied` per edge), sorted by edgeId
# (inherited from the reader). Fail-closed: an unresolvable current repo or
# tip is an error, never a silently-false fact set.
taskdag_edges_with_facts() {
    local edges
    edges=$(taskdag_read_edges "$@") || return 1
    taskdag_load_facts || return 2
    # Resolve current repo up front so a mid-loop failure can't half-annotate.
    taskdag_current_repo >/dev/null || { echo "Error: cannot resolve current repo to derive edge facts" >&2; return 2; }

    local map='{}' node rc d
    while IFS= read -r node; do
        [ -n "$node" ] || continue
        taskdag_node_done "$node"; rc=$?
        case "$rc" in
            0) d=true ;;
            1) d=false ;;
            *) return 2 ;;
        esac
        map=$(printf '%s' "$map" | jq --arg k "$node" --argjson v "$d" '. + {($k): $v}')
    done < <(printf '%s' "$edges" | jq -r '[.[].to] | unique[]')

    printf '%s' "$edges" | jq --argjson m "$map" 'map(. + {satisfied: ($m[.to] // false)})'
}

# Command: facts — READ derived done/satisfied facts (read-only plumbing).
cmd_facts() {
    local json=false do_fetch=true node=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --json) json=true; shift ;;
            --no-fetch) do_fetch=false; shift ;;
            --node) node="${2:-}"; shift 2 ;;
            --node=*) node="${1#*=}"; shift ;;
            --help|-h)
                cat <<'EOF'
Usage: task-dag facts [--json] [--no-fetch] [--node <node>]

READ (only) the DERIVED done/satisfied facts of the dependency graph,
computed purely from master's completion history and cached in memory (issue
#13 north-star). This never writes a ref — done/satisfied are derived facts,
never one-ref-per-fact (the bounded-ref invariant).

  done(node)      task:<cur-repo>@<sha>  ⟺ <sha> is a completed (empty-tree)
                  task commit on master; issue:<cur-repo>#<N> ⟺ a
                  `Closes-Epic: #<N>` merge is on master. Facts are scoped to
                  the CURRENT repo; a foreign node is reported not-done here
                  (its completion is carried by the cross-repo siblings).
  satisfied(edge) ⟺ done(edge.to), for both requires and satisfies edges.

Default (online): syncs BOTH origin/master and the graph index before
deriving, so an empty/unsatisfied result means "not done", never "couldn't
reach origin". --no-fetch reads BOTH from local refs only (offline).

  --node <node>   query ONE node's done fact. Prints "<node>\tdone|not-done"
                  (or {node,done} with --json) and EXITS 0 if done, 1 if not
                  done, 2 on error. Does not read the edge set.
  --json          emit JSON (edge array with a `satisfied` boolean, or the
                  single-node object with --node).
  --no-fetch      local refs only (offline).

This is low-level plumbing. It computes RAW facts only — NOT leaf readiness,
epic closure, supersede propagation, or "why" (those are the reconciler /
graph --explain siblings). Requires jq.
EOF
                return 0
                ;;
            *) echo "Error: unknown option: $1" >&2; return 2 ;;
        esac
    done

    if [ "$do_fetch" = true ]; then
        taskdag_sync_master || { echo "Error: could not sync origin/master (indeterminate); refusing to derive facts from a possibly-stale view (use --no-fetch to read local refs)" >&2; return 2; }
    fi

    # Single-node query (does not touch the edge set).
    if [ -n "$node" ]; then
        local rc status
        taskdag_node_done "$node"; rc=$?
        [ "$rc" -eq 2 ] && return 2
        if [ "$rc" -eq 0 ]; then status=done; else status=not-done; fi
        if [ "$json" = true ]; then
            jq -nc --arg node "$node" --argjson done "$([ "$rc" -eq 0 ] && echo true || echo false)" \
                '{node:$node, done:$done}'
        else
            printf '%s\t%s\n' "$node" "$status"
        fi
        return "$rc"
    fi

    local args=()
    [ "$do_fetch" = false ] && args+=(--no-fetch)
    local out
    out=$(taskdag_edges_with_facts "${args[@]}") || return 1

    if [ "$json" = true ]; then
        printf '%s\n' "$out"
        return 0
    fi

    # Human table.
    local count
    count=$(printf '%s' "$out" | jq 'length')
    if [ "$count" -eq 0 ]; then
        printf "${BOLD}No active dependency edges${RESET} (%s)\n" "$TASKDAG_GRAPH_REF"
        return 0
    fi
    printf "${BOLD}%-12s %-9s %-9s %-26s %-26s${RESET}\n" "EDGE-ID" "RELATION" "SATISFIED" "FROM" "TO"
    printf '%s' "$out" | jq -r \
        '.[] | [(.edgeId[0:12]), .relation, (.satisfied|tostring), .from, .to] | @tsv' \
    | while IFS=$'\t' read -r eid rel sat from to; do
        printf "%-12s %-9s %-9s %-26s %-26s\n" "$eid" "$rel" "$sat" "$from" "$to"
    done
}
