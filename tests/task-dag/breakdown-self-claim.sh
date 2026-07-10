#!/usr/bin/env bash
# Fixture smoke test: `breakdown` with "claim": true creates a child that
# is BORN CLAIMED by the caller — its tasks/active/<short> ref is published
# in the same atomic push and it never gets a pickable tasks/frontier/<short>
# ref, so no other worker can race to take it. This is the zero-race-window
# decompose->implement handoff (root/leaf double-dispatch fix).
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

Issue: #777
URL: https://github.com/test/test/issues/777
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/gh/issues/777 "$EPIC"
git update-ref refs/heads/tasks/pending/777 "$EPIC"
git push -q origin refs/heads/gh/issues/777 refs/heads/tasks/pending/777

# Spec: one self-claimed child + one normal child.
cat > "$ROOT/spec.json" <<'JSON'
[
  {"title":"mine to implement","type":"leaf","claim":true},
  {"title":"for the fleet","type":"leaf"}
]
JSON

# Decomposing the epic root requires (and consumes) the orchestration lock
# (issue #2): take it as the root worker before breaking down.
TASK_DAG_CLAIMER=rootworker TASK_DAG_CLAIMER_HOST=hostA TASK_DAG_CLAIMER_PID=909090 \
  "$TD" claim-root 777 >/dev/null 2>&1
BD=$(TASK_DAG_CLAIMER=rootworker TASK_DAG_CLAIMER_HOST=hostA TASK_DAG_CLAIMER_PID=909090 \
       "$TD" breakdown "$EPIC" --spec-file="$ROOT/spec.json" --json 2>/dev/null)

# Extract the two child short shas + claimed flags from JSON (order preserved).
CLAIMED_SHORT=$(printf '%s' "$BD" | jq -r '.tasks[] | select(.claimed==true) | .shortSha')
NORMAL_SHORT=$(printf '%s'  "$BD" | jq -r '.tasks[] | select(.claimed==false) | .shortSha')

# ---------------------------------------------------------------------------
# TEST 1: JSON marks exactly one child claimed and one not.
# ---------------------------------------------------------------------------
nclaim=$(printf '%s' "$BD" | jq '[.tasks[] | select(.claimed==true)] | length')
nfree=$(printf '%s'  "$BD" | jq '[.tasks[] | select(.claimed==false)] | length')
if [ "$nclaim" = 1 ] && [ "$nfree" = 1 ]; then
  ok "1: breakdown --json reports 1 claimed + 1 unclaimed child"
else
  bad "1: expected 1 claimed + 1 unclaimed, got claimed=$nclaim free=$nfree ($BD)"
fi

# ---------------------------------------------------------------------------
# TEST 2: claimed child has tasks/active/<short> on ORIGIN and NO frontier.
# ---------------------------------------------------------------------------
if [ -n "$CLAIMED_SHORT" ]; then
  has_active=$(git ls-remote origin "refs/heads/tasks/active/$CLAIMED_SHORT" | wc -l | tr -d ' ')
  has_frontier=$(git ls-remote origin "refs/heads/tasks/frontier/$CLAIMED_SHORT" | wc -l | tr -d ' ')
  if [ "$has_active" = 1 ] && [ "$has_frontier" = 0 ]; then
    ok "2: claimed child is born in tasks/active (no frontier ref ever exists)"
  else
    bad "2: claimed child active=$has_active frontier=$has_frontier (want 1/0)"
  fi
else
  bad "2: no claimed short sha in JSON"
fi

# ---------------------------------------------------------------------------
# TEST 3: normal child has tasks/frontier/<short> on origin and NO active.
# ---------------------------------------------------------------------------
if [ -n "$NORMAL_SHORT" ]; then
  has_active=$(git ls-remote origin "refs/heads/tasks/active/$NORMAL_SHORT" | wc -l | tr -d ' ')
  has_frontier=$(git ls-remote origin "refs/heads/tasks/frontier/$NORMAL_SHORT" | wc -l | tr -d ' ')
  if [ "$has_active" = 0 ] && [ "$has_frontier" = 1 ]; then
    ok "3: unmarked child is a normal frontier leaf"
  else
    bad "3: normal child active=$has_active frontier=$has_frontier (want 0/1)"
  fi
else
  bad "3: no normal short sha in JSON"
fi

# ---------------------------------------------------------------------------
# TEST 4: claim commit records the caller's identity (so the same worker can
#         complete it, and a janitor can detect it if the worker dies).
# ---------------------------------------------------------------------------
if [ -n "$CLAIMED_SHORT" ]; then
  msg=$(git log -1 --format=%B "refs/heads/tasks/active/$CLAIMED_SHORT" 2>/dev/null || true)
  if grep -q '^Claimer: rootworker$' <<<"$msg" \
     && grep -q '^Claimer-PID: 909090$' <<<"$msg"; then
    ok "4: born-claimed child records the caller as Claimer/Claimer-PID"
  else
    bad "4: claim metadata missing from active commit: $msg"
  fi
else
  bad "4: skipped (no claimed short sha)"
fi

# ---------------------------------------------------------------------------
# TEST 5: `frontier` does NOT list the born-claimed child (already claimed),
#         but DOES list the normal child.
# ---------------------------------------------------------------------------
FRONTIER=$("$TD" frontier 2>/dev/null || true)
if ! grep -q "$CLAIMED_SHORT" <<<"$FRONTIER" && grep -q "$NORMAL_SHORT" <<<"$FRONTIER"; then
  ok "5: frontier hides the born-claimed child, shows the normal one"
else
  bad "5: frontier listing wrong:\n$FRONTIER"
fi

# ---------------------------------------------------------------------------
# TEST 6: the claiming worker can complete the born-claimed child.
# ---------------------------------------------------------------------------
if [ -n "$CLAIMED_SHORT" ]; then
  echo impl > impl.txt; git add impl.txt; git commit -qm "implement claimed child"
  git push -q origin HEAD:master
  BEFORE=$(git rev-parse HEAD)
  if TASK_DAG_CLAIMER=rootworker TASK_DAG_CLAIMER_HOST=hostA \
       "$TD" complete "$CLAIMED_SHORT" >/dev/null 2>&1; then
    still=$(git ls-remote origin "refs/heads/tasks/active/$CLAIMED_SHORT" | wc -l | tr -d ' ')
    if [ "$still" = 1 ]; then
      ok "6: local completion preserves the born-claimed active ref"
    else
      bad "6: local completion unexpectedly changed the active ref ($still)"
    fi
    git push -q origin HEAD:master
    "$TD" graph-converge --range "$BEFORE..HEAD" >/dev/null 2>&1
    still=$(git ls-remote origin "refs/heads/tasks/active/$CLAIMED_SHORT" | wc -l | tr -d ' ')
    [ "$still" = 0 ] && ok "6: convergence clears the born-claimed active ref" \
                       || bad "6: convergence left the active ref ($still)"
  else
    bad "6: complete failed for the born-claimed child"
  fi
else
  bad "6: skipped (no claimed short sha)"
fi

# ---------------------------------------------------------------------------
# TEST 7: the double-decompose guard recognizes a parent whose ONLY children
#         are born-claimed (active refs). A second breakdown without --force
#         must refuse — active refs point at claim commits, so the guard has
#         to unwrap one level to find the child task commit / its parent.
# ---------------------------------------------------------------------------
EPIC2=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: Test epic 2

Issue: #778
URL: https://github.com/test/test/issues/778
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/tasks/pending/778 "$EPIC2"
git push -q origin refs/heads/tasks/pending/778

printf '[{"title":"only child, claimed","type":"leaf","claim":true}]' > "$ROOT/spec2.json"
TASK_DAG_CLAIMER=rootworker TASK_DAG_CLAIMER_HOST=hostA \
  "$TD" claim-root 778 >/dev/null 2>&1
TASK_DAG_CLAIMER=rootworker TASK_DAG_CLAIMER_HOST=hostA \
  "$TD" breakdown "$EPIC2" --spec-file="$ROOT/spec2.json" --json >/dev/null 2>&1

# Second breakdown on the same parent (no --force) must refuse. Re-acquire
# the root lock (--force, since the root is already decomposed) so breakdown
# gets *past* the lock check and is refused specifically by the
# double-decompose guard we are exercising here.
TASK_DAG_CLAIMER=rootworker TASK_DAG_CLAIMER_HOST=hostA \
  "$TD" claim-root 778 --force >/dev/null 2>&1
printf '[{"title":"another one","type":"leaf"}]' > "$ROOT/spec3.json"
if "$TD" breakdown "$EPIC2" --spec-file="$ROOT/spec3.json" --json >/dev/null 2>&1; then
  bad "7: second breakdown was allowed though parent already has a born-claimed child"
else
  ok "7: double-decompose guard refuses when existing children are born-claimed"
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
