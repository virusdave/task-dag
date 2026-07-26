# shellcheck shell=bash
# Provider-free, level-triggered composition.  Serialization remains owned by
# epic-create, breakdown, and dep-add.

taskdag_epic_compose_help() {
    cat <<'EOF'
Usage: task-dag epic-compose --json --source-checkout ABSOLUTE_PATH
       --target-checkout ABSOLUTE_PATH --spec-file PATH

The strict schema-1 object has exactly: epicCreate, breakdown, sourceClaim,
sourceOps and schema. sourceClaim has activeRefSuffix, taskSha and claimOid.
The ambient TASK_DAG_CLAIMER, TASK_DAG_CLAIMER_HOST and TASK_DAG_CLAIMER_PID
must identify that live source claim. sourceOps are dep-add objects; $targetRoot
in either endpoint denotes task:<target repository>@<root commit>.
EOF
}

_taskdag_compose_cli() { printf '%s/task-dag' "$TASKDAG_SCRIPT_DIR"; }

_taskdag_compose_fail() { echo "epic-compose: $*" >&2; return "${2:-3}"; }

_taskdag_compose_github_slug() { # effective-url
    local url=$1 slug
    case "$url" in
      https://github.com/*) slug=${url#https://github.com/} ;;
      ssh://git@github.com/*) slug=${url#ssh://git@github.com/} ;;
      git@github.com:*) slug=${url#git@github.com:} ;;
      *) return 1 ;;
    esac
    slug=${slug%.git}; taskdag_norm_owner_repo "$slug"
}

_taskdag_compose_origin_url() { # checkout expected-slug
    local checkout=$1 expected=$2 fetch push fetch_slug push_slug
    # An explicit pushurl or pushInsteadOf makes the apparently effective URL
    # dependent on extra config.  Refuse rather than attempting to emulate
    # Git's precedence rules in a security-sensitive checkout binding.
    ! git -C "$checkout" config --get-all remote.origin.pushurl >/dev/null 2>&1 || return 1
    ! git -C "$checkout" config --get-regexp '^url\..*\.pushInsteadOf$' >/dev/null 2>&1 || return 1
    mapfile -t fetch < <(git -C "$checkout" remote get-url --all origin) || return 1
    mapfile -t push < <(git -C "$checkout" remote get-url --push --all origin) || return 1
    [ "${#fetch[@]}" -eq 1 ] && [ "${#push[@]}" -eq 1 ] || return 1
    fetch_slug=$(_taskdag_compose_github_slug "${fetch[0]}") || return 1
    push_slug=$(_taskdag_compose_github_slug "${push[0]}") || return 1
    [ "$fetch_slug" = "$expected" ] && [ "$push_slug" = "$expected" ] || return 1
    printf '%s\n' "${fetch[0]}"
}

_taskdag_compose_checkout_snapshot() { # checkout expected-slug expected-id
    local checkout=$1 expected=$2 expected_id=$3 current url master authority token record source_tip tmpbase master_ref authority_ref
    taskdag_full_history_checkout "$checkout" || return 1
    current=$(git -C "$checkout" config --get taskdag.current-repo 2>/dev/null) || return 1
    current=$(taskdag_norm_owner_repo "$current") || return 1
    [ "$current" = "$expected" ] || return 1
    url=$(_taskdag_compose_origin_url "$checkout" "$expected") || return 1
    tmpbase="refs/task-dag-tmp/compose-snapshot/$$-$RANDOM"
    master_ref="$tmpbase/master"; authority_ref="$tmpbase/activation"
    git -C "$checkout" fetch -q --no-tags --no-write-fetch-head origin \
      "+refs/heads/master:$master_ref" "+$TASKDAG_ACTIVATION_REF:$authority_ref" || return 1
    master=$(git -C "$checkout" rev-parse --verify "$master_ref^{commit}") || return 1
    authority=$(git -C "$checkout" rev-parse --verify "$authority_ref^{commit}") || return 1
    git -C "$checkout" update-ref -d "$master_ref" || return 1
    git -C "$checkout" update-ref -d "$authority_ref" || return 1
    [ "$(git -C "$checkout" rev-parse HEAD)" = "$master" ] || return 1
    token=$(cd "$checkout" && _taskdag_activation_snapshot_token_for_tip "$authority") || return 1
    record=$(cd "$checkout" && taskdag_activation_record_for_snapshot "$token") || return 1
    jq -e --arg repo "$expected" --arg id "$expected_id" 'any(.registrySnapshot.repositories[];.repository==$repo and .repositoryId==$id)' <<<"$record" >/dev/null || return 1
    source_tip=$(jq -er --arg repo "$expected" --arg id "$expected_id" '.sourceTips[]|select(.repository==$repo and .repositoryId==$id)|.commit' <<<"$record") || return 1
    git -C "$checkout" cat-file -e "$source_tip^{commit}" 2>/dev/null || git -C "$checkout" fetch -q --no-tags origin "$source_tip" || return 1
    git -C "$checkout" merge-base --is-ancestor "$source_tip" "$master" || return 1
    jq -ncS --arg url "$url" --argjson token "$token" --argjson record "$record" '{record:$record,token:$token,url:$url}'
}

_taskdag_compose_json_args() {
    local object=$1 key value
    while IFS= read -r -d '' key && IFS= read -r -d '' value; do
        case "$key" in repositoryId) key=repository-id;; originRepository) key=origin-repository;; originRepositoryId) key=origin-repository-id;; operationId) key=operation-id;; claimNote) key=claim-note;; esac
        printf '%s\0%s\0' "--$key" "$value"
    done < <(jq -j 'to_entries[] | .key,"\u0000",(.value|tostring),"\u0000"' <<<"$object")
}

_taskdag_compose_description() { # checkout commit
    git -C "$1" show -s --format=%B "$2" | awk '
      NR==1 {next} NR==2 && $0=="" {next}
      !body && /^(Issue|Author|URL|Status|Type|Epic-ID|Epic-Root-Descriptor): / {next}
      !body && $0=="" {body=1; next}
      {body=1; print}'
}

_taskdag_compose_validate_source_claim() { # checkout claim-json
    local checkout=$1 claim=$2 suffix task oid advertised claimer host pid rc ref
    suffix=$(jq -r .activeRefSuffix <<<"$claim"); task=$(jq -r .taskSha <<<"$claim"); oid=$(jq -r .claimOid <<<"$claim")
    claimer=${TASK_DAG_CLAIMER:-${USER:-unknown}}; host=${TASK_DAG_CLAIMER_HOST:-$(hostname -s 2>/dev/null || echo unknown)}; pid=${TASK_DAG_CLAIMER_PID:-$PPID}
    # Ref suffixes are a durable prefix of the full object name.  Never bind
    # their validity to this checkout's mutable core.abbrev setting.
    [ "${task:0:${#suffix}}" = "$suffix" ] || return 1
    [ "$TASKDAG_CONSUMER_READY" = true ] || return 1
    ref="refs/heads/tasks/active/$suffix"
    advertised=$(awk -v r="$ref" '$2==r{print $1}' <<<"$TASKDAG_CHILD_MAP_REFS")
    [ "$advertised" = "$oid" ] && [ "$(awk -v r="$ref" '$2==r{n++} END{print n+0}' <<<"$TASKDAG_CHILD_MAP_REFS")" -eq 1 ] || return 1
    git -C "$checkout" cat-file -e "$oid^{commit}" && git -C "$checkout" cat-file -e "$task^{commit}" || return 1
    (cd "$checkout" && taskdag_validate_source_claim "$oid" "$task" "$claimer" "$host" "$pid") || return 1
    (cd "$checkout" && claim_is_dead "$oid"); rc=$?
    [ "$rc" -eq 1 ]
}

cmd_epic_compose() {
    case "${1:-}" in -h|--help) taskdag_epic_compose_help; return 0;; esac
    local json=false source='' target='' file='' k v
    while [ "$#" -gt 0 ]; do case "$1" in
        --json) json=true; shift;;
        --source-checkout|--target-checkout|--spec-file) [ "$#" -ge 2 ] || return 2; k=${1#--}; v=$2; shift 2; case "$k" in source-checkout) source=$v;; target-checkout) target=$v;; spec-file) file=$v;; esac;;
        *) _taskdag_compose_fail "unknown argument: $1" 2; return 2;; esac; done
    $json && [[ "$source" = /* ]] && [[ "$target" = /* ]] && [ -f "$file" ] && [ ! -L "$file" ] \
      && [ "$(stat -c %F -- "$file" 2>/dev/null)" = "regular file" ] || { _taskdag_compose_fail "--json, two absolute checkouts and a regular, non-symlink --spec-file are required" 2; return 2; }
    local snapshot spec create breakdown claim ops source_repo source_id target_repo target_id ss ts td out root broken tmp rc n i op from to relation mode repo_id witness reason authority epic locator existing active
    snapshot=$(mktemp) || return 2
    # RETURN traps fire when any nested helper returns.  Use the CLI process
    # boundary so the immutable snapshot survives the complete composition.
    trap "rm -f '$snapshot'" EXIT
    # Copy exactly once.  Every subsequent parse and validation is against the
    # immutable private snapshot, never the caller-controlled pathname.
    cat -- "$file" >"$snapshot" || return 2
    taskdag_json_file_is_single_strict "$snapshot" && _taskdag_materialise_no_duplicate_keys "$snapshot" || { _taskdag_compose_fail "spec is not one strict JSON value" 2; return 2; }
    jq -e 'type=="object" and keys==["breakdown","epicCreate","schema","sourceClaim","sourceOps"] and .schema==1 and
      (.epicCreate|type)=="object" and (.epicCreate|keys)==["author","claimNote","description","operationId","originRepository","originRepositoryId","parent","provider","repository","repositoryId","timestamp","title"] and
      all(.epicCreate[]; type=="string") and
      (.breakdown|type)=="array" and length>0 and all(.breakdown[]; type=="object" and
        (keys|all(.[]; . as $k | ["claim","dependencies","description","status","title","type"]|index($k))) and
        (.title|type=="string" and length>0 and (test("[\\r\\n]")|not)) and
        ((.description//"")|type=="string") and ((.dependencies//[])|type=="array" and all(.[];type=="string" and length>0)) and
        ((.claim//false)|type=="boolean") and ((.status//"pending")=="pending") and ((.type//"leaf")|IN("epic","task","leaf"))) and
      (.sourceOps|type)=="array" and
      (.sourceClaim|type)=="object" and (.sourceClaim|keys)==["activeRefSuffix","claimOid","taskSha"] and
      (.sourceClaim.activeRefSuffix|test("^[0-9a-f]{4,64}$")) and (.sourceClaim.claimOid|test("^([0-9a-f]{40}|[0-9a-f]{64})$")) and (.sourceClaim.taskSha|test("^([0-9a-f]{40}|[0-9a-f]{64})$")) and
      all(.sourceOps[];type=="object" and keys==["from","mode","reason","relation","repoId","to","witness"] and
        (.from|type)=="string" and (.to|type)=="string" and (.relation=="requires" or .relation=="satisfies") and
        (.mode|type=="string") and (.reason|type=="string" and (test("[[:cntrl:]]")|not)) and
        (.witness|type=="string" and length>0 and (test("[[:cntrl:]]")|not)) and
        (.repoId|type=="number" and . > 0 and . == floor))' "$snapshot" >/dev/null || { _taskdag_compose_fail "invalid spec" 2; return 2; }
    # This is the canonical mutation-free planner boundary.  It deliberately
    # runs before checkout discovery or epic-create, and rejects every shape
    # that breakdown/dep-add would only discover after the root was minted.
    jq -e '
      . as $root | all(..|strings; (test("[[:cntrl:]]")|not)) and
      all(.breakdown[];
        (.claim//false)==false and
        (((.description//"")|test("(?m)^(Task|Issue|Author|URL|Status|Type|Materialisation-Operation-Id|Epic-ID|Epic-Root-Format|Epic-Root-Descriptor|Epic-Origin-Kind|Epic-Origin-Provider|Epic-Origin-Repository-ID|Epic-Origin-Operation-ID|Epic-Origin-Issue-ID|Projection-Provider|Projection-Repository|Projection-Repository-ID|Projection-Issue-ID|Projection-Issue-Number|Projection-URL|Root-Ref|Claim-Kind|Claim-ID|Task-Commit|Claimer|Claimer-Host|Claimer-PID|Claimed-At|TTL-Hours|Note):")|not))) and
      ([.breakdown[].title]|length==(unique|length)) and
      all(range(0;($root.breakdown|length)); . as $i |
        all(($root.breakdown[$i].dependencies//[])[]; . as $d |
          if ($d|test("^@[0-9]+$")) then (($d[1:]|tonumber)>=1 and ($d[1:]|tonumber)<=$i)
          elif ([$root.breakdown[0:$i][].title]|index($d))!=null then true
          else ($d|test("^([0-9a-f]{40}|[0-9a-f]{64})$")) end)) and
      all($root.sourceOps[];
        (.to=="$targetRoot") and (.from!="$targetRoot") and
        ((.relation=="requires" and .mode=="all") or (.relation=="satisfies" and .mode=="any")) and
        (.from|test("^task:[a-z0-9_.-]+/[a-z0-9_.-]+@([0-9a-f]{40}|[0-9a-f]{64})$")))' \
      "$snapshot" >/dev/null || { _taskdag_compose_fail "spec failed canonical dry-run planning" 2; return 2; }
    spec=$(jq -cS . "$snapshot"); create=$(jq -cS .epicCreate <<<"$spec"); breakdown=$(jq -cS .breakdown <<<"$spec"); claim=$(jq -cS .sourceClaim <<<"$spec"); ops=$(jq -cS .sourceOps <<<"$spec")
    # Resolve the hard production gate before even fetching a checkout
    # snapshot.  With the all-f sentinel this invocation is effect-free.
    git -C "$TASKDAG_SCRIPT_DIR/.." cat-file -e "$TASKDAG_EPIC_COMPOSE_CUTOVER^{commit}" 2>/dev/null \
      || { _taskdag_compose_fail "compose cutover is not active"; return 3; }
    source_repo=$(taskdag_norm_owner_repo "$(jq -er .originRepository <<<"$create")") || return 2; source_id=$(jq -er .originRepositoryId <<<"$create") || return 2
    target_repo=$(taskdag_norm_owner_repo "$(jq -er .repository <<<"$create")") || return 2; target_id=$(jq -er .repositoryId <<<"$create") || return 2
    ss=$(_taskdag_compose_checkout_snapshot "$source" "$source_repo" "$source_id") || { _taskdag_compose_fail "source checkout binding failed"; return 3; }
    ts=$(_taskdag_compose_checkout_snapshot "$target" "$target_repo" "$target_id") || { _taskdag_compose_fail "target checkout binding failed"; return 3; }
    jq -e --argjson b "$(jq -c '{epoch,digest,guardVersion}' <<<"$(jq -c .token <<<"$ts")")" --arg rid "$(jq -r .record.registrySnapshot.id <<<"$ts")" '{epoch:.token.epoch,digest:.token.digest,guardVersion:.token.guardVersion}==$b and .record.registrySnapshot.id==$rid' <<<"$ss" >/dev/null || { _taskdag_compose_fail "source and target activation snapshots differ"; return 3; }
    # Production remains dormant until a real rollout commit replaces all-f.
    # Both the running binary and the published compatibility floor must
    # contain that commit before any writer is called.
    git -C "$TASKDAG_SCRIPT_DIR/.." cat-file -e "$TASKDAG_EPIC_COMPOSE_CUTOVER^{commit}" 2>/dev/null \
      && git -C "$TASKDAG_SCRIPT_DIR/.." merge-base --is-ancestor "$TASKDAG_EPIC_COMPOSE_CUTOVER" "$(jq -r .token.runtimeCommit <<<"$ts")" \
      && git -C "$TASKDAG_SCRIPT_DIR/.." merge-base --is-ancestor "$TASKDAG_EPIC_COMPOSE_CUTOVER" "$(jq -r .token.minimumCompatibleTaskDagCommit <<<"$ts")" \
      || { _taskdag_compose_fail "compose cutover is not active"; return 3; }
    # Authorize the source operation before creating anything in the target.
    # Every later source write repeats this snapshot-and-claim check.
    local compose_pwd=$PWD
    cd "$source" || return 3
    taskdag_consumer_prepare epic-compose-source-preflight \
      && _taskdag_compose_validate_source_claim "$source" "$claim" \
      || { cd "$compose_pwd" || return 3; _taskdag_compose_fail "source claim is absent, changed, foreign, or dead"; return 3; }
    cd "$compose_pwd" || return 3
    jq -e --arg prefix "task:${source_repo}@" 'all(.[];.from|startswith($prefix))' <<<"$ops" >/dev/null \
      || { _taskdag_compose_fail "every source operation must originate in the source repository" 2; return 2; }
    # Resolve external breakdown parents and prove claim-first has a ready
    # child against the current target generation before creating the root.
    cd "$target" || return 3
    taskdag_consumer_prepare epic-compose-target-preflight || { cd "$compose_pwd" || return 3; return 3; }
    local bi bj bcount dcount dependency ready any_ready=false external
    bcount=$(jq length <<<"$breakdown")
    for ((bi=0;bi<bcount;bi++)); do
        ready=true; dcount=$(jq ".[$bi].dependencies//[]|length" <<<"$breakdown")
        for ((bj=0;bj<dcount;bj++)); do
            dependency=$(jq -r ".[$bi].dependencies[$bj]" <<<"$breakdown")
            if [[ "$dependency" =~ ^@ ]] || jq -e --arg d "$dependency" --argjson i "$bi" '.[0:$i]|any(.title==$d)' <<<"$breakdown" >/dev/null; then
                ready=false; continue
            fi
            external=$(git rev-parse --verify "$dependency^{commit}" 2>/dev/null) \
              || { cd "$compose_pwd" || return 3; _taskdag_compose_fail "unresolved external breakdown dependency" 2; return 2; }
            taskdag_node_complete "task:${target_repo}@${external}" || ready=false
        done
        [ "$ready" = false ] || any_ready=true
    done
    cd "$compose_pwd" || return 3
    $any_ready || { _taskdag_compose_fail "breakdown has no dependency-ready child" 2; return 2; }
    td=$(_taskdag_compose_cli); local -a args=(); while IFS= read -r -d '' v; do args+=("$v"); done < <(_taskdag_compose_json_args "$create")
    # A consumed root lock is an expected replay state. Do not reacquire it.
    epic=$(taskdag_epic_id_for_operation "$source_id" "$(jq -r .operationId <<<"$create")") || return 2; locator=$(taskdag_root_locator "$epic") || return 2
    existing=$(git -C "$target" ls-remote --refs origin "$(jq -r .pendingRef <<<"$locator")" | awk 'NF==2{print $1}') || return 3
    active=$(git -C "$target" ls-remote --refs origin "$(jq -r .activeRef <<<"$locator")" | awk 'NF==2{print $1}') || return 3
    if [ -n "$existing" ] && [ -z "$active" ]; then
      out=$(cd "$target" && "$td" epic-create --json "${args[@]}") || return $?
    else out=$(cd "$target" && "$td" epic-create --json --claim "${args[@]}") || return $?; fi
    root=$(jq -er .rootCommit <<<"$out") || return 3
    tmp=$(mktemp) || return 2; printf '%s\n' "$breakdown" >"$tmp"
    broken=$(cd "$target" && "$td" breakdown "$root" --spec-file="$tmp" --claim-first --json 2>/dev/null); rc=$?; rm -f "$tmp"
    [ "$rc" -eq 0 ] || { _taskdag_compose_fail "canonical breakdown failed (conflict, ownership, stale state, or transport)"; return 3; }
    local target_node="task:${target_repo}@${root}"; n=$(jq length <<<"$ops")
    for ((i=0;i<n;i++)); do
        local compose_attempt=0 compose_max=3
        while :; do
        compose_attempt=$((compose_attempt+1))
        cd "$source" || return 3
        taskdag_consumer_prepare "epic-compose-source-$i" || { cd "$compose_pwd" || return 3; _taskdag_compose_fail "source semantic snapshot did not stabilize"; return 3; }
        _taskdag_compose_validate_source_claim "$source" "$claim" || { cd "$compose_pwd" || return 3; _taskdag_compose_fail "source claim is absent, changed, foreign, or dead"; return 3; }
        op=$(jq -c ".[$i]" <<<"$ops"); from=$(jq -r .from <<<"$op"); to=$(jq -r .to <<<"$op"); [ "$from" != '$targetRoot' ] || from=$target_node; [ "$to" != '$targetRoot' ] || to=$target_node
        relation=$(jq -r .relation <<<"$op"); mode=$(jq -r '.mode//empty' <<<"$op"); repo_id=$(jq -r '.repoId//empty' <<<"$op"); witness=$(jq -r '.witness//empty' <<<"$op"); reason=$(jq -r '.reason//"epic-compose"' <<<"$op")
        local -a dep=(dep add --from "$from" --to "$to" --relation "$relation" --reason "$reason")
        [ -z "$mode" ] || dep+=(--mode "$mode"); [ -z "$repo_id" ] || dep+=(--repo-id "$repo_id"); [ -z "$witness" ] || dep+=(--witness "$witness")
        authority=$(jq -er '.authorityTip' <<<"$TASKDAG_CONSUMER_ACTIVATION") || return 3
        TASKDAG_ACTIVATION_FENCED_PUSH_RESULT=''
        rc=0
        TASKDAG_EXPECTED_ACTIVATION_AUTHORITY="$authority" TASKDAG_USE_PREPARED_SNAPSHOT=true \
          taskdag_dep_add "$from" "$to" "$relation" "$mode" "$repo_id" "$witness" "$reason" >/dev/null || rc=$?
        if [ "$rc" -eq 0 ]; then break; fi
        if [ "$rc" -ne 75 ] || [ "$compose_attempt" -ge "$compose_max" ]; then cd "$compose_pwd" || return 3; return "$rc"; fi
        taskdag_cas_sleep "$compose_attempt" || return 3
        done
        cd "$compose_pwd" || return 3
    done
    jq -ncS --argjson epic "$out" --argjson breakdown "$broken" --argjson sourceOperationCount "$n" '{breakdown:$breakdown,epic:$epic,ok:true,schema:1,sourceOperationCount:$sourceOperationCount}'
}
