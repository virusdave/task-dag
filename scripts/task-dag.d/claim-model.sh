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

build_claim_commit() {
    local task_sha="$1" claimer="$2" claimer_host="$3" ttl_hours="$4" note="$5"
    local claimer_pid="$6" task_title task_tree now
    task_title=$(get_task_title "$task_sha")
    task_tree=$(git rev-parse "$task_sha^{tree}")
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    local msg="Claim: ${task_title}

Task-Commit: ${task_sha}
Claimer: ${claimer}
Claimer-Host: ${claimer_host}"
    [ -z "$claimer_pid" ] || msg="${msg}
Claimer-PID: ${claimer_pid}"
    msg="${msg}
Claimed-At: ${now}
TTL-Hours: ${ttl_hours}"
    [ -z "$note" ] || msg="${msg}
Note: ${note}"
    git commit-tree "$task_tree" -p "$task_sha" -m "$msg"
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
Issue: #${issue}
Claim-ID: ${claim_id}
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
