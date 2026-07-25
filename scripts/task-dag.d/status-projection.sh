# shellcheck shell=bash

if ! declare -F taskdag_task_completed_at_tip >/dev/null; then
    echo "Error: status-projection.sh requires facts.sh provider taskdag_task_completed_at_tip to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F taskdag_normalize_node >/dev/null; then
    echo "Error: status-projection.sh requires edges.sh provider taskdag_normalize_node to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F is_task_blocked >/dev/null || ! declare -F blocked_structural_ancestor >/dev/null; then
    echo "Error: status-projection.sh requires blocked-core.sh providers is_task_blocked and blocked_structural_ancestor to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F taskdag_node_complete >/dev/null || ! declare -F taskdag_recon_resolve_task_node >/dev/null; then
    echo "Error: status-projection.sh requires reconciliation-core.sh providers taskdag_node_complete and taskdag_recon_resolve_task_node to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F taskdag_consumer_require_prepared >/dev/null; then
    echo "Error: status-projection.sh requires semantic-consumer.sh provider taskdag_consumer_require_prepared to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
for prerequisite in get_dep_parents task_has_children is_human_comment_task; do
    if ! declare -F "$prerequisite" >/dev/null; then
        echo "Error: status-projection.sh requires entrypoint provider $prerequisite to be defined first" >&2
        return 2 2>/dev/null || exit 2
    fi
done
unset prerequisite

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
    local node=$1 issue=$2 normalized sha complete=false blocked=false claimed=false decomposed=false pickable=false req rc reasons='[]' locator active_sha
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
    if git show-ref --verify --quiet "refs/heads/tasks/root-active/$issue"; then
        locator=$(taskdag_root_locator "refs/heads/tasks/root-active/$issue") || return 2
        [ "$(jq -r .dialect <<<"$locator")" != epic-v1 ] \
            || taskdag_resolve_typed_root "$locator" "$sha" >/dev/null || return 2
        active_sha=$(git rev-parse "refs/heads/tasks/root-active/$issue") || return 2
        taskdag_validate_root_claim "$locator" "$sha" "$active_sha" || return 2
        claimed=true
    fi
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
