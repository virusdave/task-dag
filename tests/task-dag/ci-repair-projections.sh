#!/usr/bin/env bash
# Deterministic read-only fixtures for repair scheduling-projection snapshots.
set -uo pipefail

ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok() { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
source "$REPO_ROOT/scripts/task-dag.d/ci-chains.sh"
EMPTY_TREE=4b825dc642cb6eb9a060e54bf8d69288fbee4904
source "$REPO_ROOT/scripts/task-dag.d/ci-repair.sh"

SNAP="$ROOT/snapshot.git"; git init -q --bare "$SNAP"
sgit() { git --git-dir="$SNAP" "$@"; }
REPO=acme/widgets BRANCH=master ISSUE=7 FIRST_RED=$(printf '1%.0s' {1..40})
SLOT="<!-- ci-repair-slot:v1 repo=$REPO branch=$BRANCH -->"
FR="<!-- ci-repair-first-red:$FIRST_RED -->"
MASTER=$(printf 'seed\n' | sgit commit-tree "$EMPTY_TREE")
ROOT_TASK=$(sgit commit-tree "$EMPTY_TREE" -p "$MASTER" <<EOF
Task: Repair CI

Issue: #$ISSUE
Author: bot
URL: https://github.com/$REPO/issues/$ISSUE
Status: pending
Type: epic

$SLOT
$FR

Repair this branch.
EOF
)
CHILD=$(sgit commit-tree "$EMPTY_TREE" -p "$ROOT_TASK" <<EOF
Task: Fix CI

Issue: #$ISSUE
Author: bot
URL: https://github.com/$REPO/issues/$ISSUE
Status: pending
Type: leaf
EOF
)
DEP_ROOT=$(sgit commit-tree "$EMPTY_TREE" -p "$MASTER" <<EOF
Task: Other issue

Issue: #8
Author: bot
URL: https://github.com/$REPO/issues/8
Status: pending
Type: epic

Issue: #8
Type: free-form-body
EOF
)
DEP_ONLY=$(sgit commit-tree "$EMPTY_TREE" -p "$DEP_ROOT" -p "$ROOT_TASK" <<EOF
Task: Depends on repair

Issue: #8
Author: bot
URL: https://github.com/$REPO/issues/8
Status: pending
Type: leaf
EOF
)
CLAIM=$(sgit commit-tree "$EMPTY_TREE" -p "$CHILD" <<EOF
Claim: Fix CI

Task-Commit: $CHILD
Claimer: worker
Claimer-Host: host
Claimed-At: 2030-01-01T00:00:00Z
TTL-Hours: 24
EOF
)
ROOT_CLAIM=$(sgit commit-tree "$EMPTY_TREE" -p "$ROOT_TASK" <<EOF
Claim: Repair CI

Claim-Kind: root
Issue: #$ISSUE
Claim-ID: claim-1
Task-Commit: $ROOT_TASK
Claimer: worker
Claimer-Host: host
Claimed-At: 2030-01-01T00:00:00Z
TTL-Hours: 24
EOF
)
OTHER_ROOT_CLAIM=$(sgit commit-tree "$EMPTY_TREE" -p "$DEP_ROOT" <<EOF
Claim: Other issue

Claim-Kind: root
Issue: #8
Claim-ID: claim-8
Task-Commit: $DEP_ROOT
Claimer: worker
Claimer-Host: host
Claimed-At: 2030-01-01T00:00:00Z
TTL-Hours: 24
EOF
)
META=$(sgit commit-tree "$EMPTY_TREE" -p "$CHILD" <<EOF
Blocked-Meta: Fix CI

Task-Commit: $CHILD
Blocker-Kind: downstream
Reason: waiting
Blocked-At: 2030-01-01T00:00:00Z
EOF
)
sgit update-ref "refs/heads/gh/issues/$ISSUE" "$ROOT_TASK"
sgit update-ref refs/heads/gh/issues/8 "$DEP_ROOT"
sgit update-ref "refs/heads/tasks/pending/$ISSUE" "$ROOT_TASK"
sgit update-ref "refs/heads/tasks/root-active/$ISSUE" "$ROOT_CLAIM"
sgit update-ref refs/heads/tasks/root-active/8 "$OTHER_ROOT_CLAIM"
sgit update-ref "refs/heads/tasks/frontier/${CHILD:0:7}" "$CHILD"
sgit update-ref "refs/heads/tasks/active/${CHILD:0:7}" "$CLAIM"
sgit update-ref "refs/heads/tasks/blocked/$CHILD" "$CHILD"
sgit update-ref "refs/heads/tasks/blocked-meta/$CHILD" "$META"
sgit update-ref "refs/heads/tasks/frontier/${DEP_ONLY:0:7}" "$DEP_ONLY"

OBS="$ROOT/observation.json"
jq -n --arg repository "$REPO" --arg branch "$BRANCH" --arg firstRed "$FIRST_RED" \
  --argjson number "$ISSUE" --arg url "https://github.com/$REPO/issues/$ISSUE" \
  --arg body "$SLOT
$FR

Repair this branch." \
  '{version:1,repository:$repository,branch:$branch,firstRed:$firstRed,issue:{kind:"issue",number:$number,url:$url,body:$body}}' >"$OBS"

before=$(sgit for-each-ref --format='%(objectname) %(refname)' | sha256sum)
out=$(_ci_repair_classify_projection_snapshot "$SNAP" "$OBS"); rc=$?
after=$(sgit for-each-ref --format='%(objectname) %(refname)' | sha256sum)
if [ "$rc" -eq 0 ] && [ "$(jq '.candidates|length' <<<"$out")" -eq 6 ] \
   && ! grep -q "$DEP_ONLY" <<<"$out" && [ "$before" = "$after" ] \
   && jq -e '.status=="ready" and ([.candidates[].ref] == ([.candidates[].ref]|sort))' <<<"$out" >/dev/null; then
  ok "1: canonical coexisting projections are sorted candidates; dependency-only task is isolated"
else
  bad "1: canonical classification rc=$rc out=$out"
fi

if ! grep -q 'root-active/8' <<<"$out"; then
  ok "1b: valid unrelated root claim and field-looking root body are isolated"
else bad "1b: unrelated root claim leaked into candidates: $out"; fi

WRONG_PENDING_8=$(sgit commit-tree "$EMPTY_TREE" -p "$ROOT_TASK" <<EOF
Task: Miskeyed other issue

Issue: #8
Author: bot
URL: https://github.com/$REPO/issues/8
Status: pending
Type: epic
EOF
)
sgit update-ref refs/heads/tasks/pending/8 "$WRONG_PENDING_8"
out=$(_ci_repair_classify_projection_snapshot "$SNAP" "$OBS"); rc=$?
if [ "$rc" -eq 2 ] && jq -e '.reason=="ambiguous-projection" and .candidates==[]' <<<"$out" >/dev/null; then
  ok "1c: unrelated pending must equal its retained issue root"
else bad "1c: divergent unrelated pending rc=$rc out=$out"; fi
sgit update-ref -d refs/heads/tasks/pending/8

# Pending may already be gone on a replay; retained gh/issues still anchors a
# late scheduling projection.
sgit update-ref -d "refs/heads/tasks/pending/$ISSUE"
out=$(_ci_repair_classify_projection_snapshot "$SNAP" "$OBS"); rc=$?
if [ "$rc" -eq 0 ] && [ "$(jq '.candidates|length' <<<"$out")" -eq 5 ]; then
  ok "2: retained gh/issues identity classifies late refs without pending"
else bad "2: pending-absent rc=$rc out=$out"; fi

# A malformed relevant claim fails closed and never returns a partial set.
BAD_CLAIM=$(sgit commit-tree "$EMPTY_TREE" -p "$CHILD" <<EOF
Claim: Fix CI

Task-Commit: $ROOT_TASK
Claimer: worker
Claimer-Host: host
Claimed-At: 2030-01-01T00:00:00Z
TTL-Hours: 24
EOF
)
sgit update-ref "refs/heads/tasks/active/${CHILD:0:7}" "$BAD_CLAIM"
out=$(_ci_repair_classify_projection_snapshot "$SNAP" "$OBS"); rc=$?
if [ "$rc" -eq 2 ] && jq -e '.status=="indeterminate" and .candidates==[]' <<<"$out" >/dev/null; then
  ok "3: malformed relevant claim fails closed with no candidates"
else bad "3: malformed claim rc=$rc out=$out"; fi
sgit update-ref "refs/heads/tasks/active/${CHILD:0:7}" "$CLAIM"

# Marker substring/duplication and the immutable-root marker binding are both
# rejected; issue observations do not become authority merely by containing a
# marker somewhere.
jq --arg body "prefix $SLOT
$FR

x" '.issue.body=$body' "$OBS" >"$ROOT/bad-observation.json"
out=$(_ci_repair_classify_projection_snapshot "$SNAP" "$ROOT/bad-observation.json"); rc=$?
if [ "$rc" -eq 2 ] && jq -e '.reason=="invalid-observation" and .candidates==[]' <<<"$out" >/dev/null; then
  ok "4: non-prefix GitHub markers are rejected"
else bad "4: marker validation rc=$rc out=$out"; fi

BAD_ROOT=$(printf '%s\n' "Task: Repair CI" "" "Issue: #$ISSUE" "Author: bot" \
  "URL: https://github.com/$REPO/issues/$ISSUE" "Status: pending" "Type: epic" "" \
  "<!-- ci-repair-slot:v1 repo=$REPO branch=other -->" "$FR" "" | sgit commit-tree "$EMPTY_TREE" -p "$MASTER")
sgit update-ref "refs/heads/gh/issues/$ISSUE" "$BAD_ROOT"
out=$(_ci_repair_classify_projection_snapshot "$SNAP" "$OBS"); rc=$?
if [ "$rc" -eq 2 ] && jq -e '.reason=="ambiguous-projection" and .candidates==[]' <<<"$out" >/dev/null; then
  ok "5: immutable root marker mismatch fails closed"
else bad "5: root marker mismatch rc=$rc out=$out"; fi
sgit update-ref "refs/heads/gh/issues/$ISSUE" "$ROOT_TASK"

# Mapping disagreement is ambiguous even when each object is otherwise valid.
sgit update-ref "refs/heads/tasks/pending/$ISSUE" "$DEP_ROOT"
out=$(_ci_repair_classify_projection_snapshot "$SNAP" "$OBS"); rc=$?
if [ "$rc" -eq 2 ] && jq -e '.reason=="ambiguous-projection" and .candidates==[]' <<<"$out" >/dev/null; then
  ok "6: pending/gh issue disagreement fails closed"
else bad "6: issue mapping rc=$rc out=$out"; fi
sgit update-ref "refs/heads/tasks/pending/$ISSUE" "$ROOT_TASK"

# A root lock is a lock on the exact retained root, never on an arbitrary
# structural descendant that happens to repeat the issue number.
DESC_ROOT_CLAIM=$(sgit commit-tree "$EMPTY_TREE" -p "$CHILD" <<EOF
Claim: Wrong root

Claim-Kind: root
Issue: #$ISSUE
Claim-ID: wrong-root
Task-Commit: $CHILD
Claimer: worker
Claimer-Host: host
Claimed-At: 2030-01-01T00:00:00Z
TTL-Hours: 24
EOF
)
sgit update-ref "refs/heads/tasks/root-active/$ISSUE" "$DESC_ROOT_CLAIM"
out=$(_ci_repair_classify_projection_snapshot "$SNAP" "$OBS"); rc=$?
if [ "$rc" -eq 2 ] && jq -e '.reason=="ambiguous-projection" and .candidates==[]' <<<"$out" >/dev/null; then
  ok "7: root-active cannot claim a descendant"
else bad "7: descendant root claim rc=$rc out=$out"; fi
sgit update-ref "refs/heads/tasks/root-active/$ISSUE" "$ROOT_CLAIM"

# Nested names beneath a scheduling namespace are never normalized down to
# their final path component.
sgit update-ref "refs/heads/tasks/frontier/nested/${CHILD:0:7}" "$CHILD"
out=$(_ci_repair_classify_projection_snapshot "$SNAP" "$OBS"); rc=$?
if [ "$rc" -eq 2 ] && jq -e '.reason=="ambiguous-projection" and .candidates==[]' <<<"$out" >/dev/null; then
  ok "8: nested scheduling ref paths fail closed"
else bad "8: nested ref rc=$rc out=$out"; fi
sgit update-ref -d "refs/heads/tasks/frontier/nested/${CHILD:0:7}"

# Free-form task descriptions may contain protocol-looking lines; only the
# ordered minter-owned prefix is structural.
BODY_FIELDS=$(sgit commit-tree "$EMPTY_TREE" -p "$ROOT_TASK" <<EOF
Task: Body fields

Issue: #$ISSUE
Author: bot
URL: https://github.com/$REPO/issues/$ISSUE
Status: pending
Type: leaf

Type: not-a-protocol-field
Task-Commit: also-body
EOF
)
sgit update-ref "refs/heads/tasks/frontier/${BODY_FIELDS:0:7}" "$BODY_FIELDS"
out=$(_ci_repair_classify_projection_snapshot "$SNAP" "$OBS"); rc=$?
if [ "$rc" -eq 0 ] && jq -e --arg oid "$BODY_FIELDS" '[.candidates[].taskOid] | index($oid)!=null' <<<"$out" >/dev/null; then
  ok "9: field-looking free-form task body stays opaque"
else bad "9: opaque body rc=$rc out=$out"; fi
sgit update-ref -d "refs/heads/tasks/frontier/${BODY_FIELDS:0:7}"

jq '.issue.kind="pull-request"' "$OBS" >"$ROOT/wrong-kind.json"
out=$(_ci_repair_classify_projection_snapshot "$SNAP" "$ROOT/wrong-kind.json"); rc=$?
if [ "$rc" -eq 2 ] && jq -e '.reason=="invalid-observation" and .candidates==[]' <<<"$out" >/dev/null; then
  ok "10: non-issue observation kind is rejected"
else bad "10: issue kind rc=$rc out=$out"; fi

touch "$SNAP/shallow"
out=$(_ci_repair_classify_projection_snapshot "$SNAP" "$OBS"); rc=$?
rm -f "$SNAP/shallow"
if [ "$rc" -eq 2 ] && jq -e '.reason=="invalid-snapshot" and .candidates==[]' <<<"$out" >/dev/null; then
  ok "11: shallow snapshots are rejected"
else bad "11: shallow snapshot rc=$rc out=$out"; fi

sgit config remote.origin.partialCloneFilter blob:none
out=$(_ci_repair_classify_projection_snapshot "$SNAP" "$OBS"); rc=$?
sgit config --unset remote.origin.partialCloneFilter
if [ "$rc" -eq 2 ] && jq -e '.reason=="invalid-snapshot" and .candidates==[]' <<<"$out" >/dev/null; then
  ok "11b: partial-clone filter snapshots are rejected"
else bad "11b: partial-clone snapshot rc=$rc out=$out"; fi

# The alternate canonical root dialect created by on-demand backfill keeps
# its metadata in the owned prefix and remains usable as the retained anchor.
for ref in $(sgit for-each-ref --format='%(refname)' refs/heads/tasks/pending refs/heads/tasks/root-active refs/heads/tasks/frontier refs/heads/tasks/active refs/heads/tasks/blocked refs/heads/tasks/blocked-meta); do
  sgit update-ref -d "$ref"
done
BACKFILL_ROOT=$(sgit commit-tree "$EMPTY_TREE" -p "$MASTER" <<EOF
Task: Repair CI

Issue: #$ISSUE
Author: bot
URL: https://github.com/$REPO/issues/$ISSUE
Status: pending
Type: epic
Backfilled: true
Backfill-Reason: epic ref was missing and was recreated on demand by task-dag; the first-sighting issue-to-task run never created it (workflow broken/mid-migration at open time, or issue predates task-dag). See virusdave/top-level#28.

$SLOT
$FR

Repair this branch.
EOF
)
sgit update-ref "refs/heads/gh/issues/$ISSUE" "$BACKFILL_ROOT"
sgit update-ref "refs/heads/tasks/pending/$ISSUE" "$BACKFILL_ROOT"
out=$(_ci_repair_classify_projection_snapshot "$SNAP" "$OBS"); rc=$?
if [ "$rc" -eq 0 ] && [ "$(jq '.candidates|length' <<<"$out")" -eq 1 ] \
   && [ "$(jq -r .rootOid <<<"$out")" = "$BACKFILL_ROOT" ]; then
  ok "12: canonical backfilled root anchors classification"
else bad "12: backfilled root rc=$rc out=$out"; fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
