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
# Relies on the edge reader, fact-backed prunability, semantic preparation,
# and the graph mutation primitives in edges-write.sh. The entrypoint composes
# this module's pruning adapter with the writer's add/drop adapters only after
# both provider modules have loaded.
#
# Scope boundary: this module PRUNES prunable edges; it does NOT decide what
# a completion TRIGGERS (the reconciler / supersede / mailbox siblings do). In
# particular it does NOT synthesize a supersede completion — a `satisfies` edge
# is kept until the DEPENDENT itself is done (that is what the reconcile
# predicate reads to detect supersede), so pruning it earlier would drop the
# still-needed supersede signal.
# ═══════════════════════════════════════════════════════════════════════

for prerequisite in taskdag_read_edges taskdag_sync_graph_ref taskdag_sync_master \
    taskdag_edge_prunable taskdag_consumer_prepare _taskdag_graph_edge_tuple \
    _taskdag_graph_cas _taskdag_graph_has_path taskdag_dep_help; do
    if ! declare -F "$prerequisite" >/dev/null; then
        echo "Error: edges-prune.sh requires provider $prerequisite to be loaded first" >&2
        return 2 2>/dev/null || exit 2
    fi
done
for prerequisite in TASKDAG_GRAPH_REF GREEN BLUE BOLD RESET; do
    if ! declare -p "$prerequisite" >/dev/null 2>&1; then
        echo "Error: edges-prune.sh requires global $prerequisite to be initialized first" >&2
        return 2 2>/dev/null || exit 2
    fi
done
unset prerequisite

# taskdag_prune_edge <edge-id>: prune ONE edge iff it is PRUNABLE (see
# taskdag_edge_prunable). Returns:
#   0  pruned (or already absent — nothing to prune)
#   1  failed loud (edge is NOT prunable, corrupt, indeterminate facts, or a
#      transport/CAS failure) — a not-yet-prunable edge must be `dep drop`ped
#      (tombstoned), never silently pruned.
# The source-time contract requires the fact-backed predicate; pruning without
# a durable completion witness would be an unwitnessed deletion.
taskdag_prune_edge() {
    local eid="$1"
    [[ "$eid" =~ ^[0-9a-f]{64}$ ]] || { echo "Error: prune needs a 64-hex edge-id (got: $eid)" >&2; return 1; }
    local epath="edges/${eid}.json"
    # Already gone (e.g. concurrently pruned) → idempotent success.
    if ! _taskdag_graph_has_path "$epath"; then
        printf "${BLUE}• Edge %s not present${RESET} (nothing to prune)\n" "${eid:0:12}"
        return 0
    fi

    local tuple from to relation
    tuple=$(_taskdag_graph_edge_tuple "$eid") || { echo "Error: edge ${eid:0:12} is corrupt / non-canonical; cannot prune it safely" >&2; return 1; }
    IFS=$'\t' read -r from to relation _ <<<"$tuple"

    if ! taskdag_edge_prunable "$relation" "$from" "$to"; then
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
        if taskdag_edge_prunable "$relation" "$from" "$to"; then
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
            --help|-h) taskdag_dep_help; return 0 ;;
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
        taskdag_sync_master || { echo "Error: could not sync origin/master (indeterminate); refusing to prune on a possibly-stale view (use --no-fetch to prune against local refs)" >&2; return 1; }
    fi

    local consumer_args=()
    [ "$do_fetch" = false ] && consumer_args+=(--no-fetch --tip HEAD)
    taskdag_consumer_prepare dep-prune "${consumer_args[@]}" || return 1

    if [ -n "$eid" ]; then
        taskdag_prune_edge "$eid"
    else
        local args=()
        [ "$do_fetch" = false ] && args+=(--no-fetch)
        taskdag_prune_satisfied "${args[@]}"
    fi
}
