# shellcheck shell=bash

if ! declare -F taskdag_recon_prepare >/dev/null \
    || ! declare -F taskdag_node_complete >/dev/null \
    || ! declare -F taskdag_leaf_ready >/dev/null; then
    echo "Error: reconcile.sh requires reconciliation-core.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F taskdag_normalize_node >/dev/null; then
    echo "Error: reconcile.sh requires edges.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
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
# Canonical state and aggregation live in reconciliation-core.sh. Reusable
# status projection moved to status-projection.sh; this module retains only
# the reconcile command adapter over the read-only predicate providers.
# ═══════════════════════════════════════════════════════════════════════

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
