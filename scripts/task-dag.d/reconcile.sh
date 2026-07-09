# shellcheck shell=bash
# ═══════════════════════════════════════════════════════════════════════
# task-dag RECONCILE PREDICATES: complete() + leaf-readiness over the edge
# graph (issue #13 north-star — the AGGREGATION layer above the raw facts).
#
# The fact layer (scripts/task-dag.d/facts.sh) emits only two EDGE-LOCAL
# booleans, purely from master's completion history and in memory:
#   • done(node)      — is a node's completion a durable git fact on master?
#   • satisfied(edge) — done(edge.to), the SAME boolean for both relations.
#
# This module turns those raw facts into BEHAVIOR by aggregating them across
# the containment tree (first-parent children) and the two edge relations,
# implementing the north-star predicates:
#
#   complete(node):
#     if ANY outgoing satisfies-edge is satisfied: return true   # supersede
#     if node is an EPIC (first-parent children, or Type: epic with outgoing
#                        requires-edges):
#         return obligations non-empty
#            AND every requires-edge satisfied
#            AND every child subtree complete()                  # obligations
#     else (a LEAF / issue / foreign node):
#         return done(node)                                      # authoritative
#
#   leaf-readiness(node) = NOT complete(node)  AND  every requires-edge
#     satisfied  AND (for a current-repo task node) unclaimed AND unblocked.
#
# A node is classified EPIC vs LEAF by CONTAINMENT (does it have first-parent
# children?) and explicit Type: epic roots BEFORE the raw done() fact is
# trusted, and this ordering is load-bearing: the fact layer derives done()
# from ANY parent-field token reachable from master, and an epic root is its
# children's FIRST-parent token — so a decomposed epic false-positives as
# done() the instant any one child completes. Completeness of an epic is
# therefore always derived from its obligations (exactly like the legacy
# epic_subtree_complete), never from done(); done() stays authoritative only
# for a leaf (which appears solely as the 2nd parent of its own completion
# merge) and an issue (Closes-Epic). A LEAF's outgoing requires-edges gate
# READINESS, not completeness.
#
# Semantics locked by the operator on issue #13: requires = ALL (a plain AND
# — OR-deps are out of scope), satisfies = ANY (supersede). A requires-edge
# uses the edge-local `satisfied` (= done(.to)); a node completed ONLY via
# supersede becomes `done` once the reconciler backstop synthesizes its
# completion merge on master (a SEPARATE sibling task — see the scope
# boundary below), so `satisfied` converges without this layer recursing over
# edges. The ONLY recursion here is over the containment FOREST (each task
# commit has exactly one first parent), which is inherently acyclic and
# bounded by the decomposition depth.
#
# READ-ONLY / ADDITIVE. This module computes predicates and reports them; it
# NEVER writes a ref. Mutating graph convergence and epic close emission live
# in sibling modules and call this predicate layer instead of re-implementing
# its semantics.
#
# Relies on: facts.sh (taskdag_node_done, taskdag_edges_with_facts,
# taskdag_current_repo, taskdag_sync_master), edges.sh (taskdag_normalize_node),
# and the containment-tree / block helpers from the main script
# (is_task_commit, get_first_parent, is_task_blocked,
# blocked_structural_ancestor). Requires jq.
# ═══════════════════════════════════════════════════════════════════════

# The canonical empty tree — also defined in the main script; a fallback so
# this module is correct when sourced standalone (tests).
: "${EMPTY_TREE:=4b825dc642cb6eb9a060e54bf8d69288fbee4904}"

# Per-invocation state, prepared ONCE by taskdag_recon_prepare so the
# recursion never re-fetches / re-scans:
#   • the active edge set annotated with `satisfied` (from facts.sh),
#   • the containment child map (first-parent -> newline-joined child SHAs),
#   • the resolved current repo (to address current-repo task nodes).
TASKDAG_RECON_EDGES_JSON=""
declare -gA TASKDAG_RECON_FP_CHILDREN=()
TASKDAG_RECON_CUR=""
TASKDAG_RECON_READY=false   # set by prepare; guards use-before-prepare

# taskdag_recon_build_child_map: build the containment (first-parent) child
# map ONCE from ALL reachable task commits, in a SINGLE `git log` call (no
# per-commit subprocess). A commit is a containment child of its FIRST
# parent iff it is an empty-tree task commit and is not a Claim:/
# Blocked-Meta: side commit (mirrors list_dag_children's filtering, but the
# containment edge is strictly the FIRST parent — the breakdown/structural
# parent — never a dependency parent). The result is a strict forest, so the
# complete() recursion over it is inherently acyclic and terminating.
taskdag_recon_build_child_map() {
    TASKDAG_RECON_FP_CHILDREN=()
    local us=$'\x1f' commit tree subject parents first
    while IFS="$us" read -r commit tree subject parents; do
        [ -n "$commit" ] || continue
        [ "$tree" = "$EMPTY_TREE" ] || continue           # task commits only
        case "$subject" in
            Claim:*|Blocked-Meta:*|kind:\ delegated*|kind:\ completion*) continue ;;
        esac
        first="${parents%% *}"                            # first parent only
        [ -n "$first" ] || continue                       # a rootless commit
        TASKDAG_RECON_FP_CHILDREN["$first"]+="$commit"$'\n'
    done < <(git log --all --format="%H${us}%T${us}%s${us}%P" 2>/dev/null)
}

# taskdag_recon_prepare [--no-fetch]: load the per-invocation state. Online
# (default) syncs BOTH origin/master (the fact tip) and the graph index
# before deriving, so a not-complete/not-ready verdict means the fact is
# absent, never "couldn't reach origin"; --no-fetch reads BOTH from local
# refs only (offline). Fails (rc 2) if the edge/fact view or the current
# repo cannot be resolved — a predicate must never run on a silently-empty
# input. The containment map is read from LOCAL task refs (like `frontier`);
# a caller wanting an online containment view fetches task refs first.
taskdag_recon_prepare() {
    local nofetch=false
    [ "${1:-}" = --no-fetch ] && nofetch=true
    command -v jq >/dev/null 2>&1 || { echo "Error: jq is required to reconcile the dependency graph" >&2; return 2; }

    # Reset per-invocation state UP FRONT so a failed (re-)prepare can never
    # leave a stale/partial view marked ready for a caller that ignores rc.
    TASKDAG_RECON_READY=false
    TASKDAG_RECON_EDGES_JSON=""
    TASKDAG_RECON_CUR=""
    TASKDAG_RECON_FP_CHILDREN=()

    if [ "$nofetch" = false ]; then
        taskdag_sync_master || { echo "Error: could not sync origin/master (indeterminate); refusing to reconcile against a possibly-stale view (use --no-fetch for local refs)" >&2; return 2; }
        # Sync the task-ref namespace so containment (the child map) AND the
        # claim/block gates reflect ORIGIN, not a partial local checkout. FAIL
        # CLOSED: a decomposed epic judged against a partial local DAG (only
        # the completed child visible) would FALSE-COMPLETE — the exact hazard
        # the legacy auto-close path guards against. (An unset helper resolves
        # to 127 here, also caught by `|| { … }`, so this is fail-closed even
        # when the module is sourced standalone.)
        fetch_task_refs_strict >/dev/null 2>&1 || { echo "Error: could not sync task refs from origin (indeterminate); refusing to reconcile against a partial local DAG (use --no-fetch for the local view)" >&2; return 2; }
    fi

    local args=()
    [ "$nofetch" = true ] && args+=(--no-fetch)
    TASKDAG_RECON_EDGES_JSON=$(taskdag_edges_with_facts "${args[@]}") || return 2

    TASKDAG_RECON_CUR=$(taskdag_current_repo) || { echo "Error: cannot resolve current repo to reconcile the graph" >&2; return 2; }
    taskdag_recon_build_child_map
    TASKDAG_RECON_READY=true
    return 0
}

# taskdag_recon_resolve_task_node <normalized-node>: TRI-STATE resolver for a
# node's LOCAL containment identity, so an unverifiable current-repo task node
# fails CLOSED instead of being silently treated as a childless leaf.
#   rc 0 + <sha> -> a current-repo task node present locally as an empty-tree
#                   task commit (has containment children / claim / block refs)
#   rc 1         -> NOT a current-repo task node (an issue node or a foreign-
#                   repo node): no local containment; the caller uses the fact
#                   layer (done()) / cross-repo siblings
#   rc 2         -> a current-repo TASK node that is MISSING locally or is not
#                   an empty-tree task commit — an indeterminate / corrupt
#                   local view; the caller must fail closed (never guess ready)
taskdag_recon_resolve_task_node() {
    local node="$1" rest or ref
    case "$node" in task:*) ;; *) return 1 ;; esac      # issue node ⇒ not a task node
    rest="${node#task:}"; or="${rest%@*}"; ref="${rest##*@}"
    [ "$or" = "$TASKDAG_RECON_CUR" ] || return 1         # foreign-repo task node
    git rev-parse -q --verify "${ref}^{commit}" >/dev/null 2>&1 || return 2
    is_task_commit "$ref" || return 2
    printf '%s\n' "$ref"
}

# taskdag_recon_has_satisfying_edge <normalized-node>: rc 0 iff ANY outgoing
# satisfies-edge (from == node) is satisfied (the supersede short-circuit).
taskdag_recon_has_satisfying_edge() {
    printf '%s' "$TASKDAG_RECON_EDGES_JSON" | jq -e --arg n "$1" \
        'any(.[]; .from == $n and .relation == "satisfies" and .satisfied == true)' \
        >/dev/null 2>&1
}

# taskdag_recon_requires_satisfied <normalized-node>: rc 0 iff EVERY outgoing
# requires-edge (from == node) is satisfied. Vacuously true when the node has
# no requires-edges (`all` over an empty set is true) — requires = ALL.
taskdag_recon_requires_satisfied() {
    printf '%s' "$TASKDAG_RECON_EDGES_JSON" | jq -e --arg n "$1" \
        '[.[] | select(.from == $n and .relation == "requires")] | all(.satisfied == true)' \
        >/dev/null 2>&1
}

# taskdag_recon_has_requires <normalized-node>: rc 0 iff the node has at
# least one outgoing requires-edge. Used to keep childless Type: epic roots
# from vacuously completing while still allowing a requires-only delegated
# epic to close once its edge is satisfied.
taskdag_recon_has_requires() {
    printf '%s' "$TASKDAG_RECON_EDGES_JSON" | jq -e --arg n "$1" \
        'any(.[]; .from == $n and .relation == "requires")' \
        >/dev/null 2>&1
}

# taskdag_recon_task_type <sha>: print the lowercase Type: field from a task
# commit, if present. Missing Type is a normal legacy/task case.
taskdag_recon_task_type() {
    git log -1 --format='%B' "$1" 2>/dev/null \
        | awk -F':[[:space:]]*' 'tolower($1) == "type" { print tolower($2); exit }'
}

# taskdag_node_complete <node>: the north-star complete() predicate.
#   rc 0 -> complete   rc 1 -> not complete   rc 2 -> error (bad node / setup)
# Assumes taskdag_recon_prepare has run this invocation.
taskdag_node_complete() {
    [ "$TASKDAG_RECON_READY" = true ] || { echo "Error: taskdag_node_complete called before taskdag_recon_prepare" >&2; return 2; }
    local node
    node=$(taskdag_normalize_node "$1") || { echo "Error: invalid node: $1" >&2; return 2; }

    # (1) supersede — any outgoing satisfies-edge satisfied fulfils the node
    #     (valid for both leaves and epics; the supersede short-circuit).
    taskdag_recon_has_satisfying_edge "$node" && return 0

    # (2) classify by CONTAINMENT and explicit epic type. A node with
    #     first-parent children is an EPIC; a childless Type: epic task with
    #     outgoing requires-edges is also an EPIC whose obligations are those
    #     edges. A childless Type: epic task with no requires-edges has EMPTY
    #     obligations and is not complete. Ordinary childless tasks remain
    #     LEAF nodes: their requires-edges gate readiness, not completeness.
    #
    #     This MUST come before trusting the raw done() fact: the fact layer
    #     derives done() from ANY parent-field token reachable from master,
    #     and an epic root is its children's FIRST-parent token, so a
    #     decomposed epic FALSE-POSITIVES as done() the moment any child is
    #     completed. Completeness of an epic is therefore derived from its
    #     obligations, exactly like the legacy epic_subtree_complete — never
    #     from done(). done() stays authoritative only for a leaf (which
    #     appears solely as the 2nd parent of its own completion merge) and
    #     for an issue (Closes-Epic).
    local sha children="" resolve_rc=0 task_type="" has_requires=false is_epic=false
    sha=$(taskdag_recon_resolve_task_node "$node") || resolve_rc=$?
    if [ "$resolve_rc" -eq 2 ]; then
        echo "Error: current-repo task node not resolvable locally (missing or not an empty-tree task commit): $node — fetch task refs or check the local view" >&2
        return 2
    fi
    if [ "$resolve_rc" -eq 0 ]; then
        children="${TASKDAG_RECON_FP_CHILDREN[$sha]:-}"
        task_type="$(taskdag_recon_task_type "$sha")"
        taskdag_recon_has_requires "$node" && has_requires=true || has_requires=false
        if [ -n "$children" ] || { [ "$task_type" = epic ] && [ "$has_requires" = true ]; }; then
            is_epic=true
        elif [ "$task_type" = epic ]; then
            return 1
        fi
    fi

    if [ "$is_epic" = false ]; then
        # LEAF / issue / foreign node — the durable done() fact is
        # authoritative. `|| rc=$?` (not `; rc=$?`) so a non-zero return
        # under the CLI's `set -e` is captured, not an abort. A leaf's
        # outgoing requires-edges gate READINESS, not completeness.
        local rc=0
        taskdag_node_done "$node" || rc=$?
        [ "$rc" -eq 2 ] && return 2
        return "$rc"
    fi

    # EPIC — obligations = its containment children ∪ its outgoing
    # requires-edges. Complete iff obligations are non-empty, every
    # requires-edge is satisfied (mode = all), and every child subtree is
    # complete. The empty-obligations Type: epic case returned incomplete
    # above, so a root can never vacuously close.
    taskdag_recon_requires_satisfied "$node" || return 1
    local child rc
    while IFS= read -r child; do
        [ -n "$child" ] || continue
        rc=0; taskdag_node_complete "task:${TASKDAG_RECON_CUR}@${child}" || rc=$?
        [ "$rc" -eq 2 ] && return 2
        [ "$rc" -eq 0 ] || return 1
    done <<< "$children"
    return 0
}

# taskdag_leaf_ready <node>: the north-star leaf-readiness predicate —
#   NOT complete  AND  every requires-edge satisfied  AND (for a current-repo
#   task node) unclaimed AND unblocked (structural block included).
#   rc 0 -> ready   rc 1 -> not ready   rc 2 -> error
# Claim/block are read from LOCAL refs (like `frontier`); the caller fetches
# task refs first for an online-accurate view.
taskdag_leaf_ready() {
    [ "$TASKDAG_RECON_READY" = true ] || { echo "Error: taskdag_leaf_ready called before taskdag_recon_prepare" >&2; return 2; }
    local node
    node=$(taskdag_normalize_node "$1") || { echo "Error: invalid node: $1" >&2; return 2; }

    # complete ⇒ not a pickable leaf.
    local rc=0
    taskdag_node_complete "$node" || rc=$?
    [ "$rc" -eq 2 ] && return 2
    [ "$rc" -eq 0 ] && return 1

    # every requires-edge satisfied.
    taskdag_recon_requires_satisfied "$node" || return 1

    # claim/block gate for a current-repo task node (bare-sha overlay refs).
    # An unresolvable current-repo task node is indeterminate ⇒ fail closed
    # (rc 2), never guessed "ready". (complete() above already returns 2 for
    # that case, so this is belt-and-suspenders.)
    local sha short resolve_rc=0
    sha=$(taskdag_recon_resolve_task_node "$node") || resolve_rc=$?
    [ "$resolve_rc" -eq 2 ] && return 2
    if [ "$resolve_rc" -eq 0 ]; then
        [ "$(taskdag_recon_task_type "$sha")" = epic ] && return 1
        is_task_blocked "$sha" && return 1
        blocked_structural_ancestor "$sha" >/dev/null 2>&1 && return 1
        short=$(git rev-parse --short "$sha" 2>/dev/null || true)
        [ -n "$short" ] && git show-ref --verify --quiet "refs/heads/tasks/active/$short" && return 1
    fi
    return 0
}

# Command: reconcile — READ-ONLY evaluation of the complete()/leaf-readiness
# predicates over the edge graph (issue #13 north-star). Never writes a ref.
cmd_reconcile() {
    local json=false do_fetch=true node="" want_ready=false
    while [ $# -gt 0 ]; do
        case "$1" in
            --json) json=true; shift ;;
            --no-fetch) do_fetch=false; shift ;;
            --ready) want_ready=true; shift ;;
            --node) node="${2:-}"; shift 2 ;;
            --node=*) node="${1#*=}"; shift ;;
            --help|-h)
                cat <<'EOF'
Usage: task-dag reconcile [--json] [--no-fetch] [--node <node>] [--ready]

READ (only) the AGGREGATED complete()/leaf-readiness verdicts of the
dependency graph (issue #13 north-star), computed from master's completion
history and the active edge set. This is the layer above the raw `facts`:

  complete(node)  ⟺ done(node), OR an outgoing satisfies-edge is satisfied,
                    OR (node has obligations — containment children and/or
                    outgoing requires-edges) AND every child subtree is
                    complete AND every requires-edge is satisfied.
  ready(node)     ⟺ NOT complete AND every requires-edge satisfied AND (for a
                    current-repo task node) unclaimed AND unblocked.

It NEVER writes a ref and does not drive live frontier/complete/epic-close
behavior (those are later-phase sibling tasks); it only reports the verdicts.

Default (online): syncs BOTH origin/master and the graph index before
deriving; --no-fetch reads BOTH from local refs only (offline). Containment
children and claim/block are read from LOCAL task refs (like `frontier`).

  --node <node>   evaluate ONE node. Prints "<node>\tcomplete|incomplete"
                  and EXITS 0 if complete / 1 if not / 2 on error; with
                  --ready prints "<node>\tready|not-ready" and the exit code
                  reflects readiness instead.
  --ready         with --node, make the exit status reflect readiness; in the
                  table, this is informational (both columns always shown).
  --json          emit JSON ({node,complete,ready} with --node, else an array
                  of such objects over every distinct edge-source node).
  --no-fetch      local refs only (offline).

Requires jq.
EOF
                return 0
                ;;
            *) echo "Error: unknown option: $1" >&2; return 2 ;;
        esac
    done

    local prep=()
    [ "$do_fetch" = false ] && prep+=(--no-fetch)
    taskdag_recon_prepare "${prep[@]}" || return 2

    # Single-node query.
    if [ -n "$node" ]; then
        local nn crc=0 rrc=0 cbool rbool
        nn=$(taskdag_normalize_node "$node") || { echo "Error: invalid node: $node" >&2; return 2; }
        taskdag_node_complete "$nn" || crc=$?
        [ "$crc" -eq 2 ] && return 2
        taskdag_leaf_ready "$nn" || rrc=$?
        [ "$rrc" -eq 2 ] && return 2
        [ "$crc" -eq 0 ] && cbool=true || cbool=false
        [ "$rrc" -eq 0 ] && rbool=true || rbool=false

        if [ "$json" = true ]; then
            jq -nc --arg node "$nn" --argjson complete "$cbool" --argjson ready "$rbool" \
                '{node:$node, complete:$complete, ready:$ready}'
        elif [ "$want_ready" = true ]; then
            printf '%s\t%s\n' "$nn" "$([ "$rrc" -eq 0 ] && echo ready || echo not-ready)"
        else
            printf '%s\t%s\n' "$nn" "$([ "$crc" -eq 0 ] && echo complete || echo incomplete)"
        fi
        if [ "$want_ready" = true ]; then return "$rrc"; else return "$crc"; fi
    fi

    # Table / array over every distinct edge-source node.
    local nodes
    nodes=$(printf '%s' "$TASKDAG_RECON_EDGES_JSON" | jq -r '[.[].from] | unique[]')

    if [ "$json" = true ]; then
        local out='[]' n crc rrc cbool rbool
        while IFS= read -r n; do
            [ -n "$n" ] || continue
            crc=0; taskdag_node_complete "$n" || crc=$?
            [ "$crc" -eq 2 ] && return 2
            rrc=0; taskdag_leaf_ready "$n" || rrc=$?
            [ "$rrc" -eq 2 ] && return 2
            [ "$crc" -eq 0 ] && cbool=true || cbool=false
            [ "$rrc" -eq 0 ] && rbool=true || rbool=false
            out=$(printf '%s' "$out" | jq -c --arg node "$n" --argjson complete "$cbool" --argjson ready "$rbool" \
                '. + [{node:$node, complete:$complete, ready:$ready}]')
        done <<< "$nodes"
        printf '%s\n' "$out"
        return 0
    fi

    if [ -z "$nodes" ]; then
        printf "${BOLD}No edge-source nodes to reconcile${RESET} (%s)\n" "$TASKDAG_GRAPH_REF"
        return 0
    fi
    printf "${BOLD}%-9s %-9s %-42s${RESET}\n" "COMPLETE" "READY" "NODE"
    local n crc rrc
    while IFS= read -r n; do
        [ -n "$n" ] || continue
        crc=0; taskdag_node_complete "$n" || crc=$?
        [ "$crc" -eq 2 ] && return 2
        rrc=0; taskdag_leaf_ready "$n" || rrc=$?
        [ "$rrc" -eq 2 ] && return 2
        printf "%-9s %-9s %-42s\n" \
            "$([ "$crc" -eq 0 ] && echo yes || echo no)" \
            "$([ "$rrc" -eq 0 ] && echo yes || echo no)" \
            "$n"
    done <<< "$nodes"
    return 0
}
