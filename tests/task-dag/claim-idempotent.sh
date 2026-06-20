#!/usr/bin/env bash
# Fixture test: a leaf `claim` is IDEMPOTENT for the same worker identity.
#
# The github-worker dispatcher now wins the authoritative task-dag CAS
# BEFORE it spawns the agent (so N workers can't all select the same
# frontier leaf and waste N-1 runs). The agent it spawns then VERIFIES the
# claim by re-running `claim` under the inherited
# TASK_DAG_CLAIMER/_HOST/_PID identity. That re-claim must SUCCEED for the
# same identity, but a DIFFERENT identity must still be refused.
set -uo pipefail
TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok(){ echo "PASS: $1"; PASS=$((PASS+1)); }
bad(){ echo "FAIL: $1"; FAIL=$((FAIL+1)); }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_GIT_NAME=t TASK_DAG_GIT_EMAIL=t@t

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"; cd "$ROOT/wc"
echo s>s; git add s; git commit -qm s; git push -q origin HEAD:master

EPIC=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: epic
Type: epic")
TASK=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p "$EPIC" -m "Task: do a thing
Type: task")
SHORT=$(git rev-parse --short "$TASK")
git update-ref "refs/heads/tasks/frontier/$SHORT" "$TASK"
git push -q origin "refs/heads/tasks/frontier/$SHORT"

active_on_origin(){ git ls-remote origin "refs/heads/tasks/active/$SHORT" | awk '{print $1}'; }

# Worker w1 (the dispatcher) wins the authoritative claim.
TASK_DAG_CLAIMER=w1 TASK_DAG_CLAIMER_HOST=h1 TASK_DAG_CLAIMER_PID=111 \
  "$TD" claim "$SHORT" --note='dispatcher preclaim' >/dev/null 2>&1
a1=$(active_on_origin)
[ -n "$a1" ] && ok "1: dispatcher claim created the active ref" \
  || bad "1: dispatcher claim did not create active ref"

# The agent it spawned re-claims under the SAME inherited identity → ok.
if TASK_DAG_CLAIMER=w1 TASK_DAG_CLAIMER_HOST=h1 TASK_DAG_CLAIMER_PID=111 \
     "$TD" claim "$SHORT" --note='agent verify' >/dev/null 2>&1; then
  ok "2: agent re-claim under the SAME identity is idempotent (exit 0)"
else
  rc=$?; bad "2: same-identity re-claim should succeed, got exit $rc"
fi

# The idempotent verify must NOT have rewritten the active ref (no churn).
a2=$(active_on_origin)
[ "$a2" = "$a1" ] && ok "3: idempotent re-claim left the active ref unchanged" \
  || bad "3: idempotent re-claim rewrote active ref ($a1 -> $a2)"

# The --json form reports alreadyHeld:true for the verify.
json=$(TASK_DAG_CLAIMER=w1 TASK_DAG_CLAIMER_HOST=h1 TASK_DAG_CLAIMER_PID=111 \
        "$TD" claim "$SHORT" --json 2>/dev/null || true)
grep -q '"alreadyHeld":true' <<<"$json" \
  && ok "4: --json re-claim reports alreadyHeld:true" \
  || bad "4: --json re-claim missing alreadyHeld:true ($json)"

# A DIFFERENT worker identity is still refused (exit 2), even same host/user.
if TASK_DAG_CLAIMER=w2 TASK_DAG_CLAIMER_HOST=h1 TASK_DAG_CLAIMER_PID=222 \
     "$TD" claim "$SHORT" >/dev/null 2>&1; then
  bad "5: claim by a DIFFERENT identity succeeded (should be refused)"
else
  rc=$?
  [ "$rc" = 2 ] && ok "5: claim by a different identity refused (exit 2)" \
    || bad "5: wrong exit $rc"
fi

# Same claimer + host but different PID is also refused (only the live
# claiming process can re-confirm; PID is the liveness discriminator).
if TASK_DAG_CLAIMER=w1 TASK_DAG_CLAIMER_HOST=h1 TASK_DAG_CLAIMER_PID=999 \
     "$TD" claim "$SHORT" >/dev/null 2>&1; then
  bad "6: claim with a different PID succeeded (should be refused)"
else
  rc=$?
  [ "$rc" = 2 ] && ok "6: claim with a different PID refused (exit 2)" \
    || bad "6: wrong exit $rc"
fi

echo "-----"; echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
