# shellcheck shell=bash

# Canonical complete()/leaf-readiness state and pure aggregation providers.
# This module is deliberately read-only: graph writers, command adapters,
# semantic-consumer orchestration, rendering, and scheduling fences belong to
# later modules.  The entrypoint is the only loader; modules never source one
# another.
if ! declare -F taskdag_prepare_child_map_from >/dev/null \
    || ! declare -F taskdag_prepare_child_map >/dev/null \
    || ! declare -F taskdag_reset_child_map >/dev/null; then
    echo "Error: reconciliation-core.sh requires child-map.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F taskdag_normalize_node >/dev/null; then
    echo "Error: reconciliation-core.sh requires edges.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F taskdag_edges_with_facts >/dev/null || ! declare -F taskdag_node_done >/dev/null \
    || ! declare -F taskdag_typed_root_completed_at_tip >/dev/null \
    || ! declare -F taskdag_load_facts >/dev/null; then
    echo "Error: reconciliation-core.sh requires facts.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F taskdag_current_repo >/dev/null; then
    echo "Error: reconciliation-core.sh requires repository-identity.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F taskdag_sync_root_refs >/dev/null; then
    echo "Error: reconciliation-core.sh requires github-origin.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F is_task_commit >/dev/null; then
    echo "Error: reconciliation-core.sh requires git-objects.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F is_task_blocked >/dev/null || ! declare -F blocked_structural_ancestor >/dev/null; then
    echo "Error: reconciliation-core.sh requires blocked-core.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi

# Process-global state, prepared once per authority snapshot.  Keeping this
# state in the unique provider module preserves cache ownership across every
# consumer in the live shell.
TASKDAG_RECON_EDGES_JSON=""
TASKDAG_RECON_FACTS_TIP=""
declare -gA TASKDAG_RECON_NODE_STATE=()
TASKDAG_RECON_CUR=""
TASKDAG_RECON_READY=false

# taskdag_recon_build_child_map: the child-map module owns capture; this
# provider verifies that an authoritative map is available to aggregation.
taskdag_recon_build_child_map() {
    [ "$TASKDAG_CHILD_MAP_READY" = true ] || return 2
}

# Prepare the complete edge/fact/containment authority snapshot.  This is
# tri-state-safe: failures clear readiness before returning indeterminate.
taskdag_recon_prepare() {
    local nofetch=false tip="" arg
    while [ "$#" -gt 0 ]; do
        arg=$1; shift
        case "$arg" in
            --no-fetch) nofetch=true ;;
            --tip) tip=${1:-}; [ -n "$tip" ] || return 2; shift ;;
            --tip=*) tip=${arg#*=} ;;
            *) echo "Error: unknown reconcile option: $arg" >&2; return 2 ;;
        esac
    done
    command -v jq >/dev/null 2>&1 || { echo "Error: jq is required to reconcile the dependency graph" >&2; return 2; }

    TASKDAG_RECON_READY=false
    TASKDAG_RECON_EDGES_JSON=""
    TASKDAG_RECON_FACTS_TIP=""
    TASKDAG_RECON_CUR=""
    if [ "$nofetch" = true ]; then
        [ "$TASKDAG_CHILD_MAP_READY" = true ] || {
            echo "Error: offline reconciliation requires an already-prepared authoritative child snapshot" >&2
            return 2
        }
    else
        taskdag_reset_child_map
    fi
    TASKDAG_RECON_NODE_STATE=()

    if [ "$nofetch" = false ]; then
        taskdag_sync_root_refs >/dev/null 2>&1 \
          && taskdag_prepare_child_map >/dev/null 2>&1 \
          || { echo "Error: could not sync the authoritative master/task-ref snapshot (indeterminate); refusing reconciliation" >&2; return 2; }
    fi

    local args=() facts_args=()
    [ "$nofetch" = true ] && args+=(--no-fetch)
    facts_args=("${args[@]}")
    [ -n "$tip" ] || tip=$TASKDAG_CHILD_MAP_MASTER
    tip=$(git rev-parse --verify -q "${tip}^{commit}") || return 2
    taskdag_load_facts "$tip" || return 2
    [ "$TASKDAG_FACTS_TIP_OID" = "$tip" ] || return 2
    facts_args+=(--tip "$tip")
    TASKDAG_RECON_EDGES_JSON=$(taskdag_edges_with_facts "${facts_args[@]}") || return 2
    TASKDAG_RECON_FACTS_TIP=$tip

    TASKDAG_RECON_CUR=$(taskdag_current_repo) || { echo "Error: cannot resolve current repo to reconcile the graph" >&2; return 2; }
    taskdag_recon_build_child_map || return 2
    TASKDAG_RECON_READY=true
    return 0
}

taskdag_recon_resolve_task_node() {
    local node="$1" rest or ref
    case "$node" in task:*) ;; *) return 1 ;; esac
    rest="${node#task:}"; or="${rest%@*}"; ref="${rest##*@}"
    [ "$or" = "$TASKDAG_RECON_CUR" ] || return 1
    git rev-parse -q --verify "${ref}^{commit}" >/dev/null 2>&1 || return 2
    is_task_commit "$ref" || return 2
    printf '%s\n' "$ref"
}

taskdag_recon_has_satisfying_edge() {
    local target rc
    while IFS= read -r target; do
        [ -n "$target" ] || continue
        rc=0; taskdag_node_complete "$target" || rc=$?
        [ "$rc" -eq 0 ] && return 0
        [ "$rc" -eq 2 ] && return 2
    done < <(printf '%s' "$TASKDAG_RECON_EDGES_JSON" | jq -r --arg n "$1" \
        '.[] | select(.from == $n and .relation == "satisfies") | .to')
    return 1
}

taskdag_recon_requires_satisfied() {
    local target rc
    while IFS= read -r target; do
        [ -n "$target" ] || continue
        rc=0; taskdag_node_complete "$target" || rc=$?
        [ "$rc" -eq 2 ] && return 2
        [ "$rc" -eq 0 ] || return 1
    done < <(printf '%s' "$TASKDAG_RECON_EDGES_JSON" | jq -r --arg n "$1" \
        '.[] | select(.from == $n and .relation == "requires") | .to')
    return 0
}

taskdag_recon_has_requires() {
    printf '%s' "$TASKDAG_RECON_EDGES_JSON" | jq -e --arg n "$1" \
        'any(.[]; .from == $n and .relation == "requires")' >/dev/null 2>&1
}

taskdag_recon_task_type() {
    git log -1 --format='%B' "$1" 2>/dev/null \
        | awk -F':[[:space:]]*' 'tolower($1) == "type" { print tolower($2); exit }'
}

taskdag__node_complete_impl() {
    local node
    node=$(taskdag_normalize_node "$1") || { echo "Error: invalid node: $1" >&2; return 2; }
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
        if [ -n "$children" ] || [ "$task_type" = epic ]; then is_epic=true; fi
        # A validated typed root close is the root task node's lifecycle fact;
        # do not reinterpret it as an ordinary task-completion parent.
        local typed_root_rc=0
        taskdag_typed_root_completed_at_tip "$TASKDAG_RECON_FACTS_TIP" "$sha" || typed_root_rc=$?
        case "$typed_root_rc" in
            0) return 0 ;;
            1) ;;
            2) return 2 ;;
            *) return 2 ;;
        esac
    fi

    if [ "$is_epic" = false ]; then
        local rc=0
        taskdag_node_done "$node" "$TASKDAG_RECON_FACTS_TIP" || rc=$?
        [ "$rc" -eq 2 ] && return 2
        [ "$rc" -eq 0 ] && return 0
    fi

    local satisfies_rc=0
    taskdag_recon_has_satisfying_edge "$node" || satisfies_rc=$?
    [ "$satisfies_rc" -eq 0 ] && return 0
    [ "$satisfies_rc" -eq 2 ] && return 2
    [ "$is_epic" = true ] || return 1
    [ -n "$children" ] || [ "$has_requires" = true ] || return 1
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

taskdag_node_complete() {
    [ "$TASKDAG_RECON_READY" = true ] || { echo "Error: taskdag_node_complete called before taskdag_recon_prepare" >&2; return 2; }
    local node state rc=0
    node=$(taskdag_normalize_node "$1") || { echo "Error: invalid node: $1" >&2; return 2; }
    state="${TASKDAG_RECON_NODE_STATE[$node]:-}"
    case "$state" in
        complete) return 0 ;;
        incomplete) return 1 ;;
        visiting) echo "Error: dependency graph cycle encountered while resolving $node" >&2; return 2 ;;
    esac
    TASKDAG_RECON_NODE_STATE["$node"]=visiting
    taskdag__node_complete_impl "$node" || rc=$?
    case "$rc" in
        0) TASKDAG_RECON_NODE_STATE["$node"]=complete ;;
        1) TASKDAG_RECON_NODE_STATE["$node"]=incomplete ;;
        *) unset 'TASKDAG_RECON_NODE_STATE[$node]' ;;
    esac
    return "$rc"
}

taskdag_leaf_ready() {
    [ "$TASKDAG_RECON_READY" = true ] || { echo "Error: taskdag_leaf_ready called before taskdag_recon_prepare" >&2; return 2; }
    local node
    node=$(taskdag_normalize_node "$1") || { echo "Error: invalid node: $1" >&2; return 2; }
    local rc=0
    taskdag_node_complete "$node" || rc=$?
    [ "$rc" -eq 2 ] && return 2
    [ "$rc" -eq 0 ] && return 1
    taskdag_recon_requires_satisfied "$node" || return 1
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
