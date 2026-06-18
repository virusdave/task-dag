#!/usr/bin/env bash
# Fixture smoke test: CI broken-master "repair chain" state persistence —
# the ref format, the compare-and-set read/write primitive, and the
# out-of-order / stale-run race guard (design §1 + §4). Builds a throwaway
# bare origin + working clone in a tempdir (no network, no real repo).
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
REF=refs/heads/tasks/ci-chains/acme/widgets/master

# ---------------------------------------------------------------------------
# TEST 1: reading a non-existent chain reports exists:false and exit 3.
# ---------------------------------------------------------------------------
out=$("$TD" chain-read "$REPO" master --json 2>/dev/null); rc=$?
if [ "$rc" -eq 3 ] && grep -q '"exists":false' <<<"$out"; then
  ok "1: chain-read of absent state exits 3 with exists:false"
else
  bad "1: absent read rc=$rc out=$out"
fi

# ---------------------------------------------------------------------------
# TEST 2: --create writes the design §1 fields and the ref exists on origin.
# ---------------------------------------------------------------------------
"$TD" chain-write "$REPO" master --for-sha="$C2" --state=red \
  --first-red="$C2" --last-green="$C1" --create >/dev/null 2>&1; rc=$?
remote=$(git ls-remote origin "$REF" | awk '{print $1}')
if [ "$rc" -eq 0 ] && [ -n "$remote" ]; then
  ok "2: chain-write --create lands the ref on origin"
else
  bad "2: create rc=$rc remote='$remote'"
fi

# ---------------------------------------------------------------------------
# TEST 3: chain-read round-trips every stored field.
# ---------------------------------------------------------------------------
j=$("$TD" chain-read "$REPO" master --json 2>/dev/null)
if grep -q "\"currentHead\":\"$C2\"" <<<"$j" \
   && grep -q "\"firstRed\":\"$C2\"" <<<"$j" \
   && grep -q "\"lastGreen\":\"$C1\"" <<<"$j" \
   && grep -q '"state":"red"' <<<"$j"; then
  ok "3: chain-read round-trips Current-Head/First-Red/Last-Green/State"
else
  bad "3: round-trip mismatch: $j"
fi

# ---------------------------------------------------------------------------
# TEST 4: a second --create on an existing chain is refused (exit 5).
# ---------------------------------------------------------------------------
"$TD" chain-write "$REPO" master --for-sha="$C2" --create >/dev/null 2>&1; rc=$?
[ "$rc" -eq 5 ] && ok "4: --create on existing chain refused (exit 5)" \
  || bad "4: expected exit 5, got $rc"

# ---------------------------------------------------------------------------
# TEST 5: STALE-RUN GUARD — a write for C1 (ancestor of stored head C2) is
# rejected (exit 6) and the stored state is left untouched.
# ---------------------------------------------------------------------------
before=$(git ls-remote origin "$REF" | awk '{print $1}')
"$TD" chain-write "$REPO" master --for-sha="$C1" --state=green >/dev/null 2>&1; rc=$?
after=$(git ls-remote origin "$REF" | awk '{print $1}')
if [ "$rc" -eq 6 ] && [ "$before" = "$after" ]; then
  ok "5: out-of-order write (superseded SHA) rejected, state unchanged"
else
  bad "5: stale guard rc=$rc before=$before after=$after"
fi

# ---------------------------------------------------------------------------
# TEST 6: --allow-stale bypasses the guard and writes.
# ---------------------------------------------------------------------------
"$TD" chain-write "$REPO" master --for-sha="$C1" --repair-attempt=2 \
  --allow-stale >/dev/null 2>&1; rc=$?
j=$("$TD" chain-read "$REPO" master --json 2>/dev/null)
if [ "$rc" -eq 0 ] && grep -q "\"currentHead\":\"$C1\"" <<<"$j"; then
  ok "6: --allow-stale overrides the supersede guard"
else
  bad "6: allow-stale rc=$rc out=$j"
fi

# ---------------------------------------------------------------------------
# TEST 7: advancing to a NEWER head (descendant) succeeds and INHERITS
# unspecified fields (First-Red carried forward from the prior state).
# ---------------------------------------------------------------------------
"$TD" chain-write "$REPO" master --for-sha="$C3" --state=green \
  --last-green="$C3" >/dev/null 2>&1; rc=$?
j=$("$TD" chain-read "$REPO" master --json 2>/dev/null)
if [ "$rc" -eq 0 ] \
   && grep -q "\"currentHead\":\"$C3\"" <<<"$j" \
   && grep -q "\"lastGreen\":\"$C3\"" <<<"$j" \
   && grep -q "\"firstRed\":\"$C2\"" <<<"$j"; then
  ok "7: advancing head succeeds and inherits unspecified fields"
else
  bad "7: advance rc=$rc out=$j"
fi

# ---------------------------------------------------------------------------
# TEST 8: each write appends to a linear audit history (parent linkage).
# ---------------------------------------------------------------------------
git fetch -q origin "+$REF:$REF" 2>/dev/null
n=$(git rev-list --count "$REF")
if [ "$n" -ge 3 ]; then
  ok "8: chain ref keeps a linear audit history ($n commits)"
else
  bad "8: expected >=3 chain commits, got $n"
fi

# ---------------------------------------------------------------------------
# TEST 9: a slashed branch is encoded to one ref-safe path component (no
# D/F conflict with a plain 'release' branch's ref).
# ---------------------------------------------------------------------------
"$TD" chain-write "$REPO" release --for-sha="$C1" --create >/dev/null 2>&1
"$TD" chain-write "$REPO" release/v1 --for-sha="$C2" --create >/dev/null 2>&1; rc=$?
git fetch -q origin '+refs/heads/tasks/ci-chains/*:refs/heads/tasks/ci-chains/*' 2>/dev/null
if [ "$rc" -eq 0 ] \
   && git show-ref --verify --quiet "refs/heads/tasks/ci-chains/acme/widgets/release" \
   && git show-ref --verify --quiet "refs/heads/tasks/ci-chains/acme/widgets/release%2Fv1"; then
  ok "9: slashed branch encoded without D/F ref conflict"
else
  bad "9: slashed-branch encoding rc=$rc"
fi

# ---------------------------------------------------------------------------
# TEST 10: CONCURRENCY CAS — two parallel --create writers for the same
# fresh chain; exactly one wins (exit 0) and the other loses the lease
# (exit 5). This exercises the atomic --force-with-lease push + readback.
# ---------------------------------------------------------------------------
git clone -q "$ROOT/origin.git" "$ROOT/wc2" 2>/dev/null
( cd "$ROOT/wc"  && "$TD" chain-write "$REPO" hotbranch --for-sha="$C1" --create \
    >/dev/null 2>&1; echo $? > "$ROOT/r1" ) &
( cd "$ROOT/wc2" && "$TD" chain-write "$REPO" hotbranch --for-sha="$C2" --create \
    >/dev/null 2>&1; echo $? > "$ROOT/r2" ) &
wait
r1=$(cat "$ROOT/r1"); r2=$(cat "$ROOT/r2")
wins=0; losses=0
for r in "$r1" "$r2"; do
  [ "$r" -eq 0 ] && wins=$((wins+1))
  [ "$r" -eq 5 ] && losses=$((losses+1))
done
if [ "$wins" -eq 1 ] && [ "$losses" -eq 1 ]; then
  ok "10: concurrent --create CAS — exactly one winner, one lease-loser"
else
  bad "10: concurrency r1=$r1 r2=$r2 (wins=$wins losses=$losses)"
fi

# ---------------------------------------------------------------------------
# TEST 11: a --for-sha that does not resolve to a commit object is rejected
# (exit 1) — no junk like a branch name or typo can poison Current-Head.
# ---------------------------------------------------------------------------
"$TD" chain-write "$REPO" master --for-sha=not-a-real-ref >/dev/null 2>&1; rc=$?
[ "$rc" -eq 1 ] && ok "11: unresolvable --for-sha rejected (exit 1)" \
  || bad "11: expected exit 1 for junk --for-sha, got $rc"

# ---------------------------------------------------------------------------
# TEST 12: FAIL-CLOSED — when the stored Current-Head's object is not present
# locally, ancestry is undeterminable and the write must be REFUSED (exit 6),
# never allowed to clobber possibly-newer state.
# ---------------------------------------------------------------------------
EMPTY_TREE=$(git hash-object -t tree /dev/null)
FAKE=0000000000000000000000000000000000000001   # not a real object
poison=$(printf 'CI-Chain: %s@indet\n\nCurrent-Head: %s\nState: red\n' "$REPO" "$FAKE" \
  | git commit-tree "$EMPTY_TREE")
git push -q origin "$poison:refs/heads/tasks/ci-chains/acme/widgets/indet"
before=$(git ls-remote origin refs/heads/tasks/ci-chains/acme/widgets/indet | awk '{print $1}')
out=$("$TD" chain-write "$REPO" indet --for-sha="$C1" --json 2>/dev/null); rc=$?
after=$(git ls-remote origin refs/heads/tasks/ci-chains/acme/widgets/indet | awk '{print $1}')
if [ "$rc" -eq 6 ] && grep -q '"reason":"stale-indeterminate"' <<<"$out" && [ "$before" = "$after" ]; then
  ok "12: undeterminable ancestry fails closed (exit 6), state untouched"
else
  bad "12: fail-closed rc=$rc before=$before after=$after out=$out"
fi
# ...but --allow-stale still lets an operator force it through.
"$TD" chain-write "$REPO" indet --for-sha="$C1" --allow-stale >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && ok "12b: --allow-stale overrides the fail-closed guard" \
  || bad "12b: allow-stale over indeterminate expected 0, got $rc"

# ---------------------------------------------------------------------------
# TEST 13: JSON output stays valid when a field value contains quotes /
# backslashes (the generic --set / arbitrary State values must be escaped).
# ---------------------------------------------------------------------------
json_ok() { # read a JSON string on stdin, exit 0 iff it parses
  if command -v jq >/dev/null 2>&1; then jq -e . >/dev/null 2>&1
  elif command -v python3 >/dev/null 2>&1; then python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null
  else cat >/dev/null; return 0  # no validator available; treat as pass
  fi
}
"$TD" chain-write "$REPO" jsonesc --for-sha="$C1" --state='re"d\x' --create >/dev/null 2>&1
if "$TD" chain-read "$REPO" jsonesc --json 2>/dev/null | json_ok; then
  ok "13: chain-read --json escapes quotes/backslashes into valid JSON"
else
  bad "13: chain-read --json produced invalid JSON for a quoted field value"
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
