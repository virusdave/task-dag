# shellcheck shell=bash

if ! declare -F is_task_blocked >/dev/null || ! declare -F blocked_structural_ancestor >/dev/null; then
    echo "Error: reconcile.sh requires blocked-core.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F taskdag_node_complete >/dev/null \
    || ! declare -F taskdag_leaf_ready >/dev/null; then
    echo "Error: reconcile.sh requires reconciliation-core.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F taskdag_consumer_prepare >/dev/null \
    || ! declare -F taskdag_consumer_require_prepared >/dev/null; then
    echo "Error: reconcile.sh requires semantic-consumer.sh to be loaded first" >&2
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
# Canonical state and aggregation live in reconciliation-core.sh, while
# semantic-consumer.sh owns attested snapshot preparation. This module retains
# status rendering and the command adapter over those read-only providers.
# ═══════════════════════════════════════════════════════════════════════

# The canonical empty tree — also defined in the main script; a fallback so
# this module is correct when sourced standalone (tests).
: "${EMPTY_TREE:=4b825dc642cb6eb9a060e54bf8d69288fbee4904}"

# Canonical parent-encoded dependency verdict used by legacy-shaped task
# commits while graph migration is drained. Callers consume this JSON instead
# of reconstructing readiness. The authority tip is mandatory.
_taskdag_legacy_parent_dependency_status_json() {
    local tip="$1" task="$2" dep complete=true reasons='[]' deps='[]' done
    git rev-parse --verify -q "${tip}^{commit}" >/dev/null 2>&1 || return 2
    while IFS= read -r dep; do
        [ -n "$dep" ] || continue
        done=false
        if taskdag_task_completed_at_tip "$tip" "$dep"; then done=true; else complete=false; fi
        deps=$(jq -c --arg sha "$dep" --argjson completed "$done" '. + [{sha:$sha,completed:$completed}]' <<<"$deps") || return 2
        if [ "$done" = false ]; then
            reasons=$(jq -c --arg sha "$dep" '. + [{code:"incomplete-requirement",task:$sha}]' <<<"$reasons") || return 2
        fi
    done < <(get_dep_parents "$task")
    jq -nc --arg task "$task" --arg tip "$(git rev-parse "${tip}^{commit}")" \
        --argjson ready "$complete" --argjson reasons "$reasons" --argjson dependencies "$deps" \
        '{schema:1,task:$task,authorityTip:$tip,dependencies:$dependencies,ready:$ready,reasons:$reasons}'
}

taskdag_requirements_status_json() {
    local node=$1 task="" dep complete=true reasons='[]' deps='[]' rc normalized
    taskdag_consumer_require_prepared || return 2
    normalized=$(taskdag_normalize_node "$node") || return 2
    if [ "$TASKDAG_CONSUMER_MODE" = legacy ]; then
        case "$normalized" in
            task:${TASKDAG_RECON_CUR}@*) task=${normalized##*@} ;;
            *) jq -ncS '{requirements:[],requirementsSatisfied:true,reasons:[]}'; return 0 ;;
        esac
        _taskdag_legacy_parent_dependency_status_json "$TASKDAG_CONSUMER_TIP" "$task" \
          | jq -cS '{requirements:(.dependencies|map({node:("task:'"$TASKDAG_RECON_CUR"'@"+.sha),complete:.completed})),requirementsSatisfied:.ready,reasons}'
        return ${PIPESTATUS[0]}
    fi
    while IFS= read -r dep; do
        [ -n "$dep" ] || continue
        rc=0; taskdag_node_complete "$dep" || rc=$?
        [ "$rc" -eq 2 ] && return 2
        if [ "$rc" -eq 0 ]; then
            deps=$(jq -c --arg node "$dep" '.+[{node:$node,complete:true}]' <<<"$deps") || return 2
        else
            complete=false
            deps=$(jq -c --arg node "$dep" '.+[{node:$node,complete:false}]' <<<"$deps") || return 2
            reasons=$(jq -c --arg node "$dep" '.+[{code:"incomplete-requirement",node:$node}]' <<<"$reasons") || return 2
        fi
    done < <(jq -r --arg n "$normalized" '.[]|select(.from==$n and .relation=="requires")|.to' <<<"$TASKDAG_RECON_EDGES_JSON")
    jq -ncS --argjson requirements "$deps" --argjson requirementsSatisfied "$complete" --argjson reasons "$reasons" \
        '{requirements:$requirements,requirementsSatisfied:$requirementsSatisfied,reasons:$reasons}'
}

taskdag_task_status_json() { # <task-node> [--include-claimed]
    local node=$1 include_claimed=false normalized sha short complete=false blocked=false claimed=false ancestor="" ready=false reasons='[]' req rc
    [ "${2:-}" = --include-claimed ] && include_claimed=true
    taskdag_consumer_require_prepared || return 2
    normalized=$(taskdag_normalize_node "$node") || return 2
    if [ "$TASKDAG_CONSUMER_MODE" = legacy ]; then
        case "$normalized" in task:${TASKDAG_RECON_CUR}@*) sha=${normalized##*@} ;; *) return 2 ;; esac
        taskdag_task_completed_at_tip "$TASKDAG_CONSUMER_TIP" "$sha" && complete=true
    else
        sha=$(taskdag_recon_resolve_task_node "$normalized") || return 2
        rc=0; taskdag_node_complete "$normalized" || rc=$?; [ "$rc" -eq 2 ] && return 2; [ "$rc" -eq 0 ] && complete=true
    fi
    req=$(taskdag_requirements_status_json "$normalized") || return 2
    is_task_blocked "$sha" && blocked=true
    ancestor=$(blocked_structural_ancestor "$sha" 2>/dev/null || true)
    short=$(git rev-parse --short "$sha") || return 2
    git show-ref --verify --quiet "refs/heads/tasks/active/$short" && claimed=true
    reasons=$(jq -c '.reasons' <<<"$req") || return 2
    [ "$complete" = true ] && reasons=$(jq -c '.+[{code:"complete"}]' <<<"$reasons")
    [ "$blocked" = true ] && reasons=$(jq -c '.+[{code:"blocked"}]' <<<"$reasons")
    if [ -n "$ancestor" ] && ! is_human_comment_task "$sha"; then reasons=$(jq -c --arg task "$ancestor" '.+[{code:"ancestor-blocked",task:$task}]' <<<"$reasons"); fi
    [ "$claimed" = true ] && [ "$include_claimed" = false ] && reasons=$(jq -c '.+[{code:"claimed"}]' <<<"$reasons")
    if [ "$complete" = false ] && [ "$(jq -r .requirementsSatisfied <<<"$req")" = true ] && [ "$blocked" = false ] \
      && { [ -z "$ancestor" ] || is_human_comment_task "$sha"; } \
      && { [ "$claimed" = false ] || [ "$include_claimed" = true ]; }; then ready=true; fi
    jq -ncS --arg node "$normalized" --arg task "$sha" --arg mode "$TASKDAG_CONSUMER_MODE" --arg tip "$TASKDAG_CONSUMER_TIP" \
      --argjson activation "$TASKDAG_CONSUMER_ACTIVATION" --argjson complete "$complete" --argjson blocked "$blocked" \
      --arg blockedAncestor "$ancestor" --argjson claimed "$claimed" --argjson ready "$ready" --argjson requirements "$(jq -c .requirements <<<"$req")" \
      --argjson requirementsSatisfied "$(jq -c .requirementsSatisfied <<<"$req")" --argjson reasons "$reasons" \
      '{schema:1,node:$node,task:$task,complete:$complete,requirements:$requirements,requirementsSatisfied:$requirementsSatisfied,blocked:$blocked,blockedAncestor:(if $blockedAncestor=="" then null else $blockedAncestor end),claimed:$claimed,ready:$ready,reasons:$reasons,attestation:{mode:$mode,factsTip:$tip,activation:$activation}}'
}

taskdag_root_status_json() { # <root-node> <issue>
    local node=$1 issue=$2 normalized sha complete=false blocked=false claimed=false decomposed=false pickable=false req rc reasons='[]'
    taskdag_consumer_require_prepared || return 2
    normalized=$(taskdag_normalize_node "$node") || return 2
    if [ "$TASKDAG_CONSUMER_MODE" = legacy ]; then
        case "$normalized" in task:${TASKDAG_RECON_CUR}@*) sha=${normalized##*@} ;; *) return 2 ;; esac
        taskdag_task_completed_at_tip "$TASKDAG_CONSUMER_TIP" "$sha" && complete=true
    else
        sha=$(taskdag_recon_resolve_task_node "$normalized") || return 2
        rc=0; taskdag_node_complete "$normalized" || rc=$?; [ "$rc" -eq 2 ] && return 2; [ "$rc" -eq 0 ] && complete=true
    fi
    req=$(taskdag_requirements_status_json "$normalized") || return 2
    task_has_children "$sha" >/dev/null 2>&1 && decomposed=true
    is_task_blocked "$sha" && blocked=true
    git show-ref --verify --quiet "refs/heads/tasks/root-active/$issue" && claimed=true
    reasons=$(jq -c '.reasons' <<<"$req")
    [ "$complete" = true ] && reasons=$(jq -c '.+[{code:"complete"}]' <<<"$reasons")
    [ "$decomposed" = true ] && reasons=$(jq -c '.+[{code:"decomposed"}]' <<<"$reasons")
    [ "$claimed" = true ] && reasons=$(jq -c '.+[{code:"claimed"}]' <<<"$reasons")
    [ "$blocked" = true ] && reasons=$(jq -c '.+[{code:"blocked"}]' <<<"$reasons")
    if [ "$complete" = false ] && [ "$decomposed" = false ] && [ "$claimed" = false ] && [ "$blocked" = false ] \
      && [ "$(jq -r .requirementsSatisfied <<<"$req")" = true ]; then pickable=true; fi
    jq -ncS --arg node "$normalized" --arg task "$sha" --arg mode "$TASKDAG_CONSUMER_MODE" --arg tip "$TASKDAG_CONSUMER_TIP" \
      --argjson activation "$TASKDAG_CONSUMER_ACTIVATION" --argjson complete "$complete" --argjson decomposed "$decomposed" \
      --argjson claimed "$claimed" --argjson blocked "$blocked" --argjson requirements "$(jq -c .requirements <<<"$req")" \
      --argjson requirementsSatisfied "$(jq -c .requirementsSatisfied <<<"$req")" --argjson pickable "$pickable" --argjson reasons "$reasons" \
      '{schema:1,node:$node,task:$task,complete:$complete,decomposed:$decomposed,claimed:$claimed,blocked:$blocked,requirements:$requirements,requirementsSatisfied:$requirementsSatisfied,pickable:$pickable,reasons:$reasons,attestation:{mode:$mode,factsTip:$tip,activation:$activation}}'
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
