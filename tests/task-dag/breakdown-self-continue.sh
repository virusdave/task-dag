#!/usr/bin/env bash
# Fixture smoke test for the self-continue-after-breakdown machinery
# (virusdave/top-level#53):
#
#   * `breakdown --claim-first` born-claims EXACTLY the topologically-first
#     dependency-ready child (so a decomposing worker can continue straight
#     into it in the same session), leaves the rest as frontier leaves, is
#     mutually exclusive with a per-child "claim":true, and ERRORS before any
#     mutation if no child is dependency-ready.
#   * `breakdown --json` now emits each child's published `ref`.
#   * A recursive (NON-root) breakdown of a parent the caller holds a claim on
#     CONSUMES that tasks/active/<short> claim in the same atomic push (so the
#     post-agent claim sweep can't block the now-structural parent and stall
#     its children), and REFUSES a FOREIGN active claim on the parent.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"
cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master

# The empty tree every task/gh ref must point at (INVARIANTS.md). Real epic
# roots are empty-tree commits parented on real history; using it here is what
# makes is_task_commit() recognise a child epic's first parent as a task
# commit (so a child epic is NOT mis-detected as a root-shaped epic).
EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"

# Helper: create + publish a pending epic root for an issue, print its sha.
mk_epic() {
  local issue="$1"
  local epic
  epic=$(git commit-tree "$EMPTY_TREE" -p HEAD -m "Task: Epic $issue

Issue: #$issue
URL: https://github.com/test/test/issues/$issue
Author: tester
Status: pending
Type: epic")
  git update-ref "refs/heads/gh/issues/$issue" "$epic"
  git update-ref "refs/heads/tasks/pending/$issue" "$epic"
  git push -q origin "refs/heads/gh/issues/$issue" "refs/heads/tasks/pending/$issue"
  printf '%s' "$epic"
}

C1=cont-worker; H1=hostA; P1=111111
C2=other-worker; H2=hostB; P2=222222

# ===========================================================================
# A. --claim-first born-claims the FIRST dependency-ready child; --json ref.
# ===========================================================================
EPIC_A=$(mk_epic 781)
cat > "$ROOT/specA.json" <<'JSON'
[
  {"title":"first ready leaf","type":"leaf"},
  {"title":"second depends on first","type":"leaf","dependencies":["@1"]}
]
JSON
TASK_DAG_CLAIMER=$C1 TASK_DAG_CLAIMER_HOST=$H1 TASK_DAG_CLAIMER_PID=$P1 \
  "$TD" claim-root 781 >/dev/null 2>&1
BDA=$(TASK_DAG_CLAIMER=$C1 TASK_DAG_CLAIMER_HOST=$H1 TASK_DAG_CLAIMER_PID=$P1 \
        "$TD" breakdown "$EPIC_A" --spec-file="$ROOT/specA.json" --claim-first --json 2>/dev/null)

CLAIMED_SHORT=$(printf '%s' "$BDA" | jq -r '.tasks[] | select(.claimed==true)  | .shortSha')
CLAIMED_REF=$(printf   '%s' "$BDA" | jq -r '.tasks[] | select(.claimed==true)  | .ref')
FREE_SHORT=$(printf    '%s' "$BDA" | jq -r '.tasks[] | select(.claimed==false) | .shortSha')
FREE_REF=$(printf      '%s' "$BDA" | jq -r '.tasks[] | select(.claimed==false) | .ref')
# The claimed child must be the FIRST spec entry (topologically-first ready).
FIRST_TITLE=$(printf '%s' "$BDA" | jq -r '.tasks[0] | (.claimed|tostring)')

nclaim=$(printf '%s' "$BDA" | jq '[.tasks[] | select(.claimed==true)] | length')
if [ "$nclaim" = 1 ] && [ "$FIRST_TITLE" = true ]; then
  ok "A1: --claim-first born-claims exactly the first ready child"
else
  bad "A1: expected 1 claimed = first child, got nclaim=$nclaim first=$FIRST_TITLE ($BDA)"
fi

if [ "$CLAIMED_REF" = "tasks/active/$CLAIMED_SHORT" ] && [ "$FREE_REF" = "tasks/frontier/$FREE_SHORT" ]; then
  ok "A2: --json emits the published ref for each child (active vs frontier)"
else
  bad "A2: refs wrong: claimed=[$CLAIMED_REF] free=[$FREE_REF]"
fi

ca=$(git ls-remote origin "refs/heads/tasks/active/$CLAIMED_SHORT" | wc -l | tr -d ' ')
cf=$(git ls-remote origin "refs/heads/tasks/frontier/$CLAIMED_SHORT" | wc -l | tr -d ' ')
fa=$(git ls-remote origin "refs/heads/tasks/active/$FREE_SHORT" | wc -l | tr -d ' ')
ff=$(git ls-remote origin "refs/heads/tasks/frontier/$FREE_SHORT" | wc -l | tr -d ' ')
if [ "$ca" = 1 ] && [ "$cf" = 0 ] && [ "$fa" = 0 ] && [ "$ff" = 1 ]; then
  ok "A3: origin has claimed child in active (no frontier), free child in frontier (no active)"
else
  bad "A3: origin refs wrong claimed(a=$ca,f=$cf) free(a=$fa,f=$ff)"
fi

# ===========================================================================
# B. --claim-first is mutually exclusive with a per-child "claim":true.
# ===========================================================================
EPIC_B=$(mk_epic 782)
printf '[{"title":"x","type":"leaf","claim":true}]' > "$ROOT/specB.json"
TASK_DAG_CLAIMER=$C1 TASK_DAG_CLAIMER_HOST=$H1 "$TD" claim-root 782 >/dev/null 2>&1
b_before=$(git ls-remote origin | sort)
if TASK_DAG_CLAIMER=$C1 TASK_DAG_CLAIMER_HOST=$H1 \
     "$TD" breakdown "$EPIC_B" --spec-file="$ROOT/specB.json" --claim-first >/dev/null 2>&1; then
  bad "B1: --claim-first + per-child claim:true was allowed (should be mutually exclusive)"
else
  b_after=$(git ls-remote origin | sort)
  if [ "$b_before" = "$b_after" ]; then
    ok "B1: --claim-first refuses (no mutation) when a per-child claim:true is also set"
  else
    bad "B1: --claim-first errored but MUTATED origin"
  fi
fi

# ===========================================================================
# C. --claim-first ERRORS before any mutation when NO child is ready.
#    (single child depending on an external, un-completed task.)
# ===========================================================================
EXT=$(git commit-tree "$EMPTY_TREE" -p HEAD -m "Task: external dep

Issue: #799
Status: pending
Type: leaf")
EXT_SHORT=$(git rev-parse --short "$EXT")
git update-ref "refs/heads/tasks/frontier/$EXT_SHORT" "$EXT"
git push -q origin "refs/heads/tasks/frontier/$EXT_SHORT"

EPIC_C=$(mk_epic 783)
cat > "$ROOT/specC.json" <<JSON
[
  {"title":"blocked on external","type":"leaf","dependencies":["$EXT"]}
]
JSON
TASK_DAG_CLAIMER=$C1 TASK_DAG_CLAIMER_HOST=$H1 "$TD" claim-root 783 >/dev/null 2>&1
before=$(git ls-remote origin | wc -l | tr -d ' ')
if TASK_DAG_CLAIMER=$C1 TASK_DAG_CLAIMER_HOST=$H1 \
     "$TD" breakdown "$EPIC_C" --spec-file="$ROOT/specC.json" --claim-first >/dev/null 2>&1; then
  bad "C1: --claim-first created a breakdown with no ready child (should error)"
else
  after=$(git ls-remote origin | wc -l | tr -d ' ')
  if [ "$before" = "$after" ]; then
    ok "C1: --claim-first errors with no mutation when no child is dependency-ready"
  else
    bad "C1: --claim-first errored but MUTATED origin (before=$before after=$after)"
  fi
fi

# ===========================================================================
# D. Recursive (non-root) breakdown CONSUMES the parent's OWNED active claim.
# ===========================================================================
EPIC_D=$(mk_epic 784)
printf '[{"title":"child epic to recurse","type":"epic"}]' > "$ROOT/specD.json"
TASK_DAG_CLAIMER=$C1 TASK_DAG_CLAIMER_HOST=$H1 TASK_DAG_CLAIMER_PID=$P1 \
  "$TD" claim-root 784 >/dev/null 2>&1
BDD=$(TASK_DAG_CLAIMER=$C1 TASK_DAG_CLAIMER_HOST=$H1 TASK_DAG_CLAIMER_PID=$P1 \
        "$TD" breakdown "$EPIC_D" --spec-file="$ROOT/specD.json" --claim-first --json 2>/dev/null)
CHILD_SHA=$(printf '%s' "$BDD" | jq -r '.tasks[0].sha')
CHILD_SHORT=$(printf '%s' "$BDD" | jq -r '.tasks[0].shortSha')

# Sanity: the child is born-claimed by us.
pre_active=$(git ls-remote origin "refs/heads/tasks/active/$CHILD_SHORT" | wc -l | tr -d ' ')

printf '[{"title":"grandchild leaf","type":"leaf"}]' > "$ROOT/specDD.json"
BDDD=$(TASK_DAG_CLAIMER=$C1 TASK_DAG_CLAIMER_HOST=$H1 TASK_DAG_CLAIMER_PID=$P1 \
         "$TD" breakdown "$CHILD_SHA" --spec-file="$ROOT/specDD.json" --json 2>/dev/null)
bdd_rc=$?
GRAND_SHORT=$(printf '%s' "$BDDD" | jq -r '.tasks[0].shortSha' 2>/dev/null || true)

post_active=$(git ls-remote origin "refs/heads/tasks/active/$CHILD_SHORT" | wc -l | tr -d ' ')
grand_frontier=$(git ls-remote origin "refs/heads/tasks/frontier/$GRAND_SHORT" 2>/dev/null | wc -l | tr -d ' ')
if [ "$pre_active" = 1 ] && [ "$bdd_rc" = 0 ] && [ "$post_active" = 0 ] && [ "$grand_frontier" = 1 ]; then
  ok "D1: recursive breakdown consumed the parent's owned active claim + created the grandchild"
else
  bad "D1: pre_active=$pre_active rc=$bdd_rc post_active=$post_active grand_frontier=$grand_frontier ($BDDD)"
fi

# ===========================================================================
# E. Recursive breakdown REFUSES a FOREIGN active claim on the parent.
# ===========================================================================
EPIC_E=$(mk_epic 785)
printf '[{"title":"child epic owned by C1","type":"epic"}]' > "$ROOT/specE.json"
TASK_DAG_CLAIMER=$C1 TASK_DAG_CLAIMER_HOST=$H1 TASK_DAG_CLAIMER_PID=$P1 \
  "$TD" claim-root 785 >/dev/null 2>&1
BDE=$(TASK_DAG_CLAIMER=$C1 TASK_DAG_CLAIMER_HOST=$H1 TASK_DAG_CLAIMER_PID=$P1 \
        "$TD" breakdown "$EPIC_E" --spec-file="$ROOT/specE.json" --claim-first --json 2>/dev/null)
ECHILD_SHA=$(printf '%s' "$BDE" | jq -r '.tasks[0].sha')
ECHILD_SHORT=$(printf '%s' "$BDE" | jq -r '.tasks[0].shortSha')

printf '[{"title":"grandchild that must not be created","type":"leaf"}]' > "$ROOT/specEE.json"
# Snapshot ALL origin refs so we can prove the failed foreign attempt mutated
# nothing (neither stole/consumed the claim nor created a grandchild).
e_before=$(git ls-remote origin | sort)
# A DIFFERENT worker (C2) tries to decompose C1's claimed child epic.
if TASK_DAG_CLAIMER=$C2 TASK_DAG_CLAIMER_HOST=$H2 TASK_DAG_CLAIMER_PID=$P2 \
     "$TD" breakdown "$ECHILD_SHA" --spec-file="$ROOT/specEE.json" --json >/dev/null 2>&1; then
  bad "E1: a foreign worker was allowed to decompose a claimed child (should refuse)"
else
  e_after=$(git ls-remote origin | sort)
  still_active=$(git ls-remote origin "refs/heads/tasks/active/$ECHILD_SHORT" | wc -l | tr -d ' ')
  if [ "$e_before" = "$e_after" ] && [ "$still_active" = 1 ]; then
    ok "E1: recursive breakdown refuses a foreign claim (no mutation: claim intact, no grandchild)"
  else
    bad "E1: foreign refusal mutated origin (active=$still_active, refs changed=$([ "$e_before" = "$e_after" ] && echo no || echo yes))"
  fi
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
