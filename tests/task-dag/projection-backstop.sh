#!/usr/bin/env bash
# Fixture test for the master-derived close projection backstop: when the
# push-range close-completed workflow was missed, a schedule/manual run with no
# BEFORE_SHA re-derives sanctioned Closes-Epic facts from master, closes the
# GitHub issue, and cleans stale task refs idempotently.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
case "$TD" in
    /*) ;;
    *) TD="$(pwd)/$TD" ;;
esac
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
if [ "$($TD migration-status --json | jq -r .mode)" = draining-legacy-writers ]; then
  "$TD" reconcile-backstop --no-fetch >/dev/null 2>&1; rc=$?
  [ "$rc" -eq 75 ] && { echo "PASS: legacy projection backstop integration is drained"; exit 0; }
  echo "FAIL: expected migration status 75, got $rc"; exit 1
fi

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_GIT_NAME=t TASK_DAG_GIT_EMAIL=t@t

REPO="acme/widgets"
CLOSE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.github/scripts/close-completed-issues.sh"
CLEANUP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.github/scripts/cleanup-closed-issue-task-refs.sh"
EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"

# Fake gh: enough of issue close/view for close-completed-issues.sh and the
# delegated reconcile-closed-issue cleanup. State is durable in $GH_STATE_DIR.
mkdir -p "$ROOT/bin" "$ROOT/gh-state"
cat > "$ROOT/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
state_file() { printf '%s/%s.state' "$GH_STATE_DIR" "$1"; }
if [ "$1" = issue ] && [ "$2" = close ]; then
    n="$3"
    echo CLOSED > "$(state_file "$n")"
    printf '%s\n' "$*" >> "$GH_STATE_DIR/close-calls"
    exit 0
fi
if [ "$1" = issue ] && [ "$2" = view ]; then
    n="$3"; jqexpr=""
    while [ $# -gt 0 ]; do
        if [ "$1" = --jq ]; then jqexpr="${2:-}"; break; fi
        shift
    done
    case "$jqexpr" in
        .state) cat "$(state_file "$n")" ;;
        .author.login) echo tester ;;
        .url) echo "https://github.com/acme/widgets/issues/$n" ;;
        *) echo "gh fixture: unsupported jq '$jqexpr'" >&2; exit 1 ;;
    esac
    exit 0
fi
echo "gh fixture: unsupported args: $*" >&2
exit 1
SH
chmod +x "$ROOT/bin/gh"
export GH_STATE_DIR="$ROOT/gh-state"
PATH="$ROOT/bin:$PATH"; export PATH
echo OPEN > "$GH_STATE_DIR/42.state"

remote_has() { git ls-remote origin "$1" | grep -q .; }

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"
cd "$ROOT/wc" || exit 1
git config taskdag.current-repo "$REPO"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master

ROOT_TASK=$(git commit-tree "$EMPTY_TREE" -p "$(git rev-parse HEAD)" -m "Task: root

Issue: #42
URL: https://github.com/${REPO}/issues/42
Author: tester
Status: pending
Type: epic")
LEAF=$(git commit-tree "$EMPTY_TREE" -p "$ROOT_TASK" -m "Task: stale leaf

Issue: #42
URL: https://github.com/${REPO}/issues/42
Author: tester
Status: pending
Type: leaf")
LEAF_SHORT=$(git rev-parse --short "$LEAF")
git push -q origin \
    "$ROOT_TASK:refs/heads/tasks/pending/42" \
    "$ROOT_TASK:refs/heads/tasks/root-active/42" \
    "$LEAF:refs/heads/tasks/frontier/$LEAF_SHORT" \
    "$LEAF:refs/heads/tasks/blocked/$LEAF"

# Land the durable master close fact, but intentionally do NOT run the push
# close workflow. This leaves GitHub OPEN and refs stale until the backstop.
tip=$(git rev-parse HEAD); tree=$(git rev-parse "${tip}^{tree}")
CLOSE_SHA=$(git commit-tree "$tree" -p "$tip" -p "$ROOT_TASK" -m "Close epic #42

All task-dag obligations for this epic are satisfied.

Closes-Epic: #42")
git update-ref refs/heads/master "$CLOSE_SHA"
git push -q origin master:master

git clone -q "$ROOT/origin.git" "$ROOT/run"
cd "$ROOT/run" || exit 1
git config taskdag.current-repo "$REPO"

out=$(env -u BEFORE_SHA -u AFTER_SHA \
    GH_TOKEN=dummy GITHUB_REPOSITORY="$REPO" \
    CLEANUP_REFS_SCRIPT="$CLEANUP" TASK_DAG_CLI="$TD" \
    bash "$CLOSE" 2>&1); rc=$?
if [ "$rc" = 0 ]; then ok "A1: schedule/manual projection backstop exits 0"; else bad "A1: rc=$rc out=$out"; fi
[ "$(cat "$GH_STATE_DIR/42.state")" = CLOSED ] && ok "A2: backstop closed the open GitHub issue" || bad "A2: issue state not CLOSED"
remote_has "refs/heads/tasks/pending/42"      && bad "A3: pending ref survived"     || ok "A3: pending ref deleted"
remote_has "refs/heads/tasks/root-active/42"  && bad "A4: root-active survived"     || ok "A4: root-active ref deleted"
remote_has "refs/heads/tasks/frontier/$LEAF_SHORT" && bad "A5: frontier survived"   || ok "A5: stale frontier ref deleted"
remote_has "refs/heads/tasks/blocked/$LEAF"   && bad "A6: blocked overlay survived" || ok "A6: stale blocked overlay deleted"

out=$(env -u BEFORE_SHA -u AFTER_SHA \
    GH_TOKEN=dummy GITHUB_REPOSITORY="$REPO" \
    CLEANUP_REFS_SCRIPT="$CLEANUP" TASK_DAG_CLI="$TD" \
    bash "$CLOSE" 2>&1); rc=$?
[ "$rc" = 0 ] && ok "B1: second projection backstop run is idempotent" || { bad "B1: rc=$rc out=$out"; }

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
