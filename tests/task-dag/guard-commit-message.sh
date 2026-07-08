#!/usr/bin/env bash
# Fixture test for `task-dag guard-commit-message` (issue #7): the canonical
# check behind the per-repo commit-msg hook. Verifies it REJECTS hand-written
# commit messages carrying task-dag control-plane markers and ALLOWS ordinary
# implementation commits (including legit cross-repo trailers).
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

# reject <name> <message...>  — expect exit 1
reject() {
  local name="$1"; shift
  printf '%s\n' "$*" > "$ROOT/m"
  "$TD" guard-commit-message "$ROOT/m" >/dev/null 2>&1
  [ $? -eq 1 ] && ok "rejects $name" || bad "did NOT reject $name"
}
# allow <name> <message...>  — expect exit 0
allow() {
  local name="$1"; shift
  printf '%s\n' "$*" > "$ROOT/m"
  "$TD" guard-commit-message "$ROOT/m" >/dev/null 2>&1
  [ $? -eq 0 ] && ok "allows $name" || bad "wrongly rejected $name"
}

# ── reserved control markers → REJECT ───────────────────────────────
reject "Status: completed (fake completion)" \
"seo: enforce ads-policy lint

Task-Commit: 5e1860cc50cf8ddb46d0b51259f52ea69c2ed7f5
Status: completed"
reject "bare Task-Commit trailer"        "impl work
Task-Commit: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
reject "Closes-Epic trailer"             "close it
Closes-Epic: #46"
reject "Historical-Commit trailer"       "link it
Historical-Commit: abc123"
reject "Retroactive: true"               "retro
Retroactive: true"
reject "Blocked-Meta trailer"            "block it
Blocked-Meta: something"
reject "Type: leaf"                      "a task
Type: leaf"
reject "Task: subject (task commit)"     "Task: P5 enforce ads-policy lint"
reject "Status: pending"                 "new task
Status: pending"

# ── ordinary work → ALLOW ───────────────────────────────────────────
allow "plain impl commit"                "seo(faq): enforce ads-policy lint in approval gate"
allow "impl commit with Satisfies/Phase" \
"seo(faq): enforce ads-policy lint

Wire the scanner into the approval gate.

Phase: P5. Satisfies: virusdave/top-level#17.
Co-authored-by: Amp <amp@ampcode.com>"
allow "prose mentioning a task casually" \
"fix: handle the completed state in the UI

This renders the Status label when a task is completed."

# ── comment lines (git strips them) must NOT trigger ────────────────
allow "reserved marker only inside a # comment line" \
"chore: tidy

# Task-Commit: this line is a git comment and must be ignored
# Status: completed"

# ── long messages: no SIGPIPE→141 under pipefail, no missed markers ──
# A body far longer than any pipe buffer would, with a naive
# `printf | grep -q` / `head -1`, let the early-exiting reader SIGPIPE the
# producer and (under pipefail) flip the result. Marker on line 1 must
# still reject; a long marker-free body must cleanly allow (exit 0).
{ echo "impl work with a very long body"; echo "Task-Commit: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  for i in $(seq 1 5000); do echo "filler line $i lorem ipsum dolor sit amet"; done; } > "$ROOT/m"
"$TD" guard-commit-message "$ROOT/m" >/dev/null 2>&1
[ $? -eq 1 ] && ok "rejects marker even in a very long message" || bad "long message missed the marker (SIGPIPE/pipefail?)"
{ echo "seo: a perfectly ordinary but very long commit"; echo
  for i in $(seq 1 5000); do echo "filler line $i lorem ipsum dolor sit amet"; done; } > "$ROOT/m"
"$TD" guard-commit-message "$ROOT/m" >/dev/null 2>&1
[ $? -eq 0 ] && ok "allows a long marker-free message (no exit 141)" || bad "long marker-free message did not exit 0"

# ── a regex-special core.commentChar must not corrupt the filter ─────
# ']' is invalid inside a naive "^[$cc]" bracket expression; the guard must
# strip such comment lines literally, not fail open.
CC_REPO=$(mktemp -d)
git -C "$CC_REPO" init -q
git -C "$CC_REPO" config core.commentChar ']'
printf ']  Task-Commit: this is a comment, ignore it\nseo: real work\n' > "$CC_REPO/m"
( cd "$CC_REPO" && "$TD" guard-commit-message "$CC_REPO/m" >/dev/null 2>&1 )
[ $? -eq 0 ] && ok "special core.commentChar (']') strips comment, allows clean msg" || bad "special commentChar corrupted the filter"
printf 'seo: real work\n]  filler\nTask-Commit: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n' > "$CC_REPO/m"
( cd "$CC_REPO" && "$TD" guard-commit-message "$CC_REPO/m" >/dev/null 2>&1 )
[ $? -eq 1 ] && ok "special core.commentChar still rejects a real marker" || bad "special commentChar caused a false allow"
rm -rf "$CC_REPO"

# ── stdin + usage ───────────────────────────────────────────────────
printf 'impl\nCloses-Epic: #9\n' | "$TD" guard-commit-message --stdin >/dev/null 2>&1
[ $? -eq 1 ] && ok "rejects via --stdin" || bad "--stdin did not reject"
"$TD" guard-commit-message /no/such/file >/dev/null 2>&1
[ $? -eq 2 ] && ok "usage error (missing file) exits 2" || bad "missing file did not exit 2"

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
