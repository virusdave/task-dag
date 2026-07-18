# shellcheck shell=bash
# Sole external-effect actuator for immutable materialisation intents.

_taskdag_materialise_fetch_authority() { # prints tip<TAB>activation-token<TAB>producer-record
    local token producer tip current_repo
    token=$(taskdag_activation_snapshot_token) || return 3
    producer=$(taskdag_materialise_producer_check "$token") || return $?
    tip=$(git ls-remote --refs origin "$TASKDAG_MATERIALISATION_REF" | awk 'NF==2{print $1}') || return 2
    [ -n "$tip" ] || return 3
    git fetch -q --no-tags origin "$TASKDAG_MATERIALISATION_REF" || return 2
    tip=$(git rev-parse FETCH_HEAD) || return 3
    current_repo=$(printf '%s' "$(_xrepo_current_repo)" | tr '[:upper:]' '[:lower:]') || return 3
    [ -z "$(taskdag_materialisation_online_tree_violations "$tip" "$(jq -r .authorityTip <<<"$token")" "$current_repo")" ] || return 3
    printf '%s\t%s\t%s\n' "$tip" "$(jq -cS . <<<"$token")" "$(jq -cS . <<<"$producer")"
}

_taskdag_materialise_latest_state() { # tip slot
    local tip=$1 slot=$2 path
    path=$(git ls-tree -r --name-only "$tip" "slots/$slot/states" | sort | tail -1)
    [ -n "$path" ] || return 3
    git show "$tip:$path"
}

# Append one immutable state. Return 0 only when this exact candidate won the
# origin CAS, 10 when another valid transition won, and 3 when readback is
# indeterminate. The caller may POST only after return 0.
_taskdag_materialise_append_state() { # old token slot record
    local old=$1 token=$2 slot=$3 record=$4 generation path tmp index tree commit updates remote rc current_repo
    generation=$(jq -r .generation <<<"$record")
    path="slots/$slot/states/$(printf '%016d' "$generation").json"
    git cat-file -e "$old:$path" 2>/dev/null && return 10
    tmp=$(mktemp -d) || return 3
    index="$tmp/index"; GIT_INDEX_FILE="$index" git read-tree "$old" || { rm -rf "$tmp"; return 3; }
    printf '%s\n' "$record" >"$tmp/record"
    GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "100644,$(git hash-object -w "$tmp/record"),$path" || { rm -rf "$tmp"; return 3; }
    tree=$(GIT_INDEX_FILE="$index" git write-tree) || { rm -rf "$tmp"; return 3; }
    commit=$(printf 'Advance materialisation slot %s to %s\n' "${slot:0:12}" "$(jq -r .state <<<"$record")" | git commit-tree "$tree" -p "$old") || { rm -rf "$tmp"; return 3; }
    current_repo=$(printf '%s' "$(_xrepo_current_repo)" | tr '[:upper:]' '[:lower:]') || { rm -rf "$tmp"; return 3; }
    [ -z "$(taskdag_materialisation_online_tree_violations "$commit" "$(jq -r .authorityTip <<<"$token")" "$current_repo")" ] || { rm -rf "$tmp"; return 3; }
    updates=$(jq -ncS --arg ref "$TASKDAG_MATERIALISATION_REF" --arg old "$old" --arg new "$commit" '[{ref:$ref,old:$old,new:$new}]') || { rm -rf "$tmp"; return 3; }
    taskdag_activation_fenced_multi_push "$token" materialisation reconcile "$(jq -r .actor <<<"$record")" "$(jq -r .authoritativeTimestamp <<<"$record")" "$updates" >/dev/null 2>&1 || :
    remote=$(git ls-remote --refs origin "$TASKDAG_MATERIALISATION_REF" | awk 'NF==2{print $1}') || { rm -rf "$tmp"; return 3; }
    [ -n "$remote" ] || { rm -rf "$tmp"; return 3; }
    git fetch -q --no-tags origin "$TASKDAG_MATERIALISATION_REF" || { rm -rf "$tmp"; return 3; }
    remote=$(git rev-parse FETCH_HEAD) || { rm -rf "$tmp"; return 3; }
    if [ "$remote" = "$commit" ]; then rc=0
    elif git cat-file -e "$remote:$path" 2>/dev/null; then rc=10
    else rc=3
    fi
    rm -rf "$tmp"; return "$rc"
}

_taskdag_materialise_b64url() { base64 -w0 | tr '+/' '-_' | tr -d '='; }

_taskdag_materialise_peer_token() { # owner/repository
    local peer=$1 owner=${peer%%/*} repo=${peer#*/} key now header payload signature jwt response code body install
    [ -n "${TASKDAG_APP_ID:-}" ] && [ -n "${TASKDAG_APP_PRIVATE_KEY:-}" ] || {
        echo "Error: TASKDAG_APP_ID and TASKDAG_APP_PRIVATE_KEY are required by materialise-reconcile" >&2
        return 1
    }
    key=$(mktemp) || return 1; chmod 600 "$key"; printf '%s\n' "$TASKDAG_APP_PRIVATE_KEY" >"$key"
    now=$(date +%s); header=$(printf '{"alg":"RS256","typ":"JWT"}' | _taskdag_materialise_b64url)
    payload=$(jq -jcn --argjson iat "$((now-30))" --argjson exp "$((now+540))" --arg iss "$TASKDAG_APP_ID" '{iat:$iat,exp:$exp,iss:$iss}' | _taskdag_materialise_b64url)
    signature=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$key" -binary | _taskdag_materialise_b64url) || { rm -f "$key"; return 1; }
    rm -f "$key"; jwt="$header.$payload.$signature"
    response=$(curl -sS -w '\n%{http_code}' -H "Authorization: Bearer $jwt" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$owner/$repo/installation") || return 1
    code=$(tail -n1 <<<"$response"); body=$(sed '$d' <<<"$response"); [ "$code" = 200 ] || return 1; install=$(jq -r '.id // empty' <<<"$body"); [ -n "$install" ] || return 1
    response=$(curl -sS -w '\n%{http_code}' -X POST -H "Authorization: Bearer $jwt" -H 'Accept: application/vnd.github+json' "https://api.github.com/app/installations/$install/access_tokens" -d "$(jq -nc --arg repo "$repo" '{repositories:[$repo],permissions:{issues:"write",metadata:"read"}}')") || return 1
    code=$(tail -n1 <<<"$response"); body=$(sed '$d' <<<"$response"); [ "$code" = 201 ] || return 1
    jq -r '.token // empty' <<<"$body"
}

taskdag_materialise_provider_list() { # repository
    local token pages probe repository_id observed_at query
    token=$(_taskdag_materialise_peer_token "$1") || return 1
    query="repos/$1/issues?state=all&per_page=100"
    probe=$(GH_TOKEN="$token" gh api -i "repos/$1") || return 1
    repository_id=$(sed -n '/^{/,$p' <<<"$probe" | jq -r .node_id) || return 1
    observed_at=$(date -u -d "$(sed -n 's/^[Dd]ate: //p' <<<"$probe" | tr -d '\r' | tail -1)" +%Y-%m-%dT%H:%M:%SZ) || return 1
    pages=$(GH_TOKEN="$token" gh api --paginate --slurp "$query") || return 1
    jq -nc --arg repositoryId "$repository_id" --arg observedAt "$observed_at" --arg paginationQuery "$query" --argjson pages "$pages" \
      '{repositoryId:$repositoryId,observedAt:$observedAt,paginationQuery:$paginationQuery,pagesFetched:($pages|length),issues:($pages|add)}'
}

taskdag_materialise_provider_probe() { # repository; repositoryId<TAB>provider-time
    local token response repository_id observed_at
    token=$(_taskdag_materialise_peer_token "$1") || return 1
    response=$(GH_TOKEN="$token" gh api -i "repos/$1") || return 1
    repository_id=$(sed -n '/^{/,$p' <<<"$response" | jq -r .node_id) || return 1
    observed_at=$(date -u -d "$(sed -n 's/^[Dd]ate: //p' <<<"$response" | tr -d '\r' | tail -1)" +%Y-%m-%dT%H:%M:%SZ) || return 1
    [ -n "$repository_id" ] && [ -n "$observed_at" ] || return 1
    printf '%s\t%s\n' "$repository_id" "$observed_at"
}

taskdag_materialise_provider_create() { # repository title body-file
    local repo=$1 title=$2 body_file=$3 payload token
    token=$(_taskdag_materialise_peer_token "$repo") || return 1
    payload=$(mktemp) || return 1
    jq -n --arg title "$title" --rawfile body "$body_file" '{title:$title,body:$body}' >"$payload" || { rm -f "$payload"; return 1; }
    GH_TOKEN="$token" gh api -X POST "repos/$repo/issues" --input "$payload"
    local rc=$?; rm -f "$payload"; return "$rc"
}

_taskdag_materialise_visible_body() { # authority declaration output-file
    local tip=$1 declaration=$2 output=$3 body_sha operation digest
    body_sha=$(jq -r .bodySha256 <<<"$declaration"); operation=$(jq -r .operationId <<<"$declaration"); digest=$(jq -r .declarationDigest <<<"$declaration")
    git show "$tip:bodies/$body_sha.body" >"$output" || return 1
    printf '\n\n<!-- task-dag-materialisation:v1 operation=%s declaration=%s -->\n' "$operation" "$digest" >>"$output"
}

_taskdag_materialise_exact_matches() { # issues-json declaration expected-body transition-time creator output
    local issues=$1 declaration=$2 body=$3 transition_time=$4 creator=$5 output=$6 candidate tmp
    : >"$output"
    tmp=$(mktemp) || return 1
    jq -c --arg title "$(jq -r .title <<<"$declaration")" --arg creator "$creator" --arg since "$transition_time" \
      '.[]|select(.title==$title and .user.node_id==$creator and .created_at >= $since and (.node_id|type=="string") and (.number|type=="number"))' <<<"$issues" |
    while IFS= read -r candidate; do
        jq -rj '.body // ""' <<<"$candidate" >"$tmp" || { rm -f "$tmp"; return 1; }
        if cmp -s "$tmp" "$body"; then printf '%s\n' "$candidate" >>"$output"; fi
    done
    rm -f "$tmp"
    return 0
}

_taskdag_materialise_recover() { # tip token producer slot uncertain declaration body
    local tip=$1 token=$2 producer=$3 slot=$4 state=$5 declaration=$6 body=$7 issues matches count issue now prior_digest record rc
    issues=$(taskdag_materialise_provider_list "$(jq -r .peerRepo.name <<<"$declaration")") || { echo "Error: provider pagination failed for materialisation slot $slot" >&2; return 3; }
    jq -e 'type=="object" and keys==["issues","observedAt","pagesFetched","paginationQuery","repositoryId"] and (.issues|type=="array") and (.pagesFetched|type=="number" and .>=1)' >/dev/null <<<"$issues" || return 3
    [ "$(jq -r .repositoryId <<<"$issues")" = "$(jq -r .peerRepo.id <<<"$declaration")" ] || { echo "Error: provider repository identity changed for materialisation slot $slot" >&2; return 3; }
    matches=$(mktemp) || return 3
    _taskdag_materialise_exact_matches "$(jq -c .issues <<<"$issues")" "$declaration" "$body" "$(jq -r .provider.timeFloor <<<"$state")" "$(jq -r .appCreatorNodeId <<<"$producer")" "$matches" || { rm -f "$matches"; return 3; }
    count=$(wc -l <"$matches")
    if [ "$count" -eq 0 ]; then rm -f "$matches"; echo "Materialisation slot $slot remains create-in-flight-or-uncertain; no exact provider match." >&2; return 75; fi
    if [ "$count" -ne 1 ]; then rm -f "$matches"; echo "Error: materialisation slot $slot has $count exact provider matches; operator repair required." >&2; return 3; fi
    issue=$(cat "$matches"); rm -f "$matches"; now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    prior_digest=$(printf '%s\n' "$state" | sha256sum | awk '{print $1}')
    record=$(jq -ncS --argjson prior "$state" --argjson issue "$issue" --argjson provider "$issues" --arg actor "${TASK_DAG_CLAIMER:-materialisation-reconciler}" --arg now "$now" --arg tip "$tip" --arg authorityTip "$(jq -r .authorityTip <<<"$token")" --arg priorDigest "$prior_digest" --arg creator "$(jq -r .appCreatorNodeId <<<"$producer")" --arg bodySha256 "$(sha256sum "$body" | awk '{print $1}')" --arg title "$(jq -r .title <<<"$declaration")" '{schema:1,state:"issue-adopted",slotId:$prior.slotId,declarationDigest:$prior.declarationDigest,operationId:$prior.operationId,generation:($prior.generation+1),fence:($prior.generation+2),activation:$prior.activation,actor:$actor,authoritativeTimestamp:$now,predecessorStateDigest:$priorDigest,originReadback:{activationAuthorityTip:$authorityTip,materialisationTip:$tip},createAttemptId:$prior.createAttemptId,adoptedIssue:{repositoryId:$provider.repositoryId,issueNodeId:$issue.node_id,number:$issue.number},providerReceipt:{repositoryId:$provider.repositoryId,creatorNodeId:$creator,observedAt:$provider.observedAt,paginationQuery:$provider.paginationQuery,pagesFetched:$provider.pagesFetched,exhausted:true,matchCount:1,matchedIdentity:{issueNodeId:$issue.node_id,number:$issue.number,createdAt:$issue.created_at,title:$title,bodySha256:$bodySha256,operationId:$prior.operationId,declarationDigest:$prior.declarationDigest}}}') || return 3
    _taskdag_materialise_append_state "$tip" "$token" "$slot" "$record"; rc=$?
    [ "$rc" -eq 0 ] || [ "$rc" -eq 10 ]
}

_taskdag_materialise_finalize() { # tip token slot adopted declaration
    local tip=$1 token=$2 slot=$3 adopted=$4 declaration=$5 marker marker_ref marker_commit parent peer issue note args root delegation from to edge now prior_digest pending final rc activation
    activation=$(jq -c '{epoch,digest,guardVersion}' <<<"$token") || return 3
    if [ "$(jq -r .state <<<"$adopted")" = issue-adopted ]; then
        marker=$(taskdag_materialise_operation_marker_write "$declaration" "$(jq -c .adoptedIssue <<<"$adopted")") || return 3
        IFS=$'\t' read -r marker_ref marker_commit <<<"$marker"
        now=$(date -u +%Y-%m-%dT%H:%M:%SZ); prior_digest=$(printf '%s\n' "$adopted" | sha256sum | awk '{print $1}')
        pending=$(jq -ncS --argjson prior "$adopted" --argjson activation "$activation" --arg actor "${TASK_DAG_CLAIMER:-materialisation-reconciler}" --arg now "$now" --arg tip "$tip" --arg authorityTip "$(jq -r .authorityTip <<<"$token")" --arg priorDigest "$prior_digest" --arg markerRef "$marker_ref" --arg markerCommit "$marker_commit" '{schema:1,state:"marker-durable-delegation-pending",slotId:$prior.slotId,declarationDigest:$prior.declarationDigest,operationId:$prior.operationId,generation:($prior.generation+1),fence:($prior.generation+2),activation:$activation,actor:$actor,authoritativeTimestamp:$now,predecessorStateDigest:$priorDigest,originReadback:{activationAuthorityTip:$authorityTip,materialisationTip:$tip},adoptedIssue:$prior.adoptedIssue,markerRef:$markerRef,markerCommit:$markerCommit}') || return 3
        _taskdag_materialise_append_state "$tip" "$token" "$slot" "$pending"; rc=$?
        [ "$rc" -eq 0 ] || { [ "$rc" -eq 10 ] && return 10; return 3; }
        tip=$(git ls-remote --refs origin "$TASKDAG_MATERIALISATION_REF" | awk 'NF==2{print $1}'); git fetch -q --no-tags origin "$TASKDAG_MATERIALISATION_REF" || return 3; tip=$(git rev-parse FETCH_HEAD)
        adopted=$(_taskdag_materialise_latest_state "$tip" "$slot") || return 3
    fi
    parent=$(jq -r .parentIssue.number <<<"$declaration"); peer=$(jq -r .peerRepo.name <<<"$declaration"); issue=$(jq -r .adoptedIssue.number <<<"$adopted"); note=$(jq -r '.delegationNote // ""' <<<"$declaration")
    args=(--issue "$parent" --to "$peer#$issue"); [ -z "$note" ] || args+=(--note "$note")
    _taskdag_materialise_delegate_projection "${args[@]}" || return 3
    root=$(git rev-parse "refs/heads/tasks/pending/$parent") || return 3
    delegation="refs/heads/tasks/delegated/$parent/$peer/$issue"
    taskdag_materialise_delegation_valid "$delegation" "$root" "$peer" "$issue" "$note" || return 3
    taskdag_sync_graph_ref || return 3
    from="task:$(_xrepo_current_repo)@$root"; to="issue:$peer#$issue"; edge=$(taskdag_edge_id "$from" "$to" requires all) || return 3
    taskdag_materialise_edge_durable "$edge" || return 3
    marker=$(taskdag_materialise_operation_marker_write "$declaration" "$(jq -c .adoptedIssue <<<"$adopted")") || return 3
    [ "$marker" = "$(jq -r .markerRef <<<"$adopted")"$'\t'"$(jq -r .markerCommit <<<"$adopted")" ] || return 3
    adopted=$(_taskdag_materialise_latest_state "$tip" "$slot") || return 3
    [ "$(jq -r .state <<<"$adopted")" = marker-durable-delegation-pending ] || return 10
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ); prior_digest=$(printf '%s\n' "$adopted" | sha256sum | awk '{print $1}')
    final=$(jq -ncS --argjson prior "$adopted" --arg actor "${TASK_DAG_CLAIMER:-materialisation-reconciler}" --arg now "$now" --arg tip "$tip" --arg authorityTip "$(jq -r .authorityTip <<<"$token")" --arg priorDigest "$prior_digest" --arg delegationRef "$delegation" --arg edgeId "$edge" '{schema:1,state:"final",slotId:$prior.slotId,declarationDigest:$prior.declarationDigest,operationId:$prior.operationId,generation:($prior.generation+1),fence:($prior.generation+2),activation:$prior.activation,actor:$actor,authoritativeTimestamp:$now,predecessorStateDigest:$priorDigest,originReadback:{activationAuthorityTip:$authorityTip,materialisationTip:$tip},adoptedIssue:$prior.adoptedIssue,markerRef:$prior.markerRef,markerCommit:$prior.markerCommit,delegationRef:$delegationRef,edgeId:$edgeId}') || return 3
    _taskdag_materialise_append_state "$tip" "$token" "$slot" "$final"; rc=$?
    [ "$rc" -eq 0 ] || [ "$rc" -eq 10 ]
}

_taskdag_materialise_reconcile_slot() { # slot
    local slot=$1 authority tip token producer state declaration body tmp attempt prior_digest record rc probe provider_id provider_time generation authorization authorization_digest
    authority=$(_taskdag_materialise_fetch_authority) || return $?
    IFS=$'\t' read -r tip token producer <<<"$authority"
    state=$(_taskdag_materialise_latest_state "$tip" "$slot") || return 3
    declaration=$(git show "$tip:declarations/$(jq -r .declarationDigest <<<"$state").json") || return 3
    tmp=$(mktemp -d) || return 3; body="$tmp/body"
    _taskdag_materialise_visible_body "$tip" "$declaration" "$body" || { rm -rf "$tmp"; return 3; }
    case "$(jq -r .state <<<"$state")" in
      final) rm -rf "$tmp"; return 0 ;;
      batch-reserved-before-create)
        probe=$(taskdag_materialise_provider_probe "$(jq -r .peerRepo.name <<<"$declaration")") || { rm -rf "$tmp"; return 3; }
        IFS=$'\t' read -r provider_id provider_time <<<"$probe"
        [ "$provider_id" = "$(jq -r .peerRepo.id <<<"$declaration")" ] || { rm -rf "$tmp"; return 3; }
        attempt=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n') || { rm -rf "$tmp"; return 3; }
        prior_digest=$(printf '%s\n' "$state" | sha256sum | awk '{print $1}')
        record=$(jq -ncS --argjson prior "$state" --arg actor "${TASK_DAG_CLAIMER:-materialisation-reconciler}" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg tip "$tip" --arg authorityTip "$(jq -r .authorityTip <<<"$token")" --arg priorDigest "$prior_digest" --arg attempt "$attempt" --arg producerDigest "$(printf '%s\n' "$producer" | sha256sum | awk '{print $1}')" --arg repository "$(jq -r .peerRepo.name <<<"$declaration")" --arg repositoryId "$provider_id" --arg timeFloor "$provider_time" '{schema:1,state:"create-in-flight-or-uncertain",slotId:$prior.slotId,declarationDigest:$prior.declarationDigest,operationId:$prior.operationId,generation:($prior.generation+1),fence:($prior.generation+2),activation:$prior.activation,actor:$actor,authoritativeTimestamp:$now,predecessorStateDigest:$priorDigest,originReadback:{activationAuthorityTip:$authorityTip,materialisationTip:$tip},createAttemptId:$attempt,producerRecordDigest:$producerDigest,provider:{repository:$repository,repositoryId:$repositoryId,timeFloor:$timeFloor}}') || { rm -rf "$tmp"; return 3; }
        _taskdag_materialise_append_state "$tip" "$token" "$slot" "$record"; rc=$?
        if [ "$rc" -eq 0 ]; then
            taskdag_materialise_provider_create "$(jq -r .peerRepo.name <<<"$declaration")" "$(jq -r .title <<<"$declaration")" "$body" >/dev/null 2>&1 || :
        elif [ "$rc" -ne 10 ]; then rm -rf "$tmp"; return 3
        fi
        authority=$(_taskdag_materialise_fetch_authority) || { rm -rf "$tmp"; return $?; }; IFS=$'\t' read -r tip token producer <<<"$authority"; state=$(_taskdag_materialise_latest_state "$tip" "$slot") || { rm -rf "$tmp"; return 3; }
        ;;&
      create-in-flight-or-uncertain)
        if [ "$(jq -r .state <<<"$state")" = create-in-flight-or-uncertain ]; then
            generation=$(( $(jq -r .generation <<<"$state") + 1 ))
            authorization="slots/$slot/authorizations/$(printf '%016d' "$generation").json"
            if git cat-file -e "$tip:$authorization" 2>/dev/null; then
                authorization_digest=$(git show "$tip:$authorization" | jq -r .authorizationDigest) || { rm -rf "$tmp"; return 3; }
                probe=$(taskdag_materialise_provider_probe "$(jq -r .peerRepo.name <<<"$declaration")") || { rm -rf "$tmp"; return 3; }
                IFS=$'\t' read -r provider_id provider_time <<<"$probe"
                [ "$provider_id" = "$(jq -r .peerRepo.id <<<"$declaration")" ] || { rm -rf "$tmp"; return 3; }
                attempt=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n') || { rm -rf "$tmp"; return 3; }
                prior_digest=$(printf '%s\n' "$state" | sha256sum | awk '{print $1}')
                record=$(jq -ncS --argjson prior "$state" --argjson activation "$(jq -c '{epoch,digest,guardVersion}' <<<"$token")" --arg actor "${TASK_DAG_CLAIMER:-materialisation-reconciler}" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg tip "$tip" --arg authorityTip "$(jq -r .authorityTip <<<"$token")" --arg priorDigest "$prior_digest" --arg attempt "$attempt" --arg producerDigest "$(printf '%s\n' "$producer" | sha256sum | awk '{print $1}')" --arg repository "$(jq -r .peerRepo.name <<<"$declaration")" --arg repositoryId "$provider_id" --arg timeFloor "$provider_time" --arg authorizationDigest "$authorization_digest" '{schema:1,state:"create-in-flight-or-uncertain",slotId:$prior.slotId,declarationDigest:$prior.declarationDigest,operationId:$prior.operationId,generation:($prior.generation+1),fence:($prior.generation+2),activation:$activation,actor:$actor,authoritativeTimestamp:$now,predecessorStateDigest:$priorDigest,originReadback:{activationAuthorityTip:$authorityTip,materialisationTip:$tip},createAttemptId:$attempt,producerRecordDigest:$producerDigest,provider:{repository:$repository,repositoryId:$repositoryId,timeFloor:$timeFloor},rearmAuthorizationDigest:$authorizationDigest}') || { rm -rf "$tmp"; return 3; }
                _taskdag_materialise_append_state "$tip" "$token" "$slot" "$record"; rc=$?
                if [ "$rc" -eq 0 ]; then
                    taskdag_materialise_provider_create "$(jq -r .peerRepo.name <<<"$declaration")" "$(jq -r .title <<<"$declaration")" "$body" >/dev/null 2>&1 || :
                elif [ "$rc" -ne 10 ]; then rm -rf "$tmp"; return 3
                fi
                authority=$(_taskdag_materialise_fetch_authority) || { rm -rf "$tmp"; return $?; }; IFS=$'\t' read -r tip token producer <<<"$authority"; state=$(_taskdag_materialise_latest_state "$tip" "$slot") || { rm -rf "$tmp"; return 3; }
            elif ! jq -e 'has("createAttemptId") and has("producerRecordDigest") and (.provider|has("timeFloor"))' >/dev/null <<<"$state"; then
                echo "Error: imported uncertain slot $slot requires explicit operator adoption or rearm." >&2
                rm -rf "$tmp"
                return 3
            fi
            [ "$(jq -r .producerRecordDigest <<<"$state")" = "$(printf '%s\n' "$producer" | sha256sum | awk '{print $1}')" ] \
              || { rm -rf "$tmp"; return 3; }
            _taskdag_materialise_recover "$tip" "$token" "$producer" "$slot" "$state" "$declaration" "$body"; rc=$?
            [ "$rc" -eq 0 ] || { rm -rf "$tmp"; return "$rc"; }
            authority=$(_taskdag_materialise_fetch_authority) || { rm -rf "$tmp"; return $?; }; IFS=$'\t' read -r tip token producer <<<"$authority"; state=$(_taskdag_materialise_latest_state "$tip" "$slot") || { rm -rf "$tmp"; return 3; }
        fi
        ;;&
      issue-adopted)
        if [ "$(jq -r .state <<<"$state")" = issue-adopted ]; then _taskdag_materialise_finalize "$tip" "$token" "$slot" "$state" "$declaration"; rc=$?; rm -rf "$tmp"; return "$rc"; fi
        ;;
      marker-durable-delegation-pending) _taskdag_materialise_finalize "$tip" "$token" "$slot" "$state" "$declaration"; rc=$?; rm -rf "$tmp"; return "$rc" ;;
      *) echo "Error: materialisation slot $slot is not automatically reconcilable from state $(jq -r .state <<<"$state")" >&2; rm -rf "$tmp"; return 3 ;;
    esac
    rm -rf "$tmp"
}

cmd_materialise_reconcile() {
    local slot="" authority tip token producer path rc=0 one_rc
    while [ $# -gt 0 ]; do case "$1" in --slot) [ $# -ge 2 ] || return 2; slot=$2; shift 2;; --slot=*) slot=${1#*=}; shift;; -h|--help) echo 'Usage: task-dag materialise-reconcile [--slot ID]'; return 0;; *) return 2;; esac; done
    [ -z "$slot" ] || [[ "$slot" =~ ^[0-9a-f]{64}$ ]] || return 2
    if [ -n "$slot" ]; then _taskdag_materialise_reconcile_slot "$slot"; return $?; fi
    authority=$(_taskdag_materialise_fetch_authority) || return $?
    IFS=$'\t' read -r tip token producer <<<"$authority"
    while IFS= read -r path; do
        slot=${path#slots/}; slot=${slot%%/*}
        if _taskdag_materialise_reconcile_slot "$slot"; then :; else
            one_rc=$?
            if [ "$one_rc" -eq 75 ] && [ "$rc" -ne 3 ]; then rc=75
            else rc=3
            fi
        fi
    done < <(git ls-tree -r --name-only "$tip" | grep -E '^slots/[0-9a-f]{64}/states/0000000000000000\.json$' | sort)
    return "$rc"
}
