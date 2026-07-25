# shellcheck shell=bash
# Minimal task classification and ancestry predicates.

if ! declare -F parse_commit_metadata >/dev/null \
    || ! declare -F extract_field >/dev/null \
    || ! declare -F get_first_parent >/dev/null \
    || ! declare -F is_task_commit >/dev/null; then
    echo "Error: task-model.sh requires git-objects.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi

# True only for the exact human GitHub comment task dialect. Ordinary task
# children, bot/system messages, and malformed messages remain fail-closed.
is_human_comment_task() {
    local sha="$1" msg
    msg=$(parse_commit_metadata "$sha" 2>/dev/null) || return 1
    [ "$(extract_field "$msg" "kind")" = "message" ] &&
    [ "$(extract_field "$msg" "role")" = "human" ] &&
    [ "$(extract_field "$msg" "intent")" = "comment" ]
}

# A top-level epic root is Type: epic and is not parented on another task
# object. Child epics therefore remain distinct from repository-history roots.
task_is_root_shaped_epic() {
    local sha="$1" type first
    type=$(extract_field "$(parse_commit_metadata "$sha")" "Type" 2>/dev/null || true)
    [ "$type" = epic ] || return 1
    first=$(get_first_parent "$sha" 2>/dev/null || true)
    if [ -n "$first" ] && is_task_commit "$first"; then
        return 1
    fi
    return 0
}

# Canonical task message serialization shared by issue roots and breakdown
# leaves. Optional metadata is represented explicitly by empty arguments; the
# resulting bytes retain the existing task format.
taskdag_serialize_task_message() { # title issue author url status type description [extra]
    local title=$1 issue=$2 author=$3 url=$4 status=$5 type=$6 description=$7 extra=${8:-}
    [ -n "$title" ] && [[ "$title" != *$'\n'* ]] || return 1
    [[ "$issue" =~ ^#[1-9][0-9]*$|^$ ]] || return 1
    [ "$status" = pending ] || return 1
    [[ "$type" =~ ^(leaf|task|epic)$ ]] || return 1
    [[ "$author" != *$'\n'* && "$author" != *$'\r'* ]] || return 1
    [[ "$url" != *$'\n'* && "$url" != *$'\r'* ]] || return 1
    [[ "$extra" =~ ^Materialisation-Operation-Id:\ [0-9a-f]{64}$|^$ ]] || return 1
    if grep -Eq '^(Task|Issue|Author|URL|Status|Type|Materialisation-Operation-Id):' <<<"$description"; then
        return 1
    fi
    printf 'Task: %s\n\n' "$title"
    [ -z "$issue" ] || printf 'Issue: %s\n' "$issue"
    [ -z "$author" ] || printf 'Author: %s\n' "$author"
    [ -z "$url" ] || printf 'URL: %s\n' "$url"
    printf 'Status: %s\nType: %s\n' "$status" "$type"
    [ -z "$extra" ] || printf '%s\n' "$extra"
    [ -z "$description" ] || printf '\n%s\n' "$description"
}

# Emit a mutation-free operation-bound commit plan; no ref or object is written.
taskdag_plan_task_commit() { # kind tree parent title issue author url status type description operation-id [dependency...]
    local kind=$1 tree=$2 parent=$3 title=$4 issue=$5 author=$6 url=$7 status=$8 type=$9
    shift 9
    local description=$1 operation_id=$2; shift 2
    local message_file parents dep
    [[ "$kind" =~ ^(root|leaf)$ ]] || return 1
    [ "$tree" = "$EMPTY_TREE" ] || return 1
    [[ "$parent" =~ ^[0-9a-f]{40}$|^[0-9a-f]{64}$ ]] || return 1
    [[ "$operation_id" =~ ^[0-9a-f]{64}$ ]] || return 1
    if [ "$kind" = root ]; then
        [ "$type" = epic ] && [ "$status" = pending ] || return 1
        [ "$#" -eq 0 ] || return 1
    else
        [ "$type" = leaf ] && [ "$status" = pending ] || return 1
    fi
    message_file=$(mktemp) || return 1
    taskdag_serialize_task_message "$title" "$issue" "$author" "$url" "$status" "$type" "$description" \
        "Materialisation-Operation-Id: $operation_id" >"$message_file" || { rm -f "$message_file"; return 1; }
    parents=$(jq -nc --arg parent "$parent" '[ $parent ]') || return 1
    for dep in "$@"; do
        [[ "$dep" =~ ^[0-9a-f]{40}$|^[0-9a-f]{64}$ ]] || return 1
        jq -e --arg dep "$dep" 'index($dep)==null' <<<"$parents" >/dev/null || { rm -f "$message_file"; return 1; }
        parents=$(jq -c --arg dep "$dep" '. + [$dep]' <<<"$parents") || return 1
    done
    jq -ncS --arg kind "$kind" --arg tree "$tree" --rawfile message "$message_file" --argjson parents "$parents" \
        --arg title "$title" --arg issue "$issue" --arg author "$author" --arg url "$url" --arg status "$status" \
        --arg type "$type" --arg description "$description" --arg operationId "$operation_id" \
        '{schema:1,kind:$kind,tree:$tree,parents:$parents,message:$message,task:{author:$author,description:$description,issue:$issue,operationId:$operationId,status:$status,title:$title,type:$type,url:$url}}'
    local rc=$?; rm -f "$message_file"; return "$rc"
}

taskdag_validate_task_commit_plan() {
    local input expected_file
    input=$(mktemp) || return 1
    cat >"$input"
    taskdag_json_file_is_single_strict "$input" || { rm -f "$input"; return 1; }
    jq -e --arg empty "$EMPTY_TREE" '
      def oid: type=="string" and test("^([0-9a-f]{40}|[0-9a-f]{64})$");
      type=="object" and keys==["kind","message","parents","schema","task","tree"] and .schema==1 and
      (.kind=="root" or .kind=="leaf") and .tree==$empty and
      (.parents|type=="array" and length>0 and length==(unique|length) and all(.[];oid)) and
      (.task|type=="object" and keys==["author","description","issue","operationId","status","title","type","url"] and
        (.title|type=="string" and length>0 and (test("[\\r\\n]")|not)) and
        (.issue|test("^#[1-9][0-9]*$")) and (.author|type=="string" and (test("[\\r\\n]")|not)) and
        (.url|type=="string" and (test("[\\r\\n]")|not)) and
        (.description|type=="string" and (test("(?m)^(Task|Issue|Author|URL|Status|Type|Materialisation-Operation-Id):")|not)) and
        .status=="pending" and (.operationId|test("^[0-9a-f]{64}$")) and
        (if $ARGS.named.kind=="root" then .type=="epic" else .type=="leaf" end)) and
      (if .kind=="root" then (.parents|length)==1 else true end)' --arg kind "$(jq -r .kind "$input")" "$input" >/dev/null \
        || { rm -f "$input"; return 1; }
    local title issue author url status type description operation_id
    title=$(jq -r .task.title "$input"); issue=$(jq -r .task.issue "$input")
    author=$(jq -r .task.author "$input"); url=$(jq -r .task.url "$input")
    status=$(jq -r .task.status "$input"); type=$(jq -r .task.type "$input")
    description=$(jq -j '.task.description+"\u0001"' "$input"); description=${description%$'\1'}
    operation_id=$(jq -r .task.operationId "$input")
    expected_file=$(mktemp) || { rm -f "$input"; return 1; }
    taskdag_serialize_task_message "$title" "$issue" "$author" "$url" "$status" "$type" "$description" \
        "Materialisation-Operation-Id: $operation_id" >"$expected_file" || { rm -f "$input" "$expected_file"; return 1; }
    jq -e --rawfile expected "$expected_file" '.message==$expected' "$input" >/dev/null \
        || { rm -f "$input" "$expected_file"; return 1; }
    rm -f "$input" "$expected_file"
}
