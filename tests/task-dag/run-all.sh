#!/usr/bin/env bash
# Run the task-dag fixture smoke tests. Each test builds a throwaway bare
# "origin" + working clone in a tempdir (no network, no real repo), so it
# is safe to run anywhere. Pass an explicit CLI path as $1 to test a
# specific copy; defaults to ../../scripts/task-dag.
#
# These are the central quality gate that replaces the per-repo
# task-dag-drift-guard (see docs/task_dag/CLI_DISTRIBUTION.md, issue #22).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TD="${1:-$(cd "$here/../../scripts" && pwd)/task-dag}"

echo "Testing CLI: $TD"
command -v shellcheck >/dev/null 2>&1 && {
    echo "== shellcheck =="
    shellcheck -S error "$TD" "$(dirname "$TD")/task-dag.d/cross-repo.sh" \
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
        "$(dirname "$TD")/operator-blocked-dashboard.sh" \
        "$(dirname "$TD")/operator-blocked-dashboard-publish.sh" \
        "$(dirname "$TD")/../.github/scripts/close-completed-issues.sh" \
        "$(dirname "$TD")/../.github/scripts/cleanup-closed-issue-task-refs.sh" \
        "$(dirname "$TD")/../.github/scripts/create-task-commit.sh" \
        "$(dirname "$TD")/../.github/scripts/post-reopen-notice.sh" \
        "$(dirname "$TD")/../.github/scripts/materialise-child-epics.sh" \
        "$(dirname "$TD")/../.github/scripts/materialise-child-epics.test.sh" \
        "$(dirname "$TD")/validate-caller-workflow.sh" \
        "$here/ci-repair-ticket.sh" "$here/ci-tree-fix-outcome.sh" \
        "$here/ci-race-stale.sh" "$here/delegated-block-json.sh" \
        "$here/no-handbuilt-json.sh" "$here/reconcile-closed-issue.sh" \
        "$here/projection-backstop.sh" "$here/graph-converge.sh" \
        "$here/validate-closed-issue-audit.sh" "$here/context-cmd.sh" \
        "$here/wrappers.sh" "$here/caller-workflow-preflight.sh" || exit 1
}
echo "== bash -n =="
bash -n "$TD" \
    && bash -n "$(dirname "$TD")/task-dag.d/cross-repo.sh" \
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
    && bash -n "$(dirname "$TD")/operator-blocked-dashboard.sh" \
    && bash -n "$(dirname "$TD")/operator-blocked-dashboard-publish.sh" \
    && bash -n "$(dirname "$TD")/../.github/scripts/close-completed-issues.sh" \
    && bash -n "$(dirname "$TD")/../.github/scripts/cleanup-closed-issue-task-refs.sh" \
    && bash -n "$(dirname "$TD")/../.github/scripts/create-task-commit.sh" \
    && bash -n "$(dirname "$TD")/../.github/scripts/post-reopen-notice.sh" \
    && bash -n "$(dirname "$TD")/../.github/scripts/materialise-child-epics.sh" \
    && bash -n "$(dirname "$TD")/validate-caller-workflow.sh" || exit 1

rc=0
for t in complete-safety.sh guard-commit-message.sh guard-pre-push.sh complete-subject-style.sh complete-historical.sh local-epic-close.sh local-epic-close-partial-view.sh close-ops-epic.sh close-issue-ref-cleanup.sh reconcile-closed-issue.sh projection-backstop.sh validate-closed-issue-audit.sh ingest-loop.sh comment-cmd.sh ingest-selfheal.sh cross-repo-completion-attribution.sh blocked-overlay.sh blocked-meta.sh blocked-json.sh frontier-json.sh emitter-json.sh no-handbuilt-json.sh validate-strict.sh edges.sh edges-write.sh facts.sh reconcile.sh graph-converge.sh edges-prune.sh legacy-edges.sh mailbox.sh wrappers.sh caller-workflow-preflight.sh operator-blocked-dashboard.sh operator-blocked-dashboard-publish.sh operator-blocked-dispatch.sh transitive-block.sh claim-pid.sh claim-idempotent.sh claim-force-steal.sh reap.sh breakdown-self-claim.sh breakdown-self-continue.sh root-claim.sh tree-fix-trailers.sh ci-chain-cas.sh ci-classifier.sh ci-verify-target.sh ci-repair-ticket.sh ci-tree-fix-outcome.sh ci-race-stale.sh delegated-block-json.sh context-cmd.sh ../create-task-commit.sh ../post-reopen-notice.sh ../../.github/scripts/materialise-child-epics.test.sh; do
    echo "== $t =="
    bash "$here/$t" "$TD" || rc=1
done
exit "$rc"
