# shellcheck shell=bash
# Origin-fenced fleet lease and success evidence for comment reconciliation.

TASKDAG_COMMENT_WATCHDOG_REF="refs/heads/tasks/v1/comment-watchdog"

_taskdag_comment_watchdog_registry() { jq -cS '[.repositories[]|{repository,ingestionStartAt}]|sort_by(.repository)' "$1"; }
_taskdag_comment_watchdog_registry_digest() { printf '%s' "$(_taskdag_comment_watchdog_registry "$1")" | sha256sum | awk '{print $1}'; }

_taskdag_comment_watchdog_response_parts() { # endpoint; prints epoch<TAB>body-file
    local endpoint=$1 response headers body observed
    response=$(mktemp) || return 2; headers=$(mktemp) || { rm -f "$response"; return 2; }; body=$(mktemp) || { rm -f "$response" "$headers"; return 2; }
    gh api --include "$endpoint" >"$response" 2>/dev/null || { rm -f "$response" "$headers" "$body"; return 2; }
    awk 'BEGIN{h=1} h{gsub("\r","");if($0==""){h=0;next}print}' "$response" >"$headers"
    awk 'BEGIN{h=1} h{gsub("\r","");if($0==""){h=0;next}} !h{print}' "$response" >"$body"
    [ "$(grep -c '^HTTP/' "$headers")" -eq 1 ] || { rm -f "$response" "$headers" "$body"; return 3; }
    observed=$(awk 'tolower($1)=="date:" {$1="";sub(/^ /,"");print;exit}' "$headers")
    observed=$(date -u -d "$observed" +%s 2>/dev/null) || { rm -f "$response" "$headers" "$body"; return 3; }
    rm -f "$response" "$headers"
    printf '%s\t%s\n' "$observed" "$body"
}

_taskdag_comment_watchdog_server_time() { # repo
    local row now body
    row=$(_taskdag_comment_watchdog_response_parts "repos/$1") || return $?
    IFS=$'\t' read -r now body <<<"$row"; rm -f "$body"; printf '%s\n' "$now"
}

_taskdag_comment_watchdog_server_observation() { # repo; prints epoch<TAB>ref-sha
    local repo=$1 row observed body sha
    row=$(_taskdag_comment_watchdog_response_parts "repos/$repo/git/ref/heads/tasks/v1/comment-watchdog") || return $?
    IFS=$'\t' read -r observed body <<<"$row"
    sha=$(jq -r '.object.sha // empty' "$body" 2>/dev/null)
    rm -f "$body"; [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || return 3
    printf '%s\t%s\n' "$observed" "$sha"
}

_taskdag_comment_watchdog_validate_record() { # file expected-sequence
    local file=$1 sequence=$2
    jq -e --argjson sequence "$sequence" '
      def oid: type=="string" and test("^[0-9a-f]{40}$");
      def digest: type=="string" and test("^[0-9a-f]{64}$");
      def timestamp: type=="string" and length==20 and ((fromdateiso8601|todateiso8601)==.);
      type=="object" and .schema==1 and .sequence==$sequence and
      (.type=="lease" or .type=="attempt" or .type=="result" or .type=="fleet") and
      (.holder|type=="string" and length>0 and length<=256) and
      (.fence|type=="number" and floor==. and .>=1) and
      (.runtimeCommit|oid) and (.registrySnapshotId|test("^sha256:[0-9a-f]{64}$")) and
      (.reviewedRegistryDigest|digest) and (.coordinationRepository|type=="string" and test("^[a-z0-9_.-]+/[a-z0-9_.-]+$")) and
      (.activation|keys==["digest","epoch","guardVersion"] and (.digest|digest) and (.epoch|type=="number" and floor==. and .>=1) and .guardVersion==1) and
      (.acquiredAt|timestamp) and (.observedAt|timestamp) and (.expiresAt|timestamp) and
      (.acquiredAt<=.observedAt and .observedAt<.expiresAt) and
      if .type=="lease" then
        keys==["acquiredAt","activation","coordinationRepository","expiresAt","fence","holder","observedAt","registrySnapshotId","reviewedRegistryDigest","runtimeCommit","schema","sequence","type"]
      elif .type=="attempt" then
        keys==["acquiredAt","activation","coordinationRepository","cycle","expiresAt","fence","holder","mode","observedAt","registry","registrySnapshotId","reviewedRegistryDigest","runtimeCommit","schema","sequence","type"] and
        (.cycle|digest) and (.mode=="recent" or .mode=="complete") and (.registry|type=="array" and length>0 and .==sort_by(.repository) and (map(.repository)|length==(unique|length)) and all(.[];keys==["ingestionStartAt","repository"] and (.repository|test("^[a-z0-9_.-]+/[a-z0-9_.-]+$")) and (.ingestionStartAt|timestamp)))
      elif .type=="result" then
        keys==["acquiredAt","activation","coordinationRepository","cycle","expiresAt","fence","holder","observedAt","registrySnapshotId","repository","result","reviewedRegistryDigest","runtimeCommit","schema","sequence","type"] and (.cycle|digest) and
        (.repository|type=="string" and .==ascii_downcase and test("^[a-z0-9_.-]+/[a-z0-9_.-]+$")) and
        (.result|type=="object" and keys==["applied","deferred","dryRun","exhausted","failures","mode","status"] and
          (.mode=="recent" or .mode=="complete") and (.status=="success" or .status=="partial" or .status=="failed") and
          (.dryRun|type=="boolean") and (.exhausted|type=="boolean") and
          all(.applied,.deferred,.failures;type=="number" and floor==. and .>=0))
      else
        keys==["acquiredAt","activation","completedAt","coordinationRepository","cycle","expiresAt","fence","holder","mode","observedAt","registrySnapshotId","repositories","reviewedRegistryDigest","runtimeCommit","schema","sequence","success","type"] and
        (.cycle|digest) and (.mode=="recent" or .mode=="complete") and (.success|type=="boolean") and (.completedAt|timestamp) and
        (.repositories|type=="array" and length>0 and .==sort and length==(unique|length))
      end
    ' "$file" >/dev/null 2>&1 || return 1
    [ "$(cat "$file")" = "$(jq -cS . "$file")" ]
}

taskdag_comment_watchdog_validate_tip() { # tip
    local tip=$1 tmp previous="" commit sequence=0 path record fence holder runtime registry reviewed coordination activation acquired expires type cycle="" cycle_mode=""
    local last_attempt=none recent_success=none complete_success=none expected
    tmp=$(mktemp -d) || return 1
    git rev-list --reverse --first-parent "$tip" >"$tmp/commits" 2>/dev/null || { rm -rf "$tmp"; return 1; }
    while IFS= read -r commit; do
        [ "$(git rev-list --parents -1 "$commit" | wc -w)" -eq "$([ -z "$previous" ] && echo 1 || echo 2)" ] || { rm -rf "$tmp"; return 1; }
        [ -z "$previous" ] || [ "$(git rev-parse "$commit^")" = "$previous" ] || { rm -rf "$tmp"; return 1; }
        path="records/$(printf '%016d' "$sequence").json"
        [ "$(git ls-tree -r --name-only "$commit")" = "$path" ] || { rm -rf "$tmp"; return 1; }
        record="$tmp/record"; git show "$commit:$path" >"$record" || { rm -rf "$tmp"; return 1; }
        _taskdag_comment_watchdog_validate_record "$record" "$sequence" || { rm -rf "$tmp"; return 1; }
        [ "$sequence" -gt 0 ] || [ "$(jq -r .type "$record")" = lease ] || { rm -rf "$tmp"; return 1; }
        if [ "$sequence" -gt 0 ]; then
            [ "$(jq -r .registrySnapshotId "$record")" = "$registry" ] \
              && [ "$(jq -c .activation "$record")" = "$activation" ] \
              && [ "$(jq -r .coordinationRepository "$record")" = "$coordination" ] || { rm -rf "$tmp"; return 1; }
            type=$(jq -r .type "$record")
            if [ "$type" = lease ]; then
                if [ "$(jq -r .holder "$record")" = "$holder" ] && [ "$(jq -r .fence "$record")" = "$fence" ]; then
                    [ "$(jq -r .acquiredAt "$record")" = "$acquired" ] && [ "$(jq -r .fence "$record")" = "$fence" ] \
                      && [ "$(jq -r .runtimeCommit "$record")" = "$runtime" ] && [ "$(jq -r .reviewedRegistryDigest "$record")" = "$reviewed" ] || { rm -rf "$tmp"; return 1; }
                else
                    [ "$(jq -r .observedAt "$record")" \> "$expires" ] || [ "$(jq -r .observedAt "$record")" = "$expires" ] || { rm -rf "$tmp"; return 1; }
                    [ "$(jq -r .acquiredAt "$record")" = "$(jq -r .observedAt "$record")" ] && [ "$(jq -r .fence "$record")" -eq $((fence+1)) ] || { rm -rf "$tmp"; return 1; }
                    cycle=""; cycle_mode=""
                fi
            else
                [ "$(jq -r .holder "$record")" = "$holder" ] && [ "$(jq -r .acquiredAt "$record")" = "$acquired" ] \
                  && [ "$(jq -r .fence "$record")" = "$fence" ] && [ "$(jq -r .expiresAt "$record")" = "$expires" ] \
                  && [ "$(jq -r .runtimeCommit "$record")" = "$runtime" ] && [ "$(jq -r .reviewedRegistryDigest "$record")" = "$reviewed" ] || { rm -rf "$tmp"; return 1; }
            fi
        fi
        type=$(jq -r .type "$record")
        if [ "$type" = attempt ]; then
            [ -z "$cycle" ] || { rm -rf "$tmp"; return 1; }
            [ "$(printf '%s' "$(jq -cS .registry "$record")" | sha256sum | awk '{print $1}')" = "$(jq -r .reviewedRegistryDigest "$record")" ] || { rm -rf "$tmp"; return 1; }
            cycle=$(jq -r .cycle "$record"); cycle_mode=$(jq -r .mode "$record"); jq -r '.registry[].repository' "$record" >"$tmp/expected"; : >"$tmp/seen"; : >"$tmp/success"
        elif [ "$type" = result ]; then
            [ -n "$cycle" ] && [ "$(jq -r .cycle "$record")" = "$cycle" ] && [ "$(jq -r .result.mode "$record")" = "$cycle_mode" ] || { rm -rf "$tmp"; return 1; }
            grep -Fxq "$(jq -r .repository "$record")" "$tmp/expected" && ! grep -Fxq "$(jq -r .repository "$record")" "$tmp/seen" || { rm -rf "$tmp"; return 1; }
            jq -r .repository "$record" >>"$tmp/seen"
            jq -e '.result | .status=="success" and .dryRun==false and .exhausted==true and .failures==0 and .deferred==0' "$record" >/dev/null \
                && jq -r .repository "$record" >>"$tmp/success"
        elif [ "$type" = fleet ]; then
            [ -n "$cycle" ] && [ "$(jq -r .cycle "$record")" = "$cycle" ] && [ "$(jq -r .mode "$record")" = "$cycle_mode" ] || { rm -rf "$tmp"; return 1; }
            sort "$tmp/seen" | cmp -s - "$tmp/expected" || { rm -rf "$tmp"; return 1; }
            if [ "$(jq -r .success "$record")" = true ]; then sort "$tmp/success" | cmp -s - "$tmp/expected" || { rm -rf "$tmp"; return 1; }; fi
            [ "$(jq -c .repositories "$record")" = "$(jq -Rsc 'split("\n")[:-1]' "$tmp/expected")" ] || { rm -rf "$tmp"; return 1; }
            cycle=""; cycle_mode=""
        fi
        [ "$type" != attempt ] || last_attempt=$(jq -r .observedAt "$record")
        if [ "$type" = fleet ] && [ "$(jq -r .success "$record")" = true ]; then
            [ "$(jq -r .mode "$record")" != recent ] || recent_success=$(jq -r .completedAt "$record")
            [ "$(jq -r .mode "$record")" != complete ] || complete_success=$(jq -r .completedAt "$record")
        fi
        for expected in "Watchdog-Last-Attempt:$last_attempt" "Watchdog-Recent-Success:$recent_success" "Watchdog-Complete-Success:$complete_success"; do
            [ "$(git show -s --format="%(trailers:key=${expected%%:*},valueonly)" "$commit")" = "${expected#*:}" ] || { rm -rf "$tmp"; return 1; }
        done
        if [ "$type" = lease ]; then
            holder=$(jq -r .holder "$record"); runtime=$(jq -r .runtimeCommit "$record"); registry=$(jq -r .registrySnapshotId "$record")
            reviewed=$(jq -r .reviewedRegistryDigest "$record"); coordination=$(jq -r .coordinationRepository "$record")
            activation=$(jq -c .activation "$record"); acquired=$(jq -r .acquiredAt "$record"); fence=$(jq -r .fence "$record"); expires=$(jq -r .expiresAt "$record")
        fi
        previous=$commit; sequence=$((sequence+1))
    done <"$tmp/commits"
    [ "$sequence" -gt 0 ] || { rm -rf "$tmp"; return 1; }
    rm -rf "$tmp"
}

_taskdag_comment_watchdog_token() { # authority-tip lease-record lease-commit
    jq -ncS --arg authorityTip "$1" --arg repository "$(printf '%s' "$(_xrepo_current_repo)" | tr '[:upper:]' '[:lower:]')" --argjson lease "$2" --arg leaseCommit "$3" '{schema:1,authorityTip:$authorityTip,coordinationRepository:$repository,lease:$lease,leaseCommit:$leaseCommit}'
}

taskdag_comment_watchdog_check_file() { # token-file [minimum-seconds]
    local file=$1 minimum=${2:-15} token repo observation now tip local_tip lease lease_path lease_commit coordination=${TASKDAG_COMMENT_WATCHDOG_COORDINATION_PATH:-.}
    jq -e 'type=="object" and keys==["authorityTip","coordinationRepository","lease","leaseCommit","schema"] and .schema==1 and (.authorityTip|test("^[0-9a-f]{40}$")) and (.leaseCommit|test("^[0-9a-f]{40}$")) and (.coordinationRepository|test("^[a-z0-9_.-]+/[a-z0-9_.-]+$")) and .lease.type=="lease"' "$file" >/dev/null 2>&1 || return 3
    token=$(cat "$file"); lease=$(jq -cS .lease <<<"$token")
    repo=$(jq -r .coordinationRepository <<<"$token")
    observation=$(_taskdag_comment_watchdog_server_observation "$repo") || return 3
    IFS=$'\t' read -r now tip <<<"$observation"
    [ "$tip" = "$(jq -r .authorityTip <<<"$token")" ] || return 3
    git -C "$coordination" fetch -q --no-tags origin "$tip" || return 3; local_tip=$(git -C "$coordination" rev-parse FETCH_HEAD) || return 3
    [ "$local_tip" = "$tip" ] || return 3
    lease_path="records/$(printf '%016d' "$(jq -r .lease.sequence <<<"$token")").json"; lease_commit=$(jq -r .leaseCommit <<<"$token")
    git -C "$coordination" merge-base --is-ancestor "$lease_commit" "$tip" || return 3
    [ "$(git -C "$coordination" ls-tree -r --name-only "$lease_commit")" = "$lease_path" ] || return 3
    [ "$(git -C "$coordination" show "$lease_commit:$lease_path")" = "$lease" ] || return 3
    (cd "$coordination" && _taskdag_comment_watchdog_validate_record <(printf '%s\n' "$lease") "$(jq -r .lease.sequence <<<"$token")") || return 3
    [ $(( $(date -u -d "$(jq -r .expiresAt <<<"$lease")" +%s) - now )) -ge "$minimum" ] || return 3
}

_taskdag_comment_watchdog_append() { # activation old record actor operation
    local activation=$1 old=$2 record=$3 actor=$4 operation=$5 tmp index tree commit sequence updates type
    local last_attempt=none recent_success=none complete_success=none message
    sequence=$(jq -r .sequence <<<"$record"); tmp=$(mktemp -d) || return 2; index="$tmp/index"
    GIT_INDEX_FILE="$index" git read-tree "$(git mktree </dev/null)" || { rm -rf "$tmp"; return 2; }
    mkdir -p "$tmp/records"; printf '%s\n' "$record" >"$tmp/records/$(printf '%016d' "$sequence").json"
    GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "100644,$(git hash-object -w "$tmp/records/$(printf '%016d' "$sequence").json"),records/$(printf '%016d' "$sequence").json"
    tree=$(GIT_INDEX_FILE="$index" git write-tree) || { rm -rf "$tmp"; return 2; }; rm -rf "$tmp"
    if [ -n "$old" ]; then
        last_attempt=$(git show -s --format='%(trailers:key=Watchdog-Last-Attempt,valueonly)' "$old")
        recent_success=$(git show -s --format='%(trailers:key=Watchdog-Recent-Success,valueonly)' "$old")
        complete_success=$(git show -s --format='%(trailers:key=Watchdog-Complete-Success,valueonly)' "$old")
        [ -n "$last_attempt" ] && [ -n "$recent_success" ] && [ -n "$complete_success" ] || return 3
    fi
    type=$(jq -r .type <<<"$record")
    [ "$type" != attempt ] || last_attempt=$(jq -r .observedAt <<<"$record")
    if [ "$type" = fleet ] && [ "$(jq -r .success <<<"$record")" = true ]; then
        [ "$(jq -r .mode <<<"$record")" != recent ] || recent_success=$(jq -r .completedAt <<<"$record")
        [ "$(jq -r .mode <<<"$record")" != complete ] || complete_success=$(jq -r .completedAt <<<"$record")
    fi
    message=$(printf 'Record comment watchdog %s\n\nWatchdog-Last-Attempt: %s\nWatchdog-Recent-Success: %s\nWatchdog-Complete-Success: %s\n' "$operation" "$last_attempt" "$recent_success" "$complete_success")
    if [ -n "$old" ]; then commit=$(printf '%s' "$message" | git commit-tree "$tree" -p "$old"); else commit=$(printf '%s' "$message" | git commit-tree "$tree"); fi
    _taskdag_comment_watchdog_validate_record <(printf '%s\n' "$record") "$sequence" || return 3
    [ "$(git ls-tree -r --name-only "$commit")" = "records/$(printf '%016d' "$sequence").json" ] || return 3
    if [ -n "$old" ]; then [ "$(git rev-parse "$commit^")" = "$old" ] || return 3; else [ "$sequence" -eq 0 ] && [ "$(jq -r .type <<<"$record")" = lease ] || return 3; fi
    updates=$(jq -ncS --arg ref "$TASKDAG_COMMENT_WATCHDOG_REF" --arg old "$old" --arg new "$commit" '[{ref:$ref,old:$old,new:$new}]') || return 2
    taskdag_activation_fenced_multi_push "$activation" comment-watchdog "$operation" "$actor" "$(jq -r .observedAt <<<"$record")" "$updates" || return 3
    printf '%s\n' "$commit"
}

cmd_comment_watchdog() {
    local action=${1:-}; shift || :
    case "$action" in
      acquire|renew)
        local holder="" ttl=180 registry_file="" reviewed old="" activation activation_record runtime registry repo observation now tip prior sequence=0 fence=1 acquired observed expires record commit
        while [ $# -gt 0 ]; do case "$1" in --holder) holder=$2; shift 2;; --ttl) ttl=$2; shift 2;; --registry-file) registry_file=$2; shift 2;; *) return 2;; esac; done
        [[ -n "$holder" && ${#holder} -le 256 && "$ttl" =~ ^[1-9][0-9]*$ && "$ttl" -ge 60 && "$ttl" -le 900 && -f "$registry_file" ]] || return 2
        reviewed=$(_taskdag_comment_watchdog_registry_digest "$registry_file") || return 2
        activation=$(taskdag_activation_snapshot_token) || return 3; activation_record=$(taskdag_activation_record_for_snapshot "$activation") || return 3
        runtime=$(_taskdag_activation_runtime_commit) || return 3; registry=$(jq -r .registrySnapshot.id <<<"$activation_record")
        repo=$(printf '%s' "$(_xrepo_current_repo)" | tr '[:upper:]' '[:lower:]') || return 3
        jq -e --argjson reviewed "$(_taskdag_comment_watchdog_registry "$registry_file")" --arg coordination "$repo" '
          ($reviewed|map(.repository)) as $names |
          ($names|index($coordination))!=null and
          all($names[] as $name; any(.registrySnapshot.repositories[]; .repository==$name))
        ' <<<"$activation_record" >/dev/null || return 3
        old=$(git ls-remote --refs origin "$TASKDAG_COMMENT_WATCHDOG_REF" | awk 'NF==2{print $1}') || return 2
        if [ -z "$old" ]; then
            [ "$action" = acquire ] || return 3
            now=$(_taskdag_comment_watchdog_server_time "$repo") || return 3
            acquired=$(date -u -d "@$now" +%Y-%m-%dT%H:%M:%SZ)
        else
            observation=$(_taskdag_comment_watchdog_server_observation "$repo") || return 3
            IFS=$'\t' read -r now tip <<<"$observation"; [ "$tip" = "$old" ] || return 3
            git fetch -q --no-tags origin "$old" || return 3
            local latest_path latest_record lease_path cursor
            latest_path=$(git ls-tree -r --name-only "$old"); latest_record=$(git show "$old:$latest_path") || return 3
            _taskdag_comment_watchdog_validate_record <(printf '%s\n' "$latest_record") "$(jq -r .sequence <<<"$latest_record")" || return 3
            sequence=$(( $(jq -r .sequence <<<"$latest_record") + 1 ))
            cursor=$old
            while [ -n "$cursor" ]; do
                lease_path=$(git ls-tree -r --name-only "$cursor") || return 3
                prior=$(git show "$cursor:$lease_path") || return 3
                [ "$(jq -r .type <<<"$prior")" = lease ] && break
                cursor=$(git rev-parse -q --verify "$cursor^" 2>/dev/null || true)
            done
            [ -n "$cursor" ] || return 3
        fi
        if [ -n "$old" ] && [ "$(date -u -d "$(jq -r .expiresAt <<<"$prior")" +%s)" -gt "$now" ]; then
            [ "$(jq -r .holder <<<"$prior")" = "$holder" ] && [ "$(jq -r .runtimeCommit <<<"$prior")" = "$runtime" ] && [ "$(jq -r .registrySnapshotId <<<"$prior")" = "$registry" ] && [ "$(jq -r .reviewedRegistryDigest <<<"$prior")" = "$reviewed" ] || return 10
            fence=$(jq -r .fence <<<"$prior"); acquired=$(jq -r .acquiredAt <<<"$prior")
        elif [ -n "$old" ]; then
            [ "$action" = acquire ] || return 10
            fence=$(( $(jq -r .fence <<<"$prior") + 1 )); acquired=$(date -u -d "@$now" +%Y-%m-%dT%H:%M:%SZ)
        fi
        observed=$(date -u -d "@$now" +%Y-%m-%dT%H:%M:%SZ); expires=$(date -u -d "@$((now+ttl))" +%Y-%m-%dT%H:%M:%SZ)
        record=$(jq -ncS --argjson sequence "$sequence" --arg holder "$holder" --argjson fence "$fence" --arg runtime "$runtime" --arg registry "$registry" --arg reviewed "$reviewed" --arg coordinationRepository "$repo" --arg acquired "$acquired" --arg observed "$observed" --arg expires "$expires" --argjson activation "$(jq -c '{epoch,digest,guardVersion}' <<<"$activation")" '{schema:1,type:"lease",sequence:$sequence,holder:$holder,fence:$fence,runtimeCommit:$runtime,registrySnapshotId:$registry,reviewedRegistryDigest:$reviewed,coordinationRepository:$coordinationRepository,activation:$activation,acquiredAt:$acquired,observedAt:$observed,expiresAt:$expires}')
        commit=$(_taskdag_comment_watchdog_append "$activation" "$old" "$record" "$holder" "$action") || return $?
        _taskdag_comment_watchdog_token "$commit" "$record" "$commit";;
      check)
        [ "$#" -eq 2 ] && [ "$1" = --token-file ] || return 2; taskdag_comment_watchdog_check_file "$2";;
      attempt)
        local token_file="" registry_file="" mode="" cycle="" token lease latest sequence observation now tip observed registry_json activation record commit
        while [ $# -gt 0 ]; do case "$1" in --token-file) token_file=$2; shift 2;; --registry-file) registry_file=$2; shift 2;; --mode) mode=$2; shift 2;; --cycle) cycle=$2; shift 2;; *) return 2;; esac; done
        [ -f "$token_file" ] && [ -f "$registry_file" ] && [[ "$mode" =~ ^(recent|complete)$ && "$cycle" =~ ^[0-9a-f]{64}$ ]] || return 2
        taskdag_comment_watchdog_check_file "$token_file" 30 || return 3; token=$(cat "$token_file"); lease=$(jq -cS .lease <<<"$token")
        [ "$(_taskdag_comment_watchdog_registry_digest "$registry_file")" = "$(jq -r .reviewedRegistryDigest <<<"$lease")" ] || return 3
        tip=$(jq -r .authorityTip <<<"$token"); latest=$(git show "$tip:$(git ls-tree -r --name-only "$tip")") || return 3; sequence=$(( $(jq -r .sequence <<<"$latest") + 1 ))
        observation=$(_taskdag_comment_watchdog_server_observation "$(jq -r .coordinationRepository <<<"$lease")") || return 3; IFS=$'\t' read -r now tip <<<"$observation"; [ "$tip" = "$(jq -r .authorityTip <<<"$token")" ] || return 3
        observed=$(date -u -d "@$now" +%Y-%m-%dT%H:%M:%SZ); registry_json=$(_taskdag_comment_watchdog_registry "$registry_file") || return 2
        record=$(jq -ncS --argjson lease "$lease" --argjson sequence "$sequence" --arg observed "$observed" --arg cycle "$cycle" --arg mode "$mode" --argjson registry "$registry_json" '$lease+{type:"attempt",sequence:$sequence,observedAt:$observed,cycle:$cycle,mode:$mode,registry:$registry}')
        activation=$(taskdag_activation_snapshot_token) || return 3; commit=$(_taskdag_comment_watchdog_append "$activation" "$(jq -r .authorityTip <<<"$token")" "$record" "$(jq -r .holder <<<"$lease")" attempt) || return $?
        _taskdag_comment_watchdog_token "$commit" "$lease" "$(jq -r .leaseCommit <<<"$token")";;
      result)
        local token_file="" result_file="" result_repo="" cycle="" token lease activation latest sequence observation now tip observed result record commit
        while [ $# -gt 0 ]; do case "$1" in --token-file) token_file=$2; shift 2;; --result-file) result_file=$2; shift 2;; --repository) result_repo=$2; shift 2;; --cycle) cycle=$2; shift 2;; *) return 2;; esac; done
        [ -f "$token_file" ] && [ -f "$result_file" ] && [[ "$result_repo" =~ ^[a-z0-9_.-]+/[a-z0-9_.-]+$ && "$cycle" =~ ^[0-9a-f]{64}$ ]] || return 2
        taskdag_comment_watchdog_check_file "$token_file" 15 || return 3
        token=$(cat "$token_file"); lease=$(jq -cS .lease <<<"$token"); tip=$(jq -r .authorityTip <<<"$token")
        latest=$(git show "$tip:$(git ls-tree -r --name-only "$tip")") || return 3; sequence=$(( $(jq -r .sequence <<<"$latest") + 1 ))
        result=$(jq -cS '{mode:.mode,status:.status,dryRun:.dry_run,exhausted:.exhausted,applied:.applied,deferred:.deferred,failures:.failures}' "$result_file") || return 2
        jq -e 'keys==["applied","deferred","dryRun","exhausted","failures","mode","status"]' <<<"$result" >/dev/null || return 2
        observation=$(_taskdag_comment_watchdog_server_observation "$(printf '%s' "$(_xrepo_current_repo)" | tr '[:upper:]' '[:lower:]')") || return 3
        IFS=$'\t' read -r now tip <<<"$observation"; [ "$tip" = "$(jq -r .authorityTip <<<"$token")" ] || return 3
        observed=$(date -u -d "@$now" +%Y-%m-%dT%H:%M:%SZ)
        [ "$observed" \< "$(jq -r .expiresAt <<<"$lease")" ] || return 3
        record=$(jq -ncS --argjson sequence "$sequence" --argjson lease "$lease" --arg observed "$observed" --arg repository "$result_repo" --arg cycle "$cycle" --argjson result "$result" '$lease + {type:"result",sequence:$sequence,observedAt:$observed,repository:$repository,cycle:$cycle,result:$result}') || return 2
        activation=$(taskdag_activation_snapshot_token) || return 3
        jq -e --argjson activation "$(jq -c '{epoch,digest,guardVersion}' <<<"$activation")" '.activation==$activation' <<<"$lease" >/dev/null || return 3
        commit=$(_taskdag_comment_watchdog_append "$activation" "$(jq -r .authorityTip <<<"$token")" "$record" "$(jq -r .holder <<<"$lease")" result) || return $?
        _taskdag_comment_watchdog_token "$commit" "$lease" "$(jq -r .leaseCommit <<<"$token")";;
      finish)
        local token_file="" registry_file="" mode="" cycle="" success=true token lease latest sequence observation now tip observed completed repositories activation record commit
        while [ $# -gt 0 ]; do case "$1" in --token-file) token_file=$2; shift 2;; --registry-file) registry_file=$2; shift 2;; --mode) mode=$2; shift 2;; --cycle) cycle=$2; shift 2;; --unsuccessful) success=false; shift;; *) return 2;; esac; done
        [ -f "$token_file" ] && [ -f "$registry_file" ] && [[ "$mode" =~ ^(recent|complete)$ && "$cycle" =~ ^[0-9a-f]{64}$ ]] || return 2
        taskdag_comment_watchdog_check_file "$token_file" 15 || return 3; token=$(cat "$token_file"); lease=$(jq -cS .lease <<<"$token")
        [ "$(_taskdag_comment_watchdog_registry_digest "$registry_file")" = "$(jq -r .reviewedRegistryDigest <<<"$lease")" ] || return 3
        tip=$(jq -r .authorityTip <<<"$token"); latest=$(git show "$tip:$(git ls-tree -r --name-only "$tip")") || return 3; sequence=$(( $(jq -r .sequence <<<"$latest") + 1 ))
        observation=$(_taskdag_comment_watchdog_server_observation "$(jq -r .coordinationRepository <<<"$lease")") || return 3; IFS=$'\t' read -r now tip <<<"$observation"; [ "$tip" = "$(jq -r .authorityTip <<<"$token")" ] || return 3
        observed=$(date -u -d "@$now" +%Y-%m-%dT%H:%M:%SZ); completed=$observed; repositories=$(_taskdag_comment_watchdog_registry "$registry_file" | jq -c '[.[].repository]') || return 2
        record=$(jq -ncS --argjson lease "$lease" --argjson sequence "$sequence" --arg observed "$observed" --arg completed "$completed" --arg cycle "$cycle" --arg mode "$mode" --argjson repositories "$repositories" --argjson success "$success" '$lease+{type:"fleet",sequence:$sequence,observedAt:$observed,completedAt:$completed,cycle:$cycle,mode:$mode,repositories:$repositories,success:$success}')
        activation=$(taskdag_activation_snapshot_token) || return 3; commit=$(_taskdag_comment_watchdog_append "$activation" "$(jq -r .authorityTip <<<"$token")" "$record" "$(jq -r .holder <<<"$lease")" finish) || return $?
        _taskdag_comment_watchdog_token "$commit" "$lease" "$(jq -r .leaseCommit <<<"$token")";;
      status)
        local remote last_attempt recent_success complete_success
        remote=$(git ls-remote --refs origin "$TASKDAG_COMMENT_WATCHDOG_REF") || return 2; [ -n "$remote" ] || return 3; remote=${remote%%[[:space:]]*}; git fetch -q origin "$remote" || return 2
        last_attempt=$(git show -s --format='%(trailers:key=Watchdog-Last-Attempt,valueonly)' "$remote")
        recent_success=$(git show -s --format='%(trailers:key=Watchdog-Recent-Success,valueonly)' "$remote")
        complete_success=$(git show -s --format='%(trailers:key=Watchdog-Complete-Success,valueonly)' "$remote")
        [ -n "$last_attempt" ] && [ -n "$recent_success" ] && [ -n "$complete_success" ] || return 3
        jq -ncS --arg tip "$remote" --arg last "$last_attempt" --arg recent "$recent_success" --arg complete "$complete_success" '{schema:1,authorityTip:$tip,lastAttempt:(if $last=="none" then null else {observedAt:$last} end),recentSuccess:(if $recent=="none" then null else {completedAt:$recent} end),completeSuccess:(if $complete=="none" then null else {completedAt:$complete} end)}';;
      *) echo 'Usage: task-dag comment-watchdog acquire|renew|check|attempt|result|finish|status ...'; [ "$action" = -h ] || [ "$action" = --help ] || [ -z "$action" ] || return 2;;
    esac
}
