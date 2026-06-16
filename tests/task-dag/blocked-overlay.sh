#!/usr/bin/env bash
# Fixture smoke test for the blocked-overlay dispatch-loop fix (issue #22).
#
# Regression: fetch_task_refs() used to sync only tasks/frontier/* and
# tasks/active/*, never tasks/blocked/*. Because is_task_blocked reads the
# LOCAL blocked ref, a FRESH worker clone never saw the overlay and so
# `frontier` re-listed parked tasks — re-dispatching a task the operator
# had explicitly blocked (the comment->task dispatch loop). These tests
# drive a SECOND clone (a fresh worker) to prove the overlay now syncs.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# bare origin + "authoring" working clone
git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"
cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master

# Epic commit + refs (mimic issue-to-task)
EPIC=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: Test epic

Issue: #999
URL: https://github.com/test/test/issues/999
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/gh/issues/999 "$EPIC"
git update-ref refs/heads/tasks/pending/999 "$EPIC"
git push -q origin refs/heads/gh/issues/999 refs/heads/tasks/pending/999

mk_task() {  # prints the new leaf task short sha
  local title="$1"
  printf '[{"title":"%s","type":"leaf"}]' "$title" > "$ROOT/spec.json"
  "$TD" breakdown "$EPIC" --spec-file="$ROOT/spec.json" --json 2>/dev/null \
    | grep -oE '"shortSha":"[0-9a-f]+"' | head -1 | cut -d'"' -f4
}

T=$(mk_task "blocked overlay task")
[ -n "$T" ] || { echo "could not create task (breakdown json)"; echo "PASS=0 FAIL=1"; exit 1; }
TASK_FULL=$(git rev-parse "refs/heads/tasks/frontier/$T")

# Park it on origin.
"$TD" block "$T" --reason="awaiting operator" >/dev/null 2>&1

# ---------------------------------------------------------------------------
# A fresh worker = a brand-new clone with NO local task refs at all.
# ---------------------------------------------------------------------------
git clone -q "$ROOT/origin.git" "$ROOT/worker"
cd "$ROOT/worker"

# TEST 1: a fresh worker's frontier must EXCLUDE the blocked task.
if "$TD" frontier --issue=999 2>/dev/null | grep -q "$T"; then
  bad "1: fresh worker frontier RE-LISTED a blocked task (dispatch loop)"
else
  ok "1: fresh worker frontier excludes the blocked task"
fi

# TEST 2: a fresh worker's `blocked` must LIST the parked task.
if "$TD" blocked --issue=999 2>/dev/null | grep -q "$T"; then
  ok "2: fresh worker 'blocked' lists the parked task"
else
  bad "2: fresh worker 'blocked' did NOT list the parked task"
fi

# TEST 3: a fresh worker must NOT be able to claim a blocked task.
out=$(TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" claim "$T" 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && echo "$out" | grep -qi "blocked"; then
  ok "3: claim refuses a blocked task (rc=2)"
else
  bad "3: claim did NOT refuse a blocked task (rc=$rc): $out"
fi
# ...and origin's active ref must NOT have been created.
if [ "$(git ls-remote origin "refs/heads/tasks/active/$T" | wc -l)" -eq 0 ]; then
  ok "3: no active claim ref created for the blocked task"
else
  bad "3: an active claim ref leaked for the blocked task"
fi

# ---------------------------------------------------------------------------
# TEST 4: unblock on origin -> a fresh worker sees it pickable again, and
# --prune drops the now-stale local blocked ref in a re-fetching checkout.
# ---------------------------------------------------------------------------
cd "$ROOT/wc"
"$TD" unblock "$T" >/dev/null 2>&1

git clone -q "$ROOT/origin.git" "$ROOT/worker2"
cd "$ROOT/worker2"
if "$TD" frontier --issue=999 2>/dev/null | grep -q "$T"; then
  ok "4: after unblock, fresh worker frontier lists the task again"
else
  bad "4: after unblock, task still missing from frontier"
fi

# Re-fetch in the original authoring clone (which still has the stale local
# blocked ref) and confirm --prune removed it.
cd "$ROOT/wc"
"$TD" blocked --issue=999 >/dev/null 2>&1   # triggers fetch_task_refs (prune)
if git show-ref --verify --quiet "refs/heads/tasks/blocked/$TASK_FULL"; then
  bad "4: stale local blocked ref was NOT pruned after unblock"
else
  ok "4: --prune dropped the stale local blocked ref after unblock"
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
