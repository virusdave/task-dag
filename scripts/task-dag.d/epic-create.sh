# shellcheck shell=bash
# Public, provider-free ingress for the canonical Epic-ID root minter.

cmd_epic_create() {
    if [ "${1:-}" = --help ] || [ "${1:-}" = -h ]; then
        cat <<'EOF'
Usage: task-dag epic-create --json --title TEXT --author LOGIN --description TEXT
       --repository OWNER/REPO --repository-id NODE_ID
       (--operation-id SHA256 --origin-repository OWNER/REPO
        --origin-repository-id NODE_ID |
        --issue-id NODE_ID --issue-number N --issue-url HTTPS_URL)
       [--materialisation-operation-id SHA256
        --materialisation-declaration-digest SHA256
        --materialisation-source-repository OWNER/REPO
        --materialisation-source-repository-id NODE_ID]
       [--provider github] [--parent COMMIT] [--timestamp RFC3339]
       [--claim-note TEXT] [--claim]

Usage: task-dag epic-bind-projection --json --source-checkout ABSOLUTE_PATH
       <the issue and materialisation options shown above>

Atomically create or replay an Epic-ID root in task-dag's git
datastore. The operation form records an immutable desired issue projection
without contacting GitHub. The issue form ingests immutable repository and
issue node IDs; issue number and URL are projection metadata only. If the
numeric legacy issue refs already exist, they are adopted through the same
registry/binding compare-and-swap rather than duplicated.

--claim atomically born-claims an operation root. Provider ingress normally
omits it, leaving a pickable root which can later be claimed with claim-root.
Output is one strict JSON object. No GitHub token or API is used.
EOF
        return 0
    fi
    local title='' author='' description='' repository='' repository_id='' origin_repository='' origin_repository_id=''
    local operation_id='' issue_id='' issue_number='' issue_url='' provider=github parent='' timestamp=''
    local marker_operation='' marker_declaration='' marker_source='' marker_source_id='' source_checkout=''
    local claimer=${TASK_DAG_CLAIMER:-${USER:-unknown}} claim_id='' note='' ttl=${TASK_DAG_TTL_HOURS:-12} json=false explicit_claim=false
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --json) json=true; shift ;;
            --claim) explicit_claim=true; shift ;;
            --title|--author|--description|--repository|--repository-id|--origin-repository|--origin-repository-id|--operation-id|--issue-id|--issue-number|--issue-url|--provider|--parent|--timestamp|--claim-note|--materialisation-operation-id|--materialisation-declaration-digest|--materialisation-source-repository|--materialisation-source-repository-id|--source-checkout)
                [ "$#" -ge 2 ] || { echo "epic-create: $1 requires a value" >&2; return 2; }
                local option=${1#--} value=$2; shift 2
                case "$option" in
                    title) title=$value;; author) author=$value;; description) description=$value;; repository) repository=$value;;
                    repository-id) repository_id=$value;; origin-repository) origin_repository=$value;; origin-repository-id) origin_repository_id=$value;; operation-id) operation_id=$value;;
                    issue-id) issue_id=$value;; issue-number) issue_number=$value;; issue-url) issue_url=$value;; provider) provider=$value;;
                    parent) parent=$value;; timestamp) timestamp=$value;; claim-note) note=$value;;
                    materialisation-operation-id) marker_operation=$value;; materialisation-declaration-digest) marker_declaration=$value;;
                    materialisation-source-repository) marker_source=$value;; materialisation-source-repository-id) marker_source_id=$value;;
                    source-checkout) source_checkout=$value;;
                esac ;;
            *) echo "epic-create: unknown argument: $1" >&2; return 2 ;;
        esac
    done
    $json || { echo "epic-create: --json is required" >&2; return 2; }
    [ -n "$title" ] && [ -n "$author" ] && [ -n "$repository" ] && [ -n "$repository_id" ] \
        || { echo "epic-create: --title, --author, --description, --repository and --repository-id are required" >&2; return 2; }
    if [ -n "$operation_id" ]; then
        [ -n "$origin_repository" ] && [ -n "$origin_repository_id" ] || { echo "epic-create: operation origin needs --origin-repository and --origin-repository-id" >&2; return 2; }
    else
        [ -n "$issue_id" ] && [ -n "$issue_number" ] && [ -n "$issue_url" ] && [ -z "$origin_repository$origin_repository_id" ] \
            || { echo "epic-create: issue origin needs --issue-id, --issue-number and --issue-url" >&2; return 2; }
    fi
    [[ "$ttl" =~ ^[1-9][0-9]*$ ]] || { echo "epic-create: TASK_DAG_TTL_HOURS must be positive" >&2; return 2; }
    local token activation_record registry_repo_id
    token=$(taskdag_activation_snapshot_token) || return 3
    git -C "$TASKDAG_SCRIPT_DIR/.." cat-file -e "$TASKDAG_EPIC_WRITER_CUTOVER^{commit}" 2>/dev/null || return 3
    git -C "$TASKDAG_SCRIPT_DIR/.." merge-base --is-ancestor "$TASKDAG_EPIC_WRITER_CUTOVER" "$(jq -r .minimumCompatibleTaskDagCommit <<<"$token")" || return 3
    activation_record=$(taskdag_activation_record_for_snapshot "$token") || return 3
    repository=$(taskdag_norm_owner_repo "$repository") || { echo "epic-create: malformed --repository" >&2; return 2; }
    registry_repo_id=$(jq -er --arg repo "$repository" '.registrySnapshot.repositories[]|select(.repository==$repo)|.repositoryId' <<<"$activation_record") \
        || { echo "epic-create: repository is absent or ambiguous in activation registry" >&2; return 3; }
    [ "$repository_id" = "$registry_repo_id" ] || { echo "epic-create: --repository-id does not match activation registry" >&2; return 3; }
    if [ -n "$origin_repository_id" ]; then
        origin_repository=$(taskdag_norm_owner_repo "$origin_repository") || { echo "epic-create: malformed --origin-repository" >&2; return 2; }
        jq -e --arg repo "$origin_repository" --arg id "$origin_repository_id" \
          'any(.registrySnapshot.repositories[];.repository==$repo and .repositoryId==$id)' <<<"$activation_record" >/dev/null \
            || { echo "epic-create: origin repository slug/ID pair is absent from activation registry" >&2; return 3; }
    fi
    [ -n "$timestamp" ] || timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    if [ -n "$marker_operation$marker_declaration$marker_source$marker_source_id" ]; then
        [ -z "$operation_id" ] && [ -n "$marker_operation" ] && [ -n "$marker_declaration" ] && [ -n "$marker_source" ] && [ -n "$marker_source_id" ] \
          || { echo "epic-create: projector marker needs all immutable fields on provider ingress" >&2; return 2; }
        marker_source=$(taskdag_norm_owner_repo "$marker_source") || return 2
        jq -e --arg repo "$marker_source" --arg id "$marker_source_id" 'any(.registrySnapshot.repositories[];.repository==$repo and .repositoryId==$id)' <<<"$activation_record" >/dev/null || return 3
        if [ -n "$source_checkout" ]; then
            [[ "$source_checkout" = /* ]] || { echo "epic-create: --source-checkout must be absolute" >&2; return 2; }
            taskdag_internal_bind_operation_projection "$source_checkout" "$marker_source" "$marker_source_id" "$marker_operation" "$marker_declaration" "$provider" "$repository" "$repository_id" \
              "$issue_id" "$issue_number" "$issue_url" "$claimer" "$timestamp"
            return $?
        fi
        # A provider event is never source authority. It may only replay a
        # binding already established by a prepared worker/projector.
        local marker_epic marker_binding marker_rows marker_registry marker_master
        marker_epic=$(taskdag_epic_id_for_operation "$marker_source_id" "$marker_operation") || return 3
        marker_rows=$(git ls-remote --refs origin "$TASKDAG_EPIC_REGISTRY_REF" refs/heads/master) || return 3
        marker_registry=$(awk -v r="$TASKDAG_EPIC_REGISTRY_REF" '$2==r{print $1}' <<<"$marker_rows"); marker_master=$(awk '$2=="refs/heads/master"{print $1}' <<<"$marker_rows")
        [ -n "$marker_registry" ] && [ -n "$marker_master" ] || return 3
        git fetch -q --no-tags origin "$marker_registry" "$marker_master" || return 3
        marker_binding=$(taskdag_epic_registry_provider_binding "$provider" "$repository_id" "$issue_id" "$marker_registry" "$marker_master") || return 3
        [ "$(jq -r .epicId <<<"$marker_binding")" = "$marker_epic" ] || return 3
        taskdag_epic_registry_record "$marker_epic" "$marker_registry" "$marker_master" >/dev/null || return 3
        jq -ncS --arg epicId "$marker_epic" --arg rootCommit "$(jq -r .rootCommit <<<"$(taskdag_epic_registry_record "$marker_epic" "$marker_registry" "$marker_master")")" --arg rootRef "$(jq -r .pendingRef <<<"$(taskdag_root_locator "$marker_epic")")" '{activeRef:null,claimCommit:null,created:false,epicId:$epicId,rootCommit:$rootCommit,rootRef:$rootRef,schema:1}'
        return 0
    fi
    [ "${TASKDAG_BIND_COMMAND:-false}" != true ] || { echo "epic-bind-projection: materialisation identity and --source-checkout are required" >&2; return 2; }
    local epic origin projection legacy=null descriptor spec host pid claim=null
    if [ -n "$operation_id" ]; then
        epic=$(taskdag_epic_id_for_operation "$origin_repository_id" "$operation_id") || { echo "epic-create: invalid operation identity" >&2; return 2; }
        origin=$(jq -ncS --arg id "$origin_repository_id" --arg op "$operation_id" '{kind:"operation",operationId:$op,repositoryId:$id}') || return 2
        if [ -n "$issue_number$issue_url" ]; then
            [ -n "$issue_id" ] && [ -n "$issue_number" ] && [ -n "$issue_url" ] || { echo "epic-create: a bound projection needs all issue fields" >&2; return 2; }
        fi
    else
        epic=$(taskdag_epic_id_for_provider "$provider" "$repository_id" "$issue_id") || { echo "epic-create: invalid provider identity" >&2; return 2; }
        origin=$(jq -ncS --arg p "$provider" --arg r "$repository_id" --arg i "$issue_id" '{issueId:$i,kind:"provider",provider:$p,repositoryId:$r}') || return 2
    fi
    # Semantic identity is authoritative over mutable event payload. Resolve
    # and strictly validate an existing record before authoring descriptor,
    # root, claim, or parent-dependent objects.
    local replay_rows replay_registry replay_master replay_record='' replay_root replay_locator replay_pending replay_active replay_claim replay_binding=''
    replay_rows=$(git ls-remote --refs origin "$TASKDAG_EPIC_REGISTRY_REF" refs/heads/master) || return 3
    replay_registry=$(awk -v r="$TASKDAG_EPIC_REGISTRY_REF" '$2==r{print $1}' <<<"$replay_rows")
    replay_master=$(awk '$2=="refs/heads/master"{print $1}' <<<"$replay_rows")
    if [ -n "$replay_registry" ]; then
        [ -n "$replay_master" ] || return 3
        git fetch -q --no-tags origin "$replay_registry" "$replay_master" || return 3
        if [ -n "$operation_id" ]; then
            replay_record=$(taskdag_epic_registry_record "$epic" "$replay_registry" "$replay_master" 2>/dev/null || true)
            [ -z "$replay_record" ] || jq -e --arg op "$operation_id" --arg oid "$origin_repository_id" --arg repo "$repository" --arg rid "$repository_id" \
              '.epicId==$epicId and .descriptor.origin=={kind:"operation",operationId:$op,repositoryId:$oid} and
               .descriptor.projection.provider=="github" and .descriptor.projection.repository==$repo and
               .descriptor.projection.repositoryId==$rid' --arg epicId "$epic" <<<"$replay_record" >/dev/null || return 3
        else
            replay_binding=$(taskdag_epic_registry_provider_binding "$provider" "$repository_id" "$issue_id" "$replay_registry" "$replay_master" 2>/dev/null || true)
            if [ -n "$replay_binding" ]; then
                epic=$(jq -r .epicId <<<"$replay_binding")
                replay_record=$(taskdag_epic_registry_record "$epic" "$replay_registry" "$replay_master") || return 3
                [ "$(jq -cS .descriptor.projection <<<"$replay_record")" = "$(jq -cS .projection <<<"$replay_binding")" ] || return 3
            fi
        fi
        if [ -n "$replay_record" ]; then
            replay_root=$(jq -r .rootCommit <<<"$replay_record"); replay_locator=$(taskdag_root_locator "$epic") || return 3
            replay_pending=$(jq -r .pendingRef <<<"$replay_locator"); replay_active=$(jq -r .activeRef <<<"$replay_locator")
            [ "$(git ls-remote --refs origin "$replay_pending" | awk 'NF==2{print $1}')" = "$replay_root" ] || return 3
            if $explicit_claim; then
                [ -n "$operation_id" ] || { echo "epic-create: --claim is reserved for operation ingress; use claim-root for a provider root" >&2; return 2; }
                cmd_claim_root "$epic" --json --note="$note" >/dev/null || return $?
            fi
            replay_claim=$(git ls-remote --refs origin "$replay_active" | awk 'NF==2{print $1}')
            jq -ncS --arg epicId "$epic" --arg rootCommit "$replay_root" --arg rootRef "$replay_pending" --arg activeRef "$replay_active" --arg claimCommit "$replay_claim" \
              '{activeRef:(if $claimCommit=="" then null else $activeRef end),claimCommit:(if $claimCommit=="" then null else $claimCommit end),created:false,epicId:$epicId,rootCommit:$rootCommit,rootRef:$rootRef,schema:1}'
            return 0
        fi
    fi
    projection=$(jq -ncS --arg p "$provider" --arg repo "$repository" --arg rid "$repository_id" --arg iid "$issue_id" --arg n "$issue_number" --arg url "$issue_url" \
      '{issueId:(if $iid=="" then null else $iid end),issueNumber:(if $n=="" then null else $n end),issueUrl:(if $url=="" then null else $url end),provider:$p,repository:$repo,repositoryId:$rid}') || return 2
    descriptor=$(jq -ncS --arg epic "$epic" --argjson origin "$origin" --argjson projection "$projection" --arg title "$title" --arg author "$author" --arg description "$description" \
      '{epicId:$epic,origin:$origin,projection:$projection,schema:1,task:{author:$author,description:$description,status:"pending",title:$title,type:"epic"}}') || return 2
    if [ -z "$parent" ]; then
        parent=$(git ls-remote --refs origin refs/heads/master | awk 'NR==1{print $1}') || return 3
        [ -n "$parent" ] || { echo "epic-create: origin/master is absent" >&2; return 3; }
        git cat-file -e "$parent^{commit}" 2>/dev/null || git fetch -q --no-tags origin "$parent" || return 3
    else parent=$(git rev-parse --verify "$parent^{commit}") || return 2; fi
    if $explicit_claim; then
        [ -n "$operation_id" ] || { echo "epic-create: --claim is reserved for operation ingress; use claim-root for a provider root" >&2; return 2; }
        [ -n "$claim_id" ] || claim_id="epic-create-${epic#epic-v1:}"
        host=${TASK_DAG_CLAIMER_HOST:-$(hostname -s 2>/dev/null || echo unknown)}; pid=${TASK_DAG_CLAIMER_PID:-$PPID}
        claim=$(jq -ncS --arg id "$claim_id" --arg claimer "$claimer" --arg host "$host" --arg pid "$pid" --arg ttl "$ttl" --arg note "$note" \
          '{claimId:$id,claimer:$claimer,host:$host,note:$note,pid:$pid,ttlHours:$ttl}') || return 2
    fi
    spec=$(jq -ncS --arg actor "$claimer" --arg ts "$timestamp" --arg parent "$parent" --argjson descriptor "$descriptor" --argjson legacy "$legacy" \
      --argjson claim "$claim" \
      '{actor:$actor,authoritativeTimestamp:$ts,claim:$claim,descriptor:$descriptor,legacyAdoption:$legacy,parentCommit:$parent,schema:1}') || return 2
    taskdag_internal_mint_epic_root "$spec"
}

cmd_epic_bind_projection() {
    case "${1:-}" in -h|--help) cmd_epic_create --help; return 0;; esac
    TASKDAG_BIND_COMMAND=true cmd_epic_create "$@"
}
