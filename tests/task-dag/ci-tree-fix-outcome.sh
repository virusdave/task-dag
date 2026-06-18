#!/usr/bin/env bash
# Fixture smoke test: CI broken-master TREE-FIX OUTCOME handler (design §3).
# Exercises the tree-fix escalation table: green closes the chain + clears the
# repair/signature fields; a continuation red escalates the SAME chain to
# Repair-Mode=continue (Repair-Attempt++) and reports task=continue; a red whose
# parent was green opens a fresh initial chain; repeated SAME-signature continue
# failures BLOCK the chain + report page=true after the threshold; and the §4
# currency / stale rules carry over. Also verifies the State=blocked interplay
# with `classify` (a fresh red must NOT reopen a blocked chain; a green must
# still close it). Builds a throwaway bare origin + working clone (no network).
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc" 2>/dev/null
cd "$ROOT/wc"
echo a > f; git add f; git commit -qm c1; C1=$(git rev-parse HEAD)
git push -q origin HEAD:master

REPO=acme/widgets

field() { # <branch> <jsonkey>  -> echo value (or empty)
  "$TD" chain-read "$REPO" "$1" --json 2>/dev/null \
    | sed -E "s/.*\"$2\":\"([^\"]*)\".*/\1/;t;d"
}
jget() { sed -E "s/.*\"$1\":\"?([^\",}]*)\"?.*/\1/;t;d"; }

# Make a tree-fix commit on top of HEAD; echo its SHA. <content> <chain> <mode>
mkfix() {
  echo "$1" > f
  git commit -qam "fix $1

Tree-Fix: acme/widgets#42
Tree-Fix-Chain: $2
Tree-Fix-Mode: $3"
  git rev-parse HEAD
}

# ---------------------------------------------------------------------------
# TEST 1: a non-tree-fix commit is rejected (this command is §3-only).
# ---------------------------------------------------------------------------
echo plain > f; git commit -qam "plain commit"; CP=$(git rev-parse HEAD)
git push -q origin HEAD:master
out=$("$TD" tree-fix-outcome "$REPO" master --for-sha="$CP" --result=red \
  --signature=s --current-head="$CP" --json 2>&1); rc=$?
if [ "$rc" -eq 1 ] && grep -q "not a tree-fix commit" <<<"$out"; then
  ok "1: a non-tree-fix commit is rejected (exit 1)"
else
  bad "1: non-tree-fix rc=$rc out=$out"
fi

# ---------------------------------------------------------------------------
# TEST 2: a red result with NO --signature is rejected (thresholding needs it).
# ---------------------------------------------------------------------------
TFX=$(mkfix red1 "$C1" continue); git push -q origin HEAD:master
out=$("$TD" tree-fix-outcome "$REPO" master --for-sha="$TFX" --result=red \
  --current-head="$TFX" --json 2>&1); rc=$?
if [ "$rc" -eq 1 ] && grep -q "signature is required" <<<"$out"; then
  ok "2: a red tree-fix outcome requires --signature"
else
  bad "2: missing-signature rc=$rc out=$out"
fi

# ---------------------------------------------------------------------------
# TEST 3: RED, no open chain (parent green) => NEW regression: a fresh initial
# chain anchored at the tree-fix commit; task=initial, ticket=open.
# ---------------------------------------------------------------------------
out=$("$TD" tree-fix-outcome "$REPO" master --for-sha="$TFX" --result=red \
  --signature=sigA --current-head="$TFX" --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -q '"action":"open-regression"' <<<"$out" \
   && grep -q '"task":"initial"' <<<"$out" && grep -q '"ticket":"open"' <<<"$out" \
   && [ "$(field master firstRed)" = "$TFX" ] \
   && [ "$(field master state)" = "red" ] \
   && [ "$(field master repairMode)" = "initial" ]; then
  ok "3: red with no open chain opens a fresh initial regression chain"
else
  bad "3: regression rc=$rc out=$out first=$(field master firstRed) state=$(field master state)"
fi

# ---------------------------------------------------------------------------
# TEST 4: CONTINUATION red on OUR chain => escalate SAME chain to continue-mode,
# Repair-Attempt++, State stays red, task=continue, Same-Sig-Count=1.
# ---------------------------------------------------------------------------
TF2=$(mkfix red2 "$TFX" continue); git push -q origin HEAD:master
out=$("$TD" tree-fix-outcome "$REPO" master --for-sha="$TF2" --result=red \
  --signature=sigB --current-head="$TF2" --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -q '"action":"continue"' <<<"$out" \
   && grep -q '"task":"continue"' <<<"$out" && grep -q '"page":false' <<<"$out" \
   && [ "$(field master state)" = "red" ] \
   && [ "$(field master firstRed)" = "$TFX" ] \
   && [ "$(field master repairMode)" = "continue" ] \
   && [ "$(field master repairAttempt)" = "2" ] \
   && [ "$(field master sameSigCount)" = "1" ]; then
  ok "4: continuation red escalates the SAME chain to continue-mode (attempt++)"
else
  bad "4: continue rc=$rc out=$out state=$(field master state) attempt=$(field master repairAttempt) sig=$(field master sameSigCount)"
fi

# ---------------------------------------------------------------------------
# TEST 5: a DIFFERENT signature resets Same-Sig-Count to 1 (not a repeat).
# (attempt 2 used sigB; now use sigC -> count must reset, not grow.)
# ---------------------------------------------------------------------------
TF3=$(mkfix red3 "$TFX" continue); git push -q origin HEAD:master
out=$("$TD" tree-fix-outcome "$REPO" master --for-sha="$TF3" --result=red \
  --signature=sigC --current-head="$TF3" --json 2>/dev/null)
if [ "$(field master sameSigCount)" = "1" ] && [ "$(field master repairAttempt)" = "3" ] \
   && grep -q '"action":"continue"' <<<"$out"; then
  ok "5: a changed signature resets Same-Sig-Count (attempt still increments)"
else
  bad "5: reset out=$out attempt=$(field master repairAttempt) sig=$(field master sameSigCount)"
fi

# ---------------------------------------------------------------------------
# TEST 6: repeated SAME-signature continue failures BLOCK after --threshold,
# reporting page=true and persisting State=blocked.
# ---------------------------------------------------------------------------
# sigC count is currently 1; two more sigC reds at threshold 3 -> 2, then BLOCK.
TF4=$(mkfix red4 "$TFX" continue); git push -q origin HEAD:master
"$TD" tree-fix-outcome "$REPO" master --for-sha="$TF4" --result=red \
  --signature=sigC --current-head="$TF4" --threshold=3 --json >/dev/null 2>&1
[ "$(field master sameSigCount)" = "2" ] || bad "6a: expected sameSig=2 got $(field master sameSigCount)"
TF5=$(mkfix red5 "$TFX" continue); git push -q origin HEAD:master
out=$("$TD" tree-fix-outcome "$REPO" master --for-sha="$TF5" --result=red \
  --signature=sigC --current-head="$TF5" --threshold=3 --json 2>/dev/null)
if grep -q '"action":"block"' <<<"$out" && grep -q '"page":true' <<<"$out" \
   && grep -q '"task":"none"' <<<"$out" \
   && [ "$(field master state)" = "blocked" ] \
   && [ "$(field master sameSigCount)" = "3" ]; then
  ok "6: repeated same-signature continue failures BLOCK + page after threshold"
else
  bad "6: block out=$out state=$(field master state) sig=$(field master sameSigCount)"
fi

# ---------------------------------------------------------------------------
# TEST 7: a blocked chain is parked — another red tree-fix is a no-op (no
# escalation, no reopen), and a plain `classify` red does NOT open a 2nd chain.
# ---------------------------------------------------------------------------
TF6=$(mkfix red6 "$TFX" continue); git push -q origin HEAD:master
out=$("$TD" tree-fix-outcome "$REPO" master --for-sha="$TF6" --result=red \
  --signature=sigC --current-head="$TF6" --json 2>/dev/null); rc=$?
co=$("$TD" classify "$REPO" master --for-sha="$TF6" --result=red \
  --current-head="$TF6" --json 2>/dev/null)
if [ "$rc" -eq 0 ] && grep -q '"action":"noop-blocked"' <<<"$out" \
   && grep -q '"action":"noop-blocked"' <<<"$co" \
   && [ "$(field master state)" = "blocked" ] \
   && [ "$(field master firstRed)" = "$TFX" ]; then
  ok "7: a blocked chain is not reopened/escalated by a further red"
else
  bad "7: blocked-parked out=$out classify=$co state=$(field master state)"
fi

# ---------------------------------------------------------------------------
# TEST 8: GREEN on the blocked chain CLOSES it and clears repair+signature.
# ---------------------------------------------------------------------------
TF7=$(mkfix green1 "$TFX" continue); git push -q origin HEAD:master
out=$("$TD" tree-fix-outcome "$REPO" master --for-sha="$TF7" --result=green \
  --current-head="$TF7" --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -q '"action":"close"' <<<"$out" \
   && grep -q '"ticket":"close"' <<<"$out" \
   && [ "$(field master state)" = "green" ] \
   && [ "$(field master firstRed)" = "" ] \
   && [ "$(field master repairMode)" = "" ] \
   && [ "$(field master failSignature)" = "" ] \
   && [ "$(field master sameSigCount)" = "" ] \
   && [ "$(field master lastGreen)" = "$TF7" ]; then
  ok "8: a green tree-fix closes the chain + clears repair/signature fields"
else
  bad "8: green-close out=$out state=$(field master state) first=$(field master firstRed) sig=$(field master failSignature)"
fi

# ---------------------------------------------------------------------------
# TEST 9: a SUPERSEDED (non-current) red tree-fix is ignored (design §4).
# Open a fresh chain, then replay an older SHA that is not the live tip.
# ---------------------------------------------------------------------------
TFA=$(mkfix red7 "$C1" initial); git push -q origin HEAD:master
"$TD" tree-fix-outcome "$REPO" master --for-sha="$TFA" --result=red \
  --signature=sigZ --current-head="$TFA" --json >/dev/null 2>&1
TFB=$(mkfix red8 "$TFA" continue); git push -q origin HEAD:master
# Now classify against the OLD SHA TFA while the live head is TFB.
out=$("$TD" tree-fix-outcome "$REPO" master --for-sha="$TFA" --result=red \
  --signature=sigZ --current-head="$TFB" --json 2>&1); rc=$?
if [ "$rc" -eq 6 ] && grep -q '"action":"noop-stale"' <<<"$out"; then
  ok "9: a superseded (non-current) red tree-fix is ignored (exit 6)"
else
  bad "9: stale rc=$rc out=$out"
fi

# ---------------------------------------------------------------------------
# TEST 10: a green tree-fix that is NOT current never closes a chain.
# ---------------------------------------------------------------------------
out=$("$TD" tree-fix-outcome "$REPO" master --for-sha="$TFA" --result=green \
  --current-head="$TFB" --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -q '"action":"noop-green-noncurrent"' <<<"$out" \
   && [ "$(field master state)" = "red" ]; then
  ok "10: a non-current green tree-fix does not close the chain"
else
  bad "10: noncurrent-green rc=$rc out=$out state=$(field master state)"
fi

# ---------------------------------------------------------------------------
# TEST 11: a malformed Tree-Fix* trailer set exits 2 (delegated to the parser).
# ---------------------------------------------------------------------------
echo bad > f
git commit -qam "broken trailers

Tree-Fix: acme/widgets#42
Tree-Fix-Chain: not-a-sha
Tree-Fix-Mode: bogus"
CB=$(git rev-parse HEAD); git push -q origin HEAD:master
out=$("$TD" tree-fix-outcome "$REPO" master --for-sha="$CB" --result=red \
  --signature=s --current-head="$CB" --json 2>&1); rc=$?
if [ "$rc" -eq 2 ] && grep -q "malformed Tree-Fix" <<<"$out"; then
  ok "11: a malformed tree-fix commit exits 2"
else
  bad "11: malformed rc=$rc out=$out"
fi

# ---------------------------------------------------------------------------
# TEST 12: IDEMPOTENCY — replaying the SAME continuation red outcome (already
# the chain head) must NOT increment Repair-Attempt / Same-Sig-Count again
# (else a re-delivered CI run inflates counters and can falsely trip the block).
# ---------------------------------------------------------------------------
# Use a dedicated branch (its own chain ref) so earlier tests don't interfere.
echo idem1 > f; git commit -qam idem1; IC0=$(git rev-parse HEAD); git push -q origin HEAD:master
"$TD" classify "$REPO" idem --for-sha="$IC0" --result=red --current-head="$IC0" --json >/dev/null 2>&1
IF1=$(mkfix idemfix "$IC0" continue); git push -q origin HEAD:master
"$TD" tree-fix-outcome "$REPO" idem --for-sha="$IF1" --result=red \
  --signature=sigI --current-head="$IF1" --json >/dev/null 2>&1
a1=$(field idem repairAttempt); s1=$(field idem sameSigCount)
# Replay the EXACT same outcome (same SHA, still the head).
out=$("$TD" tree-fix-outcome "$REPO" idem --for-sha="$IF1" --result=red \
  --signature=sigI --current-head="$IF1" --json 2>/dev/null); rc=$?
a2=$(field idem repairAttempt); s2=$(field idem sameSigCount)
if [ "$rc" -eq 0 ] && grep -q '"action":"noop-already-processed"' <<<"$out" \
   && [ "$a1" = "$a2" ] && [ "$s1" = "$s2" ] && [ "$a1" = "2" ]; then
  ok "12: replaying the same continuation outcome is idempotent (no counter inflation)"
else
  bad "12: idempotency rc=$rc out=$out a1=$a1 a2=$a2 s1=$s1 s2=$s2"
fi

# ---------------------------------------------------------------------------
# TEST 13: a red result with a multi-line --signature is rejected.
# ---------------------------------------------------------------------------
out=$("$TD" tree-fix-outcome "$REPO" master --for-sha="$IF1" --result=red \
  --signature="$(printf 'a\nb')" --current-head="$IF1" --json 2>&1); rc=$?
if [ "$rc" -eq 1 ] && grep -q "single-line" <<<"$out"; then
  ok "13: a multi-line --signature is rejected"
else
  bad "13: multiline-sig rc=$rc out=$out"
fi

echo "---"
echo "tree-fix-outcome: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
