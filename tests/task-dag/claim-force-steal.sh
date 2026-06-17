#!/usr/bin/env bash
# Fixture test: `claim --force` must be able to STEAL a known-dead claim.
#
# Regression for the bug where force mode emptied the leases but pushed the
# active refspec WITHOUT a leading '+', so overwriting the existing (dead)
# active ref was a non-fast-forward that git rejected — the steal silently
# failed and the dead claim could never be recovered (virusdave/top-level#20).
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

# Create a real task on the frontier (a leaf under an epic).
EPIC=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: epic
Type: epic")
TASK=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p "$EPIC" -m "Task: do a thing
Type: task")
SHORT=$(git rev-parse --short "$TASK")
git update-ref "refs/heads/tasks/frontier/$SHORT" "$TASK"
git push -q origin "refs/heads/tasks/frontier/$SHORT"

active_on_origin(){ git ls-remote origin "refs/heads/tasks/active/$SHORT" | awk '{print $1}'; }
frontier_on_origin(){ git ls-remote origin "refs/heads/tasks/frontier/$SHORT" | awk '{print $1}'; }

# Worker A claims it (simulating the original, now-dead worker).
TASK_DAG_CLAIMER_PID=4242 "$TD" claim "$SHORT" --note='worker-A' >/dev/null 2>&1
a_active=$(active_on_origin)
[ -n "$a_active" ] && ok "worker-A claim created an active ref" \
  || bad "worker-A claim did not create active ref"
[ -z "$(frontier_on_origin)" ] && ok "worker-A claim removed the frontier ref" \
  || bad "worker-A claim left frontier ref behind"

# Worker B is a different process/host with no local active ref. A plain
# claim must be refused (claim still held).
rm -rf "$ROOT/wcB"; git clone -q "$ROOT/origin.git" "$ROOT/wcB"; cd "$ROOT/wcB"
"$TD" claim "$SHORT" --note='worker-B plain' >/dev/null 2>&1
rc=$?
[ "$rc" -ne 0 ] && ok "plain claim refused while claim is held (rc=$rc)" \
  || bad "plain claim unexpectedly succeeded over a live claim"

# Operator has determined the claim is dead → worker B force-steals it.
out=$("$TD" claim "$SHORT" --force --note='worker-B steal' 2>&1); rc=$?
b_active=$(active_on_origin)
if [ "$rc" -eq 0 ] && [ -n "$b_active" ] && [ "$b_active" != "$a_active" ]; then
  ok "claim --force STOLE the dead claim (active ref advanced to B)"
else
  bad "claim --force failed to steal (rc=$rc, active=$b_active, was=$a_active)"
  echo "$out" | sed 's/^/    /'
fi

# The stolen claim must record worker B, not the dead worker A.
msg=$(git log -1 --format=%B "refs/heads/tasks/active/$SHORT" 2>/dev/null || true)
echo "$msg" | grep -q 'worker-B steal' \
  && ok "stolen active ref records the new (B) claimer note" \
  || bad "stolen active ref does not record worker-B note"

echo "-----"; echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
