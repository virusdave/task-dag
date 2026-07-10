#!/usr/bin/env bash
# Fixture smoke test for epic-root orchestration locking (issue #2):
# claim-root / release-root + breakdown-consumes-lock + complete guard.
#
# Builds a throwaway bare origin + working clone (no network, no real
# repo). Mirrors the style of the other tests/task-dag/*.sh fixtures.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"
cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master

# Mint an epic root for issue #999 (mirrors create-task-commit.sh output).
EPIC=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: Test epic

Issue: #999
URL: https://github.com/test/test/issues/999
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/gh/issues/999 "$EPIC"
git update-ref refs/heads/tasks/pending/999 "$EPIC"
git push -q origin refs/heads/gh/issues/999 refs/heads/tasks/pending/999

remote_has() { git ls-remote origin "$1" | grep -q .; }

# ---------------------------------------------------------------------------
# TEST 1: claim-root creates tasks/root-active/<N>; a re-claim by the SAME
# worker identity is idempotent (success), but a DIFFERENT identity is
# refused. The idempotent re-claim is what lets the github-worker
# dispatcher PRE-CLAIM a root and then have the agent it spawns VERIFY
# ownership by re-running claim-root under the inherited identity.
# ---------------------------------------------------------------------------
if TASK_DAG_CLAIMER=w1 TASK_DAG_CLAIMER_HOST=h1 TASK_DAG_CLAIMER_PID=111 \
     "$TD" claim-root 999 >/dev/null 2>&1; then
  if remote_has refs/heads/tasks/root-active/999; then
    ok "1a: claim-root created tasks/root-active/999 on origin"
  else
    bad "1a: tasks/root-active/999 missing on origin after claim-root"
  fi
else
  bad "1a: claim-root 999 failed"
fi

if TASK_DAG_CLAIMER=w1 TASK_DAG_CLAIMER_HOST=h1 TASK_DAG_CLAIMER_PID=111 \
     "$TD" claim-root 999 >/dev/null 2>&1; then
  ok "1b: re-claim-root by the SAME identity is idempotent (exit 0)"
else
  rc=$?
  bad "1b: same-identity re-claim should succeed, got exit $rc"
fi

if TASK_DAG_CLAIMER=w2 TASK_DAG_CLAIMER_HOST=h2 TASK_DAG_CLAIMER_PID=222 \
     "$TD" claim-root 999 >/dev/null 2>&1; then
  bad "1c: claim-root 999 by a DIFFERENT identity succeeded (should be refused)"
else
  rc=$?
  [ "$rc" = 2 ] && ok "1c: claim-root by a different identity refused (exit 2)" || bad "1c: wrong exit $rc"
fi

# ---------------------------------------------------------------------------
# TEST 2: breakdown WITHOUT the lock is refused (re-mint clean root #1000).
# ---------------------------------------------------------------------------
EPIC2=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: Epic two

Issue: #1000
URL: https://github.com/test/test/issues/1000
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/tasks/pending/1000 "$EPIC2"
git push -q origin refs/heads/tasks/pending/1000
printf '[{"title":"leaf one","type":"leaf"}]' > "$ROOT/spec.json"
if "$TD" breakdown "$EPIC2" --spec-file="$ROOT/spec.json" >/dev/null 2>&1; then
  bad "2: breakdown of unclaimed root #1000 succeeded (should require claim-root)"
else
  if remote_has 'refs/heads/tasks/frontier/*'; then
    bad "2: breakdown created frontier refs despite no root lock"
  else
    ok "2: breakdown of unclaimed root refused and created no frontier refs"
  fi
fi

# ---------------------------------------------------------------------------
# TEST 3: claim-root + breakdown publishes leaves, consumes lock, keeps pending.
# ---------------------------------------------------------------------------
"$TD" claim-root 1000 >/dev/null 2>&1
printf '[{"title":"leaf A","type":"leaf"},{"title":"leaf B","type":"leaf"}]' > "$ROOT/spec.json"
if "$TD" breakdown "$EPIC2" --spec-file="$ROOT/spec.json" >/dev/null 2>&1; then
  leaf_ct=$(git ls-remote origin 'refs/heads/tasks/frontier/*' | wc -l | tr -d ' ')
  if [ "$leaf_ct" = "2" ]; then ok "3a: breakdown published 2 frontier leaves"; else bad "3a: expected 2 leaves, got $leaf_ct"; fi
  if remote_has refs/heads/tasks/root-active/1000; then
    bad "3b: root-active/1000 still present after breakdown (lock not consumed)"
  else
    ok "3b: breakdown consumed root-active/1000"
  fi
  if [ "$(git ls-remote origin refs/heads/tasks/pending/1000 | awk '{print $1}')" = "$EPIC2" ]; then
    ok "3c: tasks/pending/1000 identity preserved at original root SHA"
  else
    bad "3c: tasks/pending/1000 moved/deleted by breakdown"
  fi
else
  bad "3: breakdown of claimed root #1000 failed"
fi

# ---------------------------------------------------------------------------
# TEST 4: claim-root on an already-decomposed root is refused.
# ---------------------------------------------------------------------------
if "$TD" claim-root 1000 >/dev/null 2>&1; then
  bad "4: claim-root on decomposed root #1000 succeeded (should be already-decomposed)"
else
  ok "4: claim-root on decomposed root refused"
fi

# ---------------------------------------------------------------------------
# TEST 5: complete on a decomposed root is refused (before side effects).
# ---------------------------------------------------------------------------
HEAD_BEFORE=$(git rev-parse HEAD)
if "$TD" complete "$EPIC2" >/dev/null 2>&1; then
  bad "5: complete on decomposed root #1000 succeeded (should refuse)"
else
  [ "$(git rev-parse HEAD)" = "$HEAD_BEFORE" ] && ok "5: complete on root refused without moving HEAD" \
    || bad "5: complete refused but HEAD moved"
fi

# ---------------------------------------------------------------------------
# TEST 6: active-child detection — a re-claimed root with an ACTIVE child
#         (claimed leaf) still refuses a non-force breakdown.
# ---------------------------------------------------------------------------
LEAF=$(git ls-remote origin 'refs/heads/tasks/frontier/*' | head -1 | sed 's#.*/##')
"$TD" claim "$LEAF" >/dev/null 2>&1   # frontier -> active
"$TD" claim-root 1000 --force >/dev/null 2>&1   # re-establish lock on decomposed root
printf '[{"title":"leaf C","type":"leaf"}]' > "$ROOT/spec.json"
if "$TD" breakdown "$EPIC2" --spec-file="$ROOT/spec.json" >/dev/null 2>&1; then
  bad "6: breakdown succeeded despite existing ACTIVE child (dup not detected)"
else
  ok "6: breakdown detects active child and refuses duplicate decomposition"
fi
"$TD" release-root 1000 >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# TEST 7: release-root deletes the lock and creates NO frontier ref.
# ---------------------------------------------------------------------------
EPIC3=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: Epic three

Issue: #1001
URL: https://github.com/test/test/issues/1001
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/tasks/pending/1001 "$EPIC3"
git push -q origin refs/heads/tasks/pending/1001
"$TD" claim-root 1001 >/dev/null 2>&1
ROOT_SHORT=$(git rev-parse --short "$EPIC3")
if "$TD" release-root 1001 >/dev/null 2>&1; then
  if remote_has refs/heads/tasks/root-active/1001; then
    bad "7a: release-root left root-active/1001 on origin"
  else
    ok "7a: release-root deleted root-active/1001"
  fi
  if git ls-remote origin "refs/heads/tasks/frontier/${ROOT_SHORT}" | grep -q .; then
    bad "7b: release-root created a frontier ref for the root"
  else
    ok "7b: release-root created no frontier ref"
  fi
else
  bad "7: release-root 1001 failed"
fi

# ---------------------------------------------------------------------------
# TEST 8: non-root breakdown (decompose a leaf task) needs NO root lock.
# ---------------------------------------------------------------------------
"$TD" claim-root 1001 >/dev/null 2>&1
printf '[{"title":"sub leaf","type":"leaf"}]' > "$ROOT/spec.json"
"$TD" breakdown "$EPIC3" --spec-file="$ROOT/spec.json" >/dev/null 2>&1
CHILD=$(git ls-remote origin 'refs/heads/tasks/frontier/*' \
  | while read -r s r; do
      git fetch -q origin "$r:refs/tmp/c" 2>/dev/null
      if [ "$(git log -1 --format='%P' refs/tmp/c | awk '{print $1}')" = "$EPIC3" ]; then
        echo "${r##*/}"; git update-ref -d refs/tmp/c; break
      fi
      git update-ref -d refs/tmp/c 2>/dev/null
    done)
if [ -n "$CHILD" ]; then
  printf '[{"title":"sub-sub leaf","type":"leaf"}]' > "$ROOT/spec.json"
  if "$TD" breakdown "$CHILD" --spec-file="$ROOT/spec.json" >/dev/null 2>&1; then
    ok "8: non-root (leaf) breakdown succeeds without a root lock"
  else
    bad "8: non-root breakdown was incorrectly gated on a root lock"
  fi
else
  bad "8: could not locate a child leaf of root #1001 to sub-decompose"
fi

# ---------------------------------------------------------------------------
# TEST 9: a foreign owner cannot consume someone else's root lock via
#         breakdown (ownership enforced; take-over needs claim-root --force).
# ---------------------------------------------------------------------------
EPIC4=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: Epic four

Issue: #1002
URL: https://github.com/test/test/issues/1002
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/tasks/pending/1002 "$EPIC4"
git push -q origin refs/heads/tasks/pending/1002
TASK_DAG_CLAIMER=alice TASK_DAG_CLAIMER_HOST=hostA "$TD" claim-root 1002 >/dev/null 2>&1
printf '[{"title":"leaf X","type":"leaf"}]' > "$ROOT/spec.json"
if TASK_DAG_CLAIMER=bob TASK_DAG_CLAIMER_HOST=hostB \
     "$TD" breakdown "$EPIC4" --spec-file="$ROOT/spec.json" >/dev/null 2>&1; then
  bad "9: foreign worker bob decomposed alice's claimed root #1002"
else
  if remote_has refs/heads/tasks/root-active/1002; then
    ok "9: foreign breakdown refused; alice's lock intact"
  else
    bad "9: foreign breakdown refused but the lock was dropped"
  fi
fi
# Owner can still decompose.
if TASK_DAG_CLAIMER=alice TASK_DAG_CLAIMER_HOST=hostA \
     "$TD" breakdown "$EPIC4" --spec-file="$ROOT/spec.json" >/dev/null 2>&1; then
  ok "9b: lock owner alice can decompose her claimed root"
else
  bad "9b: lock owner alice could not decompose her own root"
fi

# ---------------------------------------------------------------------------
# TEST 10: two rapid claim-root --force by the same identity produce DISTINCT
#          claim commit SHAs (Claim-ID nonce), so lock epochs never collide.
# ---------------------------------------------------------------------------
EPIC5=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: Epic five

Issue: #1003
URL: https://github.com/test/test/issues/1003
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/tasks/pending/1003 "$EPIC5"
git push -q origin refs/heads/tasks/pending/1003
"$TD" claim-root 1003 >/dev/null 2>&1
C1=$(git ls-remote origin refs/heads/tasks/root-active/1003 | awk '{print $1}')
"$TD" claim-root 1003 --force >/dev/null 2>&1
C2=$(git ls-remote origin refs/heads/tasks/root-active/1003 | awk '{print $1}')
if [ -n "$C1" ] && [ -n "$C2" ] && [ "$C1" != "$C2" ]; then
  ok "10: rapid same-identity claims produced distinct claim commit SHAs"
else
  bad "10: claim commit SHAs collided ($C1 vs $C2)"
fi

# ---------------------------------------------------------------------------
# TEST 11: an epic root whose tasks/pending/<N> identity is GONE on origin
#          (closed/retired epic) is NOT silently decomposed as a "normal"
#          unlocked breakdown — it FAILS CLOSED. (Guards the close-epic /
#          stale-root resurrection bypass.)
# ---------------------------------------------------------------------------
EPIC6=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: Epic six

Issue: #1004
URL: https://github.com/test/test/issues/1004
Author: tester
Status: pending
Type: epic")
# Deliberately do NOT publish tasks/pending/1004 (simulates a retired root).
printf '[{"title":"orphan leaf","type":"leaf"}]' > "$ROOT/spec6.json"
if "$TD" breakdown "$EPIC6" --spec-file="$ROOT/spec6.json" --json >/dev/null 2>&1; then
  bad "11: breakdown of an epic root with no pending identity was allowed"
elif "$TD" breakdown "$EPIC6" --spec-file="$ROOT/spec6.json" --force --json >/dev/null 2>&1; then
  bad "11: --force bypassed the missing-pending-identity guard"
else
  ok "11: breakdown of a retired epic root (no pending/<N>) fails closed"
fi

# ---------------------------------------------------------------------------
# TEST 12: a STALE epic-root SHA (pending/<N> exists but points at a newer
#          root commit) is refused rather than decomposed as a normal task.
# ---------------------------------------------------------------------------
STALE=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: Epic seven (stale)

Issue: #1005
URL: https://github.com/test/test/issues/1005
Author: tester
Status: pending
Type: epic")
CURRENT=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: Epic seven (current)

Issue: #1005
URL: https://github.com/test/test/issues/1005
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/tasks/pending/1005 "$CURRENT"
git push -q origin refs/heads/tasks/pending/1005
printf '[{"title":"stale leaf","type":"leaf"}]' > "$ROOT/spec7.json"
if "$TD" breakdown "$STALE" --spec-file="$ROOT/spec7.json" --json >/dev/null 2>&1; then
  bad "12: breakdown of a stale epic-root SHA was allowed"
else
  ok "12: breakdown of a stale epic-root SHA (pending moved) fails closed"
fi

# ---------------------------------------------------------------------------
# TEST 13: a MALFORMED orchestration lock (root-active commit missing the
#          Claimer/Task-Commit identity fields) does not let breakdown
#          consume it — ownership cannot be positively confirmed, so refuse.
# ---------------------------------------------------------------------------
EPIC8=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: Epic eight

Issue: #1006
URL: https://github.com/test/test/issues/1006
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/tasks/pending/1006 "$EPIC8"
git push -q origin refs/heads/tasks/pending/1006
# Hand-craft a lock commit with NO Claimer/Task-Commit fields.
BADLOCK=$(git commit-tree "$EPIC8^{tree}" -p "$EPIC8" -m "Claim: bogus lock")
git push -q origin "$BADLOCK:refs/heads/tasks/root-active/1006"
printf '[{"title":"leaf under bad lock","type":"leaf"}]' > "$ROOT/spec8.json"
if "$TD" breakdown "$EPIC8" --spec-file="$ROOT/spec8.json" --json >/dev/null 2>&1; then
  bad "13: breakdown consumed a malformed (owner-less) orchestration lock"
elif [ "$(git ls-remote origin refs/heads/tasks/root-active/1006 | awk '{print $1}')" != "$BADLOCK" ]; then
  bad "13: breakdown disturbed/consumed the malformed lock instead of refusing cleanly"
else
  ok "13: breakdown refuses a malformed orchestration lock (no positive ownership)"
fi

# ---------------------------------------------------------------------------
# TEST 14: a CHILD epic (Type:epic but parented on a task commit, not on real
#          history) inherits Issue:#N whose pending/<N> points at the
#          top-level ROOT, not at it. Decomposing such a child epic must NOT
#          be gated on / refused by the root orchestration lock — it is an
#          ordinary intermediate breakdown.
# ---------------------------------------------------------------------------
ETREE=$(git mktree </dev/null)   # canonical empty tree (matches a real root)
# Root epic for #1007 with an EMPTY tree + real-history parent (production
# shape from create-task-commit.sh), so the child below is correctly seen
# as parented on a *task* commit.
ROOT7=$(git commit-tree "$ETREE" -p HEAD -m "Task: Epic with child epic

Issue: #1007
URL: https://github.com/test/test/issues/1007
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/tasks/pending/1007 "$ROOT7"
git push -q origin refs/heads/tasks/pending/1007
# Child epic: parented on the ROOT task commit (so its first parent IS a
# task commit -> non-root-shaped), inheriting Issue: #1007.
CHILD_EPIC=$(git commit-tree "$ETREE" -p "$ROOT7" -m "Task: A sub-epic

Issue: #1007
URL: https://github.com/test/test/issues/1007
Author: tester
Status: pending
Type: epic")
printf '[{"title":"sub-epic leaf","type":"leaf"}]' > "$ROOT/spec9.json"
if "$TD" breakdown "$CHILD_EPIC" --spec-file="$ROOT/spec9.json" --json >/dev/null 2>&1; then
  ok "14: child epic decomposes without a root lock (not gated as a root)"
else
  bad "14: child epic breakdown was wrongly refused as a stale/locked root"
fi

# ---------------------------------------------------------------------------
# TEST 15: stale-worktree false-negative regression. A COMPLETED child's
#          frontier ref is deleted, but the child task commit lives on as the
#          SECOND parent of its completion commit on master. A stale clone
#          (deleted frontier pruned, old master) must still see the root as
#          DECOMPOSED — fetch_root_refs refreshes master so task_has_children
#          cannot miss completed children and re-open the dup-decompose race.
# ---------------------------------------------------------------------------
EPIC9=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: Epic nine

Issue: #1100
URL: https://github.com/test/test/issues/1100
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/tasks/pending/1100 "$EPIC9"
git push -q origin refs/heads/tasks/pending/1100
"$TD" claim-root 1100 >/dev/null 2>&1
printf '[{"title":"to be completed","type":"leaf"}]' > "$ROOT/spec10.json"
"$TD" breakdown "$EPIC9" --spec-file="$ROOT/spec10.json" >/dev/null 2>&1
# Make a SECOND clone now, while the frontier leaf still exists, so wc2 has
# the child task OBJECT in its store but no remaining REF that reaches it once
# the frontier ref is deleted (we strip the remote-tracking task refs to model
# a real task-dag worktree, which mirrors task refs into refs/heads/tasks/* and
# prunes them — leaving master as the only path to a completed child).
git clone -q "$ROOT/origin.git" "$ROOT/wc2"
git -C "$ROOT/wc2" for-each-ref --format='%(refname)' refs/remotes/origin/tasks \
  | while read -r r; do git -C "$ROOT/wc2" update-ref -d "$r"; done
LEAF15=$(git ls-remote origin 'refs/heads/tasks/frontier/*' \
  | while read -r s r; do
      git fetch -q origin "$r:refs/tmp/c15" 2>/dev/null
      if [ "$(git log -1 --format='%P' refs/tmp/c15 | awk '{print $1}')" = "$EPIC9" ]; then
        echo "${r##*/}"; git update-ref -d refs/tmp/c15; break
      fi
      git update-ref -d refs/tmp/c15 2>/dev/null
    done)
# Complete the leaf in wc: pushes master (child = 2nd parent) and deletes the
# frontier/active refs on origin.
"$TD" claim "$LEAF15" >/dev/null 2>&1
echo impl15 > impl15.txt; git add impl15.txt; git commit -qm "impl 1100 leaf"
"$TD" complete "$LEAF15" >/dev/null 2>&1
git push -q origin HEAD:master
# Now drive the STALE clone wc2: it still carries the now-deleted frontier ref
# locally and an old master. claim-root must refuse (already-decomposed).
(
  cd "$ROOT/wc2"
  export TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h
  if "$TD" claim-root 1100 >/dev/null 2>&1; then
    exit 7   # BUG: stale clone re-claimed a decomposed root
  fi
  exit 0
)
if [ $? -eq 0 ]; then
  ok "15: stale clone sees a completed child via master and refuses re-claim"
else
  bad "15: stale clone re-claimed a root with a completed (master-only) child"
fi

# ---------------------------------------------------------------------------
# TEST 16: blocked and dependency-pending roots are not pickable/claimable.
# ---------------------------------------------------------------------------
EPIC_BLOCKED=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: Blocked root

Issue: #1208
URL: https://github.com/test/test/issues/1208
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/tasks/pending/1208 "$EPIC_BLOCKED"
git push -q origin refs/heads/tasks/pending/1208
"$TD" block "$EPIC_BLOCKED" --operator --reason="fixture blocked root" >/dev/null 2>&1
if "$TD" roots --pickable --json --no-fetch | jq -e '.[] | select(.issue==1208)' >/dev/null; then
  bad "16a: blocked root #1208 appeared in roots --pickable"
else
  ok "16a: blocked root is omitted from roots --pickable"
fi
rc18=0
"$TD" claim-root 1208 >/dev/null 2>&1 || rc18=$?
if [ "$rc18" = 2 ] && ! remote_has refs/heads/tasks/root-active/1208; then
  ok "16b: claim-root refuses a blocked root without creating root-active"
else
  bad "16b: blocked root claim rc=$rc18 root-active=$(remote_has refs/heads/tasks/root-active/1208 && echo yes || echo no)"
fi
"$TD" unblock "$EPIC_BLOCKED" >/dev/null 2>&1
if "$TD" roots --pickable --json --no-fetch | jq -e '.[] | select(.issue==1208)' >/dev/null \
   && "$TD" claim-root 1208 >/dev/null 2>&1; then
  ok "16c: unblocked root becomes pickable and claimable"
else
  bad "16c: unblocked root did not become pickable/claimable"
fi
"$TD" release-root 1208 >/dev/null 2>&1 || true

EMPTY_TREE_DEP=$(git mktree </dev/null)
DEP_ROOT=$(git commit-tree "$EMPTY_TREE_DEP" -p HEAD -m "Task: Root dependency

Issue: #1209
Author: tester
Status: pending
Type: leaf")
EPIC_DEP=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -p "$DEP_ROOT" -m "Task: Dependency-gated root

Issue: #1209
URL: https://github.com/test/test/issues/1209
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/tasks/pending/1209 "$EPIC_DEP"
git push -q origin refs/heads/tasks/pending/1209
if "$TD" roots --pickable --json --no-fetch | jq -e '.[] | select(.issue==1209)' >/dev/null; then
  bad "16d: dependency-pending root #1209 appeared in roots --pickable"
else
  ok "16d: dependency-pending root is omitted from roots --pickable"
fi
rc19=0
"$TD" claim-root 1209 >/dev/null 2>&1 || rc19=$?
if [ "$rc19" = 2 ] && ! remote_has refs/heads/tasks/root-active/1209; then
  ok "16e: claim-root refuses a dependency-pending root without creating root-active"
else
  bad "16e: dependency-pending root claim rc=$rc19 root-active=$(remote_has refs/heads/tasks/root-active/1209 && echo yes || echo no)"
fi
echo dep-root-work > dep-root-work.txt; git add dep-root-work.txt; git commit -qm "dep root work"
"$TD" complete "$DEP_ROOT" >/dev/null 2>&1
if "$TD" roots --pickable --json --no-fetch | jq -e '.[] | select(.issue==1209)' >/dev/null \
   && "$TD" claim-root 1209 >/dev/null 2>&1; then
  ok "16f: root becomes pickable and claimable after dependency completion"
else
  bad "16f: root did not become pickable/claimable after dependency completion"
fi
"$TD" release-root 1209 >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# TEST 16: complete fail-closed on an INDETERMINATE origin for a root-shaped
#          epic. If origin is unreachable and there is no local pending mirror
#          but the commit is shaped like a top-level epic root, complete must
#          REFUSE (never fall through and land an empty root over live leaves).
# ---------------------------------------------------------------------------
EPIC10=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: Epic ten

Issue: #1008
URL: https://github.com/test/test/issues/1008
Author: tester
Status: pending
Type: epic")
# Deliberately NO local refs/heads/tasks/pending/1008 mirror. Break origin so
# the pending lookup is indeterminate (transport error), not cleanly absent.
git remote set-url origin "$ROOT/does-not-exist.git"
HEAD_BEFORE16=$(git rev-parse HEAD)
rc16=0
"$TD" complete "$EPIC10" >/dev/null 2>&1 || rc16=$?
# Must be the clean root-guard refusal (exit 2), NOT a generic crash and NOT
# a successful completion. (Pre-fix this fell through the guard and died with a
# git error rc=128 instead of refusing.)
if [ "$rc16" = 2 ] && [ "$(git rev-parse HEAD)" = "$HEAD_BEFORE16" ]; then
  ok "16: complete fails closed (exit 2) on indeterminate origin for a root-shaped epic"
else
  bad "16: expected clean refusal exit 2 + HEAD unchanged, got rc=$rc16"
fi
git remote set-url origin "$ROOT/origin.git"

# ---------------------------------------------------------------------------
# TEST 17: claim-root refuses an orphan pending root whose GitHub issue is
# already CLOSED (defense-in-depth against wasted "decompose a done issue"
# dispatch). We stub `gh` on PATH to report CLOSED, and a separate stub to
# report OPEN to prove the guard is state-driven, not a blanket refusal.
# ---------------------------------------------------------------------------
EPIC17=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: Closed-issue epic

Issue: #1100
URL: https://github.com/test/test/issues/1100
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/tasks/pending/1100 "$EPIC17"
git push -q origin refs/heads/tasks/pending/1100

STUBDIR="$ROOT/ghstub"; mkdir -p "$STUBDIR"
cat > "$STUBDIR/gh" <<'STUB'
#!/usr/bin/env bash
# Minimal gh stub: `gh issue view <n> ... --json state --jq .state` -> $GH_STUB_STATE
if [ "${1:-}" = "issue" ] && [ "${2:-}" = "view" ]; then
  echo "${GH_STUB_STATE:-OPEN}"; exit 0
fi
exit 0
STUB
chmod +x "$STUBDIR/gh"

rc17=0
out17=$(PATH="$STUBDIR:$PATH" GH_STUB_STATE=CLOSED \
        TASK_DAG_CLAIMER=w17 TASK_DAG_CLAIMER_HOST=h17 TASK_DAG_CLAIMER_PID=1700 \
        "$TD" claim-root 1100 --json 2>/dev/null) || rc17=$?
if [ "$rc17" = 3 ] && printf '%s' "$out17" | grep -q '"reason":"issue-closed"' \
   && ! remote_has refs/heads/tasks/root-active/1100; then
  ok "17: claim-root refuses a CLOSED issue's orphan root (no root-active created)"
else
  bad "17: expected exit 3 + issue-closed + no root-active, got rc=$rc17 out=$out17"
fi

# Same root, issue reported OPEN -> claim proceeds (guard is state-driven).
rc17b=0
PATH="$STUBDIR:$PATH" GH_STUB_STATE=OPEN \
  TASK_DAG_CLAIMER=w17 TASK_DAG_CLAIMER_HOST=h17 TASK_DAG_CLAIMER_PID=1700 \
  "$TD" claim-root 1100 --json >/dev/null 2>&1 || rc17b=$?
if [ "$rc17b" = 0 ] && remote_has refs/heads/tasks/root-active/1100; then
  ok "17b: claim-root proceeds when the same issue is OPEN (state-driven, not blanket)"
else
  bad "17b: expected successful claim on OPEN issue, got rc=$rc17b"
fi

echo "------------------------------------------------------------"
echo "root-claim: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
