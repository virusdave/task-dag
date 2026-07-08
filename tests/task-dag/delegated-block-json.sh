#!/usr/bin/env bash
# Fixture test for `_xrepo_upsert_delegated_block` (scripts/task-dag.d/
# cross-repo.sh) — the helper that maintains the ```yaml delegated_to ...```
# block in an epic's GitHub issue body listing its cross-repo delegated
# children.
#
# The block payload is now serialized as JSON *inside* the ```yaml fence and
# managed entirely with jq (replacing an embedded python3 YAML parser). This
# test is the regression guard for that refactor. It asserts:
#   1. insert into an empty body produces a valid-JSON block;
#   2. inserting into a non-empty body with no block appends one;
#   3. upsert of an existing (repo,issue) updates in place (idempotently);
#   4. a second repo sorts deterministically by (repo,issue);
#   5. a legacy python-rendered YAML block is read and re-rendered without
#      losing entries (one-time compatibility path);
#   6. the issue body OUTSIDE the fence is preserved byte-for-byte, including
#      a missing final newline;
#   7. an adversarial note (newline, colon, double-quote, backslash, and a
#      line that looks like `  - repo: evil`) does NOT inject a new entry and
#      round-trips verbatim;
#   8. a leading-zero issue argument is normalised (matches old python int());
#   9. a malformed pre-existing entry fails loudly rather than silently
#      corrupting the block.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
CROSS_REPO="$(dirname "$TD")/task-dag.d/cross-repo.sh"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

command -v jq >/dev/null 2>&1 || { echo "jq is required for this test"; echo "PASS=0 FAIL=1"; exit 1; }

# Source the module directly to unit-test the internal helper. cross-repo.sh
# only defines functions at source time (it does not run `main`).
# shellcheck source=/dev/null
source "$CROSS_REPO"

# Extract the JSON payload out of the rendered ```yaml block of a body file.
block_json() { sed -n '/^```yaml$/,/^```$/p' "$1" | sed '1d;$d'; }

# --- 1. insert into empty body -------------------------------------------
: > "$ROOT/in1"
_xrepo_upsert_delegated_block "$ROOT/in1" "$ROOT/out1" "owner/repo" "123" "hello"
if block_json "$ROOT/out1" | jq -e . >/dev/null 2>&1; then
  ok "1: block is valid JSON"
else
  bad "1: block is not valid JSON"; cat "$ROOT/out1"
fi
GOT=$(block_json "$ROOT/out1" | jq -c '.delegated_to')
[ "$GOT" = '[{"repo":"owner/repo","issue":123,"note":"hello"}]' ] \
  && ok "1: entry rendered correctly" \
  || bad "1: got $GOT"

# --- 2. non-empty body, no block -> append -------------------------------
printf 'Title\n\nSome text.\n' > "$ROOT/in2"
_xrepo_upsert_delegated_block "$ROOT/in2" "$ROOT/out2" "owner/repo" "5" ""
if head -3 "$ROOT/out2" | grep -qx 'Title'; then
  ok "2: original body retained"
else
  bad "2: original body lost"; cat "$ROOT/out2"
fi
GOT=$(block_json "$ROOT/out2" | jq -c '.delegated_to')
[ "$GOT" = '[{"repo":"owner/repo","issue":5}]' ] \
  && ok "2: empty note omitted" \
  || bad "2: got $GOT"

# --- 3. upsert existing (repo,issue) in place, idempotently --------------
_xrepo_upsert_delegated_block "$ROOT/out2" "$ROOT/out3" "owner/repo" "5" "updated"
GOT=$(block_json "$ROOT/out3" | jq -c '.delegated_to')
[ "$GOT" = '[{"repo":"owner/repo","issue":5,"note":"updated"}]' ] \
  && ok "3: existing entry updated in place (no duplicate)" \
  || bad "3: got $GOT"
_xrepo_upsert_delegated_block "$ROOT/out3" "$ROOT/out3b" "owner/repo" "5" "updated"
cmp -s "$ROOT/out3" "$ROOT/out3b" \
  && ok "3: repeat upsert is byte-idempotent" \
  || { bad "3: not idempotent"; diff "$ROOT/out3" "$ROOT/out3b"; }

# --- 4. second repo sorts by (repo,issue) --------------------------------
_xrepo_upsert_delegated_block "$ROOT/out3" "$ROOT/out4" "aaa/zzz" "9" ""
GOT=$(block_json "$ROOT/out4" | jq -c '[.delegated_to[].repo]')
[ "$GOT" = '["aaa/zzz","owner/repo"]' ] \
  && ok "4: entries sorted by repo" \
  || bad "4: got $GOT"

# --- 5. legacy python-rendered YAML block is read + re-rendered ----------
cat > "$ROOT/in5" <<'BODY'
Header line

```yaml
delegated_to:
  - repo: b/two
    issue: 22
    note: legacy note
  - repo: a/one
    issue: 11
```

Footer line
BODY
_xrepo_upsert_delegated_block "$ROOT/in5" "$ROOT/out5" "c/three" "33" ""
GOT=$(block_json "$ROOT/out5" | jq -c '.delegated_to')
WANT='[{"repo":"a/one","issue":11},{"repo":"b/two","issue":22,"note":"legacy note"},{"repo":"c/three","issue":33}]'
[ "$GOT" = "$WANT" ] \
  && ok "5: legacy entries preserved, new entry merged + sorted" \
  || bad "5: got $GOT"
if block_json "$ROOT/out5" | jq -e 'type=="object"' >/dev/null 2>&1; then
  ok "5: legacy block rewritten to canonical JSON form"
else
  bad "5: block not rewritten to JSON"
fi
[ "$(head -1 "$ROOT/out5")" = "Header line" ] && [ "$(tail -1 "$ROOT/out5")" = "Footer line" ] \
  && ok "5: surrounding body preserved" \
  || bad "5: surrounding body altered"

# --- 6. outside-body bytes (incl. missing final newline) preserved -------
printf 'PRE one\nPRE two\n\n```yaml\n{\n  "delegated_to": [\n    {\n      "repo": "a/a",\n      "issue": 1\n    }\n  ]\n}\n```\n\nPOST one\nPOST two-no-nl' > "$ROOT/in6"
_xrepo_upsert_delegated_block "$ROOT/in6" "$ROOT/out6" "z/z" "2" ""
# prefix up to (not incl) the opening fence
awk '/^```yaml[[:space:]]*$/{exit} {print}' "$ROOT/in6"  > "$ROOT/pre_in"
awk '/^```yaml[[:space:]]*$/{exit} {print}' "$ROOT/out6" > "$ROOT/pre_out"
cmp -s "$ROOT/pre_in" "$ROOT/pre_out" \
  && ok "6: prefix preserved byte-for-byte" \
  || bad "6: prefix altered"
# suffix after the closing fence line
sufx() { awk 'f{print} /^```[[:space:]]*$/{f=1}' "$1"; }
sufx "$ROOT/in6"  > "$ROOT/suf_in"
sufx "$ROOT/out6" > "$ROOT/suf_out"
cmp -s "$ROOT/suf_in" "$ROOT/suf_out" \
  && ok "6: suffix preserved byte-for-byte" \
  || bad "6: suffix altered"
[ -n "$(tail -c1 "$ROOT/out6")" ] \
  && ok "6: missing final newline preserved" \
  || bad "6: a trailing newline was added"

# --- 7. adversarial note: no injection, verbatim round-trip --------------
printf 'x\n' > "$ROOT/in7"
ADV=$'evil\n  - repo: injected/repo\n    issue: 999\nend: "quote\\back'
_xrepo_upsert_delegated_block "$ROOT/in7" "$ROOT/out7" "safe/repo" "1" "$ADV"
N=$(block_json "$ROOT/out7" | jq '.delegated_to | length')
[ "$N" = "1" ] \
  && ok "7: adversarial note did not inject a new entry" \
  || bad "7: entry count is $N (want 1)"
GOTNOTE=$(block_json "$ROOT/out7" | jq -r '.delegated_to[0].note')
[ "$GOTNOTE" = "$ADV" ] \
  && ok "7: adversarial note round-trips verbatim" \
  || { bad "7: note mismatch"; printf 'got:  %q\nwant: %q\n' "$GOTNOTE" "$ADV"; }

# --- 8. leading-zero issue normalised ------------------------------------
: > "$ROOT/in8"
_xrepo_upsert_delegated_block "$ROOT/in8" "$ROOT/out8" "o/r" "007" "x"
GOT=$(block_json "$ROOT/out8" | jq -c '.delegated_to[0].issue')
[ "$GOT" = "7" ] \
  && ok "8: leading-zero issue normalised to integer" \
  || bad "8: got $GOT"

# --- 9. malformed pre-existing entry fails loudly ------------------------
printf '```yaml\n{"delegated_to":[{"repo":123,"issue":"x"}]}\n```\n' > "$ROOT/in9"
if _xrepo_upsert_delegated_block "$ROOT/in9" "$ROOT/out9" "o/r" "1" "" 2>/dev/null; then
  bad "9: malformed entry did not error"
else
  ok "9: malformed pre-existing entry fails loudly"
fi

# --- 10. legacy entry missing required repo fails closed -----------------
cat > "$ROOT/in10" <<'BODY'
```yaml
delegated_to:
  - issue: 123
  - repo: keep/repo
    issue: 1
```
BODY
if _xrepo_upsert_delegated_block "$ROOT/in10" "$ROOT/out10" "o/r" "2" "" 2>/dev/null; then
  bad "10: legacy entry missing repo did not error"
else
  ok "10: legacy entry missing required repo fails closed"
fi

# --- 11. legacy entry with duplicate key fails closed --------------------
cat > "$ROOT/in11" <<'BODY'
```yaml
delegated_to:
  - repo: a/one
    repo: b/two
    issue: 1
```
BODY
if _xrepo_upsert_delegated_block "$ROOT/in11" "$ROOT/out11" "o/r" "2" "" 2>/dev/null; then
  bad "11: legacy duplicate key did not error"
else
  ok "11: legacy duplicate key fails closed"
fi

# --- 12. unclosed delegated fence fails closed (no split-brain append) ---
printf 'body\n\n```yaml\ndelegated_to:\n  - repo: a/one\n    issue: 1\n' > "$ROOT/in12"
if _xrepo_upsert_delegated_block "$ROOT/in12" "$ROOT/out12" "o/r" "2" "" 2>/dev/null; then
  bad "12: unclosed delegated fence did not error"
else
  ok "12: unclosed delegated fence fails closed"
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
