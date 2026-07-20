#!/usr/bin/env bash
# Fixture test for `task-dag context` + fetch-before-resolve on the read
# commands (design docs/designs/task-dag-context-prefetch.md §3 Layer B,
# virusdave/top-level#42). Proves:
#   * a prepared/single-branch clone that LACKS the task object can still
#     inspect it via `context` (and via `show`/`deps`/`dag`, which now
#     fetch-before-resolve by default);
#   * `--no-fetch` deliberately skips the fetch (offline/stale inspection);
#   * `--ref` fetches exactly one ref, and an invalid `--ref` is rejected
#     BEFORE any refspec is built (no injection);
#   * ordering is fetch → verify → resolve (missing object => clear error).
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

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

# Two leaves: leaf2 depends on leaf1 (exercise dependency printing).
cat > "$ROOT/spec.json" <<'JSON'
[
  {"title":"First leaf","type":"leaf"},
  {"title":"Second leaf depends on first","type":"leaf","dependencies":["@1"]}
]
JSON
"$TD" claim-root 777 --force >/dev/null 2>&1
BREAKDOWN=$("$TD" breakdown "$EPIC" --spec-file="$ROOT/spec.json" --force --json 2>/dev/null)
LEAF1=$(echo "$BREAKDOWN" | grep -oE '"shortSha":"[0-9a-f]+"' | sed -n '1p' | cut -d'"' -f4)
LEAF2=$(echo "$BREAKDOWN" | grep -oE '"shortSha":"[0-9a-f]+"' | sed -n '2p' | cut -d'"' -f4)
LEAF2_FULL=$(git rev-parse "$LEAF2")

if [ -z "$LEAF1" ] || [ -z "$LEAF2" ]; then
  bad "setup: could not create two leaves (breakdown output: $BREAKDOWN)"
  echo "── $PASS passed, $FAIL failed ──"; [ "$FAIL" -eq 0 ]; exit
fi
# The leaf frontier ref name (namespace `frontier`, short sha component).
FRONTIER_REF="refs/heads/tasks/frontier/$LEAF2"
if git -C "$ROOT/wc" show-ref --verify --quiet "$FRONTIER_REF"; then
  ok "setup: leaf2 has a frontier ref on the source clone"
else
  # Fall back: discover whichever tasks/* ref points at LEAF2.
  FRONTIER_REF="refs/heads/$(git -C "$ROOT/wc" for-each-ref --format='%(refname:short)' --points-at "$LEAF2_FULL" | grep '^tasks/' | head -1)"
  ok "setup: located leaf2 task ref $FRONTIER_REF"
fi

# ── Prepared-workspace clone: single-branch master only (no tasks/*) ──
git clone -q --no-local --single-branch --branch master "$ROOT/origin.git" "$ROOT/prepared"
cd "$ROOT/prepared"

# Proves the problem: the task object is NOT present in this clone.
if git cat-file -e "${LEAF2_FULL}^{commit}" 2>/dev/null; then
  bad "precondition: task object unexpectedly already present in prepared clone"
else
  ok "precondition: task object missing in single-branch clone (the waste)"
fi

# `context` (fetch → verify → resolve) makes it work.
out=$("$TD" context "$LEAF2" 2>&1); rc=$?
if [ $rc -eq 0 ]; then ok "context: exit 0 in prepared clone"; else bad "context: failed (rc=$rc): $out"; fi
grep -q "Second leaf depends on first" <<<"$out" && ok "context: prints task title" || bad "context: missing title"
grep -q "First leaf" <<<"$out" && ok "context: prints dependency (leaf1) title" || bad "context: missing dependency"
grep -q "Suggested next commands" <<<"$out" && ok "context: prints suggested commands" || bad "context: missing suggestions"
grep -q "task-dag complete" <<<"$out" && ok "context: suggests complete" || bad "context: missing complete suggestion"
# After context, the object must be resolvable (prefetched into local).
if git cat-file -e "${LEAF2_FULL}^{commit}" 2>/dev/null; then
  ok "context: task object present locally afterwards"
else
  bad "context: object still missing after context"
fi

# ── fetch-before-resolve on show/deps/dag (fresh clone each) ──
for cmd in show deps dag; do
  rm -rf "$ROOT/p_$cmd"
  git clone -q --no-local --single-branch --branch master "$ROOT/origin.git" "$ROOT/p_$cmd"
  cd "$ROOT/p_$cmd"
  # --no-fetch must FAIL (object genuinely absent, no network allowed).
  if "$TD" "$cmd" "$LEAF2" --no-fetch >/dev/null 2>&1; then
    bad "$cmd --no-fetch: unexpectedly succeeded on a missing object"
  else
    ok "$cmd --no-fetch: fails on missing object (no fetch)"
  fi
  # default (fetch-before-resolve) must SUCCEED.
  if "$TD" "$cmd" "$LEAF2" >/dev/null 2>&1; then
    ok "$cmd: default fetch-before-resolve resolves the object"
  else
    bad "$cmd: default did not resolve the object"
  fi
done

# ── --ref exact fetch ──
rm -rf "$ROOT/p_ref"
git clone -q --no-local --single-branch --branch master "$ROOT/origin.git" "$ROOT/p_ref"
cd "$ROOT/p_ref"
out=$("$TD" context "$LEAF2" --ref "$FRONTIER_REF" 2>&1); rc=$?
if [ $rc -eq 0 ] && grep -q "Second leaf depends on first" <<<"$out"; then
  ok "context --ref: exact-ref fetch resolves the task"
else
  bad "context --ref: failed (rc=$rc): $out"
fi

# ── invalid --ref rejected before any fetch (no injection) ──
out=$("$TD" context "$LEAF2" --ref "tasks/foo:evil" 2>&1); rc=$?
if [ $rc -ne 0 ] && grep -qi "invalid --ref" <<<"$out"; then
  ok "context --ref: rejects a refspec-injection payload"
else
  bad "context --ref: did NOT reject an injection payload (rc=$rc): $out"
fi
out=$("$TD" context "$LEAF2" --ref "master" 2>&1); rc=$?
if [ $rc -ne 0 ] && grep -qi "invalid --ref" <<<"$out"; then
  ok "context --ref: rejects a non-tasks/* ref"
else
  bad "context --ref: accepted a non-tasks/* ref (rc=$rc): $out"
fi

# ── missing object after fetch => clear error (fetch → verify ordering) ──
cd "$ROOT/prepared"
out=$("$TD" context "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" 2>&1); rc=$?
if [ $rc -ne 0 ] && grep -qi "not present after fetch" <<<"$out"; then
  ok "context: clear error when the object cannot be resolved after fetch"
else
  bad "context: unclear behavior on unresolvable object (rc=$rc): $out"
fi

echo "── $PASS passed, $FAIL failed ──"
[ "$FAIL" -eq 0 ]
