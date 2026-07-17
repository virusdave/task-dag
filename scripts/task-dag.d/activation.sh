# shellcheck shell=bash
# Canonical semantic activation authority and fenced-writer protocol.

TASKDAG_ACTIVATION_REF="refs/heads/tasks/v1/activation"
TASKDAG_ACTIVATION_MAX_SPEC=262144

_taskdag_activation_error() { echo "Error: activation: $*" >&2; return 2; }
_taskdag_activation_digest_file() {
    local output
    output=$(sha256sum "$1") || return 1
    awk 'NF==2 && $1 ~ /^[0-9a-f]{64}$/ {print $1}' <<<"$output"
}
_taskdag_activation_full_checkout() {
    local repo=$1
    [ "$(git -C "$repo" rev-parse --is-shallow-repository 2>/dev/null)" = false ] &&
      [ -z "$(git -C "$repo" config --get extensions.partialClone 2>/dev/null)" ] &&
      ! git -C "$repo" config --get-regexp '^remote\..*\.promisor$' 2>/dev/null | grep -q ' true$'
}

_taskdag_activation_runtime_commit() {
    git -C "$TASKDAG_SCRIPT_DIR/.." rev-parse HEAD 2>/dev/null
}

_taskdag_activation_registry_id() {
    local file=$1
    printf 'sha256:%s\n' "$({ printf 'task-dag-activation-registry-v1\000'; jq -cS '{source,repositories}' "$file"; } | sha256sum | awk '{print $1}')"
}

_taskdag_activation_no_duplicate_keys() {
    _taskdag_materialise_no_duplicate_keys "$1"
}

_taskdag_activation_validate_spec_file() {
    local file=$1
    [ "$(wc -c <"$file")" -le "$TASKDAG_ACTIVATION_MAX_SPEC" ] || return 1
    jq -se 'length==1' "$file" >/dev/null 2>&1 || return 1
    _taskdag_activation_no_duplicate_keys "$file" || return 1
    jq -e '
      type=="object" and keys==["actor","authoritativeTimestamp","minimumCompatibleTaskDagCommit","registrySnapshot","sourceTips","state"]
    ' "$file" >/dev/null 2>&1 || return 1
    # Validate all untrusted fields and canonical registry identity before any
    # authority/network read by validating the prospective epoch-one record.
    local record
    record=$(mktemp) || return 1
    jq -cS '. + {schema:1,epoch:1,predecessor:null,guardVersion:1}' "$file" >"$record" \
      && _taskdag_activation_validate_record_file "$record" 1 null
    local rc=$?
    rm -f "$record"
    return "$rc"
}

_taskdag_activation_validate_record_file() {
    local file=$1 expected_epoch=${2:-} expected_predecessor=${3:-} registry id
    [ -f "$file" ] || return 1
    [ "$(wc -c <"$file")" -le "$TASKDAG_ACTIVATION_MAX_SPEC" ] || return 1
    jq -se 'length==1' "$file" >/dev/null 2>&1 || return 1
    _taskdag_activation_no_duplicate_keys "$file" || return 1
    jq -e '
      def text($n): type=="string" and length>0 and length<=$n and
        (test("[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]")|not);
      def oid: type=="string" and test("^([0-9a-f]{40}|[0-9a-f]{64})$");
      . as $record |
      type=="object" and keys==["actor","authoritativeTimestamp","epoch","guardVersion","minimumCompatibleTaskDagCommit","predecessor","registrySnapshot","schema","sourceTips","state"] and
      .schema==1 and (.state=="enabled" or .state=="disabled") and
      (.epoch|type=="number" and floor==. and .>=1 and .<=9007199254740991) and
      (.guardVersion==1) and (.minimumCompatibleTaskDagCommit|oid) and
      (.actor|text(256)) and
      (.authoritativeTimestamp|type=="string" and length==20 and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
      ((.authoritativeTimestamp|fromdateiso8601|todateiso8601)==.authoritativeTimestamp) and
      (if .epoch==1 then .predecessor==null else
        (.predecessor|type=="object" and keys==["digest","epoch"] and .epoch==($epoch-1) and (.digest|type=="string" and test("^[0-9a-f]{64}$"))) end) and
      (.registrySnapshot|type=="object" and keys==["id","repositories","schema","source"] and .schema==1 and
        (.id|type=="string" and test("^sha256:[0-9a-f]{64}$")) and
        (.source|type=="object" and keys==["blob","commit","path","repository"] and (.commit|oid) and (.blob|oid) and
          (.repository|text(128) and .==ascii_downcase and test("^[a-z0-9_.-]+/[a-z0-9_.-]+$")) and
          (.path|text(1024) and (startswith("/")|not) and (test("(^|/)\\.\\.?(/|$)|//|\\\\")|not))) and
        (.repositories|type=="array" and length>0 and length<=128 and .==(.|sort_by(.repository)) and
          (map(.repository)|length==(unique|length)) and (map(.repositoryId)|length==(unique|length)) and all(.[];
            type=="object" and keys==["name","repairBranch","repairMode","repository","repositoryId"] and
            (.repository|text(128) and .==ascii_downcase and test("^[a-z0-9_.-]+/[a-z0-9_.-]+$")) and
            (.repositoryId|text(128)) and (.name|text(128) and .==ascii_downcase) and .repairMode=="off" and .repairBranch==null))) and
      (.sourceTips|type=="array" and length>0 and length<=128 and .==(.|sort_by(.repository)) and
        (map(.repository)|length==(unique|length)) and all(.[]; type=="object" and keys==["commit","ref","repository","repositoryId"] and (.commit|oid) and
          (.ref|text(1024) and test("^refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]*$") and (test("//|(^|/)\\.\\.?(/|$)|\\.lock$|[~^:?*\\[]")|not)) and
          (.repositoryId|text(128)) and (.repository|text(128) and .==ascii_downcase and test("^[a-z0-9_.-]+/[a-z0-9_.-]+$")))) and
      ((.sourceTips|map({repository,repositoryId})) == (.registrySnapshot.repositories|map({repository,repositoryId}))) and
      ([.sourceTips[]|select(.repository=="virusdave/task-dag")]|length==1)
    ' --argjson epoch "$(jq -r .epoch "$file" 2>/dev/null || echo 0)" "$file" >/dev/null 2>&1 || return 1
    [ -z "$expected_epoch" ] || [ "$(jq -r .epoch "$file")" = "$expected_epoch" ] || return 1
    if [ -n "$expected_predecessor" ]; then
        jq -e --argjson predecessor "$expected_predecessor" '.predecessor==$predecessor' "$file" >/dev/null || return 1
    fi
    registry=$(mktemp) || return 1
    jq -cS '.registrySnapshot' "$file" >"$registry" || { rm -f "$registry"; return 1; }
    id=$(_taskdag_activation_registry_id "$registry"); rm -f "$registry"
    [ "$id" = "$(jq -r .registrySnapshot.id "$file")" ] || return 1
    git -C "$TASKDAG_SCRIPT_DIR/.." cat-file -e "$(jq -r .minimumCompatibleTaskDagCommit "$file")^{commit}" 2>/dev/null || return 1
    git -C "$TASKDAG_SCRIPT_DIR/.." cat-file -e "$(jq -r '.sourceTips[]|select(.repository=="virusdave/task-dag")|.commit' "$file")^{commit}" 2>/dev/null || return 1
    git -C "$TASKDAG_SCRIPT_DIR/.." merge-base --is-ancestor "$(jq -r .minimumCompatibleTaskDagCommit "$file")" "$(jq -r '.sourceTips[]|select(.repository=="virusdave/task-dag")|.commit' "$file")" || return 1
}

_taskdag_activation_guard_message() {
    local authority=$1 active=$2 epoch=$3 digest=$4 guard_version=$5 writer=$6 operation=$7 actor=$8 timestamp=$9 updates=${10}
    jq -e 'type=="array" and length>0 and .==(.|sort_by(.ref)) and (map(.ref)|length==(unique|length)) and all(.[]; keys==["new","old","ref"] and (.ref|test("^refs/heads/")) and ((.old=="") or (.old|test("^([0-9a-f]{40}|[0-9a-f]{64})$"))) and (.new|test("^([0-9a-f]{40}|[0-9a-f]{64})$")))' <<<"$updates" >/dev/null || return 2
    printf 'Task-Dag-Activation-Guard: v1\nActivation-Epoch: %s\nActivation-Record-Digest: %s\nGuard-Version: %s\nActivation-Commit: %s\nExpected-Authority-Tip: %s\nWriter-Class: %s\nOperation: %s\nActor: %s\nAuthoritative-Timestamp: %s\nTarget-Updates: %s\n' \
      "$epoch" "$digest" "$guard_version" "$active" "$authority" "$writer" "$operation" "$actor" "$timestamp" "$(jq -cS . <<<"$updates")"
}

_taskdag_activation_parse_guard() {
    local tip=$1 active=$2 expected_epoch=${3:-} expected_digest=${4:-} tree msg authority updates canonical epoch digest version activation writer operation actor timestamp
    [ "$(git rev-list --parents -1 "$tip" 2>/dev/null | wc -w)" -eq 2 ] || return 1
    [ "$(git rev-parse "$tip^")" = "$active" ] || return 1
    [ "$(git rev-parse "$tip^{tree}")" = "$(git rev-parse "$active^{tree}")" ] || return 1
    msg=$(git log -1 --format=%B "$tip") || return 1
    [ "$(grep -c '^Task-Dag-Activation-Guard: v1$' <<<"$msg")" -eq 1 ] || return 1
    epoch=$(sed -n 's/^Activation-Epoch: //p' <<<"$msg"); digest=$(sed -n 's/^Activation-Record-Digest: //p' <<<"$msg")
    version=$(sed -n 's/^Guard-Version: //p' <<<"$msg"); activation=$(sed -n 's/^Activation-Commit: //p' <<<"$msg")
    authority=$(sed -n 's/^Expected-Authority-Tip: //p' <<<"$msg")
    writer=$(sed -n 's/^Writer-Class: //p' <<<"$msg"); operation=$(sed -n 's/^Operation: //p' <<<"$msg"); actor=$(sed -n 's/^Actor: //p' <<<"$msg"); timestamp=$(sed -n 's/^Authoritative-Timestamp: //p' <<<"$msg")
    updates=$(sed -n 's/^Target-Updates: //p' <<<"$msg")
    [[ "$authority" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] && [ "$activation" = "$active" ] && [ "$version" = 1 ] || return 1
    [[ "$epoch" =~ ^[1-9][0-9]*$ ]] && [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
    [ -z "$expected_epoch" ] || [ "$epoch" = "$expected_epoch" ] || return 1
    [ -z "$expected_digest" ] || [ "$digest" = "$expected_digest" ] || return 1
    [[ "$writer" =~ ^[A-Za-z0-9._-]{1,128}$ ]] && [[ "$operation" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || return 1
    [[ -n "$actor" && ${#actor} -le 256 && ! "$actor" =~ [[:cntrl:]] ]] || return 1
    jq -ne --arg actor "$actor" '$actor|test("[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]")|not' >/dev/null || return 1
    [[ "$timestamp" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
    jq -ne --arg timestamp "$timestamp" '($timestamp|fromdateiso8601|todateiso8601)==$timestamp' >/dev/null 2>&1 || return 1
    jq -e 'type=="array" and length>0 and .==(.|sort_by(.ref)) and (map(.ref)|length==(unique|length)) and all(.[]; keys==["new","old","ref"] and (.ref|test("^refs/heads/")) and (.old=="" or (.old|test("^([0-9a-f]{40}|[0-9a-f]{64})$"))) and (.new|test("^([0-9a-f]{40}|[0-9a-f]{64})$")))' <<<"$updates" >/dev/null 2>&1 || return 1
    canonical=$(_taskdag_activation_guard_message "$authority" "$active" "$epoch" "$digest" "$version" "$writer" "$operation" "$actor" "$timestamp" "$updates") || return 1
    [ "$msg" = "${canonical%$'\n'}" ] || return 1
}

# Prints: active-commit authority-tip record-path record-digest.  A guard tip
# is accepted only in the one replaceable shape owned above.
taskdag_activation_validate_history() {
    local tip=$1 tmp previous="" commit epoch=0 path prior_path record digest pred active authority_tip count tree old_floor new_floor
    authority_tip=$tip
    _taskdag_activation_full_checkout . || return 1
    git rev-list --parents "$tip" >/dev/null 2>&1 || return 1
    active=$tip
    if git log -1 --format=%B "$tip" | grep -qx 'Task-Dag-Activation-Guard: v1'; then
        active=$(git rev-parse "$tip^") || return 1
        tmp=$(mktemp -d) || return 1
        git ls-tree --name-only "$active:records" >"$tmp/guard-paths" || { rm -rf "$tmp"; return 1; }
        path=$(printf 'records/%016d.json' "$(wc -l <"$tmp/guard-paths")")
        git show "$active:$path" >"$tmp/guard-record" || { rm -rf "$tmp"; return 1; }
        epoch=$(jq -r .epoch "$tmp/guard-record") || { rm -rf "$tmp"; return 1; }
        digest=$(_taskdag_activation_digest_file "$tmp/guard-record") || { rm -rf "$tmp"; return 1; }
        rm -rf "$tmp"
        _taskdag_activation_parse_guard "$tip" "$active" "$epoch" "$digest" || return 1
    fi
    epoch=0
    tmp=$(mktemp -d) || return 1
    git rev-list --reverse --first-parent "$active" >"$tmp/commits" || { rm -rf "$tmp"; return 1; }
    while IFS= read -r commit; do
        epoch=$((epoch+1)); path=$(printf 'records/%016d.json' "$epoch")
        count=$(git rev-list --parents -1 "$commit" | wc -w)
        if [ -z "$previous" ]; then [ "$count" -eq 1 ] || { rm -rf "$tmp"; return 1; }
        else [ "$(git rev-parse "$commit^")" = "$previous" ] && [ "$count" -eq 2 ] || { rm -rf "$tmp"; return 1; }; fi
        git ls-tree -r --name-only "$commit" >"$tmp/paths" || { rm -rf "$tmp"; return 1; }
        [ "$(wc -l <"$tmp/paths")" -eq "$epoch" ] || { rm -rf "$tmp"; return 1; }
        seq -f 'records/%016g.json' 1 "$epoch" >"$tmp/expected-paths" || { rm -rf "$tmp"; return 1; }
        diff -u "$tmp/expected-paths" "$tmp/paths" >/dev/null || { rm -rf "$tmp"; return 1; }
        git show "$commit:$path" >"$tmp/record" || { rm -rf "$tmp"; return 1; }
        jq -cS . "$tmp/record" >"$tmp/canonical-record" || { rm -rf "$tmp"; return 1; }
        cmp -s "$tmp/record" "$tmp/canonical-record" || { rm -rf "$tmp"; return 1; }
        pred=null; [ -z "$previous" ] || pred=$(jq -nc --argjson epoch "$((epoch-1))" --arg digest "$digest" '{epoch:$epoch,digest:$digest}')
        _taskdag_activation_validate_record_file "$tmp/record" "$epoch" "$pred" || { rm -rf "$tmp"; return 1; }
        if [ -n "$previous" ]; then
            head -n -1 "$tmp/paths" >"$tmp/prior-paths" || { rm -rf "$tmp"; return 1; }
            while IFS= read -r prior_path; do
                git diff --quiet "$previous" "$commit" -- "$prior_path" || { rm -rf "$tmp"; return 1; }
            done <"$tmp/prior-paths"
            old_floor=$(git show "$previous:$(printf 'records/%016d.json' "$((epoch-1))")" | jq -r .minimumCompatibleTaskDagCommit) || { rm -rf "$tmp"; return 1; }
            new_floor=$(jq -r .minimumCompatibleTaskDagCommit "$tmp/record")
            git -C "$TASKDAG_SCRIPT_DIR/.." merge-base --is-ancestor "$old_floor" "$new_floor" || { rm -rf "$tmp"; return 1; }
        fi
        digest=$(_taskdag_activation_digest_file "$tmp/record") || { rm -rf "$tmp"; return 1; }
        previous=$commit
    done <"$tmp/commits"
    [ "$epoch" -gt 0 ] || { rm -rf "$tmp"; return 1; }
    record=$(cat "$tmp/record"); tree=$(git rev-parse "$active^{tree}"); rm -rf "$tmp"
    [ -n "$tree" ] || return 1
    printf '%s\t%s\t%s\t%s\n' "$active" "$authority_tip" "$path" "$digest"
}

# Validate a materialisation provenance tuple against one explicitly supplied,
# already fetched activation authority. No ambient ref is consulted.
taskdag_activation_validate_provenance() { # <authority-tip> <tuple-json>
    local authority=$1 tuple=$2 info active path epoch commit record digest
    jq -e 'type=="object" and keys==["digest","epoch","guardVersion"] and
      (.epoch|type=="number" and floor==. and .>=1 and .<=9007199254740991) and
      (.digest|type=="string" and test("^[0-9a-f]{64}$")) and .guardVersion==1' <<<"$tuple" >/dev/null 2>&1 || return 1
    info=$(taskdag_activation_validate_history "$authority") || return 1
    IFS=$'\t' read -r active _ path _ <<<"$info"
    epoch=$(jq -r .epoch <<<"$tuple")
    commit=$(git rev-list --reverse --first-parent "$active" | sed -n "${epoch}p")
    [ -n "$commit" ] || return 1
    path=$(printf 'records/%016d.json' "$epoch")
    record=$(mktemp) || return 1
    git show "$commit:$path" >"$record" || { rm -f "$record"; return 1; }
    digest=$(_taskdag_activation_digest_file "$record") || { rm -f "$record"; return 1; }
    [ "$(jq -r .state "$record" 2>/dev/null)" = enabled ] || { rm -f "$record"; return 1; }
    rm -f "$record"
    [ "$digest" = "$(jq -r .digest <<<"$tuple")" ]
}

_taskdag_activation_classify_candidate() { # <candidate> <exact-record-file>
    local candidate=$1 wanted=$2 now info active path actual
    now=$(_taskdag_activation_fetch_authority) || return 2
    [ -n "$now" ] || return 3
    info=$(taskdag_activation_validate_history "$now") || return 3
    IFS=$'\t' read -r active _ path _ <<<"$info"
    if git merge-base --is-ancestor "$candidate" "$active" 2>/dev/null; then
        path=$(printf 'records/%016d.json' "$(jq -r .epoch "$wanted")")
        actual=$(mktemp) || return 2
        git show "$candidate:$path" >"$actual" 2>/dev/null && cmp -s "$wanted" "$actual"
        local rc=$?; rm -f "$actual"
        [ "$rc" -eq 0 ] && return 0
    fi
    # A concurrent identical writer may have won with another commit identity.
    actual=$(mktemp) || return 2
    git show "$active:$path" >"$actual" 2>/dev/null || { rm -f "$actual"; return 3; }
    jq -e --argjson wanted "$(jq -c 'del(.schema,.epoch,.predecessor,.guardVersion)' "$wanted")" \
      'del(.schema,.epoch,.predecessor,.guardVersion)==$wanted' "$actual" >/dev/null 2>&1
    local rc=$?; rm -f "$actual"
    [ "$rc" -eq 0 ] && return 0
    return 3
}

_taskdag_activation_fetch_authority() {
    local remote old
    remote=$(git ls-remote --refs origin "$TASKDAG_ACTIVATION_REF") || return 2
    old=${remote%%[[:space:]]*}; [ "$remote" != "$old" ] || old=""
    if [ -n "$old" ]; then
        if declare -F taskdag_activation_test_after_ls_remote_hook >/dev/null; then
            taskdag_activation_test_after_ls_remote_hook || return $?
        fi
        git fetch -q --no-tags origin "$TASKDAG_ACTIVATION_REF" || return 2
        # FETCH_HEAD is the coherent authority snapshot. The ref may advance
        # after ls-remote; rejecting that valid successor would prevent the
        # ancestry classifier from proving an already accepted candidate.
        old=$(git rev-parse FETCH_HEAD) || return 2
    fi
    printf '%s\n' "$old"
}

taskdag_activation_snapshot_token() {
    local tip info active authority path digest record runtime epoch
    tip=$(_taskdag_activation_fetch_authority) || return $?
    [ -n "$tip" ] || return 3
    info=$(taskdag_activation_validate_history "$tip") || return 3
    IFS=$'\t' read -r active authority path digest <<<"$info"
    record=$(git show "$active:$path") || return 3
    [ "$(jq -r .state <<<"$record")" = enabled ] || return 3
    runtime=$(_taskdag_activation_runtime_commit) || return 3
    _taskdag_activation_full_checkout "$TASKDAG_SCRIPT_DIR/.." || return 3
    git -C "$TASKDAG_SCRIPT_DIR/.." merge-base --is-ancestor "$(jq -r .minimumCompatibleTaskDagCommit <<<"$record")" "$runtime" || return 3
    epoch=$(jq -r .epoch <<<"$record")
    jq -ncS --arg origin "$(git remote get-url origin)" --argjson epoch "$epoch" --arg digest "$digest" --arg activationCommit "$active" --arg authorityTip "$authority" --arg state enabled --argjson guardVersion 1 --arg minimumCompatibleTaskDagCommit "$(jq -r .minimumCompatibleTaskDagCommit <<<"$record")" --arg runtimeCommit "$runtime" \
      '{activationCommit:$activationCommit,authorityTip:$authorityTip,digest:$digest,epoch:$epoch,guardVersion:$guardVersion,minimumCompatibleTaskDagCommit:$minimumCompatibleTaskDagCommit,origin:$origin,runtimeCommit:$runtimeCommit,state:$state}'
}

_taskdag_activation_authority_token() {
    local tip info active authority path digest record
    tip=$(_taskdag_activation_fetch_authority) || return $?; [ -n "$tip" ] || return 3
    info=$(taskdag_activation_validate_history "$tip") || return 3
    IFS=$'\t' read -r active authority path digest <<<"$info"; record=$(git show "$active:$path") || return 3
    jq -ncS --argjson record "$record" --arg activationCommit "$active" --arg authorityTip "$authority" --arg digest "$digest" '{activationCommit:$activationCommit,authorityTip:$authorityTip,digest:$digest,record:$record}'
}

taskdag_activation_fenced_push() { # <token-json> <writer> <operation> <actor> <timestamp> <target-ref> <old> <new>
    local token=$1 writer=$2 operation=$3 actor=$4 timestamp=$5 target=$6 old=$7 new=$8 current active tree guard updates message info authority path digest record origin
    jq -e 'def oid: type=="string" and test("^([0-9a-f]{40}|[0-9a-f]{64})$");
      type=="object" and keys==["activationCommit","authorityTip","digest","epoch","guardVersion","minimumCompatibleTaskDagCommit","origin","runtimeCommit","state"] and
      (.activationCommit|oid) and (.authorityTip|oid) and (.runtimeCommit|oid) and
      (.minimumCompatibleTaskDagCommit|oid) and (.digest|type=="string" and test("^[0-9a-f]{64}$")) and
      (.epoch|type=="number" and floor==. and .>=1 and .<=9007199254740991) and .guardVersion==1 and
      .state=="enabled" and (.origin|type=="string" and length>0)' <<<"$token" >/dev/null 2>&1 || return 3
    origin=$(git remote get-url origin) || return 2
    [ "$(jq -r .origin <<<"$token")" = "$origin" ] || return 3
    current=$(_taskdag_activation_fetch_authority) || return 2
    info=$(taskdag_activation_validate_history "$current") || return 3
    IFS=$'\t' read -r active authority path digest <<<"$info"
    record=$(git show "$active:$path") || return 3
    jq -e --arg active "$active" --arg authority "$authority" --arg digest "$digest" --arg origin "$origin" --argjson record "$record" '
      .activationCommit==$active and .authorityTip==$authority and .digest==$digest and .origin==$origin and
      .epoch==$record.epoch and .guardVersion==$record.guardVersion and .state==$record.state and
      .minimumCompatibleTaskDagCommit==$record.minimumCompatibleTaskDagCommit' <<<"$token" >/dev/null || return 3
    tree=$(git rev-parse "$active^{tree}") || return 3
    updates=$(jq -ncS --arg ref "$target" --arg old "$old" --arg new "$new" '[{ref:$ref,old:$old,new:$new}]')
    message=$(_taskdag_activation_guard_message "$current" "$active" "$(jq -r .epoch <<<"$token")" "$(jq -r .digest <<<"$token")" "$(jq -r .guardVersion <<<"$token")" "$writer" "$operation" "$actor" "$timestamp" "$updates") || return 2
    guard=$(printf '%s' "$message" | git commit-tree "$tree" -p "$active") || return 2
    _taskdag_activation_parse_guard "$guard" "$active" "$(jq -r .epoch <<<"$token")" "$(jq -r .digest <<<"$token")" || return 3
    if git push -q --atomic origin --force-with-lease="$TASKDAG_ACTIVATION_REF:$current" --force-with-lease="$target:$old" "$guard:$TASKDAG_ACTIVATION_REF" "$new:$target" 2>/dev/null; then
        [ "$(_taskdag_activation_fetch_authority)" = "$guard" ] || return 3
        [ "$(git ls-remote --refs origin "$target" | awk '{print $1}')" = "$new" ] || return 3
        return 0
    fi
    # Failure is classified by authoritative state; never retry blindly.
    [ "$(_taskdag_activation_fetch_authority 2>/dev/null || true)" = "$guard" ] \
      && [ "$(git ls-remote --refs origin "$target" 2>/dev/null | awk '{print $1}')" = "$new" ] && return 0
    return 3
}

cmd_activation_apply() {
    local spec="" tmp snapshot old info active path digest epoch predecessor record index tree commit now existing spec_fd
    case "${1:-}" in -h|--help) echo "Usage: task-dag activation apply --spec-file FILE"; return 0;; esac
    [ "$#" -eq 2 ] && [ "$1" = --spec-file ] && spec=$2 || { echo "Usage: task-dag activation apply --spec-file FILE" >&2; return 2; }
    [ -f "$spec" ] && [ ! -L "$spec" ] || { _taskdag_activation_error "--spec-file must name a regular non-symlink file"; return 2; }
    tmp=$(mktemp -d) || return 2; snapshot="$tmp/spec"
    exec {spec_fd}<"$spec" || { rm -rf "$tmp"; return 2; }
    [ "$(realpath -e -- "/proc/self/fd/$spec_fd" 2>/dev/null)" = "$(realpath -e -- "$spec" 2>/dev/null)" ] \
      || { exec {spec_fd}<&-; rm -rf "$tmp"; _taskdag_activation_error "spec file changed during secure open"; return 2; }
    cat <&$spec_fd >"$snapshot" || { exec {spec_fd}<&-; rm -rf "$tmp"; return 2; }
    exec {spec_fd}<&-
    _taskdag_activation_validate_spec_file "$snapshot" \
      || { rm -rf "$tmp"; _taskdag_activation_error "unsupported spec shape, value, or bound"; return 2; }
    old=$(_taskdag_activation_fetch_authority) || { rm -rf "$tmp"; return 2; }
    epoch=1; predecessor=null; active=""
    if [ -n "$old" ]; then
        info=$(taskdag_activation_validate_history "$old") || { rm -rf "$tmp"; return 3; }
        IFS=$'\t' read -r active _ path digest <<<"$info"
        epoch=$(( $(git show "$active:$path" | jq -r .epoch) + 1 ))
        predecessor=$(jq -nc --argjson epoch "$((epoch-1))" --arg digest "$digest" '{epoch:$epoch,digest:$digest}')
    fi
    record="$tmp/record"
    jq -cS --argjson epoch "$epoch" --argjson predecessor "$predecessor" '. + {schema:1,epoch:$epoch,predecessor:$predecessor,guardVersion:1}' "$snapshot" >"$record" || { rm -rf "$tmp"; return 2; }
    _taskdag_activation_validate_record_file "$record" "$epoch" "$predecessor" || { rm -rf "$tmp"; _taskdag_activation_error "invalid activation record"; return 2; }
    if [ -n "$active" ]; then
        existing=$(git show "$active:$path")
        # Same desired state/provenance is an idempotent success.
        if jq -e --argjson wanted "$(jq -c 'del(.schema,.epoch,.predecessor,.guardVersion)' "$record")" 'del(.schema,.epoch,.predecessor,.guardVersion)==$wanted' <<<"$existing" >/dev/null; then
            cmd_activation_status --json; rm -rf "$tmp"; return 0
        fi
        git -C "$TASKDAG_SCRIPT_DIR/.." merge-base --is-ancestor "$(jq -r .minimumCompatibleTaskDagCommit <<<"$existing")" "$(jq -r .minimumCompatibleTaskDagCommit "$record")" || { rm -rf "$tmp"; _taskdag_activation_error "minimum compatible commit cannot move backward"; return 3; }
    fi
    index="$tmp/index"; GIT_INDEX_FILE="$index" git read-tree "${active:-$(git mktree </dev/null)}"
    path=$(printf 'records/%016d.json' "$epoch")
    GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "100644,$(git hash-object -w "$record"),$path"
    tree=$(GIT_INDEX_FILE="$index" git write-tree)
    if [ -n "$active" ]; then commit=$(printf 'Advance semantic activation to epoch %d\n' "$epoch" | git commit-tree "$tree" -p "$active"); else commit=$(printf 'Create semantic activation epoch 1\n' | git commit-tree "$tree"); fi
    taskdag_activation_validate_history "$commit" >/dev/null || { rm -rf "$tmp"; return 3; }
    if declare -F taskdag_activation_test_pre_cas_hook >/dev/null; then taskdag_activation_test_pre_cas_hook "$commit" "$record" || { local rc=$?; rm -rf "$tmp"; return "$rc"; }; fi
    if ! git push -q origin --force-with-lease="$TASKDAG_ACTIVATION_REF:$old" "$commit:$TASKDAG_ACTIVATION_REF" 2>/dev/null; then
        _taskdag_activation_classify_candidate "$commit" "$record" || { local rc=$?; rm -rf "$tmp"; return "$rc"; }
        rm -rf "$tmp"; cmd_activation_status --json; return 0
    fi
    # A sourced fixture may simulate either a transport that reported failure
    # after acceptance or a successor landing before readback. Both paths use
    # the same authoritative classifier; public CLI environment cannot select
    # a bypass.
    if declare -F taskdag_activation_test_after_accepted_hook >/dev/null; then
        taskdag_activation_test_after_accepted_hook "$commit" "$record" || :
    fi
    _taskdag_activation_classify_candidate "$commit" "$record" || { local rc=$?; rm -rf "$tmp"; return "$rc"; }
    rm -rf "$tmp"; cmd_activation_status --json
}

cmd_activation_status() {
    local tip info active authority path digest record
    case "${1:-}" in -h|--help) echo "Usage: task-dag activation status --json"; return 0;; esac
    [ "$#" -eq 1 ] && [ "$1" = --json ] || { echo "Usage: task-dag activation status --json" >&2; return 2; }
    tip=$(_taskdag_activation_fetch_authority) || return 2
    [ -n "$tip" ] || { jq -ncS '{present:false}'; return 0; }
    info=$(taskdag_activation_validate_history "$tip") || return 3
    IFS=$'\t' read -r active authority path digest <<<"$info"; record=$(git show "$active:$path") || return 3
    jq -ncS --argjson record "$record" --arg activationCommit "$active" --arg authorityTip "$authority" --arg digest "$digest" '{activationCommit:$activationCommit,authorityTip:$authorityTip,digest:$digest,present:true,record:$record}'
}

cmd_activation_check_compatible() {
    local candidate="" token
    case "${1:-}" in -h|--help) echo "Usage: task-dag activation check-compatible --candidate-task-dag-commit COMMIT"; return 0;; esac
    [ "$#" -eq 2 ] && [ "$1" = --candidate-task-dag-commit ] && candidate=$2 || { echo "Usage: task-dag activation check-compatible --candidate-task-dag-commit COMMIT" >&2; return 2; }
    _taskdag_activation_full_checkout "$TASKDAG_SCRIPT_DIR/.." || return 3
    candidate=$(git -C "$TASKDAG_SCRIPT_DIR/.." rev-parse "$candidate^{commit}" 2>/dev/null) || return 2
    token=$(_taskdag_activation_authority_token) || return $?
    git -C "$TASKDAG_SCRIPT_DIR/.." merge-base --is-ancestor "$(jq -r .record.minimumCompatibleTaskDagCommit <<<"$token")" "$candidate" || return 3
    jq -ncS --arg candidate "$candidate" --argjson activation "$token" '{activation:$activation,candidateTaskDagCommit:$candidate,compatible:true}'
}

cmd_activation() {
    local sub=${1:-}; [ "$#" -gt 0 ] && shift
    case "$sub" in
      apply) cmd_activation_apply "$@" ;;
      status) cmd_activation_status "$@" ;;
      check-compatible) cmd_activation_check_compatible "$@" ;;
      -h|--help|help|'') echo "Usage: task-dag activation apply|status|check-compatible ..." ;;
      *) echo "Usage: task-dag activation apply|status|check-compatible ..." >&2; return 2 ;;
    esac
}
