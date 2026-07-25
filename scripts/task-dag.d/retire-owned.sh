#!/usr/bin/env bash
# Canonical process-owned claim retirement. This is the sole API used by
# dispatchers to release or park claims they own; callers never inspect claim
# commits or write scheduling refs themselves.

taskdag_retire_owned_validate_leaf() { # claim task claimer host pid
    local claim=$1 task=$2 claimer=$3 host=$4 pid=$5 msg field
    taskdag_validate_source_claim "$claim" "$task" "$claimer" "$host" "$pid" || return 1
    msg=$(parse_commit_metadata "$claim") || return 1
    [[ "$(git log -1 --format=%s "$claim")" = Claim:* ]] || return 1
    for field in Claimed-At TTL-Hours; do
        [ "$(grep -c "^${field}: [^ ]" <<<"$msg")" -eq 1 ] || return 1
    done
    ! grep -Eq '^(Claim-Kind|Claim-ID|Issue|Epic-ID|Root-Ref)[[:space:]]*:' <<<"$msg"
}

taskdag_retire_owned_identity_matches() { # claim claimer host pid
    local msg
    msg=$(parse_commit_metadata "$1" 2>/dev/null) || return 1
    [ "$(extract_field "$msg" Claimer 2>/dev/null || true)" = "$2" ] \
        && [ "$(extract_field "$msg" Claimer-Host 2>/dev/null || true)" = "$3" ] \
        && [ "$(extract_field "$msg" Claimer-PID 2>/dev/null || true)" = "$4" ]
}

taskdag_retire_owned_has_foreign_identity() { # claim claimer host pid
    local msg actual_claimer actual_host actual_pid
    msg=$(parse_commit_metadata "$1" 2>/dev/null) || return 1
    actual_claimer=$(extract_field "$msg" Claimer 2>/dev/null || true)
    actual_host=$(extract_field "$msg" Claimer-Host 2>/dev/null || true)
    actual_pid=$(extract_field "$msg" Claimer-PID 2>/dev/null || true)
    [ -n "$actual_claimer" ] && [ -n "$actual_host" ] && [[ "$actual_pid" =~ ^[1-9][0-9]*$ ]] \
        && { [ "$actual_claimer" != "$2" ] || [ "$actual_host" != "$3" ] || [ "$actual_pid" != "$4" ]; }
}

taskdag_retire_owned_reconcile_push() { # updates-json; echoes applied|unchanged|diverged|unreadable
    local updates=$1 refs=() advertisement i count ref old new actual all_new=true all_old=true
    count=$(jq 'length' <<<"$updates") || { echo unreadable; return; }
    for ((i=0; i<count; i++)); do refs+=("$(jq -r ".[${i}].ref" <<<"$updates")"); done
    advertisement=$(git ls-remote origin "${refs[@]}" 2>/dev/null) || { echo unreadable; return; }
    for ((i=0; i<count; i++)); do
        ref=$(jq -r ".[${i}].ref" <<<"$updates")
        old=$(jq -r ".[${i}].old" <<<"$updates")
        new=$(jq -r ".[${i}].new" <<<"$updates")
        actual=$(awk -v wanted="$ref" '$2==wanted {print $1}' <<<"$advertisement")
        [ "$actual" = "$new" ] || all_new=false
        [ "$actual" = "$old" ] || all_old=false
    done
    if [ "$all_new" = true ]; then echo applied
    elif [ "$all_old" = true ]; then echo unchanged
    else echo diverged
    fi
}

taskdag_retire_owned_one() { # kind ref claim task locator action claimer host pid
    local kind=$1 active_ref=$2 claim=$3 task=$4 locator=$5 action=$6 claimer=$7 host=$8 pid=$9
    local outcome=retired blocked_ref="" frontier_ref="" remote_blocked="" updates readback rc=0

    if [ "$kind" = leaf ]; then
        taskdag_retire_owned_validate_leaf "$claim" "$task" "$claimer" "$host" "$pid" \
            || outcome=malformed-claim
    else
        taskdag_validate_root_claim "$locator" "$task" "$claim" \
            && taskdag_retire_owned_identity_matches "$claim" "$claimer" "$host" "$pid" \
            || outcome=malformed-claim
    fi
    if [ "$outcome" = malformed-claim ] \
        && taskdag_retire_owned_has_foreign_identity "$claim" "$claimer" "$host" "$pid"; then
        outcome=foreign-claim
    fi
    if [ "$outcome" = retired ]; then
        readback=$(git ls-remote origin "$active_ref" 2>/dev/null) || outcome=origin-unreadable
        [ "$outcome" != retired ] || [ "$(awk '{print $1; exit}' <<<"$readback")" = "$claim" ] \
            || outcome=claim-changed
    fi

    if [ "$outcome" = retired ]; then
        updates=$(jq -ncS --arg ar "$active_ref" --arg ao "$claim" \
            '[{ref:$ar,old:$ao,new:""}]') || return 3
        if [ "$action" = release ] && [ "$kind" = leaf ]; then
            frontier_ref="refs/heads/tasks/frontier/$(git rev-parse --short "$task")"
            updates=$(jq -ncS --argjson u "$updates" --arg fr "$frontier_ref" --arg task "$task" \
                '$u+[{ref:$fr,old:"",new:$task}]|sort_by(.ref)') || return 3
        elif [ "$action" = park ]; then
            blocked_ref=$(blocked_ref_for "$task")
            remote_blocked=$(git ls-remote origin "$blocked_ref" 2>/dev/null) || outcome=origin-unreadable
            remote_blocked=$(awk '{print $1; exit}' <<<"$remote_blocked")
            if [ "$outcome" = retired ] && [ -n "$remote_blocked" ] && [ "$remote_blocked" != "$task" ]; then
                outcome=blocked-ref-conflict
            elif [ "$outcome" = retired ]; then
                updates=$(jq -ncS --argjson u "$updates" --arg br "$blocked_ref" \
                    --arg bo "$remote_blocked" --arg task "$task" \
                    '$u+[{ref:$br,old:$bo,new:$task}]|sort_by(.ref)') || return 3
            fi
        fi
    fi

    if [ "$outcome" = retired ]; then
        taskdag_consumer_prepare retire-owned-pre-cas || outcome=consumer-unavailable
    fi
    local push_failed=false reconciliation
    if [ "$outcome" = retired ]; then
        if [ "$TASKDAG_CONSUMER_MODE" = canonical ]; then
            taskdag_consumer_fenced_scheduling_push retire-owned "$claimer" "$updates" || push_failed=true
        else
            local lease_args=() refspecs=() update_ref old new i count
            count=$(jq 'length' <<<"$updates") || return 3
            for ((i=0; i<count; i++)); do
                update_ref=$(jq -r ".[${i}].ref" <<<"$updates") || return 3
                old=$(jq -r ".[${i}].old" <<<"$updates") || return 3
                new=$(jq -r ".[${i}].new" <<<"$updates") || return 3
                lease_args+=("--force-with-lease=$update_ref:$old")
                refspecs+=("${new}:$update_ref")
            done
            git push --atomic origin "${lease_args[@]}" "${refspecs[@]}" >/dev/null 2>&1 \
                || push_failed=true
        fi
    fi
    if [ "$push_failed" = true ]; then
        reconciliation=$(taskdag_retire_owned_reconcile_push "$updates")
        case "$reconciliation" in
            applied) outcome=retired ;;
            unchanged) outcome=cas-failed ;;
            diverged) outcome=claim-changed ;;
            *) outcome=push-outcome-indeterminate ;;
        esac
    fi
    if [ "$outcome" = retired ]; then
        readback=$(git ls-remote origin "$active_ref" "$frontier_ref" "$blocked_ref" 2>/dev/null) \
            || outcome=origin-readback-failed
        if [ "$outcome" = retired ] && grep -q "[[:space:]]${active_ref}$" <<<"$readback"; then
            outcome=retirement-not-confirmed
        elif [ "$outcome" = retired ] && [ -n "$frontier_ref" ] \
            && ! grep -q "^${task}[[:space:]]${frontier_ref}$" <<<"$readback"; then
            outcome=release-not-confirmed
        elif [ "$outcome" = retired ] && [ -n "$blocked_ref" ] \
            && ! grep -q "^${task}[[:space:]]${blocked_ref}$" <<<"$readback"; then
            outcome=park-not-confirmed
        fi
    fi
    [ "$outcome" = retired ] || rc=1
    jq -ncS --arg kind "$kind" --arg identity "${locator:-$task}" --arg task "$task" \
        --arg claimOid "$claim" --arg outcome "$outcome" \
        '{kind:$kind,identity:$identity,task:$task,claimOid:$claimOid,outcome:$outcome}'
    return "$rc"
}

cmd_retire_owned() {
    local selector="" selected="" action="" json=false claimer host pid tmp row rc=0 found=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --all) [ -z "$selector" ] || { echo "Error: choose exactly one selector" >&2; return 2; }; selector=all; shift ;;
            --task) [ $# -ge 2 ] && [ -z "$selector" ] || { echo "Error: --task needs a value and is exclusive" >&2; return 2; }; selector=task; selected=$2; shift 2 ;;
            --task=*) [ -z "$selector" ] || { echo "Error: choose exactly one selector" >&2; return 2; }; selector=task; selected=${1#*=}; shift ;;
            --root) [ $# -ge 2 ] && [ -z "$selector" ] || { echo "Error: --root needs a value and is exclusive" >&2; return 2; }; selector=root; selected=$2; shift 2 ;;
            --root=*) [ -z "$selector" ] || { echo "Error: choose exactly one selector" >&2; return 2; }; selector=root; selected=${1#*=}; shift ;;
            --release|--park) [ -z "$action" ] || { echo "Error: choose exactly one action" >&2; return 2; }; action=${1#--}; shift ;;
            --json) json=true; shift ;;
            --help|-h) cat <<'EOF'
Usage: task-dag retire-owned (--all|--task SHA|--root ROOT_ID) (--release|--park) [--json]

Retire claims owned by the exact ambient TASK_DAG_CLAIMER,
TASK_DAG_CLAIMER_HOST, and TASK_DAG_CLAIMER_PID identity. Release returns a
leaf to the frontier (root release only removes its lock); park installs the
blocked overlay without inventing operator-block metadata.
EOF
                return 0 ;;
            *) echo "Error: unknown retire-owned option: $1" >&2; return 2 ;;
        esac
    done
    [ -n "$selector" ] && [ -n "$action" ] || { echo "Error: exactly one selector and action are required" >&2; return 2; }
    claimer=${TASK_DAG_CLAIMER:-}; host=${TASK_DAG_CLAIMER_HOST:-}; pid=${TASK_DAG_CLAIMER_PID:-}
    [ -n "$claimer" ] && [ -n "$host" ] && [[ "$pid" =~ ^[1-9][0-9]*$ ]] \
        || { echo "Error: exact TASK_DAG_CLAIMER, TASK_DAG_CLAIMER_HOST, and positive TASK_DAG_CLAIMER_PID are required" >&2; return 2; }
    command -v jq >/dev/null 2>&1 || { echo "Error: jq is required" >&2; return 2; }
    fetch_task_refs_strict || { echo "Error: could not refresh task refs from origin" >&2; return 3; }
    tmp=$(mktemp)

    if [ "$selector" = task ]; then
        selected=$(resolve_sha "$selected") || return 2
    elif [ "$selector" = root ]; then
        selected=$(taskdag_root_locator "$selected") || { echo "Error: malformed or unknown root dialect" >&2; return 2; }
    fi

    while IFS=$'\t' read -r kind ref claim task locator; do
        [ -n "$ref" ] || continue
        if [ "$selector" = task ] && { [ "$kind" != leaf ] || [ "$task" != "$selected" ]; }; then continue; fi
        if [ "$selector" = root ] && { [ "$kind" != root ] || [ "$ref" != "$(jq -r .activeRef <<<"$selected")" ]; }; then continue; fi
        if [ "$selector" = all ] \
            && ! taskdag_retire_owned_identity_matches "$claim" "$claimer" "$host" "$pid"; then continue; fi
        found=$((found + 1))
        row=$(taskdag_retire_owned_one "$kind" "$ref" "$claim" "$task" "$locator" "$action" "$claimer" "$host" "$pid") || rc=1
        printf '%s\n' "$row" >>"$tmp"
    done < <(
        while read -r claim ref; do
            task=$(get_first_parent "$claim" 2>/dev/null || true)
            printf 'leaf\t%s\t%s\t%s\t\n' "$ref" "$claim" "$task"
        done < <(git for-each-ref --format='%(objectname) %(refname)' refs/heads/tasks/active)
        while read -r claim ref; do
            locator=$(taskdag_root_locator "$ref" 2>/dev/null || true)
            task=$(get_first_parent "$claim" 2>/dev/null || true)
            printf 'root\t%s\t%s\t%s\t%s\n' "$ref" "$claim" "$task" "$locator"
        done < <(git for-each-ref --format='%(objectname) %(refname)' refs/heads/tasks/root-active)
    )
    if [ "$found" -eq 0 ]; then rc=1; fi
    if [ "$json" = true ]; then
        jq -scS --arg action "$action" --arg selector "$selector" \
            '{schema:1,action:$action,selector:$selector,results:.,ok:(length>0 and all(.outcome=="retired"))}' "$tmp"
    else
        jq -r '"\(.kind) \(.identity): \(.outcome) (claim \(.claimOid))"' "$tmp"
        [ "$found" -gt 0 ] || echo "No matching active claim found" >&2
    fi
    rm -f "$tmp"
    return "$rc"
}
