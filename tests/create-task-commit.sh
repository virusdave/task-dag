#!/usr/bin/env bash
#
# Test the create-only behavior of .github/scripts/create-task-commit.sh
# (F2 of virusdave/top-level#22): an issue edit/reopen must NOT move the
# tasks/pending/<N> dispatch root (which would re-dispatch a worker), while
# the first sighting of an issue still creates the epic + both refs + one
# comment, and a missing gh/issues/<N> is backfilled without moving pending.
#
# Self-contained: a bare "origin", a working clone, and a `gh` stub on PATH.
# No network, no real GitHub.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/../.github/scripts/create-task-commit.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }
assert_eq()  { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1"; echo "        expected: [$2]"; echo "        actual:   [$3]"; fi; }
assert_ne()  { if [[ "$2" != "$3" ]]; then ok "$1"; else bad "$1"; echo "        both:     [$2]"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# gh stub: record each invocation (one line per call) so we can count
# "Task metadata commit:" comments.
GHLOG="$WORK/gh-calls.log"
mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$GHLOG"
exit 0
EOF
chmod +x "$WORK/bin/gh"
export PATH="$WORK/bin:$PATH"

# Bare origin + a working clone with a master HEAD commit.
git init -q --bare "$WORK/origin.git"
git clone -q "$WORK/origin.git" "$WORK/repo"
cd "$WORK/repo"
git config user.email t@t; git config user.name t
git commit -q --allow-empty -m "base"
git push -q origin HEAD:master

origin_ref_sha() { git ls-remote "$WORK/origin.git" "$1" | awk '{print $1}'; }

run_script() { # <issue> <title> <body>
    ISSUE_NUMBER="$1" ISSUE_TITLE="$2" ISSUE_BODY="$3" \
    ISSUE_AUTHOR="tester" ISSUE_URL="https://example/issues/$1" \
    GH_TOKEN="x" bash "$SCRIPT" >/dev/null
}

echo "== first-seen: creates epic + both refs + one comment =="
run_script 42 "My epic" "original body"
p1="$(origin_ref_sha refs/heads/tasks/pending/42)"
g1="$(origin_ref_sha refs/heads/gh/issues/42)"
if [[ -n "$p1" ]]; then ok "tasks/pending/42 created on origin"; else bad "tasks/pending/42 missing"; fi
assert_eq "gh/issues/42 == pending on first-seen" "$p1" "$g1"
assert_eq "exactly one gh comment posted" "1" "$(wc -l < "$GHLOG" | tr -d ' ')"

echo "== edit: pending root is NOT moved, no new comment =="
run_script 42 "My epic (edited title)" "EDITED body text"
p2="$(origin_ref_sha refs/heads/tasks/pending/42)"
assert_eq "tasks/pending/42 unchanged after edit (no re-dispatch SHA churn)" "$p1" "$p2"
assert_eq "still exactly one gh comment (none on edit)" "1" "$(wc -l < "$GHLOG" | tr -d ' ')"

echo "== reopen-style rerun: still no movement =="
run_script 42 "My epic" "original body"
p3="$(origin_ref_sha refs/heads/tasks/pending/42)"
assert_eq "tasks/pending/42 still unchanged on rerun" "$p1" "$p3"

echo "== backfill: missing gh/issues/<N> is restored without moving pending =="
git push -q origin --delete refs/heads/gh/issues/42
git update-ref -d refs/heads/gh/issues/42 2>/dev/null || true
if [[ -z "$(origin_ref_sha refs/heads/gh/issues/42)" ]]; then ok "gh/issues/42 removed (precondition)"; else bad "could not remove gh/issues/42"; fi
run_script 42 "My epic" "original body"
gb="$(origin_ref_sha refs/heads/gh/issues/42)"
p4="$(origin_ref_sha refs/heads/tasks/pending/42)"
assert_eq "gh/issues/42 backfilled to existing epic SHA" "$p1" "$gb"
assert_eq "pending still not moved during backfill" "$p1" "$p4"

echo "== a different, brand-new issue still gets created =="
run_script 99 "Second epic" "body two"
p99="$(origin_ref_sha refs/heads/tasks/pending/99)"
if [[ -n "$p99" ]]; then ok "tasks/pending/99 created for new issue"; else bad "tasks/pending/99 missing"; fi
assert_ne "issue 99 epic distinct from issue 42 epic" "$p99" "$p1"
assert_eq "second first-seen posted its own comment (2 total)" "2" "$(wc -l < "$GHLOG" | tr -d ' ')"

echo "== anomaly: gh/issues/<N> exists but pending missing -> fail closed, no recreate =="
# Manufacture the anomaly on origin for a fresh issue 55.
empty_tree="$(git mktree </dev/null)"
anomaly_commit="$(git commit-tree "$empty_tree" -p HEAD -m 'stray gh/issues epic')"
git push -q origin "$anomaly_commit:refs/heads/gh/issues/55"
comments_before="$(wc -l < "$GHLOG" | tr -d ' ')"
run_script 55 "Anomalous" "x"
if [[ -z "$(origin_ref_sha refs/heads/tasks/pending/55)" ]]; then
    ok "dispatch root NOT recreated when gh/issues exists but pending missing"
else bad "should not have created tasks/pending/55"; fi
assert_eq "no comment posted on anomaly path" "$comments_before" "$(wc -l < "$GHLOG" | tr -d ' ')"

echo "== mismatch: pending and gh/issues differ -> leave both, no movement =="
# issue 42: point gh/issues/42 at a different commit than pending/42.
other_commit="$(git commit-tree "$empty_tree" -p HEAD -m 'divergent gh ref')"
git push -q origin "+$other_commit:refs/heads/gh/issues/42"
run_script 42 "My epic" "body"
assert_eq "pending/42 unchanged under mismatch" "$p1" "$(origin_ref_sha refs/heads/tasks/pending/42)"
assert_eq "gh/issues/42 unchanged under mismatch" "$other_commit" "$(origin_ref_sha refs/heads/gh/issues/42)"

echo
echo "Passed: $PASS  Failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
