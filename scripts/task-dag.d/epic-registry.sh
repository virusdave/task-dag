# shellcheck shell=bash
# Immutable, read-only Epic-ID registry and close-fact codecs.  Deliberately
# contains no object/ref writer.

TASKDAG_EPIC_REGISTRY_REF=refs/heads/tasks/v1/epics

taskdag_is_epic_registry_ref() {
    case "$1" in refs/heads/tasks/v1/epics|tasks/v1/epics) return 0;; *) return 1;; esac
}

taskdag_provider_binding_key() { # provider repository-id issue-id
    local provider=$1 repository_id=$2 issue_id=$3 value
    [[ "$provider" =~ ^[a-z0-9][a-z0-9-]*$ ]] || return 1
    _taskdag_epic_opaque_id_valid "$repository_id" || return 1
    _taskdag_epic_opaque_id_valid "$issue_id" || return 1
    {
        printf 'task-dag-epic-provider-binding-v1\000'
        for value in "$provider" "$repository_id" "$issue_id"; do
            printf '%s:%s\000' "${#value}" "$value"
        done
    } | sha256sum | awk '{print $1}'
}

taskdag__canonical_json_blob() { # blob-oid
    local blob=$1 actual expected
    actual=$(mktemp) || return 1; expected=$(mktemp) || { rm -f "$actual"; return 1; }
    git cat-file blob "$blob" >"$actual" 2>/dev/null \
        && taskdag_json_file_is_single_strict "$actual" \
        && jq -cS . "$actual" >"$expected" \
        && cmp -s "$actual" "$expected"
    local rc=$?; rm -f "$actual" "$expected"; return "$rc"
}

taskdag__legacy_close_fact() { # authority-tip issue root
    local tip=$1 issue=$2 root=$3 commit first second rest tree first_tree trailers value keys
    while read -r commit first second rest; do
        [ -n "$first" ] && [ -n "$second" ] && [ -z "$rest" ] || continue
        [ "$second" = "$root" ] || continue
        tree=$(git rev-parse "$commit^{tree}") || return 2
        first_tree=$(git rev-parse "$first^{tree}") || return 2
        [ "$tree" = "$first_tree" ] || continue
        keys=$(git show -s --format='%(trailers:keyonly,separator=%x0A)' "$commit") || return 2
        [ "$(grep -cx 'Closes-Epic' <<<"$keys")" -eq 1 ] || continue
        [ "$(grep -cx 'Closes-Epic-ID' <<<"$keys")" -eq 0 ] || continue
        trailers=$(git show -s --format='%(trailers:key=Closes-Epic,valueonly,separator=%x0A)' "$commit") || return 2
        value=${trailers#\#}; [ "$value" = "$issue" ] || continue
        printf '%s\n' "$commit"; return 0
    done < <(git rev-list --first-parent --parents "$tip")
    return 1
}

taskdag__registry_root_record() { # blob digest authority-tip
    local blob=$1 digest=$2 authority=$3 record descriptor canonical epic_id root kind adoption
    local issue issue_ref pending_ref expected_message actual_message tree parent gh pending
    taskdag__canonical_json_blob "$blob" || return 1
    record=$(git cat-file blob "$blob") || return 1
    jq -e --arg epic "epic-v1:$digest" '
      type=="object" and keys==["descriptor","epicId","kind","legacyAdoption","rootCommit","schema"] and
      .schema==1 and .epicId==$epic and
      (.kind=="native-epic-v1" or .kind=="legacy-adoption-v1") and
      (.rootCommit|type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$")) and
      (.descriptor|type=="object")' <<<"$record" >/dev/null || return 1
    descriptor=$(jq -cS .descriptor <<<"$record") || return 1
    canonical=$(taskdag_canonicalize_epic_root_descriptor <<<"$descriptor") || return 1
    [ "$descriptor" = "$canonical" ] || return 1
    epic_id=$(jq -r .epicId <<<"$record"); [ "$(jq -r .epicId <<<"$descriptor")" = "$epic_id" ] || return 1
    root=$(jq -r .rootCommit <<<"$record"); kind=$(jq -r .kind <<<"$record")
    if [ "$kind" = native-epic-v1 ]; then
        jq -e '.legacyAdoption==null' <<<"$record" >/dev/null || return 1
        [ "$(taskdag_resolve_typed_root "$(taskdag_root_locator "$epic_id")" "$root")" = "$descriptor" ] || return 1
    else
        adoption=$(jq -cS .legacyAdoption <<<"$record")
        jq -e 'type=="object" and keys==["issueNumber","issueRef","pendingRef"] and
          (.issueNumber|type=="string" and test("^[1-9][0-9]*$")) and
          .issueRef==("refs/heads/gh/issues/"+.issueNumber) and
          .pendingRef==("refs/heads/tasks/pending/"+.issueNumber)' <<<"$adoption" >/dev/null || return 1
        issue=$(jq -r .issueNumber <<<"$adoption"); issue_ref=$(jq -r .issueRef <<<"$adoption"); pending_ref=$(jq -r .pendingRef <<<"$adoption")
        jq -e --arg n "$issue" '
          .origin.kind=="provider" and .origin.provider=="github" and
          .projection.provider=="github" and .origin.repositoryId==.projection.repositoryId and
          .origin.issueId==.projection.issueId and .projection.issueNumber==$n and
          .projection.issueUrl==("https://github.com/"+.projection.repository+"/issues/"+$n)' <<<"$descriptor" >/dev/null || return 1
        tree=$(git rev-parse "$root^{tree}") || return 1; [ "$tree" = "$EMPTY_TREE" ] || return 1
        parent=$(git rev-parse "$root^" 2>/dev/null) || return 1
        [ "$(git cat-file -p "$root" | grep -c '^parent ')" -eq 1 ] && ! is_task_commit "$parent" || return 1
        expected_message=$(mktemp) || return 1; actual_message=$(mktemp) || { rm -f "$expected_message"; return 1; }
        taskdag_serialize_task_message "$(jq -r .task.title <<<"$descriptor")" "#$issue" \
          "$(jq -r .task.author <<<"$descriptor")" "$(jq -r .projection.issueUrl <<<"$descriptor")" pending epic \
          "$(jq -r .task.description <<<"$descriptor")" >"$expected_message" || { rm -f "$expected_message" "$actual_message"; return 1; }
        git cat-file commit "$root" | perl -0777 -e '$m=<>; $m =~ /\A.*?\n\n(.*)\z/s or exit 1; print $1' >"$actual_message"
        cmp -s "$expected_message" "$actual_message" || { rm -f "$expected_message" "$actual_message"; return 1; }
        rm -f "$expected_message" "$actual_message"
        gh=$(git rev-parse -q --verify "$issue_ref^{commit}" 2>/dev/null) || return 1; [ "$gh" = "$root" ] || return 1
        pending=$(git rev-parse -q --verify "$pending_ref^{commit}" 2>/dev/null || true)
        if [ -n "$pending" ]; then [ "$pending" = "$root" ] || return 1
        else [ -n "$authority" ] && taskdag__legacy_close_fact "$authority" "$issue" "$root" >/dev/null || return 1
        fi
    fi
    printf '%s\n' "$record"
}

taskdag__registry_binding_record() { # blob digest
    local blob=$1 digest=$2 record
    taskdag__canonical_json_blob "$blob" || return 1
    record=$(git cat-file blob "$blob") || return 1
    jq -e --arg epic "epic-v1:$digest" '
      type=="object" and keys==["epicId","projection","schema"] and .schema==1 and .epicId==$epic and
      (.projection|type=="object" and keys==["issueId","issueNumber","issueUrl","provider","repository","repositoryId"] and
       (.issueId|type=="string") and (.issueNumber|type=="string") and (.issueUrl|type=="string"))' <<<"$record" >/dev/null || return 1
    printf '%s\n' "$record"
}

taskdag_epic_registry_validate_snapshot() { # commit [authority-tip]
    local commit=$1 authority=${2:-} mode type blob path digest record projection key expected peer
    local tmp roots epic_bindings provider_bindings
    tmp=$(mktemp -d) || return 1; roots=$tmp/roots; epic_bindings=$tmp/epic; provider_bindings=$tmp/provider
    : >"$roots"; : >"$epic_bindings"; : >"$provider_bindings"
    while read -r mode type blob path; do
        [ "$mode" = 100644 ] && [ "$type" = blob ] || { rm -rf "$tmp"; return 1; }
        case "$path" in
          roots/*.json)
            digest=${path#roots/}; digest=${digest%.json}; [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || { rm -rf "$tmp"; return 1; }
            record=$(taskdag__registry_root_record "$blob" "$digest" "$authority") || { rm -rf "$tmp"; return 1; }
            printf '%s\t%s\n' "$digest" "$record" >>"$roots";;
          bindings/by-epic/*.json)
            digest=${path#bindings/by-epic/}; digest=${digest%.json}; [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || { rm -rf "$tmp"; return 1; }
            record=$(taskdag__registry_binding_record "$blob" "$digest") || { rm -rf "$tmp"; return 1; }
            printf '%s\t%s\t%s\n' "$digest" "$blob" "$record" >>"$epic_bindings";;
          bindings/by-provider/*.json)
            key=${path#bindings/by-provider/}; key=${key%.json}; [[ "$key" =~ ^[0-9a-f]{64}$ ]] || { rm -rf "$tmp"; return 1; }
            taskdag__canonical_json_blob "$blob" || { rm -rf "$tmp"; return 1; }
            record=$(git cat-file blob "$blob"); digest=${record#*epic-v1:}; digest=${digest%%\"*}
            taskdag__registry_binding_record "$blob" "$digest" >/dev/null || { rm -rf "$tmp"; return 1; }
            expected=$(taskdag_provider_binding_key "$(jq -r .projection.provider <<<"$record")" "$(jq -r .projection.repositoryId <<<"$record")" "$(jq -r .projection.issueId <<<"$record")") || { rm -rf "$tmp"; return 1; }
            [ "$key" = "$expected" ] || { rm -rf "$tmp"; return 1; }
            printf '%s\t%s\t%s\n' "$key" "$blob" "$record" >>"$provider_bindings";;
          *) rm -rf "$tmp"; return 1;;
        esac
    done < <(git ls-tree -r "$commit")
    while IFS=$'\t' read -r digest record; do
        projection=$(jq -cS .descriptor.projection <<<"$record")
        peer=$(awk -F '\t' -v d="$digest" '$1==d {print $3}' "$epic_bindings")
        if [ "$(jq -r '.issueId==null' <<<"$projection")" = true ]; then [ -z "$peer" ] || { rm -rf "$tmp"; return 1; }
        else
            [ "$(printf '%s\n' "$peer" | sed '/^$/d' | wc -l)" -eq 1 ] && [ "$(jq -cS .projection <<<"$peer")" = "$projection" ] || { rm -rf "$tmp"; return 1; }
            key=$(taskdag_provider_binding_key "$(jq -r .provider <<<"$projection")" "$(jq -r .repositoryId <<<"$projection")" "$(jq -r .issueId <<<"$projection")") || { rm -rf "$tmp"; return 1; }
            expected=$(awk -F '\t' -v k="$key" '$1==k {print $3}' "$provider_bindings")
            [ "$(printf '%s\n' "$expected" | sed '/^$/d' | wc -l)" -eq 1 ] && [ "$expected" = "$peer" ] || { rm -rf "$tmp"; return 1; }
        fi
    done <"$roots"
    [ "$(wc -l <"$epic_bindings")" -eq "$(awk -F '\t' 'index($2,"\"issueId\":null")==0 {n++} END{print n+0}' "$roots")" ] || { rm -rf "$tmp"; return 1; }
    [ "$(wc -l <"$provider_bindings")" -eq "$(wc -l <"$epic_bindings")" ] || { rm -rf "$tmp"; return 1; }
    rm -rf "$tmp"
}

taskdag_epic_registry_validate_history() { # tip [authority-tip]
    local tip=$1 authority=${2:-} chain commit first=true parents parent status path
    chain=$(git rev-list --reverse --first-parent "$tip") || return 1
    [ "$(git rev-list --count "$tip")" = "$(printf '%s\n' "$chain" | sed '/^$/d' | wc -l)" ] || return 1
    while read -r commit; do
        [ -n "$commit" ] || continue; parents=$(git cat-file -p "$commit" | grep -c '^parent ' || true)
        if $first; then [ "$parents" -eq 0 ] || return 1; first=false
        else
            [ "$parents" -eq 1 ] || return 1; parent=$(git rev-parse "$commit^") || return 1
            while IFS=$'\t' read -r status path; do
                [ -z "$status" ] || [ "$status" = A ] || return 1
            done < <(git diff-tree --no-commit-id --name-status -r "$parent" "$commit")
        fi
        taskdag_epic_registry_validate_snapshot "$commit" "$authority" || return 1
    done <<<"$chain"
}

taskdag_epic_registry_tip() { git rev-parse -q --verify "${TASKDAG_EPIC_REGISTRY_REF}^{commit}" 2>/dev/null; }

taskdag_epic_registry_record() { # epic-id [tip] [authority-tip]
    local epic_id=$1 tip=${2:-} authority=${3:-} digest blob
    [[ "$epic_id" =~ ^epic-v1:([0-9a-f]{64})$ ]] || return 2; digest=${BASH_REMATCH[1]}
    [ -n "$tip" ] || tip=$(taskdag_epic_registry_tip) || return 1
    taskdag_epic_registry_validate_history "$tip" "$authority" || return 2
    blob=$(git rev-parse "$tip:roots/$digest.json" 2>/dev/null) || return 1
    taskdag__registry_root_record "$blob" "$digest" "$authority"
}

taskdag_epic_registry_binding() { # epic-id [tip] [authority-tip]
    local epic_id=$1 tip=${2:-} authority=${3:-} digest
    [[ "$epic_id" =~ ^epic-v1:([0-9a-f]{64})$ ]] || return 2; digest=${BASH_REMATCH[1]}
    [ -n "$tip" ] || tip=$(taskdag_epic_registry_tip) || return 1
    taskdag_epic_registry_validate_history "$tip" "$authority" || return 2
    git show "$tip:bindings/by-epic/$digest.json" 2>/dev/null || return 1
}

taskdag_epic_registry_provider_binding() { # provider repository-id issue-id [tip] [authority-tip]
    local key tip=${4:-} authority=${5:-}
    key=$(taskdag_provider_binding_key "$1" "$2" "$3") || return 2
    [ -n "$tip" ] || tip=$(taskdag_epic_registry_tip) || return 1
    taskdag_epic_registry_validate_history "$tip" "$authority" || return 2
    git show "$tip:bindings/by-provider/$key.json" 2>/dev/null || return 1
}

taskdag_parse_epic_close_commit() { # commit [registry-tip] [authority-tip]
    local commit=$1 registry_tip=${2:-} authority=${3:-} line first root extra tree first_tree legacy typed epic_id record keys
    line=$(git rev-list --parents -n1 "$commit") || return 1; read -r _ first root extra <<<"$line"
    [ -n "$first" ] && [ -n "$root" ] && [ -z "$extra" ] || return 1
    tree=$(git rev-parse "$commit^{tree}") || return 1; first_tree=$(git rev-parse "$first^{tree}") || return 1; [ "$tree" = "$first_tree" ] || return 1
    keys=$(git show -s --format='%(trailers:keyonly,separator=%x0A)' "$commit") || return 1
    [ "$(grep -cx 'Closes-Epic-ID' <<<"$keys")" -eq 1 ] || return 1
    [ "$(grep -cx 'Closes-Epic' <<<"$keys")" -eq 0 ] || return 1
    legacy=$(git show -s --format='%(trailers:key=Closes-Epic,valueonly,separator=%x0A)' "$commit") || return 1
    typed=$(git show -s --format='%(trailers:key=Closes-Epic-ID,valueonly,separator=%x0A)' "$commit") || return 1
    [ -z "$legacy" ] || return 1
    epic_id=$typed; [[ "$epic_id" =~ ^epic-v1:[0-9a-f]{64}$ ]] || return 1
    record=$(taskdag_epic_registry_record "$epic_id" "$registry_tip" "$authority") || return 1
    [ "$(jq -r .rootCommit <<<"$record")" = "$root" ] || return 1
    if [ -n "$authority" ]; then
        git merge-base --is-ancestor "$commit" "$authority" || return 1
        git rev-list --first-parent "$authority" | grep -Fxq "$commit" || return 1
    fi
    printf '%s\t%s\t%s\n' "$epic_id" "$commit" "$root"
}
