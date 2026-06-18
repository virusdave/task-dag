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
        "$here/ci-repair-ticket.sh" "$here/ci-tree-fix-outcome.sh" \
        "$here/ci-race-stale.sh" || exit 1
}
echo "== bash -n =="
bash -n "$TD" \
    && bash -n "$(dirname "$TD")/task-dag.d/cross-repo.sh" \
    && bash -n "$(dirname "$TD")/task-dag.d/ci-repair.sh" \
    && bash -n "$(dirname "$TD")/task-dag.d/ci-chains.sh" || exit 1

rc=0
for t in complete-safety.sh ingest-loop.sh ingest-selfheal.sh blocked-overlay.sh blocked-meta.sh transitive-block.sh claim-pid.sh claim-force-steal.sh breakdown-self-claim.sh tree-fix-trailers.sh ci-chain-cas.sh ci-classifier.sh ci-verify-target.sh ci-repair-ticket.sh ci-tree-fix-outcome.sh ci-race-stale.sh; do
    echo "== $t =="
    bash "$here/$t" "$TD" || rc=1
done
exit "$rc"
