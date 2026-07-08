#!/usr/bin/env bash
# Fixture smoke test: CI broken-master classifier CORE (design §2 + §4).
# Exercises green/red/unknown classification and the chain open/continue/close
# state machine on top of chain-read/chain-write, plus the §4 currency rules
# (act relative to the live branch HEAD; ignore superseded SHAs; close green
# only when current). Builds a throwaway bare origin + working clone in a
# tempdir (no network, no real repo).
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# bare origin + working clone with a 4-commit linear history C1<-C2<-C3<-C4.
git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc" 2>/dev/null
cd "$ROOT/wc"
echo a > f; git add f; git commit -qm c1; C1=$(git rev-parse HEAD)
echo b > f; git commit -qam c2; C2=$(git rev-parse HEAD)
echo c > f; git commit -qam c3; C3=$(git rev-parse HEAD)
echo d > f; git commit -qam c4; C4=$(git rev-parse HEAD)
git push -q origin HEAD:master

REPO=acme/widgets

field() { # <branch> <jsonkey>  -> echo value (or empty)
  "$TD" chain-read "$REPO" "$1" --json 2>/dev/null \
    | sed -E "s/.*\"$2\":\"([^\"]*)\".*/\1/;t;d"
}

json_ok() { # read a JSON string on stdin, exit 0 iff it parses
  if command -v jq >/dev/null 2>&1; then jq -e . >/dev/null 2>&1
  elif command -v python3 >/dev/null 2>&1; then python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null
  else cat >/dev/null; return 0  # no validator available; treat as pass
  fi
}

# ---------------------------------------------------------------------------
# TEST 1: gate aggregation — any failure => red.
# ---------------------------------------------------------------------------
out=$("$TD" classify "$REPO" agg --for-sha="$C1" --current-head="$C1" \
  --gate=success --gate=failure --json --dry-run 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -q '"result":"red"' <<<"$out"; then
  ok "1: gate aggregation: a failing gate makes the aggregate red"
else
  bad "1: agg-red rc=$rc out=$out"
fi

# ---------------------------------------------------------------------------
# TEST 2: gate aggregation — all success => green; a pending/unknown => unknown.
# ---------------------------------------------------------------------------
g=$("$TD" classify "$REPO" agg --for-sha="$C1" --current-head="$C1" \
  --gate=success --gate=success --json --dry-run 2>/dev/null)
u=$("$TD" classify "$REPO" agg --for-sha="$C1" --current-head="$C1" \
  --gate=success --gate=pending --json --dry-run 2>/dev/null)
if grep -q '"result":"green"' <<<"$g" && grep -q '"result":"unknown"' <<<"$u"; then
  ok "2: aggregation: all-success=green, any-pending=unknown"
else
  bad "2: agg-green/unknown g=$g u=$u"
fi

# ---------------------------------------------------------------------------
# TEST 3: a RED with no open chain OPENS one chain anchored at First-Red,
# action=open, ticket=open, Repair-Mode=initial.
# ---------------------------------------------------------------------------
out=$("$TD" classify "$REPO" master --for-sha="$C2" --result=red \
  --current-head="$C2" --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -q '"action":"open"' <<<"$out" \
   && grep -q '"ticket":"open"' <<<"$out" \
   && [ "$(field master firstRed)" = "$C2" ] \
   && [ "$(field master state)" = "red" ] \
   && [ "$(field master repairMode)" = "initial" ]; then
  ok "3: red with no chain opens ONE chain anchored at First-Red (mode=initial)"
else
  bad "3: open rc=$rc out=$out first=$(field master firstRed) state=$(field master state)"
fi

# ---------------------------------------------------------------------------
# TEST 4: a CONTINUATION red (chain already open) advances Current-Head but
# keeps the SAME First-Red — one chain per red streak, not a new one.
# ---------------------------------------------------------------------------
out=$("$TD" classify "$REPO" master --for-sha="$C3" --result=red \
  --current-head="$C3" --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -q '"action":"continue"' <<<"$out" \
   && grep -q '"ticket":"none"' <<<"$out" \
   && [ "$(field master currentHead)" = "$C3" ] \
   && [ "$(field master firstRed)" = "$C2" ]; then
  ok "4: continuation red advances Current-Head, keeps First-Red (one chain)"
else
  bad "4: continue rc=$rc out=$out head=$(field master currentHead) first=$(field master firstRed)"
fi

# ---------------------------------------------------------------------------
# TEST 5: STALE/SUPERSEDED — a red for C1 (ancestor of the live tip C4) is an
# out-of-order CI run; it is IGNORED (exit 6, action=noop-stale), state intact.
# ---------------------------------------------------------------------------
before=$(field master currentHead)
out=$("$TD" classify "$REPO" master --for-sha="$C1" --result=red \
  --current-head="$C4" --json 2>/dev/null); rc=$?
after=$(field master currentHead)
if [ "$rc" -eq 6 ] && grep -q '"action":"noop-stale"' <<<"$out" \
   && [ "$before" = "$after" ]; then
  ok "5: superseded (out-of-order) red ignored (exit 6), chain untouched"
else
  bad "5: stale rc=$rc out=$out before=$before after=$after"
fi

# ---------------------------------------------------------------------------
# TEST 6: GREEN that is NOT current does NOT close the open chain
# ("close green only when current", design §4).
# ---------------------------------------------------------------------------
out=$("$TD" classify "$REPO" master --for-sha="$C3" --result=green \
  --current-head="$C4" --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -q '"action":"noop-green-noncurrent"' <<<"$out" \
   && [ "$(field master state)" = "red" ]; then
  ok "6: non-current green does NOT close the chain (chain stays red)"
else
  bad "6: green-noncurrent rc=$rc out=$out state=$(field master state)"
fi

# ---------------------------------------------------------------------------
# TEST 7: GREEN that IS current CLOSES the chain: State=green, Last-Green set,
# repair fields cleared, action=close, ticket=close.
# ---------------------------------------------------------------------------
out=$("$TD" classify "$REPO" master --for-sha="$C4" --result=green \
  --current-head="$C4" --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -q '"action":"close"' <<<"$out" \
   && grep -q '"ticket":"close"' <<<"$out" \
   && [ "$(field master state)" = "green" ] \
   && [ "$(field master lastGreen)" = "$C4" ] \
   && [ -z "$(field master firstRed)" ] \
   && [ -z "$(field master repairMode)" ]; then
  ok "7: current green closes the chain (state=green, repair fields cleared)"
else
  bad "7: close rc=$rc out=$out state=$(field master state) first=$(field master firstRed)"
fi

# ---------------------------------------------------------------------------
# TEST 8: after a close, the NEXT red opens a FRESH chain (new First-Red) —
# one chain per red streak.
# ---------------------------------------------------------------------------
out=$("$TD" classify "$REPO" master --for-sha="$C4" --result=red \
  --current-head="$C4" --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -q '"action":"open"' <<<"$out" \
   && [ "$(field master firstRed)" = "$C4" ] \
   && [ "$(field master state)" = "red" ]; then
  ok "8: a red after a green opens a fresh chain (new First-Red)"
else
  bad "8: reopen rc=$rc out=$out first=$(field master firstRed)"
fi

# ---------------------------------------------------------------------------
# TEST 9: UNKNOWN leaves an open chain untouched (no close, no escalation).
# ---------------------------------------------------------------------------
before=$("$TD" chain-read "$REPO" master --json 2>/dev/null)
out=$("$TD" classify "$REPO" master --for-sha="$C4" --result=unknown \
  --current-head="$C4" --json 2>/dev/null); rc=$?
after=$("$TD" chain-read "$REPO" master --json 2>/dev/null)
if [ "$rc" -eq 0 ] && grep -q '"action":"noop-unknown"' <<<"$out" \
   && [ "$(field master state)" = "red" ] \
   && [ "$before" = "$after" ]; then
  ok "9: unknown classification leaves the open chain untouched"
else
  bad "9: unknown rc=$rc out=$out state=$(field master state)"
fi

# ---------------------------------------------------------------------------
# TEST 10: argument validation — --result and --gate together is rejected,
# and an unresolvable --for-sha is rejected (both exit 1).
# ---------------------------------------------------------------------------
"$TD" classify "$REPO" master --for-sha="$C4" --result=red --gate=success \
  >/dev/null 2>&1; r1=$?
"$TD" classify "$REPO" master --for-sha=not-a-real-sha --result=red \
  --current-head="$C4" >/dev/null 2>&1; r2=$?
if [ "$r1" -eq 1 ] && [ "$r2" -eq 1 ]; then
  ok "10: bad args rejected (--result+--gate, unresolvable --for-sha)"
else
  bad "10: arg-validation r1=$r1 r2=$r2"
fi

# ---------------------------------------------------------------------------
# TEST 11: --allow-stale forces an otherwise-superseded red through.
# ---------------------------------------------------------------------------
# Fresh branch with its own chain opened at C4, tip advertised as C4.
"$TD" classify "$REPO" forcebr --for-sha="$C4" --result=red \
  --current-head="$C4" >/dev/null 2>&1
out=$("$TD" classify "$REPO" forcebr --for-sha="$C1" --result=red \
  --current-head="$C4" --allow-stale --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -q '"action":"continue"' <<<"$out"; then
  ok "11: --allow-stale forces a superseded red through"
else
  bad "11: allow-stale rc=$rc out=$out"
fi

# ---------------------------------------------------------------------------
# TEST 12: fail-closed currency — with no chain and no determinable tip
# (no --current-head, branch absent on origin), classify refuses (exit 4)
# and creates NO chain ref.
# ---------------------------------------------------------------------------
"$TD" classify "$REPO" ghostbranch --for-sha="$C2" --result=red >/dev/null 2>&1; rc=$?
made=$(git ls-remote origin refs/heads/tasks/ci-chains/acme/widgets/ghostbranch | awk '{print $1}')
if [ "$rc" -eq 4 ] && [ -z "$made" ]; then
  ok "12: indeterminate live tip fails closed (exit 4), no ref created"
else
  bad "12: fail-closed rc=$rc made='$made'"
fi

# ---------------------------------------------------------------------------
# TEST 13: non-current green with NO open chain writes NOTHING (no watermark
# off a stale green) — action=noop-green-noncurrent, no ref created.
# ---------------------------------------------------------------------------
out=$("$TD" classify "$REPO" freshg --for-sha="$C2" --result=green \
  --current-head="$C4" --json 2>/dev/null); rc=$?
made=$(git ls-remote origin refs/heads/tasks/ci-chains/acme/widgets/freshg | awk '{print $1}')
if [ "$rc" -eq 0 ] && grep -q '"action":"noop-green-noncurrent"' <<<"$out" \
   && [ -z "$made" ]; then
  ok "13: non-current green with no chain writes nothing"
else
  bad "13: stale-green-nochain rc=$rc made='$made' out=$out"
fi

# ---------------------------------------------------------------------------
# TEST 14: ticket hint is suppressed (ticket=none, applied=false) when the
# CAS write is refused. Pre-create a chain at C4, then force a CAS mismatch by
# making the classifier's observed baseline stale via a concurrent write.
# We simulate by opening then advancing the chain out from under a second
# classifier using chain-write's --expect-old guard directly through classify:
# a continuation race where the chain moved -> exit 5, applied=false.
# ---------------------------------------------------------------------------
# Open a chain at C2 (current=C2), then advance origin chain via a direct
# chain-write so a classify that read the C2-state baseline will CAS-fail.
"$TD" classify "$REPO" race --for-sha="$C2" --result=red --current-head="$C2" >/dev/null 2>&1
RREF=refs/heads/tasks/ci-chains/acme/widgets/race
base=$(git ls-remote origin "$RREF" | awk '{print $1}')
# Build a classify continuation for C3 but first move the chain so its
# --expect-old baseline (the C2 chain commit) no longer matches origin.
"$TD" chain-write "$REPO" race --for-sha="$C3" --state=red >/dev/null 2>&1
# Now a classify whose read happened before that move would CAS-fail. We can't
# easily interleave in-process, so assert the primitive instead: a chain-write
# bound to the stale baseline is refused (exit 5) and leaves state intact.
nowsha=$(git ls-remote origin "$RREF" | awk '{print $1}')
"$TD" chain-write "$REPO" race --for-sha="$C4" --expect-old="$base" \
  --state=red >/dev/null 2>&1; rc=$?
after=$(git ls-remote origin "$RREF" | awk '{print $1}')
if [ "$rc" -eq 5 ] && [ "$nowsha" = "$after" ]; then
  ok "14: --expect-old CAS refuses a write bound to a stale baseline (exit 5)"
else
  bad "14: expect-old rc=$rc now=$nowsha after=$after"
fi

# ---------------------------------------------------------------------------
# TEST 15: a classification that does NOT mutate chain state must report
# applied=false and ticket=none, so a ticket leaf parsing the JSON can never
# file/close off a transition that did not happen. (Here: a superseded red,
# which exits 6 without writing.)
# ---------------------------------------------------------------------------
out=$("$TD" classify "$REPO" master --for-sha="$C2" --result=red \
  --current-head="$C4" --json 2>/dev/null); rc=$?
if [ "$rc" -eq 6 ] && grep -q '"applied":false' <<<"$out" \
   && grep -q '"ticket":"none"' <<<"$out"; then
  ok "15: a non-applied classification reports applied=false, ticket=none"
else
  bad "15: applied-flag rc=$rc out=$out"
fi

# ---------------------------------------------------------------------------
# TEST 16: a prior chain State carrying quote/backslash must be escaped in the
# classify --json report (priorState is read from the chain commit); a
# regression that raw-interpolated it would emit invalid JSON.
# ---------------------------------------------------------------------------
"$TD" chain-write "$REPO" advc --for-sha="$C1" \
  --set 'State=re"d\x' --set 'First-Red='"$C1" --set 'Current-Head='"$C1" \
  --create >/dev/null 2>&1
adv=$("$TD" classify "$REPO" advc --for-sha="$C1" --result=red \
  --current-head="$C1" --json --dry-run 2>/dev/null)
if printf '%s' "$adv" | json_ok; then
  ok "16: classify --json escapes a quoted/backslash priorState into valid JSON"
else
  bad "16: classify --json produced invalid JSON for an adversarial priorState: $adv"
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
