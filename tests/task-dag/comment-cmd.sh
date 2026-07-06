#!/usr/bin/env bash
# Fixture test for `task-dag comment` — the sanctioned issue-comment path.
#
# Covers: kind validation (fail-closed), body validation, marker stamping on
# physical line 1, and — critically — a ROUND-TRIP: the exact body `comment
# --dry-run` would post is fed through the real `ingest-comment` and must be
# SKIPPED, never minted as a phantom frontier task (issue #9 loop).
set -uo pipefail
TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok(){ echo "PASS: $1"; PASS=$((PASS+1)); }
bad(){ echo "FAIL: $1"; FAIL=$((FAIL+1)); }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_GIT_NAME=t TASK_DAG_GIT_EMAIL=t@t

# Local bare origin so the ingest round-trip can actually push refs. The
# `comment` command gets its repo via explicit --repo=acme/widgets (its
# remote-URL autodetect is exercised implicitly and is not the point here).
git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"; cd "$ROOT/wc"
echo s>s; git add s; git commit -qm s
EPIC=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: epic
Issue: #999
Type: epic")
git update-ref refs/heads/gh/issues/999 "$EPIC"

# ---- kind validation ----
"$TD" comment 999 --body=x >/dev/null 2>&1 \
  && bad "missing --kind should fail" || ok "missing --kind is rejected"

"$TD" comment 999 --kind=bogus --body=x >/dev/null 2>&1 \
  && bad "unknown --kind should fail" || ok "unknown --kind is rejected"

"$TD" comment 999 --kind=completion --body=x >/dev/null 2>&1 \
  && bad "completion kind should be rejected" || ok "completion kind is rejected"

# ---- body validation ----
# --repo + --dry-run so resolution succeeds (body checks are reached) and no
# network POST ever happens even if a validation gap let one through.
R="--repo=acme/widgets --dry-run"
"$TD" comment 999 $R --kind=status >/dev/null 2>&1 \
  && bad "missing body should fail" || ok "missing body is rejected"

"$TD" comment 999 $R --kind=status --body=x --body-file=/dev/null >/dev/null 2>&1 \
  && bad "both --body and --body-file should fail" || ok "body + body-file is rejected"

"$TD" comment 999 $R --kind=status --body="" >/dev/null 2>&1 \
  && bad "empty body should fail" || ok "empty body is rejected"

"$TD" comment 999 $R --kind=status --body=$'\n\n   \n' >/dev/null 2>&1 \
  && bad "whitespace-only body should fail" || ok "whitespace-only body is rejected"

"$TD" comment 999 $R --kind=status --body=$'hello\n<!-- task-dag:status -->' >/dev/null 2>&1 \
  && bad "embedded task-dag marker should fail" || ok "embedded task-dag marker is rejected"

"$TD" comment 999 $R --kind=status --body=$'hi\n<!--task-dag:status-->' >/dev/null 2>&1 \
  && bad "spaceless embedded marker should fail" || ok "spaceless embedded marker is rejected"

# ---- marker stamping (physical line 1) ----
out=$("$TD" comment 999 --repo=acme/widgets --kind=status --body="progress note" --dry-run 2>/dev/null)
[ "$(printf '%s' "$out" | head -n1)" = "<!-- task-dag:status -->" ] \
  && ok "status marker is on physical line 1" \
  || bad "status marker missing/misplaced: $(printf '%s' "$out" | head -n1)"

out=$("$TD" comment 999 --repo=acme/widgets --kind=operator-decision --body="need a call" --dry-run 2>/dev/null)
[ "$(printf '%s' "$out" | head -n1)" = "<!-- task-dag:operator-decision -->" ] \
  && ok "operator-decision marker is on physical line 1" \
  || bad "operator-decision marker missing/misplaced"

# body must survive below the marker
printf '%s' "$out" | grep -q "need a call" \
  && ok "user body is preserved below the marker" || bad "user body lost"

# ---- repo autodetect from a github origin URL (dry-run: no network) ----
# set-url persists to .git/config, so save + restore the real local origin.
real_origin=$(git remote get-url origin)
git remote set-url origin "https://github.com/acme/widgets.git"
o=$("$TD" comment 999 --kind=status --body="x" --dry-run 2>&1)
printf '%s' "$o" | grep -q "acme/widgets#999" \
  && ok "repo is autodetected from a github origin URL" \
  || bad "repo autodetect from origin URL failed"
git remote set-url origin "$real_origin"

# ---- ROUND-TRIP: dry-run body must be skipped by the real ingester ----
frontier_count(){ git ls-remote origin "refs/heads/tasks/frontier/*" 2>/dev/null | wc -l; }
git push -q origin HEAD:master
git push -q origin refs/heads/gh/issues/999
ingest(){
  printf '%s' "$2" > "$ROOT/body.txt"
  "$TD" ingest-comment --issue 999 --comment-id "$1" --author virusdave \
    --comment-url "https://x/$1" --body-file "$ROOT/body.txt" >/dev/null 2>&1
}

for kind in status operator-decision; do
  body=$("$TD" comment 999 --repo=acme/widgets --kind="$kind" --body="round trip $kind" --dry-run 2>/dev/null)
  before=$(frontier_count)
  ingest "rt-$kind" "$body"
  after=$(frontier_count)
  [ "$after" -eq "$before" ] \
    && ok "round-trip: $kind comment body is NOT ingested as a task" \
    || bad "round-trip: $kind comment minted a task (before=$before after=$after)"
done

# sanity: a plain comment (no marker) IS ingested — proves the counter works
before=$(frontier_count)
ingest plain "please add feature X"
after=$(frontier_count)
[ "$after" -eq $((before+1)) ] \
  && ok "sanity: plain prose still mints a task" \
  || bad "sanity: plain prose did not mint a task (before=$before after=$after)"

echo "-----"; echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
