# shellcheck shell=bash
# Read-only, fail-closed capture of strict materialisation census inputs.

_taskdag_census_capture_repo_stable() { # path repo ref tip manifest
    local path=$1 repo=$2 ref=$3 tip=$4 manifest=$5 actual
    actual=$(cd "$path" && _xrepo_current_repo_offline | tr '[:upper:]' '[:lower:]') || return 1
    [ "$actual" = "$repo" ] || return 1
    [ "$(git -C "$path" rev-parse HEAD^{commit} 2>/dev/null)" = "$tip" ] || return 1
    [ "$(git -C "$path" rev-parse "$ref^{commit}" 2>/dev/null)" = "$tip" ] || return 1
    git -C "$path" for-each-ref --format='%(refname)%09%(objectname)' refs/heads/gh refs/heads/tasks | LC_ALL=C sort >"$manifest"
}

_taskdag_census_capture_api() { # repo repository-id output
    local repo=$1 expected_id=$2 out=$3 metadata pages
    metadata=$(gh api --header 'X-GitHub-Api-Version: 2022-11-28' "repos/$repo") || return 1
    jq -e --arg repo "$repo" --arg id "$expected_id" '
      type=="object" and (.full_name|ascii_downcase)==$repo and .node_id==$id
    ' <<<"$metadata" >/dev/null || return 1
    pages=$(gh api --header 'X-GitHub-Api-Version: 2022-11-28' --paginate --slurp \
      "repos/$repo/issues?state=all&sort=created&direction=asc&per_page=100") || return 1
    jq -cS --arg id "$expected_id" '
      if type!="array" or length==0 or any(.[];type!="array") then error("invalid pages") else . end
      | map(map({body:(.body//""),completionEvidence:[],createdAt:.created_at,creator:.user.login,
          declarations:[],id:.node_id,liveDelegations:[],markers:[],number:.number,
          repositoryId:$id,state:(.state|ascii_upcase),title:.title}))
      | if ([.[][]|.number] as $n | ($n|length)==($n|unique|length)) then .
        else error("duplicate issue numbers") end
    ' <<<"$pages" >"$out"
}

_taskdag_census_capture_peer_id() { # activation literal-peer aliases-ndjson
    local activation=$1 peer=$2 aliases=$3 peer_lower response status metadata peer_id canonical resolution name candidate_count rc
    peer_lower=$(printf '%s' "$peer" | tr '[:upper:]' '[:lower:]')
    peer_id=$(jq -r --arg r "$peer_lower" '.registrySnapshot.repositories[]|select(.repository==$r)|.repositoryId' "$activation")
    if [ -n "$peer_id" ]; then printf '%s\n' "$peer_id"; return 0; fi
    peer_id=$(jq -sr --arg r "$peer_lower" '.[]|select((.declaredName|ascii_downcase)==$r)|.repositoryId' "$aliases")
    if [ -n "$peer_id" ]; then printf '%s\n' "$peer_id"; return 0; fi
    response=$(gh api --include --header 'X-GitHub-Api-Version: 2022-11-28' "repos/$peer" 2>/dev/null); rc=$?
    status=$(sed -n '1{s/\r$//;s/^HTTP\/[0-9.]* \([0-9][0-9][0-9]\).*/\1/p;}' <<<"$response")
    if [ "$rc" -eq 0 ]; then
      [[ "$status" =~ ^2[0-9][0-9]$ ]] || return 1
      metadata=$(awk 'found{print} /^[[:space:]]*$/{found=1}' <<<"$response")
      peer_id=$(jq -r '.node_id // empty' <<<"$metadata"); canonical=$(jq -r '.full_name // empty | ascii_downcase' <<<"$metadata"); resolution=github-node-id
    else
      [ "$status" = 404 ] || { echo "Error: cannot resolve historical peer due to non-404 GitHub failure: $peer" >&2; return 1; }
      name=${peer_lower#*/}; candidate_count=$(jq --arg name "$name" '[.registrySnapshot.repositories[]|select((.repository|split("/")[1])==$name)]|length' "$activation")
      [ "$candidate_count" -eq 1 ] || { echo "Error: historical peer is neither GitHub-resolvable nor a unique registry name: $peer" >&2; return 1; }
      canonical=$(jq -r --arg name "$name" '.registrySnapshot.repositories[]|select((.repository|split("/")[1])==$name)|.repository' "$activation")
      peer_id=$(jq -r --arg canonical "$canonical" '.registrySnapshot.repositories[]|select(.repository==$canonical)|.repositoryId' "$activation"); resolution=registry-unique-name
    fi
    [[ "$peer_id" =~ ^[A-Za-z0-9_=-]+$ && "$canonical" =~ ^[a-z0-9_.-]+/[a-z0-9_.-]+$ ]] || return 1
    jq -e --arg id "$peer_id" --arg canonical "$canonical" 'any(.registrySnapshot.repositories[];.repositoryId==$id and .repository==$canonical)' "$activation" >/dev/null || return 1
    jq -ncS --arg canonicalName "$canonical" --arg declaredName "$peer" --arg repositoryId "$peer_id" --arg resolution "$resolution" '{canonicalName:$canonicalName,declaredName:$declaredName,repositoryId:$repositoryId,resolution:$resolution}' >>"$aliases" || return 1
    printf '%s\n' "$peer_id"
}

cmd_materialise_census_capture() {
    case "${1:-}" in -h|--help) echo 'Usage: task-dag materialise-census-capture --spec-file FILE --output-dir DIR'; return 0;; esac
    [ "$#" -eq 4 ] && [ "$1" = --spec-file ] && [ "$3" = --output-dir ] || return 2
    local input=$2 destination=$4 base activation_source destination_parent destination_name stage activation
    local repo path clone clone_rel ref tip repo_id before after clone_manifest page page_file page_count issue oid refname tail owner name peer commit
    local source_id peer_id parent_id body_file body_len body_sha slug note slug_present note_present slot declaration operation group group_entry group_ordinal review_count input_schema
    [ -f "$input" ] && [ ! -L "$input" ] && _taskdag_materialise_no_duplicate_keys "$input" || return 2
    jq -e 'type=="object" and
      ((.schema==1 and keys==["activationRecord","repositories","schema"]) or
       (.schema==2 and keys==["activationRecord","repositories","schema","terminalDeclarations"] and (.terminalDeclarations|type=="array"))) and
      (.activationRecord|type=="string" and length>0) and
      (.repositories|type=="array" and length>0 and .==sort_by(.repository) and
       (map(.repository)|length==(unique|length)) and all(.[];keys==["path","repository"] and
       (.path|type=="string" and length>0) and (.repository|test("^[a-z0-9_.-]+/[a-z0-9_.-]+$"))))' "$input" >/dev/null || return 2
    base=$(dirname "$(realpath -e "$input")")
    activation_source=$(jq -r .activationRecord "$input"); [[ "$activation_source" = /* ]] || activation_source="$base/$activation_source"
    [ -f "$activation_source" ] && [ ! -L "$activation_source" ] || return 2
    destination_parent=$(realpath -e "$(dirname "$destination")") || return 2
    destination_name=$(basename "$destination"); destination="$destination_parent/$destination_name"
    [ ! -e "$destination" ] || { echo "Error: output directory already exists: $destination" >&2; return 3; }
    umask 077; stage=$(mktemp -d "$destination_parent/.${destination_name}.tmp.XXXXXX") || return 2
    trap 'rm -rf "${stage:-}"' RETURN
    cp "$activation_source" "$stage/activation.json" || return 2; activation="$stage/activation.json"
    jq -e '.schema==1 and .state=="enabled" and (.sourceTips|type=="array") and (.registrySnapshot.repositories|type=="array")' "$activation" >/dev/null || return 3
    input_schema=$(jq -r .schema "$input")
    if [ "$input_schema" = 2 ]; then
      jq -cS '.terminalDeclarations' "$input" >"$stage/terminal-declarations.json" || return 2
      jq -ncS --argjson terminalDeclarations "$(cat "$stage/terminal-declarations.json")" '{schema:2,activationRecord:"activation.json",issuePages:[],repositories:[],terminalDeclarations:$terminalDeclarations}' >"$stage/terminal-validation.json" || return 2
      _taskdag_validate_terminal_declarations "$stage/terminal-validation.json" "$activation" || return 2
    fi
    [ "$(jq -c '[.repositories[].repository]' "$input")" = "$(jq -c '[.registrySnapshot.repositories[].repository]' "$activation")" ] || return 3
    mkdir "$stage/pages" "$stage/manifests" "$stage/repos"
    : >"$stage/repositories.ndjson"; : >"$stage/pages.ndjson"
    while IFS=$'\t' read -r repo path; do
        [[ "$path" = /* ]] || path="$base/$path"; path=$(realpath -e "$path") || return 3
        ref=$(jq -r --arg r "$repo" '.sourceTips[]|select(.repository==$r)|.ref' "$activation")
        tip=$(jq -r --arg r "$repo" '.sourceTips[]|select(.repository==$r)|.commit' "$activation")
        repo_id=$(jq -r --arg r "$repo" '.registrySnapshot.repositories[]|select(.repository==$r)|.repositoryId' "$activation")
        [ -n "$ref" ] && [ -n "$tip" ] && [ -n "$repo_id" ] || return 3
        before="$stage/manifests/${repo//\//_}.before"
        _taskdag_census_capture_repo_stable "$path" "$repo" "$ref" "$tip" "$before" || return 3
        echo "census-capture: $repo API pass 1" >&2
        _taskdag_census_capture_api "$repo" "$repo_id" "$stage/${repo//\//_}.pass1" || return 3
        echo "census-capture: $repo API pass 2" >&2
        _taskdag_census_capture_api "$repo" "$repo_id" "$stage/${repo//\//_}.pass2" || return 3
        cmp -s "$stage/${repo//\//_}.pass1" "$stage/${repo//\//_}.pass2" || { echo "Error: issue snapshot changed during capture: $repo" >&2; return 3; }
        clone_rel="repos/${repo//\//_}.git"; clone="$stage/$clone_rel"
        git clone -q --mirror --no-local "$path" "$clone" || return 3
        git -C "$clone" remote set-url origin "$clone" || return 3
        git -C "$clone" config taskdag.current-repo "$repo"
        [ "$(git -C "$clone" rev-parse HEAD^{commit} 2>/dev/null)" = "$tip" ] \
          && [ "$(git -C "$clone" rev-parse "$ref^{commit}" 2>/dev/null)" = "$tip" ] || return 3
        clone_manifest="$stage/manifests/${repo//\//_}.clone"
        git -C "$clone" for-each-ref --format='%(refname)%09%(objectname)' refs/heads/gh refs/heads/tasks | LC_ALL=C sort >"$clone_manifest"
        cmp -s "$before" "$clone_manifest" || { echo "Error: isolated repository snapshot differs: $repo" >&2; return 3; }
        after="$stage/manifests/${repo//\//_}.after"
        _taskdag_census_capture_repo_stable "$path" "$repo" "$ref" "$tip" "$after" || return 3
        cmp -s "$before" "$after" || { echo "Error: task/gh refs changed during capture: $repo" >&2; return 3; }
        page_count=$(jq length "$stage/${repo//\//_}.pass1")
        for ((page=1; page<=page_count; page++)); do
            page_file="pages/${repo//\//_}.$(printf '%04d' "$page").json"
            jq -cS --argjson p "$((page-1))" '{schema:1,issues:.[ $p ]}' "$stage/${repo//\//_}.pass1" >"$stage/$page_file"
            jq -ncS --arg repository "$repo" --arg file "$page_file" --argjson page "$page" \
              --argjson hasNextPage "$([ "$page" -lt "$page_count" ] && echo true || echo false)" \
              '{file:$file,hasNextPage:$hasNextPage,page:$page,repository:$repository}' >>"$stage/pages.ndjson"
        done
        jq -ncS --arg path "$clone_rel" --arg repository "$repo" --arg tip "$tip" '{path:$path,repository:$repository,tip:$tip}' >>"$stage/repositories.ndjson"
    done < <(jq -r '.repositories[]|[.repository,.path]|@tsv' "$input")

    : >"$stage/markers.ndjson"; : >"$stage/completions.ndjson"; : >"$stage/delegations.ndjson"; : >"$stage/declarations.ndjson"; : >"$stage/aliases.ndjson"
    while IFS=$'\t' read -r repo path; do
        path="$stage/$path"
        while IFS=$'\t' read -r oid refname; do
            case "$refname" in
              refs/heads/gh/child-epics/*|refs/heads/gh/child-epic-slots/*)
                tail=${refname#refs/heads/gh/child-epics/}; [ "$tail" != "$refname" ] || tail=${refname#refs/heads/gh/child-epic-slots/}
                issue=${tail%%/*}; [[ "$issue" =~ ^[1-9][0-9]*$ ]] || return 3
                jq -ncS --arg repo "$repo" --argjson issue "$issue" --arg oid "$oid" --arg ref "$refname" '{repository:$repo,issue:$issue,oid:$oid,ref:$ref}' >>"$stage/markers.ndjson" ;;
              refs/heads/tasks/completions/*)
                tail=${refname#refs/heads/tasks/completions/}; issue=${tail%%/*}; [[ "$issue" =~ ^[1-9][0-9]*$ ]] || return 3
                jq -ncS --arg repo "$repo" --argjson issue "$issue" --arg oid "$oid" --arg ref "$refname" '{repository:$repo,issue:$issue,disposition:"partial-implementation",oid:$oid,ref:$ref}' >>"$stage/completions.ndjson" ;;
              refs/heads/tasks/delegated/*)
                tail=${refname#refs/heads/tasks/delegated/}; issue=${tail%%/*}; tail=${tail#*/}; owner=${tail%%/*}; tail=${tail#*/}; name=${tail%%/*}; peer=${tail#*/}
                [[ "$issue" =~ ^[1-9][0-9]*$ && "$peer" =~ ^[1-9][0-9]*$ ]] || return 3
                jq -ncS --arg repo "$repo" --argjson issue "$issue" --arg peerRepo "$owner/$name" --argjson peerIssue "$peer" --arg oid "$oid" --arg ref "$refname" \
                  '{repository:$repo,issue:$issue,disposition:"live-obligation",oid:$oid,parentIssue:$issue,parentRepo:$repo,peerIssue:$peerIssue,peerRepo:$peerRepo,ref:$ref}' >>"$stage/delegations.ndjson" ;;
            esac
        done < <(git -C "$path" for-each-ref --format='%(objectname)%09%(refname)' refs/heads/gh/child-epics refs/heads/gh/child-epic-slots refs/heads/tasks/completions refs/heads/tasks/delegated)
        source_id=$(jq -r --arg r "$repo" '.registrySnapshot.repositories[]|select(.repository==$r)|.repositoryId' "$activation")
        tip=$(jq -r --arg r "$repo" '.sourceTips[]|select(.repository==$r)|.commit' "$activation")
        while IFS= read -r commit; do
            while IFS= read -r group_entry; do
                [ -n "$group_entry" ] || continue
                group_ordinal=$(jq -r .key <<<"$group_entry"); group=$(jq -c .value <<<"$group_entry")
                issue=$(taskdag_materialise_parent_number "$(jq -r .parent <<<"$group")") || return 3
                peer=$(jq -r .peer <<<"$group")
                parent_id=$(jq -r --argjson issue "$issue" '[.[][]|select(.number==$issue)][0].id // empty' "$stage/${repo//\//_}.pass1")
                [ -n "$parent_id" ] || return 3
                review_count=$(jq --arg repo "$repo" --arg commit "$commit" --argjson ordinal "$group_ordinal" '[.terminalDeclarations[]?|select(.sourceRepo.name==$repo and .declarationCommit==$commit and .groupOrdinal==$ordinal)]|length' "$input") || return 2
                [ "$review_count" -le 1 ] || return 3
                [ "$review_count" -eq 0 ] || continue
                peer_id=$(_taskdag_census_capture_peer_id "$activation" "$peer" "$stage/aliases.ndjson") || return 3
                body_file=$(jq -r .bodyFile <<<"$group"); body_len=$(git -C "$path" cat-file -s "$commit:$body_file") || return 3
                git -C "$path" cat-file blob "$commit:$body_file" >"$stage/body.tmp" || return 3
                body_sha=$(_taskdag_materialise_sha256_file "$stage/body.tmp") || return 3
                slug=$(jq -r .slug <<<"$group"); note=$(jq -r .note <<<"$group"); slug_present=$(jq -r .slugPresent <<<"$group"); note_present=$(jq -r .notePresent <<<"$group")
                slot=$(_taskdag_materialise_id slot "$source_id" "$parent_id" "$issue" "$peer_id" "$([ "$slug_present" = true ] && echo present || echo absent)" "$slug")
                declaration=$(_taskdag_materialise_id declaration "$source_id" "$repo" "$parent_id" "$issue" "$peer_id" "$peer" "$(jq -r .title <<<"$group")" "$body_sha" "$body_len" "$([ "$slug_present" = true ] && echo present || echo absent)" "$slug" "$([ "$note_present" = true ] && echo present || echo absent)" "$note")
                operation=$(_taskdag_materialise_id operation "$slot" "$declaration")
                jq -ncS --rawfile body "$stage/body.tmp" --arg repo "$repo" --arg sourceId "$source_id" --arg peerRepo "$peer" --arg peerId "$peer_id" --arg parentId "$parent_id" --argjson issue "$issue" \
                  --arg title "$(jq -r .title <<<"$group")" --argjson bodyLength "$body_len" --arg bodySha256 "$body_sha" --arg slotId "$slot" --arg declarationDigest "$declaration" --arg operationId "$operation" --arg slug "$slug" --arg note "$note" --argjson slugPresent "$slug_present" --argjson notePresent "$note_present" \
                  '{repository:$repo,issue:$issue,declaration:({schema:1,sourceRepo:{id:$sourceId,name:$repo},parentIssue:{id:$parentId,number:$issue},peerRepo:{id:$peerId,name:$peerRepo},title:$title,body:$body,bodyLength:$bodyLength,bodySha256:$bodySha256,slotId:$slotId,declarationDigest:$declarationDigest,operationId:$operationId,disposition:"create-in-flight-or-uncertain"} + (if $slugPresent then {slug:$slug} else {} end) + (if $notePresent then {delegationNote:$note} else {} end))}' >>"$stage/declarations.ndjson"
            done < <(git -C "$path" log -1 --format='%B' "$commit" | taskdag_materialise_groups_json_from_message | jq -c 'to_entries[]')
        done < <(git -C "$path" rev-list --reverse "$tip")
    done < <(jq -sr 'sort_by(.repository)[]|[.repository,.path]|@tsv' "$stage/repositories.ndjson")

    for page_file in "$stage"/pages/*.json; do
        repo_id=$(jq -r '.issues[0].repositoryId // empty' "$page_file")
        repo=$(jq -r --arg id "$repo_id" '.registrySnapshot.repositories[]|select(.repositoryId==$id)|.repository' "$activation")
        # Empty repositories still have one page and need their identity from the filename.
        [ -n "$repo" ] || repo=$(jq -r --arg file "${page_file#"$stage/"}" '.[]|select(.file==$file)|.repository' "$stage/pages.ndjson" --slurp)
        jq -cS --arg repo "$repo" --slurpfile m "$stage/markers.ndjson" --slurpfile c "$stage/completions.ndjson" --slurpfile l "$stage/delegations.ndjson" --slurpfile d "$stage/declarations.ndjson" '
          .issues |= map(. as $i |
            .markers=[$m[]|select(.repository==$repo and .issue==$i.number)|{oid,ref}]|.markers|=sort_by(.ref) |
            .completionEvidence=[$c[]|select(.repository==$repo and .issue==$i.number)|{disposition,oid,ref}]|.completionEvidence|=sort_by(.ref) |
            .liveDelegations=[$l[]|select(.repository==$repo and .issue==$i.number)|del(.repository,.issue)]|.liveDelegations|=sort_by(.ref) |
            .declarations=[$d[]|select(.repository==$repo and .issue==$i.number)|.declaration]|.declarations|=sort_by(.slotId))
        ' "$page_file" >"$page_file.new" || return 3
        mv "$page_file.new" "$page_file"
    done
    if [ "$input_schema" = 2 ] || [ -s "$stage/aliases.ndjson" ]; then
      jq -ncS --arg activationRecord activation.json --slurpfile issuePages "$stage/pages.ndjson" --slurpfile repositories "$stage/repositories.ndjson" --argjson terminalDeclarations "$([ "$input_schema" = 2 ] && cat "$stage/terminal-declarations.json" || echo '[]')" --slurpfile aliases "$stage/aliases.ndjson" \
        '{schema:2,activationRecord:$activationRecord,issuePages:$issuePages,repositories:$repositories,repositoryAliases:($aliases|sort_by(.declaredName)),terminalDeclarations:$terminalDeclarations}' >"$stage/spec.json" || return 2
    else
      jq -ncS --arg activationRecord activation.json --slurpfile issuePages "$stage/pages.ndjson" --slurpfile repositories "$stage/repositories.ndjson" \
        '{schema:1,activationRecord:$activationRecord,issuePages:$issuePages,repositories:$repositories}' >"$stage/spec.json" || return 2
    fi
    echo 'census-capture: validating candidate with canonical census builder' >&2
    (cd "$stage" && _taskdag_census_build spec.json census.preview.json) || return 3
    rm -rf "$stage/manifests" "$stage"/*.pass1 "$stage"/*.pass2 "$stage/body.tmp" "$stage/terminal-validation.json" "$stage/terminal-declarations.json" "$stage/aliases.ndjson"
    [ ! -e "$destination" ] || return 3
    mv -T "$stage" "$destination" || return 2; stage=""
    jq -ncS --arg outputDir "$destination" --arg spec "$destination/spec.json" --arg preview "$destination/census.preview.json" \
      --argjson repositories "$(jq '.repositories|length' "$destination/spec.json")" --argjson pages "$(jq '.issuePages|length' "$destination/spec.json")" \
      '{ok:true,outputDir:$outputDir,spec:$spec,preview:$preview,repositories:$repositories,pages:$pages}'
}
