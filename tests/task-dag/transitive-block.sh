#!/usr/bin/env bash
# Fixture test for TRANSITIVE block over the structural (breakdown)
# lineage.
#
# Regression: blocking a parent/epic task (e.g. one parked awaiting
# operator feedback) did NOT withhold the subtasks decomposed under it.
# A breakdown child carries its parent as its FIRST git parent, which
# get_dep_parents strips, so deps_satisfied was trivially true for the
# child and `frontier` listed it / `claim` accepted it — the dispatcher
# then spawned no-op workers on children of a blocked node.
#
# These tests prove `frontier` excludes and `claim` refuses any task with
# a blocked structural ancestor, that --force still overrides, that the
# block survives partial sibling completion (the empty-tree boundary, NOT
# merge-base-with-HEAD, bounds the walk), that grandparent blocks reach
# grandchildren, and that `unblock` revives the subtree. A SECOND clone
# (a fresh worker) exercises the overlay-sync path too.
#
# NOTE: epic/issue-root task commits are minted with the canonical EMPTY
# tree in production (verified: issue-to-task + breakdown both use
# commit-tree against the empty tree, and cmd_validate enforces it). The
# fixture builds the epic the same way so the structural-ancestor walk's
# task-commit boundary is exercised realistically.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h

# bare origin + "authoring" working clone
git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc" 2>/dev/null
cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master 2>/dev/null

EMPTY_TREE=$(git hash-object -t tree /dev/null)

# Epic commit (EMPTY tree, like a real issue-root) + refs.
EPIC=$(git commit-tree "$EMPTY_TREE" -p HEAD -m "Task: Test epic

Issue: #999
URL: https://github.com/test/test/issues/999
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/gh/issues/999 "$EPIC"
git update-ref refs/heads/tasks/pending/999 "$EPIC"
git push -q origin refs/heads/gh/issues/999 refs/heads/tasks/pending/999 2>/dev/null

# Helper: breakdown <parent> into ONE child of <title>; print child short sha.
mk_child() {  # <parent-sha> <title>
  printf '[{"title":"%s","type":"task"}]' "$2" > "$ROOT/spec.json"
  local out
  out=$("$TD" breakdown "$1" --spec-file="$ROOT/spec.json" --force --json 2>/dev/null)
  grep -oE '"shortSha":"[0-9a-f]+"' <<<"$out" | head -1 | cut -d'"' -f4
}

# Helper: does `frontier` (for issue 999) currently LIST <short-sha>?
# Captures the full output into a variable BEFORE grepping. A naive
# `"$TD" frontier | grep -q "$sha"` is a pipefail trap: grep exits 0 on
# the first match and closes the pipe, so the `frontier` producer can die
# with SIGPIPE (141); under `set -o pipefail` the whole pipeline then
# reports 141 (non-zero) even though the sha WAS present — an intermittent
# false "not listed". The here-string keeps grep's own exit status.
frontier_has() {  # <short-sha> [extra frontier args…]
  local sha="$1"; shift
  local out
  out=$("$TD" frontier --issue=999 "$@" 2>/dev/null)
  grep -q "$sha" <<<"$out"
}

# Build: EPIC -> PARENT -> CHILD (CHILD's first parent is PARENT).
PSHORT=$(mk_child "$EPIC" "parent awaiting operator")
[ -n "$PSHORT" ] || { echo "could not create PARENT"; echo "PASS=0 FAIL=1"; exit 1; }
PARENT=$(git rev-parse "refs/heads/tasks/frontier/$PSHORT")
CSHORT=$(mk_child "$PARENT" "child subtask")
[ -n "$CSHORT" ] || { echo "could not create CHILD"; echo "PASS=0 FAIL=1"; exit 1; }

# Sanity: before any block, CHILD is on the frontier (dependency-free leaf).
if frontier_has "$CSHORT" --no-fetch; then
  ok "0: child is pickable before any block (baseline)"
else
  bad "0: child unexpectedly not pickable before any block"
fi

# Park the PARENT on origin.
"$TD" block "$PSHORT" --reason="awaiting operator" >/dev/null 2>&1

# ---------------------------------------------------------------------------
# Fresh worker = a brand-new clone with NO local task refs at all.
# ---------------------------------------------------------------------------
git clone -q "$ROOT/origin.git" "$ROOT/worker" 2>/dev/null
cd "$ROOT/worker"

# TEST 1: frontier must EXCLUDE the child of the blocked parent.
if frontier_has "$CSHORT"; then
  bad "1: frontier LISTED a child of a blocked parent (over-dispatch)"
else
  ok "1: frontier excludes the child of a blocked parent"
fi

# TEST 2: claim of the child must be refused (rc=2, reason ancestor-blocked),
# and no active ref may be created on origin.
out=$("$TD" claim "$CSHORT" --json 2>&1); rc=$?
if [ "$rc" -eq 2 ] && echo "$out" | grep -qi "ancestor-blocked"; then
  ok "2: claim refuses a child of a blocked parent (rc=2, ancestor-blocked)"
else
  bad "2: claim did NOT refuse the child (rc=$rc): $out"
fi
if [ "$(git ls-remote origin "refs/heads/tasks/active/$CSHORT" | wc -l)" -eq 0 ]; then
  ok "2: no active claim ref leaked for the child"
else
  bad "2: an active claim ref leaked for the child of a blocked parent"
fi

# TEST 3: --force overrides the transitive block (escape hatch for a stale
# block), proving the gate is advisory under --force like the direct one.
out=$("$TD" claim "$CSHORT" --force --json 2>&1); rc=$?
if [ "$rc" -eq 0 ] && [ "$(git ls-remote origin "refs/heads/tasks/active/$CSHORT" | wc -l)" -eq 1 ]; then
  ok "3: claim --force can still take a child of a blocked parent"
else
  bad "3: claim --force failed to override transitive block (rc=$rc): $out"
fi
# Release that forced claim so later steps see a clean frontier.
"$TD" release "$CSHORT" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# TEST 4: the empty-tree boundary, not merge-base-with-HEAD, bounds the
# walk. Add a SECOND child of PARENT and COMPLETE it: the completion lands
# the completed child (and PARENT, its first-parent) into HEAD history, so
# an "ancestor of HEAD" stop condition would wrongly stop the walk early.
# The FIRST child must STILL be withheld because PARENT is still blocked.
# (Completing the force-claimed in-flight sibling also proves `complete`
# is not gated by the new ancestor-blocked check.)
# ---------------------------------------------------------------------------
cd "$ROOT/wc"
C2SHORT=$(mk_child "$PARENT" "sibling to complete")
"$TD" claim "$C2SHORT" --force >/dev/null 2>&1     # force past PARENT's block
echo "real work for sibling" > sib_impl.txt; git add sib_impl.txt; git commit -qm "impl sibling"
"$TD" complete "$C2SHORT" >/dev/null 2>&1
git push -q origin HEAD:master 2>/dev/null || true
if git merge-base --is-ancestor "$PARENT" HEAD 2>/dev/null; then
  ok "4: precondition — blocked PARENT is now an ancestor of HEAD"
else
  bad "4: precondition failed — PARENT not reachable from HEAD after sibling complete"
fi
git clone -q "$ROOT/origin.git" "$ROOT/worker3" 2>/dev/null
cd "$ROOT/worker3"
if frontier_has "$CSHORT"; then
  bad "4: child re-listed after sibling completion (walk stopped early at HEAD)"
else
  ok "4: child still withheld after sibling completion (empty-tree boundary holds)"
fi

# ---------------------------------------------------------------------------
# TEST 5: unblock the PARENT -> the child becomes pickable again.
# ---------------------------------------------------------------------------
cd "$ROOT/wc"
"$TD" unblock "$PSHORT" >/dev/null 2>&1
git clone -q "$ROOT/origin.git" "$ROOT/worker2" 2>/dev/null
cd "$ROOT/worker2"
if frontier_has "$CSHORT"; then
  ok "5: after unblock, the child is pickable again"
else
  bad "5: after unblock, the child is still withheld"
fi

# ---------------------------------------------------------------------------
# TEST 6: grandparent depth — block the EPIC, and the grandchild (CHILD,
# via EPIC -> PARENT -> CHILD) must be withheld.
# ---------------------------------------------------------------------------
cd "$ROOT/wc"
"$TD" block "$EPIC" --reason="pause whole epic" >/dev/null 2>&1
git clone -q "$ROOT/origin.git" "$ROOT/worker4" 2>/dev/null
cd "$ROOT/worker4"
if frontier_has "$CSHORT"; then
  bad "6: grandchild listed while EPIC (grandparent) is blocked"
else
  ok "6: grandchild withheld while EPIC (grandparent) is blocked"
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
