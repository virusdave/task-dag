# shellcheck shell=bash
# ═══════════════════════════════════════════════════════════════════════
# task-dag SATISFIED-EDGE PRUNING (issue #13 north-star — the bounded-set
# backstop beneath the reconciler)
#
# Keeps the active edge set BOUNDED: once an edge is SATISFIED — its target
# (`to`) is a durable completion fact on `master` (derived by facts.sh) — it
# no longer needs to live in the active set, because re-deriving from master
# would just re-confirm it. Pruning is a plain FF tree deletion of
# edges/<edge-id>.json via the same direct-CAS writer used for add/drop (the
# completion on master is the durable witness, so NO tombstone is written).
#
# This is the SATISFIED path only. Deliberate removal BEFORE satisfaction is
# `dep drop`'s tombstone path (edges-write.sh) — pruning here REFUSES to touch
# an unsatisfied edge (that would be an unwitnessed silent deletion). The
# tombstone blob serializer + reader masking live in edges.sh.
#
# Relies on: taskdag_read_edges / taskdag_edges_with_facts (facts.sh),
# taskdag_node_done (facts.sh), _taskdag_graph_edge_tuple / _taskdag_graph_cas
# / _taskdag_graph_has_path (edges-write.sh), taskdag_sync_graph_ref (edges.sh),
# taskdag_sync_master (facts.sh), TASKDAG_GRAPH_REF / colors (main script).
#
# Scope boundary: this module PRUNES prunable edges; it does NOT decide what
# a completion TRIGGERS (the reconciler / supersede / mailbox siblings do). In
# particular it does NOT synthesize a supersede completion — a `satisfies` edge
# is kept until the DEPENDENT itself is done (that is what the reconcile
# predicate reads to detect supersede), so pruning it earlier would drop the
# still-needed supersede signal.
# ═══════════════════════════════════════════════════════════════════════

# _taskdag_edge_prunable <relation> <from> <to>: 0 iff removing this edge is
# backed by a DURABLE master completion witness (so re-deriving the graph from
# master would reconfirm the same active set — a plain prune loses nothing):
#   • requires  edge → prunable iff done(TO)   (the target completed; the
#                      obligation is permanently met and recorded on master).
#   • satisfies edge → prunable iff done(FROM) (the DEPENDENT completed; the
#                      supersede has been consumed and recorded on master — the
#                      reconcile predicate no longer needs the edge to detect
#                      it). NOT done(to): a satisfies edge whose target is done
#                      is the LIVE supersede signal and must stay active until
#                      the dependent's own completion is durable.
# Returns non-zero (not prunable) if the fact layer is unavailable or the
# witness node is not done / indeterminate — pruning is the only unwitnessed
# action, so it fails closed.
_taskdag_edge_prunable() {
    local relation="$1" from="$2" to="$3" node drc=0
    declare -F taskdag_node_done >/dev/null 2>&1 || return 1
    case "$relation" in
        requires) node="$to" ;;
        satisfies) node="$from" ;;
        *) return 1 ;;
    esac
    taskdag_node_done "$node" >/dev/null 2>&1 || drc=$?
    [ "$drc" -eq 0 ]
}

# taskdag_prune_edge <edge-id>: prune ONE edge iff it is PRUNABLE (see
# _taskdag_edge_prunable). Returns:
#   0  pruned (or already absent — nothing to prune)
#   1  failed loud (edge is NOT prunable, corrupt, indeterminate facts, or a
#      transport/CAS failure) — a not-yet-prunable edge must be `dep drop`ped
#      (tombstoned), never silently pruned.
# Requires the fact layer (taskdag_node_done); pruning without a durable
# completion witness would be an unwitnessed deletion, so it fails loud if the
# fact layer is unavailable.
taskdag_prune_edge() {
    local eid="$1"
    [[ "$eid" =~ ^[0-9a-f]{64}$ ]] || { echo "Error: prune needs a 64-hex edge-id (got: $eid)" >&2; return 1; }
    declare -F taskdag_node_done >/dev/null 2>&1 || { echo "Error: prune requires the fact layer (taskdag_node_done) to verify the completion witness" >&2; return 1; }

    local epath="edges/${eid}.json"
    # Already gone (e.g. concurrently pruned) → idempotent success.
    if ! _taskdag_graph_has_path "$epath"; then
        printf "${BLUE}• Edge %s not present${RESET} (nothing to prune)\n" "${eid:0:12}"
        return 0
    fi

    local tuple from to relation
    tuple=$(_taskdag_graph_edge_tuple "$eid") || { echo "Error: edge ${eid:0:12} is corrupt / non-canonical; cannot prune it safely" >&2; return 1; }
    IFS=$'\t' read -r from to relation _ <<<"$tuple"

    if ! _taskdag_edge_prunable "$relation" "$from" "$to"; then
        local w; [ "$relation" = satisfies ] && w="dependent ${from}" || w="target ${to}"
        echo "Error: edge ${eid:0:12} is NOT prunable (${w} not done); refusing to prune — use 'dep drop' to tombstone a deliberate removal before its completion witness exists" >&2
        return 1
    fi

    local witness msg rc
    [ "$relation" = satisfies ] && witness="dependent ${from} done" || witness="target ${to} done"
    msg="Prune dependency edge ${eid:0:12} (${witness})

Edge-Id: ${eid}
Relation: ${relation}
Prune-Witness: ${witness}"
    rc=0; _taskdag_graph_cas "$msg" remove "$epath" "" || rc=$?
    case "$rc" in
        0) printf "${GREEN}✓ Pruned edge %s${RESET} (%s)\n" "${eid:0:12}" "$witness" ;;
        2) printf "${BLUE}• Edge %s not present${RESET} (nothing to prune)\n" "${eid:0:12}"; return 0 ;;
        *) return 1 ;;
    esac
}

# taskdag_prune_satisfied [--no-fetch]: prune EVERY currently-PRUNABLE active
# edge (the bounded-set backstop the reconciler drives) — a requires edge whose
# target is done, or a satisfies edge whose DEPENDENT is done. Prints one line
# per pruned edge; returns 0 unless a prune failed loud.
taskdag_prune_satisfied() {
    local edges eid from to relation rc=0 any=0
    edges=$(taskdag_read_edges "$@") || { echo "Error: could not read edges to prune" >&2; return 1; }
    while IFS=$'\t' read -r eid from to relation; do
        [ -n "$eid" ] || continue
        if _taskdag_edge_prunable "$relation" "$from" "$to"; then
            any=1
            taskdag_prune_edge "$eid" || rc=1
        fi
    done < <(printf '%s' "$edges" | jq -r '.[] | [.edgeId, .from, .to, .relation] | @tsv')
    [ "$any" -eq 1 ] || printf "${BOLD}No prunable edges${RESET} (%s)\n" "$TASKDAG_GRAPH_REF"
    return "$rc"
}

_cmd_dep_prune() {
    local eid="" do_fetch=true
    while [ $# -gt 0 ]; do
        case "$1" in
            --no-fetch) do_fetch=false; shift ;;
            --help|-h) cmd_dep --help; return 0 ;;
            -*) echo "Error: unknown option to 'dep prune': $1" >&2; return 2 ;;
            *) [ -z "$eid" ] || { echo "Error: dep prune takes a single edge-id" >&2; return 2; }; eid="$1"; shift ;;
        esac
    done

    # Freshen BOTH the graph index and master so satisfaction AND edge-presence
    # are judged against origin (fail closed on indeterminate transport), unless
    # the caller explicitly asked to stay local. The bulk path re-syncs the
    # graph via the reader, but the single-edge path's presence check is
    # local-only, so the graph sync here is what keeps `dep prune <eid>` from
    # reporting a false "not present" against a stale local ref.
    if [ "$do_fetch" = true ]; then
        taskdag_sync_graph_ref || { echo "Error: could not sync ${TASKDAG_GRAPH_REF} (indeterminate); refusing to prune on a possibly-stale view (use --no-fetch to prune against local refs)" >&2; return 1; }
        if declare -F taskdag_sync_master >/dev/null 2>&1; then
            taskdag_sync_master || { echo "Error: could not sync origin/master (indeterminate); refusing to prune on a possibly-stale view (use --no-fetch to prune against local refs)" >&2; return 1; }
        fi
    fi

    if [ -n "$eid" ]; then
        taskdag_prune_edge "$eid"
    else
        local args=()
        [ "$do_fetch" = false ] && args+=(--no-fetch)
        taskdag_prune_satisfied "${args[@]}"
    fi
}
