#!/usr/bin/env bash
# Fixture test for the operator-blocked dashboard EVENT EMITTER added to
# block/unblock/complete/drop (virusdave/top-level#29).
#
# The emitter POSTs a `repository_dispatch` (event_type
# operator-blocked-changed) to the dashboard repo so the #29 "one-stop
# shop" dashboard rebuilds within seconds (the low-latency path; the
# workflow's schedule is only a backstop).
#
# Covers:
#   * block / unblock fire exactly one dispatch to the default repo
#     (virusdave/top-level) with the right event_type + action payload;
#   * complete / drop fire ONLY when they actually clear a block (a
#     never-blocked task must not churn the dashboard);
#   * the firing is best-effort and never changes the command exit status;
#   * the safety gate: with a local (non-network) origin and no force, NO
#     dispatch fires — this is what keeps the other fixture tests from
#     hitting real GitHub;
#   * TASK_DAG_DASHBOARD_DISPATCH_REPO overrides the target and, when
#     empty, disables the emitter entirely.
#
# A fake `gh` on PATH records every invocation so we can assert on the
# dispatch call without any network. The test seam
# TASK_DAG_DASHBOARD_DISPATCH_FORCE=1 bypasses the network-origin gate so
# the firing path can run against the local bare-repo origin.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h

# Fake gh: append the full argument string to a log, succeed silently.
mkdir -p "$ROOT/bin"
GHLOG="$ROOT/gh-calls.log"
: > "$GHLOG"
cat > "$ROOT/bin/gh" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$GHLOG"
exit 0
EOF
chmod +x "$ROOT/bin/gh"
export PATH="$ROOT/bin:$PATH"
ghlines() { wc -l < "$GHLOG" | tr -d ' '; }

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc" 2>/dev/null
cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master 2>/dev/null

EMPTY_TREE=$(git hash-object -t tree /dev/null)
EPIC=$(git commit-tree "$EMPTY_TREE" -p HEAD -m "Task: Test epic

Issue: #999
URL: https://github.com/test/test/issues/999
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/gh/issues/999 "$EPIC"
git update-ref refs/heads/tasks/pending/999 "$EPIC"
git push -q origin refs/heads/gh/issues/999 refs/heads/tasks/pending/999 2>/dev/null

mk_task() {  # prints the new leaf task short sha
  local title="$1"
  printf '[{"title":"%s","type":"leaf"}]' "$title" > "$ROOT/spec.json"
  # Decomposing the epic root requires (and consumes) the orchestration
  # lock (issue #2). --force re-acquires it for each incremental breakdown.
  "$TD" claim-root 999 --force >/dev/null 2>&1
  "$TD" breakdown "$EPIC" --spec-file="$ROOT/spec.json" --force --json 2>/dev/null \
    | grep -oE '"shortSha":"[0-9a-f]+"' | head -1 | cut -d'"' -f4
}

T=$(mk_task "dispatch block task")
[ -n "$T" ] || { echo "could not create task"; echo "PASS=0 FAIL=1"; exit 1; }

# TEST 1: block (forced) fires exactly one dispatch to the default repo
# with the right event_type + action, and the command still succeeds.
: > "$GHLOG"
TASK_DAG_DASHBOARD_DISPATCH_FORCE=1 "$TD" block "$T" --reason=x >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ "$(ghlines)" -eq 1 ] \
   && grep -q "repos/virusdave/top-level/dispatches" "$GHLOG" \
   && grep -q "event_type=operator-blocked-changed" "$GHLOG" \
   && grep -q "action]=block" "$GHLOG"; then
  ok "1: block fires one dispatch to virusdave/top-level (event+action correct, rc=0)"
else
  bad "1: block dispatch wrong (rc=$rc, lines=$(ghlines)): $(cat "$GHLOG")"
fi

# TEST 2: unblock fires a dispatch with action=unblock.
: > "$GHLOG"
TASK_DAG_DASHBOARD_DISPATCH_FORCE=1 "$TD" unblock "$T" >/dev/null 2>&1
if [ "$(ghlines)" -eq 1 ] && grep -q "action]=unblock" "$GHLOG"; then
  ok "2: unblock fires a dispatch (action=unblock)"
else
  bad "2: unblock dispatch wrong (lines=$(ghlines)): $(cat "$GHLOG")"
fi

# TEST 3: SAFETY GATE — with a local origin and NO force, block fires nothing
# (this is what stops the other fixture tests from hitting real GitHub).
: > "$GHLOG"
"$TD" block "$T" --reason=y >/dev/null 2>&1
if [ "$(ghlines)" -eq 0 ]; then
  ok "3: local-origin block does NOT dispatch without the force seam (test safety gate)"
else
  bad "3: local-origin block dispatched anyway: $(cat "$GHLOG")"
fi

# TEST 4: empty TASK_DAG_DASHBOARD_DISPATCH_REPO disables the emitter even
# when forced.
: > "$GHLOG"
TASK_DAG_DASHBOARD_DISPATCH_FORCE=1 TASK_DAG_DASHBOARD_DISPATCH_REPO="" "$TD" unblock "$T" >/dev/null 2>&1
if [ "$(ghlines)" -eq 0 ]; then
  ok "4: empty TASK_DAG_DASHBOARD_DISPATCH_REPO disables the emitter"
else
  bad "4: emitter fired despite empty dispatch repo: $(cat "$GHLOG")"
fi

# TEST 5: TASK_DAG_DASHBOARD_DISPATCH_REPO overrides the target repo.
: > "$GHLOG"
TASK_DAG_DASHBOARD_DISPATCH_FORCE=1 TASK_DAG_DASHBOARD_DISPATCH_REPO="acme/dash" \
    "$TD" block "$T" --reason=z >/dev/null 2>&1
if grep -q "repos/acme/dash/dispatches" "$GHLOG" \
   && ! grep -q "virusdave/top-level" "$GHLOG"; then
  ok "5: dispatch repo override targets acme/dash"
else
  bad "5: dispatch repo override ignored: $(cat "$GHLOG")"
fi

# TEST 6: local complete is silent; post-push convergence fires the dispatch.
T2=$(mk_task "complete blocked task")
"$TD" block "$T2" --reason=temp >/dev/null 2>&1
git clone -q "$ROOT/origin.git" "$ROOT/c2" 2>/dev/null
cd "$ROOT/c2"; git checkout -q master
echo w > w.txt; git add w.txt; git commit -qm "work T2" >/dev/null
: > "$GHLOG"
BEFORE=$(git ls-remote origin refs/heads/master | awk '{print $1}')
TASK_DAG_DASHBOARD_DISPATCH_FORCE=1 "$TD" complete "$T2" >/dev/null 2>&1
if [ "$(ghlines)" -eq 0 ]; then
  ok "6: local complete does not dispatch before publication"
else
  bad "6: local complete dispatched before publication: $(cat "$GHLOG")"
fi
git push -q origin HEAD:master
TASK_DAG_DASHBOARD_DISPATCH_FORCE=1 "$TD" graph-converge --range "$BEFORE..HEAD" >/dev/null 2>&1
if [ "$(ghlines)" -ge 1 ] && grep -q "action]=complete" "$GHLOG"; then
  ok "6: convergence of a blocked completion fires a dispatch"
else
  bad "6: blocked-completion convergence did not dispatch: $(cat "$GHLOG")"
fi
cd "$ROOT/wc"

# TEST 7: complete of a NEVER-BLOCKED task fires NO dispatch (no dashboard churn).
T3=$(mk_task "complete unblocked task")
git clone -q "$ROOT/origin.git" "$ROOT/c3" 2>/dev/null
cd "$ROOT/c3"; git checkout -q master
echo w > w.txt; git add w.txt; git commit -qm "work T3" >/dev/null
: > "$GHLOG"
TASK_DAG_DASHBOARD_DISPATCH_FORCE=1 "$TD" complete "$T3" >/dev/null 2>&1
if [ "$(ghlines)" -eq 0 ]; then
  ok "7: complete of a never-blocked task does NOT dispatch"
else
  bad "7: complete-of-unblocked dispatched unexpectedly: $(cat "$GHLOG")"
fi
cd "$ROOT/wc"

# TEST 8: drop of a BLOCKED task fires (action=drop); drop of a never-blocked
# task fires nothing.
T4=$(mk_task "drop blocked task")
"$TD" block "$T4" --reason=temp >/dev/null 2>&1
: > "$GHLOG"
TASK_DAG_DASHBOARD_DISPATCH_FORCE=1 "$TD" drop "$T4" --yes >/dev/null 2>&1
if [ "$(ghlines)" -ge 1 ] && grep -q "action]=drop" "$GHLOG"; then
  ok "8: drop of a blocked task fires a dispatch (action=drop)"
else
  bad "8: drop-of-blocked did not dispatch: $(cat "$GHLOG")"
fi

T5=$(mk_task "drop unblocked task")
: > "$GHLOG"
TASK_DAG_DASHBOARD_DISPATCH_FORCE=1 "$TD" drop "$T5" --yes >/dev/null 2>&1
if [ "$(ghlines)" -eq 0 ]; then
  ok "9: drop of a never-blocked task does NOT dispatch"
else
  bad "9: drop-of-unblocked dispatched unexpectedly: $(cat "$GHLOG")"
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
