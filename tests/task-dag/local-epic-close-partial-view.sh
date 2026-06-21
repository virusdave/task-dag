#!/usr/bin/env bash
# Regression test for the spurious-epic-close bug.
#
# `maybe_emit_local_epic_close` judges epic completeness with
# `epic_subtree_complete` -> `list_dag_children`, which reads the LOCAL ref
# view (`git rev-list --all`). A worker's ephemeral checkout typically only
# fetched its OWN task ref (the dispatcher pre-claimed the task), so the
# sibling leaves of a multi-leaf purely-local epic are INVISIBLE locally.
# Without syncing the task-ref namespace first, `complete` sees a partial DAG
# (just the leaf it is finishing), concludes the whole epic is done, and
# appends a `Closes-Epic: #<N>` commit. Pushed, that prematurely closes the
# issue and abandons the still-pending leaves.
#
# This test reproduces that partial-local-view: it drops the sibling leaf's
# LOCAL frontier ref (it stays on origin, like a leaf this checkout never
# fetched) and asserts completing the other leaf does NOT emit a close.
set -uo pipefail
TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_GIT_NAME=t TASK_DAG_GIT_EMAIL=t@t

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"; cd "$ROOT/wc"
# Mirror a real worker/ephemeral checkout: ONLY master is auto-tracked, so
# non-master heads (sibling task refs) are never pulled unless a command
# explicitly fetches them. This is what makes a sibling leaf invisible to a
# fresh `complete`.
git config remote.origin.fetch '+refs/heads/master:refs/remotes/origin/master'
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master

EMPTY_TREE=$(git mktree </dev/null)
EPIC=$(git commit-tree "$EMPTY_TREE" -p HEAD -m "Task: Test epic

Issue: #777
URL: https://github.com/test/test/issues/777
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/gh/issues/777 "$EPIC"
git update-ref refs/heads/tasks/pending/777 "$EPIC"
git push -q origin refs/heads/gh/issues/777 refs/heads/tasks/pending/777

"$TD" claim-root 777 >/dev/null 2>&1
printf '[{"title":"leaf A","type":"leaf"},{"title":"leaf B","type":"leaf"}]' > "$ROOT/spec.json"
"$TD" breakdown "$EPIC" --spec-file="$ROOT/spec.json" >/dev/null 2>&1
mapfile -t LEAVES < <(git ls-remote origin 'refs/heads/tasks/frontier/*' \
  | sed -E 's#.*refs/heads/tasks/frontier/##')
[ "${#LEAVES[@]}" = "2" ] && ok "0: breakdown published 2 frontier leaves" \
  || bad "0: expected 2 leaves, got ${#LEAVES[@]}"
A="${LEAVES[0]}"; B="${LEAVES[1]}"

has_close_on_head() {  # 0 if HEAD is a Closes-Epic:#777 merge with EPIC as a parent
  git log -1 --format='%P' HEAD | tr ' ' '\n' | grep -qx "$EPIC" || return 1
  git log -1 --format='%B' HEAD | git interpret-trailers --parse 2>/dev/null \
    | grep -qE '^Closes-Epic:[[:space:]]*#?777([^0-9]|$)'
}

# Claim + commit + complete leaf A, but FIRST simulate a worker checkout that
# never fetched leaf B: drop B's LOCAL frontier ref (it remains on origin).
TASK_DAG_CLAIMER=w1 TASK_DAG_CLAIMER_HOST=h1 TASK_DAG_CLAIMER_PID=111 \
  "$TD" claim "$A" >/dev/null 2>&1
echo "work A" > implA.txt; git add implA.txt; git commit -qm "impl A"
git update-ref -d "refs/heads/tasks/frontier/$B"   # B now invisible locally
TASK_DAG_CLAIMER=w1 TASK_DAG_CLAIMER_HOST=h1 TASK_DAG_CLAIMER_PID=111 \
  "$TD" complete "$A" >/dev/null 2>&1

if has_close_on_head; then
  bad "1: epic #777 was spuriously closed while leaf B is still pending (partial local view)"
else
  ok "1: no close commit emitted while a sibling leaf is still pending on origin"
fi

# Sanity: leaf B is genuinely still pending on origin (not actually finished).
if git ls-remote origin "refs/heads/tasks/frontier/$B" | grep -q .; then
  ok "2: leaf B is still a pending frontier leaf on origin"
else
  bad "2: leaf B unexpectedly missing from origin"
fi

echo "-----"; echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
