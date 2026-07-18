#!/usr/bin/env bash
# Canonical, restart-safe fleet orchestration for semantic activation.

_taskdag_activation_fleet_error() { echo "Error: activation fleet: $*" >&2; return 2; }

_taskdag_activation_fleet_repo_from_url() {
    local url=$1 path
    case "$url" in
        git@*:*/*) path=${url#*:} ;;
        https://github.com/*/*|ssh://git@github.com/*/*) path=${url#*github.com/} ;;
        *) return 1 ;;
    esac
    path=${path%.git}
    [[ "$path" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
    printf '%s\n' "$(tr '[:upper:]' '[:lower:]' <<<"$path")"
}

_taskdag_activation_fleet_registry_rows() { # registry-file; name<TAB>url<TAB>repo
    local file=$1 line trimmed name url mode branch extra repo
    declare -A names=() repositories=()
    while IFS= read -r line || [ -n "$line" ]; do
        [[ "$line" != *$'\r'* ]] || return 1
        trimmed=${line#"${line%%[![:space:]]*}"}
        [ -n "$trimmed" ] || continue
        [[ "$trimmed" == \#* ]] && continue
        name= url= mode= branch= extra=
        read -r name url mode branch extra <<<"$trimmed"
        [[ "$name" =~ ^[a-z0-9][a-z0-9._-]{0,127}$ ]] && [ -n "$url" ] && [ -z "$extra" ] || return 1
        [ -z "${names[$name]+set}" ] || return 1
        if [ -n "$mode" ] || [ -n "$branch" ]; then
            [ "$mode" = off ] && [ -n "$branch" ] || return 1
            git check-ref-format "refs/heads/$branch" >/dev/null 2>&1 || return 1
        fi
        repo=$(_taskdag_activation_fleet_repo_from_url "$url") || return 1
        [ -z "${repositories[$repo]+set}" ] || return 1
        names[$name]=1; repositories[$repo]=1
        printf '%s\t%s\t%s\n' "$name" "$url" "$repo"
    done <"$file"
}

_taskdag_activation_fleet_remote_head() { # checkout; ref<TAB>commit
    local checkout=$1 advertisement ref commit
    advertisement=$(git -C "$checkout" ls-remote --symref origin HEAD) || return 1
    ref=$(awk '$1=="ref:" && $3=="HEAD" {print $2}' <<<"$advertisement")
    commit=$(awk '$2=="HEAD" && $1 ~ /^[0-9a-f]{40,64}$/ {print $1}' <<<"$advertisement")
    [[ "$ref" =~ ^refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] && [[ "$commit" =~ ^[0-9a-f]{40,64}$ ]] || return 1
    git -C "$checkout" fetch -q --no-tags origin "$commit" || return 1
    [ "$(git -C "$checkout" rev-parse FETCH_HEAD)" = "$commit" ] || return 1
    printf '%s\t%s\n' "$ref" "$commit"
}

_taskdag_activation_fleet_prepare_checkout() { # work-root name url
    local root=$1 name=$2 url=$3 path="$1/$2"
    mkdir -p "$root" || return 1
    if [ ! -d "$path/.git" ]; then
        [ ! -e "$path" ] || return 1
        git clone -q "$url" "$path" || return 1
    fi
    [ "$(git -C "$path" config --get remote.origin.url)" = "$url" ] || return 1
    printf '%s\n' "$path"
}

_taskdag_activation_fleet_server_time() {
    local response observed
    response=$(gh api --include repos/virusdave/top-level 2>/dev/null) || return 1
    observed=$(awk 'BEGIN{IGNORECASE=1} /^date:/ {$1="";sub(/^ /,"");gsub("\r","");print;exit}' <<<"$response")
    date -u -d "$observed" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null
}

_taskdag_activation_fleet_validate_plan() { # file
    local file=$1 tmp
    jq -e '
      type=="object" and keys==["endpoints","expected","schema","target"] and .schema==1 and
      (.endpoints|type=="array" and length>0 and .==sort_by(.repository) and
        (map(.repository)|length==(unique|length)) and all(.[];
          keys==["repository","repositoryId","url"] and
          (.repository|type=="string" and test("^[a-z0-9_.-]+/[a-z0-9_.-]+$")) and
          (.repositoryId|type=="string" and length>0) and
          (.url|type=="string" and length>0))) and
      (.expected|type=="array" and length>0 and .==sort_by(.repository) and
        (map(.repository)|length==(unique|length)) and all(.[];
          keys==["authorityTip","recordDigest","repository","state"] and
          (.repository|type=="string" and test("^[a-z0-9_.-]+/[a-z0-9_.-]+$")) and
          (.state=="absent" or .state=="enabled" or .state=="disabled") and
          (if .state=="absent" then .authorityTip==null and .recordDigest==null
           else (.authorityTip|type=="string" and test("^[0-9a-f]{40,64}$")) and
                (.recordDigest|type=="string" and test("^[0-9a-f]{64}$")) end))) and
      ((.expected|map(.repository))==(.endpoints|map(.repository))) and
      ((.expected|map(.repository))==(.target.registrySnapshot.repositories|map(.repository))) and
      ([.endpoints[]|{repository,repositoryId}]==[.target.sourceTips[]|{repository,repositoryId}])
    ' "$file" >/dev/null 2>&1 || return 1
    tmp=$(mktemp) || return 1
    jq -cS .target "$file" >"$tmp" && _taskdag_activation_validate_spec_file "$tmp"
    local rc=$?; rm -f "$tmp"; return "$rc"
}

_taskdag_activation_fleet_checkout_identity() { # checkout plan expected-repo
    local checkout=$1 plan=$2 expected=$3 raw push endpoint repo_info head_ref head_commit
    endpoint=$(jq -c --arg repo "$expected" '.endpoints[]|select(.repository==$repo)' "$plan") || return 1
    [ -n "$endpoint" ] || return 1
    raw=$(git -C "$checkout" config --get remote.origin.url 2>/dev/null) || return 1
    push=$(git -C "$checkout" config --get-all remote.origin.pushurl 2>/dev/null || true)
    [ -z "$push" ] || return 1
    [ "$raw" = "$(jq -r .url <<<"$endpoint")" ] || return 1
    repo_info=$(gh api "repos/$expected" 2>/dev/null) || return 1
    [ "$(jq -r '.full_name|ascii_downcase' <<<"$repo_info")" = "$expected" ] || return 1
    [ "$(jq -r .node_id <<<"$repo_info")" = "$(jq -r .repositoryId <<<"$endpoint")" ] || return 1
    IFS=$'\t' read -r head_ref head_commit < <(_taskdag_activation_fleet_remote_head "$checkout") || return 1
    [ "$head_ref" = "$(jq -r --arg repo "$expected" '.target.sourceTips[]|select(.repository==$repo)|.ref' "$plan")" ] &&
      [ "$head_commit" = "$(jq -r --arg repo "$expected" '.target.sourceTips[]|select(.repository==$repo)|.commit' "$plan")" ]
}

cmd_activation_fleet_plan() {
    local registry_checkout="" work_root="" output="" actor=${TASK_DAG_CLAIMER:-activation-fleet} state=enabled registry_path
    local registry_commit registry_blob registry_snapshot rows tmp name url repo path head_ref head_commit repository_id repo_info runtime timestamp registry_id status rc operation_id
    while [ $# -gt 0 ]; do case "$1" in
        --registry-checkout) registry_checkout=$2; shift 2;;
        --work-root) work_root=$2; shift 2;;
        --output) output=$2; shift 2;;
        --actor) actor=$2; shift 2;;
        --state) state=$2; shift 2;;
        -h|--help) echo 'Usage: task-dag activation fleet-plan --registry-checkout DIR --work-root DIR --output FILE [--actor TEXT] [--state enabled|disabled]'; return 0;;
        *) return 2;;
    esac; done
    [ -n "$registry_checkout" ] && [ -n "$work_root" ] && [ -n "$output" ] && [ -d "$registry_checkout/.git" ] || return 2
    registry_checkout=$(realpath -e -- "$registry_checkout") || return 2
    work_root=$(realpath -m -- "$work_root") || return 2
    [[ "$actor" != *[[:cntrl:]]* && -n "$actor" && ${#actor} -le 200 ]] && [[ "$state" =~ ^(enabled|disabled)$ ]] || return 2
    registry_path=scripts/ephemeral_checkout.d/repos.conf
    registry_file="$registry_checkout/$registry_path"
    IFS=$'\t' read -r head_ref registry_commit < <(_taskdag_activation_fleet_remote_head "$registry_checkout") || return 3
    [ "$head_ref" = refs/heads/master ] && [ "$(git -C "$registry_checkout" rev-parse HEAD)" = "$registry_commit" ] || {
        _taskdag_activation_fleet_error "registry checkout must be pristine origin/master HEAD"; return 3;
    }
    [ -z "$(git -C "$registry_checkout" status --porcelain --untracked-files=no)" ] || return 3
    registry_blob=$(git -C "$registry_checkout" rev-parse "$registry_commit:$registry_path") || return 3
    registry_snapshot=$(mktemp) || return 2
    git -C "$registry_checkout" show "$registry_commit:$registry_path" >"$registry_snapshot" || { rm -f "$registry_snapshot"; return 3; }
    rows=$(mktemp) || return 2
    _taskdag_activation_fleet_registry_rows "$registry_snapshot" >"$rows" || { rm -f "$rows" "$registry_snapshot"; return 2; }
    rm -f "$registry_snapshot"
    [ -s "$rows" ] || { rm -f "$rows"; return 2; }
    tmp=$(mktemp -d) || { rm -f "$rows"; return 2; }
    : >"$tmp/repositories"; : >"$tmp/tips"; : >"$tmp/expected"; : >"$tmp/endpoints"
    while IFS=$'\t' read -r name url repo; do
        path=$(_taskdag_activation_fleet_prepare_checkout "$work_root" "$name" "$url") || { rm -rf "$tmp"; rm -f "$rows"; return 3; }
        IFS=$'\t' read -r head_ref head_commit < <(_taskdag_activation_fleet_remote_head "$path") || { rm -rf "$tmp"; rm -f "$rows"; return 3; }
        repo_info=$(gh api "repos/$repo" 2>/dev/null) || { rm -rf "$tmp"; rm -f "$rows"; return 3; }
        jq -e '.node_id|type=="string" and length>0' <<<"$repo_info" >/dev/null 2>&1 || { rm -rf "$tmp"; rm -f "$rows"; return 3; }
        repository_id=$(jq -r .node_id <<<"$repo_info")
        repo=$(jq -r '.full_name|ascii_downcase' <<<"$repo_info")
        [[ "$repo" =~ ^[a-z0-9_.-]+/[a-z0-9_.-]+$ ]] || { rm -rf "$tmp"; rm -f "$rows"; return 3; }
        git -C "$path" config taskdag.current-repo "$repo" || { rm -rf "$tmp"; rm -f "$rows"; return 3; }
        jq -ncS --arg repository "$repo" --arg repositoryId "$repository_id" --arg url "$url" '{repository:$repository,repositoryId:$repositoryId,url:$url}' >>"$tmp/endpoints"
        jq -ncS --arg name "$name" --arg repository "$repo" --arg repositoryId "$repository_id" '{name:$name,repairBranch:null,repairMode:"off",repository:$repository,repositoryId:$repositoryId}' >>"$tmp/repositories"
        jq -ncS --arg commit "$head_commit" --arg ref "$head_ref" --arg repository "$repo" --arg repositoryId "$repository_id" '{commit:$commit,ref:$ref,repository:$repository,repositoryId:$repositoryId}' >>"$tmp/tips"
        status=""; rc=0; status=$(cd "$path" && cmd_activation_status --json) || rc=$?
        if [ "$rc" -eq 0 ] && [ "$(jq -r .present <<<"$status")" = true ]; then
            jq -ncS --arg repository "$repo" --arg authorityTip "$(jq -r .authorityTip <<<"$status")" --arg recordDigest "$(jq -r .digest <<<"$status")" --arg priorState "$(jq -r .record.state <<<"$status")" \
              '{authorityTip:$authorityTip,recordDigest:$recordDigest,repository:$repository,state:$priorState}' >>"$tmp/expected"
        elif [ "$rc" -eq 0 ]; then
            jq -ncS --arg repository "$repo" '{authorityTip:null,recordDigest:null,repository:$repository,state:"absent"}' >>"$tmp/expected"
        else rm -rf "$tmp"; rm -f "$rows"; return 3; fi
    done <"$rows"
    rm -f "$rows"
    runtime=$(_taskdag_activation_runtime_commit) || { rm -rf "$tmp"; return 3; }
    [ "$runtime" = "$(jq -r 'select(.repository=="virusdave/task-dag")|.commit' "$tmp/tips")" ] || {
        rm -rf "$tmp"; _taskdag_activation_fleet_error "runtime must equal the frozen task-dag origin HEAD"; return 3;
    }
    timestamp=$(_taskdag_activation_fleet_server_time) || { rm -rf "$tmp"; return 3; }
    operation_id=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n') || { rm -rf "$tmp"; return 3; }
    [[ "$operation_id" =~ ^[0-9a-f]{32}$ ]] || { rm -rf "$tmp"; return 3; }
    actor="$actor:activation-$operation_id"
    jq -scS '{schema:1,source:{repository:"virusdave/top-level",path:"scripts/ephemeral_checkout.d/repos.conf",commit:$commit,blob:$blob},repositories:sort_by(.repository)}' \
        --arg commit "$registry_commit" --arg blob "$registry_blob" "$tmp/repositories" >"$tmp/registry"
    registry_id=$(_taskdag_activation_registry_id "$tmp/registry") || { rm -rf "$tmp"; return 3; }
    jq -ncS --arg actor "$actor" --arg timestamp "$timestamp" --arg runtime "$runtime" --arg id "$registry_id" --arg state "$state" \
        --argjson registry "$(cat "$tmp/registry")" --argjson tips "$(jq -scS 'sort_by(.repository)' "$tmp/tips")" \
        '{actor:$actor,authoritativeTimestamp:$timestamp,minimumCompatibleTaskDagCommit:$runtime,registrySnapshot:($registry+{id:$id}),sourceTips:$tips,state:$state}' >"$tmp/target"
    jq -ncS --argjson target "$(cat "$tmp/target")" --argjson endpoints "$(jq -scS 'sort_by(.repository)' "$tmp/endpoints")" --argjson expected "$(jq -scS 'sort_by(.repository)' "$tmp/expected")" '{endpoints:$endpoints,expected:$expected,schema:1,target:$target}' >"$tmp/plan"
    _taskdag_activation_fleet_validate_plan "$tmp/plan" || { rm -rf "$tmp"; return 3; }
    mkdir -p "$(dirname "$output")" && mv "$tmp/plan" "$output" || { rm -rf "$tmp"; return 2; }
    rm -rf "$tmp"
    printf '%s\n' "$output"
}

_taskdag_activation_fleet_one_status() { # plan work-root registry-entry
    local plan=$1 root=$2 entry=$3 name repo path expected target status rc=0 phase=conflict state=unreadable authority=null digest=null
    name=$(jq -r .name <<<"$entry"); repo=$(jq -r .repository <<<"$entry"); path="$root/$name"
    expected=$(jq -c --arg repo "$repo" '.expected[]|select(.repository==$repo)' "$plan")
    target=$(jq -c .target "$plan")
    if [ -d "$path/.git" ] && _taskdag_activation_fleet_checkout_identity "$path" "$plan" "$repo"; then
        status=$(cd "$path" && cmd_activation_status --json) || rc=$?
        if [ "$rc" -eq 0 ] && [ "$(jq -r .present <<<"$status")" = false ]; then
            state=absent
            [ "$(jq -r .state <<<"$expected")" = absent ] && phase=expected
        elif [ "$rc" -eq 0 ]; then
            state=$(jq -r .record.state <<<"$status"); authority=$(jq -r .authorityTip <<<"$status"); digest=$(jq -r .digest <<<"$status")
            if jq -e --argjson target "$target" '.record|del(.schema,.epoch,.predecessor,.guardVersion)==$target' <<<"$status" >/dev/null 2>&1; then
                phase=target
            elif [ "$(jq -r .state <<<"$target")" = enabled ] && [ "$state" = disabled ] \
              && jq -e --argjson target "$target" '.record|del(.schema,.epoch,.predecessor,.guardVersion,.state)==($target|del(.state))' <<<"$status" >/dev/null 2>&1; then
                phase=intermediate
            elif [ "$authority" = "$(jq -r .authorityTip <<<"$expected")" ] \
              && [ "$digest" = "$(jq -r .recordDigest <<<"$expected")" ] \
              && [ "$state" = "$(jq -r .state <<<"$expected")" ]; then
                phase=expected
            fi
        fi
    fi
    jq -ncS --arg name "$name" --arg repository "$repo" --arg phase "$phase" --arg state "$state" \
      --arg authorityTip "$authority" --arg recordDigest "$digest" \
      '{authorityTip:(if $authorityTip=="null" then null else $authorityTip end),name:$name,phase:$phase,recordDigest:(if $recordDigest=="null" then null else $recordDigest end),repository:$repository,state:$state}'
}

_taskdag_activation_fleet_status_snapshot() { # snapshotted-plan work-root
    local plan=$1 root=$2 row statuses tmp overall target_state
    tmp=$(mktemp) || return 2; : >"$tmp"; target_state=$(jq -r .target.state "$plan")
    while IFS= read -r row; do _taskdag_activation_fleet_one_status "$plan" "$root" "$row" >>"$tmp"; done < <(jq -c '.target.registrySnapshot.repositories[]' "$plan")
    statuses=$(jq -scS 'sort_by(.repository)' "$tmp"); rm -f "$tmp"
    if jq -e 'any(.[];.phase=="conflict")' <<<"$statuses" >/dev/null; then overall=conflict
    elif jq -e 'all(.[];.phase=="target")' <<<"$statuses" >/dev/null; then overall=$target_state
    elif [ "$target_state" = enabled ] && jq -e 'all(.[];.phase=="intermediate")' <<<"$statuses" >/dev/null; then overall=disabled
    elif [ "$target_state" = enabled ] && jq -e 'all(.[];.phase=="intermediate" or .phase=="target")' <<<"$statuses" >/dev/null; then overall=partial-enabled
    else overall=expected; fi
    jq -ncS --arg overall "$overall" --arg targetState "$target_state" --argjson repositories "$statuses" '{overall:$overall,repositories:$repositories,schema:1,targetState:$targetState}'
    [ "$overall" != conflict ]
}

cmd_activation_fleet_status() {
    local spec="" root="" tmp status rc=0
    while [ $# -gt 0 ]; do case "$1" in --spec-file) spec=$2; shift 2;; --work-root) root=$2; shift 2;; -h|--help) echo 'Usage: task-dag activation fleet-status --spec-file FILE --work-root DIR'; return 0;; *) return 2;; esac; done
    [ -n "$spec" ] && [ -d "$root" ] || return 2
    tmp=$(mktemp -d) || return 2
    _taskdag_activation_snapshot_file "$spec" "$tmp/plan" && _taskdag_activation_fleet_validate_plan "$tmp/plan" || { rm -rf "$tmp"; return 2; }
    status=$(_taskdag_activation_fleet_status_snapshot "$tmp/plan" "$root") || rc=$?
    rm -rf "$tmp"; printf '%s\n' "$status"; return "$rc"
}

_taskdag_activation_fleet_apply_rows() { # plan target-spec root status phase
    local plan=$1 target=$2 root=$3 status=$4 wanted_phase=$5 row name repo path expect
    while IFS= read -r row; do
        [ "$(jq -r .phase <<<"$row")" = "$wanted_phase" ] || continue
        name=$(jq -r .name <<<"$row"); repo=$(jq -r .repository <<<"$row"); path="$root/$name"; expect=$(jq -r '.authorityTip // "absent"' <<<"$row")
        _taskdag_activation_fleet_checkout_identity "$path" "$plan" "$repo" || return 3
        (cd "$path" && cmd_activation_apply --spec-file "$target" --expect-old "$expect") >/dev/null || return 3
    done < <(jq -c '.repositories[]' <<<"$status")
}

cmd_activation_fleet_apply() {
    local spec="" root="" tmp plan target disabled desired status overall
    while [ $# -gt 0 ]; do case "$1" in --spec-file) spec=$2; shift 2;; --work-root) root=$2; shift 2;; -h|--help) echo 'Usage: task-dag activation fleet-apply --spec-file FILE --work-root DIR'; return 0;; *) return 2;; esac; done
    [ -n "$spec" ] && [ -d "$root" ] || return 2
    tmp=$(mktemp -d) || return 2; plan="$tmp/plan"; target="$tmp/target"; disabled="$tmp/disabled"
    _taskdag_activation_snapshot_file "$spec" "$plan" && _taskdag_activation_fleet_validate_plan "$plan" || { rm -rf "$tmp"; return 2; }
    jq -cS .target "$plan" >"$target"; desired=$(jq -r .state "$target")
    status=$(_taskdag_activation_fleet_status_snapshot "$plan" "$root") || { rm -rf "$tmp"; return 3; }
    if [ "$desired" = disabled ]; then
        _taskdag_activation_fleet_apply_rows "$plan" "$target" "$root" "$status" expected || { rm -rf "$tmp"; return 3; }
        status=$(_taskdag_activation_fleet_status_snapshot "$plan" "$root") || { rm -rf "$tmp"; return 3; }
        [ "$(jq -r .overall <<<"$status")" = disabled ] || { rm -rf "$tmp"; return 3; }
        rm -rf "$tmp"; printf '%s\n' "$status"; return 0
    fi
    overall=$(jq -r .overall <<<"$status")
    if [ "$overall" = expected ]; then
        jq -cS '.target.state="disabled"|.target' "$plan" >"$disabled"
        _taskdag_activation_fleet_apply_rows "$plan" "$disabled" "$root" "$status" expected || { rm -rf "$tmp"; return 3; }
        status=$(_taskdag_activation_fleet_status_snapshot "$plan" "$root") || { rm -rf "$tmp"; return 3; }
        overall=$(jq -r .overall <<<"$status")
    fi
    [ "$overall" = disabled ] || [ "$overall" = partial-enabled ] || [ "$overall" = enabled ] || { rm -rf "$tmp"; return 3; }
    _taskdag_activation_fleet_apply_rows "$plan" "$target" "$root" "$status" intermediate || { rm -rf "$tmp"; return 3; }
    status=$(_taskdag_activation_fleet_status_snapshot "$plan" "$root") || { rm -rf "$tmp"; return 3; }
    [ "$(jq -r .overall <<<"$status")" = enabled ] || { rm -rf "$tmp"; return 3; }
    rm -rf "$tmp"; printf '%s\n' "$status"
}
