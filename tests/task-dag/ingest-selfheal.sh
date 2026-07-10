#!/usr/bin/env bash
# Fixture test for the epic self-heal helper _xrepo_ensure_issue_epic
# (virusdave/top-level#28), exercised through `ingest-comment`.
#
# When a human comment arrives on an issue that has NO epic ref (its
# first-sighting issue-to-task run never created one — e.g. the workflow
# was broken when the issue was opened, or the issue predates task-dag),
# ingest-comment used to die "no epic ref" and silently fail to dispatch a
# worker. It must now BACKFILL the epic (annotated as a backfill) and then
# mint the comment task normally, so nothing is lost. (Whether the task is
# actually dispatched for, say, a closed issue is the dispatcher's call,
# not task-dag's.)
set -uo pipefail
TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok(){ echo "PASS: $1"; PASS=$((PASS+1)); }
bad(){ echo "FAIL: $1"; FAIL=$((FAIL+1)); }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_GIT_NAME=t TASK_DAG_GIT_EMAIL=t@t

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"; cd "$ROOT/wc"
echo s>s; git add s; git commit -qm s; git push -q origin HEAD:master

remote_sha(){ git ls-remote origin "$1" 2>/dev/null | awk 'NR==1{print $1}'; }
frontier_count(){ git ls-remote origin "refs/heads/tasks/frontier/*" 2>/dev/null | wc -l; }

ingest(){  # $1=issue $2=comment_id $3=body
  printf '%s' "$3" > "$ROOT/body.txt"
  "$TD" ingest-comment --issue "$1" --comment-id "$2" --author virusdave \
    --comment-url "https://x/$2" --created-at 2026-01-02T03:04:05Z --updated-at 2026-01-02T03:04:05Z \
    --body-file "$ROOT/body.txt" >"$ROOT/out.txt" 2>&1
}

# Backfill metadata comes from the env the comment workflow exports.
export ISSUE_TITLE="Fix dependabot alerts"
export ISSUE_AUTHOR=virusdave
export ISSUE_URL="https://example/issues/14"
export ISSUE_BODY="Fix the vulnerabilities."

# ── Case 1: no epic ref → backfill epic + mint comment leaf ──
before_frontier=$(frontier_count)
ingest 14 1001 "ping? was this completed? if not, fix the vulnerabilities."
rc=$?
[ "$rc" -eq 0 ] || bad "self-heal ingest exited non-zero ($rc): $(cat "$ROOT/out.txt")"

p=$(remote_sha refs/heads/tasks/pending/14)
g=$(remote_sha refs/heads/gh/issues/14)
c=$(remote_sha refs/heads/gh/comments/14/1001)
after_frontier=$(frontier_count)

[ -n "$p" ] && ok "backfilled tasks/pending/14" || bad "tasks/pending/14 not created"
[ -n "$g" ] && ok "backfilled gh/issues/14"     || bad "gh/issues/14 not created"
[ "$p" = "$g" ] && ok "pending and gh/issues agree" || bad "pending ($p) != gh/issues ($g)"
[ -n "$c" ] && ok "comment provenance ref created" || bad "comment ref not created"
[ "$after_frontier" -eq $((before_frontier+1)) ] \
  && ok "comment leaf minted normally on top of the backfilled epic" \
  || bad "expected exactly one new frontier leaf (before=$before_frontier after=$after_frontier)"

# The backfilled epic must be self-documenting.
git fetch -q origin refs/heads/tasks/pending/14 2>/dev/null
if git log -1 --format='%B' "$p" 2>/dev/null | grep -q '^Backfilled: true$'; then
  ok "backfilled epic commit is annotated 'Backfilled: true'"
else
  bad "backfilled epic commit lacks the 'Backfilled: true' annotation"
fi
git log -1 --format='%B' "$p" 2>/dev/null | grep -q '^Type: epic$' \
  && ok "backfilled epic keeps the normal epic shape (Type: epic)" \
  || bad "backfilled epic missing 'Type: epic'"

# ── Case 2: idempotent re-run of the same comment ──
p_before="$p"; before_frontier=$(frontier_count)
ingest 14 1001 "ping? was this completed? if not, fix the vulnerabilities."
[ "$(remote_sha refs/heads/tasks/pending/14)" = "$p_before" ] \
  && ok "self-heal is idempotent on re-run (epic SHA unchanged)" \
  || bad "self-heal re-run changed the epic SHA"
[ "$(frontier_count)" -eq "$before_frontier" ] \
  && ok "re-run mints no second leaf (comment ref short-circuits)" \
  || bad "re-run minted an extra leaf"

# ── Case 3: a later, different comment now takes the normal path ──
before_frontier=$(frontier_count)
ingest 14 1002 "Also bump the lockfile please."
after_frontier=$(frontier_count)
[ "$after_frontier" -eq $((before_frontier+1)) ] \
  && ok "later comment on the now-healed issue mints a normal frontier leaf" \
  || bad "later comment did not mint a leaf (before=$before_frontier after=$after_frontier)"
[ "$(remote_sha refs/heads/tasks/pending/14)" = "$p_before" ] \
  && ok "later comment does NOT re-create or move the epic" \
  || bad "later comment moved the epic SHA"

# ── Case 4: cannot determine metadata → fail loud, write nothing ──
( unset ISSUE_TITLE ISSUE_AUTHOR ISSUE_URL ISSUE_BODY
  printf 'x' > "$ROOT/body2.txt"
  "$TD" ingest-comment --issue 55 --comment-id 5001 --author virusdave \
    --comment-url "https://x/5001" --created-at 2026-01-02T03:04:05Z --updated-at 2026-01-02T03:04:05Z \
    --body-file "$ROOT/body2.txt" >/dev/null 2>&1 )
rc=$?
# In a fixture repo with no real GitHub remote, the gh fallback yields no
# title, so the helper must die rather than write a junk epic.
[ "$rc" -ne 0 ] && ok "no metadata available → ingest fails loud (rc=$rc)" \
  || bad "ingest with no metadata unexpectedly succeeded"
[ -z "$(remote_sha refs/heads/tasks/pending/55)" ] \
  && ok "no junk epic written when metadata is unavailable" \
  || bad "a junk epic was written for #55 despite missing metadata"

echo "-----"; echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
