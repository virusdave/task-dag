#!/usr/bin/env bash
# Canonical claim commit model: claim metadata construction, lease/liveness
# parsing, expiry, and claim-state predicates. Command adapters, CAS/readback,
# reaping, and structural containment remain with their feature consumers.

if ! declare -F parse_commit_metadata >/dev/null || ! declare -F extract_field >/dev/null \
    || ! declare -F get_task_title >/dev/null; then
    echo "Error: claim-model.sh requires git-objects.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi

task_is_claimed_on_remote() {
    local short_sha="$1"
    git ls-remote --exit-code origin "refs/heads/tasks/active/$short_sha" \
        >/dev/null 2>&1 && echo "yes" || echo "no"
}

taskdag_claim_message() { # task title claimer host pid claimed-at ttl note
    local task_sha=$1 task_title=$2 claimer=$3 claimer_host=$4 claimer_pid=$5
    local claimed_at=$6 ttl_hours=$7 note=$8
    printf 'Claim: %s\n\n' "$task_title"
    printf 'Task-Commit: %s\nClaimer: %s\nClaimer-Host: %s\n' \
        "$task_sha" "$claimer" "$claimer_host"
    [ -z "$claimer_pid" ] || printf 'Claimer-PID: %s\n' "$claimer_pid"
    printf 'Claimed-At: %s\nTTL-Hours: %s\n' "$claimed_at" "$ttl_hours"
    [ -z "$note" ] || printf 'Note: %s\n' "$note"
}

build_claim_commit() {
    local task_sha="$1" claimer="$2" claimer_host="$3" ttl_hours="$4" note="$5"
    local claimer_pid="$6" task_title task_tree now
    task_title=$(get_task_title "$task_sha")
    task_tree=$(git rev-parse "$task_sha^{tree}")
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    taskdag_claim_message "$task_sha" "$task_title" "$claimer" "$claimer_host" \
        "$claimer_pid" "$now" "$ttl_hours" "$note" \
        | git commit-tree "$task_tree" -p "$task_sha"
}

build_root_claim_commit() {
    local issue="$1" root_sha="$2" claimer="$3" claimer_host="$4"
    local ttl_hours="$5" note="$6" claimer_pid="$7"
    local root_title root_tree now claim_id
    root_title=$(get_task_title "$root_sha")
    root_tree=$(git rev-parse "$root_sha^{tree}")
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    claim_id=$(uuidgen 2>/dev/null || echo "$(date +%s%N)-$$-${RANDOM}")

    local msg="Claim: ${root_title}

Claim-Kind: root
"
    if [[ "$issue" =~ ^[1-9][0-9]*$ ]]; then
        msg="${msg}Issue: #${issue}
"
    else
        local digest=${issue#epic-v1/}
        [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
        msg="${msg}Epic-ID: epic-v1:${digest}
Root-Ref: refs/heads/tasks/pending/epic-v1/${digest}
"
    fi
    msg="${msg}Claim-ID: ${claim_id}
Task-Commit: ${root_sha}
Claimer: ${claimer}
Claimer-Host: ${claimer_host}"
    [ -z "$claimer_pid" ] || msg="${msg}
Claimer-PID: ${claimer_pid}"
    msg="${msg}
Claimed-At: ${now}
TTL-Hours: ${ttl_hours}"
    [ -z "$note" ] || msg="${msg}
Note: ${note}"
    git commit-tree "$root_tree" -p "$root_sha" -m "$msg"
}

# Validate the complete root-lock binding once for every root consumer. Typed
# locks carry the explicit protocol fields; legacy locks retain their exact
# historical bytes while still requiring the existing issue/task/path safety.
taskdag_validate_root_claim() { # locator-json root-sha claim-sha
    local locator=$1 root_sha=$2 claim_sha=$3 msg parent tree root_tree dialect expected field count
    git cat-file -e "$root_sha^{commit}" 2>/dev/null || return 1
    git cat-file -e "$claim_sha^{commit}" 2>/dev/null || return 1
    parent=$(git show -s --format=%P "$claim_sha" 2>/dev/null) || return 1
    [ "$parent" = "$root_sha" ] || return 1
    tree=$(git rev-parse "$claim_sha^{tree}" 2>/dev/null) || return 1
    root_tree=$(git rev-parse "$root_sha^{tree}" 2>/dev/null) || return 1
    [ "$tree" = "$root_tree" ] || return 1
    msg=$(parse_commit_metadata "$claim_sha" 2>/dev/null) || return 1
    for field in Claim-Kind Claim-ID Task-Commit Claimer Claimer-Host Claimed-At TTL-Hours; do
        count=$(grep -c "^${field}:" <<<"$msg")
        [ "$count" -eq 1 ] || return 1
        [ "$(grep -Ec "^${field}: [^ ]" <<<"$msg")" -eq 1 ] || return 1
    done
    count=$(grep -c '^Claimer-PID:' <<<"$msg")
    [ "$count" -le 1 ] || return 1
    [ "$count" -eq 0 ] || [ "$(grep -Ec '^Claimer-PID: [^ ]' <<<"$msg")" -eq 1 ] || return 1
    [ "$(extract_field "$msg" Task-Commit 2>/dev/null || true)" = "$root_sha" ] || return 1
    [ "$(extract_field "$msg" Claim-Kind 2>/dev/null || true)" = root ] || return 1
    # A reserved identity key with whitespace before ':' is not an unrelated
    # note: it is a malformed opposite-dialect field and must fail closed.
    ! grep -Eq '^(Issue|Epic-ID|Root-Ref)[[:space:]]+:' <<<"$msg" || return 1
    dialect=$(jq -r .dialect <<<"$locator") || return 1
    if [ "$dialect" = epic-v1 ]; then
        [ "$(grep -c '^Epic-ID:' <<<"$msg")" -eq 1 ] \
            && [ "$(grep -c '^Root-Ref:' <<<"$msg")" -eq 1 ] \
            && [ "$(grep -c '^Issue:' <<<"$msg")" -eq 0 ] || return 1
        [ "$(grep -Ec '^Epic-ID: [^ ]' <<<"$msg")" -eq 1 ] \
            && [ "$(grep -Ec '^Root-Ref: [^ ]' <<<"$msg")" -eq 1 ] || return 1
        expected=$(jq -r .epicId <<<"$locator") || return 1
        [ "$(extract_field "$msg" Epic-ID 2>/dev/null || true)" = "$expected" ] || return 1
        expected=$(jq -r .pendingRef <<<"$locator") || return 1
        [ "$(extract_field "$msg" Root-Ref 2>/dev/null || true)" = "$expected" ] || return 1
    else
        [ "$(grep -c '^Issue:' <<<"$msg")" -eq 1 ] \
            && [ "$(grep -c '^Epic-ID:' <<<"$msg")" -eq 0 ] \
            && [ "$(grep -c '^Root-Ref:' <<<"$msg")" -eq 0 ] || return 1
        [ "$(grep -Ec '^Issue: [^ ]' <<<"$msg")" -eq 1 ] || return 1
        expected=$(jq -r .issueNumber <<<"$locator") || return 1
        [ "$(extract_field "$msg" Issue 2>/dev/null || true)" = "#$expected" ] || return 1
    fi
}

# Positively validate the exact claim object a caller intends to consume.
# This is deliberately stricter than the historical completion/reaping readers:
# new multi-repository operations must bind ownership to one immutable claim OID,
# its task parent, and the complete process identity which won the claim.
taskdag_validate_source_claim() { # claim-oid task-oid claimer host pid
    local claim_oid=$1 task_oid=$2 expected_claimer=$3 expected_host=$4 expected_pid=$5
    local actual_oid msg task claimer host pid first tree task_tree parents
    [[ "$claim_oid" =~ ^[0-9a-f]{40}$|^[0-9a-f]{64}$ ]] || return 1
    [[ "$task_oid" =~ ^[0-9a-f]{40}$|^[0-9a-f]{64}$ ]] || return 1
    [ -n "$expected_claimer" ] && [ -n "$expected_host" ] \
        && [[ "$expected_pid" =~ ^[1-9][0-9]*$ ]] || return 1
    actual_oid=$(git rev-parse --verify "$claim_oid^{commit}" 2>/dev/null) || return 1
    [ "$actual_oid" = "$claim_oid" ] || return 1
    git cat-file -e "$task_oid^{commit}" 2>/dev/null || return 1
    parents=$(git show -s --format=%P "$claim_oid" 2>/dev/null) || return 1
    [ "$parents" = "$task_oid" ] || return 1
    first=$(get_first_parent "$claim_oid" 2>/dev/null) || return 1
    [ "$first" = "$task_oid" ] || return 1
    tree=$(git rev-parse "$claim_oid^{tree}" 2>/dev/null) || return 1
    task_tree=$(git rev-parse "$task_oid^{tree}" 2>/dev/null) || return 1
    [ "$tree" = "$task_tree" ] || return 1
    msg=$(parse_commit_metadata "$claim_oid" 2>/dev/null) || return 1
    for field in Task-Commit Claimer Claimer-Host Claimer-PID; do
        [ "$(awk -v key="$field" 'index($0,key ": ")==1{n++} END{print n+0}' <<<"$msg")" -eq 1 ] || return 1
    done
    task=$(extract_field "$msg" Task-Commit 2>/dev/null) || return 1
    claimer=$(extract_field "$msg" Claimer 2>/dev/null) || return 1
    host=$(extract_field "$msg" Claimer-Host 2>/dev/null) || return 1
    pid=$(extract_field "$msg" Claimer-PID 2>/dev/null) || return 1
    [ "$task" = "$task_oid" ] && [ "$claimer" = "$expected_claimer" ] \
        && [ "$host" = "$expected_host" ] && [ "$pid" = "$expected_pid" ]
}

# Validate a born claim including the fields which are intentionally not part
# of generic source-claim ownership.  Construction and replay both use
# build_claim_commit's canonical field contract.
taskdag_validate_born_claim() { # claim task claimer host pid ttl note
    local claim=$1 task=$2 claimer=$3 host=$4 pid=$5 ttl=$6 note=$7 msg claimed_at title actual expected
    taskdag_validate_source_claim "$claim" "$task" "$claimer" "$host" "$pid" || return 1
    msg=$(parse_commit_metadata "$claim") || return 1
    [ "$(grep -c '^Claimed-At:' <<<"$msg")" -eq 1 ] \
      && [[ "$(extract_field "$msg" Claimed-At)" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
      && [ "$(grep -c '^TTL-Hours:' <<<"$msg")" -eq 1 ] \
      && [ "$(extract_field "$msg" TTL-Hours)" = "$ttl" ] || return 1
    claimed_at=$(extract_field "$msg" Claimed-At) || return 1
    title=$(get_task_title "$task") || return 1
    actual=$(mktemp) || return 1; expected=$(mktemp) || { rm -f "$actual"; return 1; }
    git cat-file commit "$claim" | sed '1,/^$/d' >"$actual" \
        && taskdag_claim_message "$task" "$title" "$claimer" "$host" "$pid" \
            "$claimed_at" "$ttl" "$note" >"$expected" \
        && cmp -s "$actual" "$expected"
    local rc=$?; rm -f "$actual" "$expected"; return "$rc"
}

claim_dead_reason="none"

# Returns 0 dead, 1 alive, 2 indeterminate. TTL retains the historical
# five-minute grace period, and same-host PID evidence takes precedence.
claim_is_dead() {
    local claim_sha="$1" msg claimer_host claimer_pid claimed_at ttl_hours
    local this_host env_host pid_path_available=false ttl_path_available=false
    claim_dead_reason="none"
    msg=$(parse_commit_metadata "$claim_sha" 2>/dev/null || true)
    claimer_host=$(extract_field "$msg" "Claimer-Host" 2>/dev/null || true)
    claimer_pid=$(extract_field "$msg" "Claimer-PID" 2>/dev/null || true)
    claimed_at=$(extract_field "$msg" "Claimed-At" 2>/dev/null || true)
    ttl_hours=$(extract_field "$msg" "TTL-Hours" 2>/dev/null || true)
    this_host=$(hostname -s 2>/dev/null || echo unknown)
    env_host="${TASK_DAG_CLAIMER_HOST:-$this_host}"
    if { [ "$claimer_host" = "$this_host" ] || [ "$claimer_host" = "$env_host" ]; } \
        && [[ "$claimer_pid" =~ ^[1-9][0-9]*$ ]]; then
        pid_path_available=true
        kill -0 "$claimer_pid" 2>/dev/null && return 1
        local kill_err
        kill_err=$(kill -0 "$claimer_pid" 2>&1 >/dev/null || true)
        printf '%s' "$kill_err" | grep -qi 'Operation not permitted' && return 1
        if printf '%s' "$kill_err" | grep -qi 'No such process'; then
            claim_dead_reason="pid"; return 0
        fi
    fi
    if [ -n "$claimed_at" ] && [[ "$ttl_hours" =~ ^[0-9]+([.][0-9]+)?$ ]] \
        && awk "BEGIN { exit !($ttl_hours > 0) }"; then
        local claimed_epoch expiry_epoch now_epoch
        claimed_epoch=$(date -u -d "$claimed_at" +%s 2>/dev/null || true)
        if [ -n "$claimed_epoch" ]; then
            ttl_path_available=true
            expiry_epoch=$(awk "BEGIN { printf \"%.0f\", $claimed_epoch + ($ttl_hours * 3600) + 300 }")
            now_epoch=$(date -u +%s)
            if [ "$now_epoch" -gt "$expiry_epoch" ]; then claim_dead_reason="ttl"; return 0; fi
            return 1
        fi
    fi
    [ "$pid_path_available" = true ] || [ "$ttl_path_available" = true ] || return 2
    return 1
}
