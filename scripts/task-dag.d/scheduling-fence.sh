# shellcheck shell=bash

if ! declare -F taskdag_consumer_prepare >/dev/null; then
    echo "Error: scheduling-fence.sh requires semantic-consumer.sh provider taskdag_consumer_prepare to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F taskdag_requirements_status_json >/dev/null \
    || ! declare -F taskdag_task_status_json >/dev/null; then
    echo "Error: scheduling-fence.sh requires status-projection.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F taskdag_activation_snapshot_token >/dev/null \
    || ! declare -F taskdag_activation_fenced_multi_push >/dev/null; then
    echo "Error: scheduling-fence.sh requires activation.sh fencing providers to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi

# Scheduling admission predicates over one attested semantic-consumer snapshot.
# This module owns no process-global state: semantic-consumer owns the authority
# snapshot, status-projection owns its verdicts, and activation owns the fence.

# Helper: true iff every dependency parent of <sha> is completed, i.e.
# the task is "ready" to be picked up. A task with no dependency parents
# is trivially ready (a dependency-free root). Mirrors the readiness
# logic of `cmd_deps` (get_dep_parents + is_task_completed) so `frontier`
# and `deps` never disagree about whether a task is pickable.
deps_satisfied() {
    local sha="$1"
    [ "$TASKDAG_CONSUMER_READY" = true ] || taskdag_consumer_prepare requirements || return 2
    taskdag_requirements_status_json "task:${TASKDAG_RECON_CUR}@${sha}" | jq -e '.requirementsSatisfied == true' >/dev/null
}

# Helper: same dependency predicate as deps_satisfied, but evaluated against a
# caller-supplied master tip. Commands that build directly on origin/master use
# this so they do not accidentally make a readiness decision from a stale or
# unrelated local HEAD.
deps_satisfied_at_commit() {
    local tip="$1" sha="$2"
    taskdag_consumer_prepare requirements-at-tip --tip "$tip" || return 2
    taskdag_requirements_status_json "task:${TASKDAG_RECON_CUR}@${sha}" | jq -e '.requirementsSatisfied == true' >/dev/null
}

taskdag_completion_allowed() { # <task-sha>, against prepared snapshot
    local status
    status=$(taskdag_task_status_json "task:${TASKDAG_RECON_CUR}@$1" --include-claimed) || return 2
    [ "$(jq -r '(.complete|not) and .requirementsSatisfied' <<<"$status")" = true ]
}

taskdag_task_is_complete_prepared() { # <task-sha>
    local status
    status=$(taskdag_task_status_json "task:${TASKDAG_RECON_CUR}@$1" --include-claimed) || return 2
    [ "$(jq -r .complete <<<"$status")" = true ]
}

taskdag_consumer_fenced_scheduling_push() { # <operation> <actor> <updates-json>
    local operation=$1 actor=$2 updates=$3 token timestamp
    [ "$TASKDAG_CONSUMER_MODE" = canonical ] || return 2
    token=$(taskdag_activation_snapshot_token) || return 3
    [ "$(jq -r .authorityTip <<<"$token")" = "$(jq -r .authorityTip <<<"$TASKDAG_CONSUMER_ACTIVATION")" ] || return 3
    updates=$(jq -cS 'sort_by(.ref)' <<<"$updates") || return 3
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    taskdag_activation_fenced_multi_push "$token" scheduling "$operation" "$actor" "$timestamp" "$updates"
}
