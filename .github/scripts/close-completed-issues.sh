#!/usr/bin/env bash
# Close task-epic issues whose epic-task commit has just been merged
# into master.  The completion signal has two parts that BOTH must be
# present:
#
#   1. Structure: the merge commit on master lists a metadata commit at
#      refs/heads/tasks/pending/<N> as one of its non-primary parents.
#   2. Trailer:   the merge commit's message carries an explicit
#                 `Closes-Epic: #<N>` trailer matching the same <N>.
#
# Both conditions are required because `scripts/task-dag complete`
# uses the same parent structure to *attach* an implementation commit
# to an in-progress epic — that is NOT a completion signal and must
# not auto-close the epic. See docs/task_dag/EPIC_CLOSURE.md and
# virusdave/top-level#8 for the rationale and the incident on #7 that
# motivated this gate.
#
# The canonical way to emit the trailer is `scripts/task-dag close-epic
# <N>`, which constructs a tree-equal merge commit with the trailer
# baked in.  Operators can also add the trailer by hand when landing
# an epic-closing merge directly.
#
# When both conditions are met, this script:
#
#   1. closes issue #<N> via `gh issue close`, including an @-mention
#      of the issue author so they get a GitHub notification (this is
#      the operator paging path operators rely on to know an epic
#      finally wrapped up — see virusdave/top-level#3),
#   2. cleans up the remote `refs/heads/tasks/pending/<N>` ref, and
#   3. cleans up any lingering `tasks/blocked/<sha>` overlay (+ frontier /
#      blocked-meta) refs for the closed issue — delegated to
#      cleanup-closed-issue-task-refs.sh. Without this, an epic ROOT that
#      was auto-parked by github-worker (agent abandoned the claim) keeps a
#      blocked overlay forever — the epic root is closed via this merge, not
#      via `task-dag complete`, so nothing else clears it — and the closed
#      issue lingers in the operator-blocked #29 dashboard. See
#      FreshlyBakedNYC/automation#6.
#
# Idempotent but NOT silent: re-closing an already-closed issue and
# deleting an already-absent ref are both treated as success, but a REAL
# close/delete failure (e.g. insufficient `contents` permission) fails the
# run loudly via exit 1 — see ensure_issue_closed / delete_remote_ref_if_present.
#
# Invoked by .github/workflows/close-completed-issues.yml with:
#   BEFORE_SHA  — optional push event's before SHA (40-zero on first push)
#   AFTER_SHA   — optional push event's after SHA / current master tip
#   GH_TOKEN    — workflow token, scoped issues:write
#
# If BEFORE_SHA is empty, the script runs as a projection backstop: it derives
# every sanctioned `Closes-Epic:` fact reachable from the current master tip
# and repairs the GitHub issue / task-ref projection idempotently. This is the
# schedule/manual path for missed push workflows and bot pushes that did not
# trigger the push-range close job.

set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    echo "Usage: close-completed-issues.sh"
    echo "Project legacy epic-close commits to GitHub issues and task refs."
    exit 0
fi
[ "$#" -eq 0 ] || { echo "Error: close-completed-issues.sh accepts no arguments" >&2; exit 2; }

_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_migration_lib="$_here/../../scripts/task-dag.d/semantic-migration.sh"
[ -r "$_migration_lib" ] || { echo "Error: coherent semantic migration guard not found: $_migration_lib" >&2; exit 1; }
# shellcheck source=/dev/null
source "$_migration_lib"
TASK_DAG="${TASK_DAG_CLI:-$_here/../../scripts/task-dag}"
unset _here _migration_lib

: "${GH_TOKEN:?GH_TOKEN is required}"

# Track whether any projection step failed so the workflow goes red.
SAW_FAILURE=0

facts="$($TASK_DAG completed-issue-projection-list --json)" || exit $?
while IFS=$'\t' read -r issue_num commit root; do
        [ -n "$issue_num" ] || continue
        echo "Found canonical completion of task epic for issue #$issue_num in commit $commit"

        # The coherent CLI re-derives the exact fact immediately before it
        # closes GitHub, confirms CLOSED, then re-prepares and atomically
        # retires every non-active task ref under the activation fence.
        if ! "$TASK_DAG" project-completed-issue \
                --issue="$issue_num" --root="$root" --close-commit="$commit"; then
            echo "ERROR: canonical task-ref projection failed for issue #$issue_num" >&2
            SAW_FAILURE=1
        fi
done < <(jq -r '.[] | [.issue,.closeCommit,.root] | @tsv' <<<"$facts")

# Surface any close/cleanup failure as a red workflow run so silent ref
# orphaning (the contents:read regression) can never recur unnoticed.
if [ "$SAW_FAILURE" -ne 0 ]; then
    echo "ERROR: one or more issue closes or task-ref deletions failed (see above)" >&2
    exit 1
fi
