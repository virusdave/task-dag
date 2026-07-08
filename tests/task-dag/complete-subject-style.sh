#!/usr/bin/env bash
# Fixture test for the commit-subject style backstop inside `task-dag complete`
# (top-level#45): a live completion must REFUSE a Conventional-Commits impl
# subject (the commit-msg hook is the primary gate, but complete is the last
# reliable point before the subject is linked as task work). The single-leaf
# form blocks with no side effects; the batch --leaves form reports every
# offender and does nothing.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"
cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master

EPIC=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: Test epic

Issue: #999
URL: https://github.com/test/test/issues/999
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/gh/issues/999 "$EPIC"
git update-ref refs/heads/tasks/pending/999 "$EPIC"
git push -q origin refs/heads/gh/issues/999 refs/heads/tasks/pending/999

mk_task() {
  printf '[{"title":"%s","type":"leaf"}]' "$1" > "$ROOT/spec.json"
  "$TD" claim-root 999 --force >/dev/null 2>&1
  "$TD" breakdown "$EPIC" --spec-file="$ROOT/spec.json" --force --json 2>/dev/null \
    | grep -oE '"shortSha":"[0-9a-f]+"' | head -1 | cut -d'"' -f4
}

# ── single-leaf: REJECT a Conventional-Commits impl subject ───────────
T1=$(mk_task "t1 bad subject")
TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" claim "$T1" >/dev/null 2>&1
echo w1 > i1.txt; git add i1.txt; git commit -qm "feat(helios): add a thing"
HEAD_BEFORE=$(git rev-parse HEAD)
out=$(TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" complete "$T1" 2>&1); rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -qi "Conventional-Commits"; then
  ok "single: refused a Conventional-Commits impl subject"
else
  bad "single: did NOT refuse a bad impl subject (rc=$rc): $out"
fi
# no side effects: HEAD unchanged, active+frontier refs intact
if [ "$(git rev-parse HEAD)" = "$HEAD_BEFORE" ]; then
  ok "single: HEAD unchanged after refusal"
else
  bad "single: HEAD moved despite refusal"
fi
if git show-ref --verify --quiet "refs/heads/tasks/active/$T1"; then
  ok "single: active claim intact after refusal"
else
  bad "single: active claim was removed on refusal"
fi

# amend to a canonical subject → now it completes
git commit -q --amend -m "Add a thing to Helios"
GOOD=$(git rev-parse HEAD)
out=$(TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" complete "$T1" 2>&1); rc=$?
if [ $rc -eq 0 ] && [ "$(git rev-parse HEAD^1)" = "$GOOD" ]; then
  ok "single: completes once the subject is canonical"
else
  bad "single: canonical subject did not complete (rc=$rc): $out"
fi
git push -q origin HEAD:master 2>/dev/null

# ── batch --leaves: report ALL bad subjects, do nothing ───────────────
git checkout -q master 2>/dev/null || true
git push -q origin HEAD:master 2>/dev/null
S_LEAF=$(mk_task "batch server")
C_LEAF=$(mk_task "batch client")
TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" claim "$S_LEAF" >/dev/null 2>&1
TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" claim "$C_LEAF" >/dev/null 2>&1
echo sv > sv.txt; git add sv.txt; git commit -qm "feat: server bit"
S=$(git rev-parse HEAD)
echo cl > cl.txt; git add cl.txt; git commit -qm "fix(client): client bit"
C=$(git rev-parse HEAD)
HEAD_BEFORE=$(git rev-parse HEAD)
out=$(TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" complete --leaves="$S_LEAF:$S,$C_LEAF:$C" 2>&1); rc=$?
if [ $rc -ne 0 ] \
   && echo "$out" | grep -q "server bit" \
   && echo "$out" | grep -q "client bit"; then
  ok "batch: reported BOTH offending impl subjects and refused"
else
  bad "batch: did not report both offenders / did not refuse (rc=$rc): $out"
fi
if [ "$(git rev-parse HEAD)" = "$HEAD_BEFORE" ]; then
  ok "batch: no graft/link side effects after refusal"
else
  bad "batch: history was rewritten despite refusal"
fi

echo
echo "complete-subject-style: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
