#!/usr/bin/env bash
# Fixture test for the durable operator-block metadata overlay
# (refs/heads/tasks/blocked-meta/<sha>) added for the operator-blocked
# #29 dashboard (virusdave/top-level#29).
#
# Covers:
#   * block writes a blocked-meta side ref alongside the blocked overlay,
#     classifying operator (default) vs --downstream, with durable reason
#     + request-url + derived repo/issue/source-url + blocked actor/time;
#   * the blocked overlay ref still points straight at the task commit
#     (backwards compatible) and the meta ref is a SEPARATE namespace;
#   * block is idempotent (re-running yields the SAME meta commit SHA and
#     preserves the original block time/actor) and refinable;
#   * unblock / complete / drop all clear the meta ref in lockstep;
#   * a legacy block (meta ref absent) is still valid and unblockable;
#   * a fresh worker clone syncs the meta overlay (fetch_task_refs).
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_CLAIMER=me TASK_DAG_CLAIMER_HOST=h

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc" 2>/dev/null
cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master 2>/dev/null

EMPTY_TREE=$(git hash-object -t tree /dev/null)
EPIC=$(git commit-tree "$EMPTY_TREE" -p HEAD -m "Task: Test epic

Issue: #999
URL: https://github.com/test/test/issues/999
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/gh/issues/999 "$EPIC"
git update-ref refs/heads/tasks/pending/999 "$EPIC"
git push -q origin refs/heads/gh/issues/999 refs/heads/tasks/pending/999 2>/dev/null

mk_task() {  # prints the new leaf task short sha
  # --force bypasses the double-decompose guard so this fixture can mint
  # several independent leaves under one epic (each gets a unique SHA, so
  # the stale local frontier refs left by earlier mk_task calls would
  # otherwise trip the guard — a harness artifact, not a CLI concern).
  local title="$1"
  printf '[{"title":"%s","type":"leaf"}]' "$title" > "$ROOT/spec.json"
  "$TD" breakdown "$EPIC" --spec-file="$ROOT/spec.json" --force --json 2>/dev/null \
    | grep -oE '"shortSha":"[0-9a-f]+"' | head -1 | cut -d'"' -f4
}

meta_ref()  { echo "refs/heads/tasks/blocked-meta/$1"; }
meta_body() { git log -1 --format='%B' "$(meta_ref "$1")"; }
remote_sha() { git ls-remote origin "$1" 2>/dev/null | awk '{print $1; exit}'; }

# ---------------------------------------------------------------------------
T=$(mk_task "operator block meta task")
[ -n "$T" ] || { echo "could not create task (breakdown json)"; echo "PASS=0 FAIL=1"; exit 1; }
TASK_FULL=$(git rev-parse "refs/heads/tasks/frontier/$T")

# TEST 1: an operator block (default) writes BOTH the overlay and meta ref.
"$TD" block "$T" --reason="awaiting operator go/no-go" \
    --request-url="https://github.com/test/test/issues/999#issuecomment-1" >/dev/null 2>&1
if git show-ref --verify --quiet "refs/heads/tasks/blocked/$TASK_FULL"; then
  ok "1: blocked overlay ref created"
else
  bad "1: blocked overlay ref missing"
fi
if git show-ref --verify --quiet "$(meta_ref "$TASK_FULL")"; then
  ok "1: blocked-meta ref created"
else
  bad "1: blocked-meta ref missing"
fi
# ...and it must be PUSHED to origin, not just local (durable metadata).
if [ "$(remote_sha "$(meta_ref "$TASK_FULL")")" = "$(git rev-parse "$(meta_ref "$TASK_FULL")")" ]; then
  ok "1: blocked-meta ref pushed to origin"
else
  bad "1: blocked-meta ref not on origin (or mismatched)"
fi

# TEST 2: the overlay ref still points straight at the TASK commit (compat).
if [ "$(git rev-parse "refs/heads/tasks/blocked/$TASK_FULL")" = "$TASK_FULL" ]; then
  ok "2: blocked overlay still points at the task commit (backwards compatible)"
else
  bad "2: blocked overlay no longer points at the task commit"
fi

# TEST 3: the meta body carries the durable fields, default operator kind,
# and derived repo/issue/source-url.
BODY=$(meta_body "$TASK_FULL")
check_field() {  # $1 grep-pattern  $2 label
  if echo "$BODY" | grep -q "$1"; then ok "3: meta has $2"; else bad "3: meta missing $2 ($1)"; fi
}
check_field "^Blocker-Kind: operator$"                          "default operator kind"
check_field "^Reason: awaiting operator go/no-go$"              "durable reason"
check_field "^Request-URL: https://github.com/test/test/issues/999#issuecomment-1$" "request url"
check_field "^Repo: test/test$"                                 "derived repo"
check_field "^Issue: #999$"                                     "derived issue"
check_field "^Source-URL: https://github.com/test/test/issues/999$" "derived source url"
check_field "^Blocked-By: me$"                                  "blocked actor"
check_field "^Blocked-At: "                                     "blocked timestamp"

# TEST 4: the meta ref is in a DISTINCT namespace and `blocked` ignores it
# (the for-each-ref over tasks/blocked/ must not pick up blocked-meta/).
COUNT=$("$TD" blocked --issue=999 --no-fetch 2>/dev/null | grep -c "$T" || true)
if [ "$COUNT" -eq 1 ]; then
  ok "4: 'blocked' lists the task exactly once (blocked-meta not mistaken for a task)"
else
  bad "4: 'blocked' listed the task $COUNT times (expected 1)"
fi

# TEST 5: idempotency — a bare re-block yields the IDENTICAL meta commit SHA
# and preserves the original block time/actor.
META1=$(git rev-parse "$(meta_ref "$TASK_FULL")")
AT1=$(echo "$BODY" | grep '^Blocked-At: ')
sleep 1
TASK_DAG_CLAIMER=other "$TD" block "$T" >/dev/null 2>&1
META2=$(git rev-parse "$(meta_ref "$TASK_FULL")")
AT2=$(meta_body "$TASK_FULL" | grep '^Blocked-At: ')
if [ "$META1" = "$META2" ]; then
  ok "5: re-block is idempotent (identical meta commit SHA)"
else
  bad "5: re-block changed the meta commit SHA ($META1 -> $META2)"
fi
if [ "$AT1" = "$AT2" ] && meta_body "$TASK_FULL" | grep -q "^Blocked-By: me$"; then
  ok "5: re-block preserves original block time + actor"
else
  bad "5: re-block did not preserve original block time/actor"
fi

# TEST 6: refinement — re-block with --downstream updates the classification
# while still preserving the original time, AND the refined (sibling) meta
# commit must actually land on ORIGIN (a non-fast-forward update that a
# plain push would silently reject).
"$TD" block "$T" --downstream >/dev/null 2>&1
if meta_body "$TASK_FULL" | grep -q "^Blocker-Kind: downstream$" \
   && meta_body "$TASK_FULL" | grep -q "^Reason: awaiting operator go/no-go$"; then
  ok "6: re-block --downstream updates kind, preserves earlier reason"
else
  bad "6: re-block --downstream did not refine correctly"
fi
if [ "$(remote_sha "$(meta_ref "$TASK_FULL")")" = "$(git rev-parse "$(meta_ref "$TASK_FULL")")" ]; then
  ok "6: refined (sibling) meta commit landed on origin"
else
  bad "6: refined meta commit did NOT land on origin (non-ff push silently rejected)"
fi

# TEST 7: mutually-exclusive classification flags are rejected.
if "$TD" block "$T" --operator --downstream >/dev/null 2>&1; then
  bad "7: block accepted both --operator and --downstream"
else
  ok "7: block rejects mutually-exclusive --operator/--downstream"
fi

# TEST 8: unblock clears BOTH refs, locally and on origin.
"$TD" unblock "$T" >/dev/null 2>&1
if git show-ref --verify --quiet "refs/heads/tasks/blocked/$TASK_FULL" \
   || git show-ref --verify --quiet "$(meta_ref "$TASK_FULL")"; then
  bad "8: unblock left a local blocked/meta ref"
else
  ok "8: unblock cleared local blocked + meta refs"
fi
if [ "$(git ls-remote origin "$(meta_ref "$TASK_FULL")" | wc -l)" -eq 0 ]; then
  ok "8: unblock cleared the meta ref on origin"
else
  bad "8: unblock left the meta ref on origin"
fi

# TEST 9: a fresh worker clone syncs the meta overlay via fetch_task_refs.
"$TD" block "$T" --reason="park again" >/dev/null 2>&1
git clone -q "$ROOT/origin.git" "$ROOT/worker" 2>/dev/null
cd "$ROOT/worker"
"$TD" blocked --issue=999 >/dev/null 2>&1   # triggers fetch_task_refs
if git show-ref --verify --quiet "$(meta_ref "$TASK_FULL")"; then
  ok "9: fresh worker synced the blocked-meta overlay"
else
  bad "9: fresh worker did NOT sync the blocked-meta overlay"
fi
cd "$ROOT/wc"

# TEST 10: drop clears the meta ref too.
"$TD" drop "$T" --yes >/dev/null 2>&1
if git show-ref --verify --quiet "$(meta_ref "$TASK_FULL")" \
   || [ "$(git ls-remote origin "$(meta_ref "$TASK_FULL")" | wc -l)" -ne 0 ]; then
  bad "10: drop left a blocked-meta ref (local or origin)"
else
  ok "10: drop cleared the blocked-meta ref (local + origin)"
fi

# TEST 11: complete clears the meta ref. Use a fresh task, claim, block, then
# complete from a clone checked out at master (complete advances HEAD).
T2=$(mk_task "complete clears meta task")
T2_FULL=$(git rev-parse "refs/heads/tasks/frontier/$T2")
"$TD" claim "$T2" >/dev/null 2>&1
"$TD" block "$T2" --reason="temp" >/dev/null 2>&1
git clone -q "$ROOT/origin.git" "$ROOT/completer" 2>/dev/null
cd "$ROOT/completer"
git checkout -q master
echo "work for $T2" > work.txt; git add work.txt; git commit -qm "do the work" >/dev/null
"$TD" complete "$T2" >/dev/null 2>&1
if git show-ref --verify --quiet "$(meta_ref "$T2_FULL")" \
   || [ "$(git ls-remote origin "$(meta_ref "$T2_FULL")" | wc -l)" -ne 0 ]; then
  bad "11: complete left a blocked-meta ref (local or origin)"
else
  ok "11: complete cleared the blocked-meta ref (local + origin)"
fi
cd "$ROOT/wc"

# TEST 12: a LEGACY block (overlay ref only, no meta) is still valid and
# unblockable — backwards compatibility for refs written by the old CLI.
T3=$(mk_task "legacy block task")
T3_FULL=$(git rev-parse "refs/heads/tasks/frontier/$T3")
git update-ref "refs/heads/tasks/blocked/$T3_FULL" "$T3_FULL"
git push -q origin "refs/heads/tasks/blocked/$T3_FULL:refs/heads/tasks/blocked/$T3_FULL" 2>/dev/null
out=$("$TD" unblock "$T3" 2>&1); rc=$?
if [ "$rc" -eq 0 ] && ! git show-ref --verify --quiet "refs/heads/tasks/blocked/$T3_FULL"; then
  ok "12: a legacy (meta-less) block is still unblockable"
else
  bad "12: legacy block could not be unblocked (rc=$rc): $out"
fi

# TEST 13: block with NO --reason, then a BARE re-block. Regression for the
# `set -euo pipefail` abort when read_blocked_meta_field/extract_field hit a
# field that is simply absent (grep returns non-zero -> whole command dies).
T4=$(mk_task "no-reason block task")
T4_FULL=$(git rev-parse "refs/heads/tasks/frontier/$T4")
out=$("$TD" block "$T4" 2>&1); rc=$?
if [ "$rc" -eq 0 ] && git show-ref --verify --quiet "$(meta_ref "$T4_FULL")"; then
  ok "13: block with no --reason succeeds and writes meta"
else
  bad "13: block with no --reason failed (rc=$rc): $out"
fi
out=$("$TD" block "$T4" 2>&1); rc=$?   # bare re-block must not abort on the absent Reason field
if [ "$rc" -eq 0 ]; then
  ok "13: bare re-block of a reason-less task does not abort (pipefail-safe field reads)"
else
  bad "13: bare re-block aborted (rc=$rc): $out"
fi

# TEST 14: blocking an INGESTED-COMMENT task node (YAML body, NO "Issue:"/"URL:"
# trailers) must derive repo/issue from the YAML and not abort. This exercises
# derive_task_origin's fallback path under pipefail.
CTASK=$(git commit-tree "$EMPTY_TREE" -p "$EPIC" -m "kind: message
role: human
intent: comment

issue:
  number: 999

github:
  comment_id: 42
  actor: tester
  url: https://github.com/test/test/issues/999#issuecomment-42

message_id: msg_1_42

body: |
  please do the thing")
CSHORT=$(git rev-parse --short "$CTASK")
git update-ref "refs/heads/tasks/frontier/$CSHORT" "$CTASK"
git push -q origin "refs/heads/tasks/frontier/$CSHORT:refs/heads/tasks/frontier/$CSHORT" 2>/dev/null
out=$("$TD" block "$CSHORT" --reason="needs operator clarification" 2>&1); rc=$?
CBODY=$(git log -1 --format='%B' "$(meta_ref "$CTASK")" 2>/dev/null || true)
if [ "$rc" -eq 0 ] \
   && echo "$CBODY" | grep -q "^Repo: test/test$" \
   && echo "$CBODY" | grep -q "^Issue: #999$" \
   && echo "$CBODY" | grep -q "^Source-URL: https://github.com/test/test/issues/999#issuecomment-42$"; then
  ok "14: blocking an ingested-comment task derives repo/issue/source-url from YAML"
else
  bad "14: ingested-comment block failed or mis-derived (rc=$rc): $out / $CBODY"
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
