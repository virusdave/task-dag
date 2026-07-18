# shellcheck shell=bash
# Shared Materialise-Child-Epic intent parser and close barrier.
#
# A trailer is a durable declaration of a future dependency.  The GitHub
# workflow creates its marker, delegated ref, and requires edge asynchronously,
# so absence of the edge is not evidence that the parent has no obligation.
# Every close producer calls taskdag_materialisation_intents_durable before it
# emits Closes-Epic; the predicate fails closed until all three projections are
# present on origin.

taskdag_extract_materialise_trailers_from_message() {
    local line key val key_lc in_group=0
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"
        [[ "$line" =~ ^[A-Za-z0-9-]+: ]] || continue
        key="${line%%:*}"
        val="${line#*:}"
        val="${val#"${val%%[![:space:]]*}"}"
        key_lc="$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')"
        case "$key_lc" in
            materialise-child-epic|materialize-child-epic)
                in_group=1
                printf '%s: %s\n' "$key" "$val"
                ;;
            child-epic-title|child-epic-body-file|parent-issue|child-epic-slug|delegation-note)
                [ "$in_group" = 1 ] && printf '%s: %s\n' "$key" "$val"
                ;;
        esac
    done
    return 0
}

# Compatibility name used by the materialisation workflow and its tests.
extract_materialise_trailers_from_message() {
    taskdag_extract_materialise_trailers_from_message
}

# Normalize the shared Parent-Issue grammar. Both materialisation and closure
# use this exact helper so a value can never be rejected by one while silently
# ignored by the other. Optional '#', surrounding whitespace, and leading
# zeroes are accepted; zero/non-decimal values are rejected.
taskdag_materialise_parent_number() {
    local value="$1" normalized
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    value="${value#\#}"
    [[ "$value" =~ ^[0-9]+$ ]] || return 1
    normalized=$(printf '%s' "$value" | sed 's/^0*//')
    [ -n "$normalized" ] || return 1
    printf '%s\n' "$normalized"
}

# Read a complete commit message on stdin and emit a compact JSON array of
# materialisation groups. Duplicate fields retain the workflow's existing
# last-wins behavior. Values are encoded by jq, never by shell interpolation.
taskdag_materialise_groups_json_from_message() {
    local trailers line key val key_lc open=false
    local peer="" title="" body_file="" parent="" slug="" note="" slug_present=false note_present=false
    local -a groups=()
    trailers=$(taskdag_extract_materialise_trailers_from_message) || return 1

    _taskdag_mi_flush_group() {
        [ "$open" = true ] || return 0
        groups+=("$(jq -nc \
            --arg peer "$peer" --arg title "$title" --arg bodyFile "$body_file" \
            --arg parent "$parent" --arg slug "$slug" --arg note "$note" \
            --argjson slugPresent "$slug_present" --argjson notePresent "$note_present" \
            '{peer:$peer,title:$title,bodyFile:$bodyFile,parent:$parent,slug:$slug,note:$note,slugPresent:$slugPresent,notePresent:$notePresent}')")
    }

    while IFS= read -r line; do
        [ -n "$line" ] || continue
        key="${line%%:*}"
        val="${line#*:}"
        val="${val#"${val%%[![:space:]]*}"}"
        key_lc="$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')"
        case "$key_lc" in
            materialise-child-epic|materialize-child-epic)
                _taskdag_mi_flush_group || return 1
                open=true peer="$val" title="" body_file="" parent="" slug="" note="" slug_present=false note_present=false
                ;;
            child-epic-title) title="$val" ;;
            child-epic-body-file) body_file="$val" ;;
            parent-issue) parent="$val" ;;
            child-epic-slug) slug="$val"; slug_present=true ;;
            delegation-note) note="$val"; note_present=true ;;
        esac
    done <<< "$trailers"
    _taskdag_mi_flush_group || return 1
    unset -f _taskdag_mi_flush_group

    if [ "${#groups[@]}" -eq 0 ]; then
        printf '[]\n'
    else
        printf '%s\n' "${groups[@]}" | jq -sc .
    fi
}

taskdag_materialise_marker_ref() {
    local issue="$1" peer="$2" slug="$3" owner="${peer%%/*}" repo="${peer#*/}"
    if [ -n "$slug" ]; then
        printf 'refs/heads/gh/child-epic-slots/%s/%s/%s/%s\n' "$issue" "$owner" "$repo" "$slug"
    else
        printf 'refs/heads/gh/child-epics/%s/%s/%s\n' "$issue" "$owner" "$repo"
    fi
}

taskdag_materialise_operation_marker_ref() { printf 'refs/heads/gh/materialisation-markers/%s\n' "$1"; }

_taskdag_materialise_operation_marker_record() { # declaration adopted-issue
    local declaration=$1 adopted=$2
    jq -ncS --argjson declaration "$declaration" --argjson adopted "$adopted" '{schema:1,operationId:$declaration.operationId,declarationDigest:$declaration.declarationDigest,sourceRepo:$declaration.sourceRepo,parentIssue:$declaration.parentIssue,peerRepo:$declaration.peerRepo,peerIssue:$adopted,delegationNote:(if ($declaration|has("delegationNote")) then {present:true,value:$declaration.delegationNote} else {present:false} end)}'
}

taskdag_materialise_operation_marker_validate() { # commit declaration adopted-issue
    local commit=$1 declaration=$2 adopted=$3 msg encoded actual expected empty
    [ "$(git rev-list --parents -1 "$commit" 2>/dev/null | wc -w)" -eq 1 ] || return 1
    empty=$(git mktree </dev/null) || return 1
    [ "$(git rev-parse "$commit^{tree}" 2>/dev/null)" = "$empty" ] || return 1
    msg=$(git log -1 --format=%B "$commit") || return 1
    [ "$(grep -c '^kind: gh-materialisation-marker-v1$' <<<"$msg")" -eq 1 ] || return 1
    [ "$(grep -c '^Materialisation-Record: ' <<<"$msg")" -eq 1 ] || return 1
    encoded=$(sed -n 's/^Materialisation-Record: //p' <<<"$msg")
    actual=$(printf '%s' "$encoded" | base64 -d 2>/dev/null) || return 1
    expected=$(_taskdag_materialise_operation_marker_record "$declaration" "$adopted") || return 1
    [ "$actual" = "$expected" ]
}

taskdag_materialise_operation_marker_write() { # declaration adopted-issue; prints ref<TAB>commit
    local declaration=$1 adopted=$2 operation ref record encoded empty commit remote rc=0 tmp
    operation=$(jq -r .operationId <<<"$declaration"); ref=$(taskdag_materialise_operation_marker_ref "$operation")
    remote=$(git ls-remote --exit-code origin "$ref" 2>/dev/null) || rc=$?
    if [ "$rc" -eq 2 ]; then
        record=$(_taskdag_materialise_operation_marker_record "$declaration" "$adopted") || return 3
        encoded=$(printf '%s' "$record" | base64 -w0) || return 3
        empty=$(git mktree </dev/null) || return 3
        commit=$(printf 'kind: gh-materialisation-marker-v1\nMaterialisation-Record: %s\n' "$encoded" | git commit-tree "$empty") || return 3
        git push origin "$commit:$ref" >/dev/null 2>&1 || :
    elif [ "$rc" -eq 0 ]; then commit=${remote%%[[:space:]]*}
    else return 3
    fi
    remote=$(git ls-remote --refs origin "$ref" | awk 'NF==2{print $1}') || return 3
    [ -n "$remote" ] || return 3
    tmp="refs/task-dag-tmp/materialisation-marker/$remote"; git update-ref -d "$tmp" 2>/dev/null || true
    git fetch -q --no-tags origin "+$ref:$tmp" || return 3
    taskdag_materialise_operation_marker_validate "$tmp" "$declaration" "$adopted" || { git update-ref -d "$tmp" 2>/dev/null || true; return 3; }
    git update-ref -d "$tmp" 2>/dev/null || true
    printf '%s\t%s\n' "$ref" "$remote"
}

taskdag_validate_materialise_marker_commit() {
    local commit="$1" issue="$2" peer="$3" slug="$4" msg peer_issue
    local marker_kind marker_parent marker_peer marker_slug marker_tree empty_tree
    local kind_count parent_count peer_repo_count peer_issue_count slug_count parent_total
    msg=$(git log -1 --format='%B' "$commit" 2>/dev/null || true)
    marker_tree=$(git rev-parse "${commit}^{tree}" 2>/dev/null || true)
    empty_tree=$(git mktree </dev/null) || return 1
    [ "$marker_tree" = "$empty_tree" ] || return 1
    parent_total=$(git rev-list --parents -1 "$commit" 2>/dev/null | awk '{print NF-1}')
    [ "$parent_total" -eq 0 ] || return 1
    marker_kind=$(printf '%s\n' "$msg" | sed -nE 's/^kind:[[:space:]]*(.*)$/\1/p' | head -1)
    marker_parent=$(printf '%s\n' "$msg" | sed -nE 's/^parent_issue:[[:space:]]*([0-9]+)[[:space:]]*$/\1/p' | head -1)
    marker_slug=$(printf '%s\n' "$msg" | sed -nE 's/^slug:[[:space:]]*([^[:space:]]+)[[:space:]]*$/\1/p' | head -1)
    kind_count=$(printf '%s\n' "$msg" | grep -c '^kind:' || true)
    parent_count=$(printf '%s\n' "$msg" | grep -c '^parent_issue:' || true)
    slug_count=$(printf '%s\n' "$msg" | grep -c '^slug:' || true)
    marker_peer=$(printf '%s\n' "$msg" | awk '
        /^peer:$/ { inside=1; next }
        inside && /^  repo:[[:space:]]*/ { sub(/^  repo:[[:space:]]*/, ""); print }
        inside && !/^  / { inside=0 }
    ' | head -1)
    peer_issue=$(printf '%s\n' "$msg" | awk '
        /^peer:$/ { inside=1; next }
        inside && /^  issue:[[:space:]]*/ { sub(/^  issue:[[:space:]]*/, ""); print }
        inside && !/^  / { inside=0 }
    ' | head -1)
    peer_repo_count=$(printf '%s\n' "$msg" | awk '/^peer:$/ { inside=1; next } inside && /^  repo:/ { n++ } inside && !/^  / { inside=0 } END { print n+0 }')
    peer_issue_count=$(printf '%s\n' "$msg" | awk '/^peer:$/ { inside=1; next } inside && /^  issue:/ { n++ } inside && !/^  / { inside=0 } END { print n+0 }')
    [ "$marker_kind" = gh-child-epic-marker ] \
        && [ "$kind_count" -eq 1 ] \
        && [ "$marker_parent" = "$issue" ] \
        && [ "$parent_count" -eq 1 ] \
        && [ "$marker_peer" = "$peer" ] \
        && [ "$peer_repo_count" -eq 1 ] \
        && [ "$peer_issue_count" -eq 1 ] \
        && [ "$marker_slug" = "$slug" ] \
        && { [ -n "$slug" ] && [ "$slug_count" -eq 1 ] || [ -z "$slug" ] && [ "$slug_count" -eq 0 ]; } \
        && [[ "$peer_issue" =~ ^[1-9][0-9]*$ ]] || return 1
    printf '%s\n' "$peer_issue"
}

# Print the peer issue recorded by a marker ref. Origin is authoritative;
# malformed/missing/indeterminate markers all fail closed.
taskdag_materialise_marker_issue() {
    local ref="$1" issue="$2" peer="$3" slug="$4" remote_sha="" rc=0 tmp peer_issue
    remote_sha=$(remote_ref_sha_checked "$ref") || rc=$?
    [ "$rc" -eq 0 ] && [ -n "$remote_sha" ] || return 1
    tmp="refs/task-dag-tmp/materialise-marker/${remote_sha}"
    git update-ref -d "$tmp" 2>/dev/null || true
    git fetch --quiet --no-tags origin "+${ref}:${tmp}" 2>/dev/null || return 1
    peer_issue=$(taskdag_validate_materialise_marker_commit "$tmp" "$issue" "$peer" "$slug" || true)
    git update-ref -d "$tmp" 2>/dev/null || true
    [ -n "$peer_issue" ] || return 1
    printf '%s\n' "$peer_issue"
}

taskdag_materialise_delegation_valid() {
    local ref="$1" root_sha="$2" peer="$3" peer_issue="$4" expected_note="${5-}" enforce_note=false
    local remote_sha="" rc=0 tmp msg tree empty_tree parent delegated_peer delegated_issue delegated_note
    local parent_total kind_count repo_count issue_count note_count
    [ "$#" -lt 5 ] || enforce_note=true
    remote_sha=$(remote_ref_sha_checked "$ref") || rc=$?
    [ "$rc" -eq 0 ] && [ -n "$remote_sha" ] || return 1
    tmp="refs/task-dag-tmp/materialise-delegation/${remote_sha}"
    git update-ref -d "$tmp" 2>/dev/null || true
    git fetch --quiet --no-tags origin "+${ref}:${tmp}" 2>/dev/null || return 1
    msg=$(git log -1 --format='%B' "$tmp" 2>/dev/null || true)
    tree=$(git rev-parse "${tmp}^{tree}" 2>/dev/null || true)
    parent=$(git rev-parse "${tmp}^" 2>/dev/null || true)
    parent_total=$(git rev-list --parents -1 "$tmp" 2>/dev/null | awk '{print NF-1}')
    git update-ref -d "$tmp" 2>/dev/null || true
    empty_tree=$(git mktree </dev/null) || return 1
    delegated_peer=$(printf '%s\n' "$msg" | awk '/^delegated:$/ { inside=1; next } inside && /^  repo:[[:space:]]*/ { sub(/^  repo:[[:space:]]*/, ""); print } inside && !/^  / { inside=0 }' | head -1)
    delegated_issue=$(printf '%s\n' "$msg" | awk '/^delegated:$/ { inside=1; next } inside && /^  number:[[:space:]]*/ { sub(/^  number:[[:space:]]*/, ""); print } inside && !/^  / { inside=0 }' | head -1)
    delegated_note=$(printf '%s\n' "$msg" | awk '/^delegated:$/ { inside=1; next } inside && /^  note:[[:space:]]*/ { sub(/^  note:[[:space:]]*/, ""); print } inside && !/^  / { inside=0 }' | head -1)
    kind_count=$(printf '%s\n' "$msg" | grep -c '^kind:' || true)
    repo_count=$(printf '%s\n' "$msg" | awk '/^delegated:$/ { inside=1; next } inside && /^  repo:/ { n++ } inside && !/^  / { inside=0 } END { print n+0 }')
    issue_count=$(printf '%s\n' "$msg" | awk '/^delegated:$/ { inside=1; next } inside && /^  number:/ { n++ } inside && !/^  / { inside=0 } END { print n+0 }')
    note_count=$(printf '%s\n' "$msg" | awk '/^delegated:$/ { inside=1; next } inside && /^  note:/ { n++ } inside && !/^  / { inside=0 } END { print n+0 }')
    [ "$tree" = "$empty_tree" ] \
        && [ "$parent_total" -eq 1 ] \
        && [ "$parent" = "$root_sha" ] \
        && [ "$(printf '%s\n' "$msg" | sed -nE 's/^kind:[[:space:]]*(.*)$/\1/p')" = delegated ] \
        && [ "$kind_count" -eq 1 ] \
        && [ "$delegated_peer" = "$peer" ] \
        && [ "$repo_count" -eq 1 ] \
        && [ "$issue_count" -eq 1 ] \
        && [ "$delegated_issue" = "$peer_issue" ] \
        && { [ "$enforce_note" = false ] || { [ "$delegated_note" = "$expected_note" ] \
          && { [ -n "$expected_note" ] && [ "$note_count" -eq 1 ] || [ -z "$expected_note" ] && [ "$note_count" -eq 0 ]; }; }; }
}

# Validate the current graph with the canonical reader, then recognize the
# expected edge as active, deliberately tombstoned, or historically folded by
# a sanctioned completion/prune commit. Current absence alone is unresolved.
taskdag_materialise_edge_durable() {
    local eid="$1" edges commits commit parent msg blob recomputed
    edges=$(taskdag_read_edges --no-fetch) || return 2
    printf '%s' "$edges" | jq -e --arg eid "$eid" 'any(.[]; .edgeId == $eid)' >/dev/null 2>&1 && return 0
    git cat-file -e "${TASKDAG_GRAPH_REF}:tombstones/${eid}.json" 2>/dev/null && return 0
    git rev-parse --verify -q "${TASKDAG_GRAPH_REF}^{commit}" >/dev/null 2>&1 || return 1
    commits=$(git rev-list "$TASKDAG_GRAPH_REF") || return 2
    while IFS= read -r commit; do
        [ -n "$commit" ] || continue
        parent=$(git rev-parse "${commit}^" 2>/dev/null || true)
        [ -n "$parent" ] || continue
        git cat-file -e "${parent}:edges/${eid}.json" 2>/dev/null || continue
        git cat-file -e "${commit}:edges/${eid}.json" 2>/dev/null && continue
        blob=$(git cat-file blob "${parent}:edges/${eid}.json" 2>/dev/null || true)
        recomputed=$(_taskdag_edge_blob_check "$blob" 2>/dev/null || true)
        [ "$recomputed" = "$eid" ] || continue
        msg=$(git log -1 --format='%B' "$commit" 2>/dev/null || true)
        printf '%s\n' "$msg" | git interpret-trailers --parse 2>/dev/null \
            | grep -qx "Edge-Id: ${eid}" || continue
        case "$(printf '%s\n' "$msg" | head -1)" in
            "Fold dependency edge ${eid:0:12}"*|"Prune dependency edge ${eid:0:12}"*) return 0 ;;
        esac
    done <<< "$commits"
    return 1
}

# Close barrier for command-reserved and census-imported immutable intents.
# This is independent of legacy trailer discovery: every declaration for the
# parent in the validated authority must reach final and retain all exact
# operation-bound projections before the parent can close.
taskdag_materialisation_authority_durable() { # issue root-sha
    local issue=$1 root_sha=$2 remote rc=0 tip token current path declaration slot state_path state peer peer_issue marker marker_sha tmp delegation from to eid
    remote=$(git ls-remote --exit-code origin "$TASKDAG_MATERIALISATION_REF" 2>/dev/null) || rc=$?
    [ "$rc" -ne 2 ] || return 2
    [ "$rc" -eq 0 ] || return 2
    tip=${remote%%[[:space:]]*}; [ -n "$tip" ] || return 2
    git fetch -q --no-tags origin "$TASKDAG_MATERIALISATION_REF" || return 2
    tip=$(git rev-parse FETCH_HEAD) || return 2
    token=$(taskdag_activation_snapshot_token) || return 2
    current=$(taskdag_current_repo) || return 2
    [ -z "$(taskdag_materialisation_online_tree_violations "$tip" "$(jq -r .authorityTip <<<"$token")" "$(tr '[:upper:]' '[:lower:]' <<<"$current")")" ] || return 2
    while IFS= read -r path; do
        declaration=$(git show "$tip:$path") || return 2
        [ "$(jq -r .sourceRepo.name <<<"$declaration" | tr '[:upper:]' '[:lower:]')" = "$(tr '[:upper:]' '[:lower:]' <<<"$current")" ] || continue
        [ "$(jq -r .parentIssue.number <<<"$declaration")" = "$issue" ] || continue
        slot=$(jq -r .slotId <<<"$declaration")
        state_path=$(git ls-tree -r --name-only "$tip" "slots/$slot/states" | sort | tail -1); [ -n "$state_path" ] || return 1
        state=$(git show "$tip:$state_path") || return 2
        [ "$(jq -r .state <<<"$state")" = final ] || return 1
        peer=$(jq -r .peerRepo.name <<<"$declaration"); peer_issue=$(jq -r .adoptedIssue.number <<<"$state")
        marker=$(jq -r .markerRef <<<"$state"); marker_sha=$(git ls-remote --refs origin "$marker" | awk 'NF==2{print $1}') || return 2
        [ "$marker_sha" = "$(jq -r .markerCommit <<<"$state")" ] || return 1
        tmp="refs/task-dag-tmp/materialisation-close/$marker_sha"; git update-ref -d "$tmp" 2>/dev/null || true
        git fetch -q --no-tags origin "+$marker:$tmp" || return 2
        taskdag_materialise_operation_marker_validate "$tmp" "$declaration" "$(jq -c .adoptedIssue <<<"$state")" || { git update-ref -d "$tmp" 2>/dev/null || true; return 1; }
        git update-ref -d "$tmp" 2>/dev/null || true
        delegation="refs/heads/tasks/delegated/$issue/$peer/$peer_issue"
        [ "$(jq -r .delegationRef <<<"$state")" = "$delegation" ] || return 1
        taskdag_materialise_delegation_valid "$delegation" "$root_sha" "$peer" "$peer_issue" "$(jq -r '.delegationNote // ""' <<<"$declaration")" || return 1
        taskdag_sync_graph_ref || return 2
        from="task:$current@$root_sha"; to="issue:$peer#$peer_issue"; eid=$(taskdag_edge_id "$from" "$to" requires all) || return 2
        [ "$(jq -r .edgeId <<<"$state")" = "$eid" ] || return 1
        taskdag_materialise_edge_durable "$eid" || return 1
    done < <(git ls-tree -r --name-only "$tip" declarations | sort)
    TASKDAG_MATERIALISATION_VALIDATED_TIP=$tip
}

# Return 0 only when every Materialise-Child-Epic group for <issue> reachable
# through <tip> has become durable
# as marker + delegated ref + active/tombstoned requires edge. Return 1 for an
# unresolved intent and 2 for malformed state/transport errors. Close callers
# treat either non-zero result as "do not close".
taskdag_materialisation_intents_durable() {
    local issue="$1" root_sha="$2" tip="$3" cur="" base commit groups group commits group_lines
    local peer parent slug marker peer_issue delegated from to eid graph_synced=false
    base=$(git rev-parse "${root_sha}^" 2>/dev/null) || return 2

    commits=$(git rev-list --reverse "${base}..${tip}" 2>/dev/null) || return 2
    while IFS= read -r commit; do
        [ -n "$commit" ] || continue
        groups=$(git log -1 --format='%B' "$commit" \
            | taskdag_materialise_groups_json_from_message) || return 2
        group_lines=$(printf '%s' "$groups" | jq -c '.[]') || return 2
        while IFS= read -r group; do
            [ -n "$group" ] || continue
            parent=$(printf '%s' "$group" | jq -r '.parent') || return 2
            parent=$(taskdag_materialise_parent_number "$parent") || {
                echo "Malformed Parent-Issue in materialisation intent ${commit:0:12}; refusing to close any affected epic." >&2
                return 2
            }
            [ "$parent" = "$issue" ] || continue
            if [ -z "$cur" ]; then
                cur=$(taskdag_current_repo) || return 2
            fi
            peer=$(printf '%s' "$group" | jq -r '.peer') || return 2
            slug=$(printf '%s' "$group" | jq -r '.slug') || return 2
            if [[ ! "$peer" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
                || { [ -n "$slug" ] && [[ ! "$slug" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]]; }; then
                echo "Materialisation intent for epic #${issue} is malformed in ${commit:0:12}; refusing to close." >&2
                return 2
            fi

            marker=$(taskdag_materialise_marker_ref "$issue" "$peer" "$slug")
            peer_issue=$(taskdag_materialise_marker_issue "$marker" "$issue" "$peer" "$slug") || {
                echo "Epic #${issue} is waiting for materialisation slot ${peer}${slug:+/$slug}; refusing to close." >&2
                return 1
            }
            delegated="refs/heads/tasks/delegated/${issue}/${peer}/${peer_issue}"
            if ! taskdag_materialise_delegation_valid "$delegated" "$root_sha" "$peer" "$peer_issue"; then
                echo "Epic #${issue} materialisation ${peer}#${peer_issue} lacks a durable delegation; refusing to close." >&2
                return 1
            fi

            if [ "$graph_synced" = false ]; then
                taskdag_sync_graph_ref || return 2
                graph_synced=true
            fi
            from="task:${cur}@${root_sha}"
            to="issue:${peer}#${peer_issue}"
            eid=$(taskdag_edge_id "$from" "$to" requires all) || return 2
            if ! taskdag_materialise_edge_durable "$eid"; then
                echo "Epic #${issue} materialisation ${peer}#${peer_issue} lacks durable dependency state; refusing to close." >&2
                return 1
            fi
        done <<< "$group_lines"
    done <<< "$commits"
    taskdag_materialisation_authority_durable "$issue" "$root_sha"
}
