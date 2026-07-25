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

# Epic-ID v1 is provider-independent and hashes one explicitly framed origin.
# The prefix is part of the public identity; callers must never treat the raw
# digest as an interchangeable identifier. These helpers are pure and do not
# create objects or refs.
_taskdag_epic_id_v1() { # domain component...
    local LC_ALL=C domain=$1 value
    shift
    {
        printf 'task-dag-epic-id-v1\000%s\000' "$domain"
        for value in "$@"; do printf '%s:%s\000' "${#value}" "$value"; done
    } | sha256sum | awk '{print "epic-v1:" $1}'
}

_taskdag_epic_opaque_id_valid() {
    [ -n "$1" ] && [[ "$1" =~ ^[A-Za-z0-9._:+/=@-]+$ ]]
}

taskdag_epic_id_for_operation() { # source-repository-node-id durable-operation-id
    local repository_id=$1 operation_id=$2
    _taskdag_epic_opaque_id_valid "$repository_id" || return 1
    [[ "$operation_id" =~ ^[0-9a-f]{64}$ ]] || return 1
    _taskdag_epic_id_v1 operation "$repository_id" "$operation_id"
}

taskdag_epic_id_for_provider() { # provider repository-node-id issue-node-id
    local provider=$1 repository_id=$2 issue_id=$3
    [[ "$provider" =~ ^[a-z0-9][a-z0-9-]*$ ]] || return 1
    _taskdag_epic_opaque_id_valid "$repository_id" || return 1
    _taskdag_epic_opaque_id_valid "$issue_id" || return 1
    _taskdag_epic_id_v1 provider "$provider" "$repository_id" "$issue_id"
}

taskdag_epic_root_ref() { # epic-v1:<digest>
    [[ "$1" =~ ^epic-v1:([0-9a-f]{64})$ ]] || return 1
    printf 'refs/heads/tasks/pending/epic-v1/%s\n' "${BASH_REMATCH[1]}"
}

# Decode both root-ref dialects into one typed descriptor. Accepting the new
# path here does not enable it: no writer invokes this codec until the reader
# rollout and activation-fenced writer gate land.
taskdag_parse_epic_root_ref() { # full-ref
    local ref=$1 number digest
    case "$ref" in
        refs/heads/tasks/pending/[1-9]*)
            number=${ref#refs/heads/tasks/pending/}
            [[ "$number" =~ ^[1-9][0-9]*$ ]] || return 1
            jq -ncS --arg ref "$ref" --arg issueNumber "$number" \
                '{dialect:"legacy-issue-v0",epicId:null,issueNumber:$issueNumber,ref:$ref,schema:1}'
            ;;
        refs/heads/tasks/pending/epic-v1/*)
            digest=${ref#refs/heads/tasks/pending/epic-v1/}
            [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
            jq -ncS --arg ref "$ref" --arg epicId "epic-v1:$digest" \
                '{dialect:"epic-v1",epicId:$epicId,issueNumber:null,ref:$ref,schema:1}'
            ;;
        *) return 1 ;;
    esac
}

# Validate and emit the canonical JSON form of an Epic-ID root descriptor.
# Issue binding is all-or-nothing. Provider-origin roots are necessarily bound
# to the same immutable provider tuple; operation-origin roots may begin with
# an unbound desired projection. The root's desired projection survives a
# projector outage without a separate queue or intent record.
taskdag_canonicalize_epic_root_descriptor() {
    local input expected actual kind repository_id operation_id provider issue_id
    input=$(mktemp) || return 1
    cat >"$input" || { rm -f "$input"; return 1; }
    taskdag_json_file_is_single_strict "$input" || { rm -f "$input"; return 1; }
    jq -e '
      . as $root |
      type=="object" and keys==["epicId","origin","projection","schema","task"] and .schema==1 and
      (.epicId|type=="string" and test("^epic-v1:[0-9a-f]{64}$")) and
      (.task|type=="object" and keys==["author","description","status","title","type"] and
        (.title|type=="string" and length>0 and (test("[[:cntrl:]]")|not)) and
        (.author|type=="string" and (test("[[:cntrl:]]")|not)) and
        (.description|type=="string" and
          ((gsub("[\\n\\t]";"")|test("[[:cntrl:]]"))|not) and
          (test("(?m)^(Task|Epic-Root-Format|Epic-ID|Epic-Origin-Kind|Epic-Origin-Provider|Epic-Origin-Repository-ID|Epic-Origin-Operation-ID|Epic-Origin-Issue-ID|Author|Status|Type|Projection-Provider|Projection-Repository|Projection-Repository-ID|Projection-Issue-ID|Projection-Issue-Number|Projection-URL):")|not)) and
        .status=="pending" and .type=="epic") and
      (.projection|type=="object" and keys==["issueId","issueNumber","issueUrl","provider","repository","repositoryId"] and
        (.provider|type=="string" and test("^[a-z0-9][a-z0-9-]*$")) and
        (.repository|type=="string" and test("^[a-z0-9._-]+/[a-z0-9._-]+$")) and
        (.repositoryId|type=="string" and test("^[A-Za-z0-9._:+/=@-]+$")) and
        (((.issueId==null) and (.issueNumber==null) and (.issueUrl==null)) or
         ((.issueId|type=="string" and test("^[A-Za-z0-9._:+/=@-]+$")) and
          (.issueNumber|type=="string" and test("^[1-9][0-9]*$")) and
          (.issueUrl|type=="string" and test("^https://[^\\r\\n]+$") and
            (test("[[:cntrl:]]")|not))))) and
      ((.origin|type=="object" and keys==["kind","operationId","repositoryId"] and
          .kind=="operation" and (.operationId|test("^[0-9a-f]{64}$")) and
          (.repositoryId|test("^[A-Za-z0-9._:+/=@-]+$"))) or
       (.origin|type=="object" and keys==["issueId","kind","provider","repositoryId"] and
          .kind=="provider" and (.provider|test("^[a-z0-9][a-z0-9-]*$")) and
          (.repositoryId|test("^[A-Za-z0-9._:+/=@-]+$")) and
          (.issueId|test("^[A-Za-z0-9._:+/=@-]+$")) and
          .provider==$root.projection.provider and .repositoryId==$root.projection.repositoryId and
          .issueId==$root.projection.issueId))' "$input" >/dev/null \
        || { rm -f "$input"; return 1; }
    kind=$(jq -r .origin.kind "$input")
    repository_id=$(jq -r .origin.repositoryId "$input")
    if [ "$kind" = operation ]; then
        operation_id=$(jq -r .origin.operationId "$input")
        expected=$(taskdag_epic_id_for_operation "$repository_id" "$operation_id") \
            || { rm -f "$input"; return 1; }
    else
        provider=$(jq -r .origin.provider "$input")
        issue_id=$(jq -r .origin.issueId "$input")
        expected=$(taskdag_epic_id_for_provider "$provider" "$repository_id" "$issue_id") \
            || { rm -f "$input"; return 1; }
    fi
    actual=$(jq -r .epicId "$input")
    [ "$actual" = "$expected" ] || { rm -f "$input"; return 1; }
    jq -cS . "$input"
    local rc=$?; rm -f "$input"; return "$rc"
}

# Canonical message bytes for the new dialect. This is deliberately a pure
# serializer in the protocol landing; no command invokes it to mint a commit.
taskdag_serialize_epic_root_message() {
    local descriptor kind title author description epic_id provider repository_id operation_id issue_id
    local projection_provider projection_repository projection_repository_id projection_issue_number projection_url
    descriptor=$(taskdag_canonicalize_epic_root_descriptor) || return 1
    kind=$(jq -er .origin.kind <<<"$descriptor") || return 1
    title=$(jq -er .task.title <<<"$descriptor") || return 1
    author=$(jq -er '.task.author|strings' <<<"$descriptor") || return 1
    description=$(jq -ej '.task.description+"\u0001"' <<<"$descriptor") || return 1
    description=${description%$'\1'}
    epic_id=$(jq -er .epicId <<<"$descriptor") || return 1
    repository_id=$(jq -er .origin.repositoryId <<<"$descriptor") || return 1
    projection_provider=$(jq -er .projection.provider <<<"$descriptor") || return 1
    projection_repository=$(jq -er .projection.repository <<<"$descriptor") || return 1
    projection_repository_id=$(jq -er .projection.repositoryId <<<"$descriptor") || return 1

    printf 'Task: %s\n\nEpic-Root-Format: 1\nEpic-ID: %s\nEpic-Origin-Kind: %s\n' "$title" "$epic_id" "$kind" \
        || return 1
    if [ "$kind" = operation ]; then
        operation_id=$(jq -er .origin.operationId <<<"$descriptor") || return 1
        printf 'Epic-Origin-Repository-ID: %s\nEpic-Origin-Operation-ID: %s\n' "$repository_id" "$operation_id" \
            || return 1
    else
        provider=$(jq -er .origin.provider <<<"$descriptor") || return 1
        issue_id=$(jq -er .origin.issueId <<<"$descriptor") || return 1
        printf 'Epic-Origin-Provider: %s\nEpic-Origin-Repository-ID: %s\nEpic-Origin-Issue-ID: %s\n' \
            "$provider" "$repository_id" "$issue_id" || return 1
    fi
    printf 'Author: %s\nStatus: pending\nType: epic\nProjection-Provider: %s\nProjection-Repository: %s\nProjection-Repository-ID: %s\n' \
        "$author" "$projection_provider" "$projection_repository" "$projection_repository_id" || return 1
    local projection_unbound
    projection_unbound=$(jq -r '.projection.issueId==null' <<<"$descriptor") || return 1
    if [ "$projection_unbound" = false ]; then
        issue_id=$(jq -er .projection.issueId <<<"$descriptor") || return 1
        projection_issue_number=$(jq -er .projection.issueNumber <<<"$descriptor") || return 1
        projection_url=$(jq -er .projection.issueUrl <<<"$descriptor") || return 1
        printf 'Projection-Issue-ID: %s\nProjection-Issue-Number: %s\nProjection-URL: %s\n' \
            "$issue_id" "$projection_issue_number" "$projection_url" || return 1
    fi
    [ -z "$description" ] || printf '\n%s\n' "$description" || return 1
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
