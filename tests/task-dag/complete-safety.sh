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
  # Decomposing the epic root requires (and consumes) the orchestration
  # lock (issue #2). --force re-acquires it for each incremental breakdown.
  "$TD" claim-root 999 --force >/dev/null 2>&1
  "$TD" breakdown "$EPIC" --spec-file="$ROOT/spec.json" --force --json 2>/dev/null \
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
# TEST 3b: if publishing the completion races/fails, scheduling refs stay live
# ---------------------------------------------------------------------------
T3B=$(mk_task "t3b publish race keeps refs")
if [ -n "$T3B" ]; then
  TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" claim "$T3B" >/dev/null 2>&1
  git clone -q "$ROOT/origin.git" "$ROOT/concurrent"
  ( cd "$ROOT/concurrent" \
      && echo concurrent > concurrent.txt \
      && git add concurrent.txt \
      && git commit -qm "concurrent master advance" \
      && git push -q origin HEAD:master )
  echo work3b > impl3b.txt; git add impl3b.txt; git commit -qm "impl t3b"
  out=$(TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" complete "$T3B" 2>&1)
  rc=$?
  a=$(git ls-remote origin "refs/heads/tasks/active/$T3B" | wc -l)
  f=$(git ls-remote origin "refs/heads/tasks/frontier/$T3B" | wc -l)
  if [ "$rc" -eq 3 ] && [ "$a" -eq 1 ] && [ "$f" -eq 0 ] && echo "$out" | grep -qi "left intact"; then
    ok "C2b: publish failure leaves the owned active claim intact"
  else
    bad "C2b: expected rc=3 and intact active claim (rc=$rc active=$a frontier=$f out=$out)"
  fi
  git fetch -q origin master
  git reset --hard -q origin/master
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
  git fetch -q origin master
  git reset --hard -q origin/master
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

# find the completion merge whose 2nd+ parent is <leaf task sha>, reachable from HEAD
_merge_for_leaf() {
  git rev-list HEAD --parents \
    | awk -v t="$1" '{for(i=3;i<=NF;i++) if($i==t){print $1; exit}}'
}
# true iff <commit>'s tree differs from its first parent's tree (a REAL impl)
_is_real_impl() {
  local c="$1" t pt
  t=$(git rev-parse "$c^{tree}")
  if git rev-parse -q --verify "$c^1" >/dev/null 2>&1; then pt=$(git rev-parse "$c^1^{tree}"); else pt=4b825dc642cb6eb9a060e54bf8d69288fbee4904; fi
  [ "$t" != "$pt" ]
}

# ---------------------------------------------------------------------------
# TEST 6 (issue #7): DAG-native BATCH completion of stacked sibling leaves.
# Two stacked impls (S then C) in ONE worktree, completed via
# `complete --leaves=SERVER:S,CLIENT:C`; each completion merge's FIRST parent
# is its own impl (honest linear graph), semantics stay in the DAG (no
# Impl-Commit trailer). Single ancestor-complete is refused (points to
# --leaves). Idempotent rerun cleans up only.
# ---------------------------------------------------------------------------
git checkout -q master 2>/dev/null || true
git push -q origin HEAD:master 2>/dev/null      # origin/master == HEAD
BATCH_BASE=$(git rev-parse HEAD)
S_LEAF=$(mk_task "issue7 server leaf")
C_LEAF=$(mk_task "issue7 client leaf")
if [ -n "$S_LEAF" ] && [ -n "$C_LEAF" ]; then
  SLEAF_SHA=$(git rev-parse "refs/heads/tasks/frontier/$S_LEAF")
  CLEAF_SHA=$(git rev-parse "refs/heads/tasks/frontier/$C_LEAF")
  TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" claim "$S_LEAF" >/dev/null 2>&1
  TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" claim "$C_LEAF" >/dev/null 2>&1
  # Two stacked impls, deliberately NOT pushed (graft requires unpushed).
  echo "server work" > server.txt; git add server.txt; git commit -qm "impl server"
  S=$(git rev-parse HEAD)
  echo "client work" > client.txt; git add client.txt; git commit -qm "impl client"
  C=$(git rev-parse HEAD)

  # (a) single complete against an impl BEHIND HEAD is refused → use --leaves
  out=$(TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" complete "$S_LEAF" --commit="$S" 2>&1); rc=$?
  if [ $rc -ne 0 ] && echo "$out" | grep -q -- '--leaves'; then
    ok "7: single complete of an impl behind HEAD refuses and points to --leaves"
  else
    bad "7: single ancestor-complete was not refused (rc=$rc): $out"
  fi

  # (b) batch --leaves completes BOTH stacked siblings in one shot
  out=$(TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" complete --leaves="$S_LEAF:$S,$C_LEAF:$C" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then ok "7: complete --leaves completes both stacked siblings (rc=0)"; else bad "7: complete --leaves failed (rc=$rc): $out"; fi

  # both task commits reachable as completion parents
  if git log HEAD --format='%P' | tr ' ' '\n' | grep -qx "$SLEAF_SHA" \
     && git log HEAD --format='%P' | tr ' ' '\n' | grep -qx "$CLEAF_SHA"; then
    ok "7: both leaves recorded as completion parents reachable from HEAD"
  else
    bad "7: a stacked leaf is not reachable as a completion parent"
  fi

  # DAG-native: each completion merge's FIRST parent is a REAL impl commit
  MS=$(_merge_for_leaf "$SLEAF_SHA"); MC=$(_merge_for_leaf "$CLEAF_SHA")
  if [ -n "$MS" ] && _is_real_impl "$(git rev-parse "$MS^1")"; then
    ok "7: server completion merge's first parent is a real impl (DAG-native)"
  else
    bad "7: server completion merge first parent is not a real impl (MS=$MS)"
  fi
  if [ -n "$MC" ] && _is_real_impl "$(git rev-parse "$MC^1")"; then
    ok "7: client completion merge's first parent is a real impl (DAG-native)"
  else
    bad "7: client completion merge first parent is not a real impl (MC=$MC)"
  fi

  # DAG-native shape: the ONLY merges in the range are the two completion
  # merges, and every merge's 2nd parent is a leaf TASK commit (semantics
  # live in parentage). The first-parent spine is otherwise linear.
  merges=$(git rev-list --min-parents=2 "$BATCH_BASE..HEAD")
  nmerges=$(printf '%s\n' "$merges" | grep -c .)
  bad2parent=0
  for m in $merges; do
    p2=$(git rev-parse "$m^2")
    [ "$p2" = "$SLEAF_SHA" ] || [ "$p2" = "$CLEAF_SHA" ] || bad2parent=1
  done
  if [ "$nmerges" = "2" ] && [ "$bad2parent" = "0" ]; then
    ok "7: only the 2 completion merges exist and each 2nd parent is a leaf task commit"
  else
    bad "7: unexpected DAG shape (merges=$nmerges bad2parent=$bad2parent)"
  fi

  # NO message-encoded provenance: Impl-Commit trailer must not appear
  if git log "$BATCH_BASE..HEAD" --format='%B' | grep -q '^Impl-Commit:'; then
    bad "7: an Impl-Commit message trailer leaked into history"
  else
    ok "7: no Impl-Commit trailer — impl↔task link stays in the DAG"
  fi

  # worktree preserved through the graft (files intact)
  if [ -f server.txt ] && grep -q "server work" server.txt && [ -f client.txt ] && grep -q "client work" client.txt; then
    ok "7: worktree files preserved through the graft"
  else
    bad "7: worktree files lost after graft"
  fi

  # a local backup ref of the old tip exists (recovery)
  if [ -n "$(git for-each-ref 'refs/task-dag-backup/complete-batch/*' 2>/dev/null)" ]; then
    ok "7: old tip preserved under refs/task-dag-backup/ for recovery"
  else
    bad "7: no batch backup ref created"
  fi

  # idempotent rerun (all already completed) → cleanup-only, rc 0
  out=$(TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" complete --leaves="$S_LEAF:$S,$C_LEAF:$C" 2>&1); rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -qi 'already completed'; then
    ok "7: idempotent rerun of a fully-completed batch (cleanup-only, rc=0)"
  else
    bad "7: idempotent rerun not handled (rc=$rc): $out"
  fi
  git push -q origin HEAD:master 2>/dev/null
fi

# ---------------------------------------------------------------------------
# TEST 7 (issue #7): batch respects dependencies (option b) and refuses
# duplicate impls.
# ---------------------------------------------------------------------------
git checkout -q master 2>/dev/null || true
git push -q origin HEAD:master 2>/dev/null
# two leaves in one breakdown: CLIENT (@2) depends on SERVER (@1)
printf '[{"title":"dep server","type":"leaf"},{"title":"dep client","type":"leaf","dependencies":["@1"]}]' > "$ROOT/spec_dep.json"
"$TD" claim-root 999 --force >/dev/null 2>&1
mapfile -t DEP_SHORTS < <("$TD" breakdown "$EPIC" --spec-file="$ROOT/spec_dep.json" --force --json 2>/dev/null | grep -oE '"shortSha":"[0-9a-f]+"' | cut -d'"' -f4)
DSRV="${DEP_SHORTS[0]:-}"; DCLI="${DEP_SHORTS[1]:-}"
if [ -n "$DSRV" ] && [ -n "$DCLI" ]; then
  TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" claim "$DSRV" >/dev/null 2>&1
  TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" claim "$DCLI" >/dev/null 2>&1
  # dependency's impl (server) stacked BELOW the dependent's impl (client)
  echo "dep server work" > dsrv.txt; git add dsrv.txt; git commit -qm "impl dep server"; DS=$(git rev-parse HEAD)
  echo "dep client work" > dcli.txt; git add dcli.txt; git commit -qm "impl dep client"; DC=$(git rev-parse HEAD)

  # WRONG order (dependent's impl stacked below its dependency) → refused.
  # Here we lie about the pairing so the dependent (DCLI) maps to the lower
  # impl DS and the dependency (DSRV) to the higher impl DC — graft order
  # would then complete DCLI before its dependency DSRV.
  out=$(TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" complete --leaves="$DCLI:$DS,$DSRV:$DC" 2>&1); rc=$?
  if [ $rc -ne 0 ] && echo "$out" | grep -qi 'depends on'; then
    ok "8: batch refuses when a dependency's impl is stacked ABOVE the dependent (wrong graft order)"
  else
    bad "8: batch did not refuse reversed dependency order (rc=$rc): $out"
  fi

  # correct order (server impl below) → succeeds
  out=$(TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" complete --leaves="$DSRV:$DS,$DCLI:$DC" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then ok "8: batch with intra-batch dependency (dep impl stacked below) succeeds"; else bad "8: dependency batch failed (rc=$rc): $out"; fi
  git push -q origin HEAD:master 2>/dev/null
fi

# duplicate impl in one --leaves is refused
git checkout -q master 2>/dev/null || true; git push -q origin HEAD:master 2>/dev/null
D1=$(mk_task "dup impl A"); D2=$(mk_task "dup impl B")
if [ -n "$D1" ] && [ -n "$D2" ]; then
  TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" claim "$D1" >/dev/null 2>&1
  TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" claim "$D2" >/dev/null 2>&1
  echo dup > dup.txt; git add dup.txt; git commit -qm "impl dup"; DUP=$(git rev-parse HEAD)
  out=$(TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" complete --leaves="$D1:$DUP,$D2:$DUP" 2>&1); rc=$?
  if [ $rc -ne 0 ] && echo "$out" | grep -qi 'same impl commit'; then
    ok "8: batch refuses two leaves sharing one impl commit"
  else
    bad "8: batch did not refuse duplicate impls (rc=$rc): $out"
  fi

  # duplicate LEAF in one --leaves is refused (needs a 2nd real impl so the
  # dedupe fails on the leaf, not the impl)
  echo dup2 > dup2.txt; git add dup2.txt; git commit -qm "impl dup2"; DUP2=$(git rev-parse HEAD)
  out=$(TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h "$TD" complete --leaves="$D1:$DUP,$D1:$DUP2" 2>&1); rc=$?
  if [ $rc -ne 0 ] && echo "$out" | grep -qi 'listed twice'; then
    ok "8: batch refuses the same leaf listed twice"
  else
    bad "8: batch did not refuse a duplicate leaf (rc=$rc): $out"
  fi
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
