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

echo "== block-at-birth: labeled first-seen creates pending+gh+blocked atomically =="
# Use the repo's own CLI for hermetic meta enrichment (no network download).
export TASK_DAG_CLI="$SCRIPT_DIR/../scripts/task-dag"
ISSUE_LABELS="feature,blocked-at-birth,p2" run_script 77 "Blocked epic" "body"
p77="$(origin_ref_sha refs/heads/tasks/pending/77)"
g77="$(origin_ref_sha refs/heads/gh/issues/77)"
b77="$(origin_ref_sha "refs/heads/tasks/blocked/$p77")"
if [[ -n "$p77" ]]; then ok "tasks/pending/77 created for labeled issue"; else bad "tasks/pending/77 missing"; fi
assert_eq "gh/issues/77 == pending on first-seen" "$p77" "$g77"
assert_eq "blocked overlay points at epic SHA (blocked at birth)" "$p77" "$b77"
m77="$(origin_ref_sha "refs/heads/tasks/blocked-meta/$p77")"
if [[ -n "$m77" ]]; then ok "blocked-meta/77 created by canonical-CLI enrichment"; else bad "blocked-meta/77 missing"; fi

echo "== case-insensitive label match =="
ISSUE_LABELS="Blocked-At-Birth" run_script 88 "Case epic" "body"
p88="$(origin_ref_sha refs/heads/tasks/pending/88)"
b88="$(origin_ref_sha "refs/heads/tasks/blocked/$p88")"
assert_eq "blocked overlay created for mixed-case label" "$p88" "$b88"

echo "== unlabeled first-seen is NOT blocked =="
ISSUE_LABELS="feature,something-else" run_script 78 "Normal epic" "body"
p78="$(origin_ref_sha refs/heads/tasks/pending/78)"
b78="$(origin_ref_sha "refs/heads/tasks/blocked/$p78")"
if [[ -n "$p78" && -z "$b78" ]]; then ok "no blocked overlay for unlabeled issue"; else bad "unexpected blocked overlay for unlabeled issue"; fi

echo "== edit after unblock stays unblocked (stale label must not re-block) =="
# Simulate operator unblock: remove the overlay + meta on origin.
git push -q origin --delete "refs/heads/tasks/blocked/$p77" 2>/dev/null || true
git push -q origin --delete "refs/heads/tasks/blocked-meta/$p77" 2>/dev/null || true
if [[ -z "$(origin_ref_sha "refs/heads/tasks/blocked/$p77")" ]]; then ok "epic 77 unblocked (precondition)"; else bad "could not unblock epic 77"; fi
# Re-run with the label STILL present (edit/reopen); create-only must no-op.
ISSUE_LABELS="blocked-at-birth" run_script 77 "Blocked epic (edited title)" "new body"
p77b="$(origin_ref_sha refs/heads/tasks/pending/77)"
b77b="$(origin_ref_sha "refs/heads/tasks/blocked/$p77b")"
assert_eq "pending/77 unchanged on edit after unblock" "$p77" "$p77b"
if [[ -z "$b77b" ]]; then ok "edit after unblock did NOT re-block (create-only)"; else bad "stale label re-blocked an unblocked epic"; fi
unset TASK_DAG_CLI

echo
echo "Passed: $PASS  Failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
