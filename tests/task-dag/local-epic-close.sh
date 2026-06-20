#!/usr/bin/env bash
# Fixture test: completing the LAST leaf of a purely-local epic appends the
# canonical additive `Closes-Epic: #<N>` commit to HEAD, so the worker's
# subsequent `git push origin HEAD:master` lets close-completed-issues.yml
# close the GitHub issue. This replaces the old rogue direct-REST close in
# `complete` (which bypassed the trailer gate and needed a token workers
# don't have). Completing a NON-final leaf must NOT emit a close.
set -uo pipefail
TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_GIT_NAME=t TASK_DAG_GIT_EMAIL=t@t

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"; cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master

# Epic roots are minted with the EMPTY tree (see create-task-commit.sh),
# exactly like leaves — that is the "is this a live task DAG node?" marker.
EMPTY_TREE=$(git mktree </dev/null)
EPIC=$(git commit-tree "$EMPTY_TREE" -p HEAD -m "Task: Test epic

Issue: #777
URL: https://github.com/test/test/issues/777
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/gh/issues/777 "$EPIC"
git update-ref refs/heads/tasks/pending/777 "$EPIC"
git push -q origin refs/heads/gh/issues/777 refs/heads/tasks/pending/777

# Decompose the epic into TWO leaves in a single breakdown.
"$TD" claim-root 777 >/dev/null 2>&1
printf '[{"title":"leaf A","type":"leaf"},{"title":"leaf B","type":"leaf"}]' > "$ROOT/spec.json"
"$TD" breakdown "$EPIC" --spec-file="$ROOT/spec.json" >/dev/null 2>&1
mapfile -t LEAVES < <(git ls-remote origin 'refs/heads/tasks/frontier/*' \
  | sed -E 's#.*refs/heads/tasks/frontier/##')
[ "${#LEAVES[@]}" = "2" ] && ok "0: breakdown published 2 frontier leaves" \
  || bad "0: expected 2 leaves, got ${#LEAVES[@]}"
A="${LEAVES[0]}"; B="${LEAVES[1]}"

has_close_on_head() {  # 0 if HEAD is a Closes-Epic:#777 merge with EPIC as a parent
  git log -1 --format='%P' HEAD | tr ' ' '\n' | grep -qx "$EPIC" || return 1
  git log -1 --format='%B' HEAD | git interpret-trailers --parse 2>/dev/null \
    | grep -qE '^Closes-Epic:[[:space:]]*#?777([^0-9]|$)'
}

complete_leaf() {  # $1=short sha, $2=impl filename
  TASK_DAG_CLAIMER=w1 TASK_DAG_CLAIMER_HOST=h1 TASK_DAG_CLAIMER_PID=111 \
    "$TD" claim "$1" >/dev/null 2>&1
  echo "work $2" > "$2"; git add "$2"; git commit -qm "impl $2"
  TASK_DAG_CLAIMER=w1 TASK_DAG_CLAIMER_HOST=h1 TASK_DAG_CLAIMER_PID=111 \
    "$TD" complete "$1" >/dev/null 2>&1
}

# Complete the FIRST leaf — epic not yet done, so NO close commit.
complete_leaf "$A" implA.txt
if has_close_on_head; then
  bad "1: a close commit was emitted after only 1 of 2 leaves done"
else
  ok "1: no close commit while the epic still has an incomplete leaf"
fi

# Complete the SECOND (final) leaf — now the epic auto-closes.
complete_leaf "$B" implB.txt
if has_close_on_head; then
  ok "2: completing the final leaf appended a Closes-Epic:#777 commit"
else
  bad "2: no Closes-Epic commit after the final leaf completed"
fi

# The close commit's second parent must be the epic root itself.
if [ "$(git rev-parse HEAD^2)" = "$EPIC" ]; then
  ok "3: close commit lists the epic root as its second parent"
else
  bad "3: close commit second parent is not the epic root"
fi

# The close commit must be a no-diff (additive) commit.
if git diff-tree --no-commit-id --name-only -r HEAD | grep -q .; then
  bad "4: close commit unexpectedly carries a diff (should be additive)"
else
  ok "4: close commit is additive (no diff)"
fi

# Idempotency: it must match the EXACT gate close-completed-issues.yml uses
# (epic-as-parent AND trailer), so the server workflow will act on it.
if git log HEAD --merges --format='%H %P' \
   | grep -F "$EPIC" \
   | while read -r mc _; do
       git log -1 --format='%B' "$mc" | git interpret-trailers --parse \
         | grep -qE '^Closes-Epic:[[:space:]]*#?777' && echo found
     done | grep -q found; then
  ok "5: a trailer-gated close merge for #777 is reachable from HEAD"
else
  bad "5: no trailer-gated close merge reachable from HEAD"
fi

echo "-----"; echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
