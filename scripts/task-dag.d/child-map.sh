#!/usr/bin/env bash
# Process-local decomposition child-map state and exact child discovery.
# Synchronization and feature-level orchestration remain with their consumers.

if [ -z "${EMPTY_TREE:-}" ]; then
    echo "Error: child-map.sh requires source-contract.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi

declare -gA TASKDAG_RECON_FP_CHILDREN=()
declare -gA TASKDAG_CHILDREN_ANY=()
TASKDAG_CHILD_MAP_READY=false
TASKDAG_CHILD_MAP_MASTER=""
TASKDAG_CHILD_MAP_REFS=""
TASKDAG_CHILD_MAP_SOURCE=""

taskdag_reset_child_map() {
    TASKDAG_CHILD_MAP_READY=false
    TASKDAG_CHILD_MAP_MASTER=""
    TASKDAG_CHILD_MAP_REFS=""
    TASKDAG_CHILD_MAP_SOURCE=""
    TASKDAG_CHILDREN_ANY=()
    TASKDAG_RECON_FP_CHILDREN=()
}

taskdag_prepare_child_map() {
    taskdag_prepare_child_map_from refs/remotes/origin/master
}

taskdag_normalize_v1_task_refs() {
    awk '$2 !~ /^refs\/heads\/tasks\/(frontier|active|blocked|blocked-meta)\/v2-[0-9a-f]{64}$/'
}

taskdag_capture_child_map_refs() {
    git for-each-ref --format='%(objectname) %(refname)' \
        refs/heads/tasks/frontier/ refs/heads/tasks/active/ \
        refs/heads/tasks/blocked/ refs/heads/tasks/blocked-meta/ \
        refs/heads/tasks/root-active/ refs/heads/tasks/pending/ \
        refs/heads/gh/issues/ \
        | taskdag_normalize_v1_task_refs \
        | LC_ALL=C sort
}

# Build only from the selected authority and the normalized task-ref snapshot.
# In particular, origin/master supplies completed children whose scheduling
# refs have retired; arbitrary local branches and unreferenced objects cannot
# enter the map.
taskdag_prepare_child_map_from() {
    local authority_ref=$1
    local timing
    taskdag_timing_start timing child-map.prepare
    taskdag_reset_child_map

    local master us=$'\x1f' commit tree subject parents first parent map_file
    master=$(git rev-parse --verify -q "${authority_ref}^{commit}") || return 2
    TASKDAG_CHILD_MAP_MASTER=$master
    TASKDAG_CHILD_MAP_SOURCE=$authority_ref
    TASKDAG_CHILD_MAP_REFS=$(taskdag_capture_child_map_refs) || return 2
    map_file=$(mktemp) || return 2
    if ! {
        printf '%s\n' "$master"
        awk '{print $1}' <<<"$TASKDAG_CHILD_MAP_REFS"
    } | git log --stdin --format="%H${us}%T${us}%s${us}%P" >"$map_file" 2>/dev/null; then
        rm -f "$map_file"
        return 2
    fi
    while IFS="$us" read -r commit tree subject parents; do
        [ -n "$commit" ] || continue
        [ "$tree" = "$EMPTY_TREE" ] || continue
        case "$subject" in
            Claim:*|Blocked-Meta:*|kind:\ delegated*|kind:\ completion*) continue ;;
        esac
        first="${parents%% *}"
        [ -n "$first" ] || continue
        TASKDAG_RECON_FP_CHILDREN["$first"]+="$commit"$'\n'
        for parent in $parents; do
            TASKDAG_CHILDREN_ANY["$parent"]+="$commit"$'\n'
        done
    done <"$map_file"
    rm -f "$map_file"
    TASKDAG_CHILD_MAP_READY=true
    taskdag_timing_finish timing child-map.prepare ready
}

task_has_children() {
    local parent_sha="$1"
    [ "$TASKDAG_CHILD_MAP_READY" = true ] || return 2
    local children="${TASKDAG_CHILDREN_ANY[$parent_sha]:-}"
    [ -n "$children" ] || return 1
    printf '%s\n' "${children%%$'\n'*}"
}

task_has_structural_children() {
    local parent_sha="$1"
    [ "$TASKDAG_CHILD_MAP_READY" = true ] || return 2
    local children="${TASKDAG_RECON_FP_CHILDREN[$parent_sha]:-}"
    [ -n "$children" ] || return 1
    printf '%s\n' "${children%%$'\n'*}"
}

list_dag_children() {
    local parent_sha="$1"
    [ "$TASKDAG_CHILD_MAP_READY" = true ] || return 2
    printf '%s' "${TASKDAG_CHILDREN_ANY[$parent_sha]:-}"
}
