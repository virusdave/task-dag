#!/usr/bin/env bash
# Fixture test for the master-derived close projection backstop: when the
# push-range close-completed workflow was missed, a schedule/manual run with no
# BEFORE_SHA re-derives sanctioned Closes-Epic facts from master, closes the
# GitHub issue, and cleans stale task refs idempotently.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
case "$TD" in
    /*) ;;
    *) TD="$(pwd)/$TD" ;;
esac
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_GIT_NAME=t TASK_DAG_GIT_EMAIL=t@t

REPO="virusdave/task-dag"
REPO_ROOT="$(cd "$(dirname "$TD")/.." && pwd)"
CLOSE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.github/scripts/close-completed-issues.sh"
CLEANUP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.github/scripts/cleanup-closed-issue-task-refs.sh"
EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"

# Fake gh: enough of issue close/view for close-completed-issues.sh and the
# delegated reconcile-closed-issue cleanup. State is durable in $GH_STATE_DIR.
mkdir -p "$ROOT/bin" "$ROOT/gh-state"
cat > "$ROOT/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
state_file() { printf '%s/%s.state' "$GH_STATE_DIR" "$1"; }
if [ "$1" = issue ] && [ "$2" = close ]; then
    n="$3"
    printf '%s\n' "$*" >> "$GH_STATE_DIR/close-attempts"
    [ "${GH_CLOSE_FAIL:-0}" = 0 ] || exit 1
    echo CLOSED > "$(state_file "$n")"
    printf '%s\n' "$*" >> "$GH_STATE_DIR/close-calls"
    exit 0
fi
if [ "$1" = issue ] && [ "$2" = view ]; then
    n="$3"; jqexpr=""
    while [ $# -gt 0 ]; do
        if [ "$1" = --jq ]; then jqexpr="${2:-}"; break; fi
        shift
    done
    case "$jqexpr" in
        .state) cat "$(state_file "$n")" ;;
        .author.login)
            if [ "${GH_MOVE_ACTIVATION_ON_AUTHOR:-0}" = 1 ]; then
                git push -q origin --delete refs/heads/tasks/v1/activation
            fi
            echo tester
            ;;
        .url) echo "https://github.com/virusdave/task-dag/issues/$n" ;;
        *) echo "gh fixture: unsupported jq '$jqexpr'" >&2; exit 1 ;;
    esac
    exit 0
fi
echo "gh fixture: unsupported args: $*" >&2
exit 1
SH
chmod +x "$ROOT/bin/gh"
export GH_STATE_DIR="$ROOT/gh-state"
PATH="$ROOT/bin:$PATH"; export PATH
echo OPEN > "$GH_STATE_DIR/42.state"

remote_has() { git ls-remote origin "$1" | grep -q .; }
remote_snapshot() { git ls-remote --refs origin | LC_ALL=C sort; }
projection_target_snapshot() { git ls-remote --refs origin 'refs/heads/tasks/*' 'refs/heads/gh/*' \
  | awk '$2!="refs/heads/tasks/v1/activation"' | LC_ALL=C sort; }
close_attempt_count() { [ -f "$GH_STATE_DIR/close-attempts" ] && wc -l <"$GH_STATE_DIR/close-attempts" || echo 0; }

git init -q --bare "$ROOT/origin.git"
git clone -q "$REPO_ROOT" "$ROOT/wc"
cd "$ROOT/wc" || exit 1
git remote set-url origin "$ROOT/origin.git"
git config taskdag.current-repo "$REPO"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master
activation_tip="$(git -C "$REPO_ROOT" ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')"
git -C "$REPO_ROOT" fetch -q origin "$activation_tip"
git -C "$REPO_ROOT" push -q "$ROOT/origin.git" "FETCH_HEAD:refs/heads/tasks/v1/activation"

ROOT_TASK=$(git commit-tree "$EMPTY_TREE" -p "$(git rev-parse HEAD)" -m "Task: root

Issue: #42
URL: https://github.com/${REPO}/issues/42
Author: tester
Status: pending
Type: epic")
LEAF=$(git commit-tree "$EMPTY_TREE" -p "$ROOT_TASK" -m "Task: stale leaf

Issue: #42
URL: https://github.com/${REPO}/issues/42
Author: tester
Status: pending
Type: leaf")
LEAF_SHORT=$(git rev-parse --short "$LEAF")
BLOCKED_META=$(git commit-tree "$EMPTY_TREE" -p "$LEAF" -m "Blocked-Meta: stale leaf

Task-Commit: $LEAF
Blocker-Kind: downstream
Reason: fixture
Repo: $REPO
Issue: #42
Blocked-By: fixture
Blocked-Host: fixture
Blocked-At: 2026-07-26T00:00:00Z")
ACTIVE_TASK=$(git commit-tree "$EMPTY_TREE" -p "$ROOT_TASK" -m "Task: live worker

Issue: #42
URL: https://github.com/${REPO}/issues/42
Author: tester
Status: pending
Type: leaf")
ACTIVE_SHORT=$(git rev-parse --short "$ACTIVE_TASK")
ACTIVE_CLAIM=$(git commit-tree "$EMPTY_TREE" -p "$ACTIVE_TASK" -m "Claim: live worker

Task-Commit: $ACTIVE_TASK
Claimer: fixture
Claimer-Host: fixture
Claimer-PID: 1
Claimed-At: 2026-07-26T00:00:00Z
TTL-Hours: 12")
git push -q origin \
    "$ROOT_TASK:refs/heads/gh/issues/42" \
    "$ROOT_TASK:refs/heads/tasks/pending/42" \
    "$ROOT_TASK:refs/heads/tasks/root-active/42" \
    "$LEAF:refs/heads/tasks/frontier/$LEAF_SHORT" \
    "$LEAF:refs/heads/tasks/blocked/$LEAF" \
    "$BLOCKED_META:refs/heads/tasks/blocked-meta/$LEAF" \
    "$ACTIVE_CLAIM:refs/heads/tasks/active/$ACTIVE_SHORT"

# Land the durable master close fact, but intentionally do NOT run the push
# close workflow. This leaves GitHub OPEN and refs stale until the backstop.
tip=$(git rev-parse HEAD); tree=$(git rev-parse "${tip}^{tree}")
CLOSE_SHA=$(git commit-tree "$tree" -p "$tip" -p "$ROOT_TASK" -m "Close epic #42

All task-dag obligations for this epic are satisfied.

Closes-Epic: #42")
git update-ref refs/heads/master "$CLOSE_SHA"
git push -q origin master:master

git clone -q "$ROOT/origin.git" "$ROOT/run"
cd "$ROOT/run" || exit 1
git config taskdag.current-repo "$REPO"

# Projection is fail-closed and mutation-free without enabled activation.
git push -q origin --delete refs/heads/tasks/v1/activation
refs_before=$(remote_snapshot)
out=$(env -u BEFORE_SHA -u AFTER_SHA \
    GH_TOKEN=dummy GITHUB_REPOSITORY="$REPO" \
    CLEANUP_REFS_SCRIPT="$CLEANUP" TASK_DAG_CLI="$TD" \
    bash "$CLOSE" 2>&1); rc=$?
[ "$rc" -ne 0 ] && [ "$(cat "$GH_STATE_DIR/42.state")" = OPEN ] \
  && [ ! -e "$GH_STATE_DIR/close-attempts" ] \
  && [ "$refs_before" = "$(remote_snapshot)" ] \
  && remote_has "refs/heads/tasks/pending/42" \
  && ok "A1: absent activation refuses without projection effects" \
  || bad "A1: absent activation rc=$rc out=$out"
git push -q origin "$activation_tip:refs/heads/tasks/v1/activation"

# Authority movement after discovery but before the CLI's pre-close prepare
# must prevent any GitHub mutation and preserve every task target ref.
cat >"$ROOT/bin/td-race" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = completed-issue-projection-list ]; then
    "$REAL_TD" "$@"
    git push -q origin --delete refs/heads/tasks/v1/activation
else
    "$REAL_TD" "$@"
fi
SH
chmod +x "$ROOT/bin/td-race"
task_refs_before=$(projection_target_snapshot)
attempts_before=$(close_attempt_count)
out=$(env -u BEFORE_SHA -u AFTER_SHA REAL_TD="$TD" \
    GH_TOKEN=dummy GITHUB_REPOSITORY="$REPO" TASK_DAG_CLI="$ROOT/bin/td-race" \
    bash "$CLOSE" 2>&1); rc=$?
attempts_after=$(close_attempt_count)
[ "$rc" -ne 0 ] && [ "$attempts_before" = "$attempts_after" ] \
  && [ "$task_refs_before" = "$(projection_target_snapshot)" ] \
  && ok "A1b: activation movement before close is mutation-free" \
  || bad "A1b: activation race rc=$rc out=$out"
git push -q origin "$activation_tip:refs/heads/tasks/v1/activation"

# Movement during pre-close comment preparation is caught by the immediately
# following canonical prepare, before any close attempt.
task_refs_before=$(projection_target_snapshot)
attempts_before=$(close_attempt_count)
out=$(env -u BEFORE_SHA -u AFTER_SHA GH_MOVE_ACTIVATION_ON_AUTHOR=1 \
    GH_TOKEN=dummy GITHUB_REPOSITORY="$REPO" TASK_DAG_CLI="$TD" \
    bash "$CLOSE" 2>&1); rc=$?
attempts_after=$(close_attempt_count)
[ "$rc" -ne 0 ] && [ "$attempts_before" = "$attempts_after" ] \
  && [ "$task_refs_before" = "$(projection_target_snapshot)" ] \
  && ok "A1c: activation movement during author lookup prevents close" \
  || bad "A1c: author-lookup activation race rc=$rc out=$out"
git push -q origin "$activation_tip:refs/heads/tasks/v1/activation"

# A GitHub close failure must preserve every task identity/scheduling ref.
refs_before=$(remote_snapshot)
out=$(env -u BEFORE_SHA -u AFTER_SHA GH_CLOSE_FAIL=1 \
    GH_TOKEN=dummy GITHUB_REPOSITORY="$REPO" \
    CLEANUP_REFS_SCRIPT="$CLEANUP" TASK_DAG_CLI="$TD" \
    bash "$CLOSE" 2>&1); rc=$?
[ "$rc" -ne 0 ] && [ "$refs_before" = "$(remote_snapshot)" ] \
  && [ "$(cat "$GH_STATE_DIR/42.state")" = OPEN ] \
  && remote_has "refs/heads/tasks/root-active/42" \
  && remote_has "refs/heads/tasks/frontier/$LEAF_SHORT" \
  && ok "A2: GitHub close failure preserves task refs" \
  || bad "A2: close failure rc=$rc out=$out"

# A rejected atomic fenced push may leave GitHub closed, but it must leave the
# complete task-ref/activation snapshot unchanged for an idempotent retry.
cat >"$ROOT/origin.git/hooks/pre-receive" <<'SH'
#!/usr/bin/env bash
cat >/dev/null
exit 1
SH
chmod +x "$ROOT/origin.git/hooks/pre-receive"
refs_before=$(remote_snapshot)
out=$(env -u BEFORE_SHA -u AFTER_SHA \
    GH_TOKEN=dummy GITHUB_REPOSITORY="$REPO" TASK_DAG_CLI="$TD" \
    bash "$CLOSE" 2>&1); rc=$?
[ "$rc" -ne 0 ] && [ "$(cat "$GH_STATE_DIR/42.state")" = CLOSED ] \
  && [ "$refs_before" = "$(remote_snapshot)" ] \
  && ok "A3: rejected fenced push is atomic and retryable" \
  || bad "A3: rejected fenced push rc=$rc out=$out"
rm -f "$ROOT/origin.git/hooks/pre-receive"

out=$(env -u BEFORE_SHA -u AFTER_SHA GH_CLOSE_FAIL=1 \
    GH_TOKEN=dummy GITHUB_REPOSITORY="$REPO" \
    CLEANUP_REFS_SCRIPT="$CLEANUP" TASK_DAG_CLI="$TD" \
    bash "$CLOSE" 2>&1); rc=$?
if [ "$rc" = 0 ]; then ok "B1: completed projection exits 0"; else bad "B1: rc=$rc out=$out"; fi
[ "$(cat "$GH_STATE_DIR/42.state")" = CLOSED ] && ok "B2: projection closed the open GitHub issue" || bad "B2: issue state not CLOSED"
remote_has "refs/heads/tasks/pending/42"      && bad "B3: pending ref survived"     || ok "B3: pending ref deleted"
remote_has "refs/heads/tasks/root-active/42"  && bad "B4: root-active survived"     || ok "B4: root-active ref deleted"
remote_has "refs/heads/tasks/frontier/$LEAF_SHORT" && bad "B5: frontier survived"   || ok "B5: stale frontier ref deleted"
remote_has "refs/heads/tasks/blocked/$LEAF"   && bad "B6: blocked overlay survived" || ok "B6: stale blocked overlay deleted"
remote_has "refs/heads/tasks/blocked-meta/$LEAF" && bad "B7: blocked metadata survived" || ok "B7: stale blocked metadata deleted"
[ "$(git ls-remote origin "refs/heads/tasks/active/$ACTIVE_SHORT" | awk '{print $1}')" = "$ACTIVE_CLAIM" ] \
  && ok "B8: active claim was preserved exactly" || bad "B8: active claim changed"
[ "$(git ls-remote origin refs/heads/gh/issues/42 | awk '{print $1}')" = "$ROOT_TASK" ] \
  && ok "B9: durable issue identity was preserved exactly" || bad "B9: issue identity changed"

git clone -q "$ROOT/origin.git" "$ROOT/run2"
cd "$ROOT/run2" || exit 1
git config taskdag.current-repo "$REPO"
facts=$($TD completed-issue-projection-list --json); rc=$?
[ "$rc" = 0 ] && jq -e --argjson issue 42 --arg root "$ROOT_TASK" --arg close "$CLOSE_SHA" \
  'length==1 and .[0]=={issue:$issue,closeCommit:$close,root:$root}' <<<"$facts" >/dev/null \
  && ok "C1: fresh clone rediscovered the exact close fact" || bad "C1: fresh-clone facts=$facts"
attempts_before=$(close_attempt_count)
out=$(env -u BEFORE_SHA -u AFTER_SHA \
    GH_TOKEN=dummy GITHUB_REPOSITORY="$REPO" \
    CLEANUP_REFS_SCRIPT="$CLEANUP" TASK_DAG_CLI="$TD" \
    bash "$CLOSE" 2>&1); rc=$?
attempts_after=$(close_attempt_count)
[ "$rc" = 0 ] && [ "$attempts_after" -eq $((attempts_before + 1)) ] \
  && ok "C2: rediscovered fact was projected idempotently" || { bad "C2: rc=$rc out=$out"; }

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
