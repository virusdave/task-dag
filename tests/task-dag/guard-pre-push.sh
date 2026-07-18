#!/usr/bin/env bash
# Fixture test for `task-dag guard-pre-push` (top-level#45): the canonical
# check behind the per-repo pre-push hook. It enforces exactly ONE invariant —
# do not push PLAIN implementation work to master while you still hold an
# unresolved task-dag claim in this repo (i.e. you skipped `task-dag complete`).
# Everything else passes; it fails OPEN on anything it can't evaluate.
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
BASE=$(git rev-parse HEAD)
ZERO=$(git rev-parse HEAD | tr '0-9a-f' '0')
URL="file://$ROOT/origin.git"

# epic + refs
EPIC=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: Test epic

Issue: #999
URL: https://github.com/test/test/issues/999
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/gh/issues/999 "$EPIC"
git update-ref refs/heads/tasks/pending/999 "$EPIC"
git push -q origin refs/heads/gh/issues/999 refs/heads/tasks/pending/999

mk_task() {  # prints new leaf short sha
  printf '[{"title":"%s","type":"leaf"}]' "$1" > "$ROOT/spec.json"
  "$TD" claim-root 999 --force >/dev/null 2>&1
  "$TD" breakdown "$EPIC" --spec-file="$ROOT/spec.json" --force --json 2>/dev/null \
    | grep -oE '"shortSha":"[0-9a-f]+"' | head -1 | cut -d'"' -f4
}

# run_guard <claimer> <host> <remote-name> <stdin-line...> ; extra lines via $6+
# Returns the guard's exit code; captures nothing.
guard() {  # env-claimer env-host remote  ; stdin provided by caller via <<<
  local cl="$1" host="$2" remote="$3"
  if [ -z "$cl" ]; then
    "$TD" guard-pre-push "$remote" "$URL" >/dev/null 2>&1
  else
    TASK_DAG_CLAIMER="$cl" TASK_DAG_CLAIMER_HOST="$host" \
      "$TD" guard-pre-push "$remote" "$URL" >/dev/null 2>&1
  fi
}

# ── Core BLOCK: owned unresolved claim + plain impl tip on master ──────
T1=$(mk_task "t1 block")
TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" claim "$T1" >/dev/null 2>&1
echo work1 > impl1.txt; git add impl1.txt; git commit -qm "Implement thing one"
L1=$(git rev-parse HEAD)

guard me h origin <<<"refs/heads/master $L1 refs/heads/master $BASE"
[ $? -eq 1 ] && ok "BLOCK: owned unresolved claim + plain impl tip" \
             || bad "did NOT block owned unresolved claim + plain impl tip"

# multiple stdin lines: a task-ref update + the blocking master update → block
guard me h origin <<EOF
refs/heads/tasks/active/$T1 $L1 refs/heads/tasks/active/$T1 $ZERO
refs/heads/master $L1 refs/heads/master $BASE
EOF
[ $? -eq 1 ] && ok "BLOCK: still blocks when a task-ref line precedes master" \
             || bad "did NOT block with mixed stdin lines"

# ── ALLOW: foreign claimer / host ─────────────────────────────────────
guard other h origin <<<"refs/heads/master $L1 refs/heads/master $BASE"
[ $? -eq 0 ] && ok "ALLOW: claim owned by a different claimer" \
             || bad "wrongly blocked a foreign-claimer push"
guard me otherhost origin <<<"refs/heads/master $L1 refs/heads/master $BASE"
[ $? -eq 0 ] && ok "ALLOW: claim owned on a different host" \
             || bad "wrongly blocked a foreign-host push"

# ── ALLOW: no claimer identity (fail open) ────────────────────────────
guard "" "" origin <<<"refs/heads/master $L1 refs/heads/master $BASE"
[ $? -eq 0 ] && ok "ALLOW: no TASK_DAG_CLAIMER (fail open)" \
             || bad "wrongly blocked with no claimer identity"

# ── ALLOW: non-master ref update ──────────────────────────────────────
guard me h origin <<<"refs/heads/feature $L1 refs/heads/feature $BASE"
[ $? -eq 0 ] && ok "ALLOW: non-master ref update" \
             || bad "wrongly blocked a non-master ref update"

# ── ALLOW: master deletion (local sha all zeros) ──────────────────────
guard me h origin <<<"(delete) $ZERO refs/heads/master $BASE"
[ $? -eq 0 ] && ok "ALLOW: master deletion" \
             || bad "wrongly blocked a master deletion"

# ── BLOCK: prepared-worker first push has no semantic base ───────────
guard me h origin <<<"refs/heads/master $L1 refs/heads/master $ZERO"
[ $? -eq 1 ] && ok "BLOCK: first master push has no semantic base" \
             || bad "allowed prepared-worker first master push without a semantic base"

# ── ALLOW: non-origin remote ──────────────────────────────────────────
guard me h upstream <<<"refs/heads/master $L1 refs/heads/master $BASE"
[ $? -eq 0 ] && ok "ALLOW: non-origin remote" \
             || bad "wrongly blocked a non-origin remote push"

# ── ALLOW: properly completed (tip is a completion merge) ─────────────
TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" complete "$T1" >/dev/null 2>&1
CM=$(git rev-parse HEAD)   # completion merge
guard me h origin <<<"refs/heads/master $CM refs/heads/master $BASE"
[ $? -eq 0 ] && ok "ALLOW: tip is a completion merge (active ref still live)" \
             || bad "wrongly blocked a properly-completed push"
git push -q origin HEAD:master 2>/dev/null
BASE=$(git rev-parse HEAD)

# ── ALLOW: completion leaves an active ref, but tip resolves it in history
T2=$(mk_task "t2 local cleanup")
TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" claim "$T2" >/dev/null 2>&1
echo work2 > impl2.txt; git add impl2.txt; git commit -qm "Implement thing two"
TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" complete "$T2" >/dev/null 2>&1
CM2=$(git rev-parse HEAD)
# active ref remains present until server reconciliation
if git show-ref --verify --quiet "refs/heads/tasks/active/$T2"; then
  ok "setup: local completion left the active ref present"
else
  bad "setup: expected active ref to linger until reconciliation"
fi
guard me h origin <<<"refs/heads/master $CM2 refs/heads/master $BASE"
[ $? -eq 0 ] && ok "ALLOW: live active ref, tip is completion merge" \
             || bad "wrongly blocked a local completion push"
# and a later PLAIN commit stacked on top still passes (task already linked)
echo more2 > more2.txt; git add more2.txt; git commit -qm "Add more thing two"
L2b=$(git rev-parse HEAD)
guard me h origin <<<"refs/heads/master $L2b refs/heads/master $BASE"
[ $? -eq 0 ] && ok "ALLOW: plain tip but claim already resolved in pushed history" \
             || bad "wrongly blocked when the claim was already resolved in history"

echo
echo "guard-pre-push: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
