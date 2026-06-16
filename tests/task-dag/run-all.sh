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
    shellcheck -S error "$TD" "$(dirname "$TD")/task-dag.d/cross-repo.sh" || exit 1
}
echo "== bash -n =="
bash -n "$TD" && bash -n "$(dirname "$TD")/task-dag.d/cross-repo.sh" || exit 1

rc=0
for t in complete-safety.sh ingest-loop.sh blocked-overlay.sh; do
    echo "== $t =="
    bash "$here/$t" "$TD" || rc=1
done
exit "$rc"
