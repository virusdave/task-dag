#!/usr/bin/env bash
# Missing roots are no longer repaired by minting an untyped numeric epic from
# mutable issue metadata. Epic-ID roots require the activated typed registry;
# legacy comment ingress must fail closed and leave every namespace unchanged.
set -uo pipefail
TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok(){ echo "PASS: $1"; PASS=$((PASS+1)); }
bad(){ echo "FAIL: $1"; FAIL=$((FAIL+1)); }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_GIT_NAME=t TASK_DAG_GIT_EMAIL=t@t

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"; cd "$ROOT/wc" || exit 1
echo s>s; git add s; git commit -qm s; git push -q origin HEAD:master
printf 'comment' >"$ROOT/body"
export ISSUE_TITLE='Mutable title' ISSUE_AUTHOR=virusdave ISSUE_URL=https://example/issues/14 ISSUE_BODY='Mutable body'
before=$(git ls-remote --refs origin | sort)
"$TD" ingest-comment --issue 14 --comment-id 1001 --author virusdave \
  --comment-url https://example/comments/1001 \
  --created-at 2026-01-02T03:04:05Z --updated-at 2026-01-02T03:04:05Z \
  --body-file "$ROOT/body" >"$ROOT/out" 2>&1
rc=$?
after=$(git ls-remote --refs origin | sort)
if [ "$rc" -ne 0 ]; then ok "missing typed Epic-ID authority fails loud"; else bad "legacy numeric self-heal unexpectedly succeeded"; fi
if [ "$before" = "$after" ]; then ok "failed ingestion is mutation-free"; else bad "failed ingestion changed remote refs"; fi
if ! git --git-dir="$ROOT/origin.git" for-each-ref --format='%(refname)' | grep -Eq '^refs/heads/(gh/issues|tasks/pending)/14$'; then
  ok "mutable metadata cannot backfill obsolete numeric roots"
else bad "obsolete numeric root was minted"; fi
echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
