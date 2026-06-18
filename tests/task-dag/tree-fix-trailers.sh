#!/usr/bin/env bash
# Fixture smoke test: `parse-tree-fix` extracts + validates the
# Tree-Fix / Tree-Fix-Chain / Tree-Fix-Mode commit trailers (broken-master
# auto-repair, design section 3) via `git interpret-trailers`. Pure parser:
# reads a message (from --stdin or a commit), mutates nothing. Runs in a
# throwaway git repo (no network).
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

git init -q "$ROOT/wc"
cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed

SHA40="0123456789abcdef0123456789abcdef01234567"   # a syntactically valid full sha

# Helper: run parse-tree-fix on a message via --stdin; capture out + rc.
run_stdin() { OUT="$(printf '%s' "$1" | "$TD" parse-tree-fix --stdin "${@:2}" 2>"$ROOT/err")"; RC=$?; }

# ---------------------------------------------------------------------------
# TEST 1: a complete, valid initial-mode tree-fix parses (JSON).
# ---------------------------------------------------------------------------
MSG_OK="Fix the build

Some body text.

Tree-Fix: owner/repo#123
Tree-Fix-Chain: ${SHA40}
Tree-Fix-Mode: initial"
run_stdin "$MSG_OK" --json
EXP="{\"treeFix\":true,\"ticket\":\"owner/repo#123\",\"chain\":\"${SHA40}\",\"mode\":\"initial\"}"
if [ "$RC" -eq 0 ] && [ "$OUT" = "$EXP" ]; then
  ok "1: complete initial tree-fix parses to expected JSON"
else
  bad "1: rc=$RC out=$OUT exp=$EXP"
fi

# ---------------------------------------------------------------------------
# TEST 2: continue mode is accepted.
# ---------------------------------------------------------------------------
run_stdin "x

Tree-Fix: a/b#7
Tree-Fix-Chain: ${SHA40}
Tree-Fix-Mode: continue" --json
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q '"mode":"continue"'; then
  ok "2: continue mode accepted"
else
  bad "2: rc=$RC out=$OUT"
fi

# ---------------------------------------------------------------------------
# TEST 3: no trailers at all -> not a tree-fix commit (rc 0, treeFix false).
# ---------------------------------------------------------------------------
run_stdin "just a normal commit

no trailers here" --json
if [ "$RC" -eq 0 ] && [ "$OUT" = '{"treeFix":false}' ]; then
  ok "3: non-tree-fix commit reports treeFix=false rc=0"
else
  bad "3: rc=$RC out=$OUT"
fi

# ---------------------------------------------------------------------------
# TEST 4: Tree-Fix present but missing Chain + Mode -> malformed (rc 2).
# ---------------------------------------------------------------------------
run_stdin "x

Tree-Fix: owner/repo#1"
if [ "$RC" -eq 2 ]; then ok "4: incomplete trio rejected (rc 2)"; else bad "4: rc=$RC out=$OUT"; fi

# ---------------------------------------------------------------------------
# TEST 5: bad ticket format -> malformed (rc 2).
# ---------------------------------------------------------------------------
run_stdin "x

Tree-Fix: not-a-ticket
Tree-Fix-Chain: ${SHA40}
Tree-Fix-Mode: initial"
if [ "$RC" -eq 2 ]; then ok "5: bad ticket format rejected (rc 2)"; else bad "5: rc=$RC"; fi

# ---------------------------------------------------------------------------
# TEST 6: short (non-full) chain sha -> malformed (rc 2).
# ---------------------------------------------------------------------------
run_stdin "x

Tree-Fix: owner/repo#1
Tree-Fix-Chain: deadbeef
Tree-Fix-Mode: initial"
if [ "$RC" -eq 2 ]; then ok "6: short chain sha rejected (rc 2)"; else bad "6: rc=$RC"; fi

# ---------------------------------------------------------------------------
# TEST 7: invalid mode -> malformed (rc 2).
# ---------------------------------------------------------------------------
run_stdin "x

Tree-Fix: owner/repo#1
Tree-Fix-Chain: ${SHA40}
Tree-Fix-Mode: sideways"
if [ "$RC" -eq 2 ]; then ok "7: invalid mode rejected (rc 2)"; else bad "7: rc=$RC"; fi

# ---------------------------------------------------------------------------
# TEST 8: duplicate Tree-Fix trailer -> malformed (rc 2).
# ---------------------------------------------------------------------------
run_stdin "x

Tree-Fix: owner/repo#1
Tree-Fix: owner/repo#2
Tree-Fix-Chain: ${SHA40}
Tree-Fix-Mode: initial"
if [ "$RC" -eq 2 ]; then ok "8: duplicate Tree-Fix rejected (rc 2)"; else bad "8: rc=$RC"; fi

# ---------------------------------------------------------------------------
# TEST 9: stray Chain/Mode with no Tree-Fix -> malformed (rc 2).
# ---------------------------------------------------------------------------
run_stdin "x

Tree-Fix-Chain: ${SHA40}
Tree-Fix-Mode: initial"
if [ "$RC" -eq 2 ]; then ok "9: stray chain/mode without Tree-Fix rejected (rc 2)"; else bad "9: rc=$RC"; fi

# ---------------------------------------------------------------------------
# TEST 10: commit-ish mode (default HEAD) parses a real commit's trailers.
# ---------------------------------------------------------------------------
git commit -q --allow-empty -m "real fix

Tree-Fix: owner/repo#42
Tree-Fix-Chain: ${SHA40}
Tree-Fix-Mode: initial"
OUT="$("$TD" parse-tree-fix --json 2>"$ROOT/err")"; RC=$?
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q '"ticket":"owner/repo#42"'; then
  ok "10: commit-ish (HEAD) mode parses real commit trailers"
else
  bad "10: rc=$RC out=$OUT"
fi

# ---------------------------------------------------------------------------
# TEST 11: human (non-JSON) output for a tree-fix commit.
# ---------------------------------------------------------------------------
run_stdin "$MSG_OK"
if [ "$RC" -eq 0 ] \
   && printf '%s' "$OUT" | grep -q '^Tree-Fix: owner/repo#123$' \
   && printf '%s' "$OUT" | grep -q "^Tree-Fix-Chain: ${SHA40}$" \
   && printf '%s' "$OUT" | grep -q '^Tree-Fix-Mode: initial$'; then
  ok "11: human output prints the three trailers"
else
  bad "11: rc=$RC out=$OUT"
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
