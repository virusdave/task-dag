#!/usr/bin/env bash
# Fixture smoke test: `claim` records the worker PID (Claimer-PID) so a
# same-host janitor can detect an orphaned claim left by a dead worker.
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
  # --force: this helper decomposes the SAME epic repeatedly to mint
  # several independent leaves; the double-decompose guard (which now also
  # recognizes already-claimed children) would otherwise refuse the 2nd+.
  # Decomposing the epic root also requires (and consumes) the orchestration
  # lock (issue #2). --force re-acquires it for each incremental breakdown.
  "$TD" claim-root 999 --force >/dev/null 2>&1
  "$TD" breakdown "$EPIC" --spec-file="$ROOT/spec.json" --force --json 2>/dev/null \
    | grep -oE '"shortSha":"[0-9a-f]+"' | head -1 | cut -d'"' -f4
}

# ---------------------------------------------------------------------------
# TEST 1: an explicit --pid is recorded verbatim in the claim commit.
# ---------------------------------------------------------------------------
T1=$(mk_task "t1 explicit pid")
if [ -n "$T1" ]; then
  TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" claim "$T1" --pid=424242 >/dev/null 2>&1
  msg=$(git log -1 --format=%B "refs/heads/tasks/active/$T1" 2>/dev/null || true)
  if grep -q '^Claimer-PID: 424242$' <<<"$msg"; then
    ok "1: explicit --pid recorded as Claimer-PID in the claim commit"
  else
    bad "1: Claimer-PID 424242 missing from claim commit message: $msg"
  fi
else
  bad "1: could not create T1"
fi

# ---------------------------------------------------------------------------
# TEST 2: TASK_DAG_CLAIMER_PID env var is honored.
# ---------------------------------------------------------------------------
T2=$(mk_task "t2 env pid")
if [ -n "$T2" ]; then
  TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h TASK_DAG_CLAIMER_PID=515151 \
    "$TD" claim "$T2" >/dev/null 2>&1
  msg=$(git log -1 --format=%B "refs/heads/tasks/active/$T2" 2>/dev/null || true)
  if grep -q '^Claimer-PID: 515151$' <<<"$msg"; then
    ok "2: TASK_DAG_CLAIMER_PID env var recorded as Claimer-PID"
  else
    bad "2: env Claimer-PID missing from claim commit message: $msg"
  fi
else
  bad "2: could not create T2"
fi

# ---------------------------------------------------------------------------
# TEST 3: with no override, a numeric default pid ($PPID) is recorded.
# ---------------------------------------------------------------------------
T3=$(mk_task "t3 default pid")
if [ -n "$T3" ]; then
  env -u TASK_DAG_CLAIMER_PID TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h \
    "$TD" claim "$T3" >/dev/null 2>&1
  pid_line=$(git log -1 --format=%B "refs/heads/tasks/active/$T3" 2>/dev/null \
    | sed -n 's/^Claimer-PID: //p')
  if [[ "$pid_line" =~ ^[0-9]+$ ]]; then
    ok "3: default claim records a numeric Claimer-PID ($pid_line)"
  else
    bad "3: default claim Claimer-PID not numeric: '$pid_line'"
  fi
else
  bad "3: could not create T3"
fi

# ---------------------------------------------------------------------------
# TEST 4: `active --json` surfaces claimerPid for a claimed task.
# ---------------------------------------------------------------------------
if [ -n "$T1" ]; then
  json=$("$TD" active --json --no-fetch 2>/dev/null || true)
  if grep -q '"claimerPid": 424242' <<<"$json"; then
    ok "4: active --json exposes claimerPid"
  else
    bad "4: claimerPid 424242 not found in active --json: $json"
  fi
else
  bad "4: skipped (no T1)"
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
