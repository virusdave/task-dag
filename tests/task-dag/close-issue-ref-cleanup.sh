#!/usr/bin/env bash
# Fixture test for .github/scripts/cleanup-closed-issue-task-refs.sh — the
# blocked/frontier overlay cleanup that runs when a task-epic issue closes.
#
# Regression (FreshlyBakedNYC/automation#6): closing an epic retired only
# tasks/pending/<N> + tasks/root-active/<N>, never the tasks/blocked/<sha>
# overlay (+ blocked-meta) of a task belonging to that issue — most often the
# epic ROOT auto-parked by github-worker. So the closed issue lingered
# forever in the operator-blocked #29 dashboard, which rebuilds purely from
# live blocked refs.
#
# These tests build a throwaway bare "origin" + working clone (no network),
# seed blocked/frontier refs for two issues in this repo plus a cross-repo
# referencing block, then run the cleaner and assert:
#   - every blocked/blocked-meta/frontier ref for the closed issue is gone
#     (epic root, autoparked leaf, and a legacy no-meta block);
#   - a DIFFERENT issue's refs are untouched;
#   - a cross-repo block referencing the same issue number is untouched;
#   - re-running is idempotent (already-absent = success);
#   - the hint-SHA belt-and-braces path cleans the epic root by name.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
CLEANUP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.github/scripts" && pwd)/cleanup-closed-issue-task-refs.sh"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
if [ "$($TD migration-status --json | jq -r .mode)" = draining-legacy-writers ]; then
  "$TD" reconcile-closed-issue 1 --yes >/dev/null 2>&1; rc=$?
  [ "$rc" -eq 75 ] && { echo "PASS: legacy closed-issue cleanup integration is drained"; exit 0; }
  echo "FAIL: expected migration status 75, got $rc"; exit 1
fi

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_GIT_NAME=t TASK_DAG_GIT_EMAIL=t@t

REPO="acme/widgets"            # matches GITHUB_REPOSITORY passed to the cleaner
OTHER="other/thing"            # cross-repo referencing block; must survive

# The cleanup script delegates to reconcile-closed-issue, which fails safe by
# confirming the issue is CLOSED live. Keep the fixture hermetic with a fake
# gh whose state map marks only the issues this test closes as CLOSED.
GH_STATE_FILE="$ROOT/gh-state"
mkdir "$ROOT/bin"
cat > "$ROOT/bin/gh" <<'SH'
#!/usr/bin/env bash
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
    n="$3"
    st=$(awk -v n="$n" '$1==n{print $2; exit}' "$GH_STATE_FILE" 2>/dev/null)
    [ -n "$st" ] || { echo "gh: issue $n not found" >&2; exit 1; }
    echo "$st"
    exit 0
fi
echo "gh: unsupported args: $*" >&2; exit 1
SH
chmod +x "$ROOT/bin/gh"
export GH_STATE_FILE
PATH="$ROOT/bin:$PATH"; export PATH

cat > "$GH_STATE_FILE" <<EOF
42 CLOSED
55 CLOSED
EOF

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"; cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master
EMPTY_TREE=$(git mktree </dev/null)

# mk_task <issue> <repo> <type> <title-suffix>  -> prints the new task's full sha.
# Builds an empty-tree task commit (like create-task-commit.sh) whose body
# carries the Issue/URL trailers derive_task_origin reads.
mk_task() {
    local issue="$1" repo="$2" type="$3" suffix="$4"
    git commit-tree "$EMPTY_TREE" -p "$(git rev-parse HEAD)" -m "Task: T-$suffix

Issue: #${issue}
URL: https://github.com/${repo}/issues/${issue}
Author: tester
Status: pending
Type: ${type}"
}

remote_has() { git ls-remote origin "$1" | grep -q .; }

# ── Seed refs for the CLOSED issue 42 (repo acme/widgets) ──────────────────
E=$(mk_task 42 "$REPO" epic root)                     # epic root (blocked)
git push -q origin "$E:refs/heads/tasks/pending/42"
"$TD" block "$E" --operator --reason="agent abandoned claim" >/dev/null 2>&1

LA=$(mk_task 42 "$REPO" leaf leafA)                    # autoparked leaf w/ frontier
LA_SHORT=$(git rev-parse --short "$LA")
git push -q origin "$LA:refs/heads/tasks/frontier/$LA_SHORT"
"$TD" block "$LA" --operator --reason="awaiting operator" >/dev/null 2>&1

LC=$(mk_task 42 "$REPO" leaf legacy)                   # LEGACY block: overlay, NO meta
LC_SHORT=$(git rev-parse --short "$LC")
git push -q origin "$LC:refs/heads/tasks/frontier/$LC_SHORT" "$LC:refs/heads/tasks/blocked/$LC"

# ── Seed refs that MUST survive ────────────────────────────────────────────
LB=$(mk_task 99 "$REPO" leaf otherIssue)              # different issue, same repo
git push -q origin "$LB:refs/heads/tasks/frontier/$(git rev-parse --short "$LB")"
"$TD" block "$LB" --operator --reason="other issue" >/dev/null 2>&1

X=$(mk_task 42 "$OTHER" leaf crossRepo)               # SAME issue number, DIFFERENT repo
git push -q origin "$X:refs/heads/tasks/frontier/$(git rev-parse --short "$X")"
"$TD" block "$X" --operator --reason="cross-repo" >/dev/null 2>&1

# Sanity: everything is present before cleanup.
remote_has "refs/heads/tasks/blocked/$E"  && remote_has "refs/heads/tasks/blocked/$LA" \
    && remote_has "refs/heads/tasks/blocked/$LC" && remote_has "refs/heads/tasks/blocked/$LB" \
    && remote_has "refs/heads/tasks/blocked/$X" \
    && ok "0: all seed blocked refs present before cleanup" \
    || bad "0: seed setup incomplete"

# ── Run the cleaner for the closed issue 42 (pass epic root as hint) ───────
# A fresh clone == a real worker/CI checkout with no local task refs.
git clone -q "$ROOT/origin.git" "$ROOT/run"; cd "$ROOT/run"
GITHUB_REPOSITORY="$REPO" TASK_DAG_CLI="$TD" \
    bash "$CLEANUP" 42 "$E" > "$ROOT/out1.log" 2>&1
rc=$?
[ "$rc" = 0 ] && ok "1: cleaner exited 0" || { bad "1: cleaner exited $rc"; cat "$ROOT/out1.log"; }

# ── Assertions on origin ───────────────────────────────────────────────────
gone() { remote_has "$1" && bad "$2 ($1 still present)" || ok "$2"; }
kept() { remote_has "$1" && ok "$2" || bad "$2 ($1 missing)"; }

gone "refs/heads/tasks/blocked/$E"        "2: epic-root blocked overlay removed"
gone "refs/heads/tasks/blocked-meta/$E"   "3: epic-root blocked-meta removed"
gone "refs/heads/tasks/blocked/$LA"       "4: autoparked leaf blocked overlay removed"
gone "refs/heads/tasks/blocked-meta/$LA"  "5: autoparked leaf blocked-meta removed"
gone "refs/heads/tasks/frontier/$LA_SHORT" "6: autoparked leaf frontier removed (no zombie dispatch)"
gone "refs/heads/tasks/blocked/$LC"       "7: legacy (no-meta) block overlay removed"
gone "refs/heads/tasks/frontier/$LC_SHORT" "8: legacy block frontier removed"

kept "refs/heads/tasks/blocked/$LB"       "9: different issue's blocked overlay preserved"
kept "refs/heads/tasks/blocked/$X"        "10: cross-repo block (same issue #, other repo) preserved"

# ── Idempotency: a second run is a clean no-op ─────────────────────────────
GITHUB_REPOSITORY="$REPO" TASK_DAG_CLI="$TD" \
    bash "$CLEANUP" 42 "$E" > "$ROOT/out2.log" 2>&1
rc=$?
[ "$rc" = 0 ] && ok "11: re-running the cleaner is idempotent (exit 0)" \
    || { bad "11: idempotent re-run exited $rc"; cat "$ROOT/out2.log"; }

# ── CLI failure must be LOUD, not a silent empty sweep ─────────────────────
# Seed a fresh blocked ref for issue 55, then run with a CLI that always
# fails and no hint SHA: the enumeration must fail the run (exit 1) and NOT
# delete the ref (never silently coerce a CLI error into an empty list).
cd "$ROOT/wc"
S55=$(mk_task 55 "$REPO" leaf failCli)
git push -q origin "$S55:refs/heads/tasks/frontier/$(git rev-parse --short "$S55")"
"$TD" block "$S55" --operator --reason="cli-fail probe" >/dev/null 2>&1
cd "$ROOT/run"
GITHUB_REPOSITORY="$REPO" TASK_DAG_CLI="/bin/false" \
    bash "$CLEANUP" 55 > "$ROOT/out3.log" 2>&1
rc=$?
[ "$rc" = 1 ] && ok "12: a failing task-dag CLI makes the run exit 1 (loud)" \
    || { bad "12: failing CLI did not exit 1 (got $rc)"; cat "$ROOT/out3.log"; }
kept "refs/heads/tasks/blocked/$S55" "13: failing CLI did not silently delete the blocked ref"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
