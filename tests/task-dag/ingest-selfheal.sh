#!/usr/bin/env bash
# Fixture test for cmd_ingest_comment epic self-heal (virusdave/top-level#28).
#
# When a human comment arrives on an issue that has NO epic ref (its
# first-sighting issue-to-task run never created one — e.g. the workflow was
# broken when the issue was opened, or the issue predates task-dag),
# ingest-comment used to die "no epic ref" and silently fail to dispatch a
# worker. It must now self-heal by backfilling the epic — but only for OPEN
# issues, and without minting a comment frontier leaf (the epic root is the
# dispatch unit).
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
    --comment-url "https://x/$2" --body-file "$ROOT/body.txt" >"$ROOT/out.txt" 2>&1
}

# ── Case 1: OPEN issue, no epic ref → backfill epic, NO frontier leaf ──
export ISSUE_STATE=open
export ISSUE_TITLE="Fix dependabot alerts"
export ISSUE_AUTHOR=virusdave
export ISSUE_URL="https://example/issues/14"
export ISSUE_BODY="Fix the vulnerabilities."

before_frontier=$(frontier_count)
ingest 14 1001 "ping? was this completed? if not, fix the vulnerabilities."
rc=$?
[ "$rc" -eq 0 ] || bad "self-heal ingest exited non-zero ($rc): $(cat "$ROOT/out.txt")"

p=$(remote_sha refs/heads/tasks/pending/14)
g=$(remote_sha refs/heads/gh/issues/14)
c=$(remote_sha refs/heads/gh/comments/14/1001)
after_frontier=$(frontier_count)

[ -n "$p" ] && ok "open issue: backfilled tasks/pending/14" || bad "open issue: tasks/pending/14 not created"
[ -n "$g" ] && ok "open issue: backfilled gh/issues/14"     || bad "open issue: gh/issues/14 not created"
[ "$p" = "$g" ] && ok "open issue: pending and gh/issues agree" || bad "open issue: pending ($p) != gh/issues ($g)"
[ "$c" = "$p" ] && ok "open issue: comment provenance ref points at epic" || bad "open issue: comment ref ($c) != epic ($p)"
[ "$after_frontier" -eq "$before_frontier" ] \
  && ok "open issue: no comment frontier leaf minted (epic root is the dispatch unit)" \
  || bad "open issue: a frontier leaf was minted (before=$before_frontier after=$after_frontier)"

# Re-run the same comment: idempotent no-op (no new epic commit, no leaf).
p_before="$p"
ingest 14 1001 "ping? was this completed? if not, fix the vulnerabilities."
[ "$(remote_sha refs/heads/tasks/pending/14)" = "$p_before" ] \
  && ok "self-heal is idempotent on re-run (epic SHA unchanged)" \
  || bad "self-heal re-run changed the epic SHA"

# A NEW comment now that the epic exists takes the normal path → mints a leaf.
before_frontier=$(frontier_count)
ingest 14 1002 "Also bump the lockfile please."
after_frontier=$(frontier_count)
[ "$after_frontier" -eq $((before_frontier+1)) ] \
  && ok "later comment on now-healed issue mints a normal frontier leaf" \
  || bad "later comment did not mint a leaf (before=$before_frontier after=$after_frontier)"

# ── Case 2: CLOSED issue, no epic ref → clean no-op, no refs created ──
export ISSUE_STATE=closed
export ISSUE_TITLE="Old closed issue"
export ISSUE_URL="https://example/issues/77"
export ISSUE_BODY="done long ago"

before_frontier=$(frontier_count)
ingest 77 2001 "stray comment on a closed issue"
rc=$?
[ "$rc" -eq 0 ] || bad "closed-issue ingest exited non-zero ($rc): $(cat "$ROOT/out.txt")"
[ -z "$(remote_sha refs/heads/tasks/pending/77)" ] \
  && ok "closed issue: no dispatch root created" \
  || bad "closed issue: tasks/pending/77 was created (would resurrect finished work)"
[ -z "$(remote_sha refs/heads/gh/issues/77)" ] \
  && ok "closed issue: no gh/issues ref created" || bad "closed issue: gh/issues/77 created"
[ "$(frontier_count)" -eq "$before_frontier" ] \
  && ok "closed issue: no frontier leaf minted" || bad "closed issue: a frontier leaf was minted"

echo "-----"; echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
