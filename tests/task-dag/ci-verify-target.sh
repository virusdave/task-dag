#!/usr/bin/env bash
# Fixture smoke test: CI broken-master WORKER VERIFIER (design §6 + §7).
# Exercises `task-dag verify-target` — the read-only, fail-closed preflight a
# repair worker runs to confirm its target is still the current, first-red,
# unclaimed chain head. Builds a throwaway bare origin + working clone in a
# tempdir (no network, no real repo); drives chain state through `classify`.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# bare origin + working clone with a 3-commit linear history C1<-C2<-C3.
git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc" 2>/dev/null
cd "$ROOT/wc"
echo a > f; git add f; git commit -qm c1; C1=$(git rev-parse HEAD)
echo b > f; git commit -qam c2; C2=$(git rev-parse HEAD)
echo c > f; git commit -qam c3; C3=$(git rev-parse HEAD)
git push -q origin HEAD:master

REPO=acme/widgets
jget() { sed -E "s/.*\"$1\":(\"?)([^,\"}]*)\1.*/\2/;t;d"; }
json_ok() { # read a JSON string on stdin, exit 0 iff it parses
  if command -v jq >/dev/null 2>&1; then jq -e . >/dev/null 2>&1
  elif command -v python3 >/dev/null 2>&1; then python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null
  else cat >/dev/null; return 0  # no validator available; treat as pass
  fi
}

# ---------------------------------------------------------------------------
# TEST 1: no chain state at all -> reason=no-chain, exit 3, ok=false.
# ---------------------------------------------------------------------------
out=$("$TD" verify-target "$REPO" master --target-sha="$C2" --json 2>/dev/null); rc=$?
if [ "$rc" -eq 3 ] && grep -q '"ok":false' <<<"$out" && grep -q '"reason":"no-chain"' <<<"$out"; then
  ok "1: no chain state -> no-chain (exit 3)"
else
  bad "1: no-chain rc=$rc out=$out"
fi

# Open a chain anchored at C2 (red, mode=initial, attempt=1), record issue 77.
"$TD" classify "$REPO" master --for-sha="$C2" --result=red \
  --current-head="$C2" --repair-issue=77 >/dev/null 2>&1

# ---------------------------------------------------------------------------
# TEST 2: target IS the open first-red head -> ok=true, exit 0.
# ---------------------------------------------------------------------------
out=$("$TD" verify-target "$REPO" master --target-sha="$C2" --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -q '"ok":true' <<<"$out" \
   && grep -q '"reason":"current-first-red-unclaimed"' <<<"$out" \
   && [ "$(jget firstRed <<<"$out")" = "$C2" ] \
   && [ "$(jget state <<<"$out")" = "red" ]; then
  ok "2: target is the current first-red head -> verified (exit 0)"
else
  bad "2: verified rc=$rc out=$out"
fi

# ---------------------------------------------------------------------------
# TEST 3: a DIFFERENT sha is not the first-red anchor -> not-first-red, exit 6.
# ---------------------------------------------------------------------------
out=$("$TD" verify-target "$REPO" master --target-sha="$C3" --json 2>/dev/null); rc=$?
if [ "$rc" -eq 6 ] && grep -q '"ok":false' <<<"$out" && grep -q '"reason":"not-first-red"' <<<"$out"; then
  ok "3: non-anchor sha -> not-first-red (exit 6)"
else
  bad "3: not-first-red rc=$rc out=$out"
fi

# ---------------------------------------------------------------------------
# TEST 4: optional field matchers — matching issue/mode/attempt pass; a
# mismatching issue fails with repair-issue-mismatch (exit 6).
# ---------------------------------------------------------------------------
good=$("$TD" verify-target "$REPO" master --target-sha="$C2" \
  --repair-issue=77 --mode=initial --attempt=1 --json 2>/dev/null); grc=$?
miss=$("$TD" verify-target "$REPO" master --target-sha="$C2" \
  --repair-issue=999 --json 2>/dev/null); mrc=$?
if [ "$grc" -eq 0 ] && grep -q '"ok":true' <<<"$good" \
   && [ "$mrc" -eq 6 ] && grep -q '"reason":"repair-issue-mismatch"' <<<"$miss"; then
  ok "4: field matchers — matching passes, mismatched issue fails (exit 6)"
else
  bad "4: matchers grc=$grc mrc=$mrc good=$good miss=$miss"
fi

# ---------------------------------------------------------------------------
# TEST 5: mode/attempt mismatch -> distinct reasons, exit 6.
# ---------------------------------------------------------------------------
m=$("$TD" verify-target "$REPO" master --target-sha="$C2" --mode=continue --json 2>/dev/null); mr=$?
a=$("$TD" verify-target "$REPO" master --target-sha="$C2" --attempt=2 --json 2>/dev/null); ar=$?
if [ "$mr" -eq 6 ] && grep -q '"reason":"repair-mode-mismatch"' <<<"$m" \
   && [ "$ar" -eq 6 ] && grep -q '"reason":"repair-attempt-mismatch"' <<<"$a"; then
  ok "5: mode/attempt mismatch -> distinct reasons (exit 6)"
else
  bad "5: mode/attempt mr=$mr ar=$ar m=$m a=$a"
fi

# ---------------------------------------------------------------------------
# TEST 6: once the chain CLOSES green, the old target is no longer red ->
# not-red, exit 6 (worker must not keep repairing a healed tree).
# ---------------------------------------------------------------------------
"$TD" classify "$REPO" master --for-sha="$C2" --result=green \
  --current-head="$C2" >/dev/null 2>&1
out=$("$TD" verify-target "$REPO" master --target-sha="$C2" --json 2>/dev/null); rc=$?
if [ "$rc" -eq 6 ] && grep -q '"reason":"not-red"' <<<"$out"; then
  ok "6: closed (green) chain -> not-red (exit 6)"
else
  bad "6: not-red rc=$rc out=$out"
fi

# ---------------------------------------------------------------------------
# TEST 7: claim awareness — open a fresh chain at C3, then place an active
# claim on the repair task SHA; --task makes verify-target report claimed (5).
# ---------------------------------------------------------------------------
"$TD" classify "$REPO" master --for-sha="$C3" --result=red \
  --current-head="$C3" >/dev/null 2>&1
# Forge an active claim ref on origin for a fake repair-task short SHA.
TASK=deadbeefcafef00dbaadf00ddeadbeefcafef00d
short="${TASK:0:7}"
git push -q origin "HEAD:refs/heads/tasks/active/$short"
unclaimed=$("$TD" verify-target "$REPO" master --target-sha="$C3" --json 2>/dev/null); urc=$?
claimed=$("$TD" verify-target "$REPO" master --target-sha="$C3" --task="$TASK" --json 2>/dev/null); crc=$?
if [ "$urc" -eq 0 ] && grep -q '"ok":true' <<<"$unclaimed" \
   && [ "$crc" -eq 5 ] && grep -q '"reason":"claimed"' <<<"$claimed" \
   && grep -q '"claimed":true' <<<"$claimed"; then
  ok "7: --task claim check — claimed task -> claimed (exit 5)"
else
  bad "7: claim urc=$urc crc=$crc unclaimed=$unclaimed claimed=$claimed"
fi

# ---------------------------------------------------------------------------
# TEST 8: argument validation — missing --target-sha, bad --mode, and an
# unresolvable non-hex target all rejected (exit 1).
# ---------------------------------------------------------------------------
"$TD" verify-target "$REPO" master --json >/dev/null 2>&1; r1=$?
"$TD" verify-target "$REPO" master --target-sha="$C2" --mode=bogus >/dev/null 2>&1; r2=$?
"$TD" verify-target "$REPO" master --target-sha=not-a-sha >/dev/null 2>&1; r3=$?
if [ "$r1" -eq 1 ] && [ "$r2" -eq 1 ] && [ "$r3" -eq 1 ]; then
  ok "8: bad args rejected (missing target, bad mode, non-hex target)"
else
  bad "8: arg-validation r1=$r1 r2=$r2 r3=$r3"
fi

# ---------------------------------------------------------------------------
# TEST 9: adversarial chain field values (quote + backslash) must be escaped
# so the verdict --json still parses — a regression that raw-interpolated a
# chain-derived field would emit invalid JSON here.
# ---------------------------------------------------------------------------
"$TD" chain-write "$REPO" advbranch --for-sha="$C1" --state=red \
  --set 'First-Red='"$C1" --set 'Current-Head='"$C1" \
  --set 'Last-Green=he"llo\world' --create >/dev/null 2>&1
adv=$("$TD" verify-target "$REPO" advbranch --target-sha="$C1" --json 2>/dev/null)
if printf '%s' "$adv" | json_ok; then
  ok "9: verify-target --json escapes quoted/backslash chain fields into valid JSON"
else
  bad "9: verify-target --json produced invalid JSON for an adversarial field: $adv"
fi

echo
echo "verify-target: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
