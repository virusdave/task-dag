#!/usr/bin/env bash
# Fixture smoke test: CI broken-master RACE & STALE-RUN handling (design §4).
#
# The per-subsystem fixtures (ci-chain-cas / ci-classifier / ci-tree-fix-
# outcome) each prove a slice of §4 in isolation. This fixture is the
# cross-cutting integration check for the four §4 race cases the child
# epic calls out by name:
#
#   1. out-of-order CI runs        — older runs that finish after newer ones
#                                     never reopen/clobber a superseded chain;
#   2. continue escalation         — a continuation red escalates the SAME
#                                     chain to continue-mode without an
#                                     out-of-order replay inflating counters;
#   3. regression-vs-continuation  — a red while a chain is OPEN is a
#                                     continuation (same First-Red); a red
#                                     after a GREEN is a fresh regression
#                                     (new First-Red);
#   4. green closes the RIGHT chain — with multiple chains open concurrently
#                                     (two branches, two repos), a current
#                                     green closes ONLY its own chain and
#                                     leaves every sibling chain untouched.
#
# Builds a throwaway bare origin + working clone in a tempdir (no network,
# no real repo), so it is safe to run anywhere.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# bare origin + working clone with a 5-commit linear history C1<-..<-C5.
git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc" 2>/dev/null
cd "$ROOT/wc"
echo a > f; git add f; git commit -qm c1; C1=$(git rev-parse HEAD)
echo b > f; git commit -qam c2; C2=$(git rev-parse HEAD)
echo c > f; git commit -qam c3; C3=$(git rev-parse HEAD)
echo d > f; git commit -qam c4; C4=$(git rev-parse HEAD)
echo e > f; git commit -qam c5; C5=$(git rev-parse HEAD)
git push -q origin HEAD:master

REPO=acme/widgets
REPO2=other/service

field() { # <repo> <branch> <jsonkey>  -> echo value (or empty)
  "$TD" chain-read "$1" "$2" --json 2>/dev/null \
    | sed -E "s/.*\"$3\":\"([^\"]*)\".*/\1/;t;d"
}

# A tree-fix commit on top of HEAD; echoes its SHA.  <content> <chain> <mode>
mkfix() {
  echo "$1" > f
  git commit -qam "fix $1

Tree-Fix: acme/widgets#42
Tree-Fix-Chain: $2
Tree-Fix-Mode: $3"
  git rev-parse HEAD
}

# ===========================================================================
# CASE 1 — OUT-OF-ORDER CI RUNS
# A streak opens at C2 then advances to C3 (live head). The classifier CI run
# for C2 (the older commit) finishes *after* the C3 run. Because C2 is now a
# superseded ancestor of the live head, that late red must be ignored and the
# chain head must stay at C3 — out-of-order runs never rewind a chain.
# ===========================================================================
"$TD" classify "$REPO" master --for-sha="$C2" --result=red --current-head="$C2" \
  --json >/dev/null 2>&1                       # open @ C2
"$TD" classify "$REPO" master --for-sha="$C3" --result=red --current-head="$C3" \
  --json >/dev/null 2>&1                       # continuation -> head=C3
before=$(field "$REPO" master currentHead)
out=$("$TD" classify "$REPO" master --for-sha="$C2" --result=red \
  --current-head="$C3" --json 2>/dev/null); rc=$?
after=$(field "$REPO" master currentHead)
if [ "$rc" -eq 6 ] && grep -q '"action":"noop-stale"' <<<"$out" \
   && grep -q '"applied":false' <<<"$out" \
   && [ "$before" = "$C3" ] && [ "$after" = "$C3" ]; then
  ok "1: out-of-order older red (run finishes late) is ignored, head unchanged"
else
  bad "1: out-of-order rc=$rc out=$out before=$before after=$after"
fi

# A late GREEN run for the same superseded C2 must also NOT close the chain
# (close green only when current, §4) — the streak is still live at C3.
out=$("$TD" classify "$REPO" master --for-sha="$C2" --result=green \
  --current-head="$C3" --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -q '"action":"noop-green-noncurrent"' <<<"$out" \
   && [ "$(field "$REPO" master state)" = "red" ]; then
  ok "2: out-of-order older green does NOT close a still-live chain"
else
  bad "2: stale-green rc=$rc out=$out state=$(field "$REPO" master state)"
fi

# ===========================================================================
# CASE 2 — CONTINUE ESCALATION, race-safe against out-of-order replays
# A tree-fix continuation red escalates the SAME chain to continue-mode and
# bumps Repair-Attempt. An out-of-order replay of an OLDER tree-fix red (a CI
# run that finished late) must NOT inflate Repair-Attempt / Same-Sig-Count —
# counter inflation could falsely trip the block threshold.
# ===========================================================================
# Fresh branch so case 1 doesn't interfere. Open an initial chain, push a
# tree-fix, escalate it to continue-mode.
echo s0 > f; git commit -qam s0; S0=$(git rev-parse HEAD); git push -q origin HEAD:master
"$TD" classify "$REPO" stream --for-sha="$S0" --result=red --current-head="$S0" \
  --json >/dev/null 2>&1
TFA=$(mkfix s_fixA "$S0" continue); git push -q origin HEAD:master
out=$("$TD" tree-fix-outcome "$REPO" stream --for-sha="$TFA" --result=red \
  --signature=sig1 --current-head="$TFA" --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -q '"action":"continue"' <<<"$out" \
   && grep -q '"task":"continue"' <<<"$out" \
   && [ "$(field "$REPO" stream repairMode)" = "continue" ] \
   && [ "$(field "$REPO" stream repairAttempt)" = "2" ]; then
  ok "3: continuation red escalates the SAME chain to continue-mode (attempt++)"
else
  bad "3: escalate rc=$rc out=$out mode=$(field "$REPO" stream repairMode) attempt=$(field "$REPO" stream repairAttempt)"
fi

# Advance the streak with a newer tree-fix (head moves to TFB)...
TFB=$(mkfix s_fixB "$S0" continue); git push -q origin HEAD:master
"$TD" tree-fix-outcome "$REPO" stream --for-sha="$TFB" --result=red \
  --signature=sig2 --current-head="$TFB" --json >/dev/null 2>&1
attemptBefore=$(field "$REPO" stream repairAttempt)
sigBefore=$(field "$REPO" stream sameSigCount)
# ...now an OLD CI run for TFA arrives late while the head is TFB: ignore it,
# and DO NOT touch the escalation counters.
out=$("$TD" tree-fix-outcome "$REPO" stream --for-sha="$TFA" --result=red \
  --signature=sig1 --current-head="$TFB" --json 2>/dev/null); rc=$?
if [ "$rc" -eq 6 ] && grep -q '"action":"noop-stale"' <<<"$out" \
   && [ "$(field "$REPO" stream repairAttempt)" = "$attemptBefore" ] \
   && [ "$(field "$REPO" stream sameSigCount)" = "$sigBefore" ]; then
  ok "4: out-of-order continue replay is ignored and never inflates counters"
else
  bad "4: replay rc=$rc out=$out attempt=$(field "$REPO" stream repairAttempt)/$attemptBefore sig=$(field "$REPO" stream sameSigCount)/$sigBefore"
fi

# ===========================================================================
# CASE 3 — REGRESSION vs CONTINUATION (First-Red identity is the tell)
# While a chain is OPEN, a new red is a CONTINUATION: same First-Red, head
# advances. After the chain goes GREEN, the next red is a fresh REGRESSION:
# a new chain anchored at a NEW First-Red. One chain per red streak.
# ===========================================================================
echo r1 > f; git commit -qam r1; R1=$(git rev-parse HEAD); git push -q origin HEAD:master
"$TD" classify "$REPO" reg --for-sha="$R1" --result=red --current-head="$R1" \
  --json >/dev/null 2>&1
firstAnchor=$(field "$REPO" reg firstRed)
echo r2 > f; git commit -qam r2; R2=$(git rev-parse HEAD); git push -q origin HEAD:master
out=$("$TD" classify "$REPO" reg --for-sha="$R2" --result=red \
  --current-head="$R2" --json 2>/dev/null)
contFirst=$(field "$REPO" reg firstRed)
if grep -q '"action":"continue"' <<<"$out" \
   && [ "$contFirst" = "$firstAnchor" ] && [ "$firstAnchor" = "$R1" ] \
   && [ "$(field "$REPO" reg currentHead)" = "$R2" ]; then
  ok "5: a red while OPEN is a continuation (First-Red unchanged, head advances)"
else
  bad "5: continuation first=$contFirst/$firstAnchor head=$(field "$REPO" reg currentHead) out=$out"
fi

# Close the streak green at the live head, then a fresh red = regression.
echo r3 > f; git commit -qam r3; R3=$(git rev-parse HEAD); git push -q origin HEAD:master
"$TD" classify "$REPO" reg --for-sha="$R3" --result=green --current-head="$R3" \
  --json >/dev/null 2>&1
[ "$(field "$REPO" reg state)" = "green" ] || bad "6a: streak did not close green"
echo r4 > f; git commit -qam r4; R4=$(git rev-parse HEAD); git push -q origin HEAD:master
out=$("$TD" classify "$REPO" reg --for-sha="$R4" --result=red \
  --current-head="$R4" --json 2>/dev/null)
regFirst=$(field "$REPO" reg firstRed)
if grep -q '"action":"open"' <<<"$out" \
   && [ "$regFirst" = "$R4" ] && [ "$regFirst" != "$firstAnchor" ] \
   && [ "$(field "$REPO" reg repairMode)" = "initial" ]; then
  ok "6: a red after GREEN is a fresh regression (new First-Red, mode=initial)"
else
  bad "6: regression first=$regFirst anchor=$firstAnchor mode=$(field "$REPO" reg repairMode) out=$out"
fi

# ===========================================================================
# CASE 4 — GREEN CLOSES THE RIGHT CHAIN (multi-chain isolation)
# Open concurrent chains on two branches of the same repo AND on a second
# repo. A current green on one chain must close ONLY that chain; every
# sibling chain (other branch, other repo) stays open/red untouched.
# ===========================================================================
# Two branches in REPO: branch-a and branch-b, both red & open at C1.
git push -q origin "$C1:refs/heads/branch-a" 2>/dev/null
git push -q origin "$C1:refs/heads/branch-b" 2>/dev/null
"$TD" classify "$REPO" branch-a --for-sha="$C1" --result=red --current-head="$C1" \
  --json >/dev/null 2>&1
"$TD" classify "$REPO" branch-b --for-sha="$C1" --result=red --current-head="$C1" \
  --json >/dev/null 2>&1
# A second repo with its own master chain, also red & open at C1.
git push -q origin "$C1:refs/heads/r2master" 2>/dev/null
"$TD" classify "$REPO2" r2master --for-sha="$C1" --result=red --current-head="$C1" \
  --json >/dev/null 2>&1

# Close branch-a green at its current head.
out=$("$TD" classify "$REPO" branch-a --for-sha="$C1" --result=green \
  --current-head="$C1" --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -q '"action":"close"' <<<"$out" \
   && grep -q '"ticket":"close"' <<<"$out" \
   && [ "$(field "$REPO" branch-a state)" = "green" ]; then
  ok "7: a current green closes its OWN chain (branch-a -> green)"
else
  bad "7: close rc=$rc out=$out state=$(field "$REPO" branch-a state)"
fi

# The sibling branch chain in the same repo is untouched.
if [ "$(field "$REPO" branch-b state)" = "red" ] \
   && [ "$(field "$REPO" branch-b firstRed)" = "$C1" ]; then
  ok "8: the sibling branch chain (branch-b) stays red — green closed the right one"
else
  bad "8: sibling-branch state=$(field "$REPO" branch-b state) first=$(field "$REPO" branch-b firstRed)"
fi

# The other repo's chain is untouched.
if [ "$(field "$REPO2" r2master state)" = "red" ] \
   && [ "$(field "$REPO2" r2master firstRed)" = "$C1" ]; then
  ok "9: the other repo's chain stays red — green did not cross repo boundaries"
else
  bad "9: cross-repo state=$(field "$REPO2" r2master state) first=$(field "$REPO2" r2master firstRed)"
fi

# And a green on branch-b now closes branch-b specifically, leaving the other
# repo still red: each green resolves exactly one chain.
"$TD" classify "$REPO" branch-b --for-sha="$C1" --result=green --current-head="$C1" \
  --json >/dev/null 2>&1
if [ "$(field "$REPO" branch-b state)" = "green" ] \
   && [ "$(field "$REPO2" r2master state)" = "red" ]; then
  ok "10: closing branch-b green still leaves the other repo's chain red"
else
  bad "10: post-close b=$(field "$REPO" branch-b state) r2=$(field "$REPO2" r2master state)"
fi

echo "-----"
echo "ci-race-stale: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
