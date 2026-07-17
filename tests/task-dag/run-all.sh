#!/usr/bin/env bash
# Run the task-dag fixture smoke tests. Each test builds a throwaway bare
# "origin" + working clone in a tempdir (no network, no real repo), so it
# is safe to run anywhere. Pass an explicit CLI path as $1 to test a
# specific copy; defaults to ../../scripts/task-dag.
#
# These are the central quality gate that replaces the per-repo
# task-dag-drift-guard (see docs/task_dag/CLI_DISTRIBUTION.md, issue #22).
set -uo pipefail

usage() {
    cat <<'EOF'
Usage: run-all.sh [TASK_DAG_CLI]

Run shellcheck (when available), bash -n, and the task-dag fixture suite.
Fixture output is buffered and printed in declaration order.

Options:
  -h, --help  Show this help and exit.

Environment:
  TASK_DAG_TEST_JOBS  Maximum parallel fixtures (1-8; default: 8).
EOF
}

case "${1:-}" in
    -h|--help) usage; exit 0 ;;
esac
if [ "$#" -gt 1 ]; then
    echo "run-all.sh: expected at most one TASK_DAG_CLI argument" >&2
    exit 2
fi

jobs=${TASK_DAG_TEST_JOBS-8}
case "$jobs" in
    [1-8]) ;;
    *)
        echo "run-all.sh: TASK_DAG_TEST_JOBS must be an integer from 1 through 8" >&2
        exit 2
        ;;
esac

if ! command -v setsid >/dev/null 2>&1; then
    echo "run-all.sh: setsid is required to isolate and clean up fixture processes" >&2
    exit 2
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TD="${1:-$(cd "$here/../../scripts" && pwd)/task-dag}"
case "$TD" in
    /*) ;;
    *)
        relative_td=$TD
        TD=$(realpath -e -- "$TD") || {
            echo "run-all.sh: cannot resolve relative TASK_DAG_CLI path: $relative_td" >&2
            exit 2
        }
        echo "run-all.sh: converting relative TASK_DAG_CLI path '$relative_td' to absolute path '$TD'" >&2
        ;;
esac

echo "Testing CLI: $TD"

# GitHub Actions exports the caller repository globally, but these fixtures
# create independent synthetic repositories and supply their own identity when
# a scenario needs one. Do not let the workflow's repository override fixture
# config/remote discovery; tests for the environment path set it explicitly.
unset GITHUB_REPOSITORY

command -v shellcheck >/dev/null 2>&1 && {
    echo "== shellcheck =="
    shellcheck -S error "$TD" "$(dirname "$TD")/task-dag.d/cross-repo.sh" \
        "$(dirname "$TD")/task-dag.d/semantic-migration.sh" \
        "$(dirname "$TD")/task-dag.d/ci-repair.sh" \
        "$(dirname "$TD")/task-dag.d/ci-chains.sh" \
        "$(dirname "$TD")/task-dag.d/edges.sh" \
        "$(dirname "$TD")/task-dag.d/facts.sh" \
        "$(dirname "$TD")/task-dag.d/edges-write.sh" \
        "$(dirname "$TD")/task-dag.d/reconcile.sh" \
        "$(dirname "$TD")/task-dag.d/graph-converge.sh" \
        "$(dirname "$TD")/task-dag.d/edges-prune.sh" \
        "$(dirname "$TD")/task-dag.d/legacy-edges.sh" \
        "$(dirname "$TD")/task-dag.d/mailbox.sh" \
        "$(dirname "$TD")/task-dag.d/materialise.sh" \
        "$(dirname "$TD")/task-dag.d/activation.sh" \
        "$(dirname "$TD")/operator-blocked-dashboard.sh" \
        "$(dirname "$TD")/operator-blocked-dashboard-publish.sh" \
        "$(dirname "$TD")/../.github/scripts/close-completed-issues.sh" \
        "$(dirname "$TD")/../.github/scripts/cleanup-closed-issue-task-refs.sh" \
        "$(dirname "$TD")/../.github/scripts/create-task-commit.sh" \
        "$(dirname "$TD")/../.github/scripts/post-reopen-notice.sh" \
        "$(dirname "$TD")/../.github/scripts/materialise-child-epics.sh" \
        "$(dirname "$TD")/../.github/scripts/materialise-child-epics.test.sh" \
        "$(dirname "$TD")/sync-comment-to-tasks.sh" \
        "$(dirname "$TD")/validate-caller-workflow.sh" \
        "$here/ci-repair-audit.sh" "$here/ci-repair-projections.sh" "$here/ci-repair-retire.sh" "$here/ci-repair-evidence.sh" \
        "$here/ci-repair-decisions.sh" \
        "$here/ci-repair-ticket.sh" "$here/ci-tree-fix-outcome.sh" \
        "$here/ci-race-stale.sh" "$here/delegated-block-json.sh" \
        "$here/no-handbuilt-json.sh" "$here/reconcile-closed-issue.sh" \
        "$here/projection-backstop.sh" "$here/completed-ref-reconcile.sh" "$here/graph-converge.sh" \
        "$here/validate-closed-issue-audit.sh" "$here/context-cmd.sh" \
        "$here/wrappers.sh" "$here/caller-workflow-preflight.sh" \
        "$here/install-completion-order-hook.sh" "$here/reconcile-comments.sh" || exit 1
}
echo "== bash -n =="
bash -n "$TD" \
    && bash -n "$(dirname "$TD")/task-dag.d/cross-repo.sh" \
    && bash -n "$(dirname "$TD")/task-dag.d/semantic-migration.sh" \
    && bash -n "$(dirname "$TD")/task-dag.d/ci-repair.sh" \
    && bash -n "$(dirname "$TD")/task-dag.d/ci-chains.sh" \
    && bash -n "$(dirname "$TD")/task-dag.d/edges.sh" \
    && bash -n "$(dirname "$TD")/task-dag.d/facts.sh" \
    && bash -n "$(dirname "$TD")/task-dag.d/edges-write.sh" \
    && bash -n "$(dirname "$TD")/task-dag.d/reconcile.sh" \
    && bash -n "$(dirname "$TD")/task-dag.d/graph-converge.sh" \
    && bash -n "$(dirname "$TD")/task-dag.d/edges-prune.sh" \
    && bash -n "$(dirname "$TD")/task-dag.d/legacy-edges.sh" \
    && bash -n "$(dirname "$TD")/task-dag.d/mailbox.sh" \
    && bash -n "$(dirname "$TD")/task-dag.d/materialise.sh" \
    && bash -n "$(dirname "$TD")/task-dag.d/activation.sh" \
    && bash -n "$(dirname "$TD")/operator-blocked-dashboard.sh" \
    && bash -n "$(dirname "$TD")/operator-blocked-dashboard-publish.sh" \
    && bash -n "$(dirname "$TD")/../.github/scripts/close-completed-issues.sh" \
    && bash -n "$(dirname "$TD")/../.github/scripts/cleanup-closed-issue-task-refs.sh" \
    && bash -n "$(dirname "$TD")/../.github/scripts/create-task-commit.sh" \
    && bash -n "$(dirname "$TD")/../.github/scripts/post-reopen-notice.sh" \
    && bash -n "$(dirname "$TD")/../.github/scripts/materialise-child-epics.sh" \
    && bash -n "$(dirname "$TD")/sync-comment-to-tasks.sh" \
    && bash -n "$(dirname "$TD")/validate-caller-workflow.sh" \
    && bash -n "$here/install-completion-order-hook.sh" \
    && bash -n "$here/reconcile-comments.sh" || exit 1

parallel_tests=(
    reconcile.sh
    ci-repair-evidence.sh
    ci-tree-fix-outcome.sh
    ci-repair-retire.sh
    ci-race-stale.sh
    mailbox.sh
    ci-repair-ticket.sh
    root-claim.sh
    ci-repair-decisions.sh
    ci-classifier.sh
    complete-safety.sh
    ci-reconcile-lease.sh
    ci-repair-audit.sh
    wrappers.sh
    edges-prune.sh
    comment-receipts.sh
    operator-blocked-dashboard.sh
    complete-ops.sh
    complete-historical.sh
    ci-chain-cas.sh
    breakdown-self-continue.sh
    blocked-json.sh
    ci-verify-target.sh
    ci-repair-projections.sh
    blocked-meta.sh
    validate-strict.sh
    transitive-block.sh
    legacy-edges.sh
    edges-write.sh
    operator-blocked-dispatch.sh
    operator-blocked-dashboard-publish.sh
    guard-pre-push.sh
    guard-commit-message.sh
    facts.sh
    validate-closed-issue-audit.sh
    complete-subject-style.sh
    comment-cmd.sh
    claim-pid.sh
    ingest-selfheal.sh
    caller-workflow-preflight.sh
    breakdown-self-claim.sh
    reap.sh
    ingest-loop.sh
    frontier-json.sh
    edges.sh
    migration-drain.sh
    materialise.sh
    activation.sh
    blocked-overlay.sh
    tree-fix-trailers.sh
    no-handbuilt-json.sh
    context-cmd.sh
    claim-idempotent.sh
    reconcile-comments.sh
    local-epic-close-partial-view.sh
    emitter-json.sh
    delegated-block-json.sh
    ../create-task-commit.sh
    claim-force-steal.sh
    reconcile-closed-issue.sh
    projection-backstop.sh
    ../post-reopen-notice.sh
    local-epic-close.sh
    graph-converge.sh
    ../../.github/scripts/materialise-child-epics.test.sh
    cross-repo-completion-attribution.sh
    completed-ref-reconcile.sh
    close-ops-epic.sh
    close-issue-ref-cleanup.sh
    close-completed-epic.sh
)

# Tests that share mutable state or a live external resource belong here. The
# current fixture audit found none: every entry above owns a distinct mktemp
# workspace and uses local bare repositories plus stubbed external commands.
# Keep this tail explicit so a future exception cannot accidentally run in
# parallel merely by being added to the suite.
serial_tests=()

run_tmp=$(mktemp -d) || {
    echo "run-all.sh: could not create fixture output directory" >&2
    exit 1
}
active_pids=()
observed_statuses=()

remove_active_pid() {
    local reaped_pid=$1 active_index
    for active_index in "${!active_pids[@]}"; do
        if [ "${active_pids[$active_index]}" = "$reaped_pid" ]; then
            unset 'active_pids[active_index]'
            active_pids=("${active_pids[@]}")
            return
        fi
    done
}

wait_for_worker_start() {
    local pid=$1 ready_file=$2 attempt
    for ((attempt = 0; attempt < 100; attempt++)); do
        if [ -e "$ready_file" ]; then
            return 0
        fi
        if ! kill -0 "$pid" 2>/dev/null; then
            [ -e "$ready_file" ] && return 0
            return 1
        fi
        sleep 0.01
    done
    return 1
}

valid_exit_status() {
    case "$1" in
        0|[1-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5]) return 0 ;;
        *) return 1 ;;
    esac
}

terminate_workers() {
    local pid
    if [ "${#active_pids[@]}" -eq 0 ]; then
        return
    fi
    for pid in "${active_pids[@]}"; do
        kill -TERM -- "-$pid" 2>/dev/null || true
    done
    sleep 2
    for pid in "${active_pids[@]}"; do
        if kill -0 -- "-$pid" 2>/dev/null; then
            kill -KILL -- "-$pid" 2>/dev/null || true
        fi
    done
    for pid in "${active_pids[@]}"; do
        wait "$pid" 2>/dev/null || true
    done
    active_pids=()
}

cleanup() {
    trap '' HUP INT TERM
    trap - EXIT
    terminate_workers
    rm -rf "$run_tmp"
}

interrupted() {
    local status=$1
    trap '' HUP INT TERM
    trap - EXIT
    terminate_workers
    rm -rf "$run_tmp"
    exit "$status"
}

trap cleanup EXIT
trap 'interrupted 129' HUP
trap 'interrupted 130' INT
trap 'interrupted 143' TERM

all_tests=("${parallel_tests[@]}" "${serial_tests[@]}")
parallel_count=${#parallel_tests[@]}
echo "== fixtures: ${#all_tests[@]} total, up to $jobs parallel; output buffered =="

for ((batch_start = 0; batch_start < parallel_count; batch_start += jobs)); do
    batch_pids=()
    batch_indexes=()
    for ((offset = 0; offset < jobs && batch_start + offset < parallel_count; offset++)); do
        index=$((batch_start + offset))
        t=${parallel_tests[$index]}
        ready_file="$run_tmp/$index.ready"
        duration_file="$run_tmp/$index.duration"
        env -u TASK_DAG_TEST_JOBS setsid bash -c \
            'ready=$1; duration=$2; shift 2; start=$SECONDS; : >"$ready" || exit 125; bash "$@"; status=$?; printf "%s\n" "$((SECONDS - start))" >"$duration" || exit 125; exit "$status"' \
            run-all-worker "$ready_file" "$duration_file" "$here/$t" "$TD" \
            >"$run_tmp/$index.log" 2>&1 &
        pid=$!
        active_pids+=("$pid")
        if wait_for_worker_start "$pid" "$ready_file"; then
            batch_pids+=("$pid")
            batch_indexes+=("$index")
        else
            kill -TERM -- "-$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
            remove_active_pid "$pid"
            observed_statuses[$index]=125
            printf 'run-all.sh: fixture worker did not confirm startup\n' \
                >>"$run_tmp/$index.log" || true
            printf '125\n' >"$run_tmp/$index.status" || true
        fi
    done

    for ((offset = 0; offset < ${#batch_pids[@]}; offset++)); do
        pid=${batch_pids[$offset]}
        index=${batch_indexes[$offset]}
        if wait "$pid"; then
            status=0
        else
            status=$?
        fi
        remove_active_pid "$pid"
        observed_statuses[$index]=$status
        printf '%s\n' "$status" >"$run_tmp/$index.status" || true
    done
done

for ((serial_index = 0; serial_index < ${#serial_tests[@]}; serial_index++)); do
    index=$((parallel_count + serial_index))
    t=${serial_tests[$serial_index]}
    ready_file="$run_tmp/$index.ready"
    duration_file="$run_tmp/$index.duration"
    env -u TASK_DAG_TEST_JOBS setsid bash -c \
        'ready=$1; duration=$2; shift 2; start=$SECONDS; : >"$ready" || exit 125; bash "$@"; status=$?; printf "%s\n" "$((SECONDS - start))" >"$duration" || exit 125; exit "$status"' \
        run-all-worker "$ready_file" "$duration_file" "$here/$t" "$TD" \
        >"$run_tmp/$index.log" 2>&1 &
    pid=$!
    active_pids+=("$pid")
    if wait_for_worker_start "$pid" "$ready_file"; then
        if wait "$pid"; then
            status=0
        else
            status=$?
        fi
        remove_active_pid "$pid"
        observed_statuses[$index]=$status
        printf '%s\n' "$status" >"$run_tmp/$index.status" || true
    else
        kill -TERM -- "-$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
        remove_active_pid "$pid"
        observed_statuses[$index]=125
        printf 'run-all.sh: fixture worker did not confirm startup\n' \
            >>"$run_tmp/$index.log" || true
        printf '125\n' >"$run_tmp/$index.status" || true
    fi
done

rc=0
failed=()
observed_durations=()
for ((index = 0; index < ${#all_tests[@]}; index++)); do
    t=${all_tests[$index]}
    fixture_failed=0
    failure_detail=""
    if [ -r "$run_tmp/$index.duration" ] \
            && duration=$(cat "$run_tmp/$index.duration") \
            && [[ "$duration" =~ ^[0-9]+$ ]]; then
        echo "== $t (${duration}s) =="
        observed_durations[$index]=$duration
    else
        duration=unknown
        echo "== $t (wall time unavailable) =="
        fixture_failed=1
        failure_detail="missing or invalid wall time"
    fi
    if [ -r "$run_tmp/$index.log" ]; then
        if ! cat "$run_tmp/$index.log"; then
            echo "run-all.sh: could not read fixture log" >&2
            fixture_failed=1
            failure_detail="log read failure"
        fi
        [ ! -s "$run_tmp/$index.log" ] || tail -c 1 "$run_tmp/$index.log" | grep -q '^$' || echo
    else
        echo "run-all.sh: missing fixture log" >&2
        fixture_failed=1
        failure_detail="missing log"
    fi
    if [ -r "$run_tmp/$index.status" ]; then
        if status=$(cat "$run_tmp/$index.status"); then
            if ! valid_exit_status "$status"; then
                fixture_failed=1
                failure_detail="${failure_detail:+$failure_detail; }invalid status"
            elif [ "$status" -ne 0 ]; then
                fixture_failed=1
                failure_detail="${failure_detail:+$failure_detail; }fixture status $status"
            fi
            if valid_exit_status "$status" \
                    && [ -n "${observed_statuses[$index]+x}" ] \
                    && [ "$status" -ne "${observed_statuses[$index]}" ]; then
                fixture_failed=1
                failure_detail="${failure_detail:+$failure_detail; }status disagrees with parent wait"
            fi
        else
            fixture_failed=1
            failure_detail="${failure_detail:+$failure_detail; }status read failure"
        fi
    else
        fixture_failed=1
        failure_detail="${failure_detail:+$failure_detail; }missing status"
    fi
    if [ -z "${observed_statuses[$index]+x}" ]; then
        fixture_failed=1
        failure_detail="${failure_detail:+$failure_detail; }missing parent wait status"
        parent_status=125
    else
        parent_status=${observed_statuses[$index]}
    fi
    if [ "$parent_status" -ne 0 ]; then
        fixture_failed=1
    fi
    if [ "$fixture_failed" -ne 0 ]; then
        failed+=("$t (parent status $parent_status${failure_detail:+; $failure_detail})")
        rc=1
    fi
done

largest_drift=0
if [ "$rc" -eq 0 ] && [ "$parallel_count" -gt 1 ]; then
    earlier_min=${observed_durations[0]}
    earlier_min_test=${parallel_tests[0]}
    for ((index = 1; index < parallel_count; index++)); do
        duration=${observed_durations[$index]}
        drift=$((duration - earlier_min))
        if [ "$drift" -gt "$largest_drift" ]; then
            largest_drift=$drift
            drift_later_test=${parallel_tests[$index]}
            drift_later_duration=$duration
            drift_earlier_test=$earlier_min_test
            drift_earlier_duration=$earlier_min
        fi
        if [ "$duration" -lt "$earlier_min" ]; then
            earlier_min=$duration
            earlier_min_test=${parallel_tests[$index]}
        fi
    done
fi

if [ "$largest_drift" -ge 30 ]; then
    echo "NOTICE: fixture timing order may have drifted: later $drift_later_test (${drift_later_duration}s) took ${largest_drift}s longer than earlier $drift_earlier_test (${drift_earlier_duration}s)."
    echo "Hint: consider reordering the parallel fixtures if this execution-time profile persists."
fi

if [ "$rc" -eq 0 ]; then
    echo "PASS: ${#all_tests[@]} fixtures"
else
    echo "FAILED fixtures:"
    printf '  %s\n' "${failed[@]}"
fi
exit "$rc"
