# shellcheck shell=bash

if ! declare -F taskdag_activation_validate_history >/dev/null \
    || ! declare -F _taskdag_activation_fetch_authority >/dev/null \
    || ! declare -F _taskdag_activation_authority_token >/dev/null \
    || ! declare -F _taskdag_activation_runtime_commit >/dev/null; then
    echo "Error: semantic-consumer.sh requires activation.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F taskdag_cas_sleep >/dev/null; then
    echo "Error: semantic-consumer.sh requires cas-retry.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F taskdag_capture_child_map_refs >/dev/null \
    || ! declare -F taskdag_reset_child_map >/dev/null; then
    echo "Error: semantic-consumer.sh requires child-map.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F taskdag_recon_prepare >/dev/null; then
    echo "Error: semantic-consumer.sh requires reconciliation-core.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F taskdag_sha256_hex >/dev/null; then
    echo "Error: semantic-consumer.sh requires edges.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi

# Canonical semantic snapshot preparation shared by every read and production
# consumer. This module owns TASKDAG_CONSUMER_* state and performs no writes.

# One attested semantic snapshot per live consumer operation. Pre-activation
# readers retain the parent-encoded bridge; once any activation exists they
# use graph semantics forever (including disabled rollback epochs).
TASKDAG_CONSUMER_READY=false
TASKDAG_CONSUMER_MODE=""
TASKDAG_CONSUMER_ID=""
TASKDAG_CONSUMER_TIP=""
TASKDAG_CONSUMER_ACTIVATION='null'
TASKDAG_CONSUMER_GRAPH_TIP=""
TASKDAG_CONSUMER_MASTER_TIP=""
TASKDAG_CONSUMER_PREPARE_RESULT='{"schema":1,"status":"error","reason":null,"attempts":0,"before":{"activation":null},"local":{"activation":null,"graph":null,"master":null,"taskRefsDigest":null},"observed":{"activation":null,"graph":null,"master":null,"taskRefsDigest":null}}'

_taskdag_consumer_local_activation_authority() {
    local observed=""
    observed=$(git rev-parse --verify -q 'refs/task-dag/activation-observed^{commit}' 2>/dev/null || true)
    [ -n "$observed" ] || observed=$(git rev-parse --verify -q "${TASKDAG_ACTIVATION_REF}^{commit}" 2>/dev/null || true)
    if [ -z "$observed" ]; then
        echo "Error: offline activation absence is unproven; prepare online before using semantic consumers" >&2
        return 2
    fi
    printf '%s\n' "$observed"
}

_taskdag_consumer_activation_token_at() {
    local tip=$1 info active authority path digest record
    info=$(taskdag_activation_validate_history "$tip") || return 2
    IFS=$'\t' read -r active authority path digest <<<"$info"
    record=$(git show "$active:$path") || return 2
    jq -ncS --argjson record "$record" --arg activationCommit "$active" --arg authorityTip "$authority" --arg digest "$digest" \
      '{activationCommit:$activationCommit,authorityTip:$authorityTip,digest:$digest,record:$record}'
}

_taskdag_consumer_remote_advertisement() {
    git ls-remote --refs origin refs/heads/master "$TASKDAG_ACTIVATION_REF" "$TASKDAG_GRAPH_REF" \
      'refs/heads/tasks/frontier/*' 'refs/heads/tasks/active/*' 'refs/heads/tasks/blocked/*' \
      'refs/heads/tasks/blocked-meta/*' 'refs/heads/tasks/root-active/*' 'refs/heads/tasks/pending/*' \
      'refs/heads/gh/issues/*'
}

_taskdag_consumer_advertised_oid() { awk -v r="$2" '$2==r {print $1}' <<<"$1"; }

_taskdag_consumer_local_task_refs() {
    [ "$TASKDAG_CHILD_MAP_READY" = true ] || return 2
    printf '%s\n' "$TASKDAG_CHILD_MAP_REFS"
}

_taskdag_consumer_advertised_task_refs() {
    awk '$2 ~ /^refs\/heads\/(tasks\/(frontier|active|blocked|blocked-meta|root-active|pending)\/|gh\/issues\/)/ {print $1" "$2}' <<<"$1" \
      | LC_ALL=C sort
}

_taskdag_consumer_refs_digest() { printf '%s' "$1" | taskdag_sha256_hex; }

_taskdag_consumer_retry_budget() {
    local raw=$1 normalized
    [[ "$raw" =~ ^[0-9]+$ ]] || return 1
    normalized=$(sed 's/^0*//' <<<"$raw")
    [ -n "$normalized" ] || normalized=0
    # A larger retry budget is operationally nonsensical (the canonical
    # quadratic backoff would already take many minutes) and risks shell
    # integer overflow. Keep the accepted decimal range explicit and small.
    [ "${#normalized}" -lt 3 ] || { [ "${#normalized}" -eq 3 ] && [ "$normalized" -le 100 ]; } || return 1
    printf '%s\n' "$normalized"
}

_taskdag_consumer_result() { # status reason attempts before local-activation local-graph local-master local-refs observed-activation observed-graph observed-master observed-refs
    local status=$1 reason=$2 attempts=$3 before=$4 local_activation=$5 local_graph=$6 local_master=$7 local_refs=$8
    local observed_activation=$9 observed_graph=${10} observed_master=${11} observed_refs=${12}
    jq -ncS --arg status "$status" --arg reason "$reason" --argjson attempts "$attempts" \
      --arg before "$before" --arg localActivation "$local_activation" --arg localGraph "$local_graph" \
      --arg localMaster "$local_master" --arg localRefs "$local_refs" --arg observedActivation "$observed_activation" \
      --arg observedGraph "$observed_graph" --arg observedMaster "$observed_master" --arg observedRefs "$observed_refs" '
      def value_or_null: if length == 0 then null else . end;
      {schema:1,status:$status,reason:($reason|value_or_null),attempts:$attempts,
       before:{activation:($before|value_or_null)},
       local:{activation:($localActivation|value_or_null),graph:($localGraph|value_or_null),master:($localMaster|value_or_null),taskRefsDigest:($localRefs|value_or_null)},
       observed:{activation:($observedActivation|value_or_null),graph:($observedGraph|value_or_null),master:($observedMaster|value_or_null),taskRefsDigest:($observedRefs|value_or_null)}}'
}

_taskdag_consumer_mismatch_reason() { # before local-activation observed-activation local-graph observed-graph local-master observed-master local-refs observed-refs requested-tip
    [ "$1" = "$2" ] || { printf 'activation-token\n'; return; }
    [ "$1" = "$3" ] || { printf 'activation-authority\n'; return; }
    [ "$4" = "$5" ] || { printf 'graph-tip\n'; return; }
    [ "$6" = "$7" ] || { printf 'master-tip\n'; return; }
    [ "$8" = "$9" ] || { printf 'task-refs\n'; return; }
    printf '\n'
}

_taskdag_consumer_prepare() { # <consumer-id> [--tip TIP] [--no-fetch] [--expected-activation-authority OID]
    local consumer=${1:-} requested_tip="" nofetch=false before after token runtime attempt arg advertisement graph_tip master_tip
    local expected_activation_authority=""
    local candidate_mode local_activation local_graph local_master local_task_refs local_task_refs_digest
    local observed_task_refs observed_task_refs_digest reason max_attempts retry_budget
    local prior_ready=${TASKDAG_CONSUMER_READY:-false} prior_mode=${TASKDAG_CONSUMER_MODE:-}
    [ -n "$consumer" ] || return 2
    shift
    while [ "$#" -gt 0 ]; do
        arg=$1; shift
        case "$arg" in
            --tip) requested_tip=${1:-}; [ -n "$requested_tip" ] || return 2; shift ;;
            --tip=*) requested_tip=${arg#*=} ;;
            --no-fetch) nofetch=true ;;
            --expected-activation-authority)
                expected_activation_authority=${1:-}; [ -n "$expected_activation_authority" ] || return 2; shift ;;
            --expected-activation-authority=*) expected_activation_authority=${arg#*=} ;;
            *) return 2 ;;
        esac
    done
    if [ -n "$expected_activation_authority" ] && ! [[ "$expected_activation_authority" =~ ^[0-9a-f]{40}$ ]]; then
        echo "Error: --expected-activation-authority requires a full 40-hex commit OID" >&2
        return 2
    fi
    TASKDAG_CONSUMER_READY=false
    TASKDAG_CONSUMER_MODE=""
    TASKDAG_CONSUMER_ID=""
    TASKDAG_CONSUMER_TIP=""
    TASKDAG_CONSUMER_ACTIVATION='null'
    TASKDAG_CONSUMER_GRAPH_TIP=""
    TASKDAG_CONSUMER_MASTER_TIP=""
    TASKDAG_RECON_READY=false
    TASKDAG_CONSUMER_PREPARE_RESULT=$(_taskdag_consumer_result error "" 0 "" "" "" "" "" "" "" "" "") || return 2
    retry_budget=$(_taskdag_consumer_retry_budget "$TASKDAG_CAS_MAX_ATTEMPTS") \
      || { echo "Error: TASKDAG_CAS_MAX_ATTEMPTS must be a decimal integer from 0 through 100" >&2; return 2; }
    declare -F taskdag_cas_sleep >/dev/null \
      || { echo "Error: canonical taskdag_cas_sleep backoff helper is unavailable" >&2; return 2; }
    max_attempts=$(( retry_budget + 1 ))
    for (( attempt=1; attempt<=max_attempts; attempt++ )); do
        TASKDAG_CONSUMER_PREPARE_RESULT=$(_taskdag_consumer_result error "" "$attempt" "" "" "" "" "" "" "" "" "") || return 2
        candidate_mode=""
        if [ "$nofetch" = true ] && [ "$prior_ready" = true ] && [ "$prior_mode" = legacy ] \
          && ! git show-ref --verify --quiet refs/task-dag/activation-observed \
          && ! git show-ref --verify --quiet "$TASKDAG_ACTIVATION_REF"; then
            # A nested offline helper may reuse the enclosing operation's
            # freshly observed pre-activation absence. This is process-local
            # evidence only; a standalone offline command still fails closed.
            before=""
        elif [ "$nofetch" = true ]; then before=$(_taskdag_consumer_local_activation_authority) || return 2
        else before=$(_taskdag_activation_fetch_authority) || return 2
        fi
        if [ -n "$expected_activation_authority" ] && [ "$before" != "$expected_activation_authority" ]; then
            TASKDAG_CONSUMER_PREPARE_RESULT=$(_taskdag_consumer_result exhausted "activation-authority" "$attempt" "$before" "" "" "" "" "$before" "" "" "") || return 2
            echo "Error: activation authority differs from the caller's prepared snapshot; refusing to retry against newer authority" >&2
            return 2
        fi
        token=null
        if [ -n "$before" ]; then
            if [ "$nofetch" = true ]; then token=$(_taskdag_consumer_activation_token_at "$before") || return 2
            else token=$(_taskdag_activation_authority_token) || return 2
            fi
            runtime=$(_taskdag_activation_runtime_commit) || return 2
            git -C "$TASKDAG_SCRIPT_DIR/.." merge-base --is-ancestor \
                "$(jq -r .record.minimumCompatibleTaskDagCommit <<<"$token")" "$runtime" || return 2
            candidate_mode=canonical
        else
            # Cutover is permanent for a checkout once it has observed any
            # valid authority.  A deleted/hidden remote ref after that point
            # is rollback damage or an indeterminate advertisement, never
            # evidence that legacy semantics are safe again.
            if git show-ref --verify --quiet refs/task-dag/activation-observed; then
                echo "Error: semantic activation disappeared after canonical cutover; refusing legacy fallback" >&2
                return 2
            fi
            candidate_mode=legacy
        fi
        local_activation=$(jq -r '.authorityTip // empty' <<<"$token") || return 2
        if [ "$local_activation" != "$before" ]; then
            reason=activation-token
            after=""; graph_tip=""; master_tip=""; local_graph=""; local_master=""
            local_task_refs_digest=""; observed_task_refs_digest=""
        else
        if [ -n "$requested_tip" ]; then
            if [ "$nofetch" = true ]; then taskdag_recon_prepare --no-fetch --tip "$requested_tip" || return 2
            else taskdag_recon_prepare --tip "$requested_tip" || return 2
            fi
        else
            if [ "$nofetch" = true ]; then taskdag_recon_prepare --no-fetch || return 2
            else taskdag_recon_prepare || return 2
            fi
        fi
        # The prepared reconciliation cache is only a candidate until the
        # final advertisement attests every captured dimension. Clear it
        # before any subsequent capture or digest operation can fail.
        TASKDAG_RECON_READY=false
        local_graph=$(git rev-parse --verify -q "${TASKDAG_GRAPH_REF}^{commit}" 2>/dev/null || true)
        # Facts may be explicitly pinned to another commit, but containment
        # always derives from the captured origin/master generation. Attest
        # that map root independently and unconditionally.
        local_master=$TASKDAG_CHILD_MAP_MASTER
        local_task_refs=$(_taskdag_consumer_local_task_refs) || return 2
        local_task_refs_digest=$(_taskdag_consumer_refs_digest "$local_task_refs") || return 2
        if declare -F taskdag_consumer_test_after_prepare_hook >/dev/null; then
            taskdag_consumer_test_after_prepare_hook "$attempt" || return $?
        fi
        if [ "$nofetch" = true ]; then
            if [ -z "$before" ]; then after=""
            else after=$(_taskdag_consumer_local_activation_authority) || return 2
            fi
            graph_tip=$(git rev-parse --verify -q "${TASKDAG_GRAPH_REF}^{commit}" 2>/dev/null || true)
            master_tip=$(git rev-parse --verify -q "${TASKDAG_CHILD_MAP_SOURCE}^{commit}") || return 2
            observed_task_refs=$(taskdag_capture_child_map_refs) || return 2
        else
            advertisement=$(_taskdag_consumer_remote_advertisement) || return 2
            after=$(_taskdag_consumer_advertised_oid "$advertisement" "$TASKDAG_ACTIVATION_REF")
            graph_tip=$(_taskdag_consumer_advertised_oid "$advertisement" "$TASKDAG_GRAPH_REF")
            master_tip=$(_taskdag_consumer_advertised_oid "$advertisement" refs/heads/master)
            observed_task_refs=$(_taskdag_consumer_advertised_task_refs "$advertisement") || return 2
        fi
        observed_task_refs_digest=$(_taskdag_consumer_refs_digest "$observed_task_refs") || return 2
        reason=$(_taskdag_consumer_mismatch_reason "$before" "$local_activation" "$after" \
          "$local_graph" "$graph_tip" "$local_master" "$master_tip" \
          "$local_task_refs_digest" "$observed_task_refs_digest" "$requested_tip") || return 2
        fi
        if [ -n "$reason" ]; then
            TASKDAG_RECON_READY=false
            if [ -n "$expected_activation_authority" ]; then
                TASKDAG_CONSUMER_PREPARE_RESULT=$(_taskdag_consumer_result exhausted "$reason" "$attempt" "$before" "$local_activation" \
                  "$local_graph" "$local_master" "$local_task_refs_digest" "$after" "$graph_tip" "$master_tip" "$observed_task_refs_digest") || return 2
                echo "Error: prepared semantic snapshot changed while using fixed activation authority; refusing retry" >&2
                return 2
            fi
            if [ "$attempt" -ge "$max_attempts" ]; then
                TASKDAG_CONSUMER_PREPARE_RESULT=$(_taskdag_consumer_result exhausted "$reason" "$attempt" "$before" "$local_activation" \
                  "$local_graph" "$local_master" "$local_task_refs_digest" "$after" "$graph_tip" "$master_tip" "$observed_task_refs_digest") || return 2
                echo "Error: semantic consumer snapshot did not stabilize after $attempt attempts" >&2
                printf '%s\n' "$TASKDAG_CONSUMER_PREPARE_RESULT" >&2
                echo "Rerun the same task-dag command; it will re-read and re-attest current state. Do not edit task refs manually. Preparation made no remote semantic mutation." >&2
                return 2
            fi
            TASKDAG_CONSUMER_PREPARE_RESULT=$(_taskdag_consumer_result retrying "$reason" "$attempt" "$before" "$local_activation" \
              "$local_graph" "$local_master" "$local_task_refs_digest" "$after" "$graph_tip" "$master_tip" "$observed_task_refs_digest") || return 2
            local sleep_rc=0
            taskdag_cas_sleep "$attempt" || sleep_rc=$?
            if [ "$sleep_rc" -ne 0 ]; then
                TASKDAG_CONSUMER_PREPARE_RESULT=$(_taskdag_consumer_result error "" "$attempt" "$before" "$local_activation" \
                  "$local_graph" "$local_master" "$local_task_refs_digest" "$after" "$graph_tip" "$master_tip" "$observed_task_refs_digest") || return 2
                return "$sleep_rc"
            fi
            continue
        fi
        if [ -n "$requested_tip" ]; then
            requested_tip=$(git rev-parse --verify -q "${requested_tip}^{commit}") || return 2
            [ "$TASKDAG_FACTS_TIP_OID" = "$requested_tip" ] || return 2
        fi
        TASKDAG_CONSUMER_MODE=$candidate_mode
        TASKDAG_CONSUMER_ID=$consumer
        TASKDAG_CONSUMER_TIP=$TASKDAG_FACTS_TIP_OID
        TASKDAG_CONSUMER_ACTIVATION=$token
        TASKDAG_CONSUMER_GRAPH_TIP=$graph_tip
        TASKDAG_CONSUMER_MASTER_TIP=$master_tip
        TASKDAG_CONSUMER_PREPARE_RESULT=$(_taskdag_consumer_result ready "" "$attempt" "$before" "$local_activation" \
          "$local_graph" "$local_master" "$local_task_refs_digest" "$after" "$graph_tip" "$master_tip" "$observed_task_refs_digest") || return 2
        TASKDAG_RECON_READY=true
        TASKDAG_CONSUMER_READY=true
        return 0
    done
    echo "Error: semantic consumer preparation ended without a ready or exhausted result" >&2
    return 2
}

# A failed or exhausted preparation must not leave its child snapshot usable
# by a caller that accidentally ignores the return status.
taskdag_consumer_prepare() {
    local rc=0
    _taskdag_consumer_prepare "$@" || rc=$?
    if [ "$rc" -ne 0 ]; then
        taskdag_reset_child_map
    fi
    return "$rc"
}

taskdag_consumer_require_prepared() {
    [ "$TASKDAG_CONSUMER_READY" = true ] || {
        echo "Error: semantic consumer used without an attested snapshot" >&2
        return 2
    }
}

# Canonical convergence is the sole activation-authorized successor to the
# drained legacy projection writer.  Absence of activation retains the exact
# static-policy response (75); once authority exists, every invalid, disabled,
# incompatible, or unstable authority fails closed and can never fall back.
taskdag_canonical_convergence_require_prepared() {
    local floor state prerequisite=73bfe103b6f5e1bddc318e5592085619c7f0f2f4
    taskdag_consumer_require_prepared || return 2
    [ "$TASKDAG_CONSUMER_MODE" = canonical ] || return 2
    state=$(jq -er '.record.state' <<<"$TASKDAG_CONSUMER_ACTIVATION") || return 2
    [ "$state" = enabled ] || {
        echo "Error: canonical convergence requires enabled semantic activation" >&2
        return 2
    }
    floor=$(jq -er '.record.minimumCompatibleTaskDagCommit' <<<"$TASKDAG_CONSUMER_ACTIVATION") || return 2
    git -C "$TASKDAG_SCRIPT_DIR/.." cat-file -e "$prerequisite^{commit}" 2>/dev/null || return 2
    git -C "$TASKDAG_SCRIPT_DIR/.." merge-base --is-ancestor "$prerequisite" "$floor" || {
        echo "Error: canonical convergence activation predates its required task-dag floor" >&2
        return 2
    }
}

taskdag_canonical_convergence_guard() {
    local nofetch=false
    case "${1:-}" in
        '') ;;
        --no-fetch) nofetch=true ;;
        *) return 2 ;;
    esac
    if [ "$nofetch" = true ]; then
        taskdag_consumer_prepare canonical-convergence --no-fetch || return $?
    else
        taskdag_consumer_prepare canonical-convergence || return $?
    fi
    if [ "$TASKDAG_CONSUMER_MODE" = legacy ]; then
        taskdag_migration_guard projection
        return $?
    fi
    taskdag_canonical_convergence_require_prepared
}
