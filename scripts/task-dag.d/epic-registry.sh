# shellcheck shell=bash
# Immutable Epic-ID registry and close-fact codecs.  The sole writer is the
# internal activation-fenced root operation below; it is intentionally not a
# command and cannot create children or leaf claims.

TASKDAG_EPIC_REGISTRY_REF=refs/heads/tasks/v1/epics
TASKDAG_EPIC_READER_CUTOVER=e265d03a71baa0f64d0a7af0135cb4f7d2c40841
TASKDAG_CANONICAL_AUTHOR_NAME=task-dag
TASKDAG_CANONICAL_AUTHOR_EMAIL=task-dag@freshlybaked.us

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

taskdag__registry_snapshot_ref() { # snapshot-json ref
    local snapshot=$1 ref=$2
    jq -er --arg ref "$ref" 'if type=="object" and .schema==1 and (.refs|type=="object") and
      (.authorityTip|type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$")) and
      (.refs|has($ref)) and (.refs[$ref]==null or (.refs[$ref]|type=="string" and test("^[0-9a-f]{40}([0-9a-f]{24})?$")))
      then (.refs[$ref] // "") else error("invalid registry origin snapshot") end' <<<"$snapshot"
}

taskdag__registry_root_record() { # blob digest authority-tip [origin-snapshot-json]
    local blob=$1 digest=$2 authority=$3 snapshot=${4:-} record descriptor canonical epic_id root kind adoption
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
        if [ -n "$snapshot" ]; then
            [ "$(jq -r .authorityTip <<<"$snapshot")" = "$authority" ] || return 1
            gh=$(taskdag__registry_snapshot_ref "$snapshot" "$issue_ref") || return 1
            pending=$(taskdag__registry_snapshot_ref "$snapshot" "$pending_ref") || return 1
        else
            gh=$(git rev-parse -q --verify "$issue_ref^{commit}" 2>/dev/null) || return 1
            pending=$(git rev-parse -q --verify "$pending_ref^{commit}" 2>/dev/null || true)
        fi
        [ "$gh" = "$root" ] || return 1
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

taskdag_epic_registry_validate_snapshot() { # commit [authority-tip] [origin-snapshot-json]
    local commit=$1 authority=${2:-} snapshot=${3:-} mode type blob path digest record projection key expected peer
    local tmp roots epic_bindings provider_bindings
    tmp=$(mktemp -d) || return 1; roots=$tmp/roots; epic_bindings=$tmp/epic; provider_bindings=$tmp/provider
    : >"$roots"; : >"$epic_bindings"; : >"$provider_bindings"
    while read -r mode type blob path; do
        [ "$mode" = 100644 ] && [ "$type" = blob ] || { rm -rf "$tmp"; return 1; }
        case "$path" in
          roots/*.json)
            digest=${path#roots/}; digest=${digest%.json}; [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || { rm -rf "$tmp"; return 1; }
            record=$(taskdag__registry_root_record "$blob" "$digest" "$authority" "$snapshot") || { rm -rf "$tmp"; return 1; }
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

taskdag_epic_registry_validate_history() { # tip [authority-tip] [origin-snapshot-json]
    local tip=$1 authority=${2:-} snapshot=${3:-} chain commit first=true parents parent status path
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
        taskdag_epic_registry_validate_snapshot "$commit" "$authority" "$snapshot" || return 1
    done <<<"$chain"
}

taskdag_epic_registry_tip() { git rev-parse -q --verify "${TASKDAG_EPIC_REGISTRY_REF}^{commit}" 2>/dev/null; }

taskdag_epic_registry_record() { # epic-id [tip] [authority-tip] [origin-snapshot-json]
    local epic_id=$1 tip=${2:-} authority=${3:-} snapshot=${4:-} digest blob
    [[ "$epic_id" =~ ^epic-v1:([0-9a-f]{64})$ ]] || return 2; digest=${BASH_REMATCH[1]}
    [ -n "$tip" ] || tip=$(taskdag_epic_registry_tip) || return 1
    taskdag_epic_registry_validate_history "$tip" "$authority" "$snapshot" || return 2
    blob=$(git rev-parse "$tip:roots/$digest.json" 2>/dev/null) || return 1
    taskdag__registry_root_record "$blob" "$digest" "$authority" "$snapshot"
}

taskdag_epic_registry_binding() { # epic-id [tip] [authority-tip] [origin-snapshot-json]
    local epic_id=$1 tip=${2:-} authority=${3:-} snapshot=${4:-} digest
    [[ "$epic_id" =~ ^epic-v1:([0-9a-f]{64})$ ]] || return 2; digest=${BASH_REMATCH[1]}
    [ -n "$tip" ] || tip=$(taskdag_epic_registry_tip) || return 1
    taskdag_epic_registry_validate_history "$tip" "$authority" "$snapshot" || return 2
    git show "$tip:bindings/by-epic/$digest.json" 2>/dev/null || return 1
}

taskdag_epic_registry_provider_binding() { # provider repository-id issue-id [tip] [authority-tip] [origin-snapshot-json]
    local key tip=${4:-} authority=${5:-} snapshot=${6:-}
    key=$(taskdag_provider_binding_key "$1" "$2" "$3") || return 2
    [ -n "$tip" ] || tip=$(taskdag_epic_registry_tip) || return 1
    taskdag_epic_registry_validate_history "$tip" "$authority" "$snapshot" || return 2
    git show "$tip:bindings/by-provider/$key.json" 2>/dev/null || return 1
}

# Atomically create (or adopt) one canonical root, append its immutable
# registry facts, and acquire its root orchestration lock. Input is one strict
# canonical JSON object. This deliberately accepts already-resolved immutable
# provider data and has no provider/API dependency.
taskdag_internal_mint_epic_root() { # spec-json
    local spec=$1 canonical descriptor epic_id digest locator pending active parent legacy kind root message
    local claim claim_id claimer host pid ttl note timestamp registry_old registry_new record binding key
    local rows pending_old active_old issue_old master_old idx tree record_blob binding_blob token updates result readback existing_record=false
    local scheduling_pending scheduling_active existing provider_existing retired=false adopted_live=false
    local discovery snapshot refs_file ref oid snapshot_rows
    local -a snapshot_args
    jq -e 'type=="object" and keys==["actor","authoritativeTimestamp","claim","descriptor","legacyAdoption","parentCommit","schema"] and
      .schema==1 and (.actor|type=="string" and length>0 and (test("[[:cntrl:]]")|not)) and
      (.authoritativeTimestamp|type=="string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
      (.parentCommit|type=="string" and test("^([0-9a-f]{40}|[0-9a-f]{64})$")) and
      (.claim|type=="object" and keys==["claimId","claimer","host","note","pid","ttlHours"] and
       (.claimId|type=="string" and test("^[A-Za-z0-9._-]{1,128}$")) and
       (.claimer|type=="string" and length>0 and (test("[[:cntrl:]]")|not)) and
       (.host|type=="string" and length>0 and (test("[[:cntrl:]]")|not)) and
       (.note|type=="string" and (test("[[:cntrl:]]")|not)) and
       (.pid|type=="string" and test("^[1-9][0-9]*$")) and
       (.ttlHours|type=="string" and test("^[1-9][0-9]*$"))) and
      (.legacyAdoption==null or (.legacyAdoption|type=="object" and keys==["issueNumber","issueRef","pendingRef"] and
       (.issueNumber|type=="string" and test("^[1-9][0-9]*$")) and .issueRef==("refs/heads/gh/issues/"+.issueNumber) and
       .pendingRef==("refs/heads/tasks/pending/"+.issueNumber)))' <<<"$spec" >/dev/null 2>&1 || return 2
    canonical=$(jq -cS . <<<"$spec") || return 2
    [ "$canonical" = "$spec" ] || return 2
    timestamp=$(jq -r .authoritativeTimestamp <<<"$spec")
    descriptor=$(taskdag_canonicalize_epic_root_descriptor <<<"$(jq -c .descriptor <<<"$spec")") || return 2
    [ "$descriptor" = "$(jq -cS .descriptor <<<"$spec")" ] || return 2
    epic_id=$(jq -r .epicId <<<"$descriptor"); digest=${epic_id#epic-v1:}
    locator=$(taskdag_root_locator "$epic_id") || return 2
    pending=$(jq -r .pendingRef <<<"$locator"); active=$(jq -r .activeRef <<<"$locator")
    parent=$(jq -r .parentCommit <<<"$spec"); git cat-file -e "$parent^{commit}" 2>/dev/null || return 2
    legacy=$(jq -cS .legacyAdoption <<<"$spec")

    # Activation compatibility is checked before writing even unreachable
    # objects. The published floor must include the Epic-ID reader cutover,
    # not merely claim that this local runtime is new enough.
    token=$(taskdag_activation_snapshot_token) || return 3
    git -C "$TASKDAG_SCRIPT_DIR/.." cat-file -e "$TASKDAG_EPIC_READER_CUTOVER^{commit}" 2>/dev/null || return 3
    git -C "$TASKDAG_SCRIPT_DIR/.." merge-base --is-ancestor "$TASKDAG_EPIC_READER_CUTOVER" \
      "$(jq -r .minimumCompatibleTaskDagCommit <<<"$token")" || return 3

    if [ "$legacy" = null ]; then
        scheduling_pending=$pending; scheduling_active=$active
    else
        scheduling_pending=$(jq -r .pendingRef <<<"$legacy")
        scheduling_active="refs/heads/tasks/root-active/$(jq -r .issueNumber <<<"$legacy")"
    fi
    # Discover the immutable registry tip, then enumerate every legacy locator
    # it contains. The second ls-remote is the one exhaustive origin snapshot;
    # it repeats registry/master so movement during discovery fails closed.
    discovery=$(git ls-remote --refs origin "$TASKDAG_EPIC_REGISTRY_REF" refs/heads/master) || return 3
    registry_old=$(awk -v r="$TASKDAG_EPIC_REGISTRY_REF" '$2==r{print $1}' <<<"$discovery")
    master_old=$(awk '$2=="refs/heads/master"{print $1}' <<<"$discovery"); [ -n "$master_old" ] || return 3
    if [ -n "$registry_old" ]; then
        git fetch -q --no-tags origin "$registry_old" || return 3
        [ "$(git rev-parse FETCH_HEAD)" = "$registry_old" ] || return 3
    fi
    refs_file=$(mktemp) || return 2
    printf '%s\n' "$TASKDAG_EPIC_REGISTRY_REF" refs/heads/master "$scheduling_pending" "$scheduling_active" "$pending" "$active" >"$refs_file"
    if [ -n "$registry_old" ]; then
        while read -r oid; do
            git cat-file blob "$oid" | jq -r 'if .kind=="legacy-adoption-v1" then .legacyAdoption.issueRef,.legacyAdoption.pendingRef else empty end' >>"$refs_file" \
              || { rm -f "$refs_file"; return 3; }
        done < <(git ls-tree -r "$registry_old" roots/ | awk '$2=="blob"{print $3}')
    fi
    [ "$legacy" = null ] || jq -r '.issueRef,.pendingRef' <<<"$legacy" >>"$refs_file"
    mapfile -t snapshot_args < <(sort -u "$refs_file"); rm -f "$refs_file"
    rows=$(git ls-remote --refs origin "${snapshot_args[@]}") || return 3
    [ "$(awk -v r="$TASKDAG_EPIC_REGISTRY_REF" '$2==r{print $1}' <<<"$rows")" = "$registry_old" ] || return 3
    [ "$(awk '$2=="refs/heads/master"{print $1}' <<<"$rows")" = "$master_old" ] || return 3
    snapshot_rows=$(mktemp) || return 2
    for ref in "${snapshot_args[@]}"; do
        oid=$(awk -v r="$ref" '$2==r{print $1}' <<<"$rows")
        jq -nc --arg ref "$ref" --arg oid "$oid" '{key:$ref,value:(if $oid=="" then null else $oid end)}' >>"$snapshot_rows" || { rm -f "$snapshot_rows"; return 2; }
    done
    snapshot=$(jq -csS --arg authority "$master_old" '{authorityTip:$authority,refs:from_entries,schema:1}' "$snapshot_rows") || { rm -f "$snapshot_rows"; return 2; }
    rm -f "$snapshot_rows"
    issue_old=$([ "$legacy" = null ] || taskdag__registry_snapshot_ref "$snapshot" "$(jq -r .issueRef <<<"$legacy")") || return 3
    [ "$legacy" = null ] || [ -n "$issue_old" ] || return 3
    # Fetch immutable roots by captured OID only; never materialise ambient refs.
    while read -r oid; do [ -z "$oid" ] || git fetch -q --no-tags origin "$oid" || return 3; done \
      < <(jq -r '.refs|to_entries[]|select(.key|startswith("refs/heads/gh/issues/"))|.value//empty' <<<"$snapshot" | sort -u)
    if [ "$legacy" != null ]; then
        # Typed scheduling refs would create a second namespace for one root.
        [ -z "$(taskdag__registry_snapshot_ref "$snapshot" "$pending")" ] \
          && [ -z "$(taskdag__registry_snapshot_ref "$snapshot" "$active")" ] || return 3
    fi
    master_old=$(awk '$2=="refs/heads/master"{print $1}' <<<"$rows")
    [ -n "$master_old" ] || return 3
    git fetch -q --no-tags origin "$master_old" || return 3
    [ "$(git rev-parse FETCH_HEAD)" = "$master_old" ] || return 3
    pending_old=$(awk -v r="$scheduling_pending" '$2==r{print $1}' <<<"$rows")
    active_old=$(awk -v r="$scheduling_active" '$2==r{print $1}' <<<"$rows")

    if [ "$legacy" = null ]; then
        message=$(mktemp) || return 2
        taskdag_serialize_epic_root_message <<<"$descriptor" >"$message" || { rm -f "$message"; return 2; }
        root=$(GIT_AUTHOR_NAME="$TASKDAG_CANONICAL_AUTHOR_NAME" GIT_AUTHOR_EMAIL="$TASKDAG_CANONICAL_AUTHOR_EMAIL" GIT_COMMITTER_NAME="$TASKDAG_CANONICAL_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$TASKDAG_CANONICAL_AUTHOR_EMAIL" GIT_AUTHOR_DATE="$timestamp" GIT_COMMITTER_DATE="$timestamp" git commit-tree "$EMPTY_TREE" -p "$parent" <"$message") || { rm -f "$message"; return 2; }
        rm -f "$message"; kind=native-epic-v1
    else
        root=$issue_old
        if [ -n "$pending_old" ]; then [ "$pending_old" = "$root" ] || return 3
        else taskdag__legacy_close_fact "$master_old" "$(jq -r .issueNumber <<<"$legacy")" "$root" >/dev/null || return 3; retired=true
        fi
        kind='legacy-adoption-v1'
    fi
    record=$(jq -ncS --argjson descriptor "$descriptor" --arg epic "$epic_id" --arg root "$root" --arg kind "$kind" --argjson legacy "$legacy" \
      '{descriptor:$descriptor,epicId:$epic,kind:$kind,legacyAdoption:$legacy,rootCommit:$root,schema:1}') || return 2
    claim=$(jq -c .claim <<<"$spec"); claim_id=$(jq -r .claimId <<<"$claim"); claimer=$(jq -r .claimer <<<"$claim")
    host=$(jq -r .host <<<"$claim"); pid=$(jq -r .pid <<<"$claim"); ttl=$(jq -r .ttlHours <<<"$claim"); note=$(jq -r .note <<<"$claim")
    if [ "$legacy" = null ]; then
        binding="Epic-ID: $epic_id
Root-Ref: $scheduling_pending"
    else
        binding="Issue: #$(jq -r .issueNumber <<<"$legacy")"
    fi
    message="Claim: $(jq -r .task.title <<<"$descriptor")

Claim-Kind: root
$binding
Claim-ID: $claim_id
Task-Commit: $root
Claimer: $claimer
Claimer-Host: $host
Claimer-PID: $pid
Claimed-At: $timestamp
TTL-Hours: $ttl"
    [ -z "$note" ] || message="$message
Note: $note"
    claim=$(GIT_AUTHOR_NAME="$TASKDAG_CANONICAL_AUTHOR_NAME" GIT_AUTHOR_EMAIL="$TASKDAG_CANONICAL_AUTHOR_EMAIL" GIT_COMMITTER_NAME="$TASKDAG_CANONICAL_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$TASKDAG_CANONICAL_AUTHOR_EMAIL" GIT_AUTHOR_DATE="$timestamp" GIT_COMMITTER_DATE="$timestamp" git commit-tree "$EMPTY_TREE" -p "$root" -m "$message") || return 2
    locator=$(taskdag_root_locator "$scheduling_pending") || return 2
    taskdag_validate_root_claim "$locator" "$root" "$claim" || return 2

    if [ -n "$registry_old" ]; then
        git fetch -q --no-tags origin "$registry_old" || return 3
        [ "$(git rev-parse FETCH_HEAD)" = "$registry_old" ] || return 3
        taskdag_epic_registry_validate_history "$registry_old" "$master_old" "$snapshot" || return 3
        existing=$(taskdag_epic_registry_record "$epic_id" "$registry_old" "$master_old" "$snapshot" 2>/dev/null || true)
        if [ -n "$existing" ]; then [ "$existing" = "$record" ] || return 3; existing_record=true; fi
        if [ "$(jq -r '.projection.issueId==null' <<<"$descriptor")" = false ]; then
            provider_existing=$(taskdag_epic_registry_provider_binding "$(jq -r .projection.provider <<<"$descriptor")" "$(jq -r .projection.repositoryId <<<"$descriptor")" "$(jq -r .projection.issueId <<<"$descriptor")" "$registry_old" "$master_old" "$snapshot" 2>/dev/null || true)
            [ -z "$provider_existing" ] || [ "$(jq -r .epicId <<<"$provider_existing")" = "$epic_id" ] || return 3
        fi
    fi
    # Exact state matrix. A registry record cannot repair missing refs, and
    # refs cannot synthesize a missing immutable record. Retired legacy roots
    # are the sole exception: append-only registry adoption, never resurrection.
    if [ "$retired" = true ]; then
        [ -z "$active_old" ] || return 3
        $existing_record && { jq -ncS --arg epicId "$epic_id" --arg rootCommit "$root" --arg rootRef "$scheduling_pending" '{activeRef:null,claimCommit:null,created:false,epicId:$epicId,rootCommit:$rootCommit,rootRef:$rootRef,schema:1}'; return 0; }
    elif [ "$legacy" != null ] && ! $existing_record; then
        [ "$pending_old" = "$root" ] && [ "$active_old" = "$claim" ] || return 3
        adopted_live=true
    elif $existing_record && [ -n "$pending_old" ] && [ -n "$active_old" ]; then
        [ "$pending_old" = "$root" ] && [ "$active_old" = "$claim" ] || return 3
        jq -ncS --arg epicId "$epic_id" --arg rootCommit "$root" --arg rootRef "$scheduling_pending" --arg claimCommit "$claim" --arg activeRef "$scheduling_active" \
          '{activeRef:$activeRef,claimCommit:$claimCommit,created:false,epicId:$epicId,rootCommit:$rootCommit,rootRef:$rootRef,schema:1}'
        return 0
    elif $existing_record || [ -n "$pending_old" ] || [ -n "$active_old" ]; then
        return 3
    fi
    idx=$(mktemp) || return 2; rm -f "$idx"
    if [ -n "$registry_old" ]; then
        GIT_INDEX_FILE=$idx git read-tree "$registry_old" || { rm -f "$idx"; return 2; }
    fi
    printf '%s\n' "$record" | git hash-object -w --stdin >"$idx.record" || { rm -f "$idx" "$idx.record"; return 2; }
    record_blob=$(cat "$idx.record"); rm -f "$idx.record"
    if GIT_INDEX_FILE=$idx git ls-files --error-unmatch "roots/$digest.json" >/dev/null 2>&1; then rm -f "$idx"; return 3; fi
    GIT_INDEX_FILE=$idx git update-index --add --cacheinfo "100644,$record_blob,roots/$digest.json" || { rm -f "$idx"; return 2; }
    if [ "$(jq -r '.projection.issueId==null' <<<"$descriptor")" = false ]; then
        binding=$(jq -ncS --arg epic "$epic_id" --argjson projection "$(jq -c .projection <<<"$descriptor")" '{epicId:$epic,projection:$projection,schema:1}') || { rm -f "$idx"; return 2; }
        binding_blob=$(printf '%s\n' "$binding" | git hash-object -w --stdin) || { rm -f "$idx"; return 2; }
        key=$(taskdag_provider_binding_key "$(jq -r .projection.provider <<<"$descriptor")" "$(jq -r .projection.repositoryId <<<"$descriptor")" "$(jq -r .projection.issueId <<<"$descriptor")") || { rm -f "$idx"; return 2; }
        for path in "bindings/by-epic/$digest.json" "bindings/by-provider/$key.json"; do
            GIT_INDEX_FILE=$idx git ls-files --error-unmatch "$path" >/dev/null 2>&1 && { rm -f "$idx"; return 3; }
            GIT_INDEX_FILE=$idx git update-index --add --cacheinfo "100644,$binding_blob,$path" || { rm -f "$idx"; return 2; }
        done
    fi
    tree=$(GIT_INDEX_FILE=$idx git write-tree); rm -f "$idx"
    if [ -n "$registry_old" ]; then registry_new=$(GIT_AUTHOR_NAME="$TASKDAG_CANONICAL_AUTHOR_NAME" GIT_AUTHOR_EMAIL="$TASKDAG_CANONICAL_AUTHOR_EMAIL" GIT_COMMITTER_NAME="$TASKDAG_CANONICAL_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$TASKDAG_CANONICAL_AUTHOR_EMAIL" GIT_AUTHOR_DATE="$timestamp" GIT_COMMITTER_DATE="$timestamp" git commit-tree "$tree" -p "$registry_old" -m "Register Epic-ID $epic_id")
    else registry_new=$(GIT_AUTHOR_NAME="$TASKDAG_CANONICAL_AUTHOR_NAME" GIT_AUTHOR_EMAIL="$TASKDAG_CANONICAL_AUTHOR_EMAIL" GIT_COMMITTER_NAME="$TASKDAG_CANONICAL_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$TASKDAG_CANONICAL_AUTHOR_EMAIL" GIT_AUTHOR_DATE="$timestamp" GIT_COMMITTER_DATE="$timestamp" git commit-tree "$tree" -m "Register Epic-ID $epic_id"); fi || return 2
    taskdag_epic_registry_validate_history "$registry_new" "$master_old" "$snapshot" || return 2
    # The activation authority captured before the origin scheduling snapshot
    # is the server-side transaction lease for that whole snapshot. Every
    # canonical scheduling writer advances the same authority, so no-op
    # pending/active refspecs are neither necessary nor part of the protocol.
    updates=$(jq -ncS --arg rr "$TASKDAG_EPIC_REGISTRY_REF" --arg ro "$registry_old" --arg rn "$registry_new" \
      --arg pr "$scheduling_pending" --arg root "$root" --arg ar "$scheduling_active" --arg claim "$claim" --argjson retired "$retired" --argjson adopted "$adopted_live" \
      '[{ref:$rr,old:$ro,new:$rn}] +
       (if $retired or $adopted then []
        else [{ref:$pr,old:"",new:$root},{ref:$ar,old:"",new:$claim}] end)|sort_by(.ref)') || return 2
    taskdag_activation_fenced_multi_push "$token" scheduling mint-epic-root "$(jq -r .actor <<<"$spec")" "$timestamp" "$updates" || return 3
    result=$TASKDAG_ACTIVATION_FENCED_PUSH_RESULT
    jq -e --arg rr "$TASKDAG_EPIC_REGISTRY_REF" --arg rn "$registry_new" '
      . as $result | .outcome=="applied" and any($result.readback.targets[]; .ref==$rr and .oid==$rn)' <<<"$result" >/dev/null || return 3
    # One coherent post-transaction advertisement must contain the accepted
    # authority, registry, and exact numeric/typed scheduling projections.
    readback=$(git ls-remote --refs origin "$TASKDAG_ACTIVATION_REF" "$TASKDAG_EPIC_REGISTRY_REF" "$scheduling_pending" "$scheduling_active") || return 3
    [ "$(awk -v r="$TASKDAG_ACTIVATION_REF" '$2==r{print $1}' <<<"$readback")" = "$(jq -r .authority.observed <<<"$result")" ] \
      && [ "$(awk -v r="$TASKDAG_EPIC_REGISTRY_REF" '$2==r{print $1}' <<<"$readback")" = "$registry_new" ] \
      && [ "$(awk -v r="$scheduling_pending" '$2==r{print $1}' <<<"$readback")" = "$([ "$retired" = true ] || printf '%s' "$root")" ] \
      && [ "$(awk -v r="$scheduling_active" '$2==r{print $1}' <<<"$readback")" = "$([ "$retired" = true ] || printf '%s' "$claim")" ] || return 3
    jq -ncS --arg epicId "$epic_id" --arg rootCommit "$root" --arg rootRef "$scheduling_pending" --arg claimCommit "$claim" --arg activeRef "$scheduling_active" --argjson retired "$retired" \
      '{activeRef:(if $retired then null else $activeRef end),claimCommit:(if $retired then null else $claimCommit end),created:true,epicId:$epicId,rootCommit:$rootCommit,rootRef:$rootRef,schema:1}'
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
