# shellcheck shell=bash
# Stable, default-deny authority for the sole materialisation issue actuator.

TASKDAG_MATERIALISE_PRODUCER_REF="refs/heads/tasks/v1/materialisation-producer"

_taskdag_materialise_runtime_commit() {
    git -C "$TASKDAG_SCRIPT_DIR/.." rev-parse HEAD 2>/dev/null
}

_taskdag_materialise_producer_validate_record() { # file
    local file=$1 expected
    jq -e '
      type=="object" and keys==["activationEpoch","activationRecordDigest","actor","appCreatorNodeId","authoritativeTimestamp","censusBlob","censusDigest","importBatchBlob","registrySnapshotId","repositories","runtimeCommit","schema","state"] and
      .schema==1 and .state=="enabled" and
      (.activationEpoch|type=="number" and floor==. and .>=1) and
      (.activationRecordDigest|test("^[0-9a-f]{64}$")) and (.censusDigest|test("^[0-9a-f]{64}$")) and
      (.censusBlob|test("^([0-9a-f]{40}|[0-9a-f]{64})$")) and (.importBatchBlob|test("^([0-9a-f]{40}|[0-9a-f]{64})$")) and
      (.runtimeCommit|test("^([0-9a-f]{40}|[0-9a-f]{64})$")) and
      (.registrySnapshotId|test("^sha256:[0-9a-f]{64}$")) and
      (.appCreatorNodeId|type=="string" and length>0 and length<=256) and
      (.repositories|type=="array" and length>0 and .==sort and length==(unique|length) and
        all(.[];type=="string" and .==ascii_downcase and test("^[a-z0-9_.-]+/[a-z0-9_.-]+$"))) and
      (.actor|type=="string" and length>0 and length<=256 and (test("[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]")|not)) and
      (.authoritativeTimestamp|type=="string" and length==20 and
        ((fromdateiso8601|todateiso8601)==.))
    ' "$file" >/dev/null 2>&1 || return 1
    expected=$(jq -cS . "$file") || return 1
    [ "$(cat "$file")" = "$expected" ]
}

_taskdag_materialise_producer_validate_tip() { # tip
    local tip=$1 tmp
    [ "$(git rev-list --parents -1 "$tip" 2>/dev/null | wc -w)" -eq 1 ] || return 1
    [ "$(git ls-tree -r --name-only "$tip" 2>/dev/null)" = producer-enable.json ] || return 1
    tmp=$(mktemp) || return 1
    git show "$tip:producer-enable.json" >"$tmp" 2>/dev/null \
      && _taskdag_materialise_producer_validate_record "$tmp"
    local rc=$?; rm -f "$tmp"; return "$rc"
}

_taskdag_materialise_producer_fetch() {
    local remote tip
    remote=$(git ls-remote --refs origin "$TASKDAG_MATERIALISE_PRODUCER_REF") || return 2
    tip=${remote%%[[:space:]]*}; [ "$remote" != "$tip" ] || return 3
    git fetch -q --no-tags origin "$TASKDAG_MATERIALISE_PRODUCER_REF:$TASKDAG_MATERIALISE_PRODUCER_REF" || return 2
    tip=$(git rev-parse "$TASKDAG_MATERIALISE_PRODUCER_REF") || return 3
    _taskdag_materialise_producer_validate_tip "$tip" || return 3
    printf '%s\n' "$tip"
}

taskdag_materialise_fetch_producer_if_required() { # materialisation-tip
    git grep -q '"providerReceipt":' "$1" -- 'slots/*/states/*.json' 2>/dev/null || return 0
    _taskdag_materialise_producer_fetch >/dev/null
}

# Success means this exact runtime is authorized against the still-active,
# immutable activation/census evidence. Any missing, stale, unreadable, or
# mismatched authority denies all issue effects.
taskdag_materialise_producer_check() {
    local supplied_token=${1:-} tip token activation_record record runtime materialisation_tip current_repo
    if [ -n "$supplied_token" ]; then token=$supplied_token
    else token=$(taskdag_activation_snapshot_token) || return 3
    fi
    activation_record=$(taskdag_activation_record_for_snapshot "$token") || return 3
    tip=$(_taskdag_materialise_producer_fetch) || return $?
    record=$(git show "$tip:producer-enable.json") || return 3
    runtime=$(_taskdag_materialise_runtime_commit) || return 3
    [ "$runtime" = "$(jq -r .runtimeCommit <<<"$record")" ] || return 3
    [ "$(jq -r .epoch <<<"$token")" = "$(jq -r .activationEpoch <<<"$record")" ] || return 3
    [ "$(jq -r .digest <<<"$token")" = "$(jq -r .activationRecordDigest <<<"$record")" ] || return 3
    [ "$(jq -r .registrySnapshot.id <<<"$activation_record")" = "$(jq -r .registrySnapshotId <<<"$record")" ] || return 3
    [ "$(jq -c '[.registrySnapshot.repositories[].repository]|sort' <<<"$activation_record")" = "$(jq -c .repositories <<<"$record")" ] || return 3
    materialisation_tip=$(git ls-remote --refs origin "$TASKDAG_MATERIALISATION_REF" | awk 'NF==2{print $1}') || return 2
    git fetch -q --no-tags origin "$TASKDAG_MATERIALISATION_REF" || return 2
    materialisation_tip=$(git rev-parse FETCH_HEAD) || return 3
    current_repo=$(printf '%s' "$(_xrepo_current_repo)" | tr '[:upper:]' '[:lower:]') || return 3
    [ -z "$(taskdag_materialisation_online_tree_violations "$materialisation_tip" "$(jq -r .authorityTip <<<"$token")" "$current_repo")" ] || return 3
    [ "$(git rev-parse "$materialisation_tip:censuses/$(jq -r .censusDigest <<<"$record").json" 2>/dev/null)" = "$(jq -r .censusBlob <<<"$record")" ] || return 3
    [ "$(git rev-parse "$materialisation_tip:import-batches/$(jq -r .censusDigest <<<"$record").json" 2>/dev/null)" = "$(jq -r .importBatchBlob <<<"$record")" ] || return 3
    git show "$materialisation_tip:censuses/$(jq -r .censusDigest <<<"$record").json" | jq -e --arg digest "$(jq -r .activationRecordDigest <<<"$record")" '.activationRecordDigest==$digest' >/dev/null 2>&1 || return 3
    printf '%s\n' "$record"
}

cmd_materialise_producer_enable() {
    case "${1:-}" in -h|--help) echo 'Usage: task-dag materialise-producer-enable --spec-file FILE'; return 0;; esac
    [ "$#" -eq 2 ] && [ "$1" = --spec-file ] || return 2
    local spec=$2 tmp token activation_record runtime materialisation_tip current_repo census census_blob import_blob record tree commit updates rc remote
    [ -f "$spec" ] && _taskdag_materialise_no_duplicate_keys "$spec" || return 2
    jq -e 'type=="object" and keys==["actor","appCreatorNodeId","authoritativeTimestamp","censusDigest","runtimeCommit"] and
      (.actor|type=="string" and length>0 and length<=256) and (.appCreatorNodeId|type=="string" and length>0 and length<=256) and (.censusDigest|test("^[0-9a-f]{64}$")) and
      (.runtimeCommit|test("^([0-9a-f]{40}|[0-9a-f]{64})$")) and
      (.authoritativeTimestamp|type=="string" and length==20 and ((fromdateiso8601|todateiso8601)==.))' "$spec" >/dev/null 2>&1 || return 2
    remote=$(git ls-remote --refs origin "$TASKDAG_MATERIALISE_PRODUCER_REF") || return 2
    token=$(taskdag_activation_snapshot_token) || return 3
    activation_record=$(taskdag_activation_record_for_snapshot "$token") || return 3
    runtime=$(_taskdag_materialise_runtime_commit) || return 3
    [ "$runtime" = "$(jq -r .runtimeCommit "$spec")" ] || return 3
    materialisation_tip=$(git ls-remote --refs origin "$TASKDAG_MATERIALISATION_REF" | awk 'NF==2{print $1}') || return 2
    [ -n "$materialisation_tip" ] || return 3
    git fetch -q --no-tags origin "$TASKDAG_MATERIALISATION_REF" || return 2
    materialisation_tip=$(git rev-parse FETCH_HEAD) || return 3
    current_repo=$(printf '%s' "$(_xrepo_current_repo)" | tr '[:upper:]' '[:lower:]') || return 3
    [ -z "$(taskdag_materialisation_online_tree_violations "$materialisation_tip" "$(jq -r .authorityTip <<<"$token")" "$current_repo")" ] || return 3
    census=$(jq -r .censusDigest "$spec")
    git show "$materialisation_tip:censuses/$census.json" | jq -e --arg digest "$(jq -r .digest <<<"$token")" '.activationRecordDigest==$digest' >/dev/null 2>&1 || return 3
    census_blob=$(git rev-parse "$materialisation_tip:censuses/$census.json") || return 3
    import_blob=$(git rev-parse "$materialisation_tip:import-batches/$census.json") || return 3
    record=$(jq -ncS --arg actor "$(jq -r .actor "$spec")" --arg appCreatorNodeId "$(jq -r .appCreatorNodeId "$spec")" --arg authoritativeTimestamp "$(jq -r .authoritativeTimestamp "$spec")" \
      --arg censusDigest "$census" --arg censusBlob "$census_blob" --arg importBatchBlob "$import_blob" --arg runtimeCommit "$runtime" \
      --arg activationRecordDigest "$(jq -r .digest <<<"$token")" --argjson activationEpoch "$(jq -r .epoch <<<"$token")" \
      --arg registrySnapshotId "$(jq -r .registrySnapshot.id <<<"$activation_record")" \
      --argjson repositories "$(jq -c '[.registrySnapshot.repositories[].repository]|sort' <<<"$activation_record")" \
      '{schema:1,state:"enabled",activationEpoch:$activationEpoch,activationRecordDigest:$activationRecordDigest,censusDigest:$censusDigest,censusBlob:$censusBlob,importBatchBlob:$importBatchBlob,registrySnapshotId:$registrySnapshotId,repositories:$repositories,runtimeCommit:$runtimeCommit,appCreatorNodeId:$appCreatorNodeId,actor:$actor,authoritativeTimestamp:$authoritativeTimestamp}') || return 2
    if [ -n "$remote" ]; then
        remote=${remote%%[[:space:]]*}
        git fetch -q --no-tags origin "$TASKDAG_MATERIALISE_PRODUCER_REF" || return 2
        _taskdag_materialise_producer_validate_tip "$remote" || return 3
        [ "$(git show "$remote:producer-enable.json")" = "$record" ] || return 3
        taskdag_materialise_producer_check >/dev/null
        return $?
    fi
    tmp=$(mktemp -d) || return 2
    printf '%s\n' "$record" >"$tmp/record"
    _taskdag_materialise_producer_validate_record "$tmp/record" || { rm -rf "$tmp"; return 3; }
    tree=$(printf '100644 blob %s\tproducer-enable.json\n' "$(git hash-object -w "$tmp/record")" | git mktree) || { rm -rf "$tmp"; return 2; }
    commit=$(printf 'Enable materialisation producer\n' | git commit-tree "$tree") || { rm -rf "$tmp"; return 2; }
    _taskdag_materialise_producer_validate_tip "$commit" || { rm -rf "$tmp"; return 3; }
    updates=$(jq -ncS --arg ref "$TASKDAG_MATERIALISE_PRODUCER_REF" --arg new "$commit" '[{ref:$ref,old:"",new:$new}]') || { rm -rf "$tmp"; return 2; }
    taskdag_activation_fenced_multi_push "$token" materialisation producer-enable "$(jq -r .actor "$spec")" "$(jq -r .authoritativeTimestamp "$spec")" "$updates"; rc=$?
    rm -rf "$tmp"
    remote=$(taskdag_materialise_producer_check) || return 3
    [ "$remote" = "$record" ]
}
