#!/usr/bin/env bash
# Fixture smoke test for task-dag complete safety fixes (issue #22).
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# bare origin + working clone
git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"
cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master

# Create an epic commit + refs (mimic issue-to-task)
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

# ---------------------------------------------------------------------------
# TEST 1 (B): dirty worktree is PRESERVED across complete (default HEAD path)
# ---------------------------------------------------------------------------
T1=$(mk_task "t1 dirty preserve")
[ -n "$T1" ] || { echo "could not create T1 (breakdown json)"; }
if [ -n "$T1" ]; then
  TASK1=$(git rev-parse "refs/heads/tasks/frontier/$T1")
  TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" claim "$T1" >/dev/null 2>&1
  echo "real work" > impl.txt; git add impl.txt; git commit -qm "impl t1"
  echo "UNCOMMITTED" > dirty.txt          # untracked dirty file
  echo "seed-modified" >> seed.txt        # modified tracked file (unstaged)
  TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" complete "$T1" >/dev/null 2>&1
  rc=$?
  if [ $rc -eq 0 ] && [ -f dirty.txt ] && grep -q UNCOMMITTED dirty.txt \
       && grep -q seed-modified seed.txt; then
    ok "B: dirty/untracked changes preserved through complete (rc=$rc)"
  else
    bad "B: dirty changes lost or complete failed (rc=$rc)"
  fi
  # And the completion commit must be HEAD with the task as 2nd parent
  if [ "$(git rev-parse HEAD^2)" = "$TASK1" ]; then
    ok "B: completion commit links task as second parent"
  else
    bad "B: completion commit missing task parent"
  fi
  # cleanup dirty state for next tests
  git checkout -q -- seed.txt 2>/dev/null; rm -f dirty.txt
  git push -q origin HEAD:master 2>/dev/null
fi

# ---------------------------------------------------------------------------
# TEST 2 (C1): refuse completing a task claimed by ANOTHER worker
# ---------------------------------------------------------------------------
T2=$(mk_task "t2 other claim")
if [ -n "$T2" ]; then
  TASK_DAG_CLAIMER=alice TASK_DAG_CLAIMER_HOST=hostA "$TD" claim "$T2" >/dev/null 2>&1
  echo work2 > impl2.txt; git add impl2.txt; git commit -qm "impl t2"
  out=$(TASK_DAG_CLAIMER=bob TASK_DAG_CLAIMER_HOST=hostB "$TD" complete "$T2" 2>&1)
  rc=$?
  if [ $rc -ne 0 ] && echo "$out" | grep -qi "claimed by alice"; then
    ok "C1: refused completing alice's task as bob (rc=$rc)"
  else
    bad "C1: did NOT refuse other-worker completion (rc=$rc): $out"
  fi
  # active ref must still exist (we didn't clobber it)
  if git ls-remote --exit-code origin "refs/heads/tasks/active/$T2" >/dev/null 2>&1; then
    ok "C1: alice's active claim left intact after refusal"
  else
    bad "C1: alice's active claim was deleted on refusal"
  fi
  # --force overrides
  out=$(TASK_DAG_CLAIMER=bob TASK_DAG_CLAIMER_HOST=hostB "$TD" complete "$T2" --force 2>&1)
  rc=$?
  if [ $rc -eq 0 ]; then ok "C1: --force overrides other-worker guard (rc=$rc)"; else bad "C1: --force failed (rc=$rc): $out"; fi
  git push -q origin HEAD:master 2>/dev/null
fi

# ---------------------------------------------------------------------------
# TEST 3 (C2): owned completion cleans remote refs (active+frontier gone)
# ---------------------------------------------------------------------------
T3=$(mk_task "t3 cleanup")
if [ -n "$T3" ]; then
  TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" claim "$T3" >/dev/null 2>&1
  echo work3 > impl3.txt; git add impl3.txt; git commit -qm "impl t3"
  TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" complete "$T3" >/dev/null 2>&1
  a=$(git ls-remote origin "refs/heads/tasks/active/$T3" | wc -l)
  f=$(git ls-remote origin "refs/heads/tasks/frontier/$T3" | wc -l)
  if [ "$a" -eq 0 ] && [ "$f" -eq 0 ]; then
    ok "C2: owned complete CAS-cleaned active+frontier refs"
  else
    bad "C2: refs lingered (active=$a frontier=$f)"
  fi
fi

# ---------------------------------------------------------------------------
# TEST 4 (B): detached HEAD completion works
# ---------------------------------------------------------------------------
T4=$(mk_task "t4 detached")
if [ -n "$T4" ]; then
  TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" claim "$T4" >/dev/null 2>&1
  echo work4 > impl4.txt; git add impl4.txt; git commit -qm "impl t4"
  git checkout -q --detach
  TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" complete "$T4" >/dev/null 2>&1
  rc=$?
  if [ $rc -eq 0 ] && git rev-parse HEAD^2 >/dev/null 2>&1; then
    ok "B: detached-HEAD complete succeeded (rc=$rc)"
  else
    bad "B: detached-HEAD complete failed (rc=$rc)"
  fi
  git checkout -q master 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# TEST 5 (C1): malformed/legacy active claim (missing fields) — must refuse
# cleanly (exit 2), not abort under set -e, and leave NO temp ref behind.
# ---------------------------------------------------------------------------
T5=$(mk_task "t5 malformed claim")
if [ -n "$T5" ]; then
  TASK5=$(git rev-parse "refs/heads/tasks/frontier/$T5")
  # Hand-craft a bogus active ref pointing at a commit with no claim metadata.
  BOGUS=$(git commit-tree "$(git rev-parse "$TASK5^{tree}")" -p "$TASK5" -m "garbage, no fields")
  git push -q origin "$BOGUS:refs/heads/tasks/active/$T5"
  echo work5 > impl5.txt; git add impl5.txt; git commit -qm "impl t5"
  out=$(TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" complete "$T5" 2>&1)
  rc=$?
  if [ $rc -eq 2 ]; then ok "C1: malformed claim refused cleanly (rc=2)"; else bad "C1: malformed claim rc=$rc (expected 2): $out"; fi
  if [ -z "$(git for-each-ref 'refs/task-dag-tmp/**' 2>/dev/null)" ]; then
    ok "C1: no temp ref leaked under refs/task-dag-tmp/"
  else
    bad "C1: temp ref leaked: $(git for-each-ref 'refs/task-dag-tmp/**')"
  fi
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
