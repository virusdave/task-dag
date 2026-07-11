#!/usr/bin/env bash
# Deterministic fenced repair-retirement and race fixtures. Every mutation is
# confined to a throwaway bare origin; the git shim injects races at the exact
# atomic-push boundary without sleeps or production resources.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok() { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc" 2>/dev/null
cd "$ROOT/wc" || exit 1
echo seed >seed; git add seed; git commit -qm seed; git push -q origin HEAD:master
MASTER=$(git rev-parse HEAD)
EMPTY_TREE=$(git hash-object -t tree /dev/null)
REPO=acme/widgets BRANCH=master ISSUE=7 OWNER=pass-A FENCE=9
NOW1=2030-01-01T00:01:00Z NOW2=2030-01-01T00:02:00Z
NOW3=2030-01-01T00:03:00Z NOW4=2030-01-01T00:04:00Z
LEASE_UNTIL=2030-01-01T00:05:00Z
FIRST_RED="$MASTER"
SLOT="<!-- ci-repair-slot:v1 repo=$REPO branch=$BRANCH -->"
FR="<!-- ci-repair-first-red:$FIRST_RED -->"

ROOT_TASK=$(git commit-tree "$EMPTY_TREE" -p "$MASTER" <<EOF
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
CHILD=$(git commit-tree "$EMPTY_TREE" -p "$ROOT_TASK" <<EOF
Task: Fix CI

Issue: #$ISSUE
Author: bot
URL: https://github.com/$REPO/issues/$ISSUE
Status: pending
Type: leaf
EOF
)
git push -q origin \
  "$ROOT_TASK:refs/heads/gh/issues/$ISSUE" \
  "$ROOT_TASK:refs/heads/tasks/pending/$ISSUE" \
  "$CHILD:refs/heads/tasks/frontier/${CHILD:0:7}"

REGISTRY_COMMIT=$(printf '2%.0s' {1..40})
REGISTRY_BLOB=$(printf '3%.0s' {1..40})
DECISION="sha256:$(printf '4%.0s' {1..64})"
CHAIN=$(git commit-tree "$EMPTY_TREE" <<EOF
CI-Chain: $REPO@$BRANCH

Current-Head: $FIRST_RED
Last-Green:
First-Red: $FIRST_RED
State: green
Repair-Mode:
Repair-Issue:
Repair-Attempt:
Fail-Signature:
Same-Sig-Count:
Observed-Head: $FIRST_RED
Policy-Digest: sha256:$(printf '5%.0s' {1..64})
Aggregate: green
Required-Evidence: W10
Head-First-Seen-At: 2030-01-01T00:00:00Z
Observed-At: 2030-01-01T00:00:00Z
Evidence-Key: sha256:$(printf '6%.0s' {1..64})
Decision-Key: $DECISION
Registry-Commit: $REGISTRY_COMMIT
Registry-Blob: $REGISTRY_BLOB
Enrollment-Mode: enforce
Reconcile-Status: projection-pending
Reconcile-Error:
Reconcile-Lease-Owner: $OWNER
Reconcile-Lease-Until: $LEASE_UNTIL
Reconcile-Fence: $FENCE
Updated-At: 2030-01-01T00:00:00Z
EOF
)
CHAIN_REF="refs/heads/tasks/ci-chains/$REPO/$BRANCH"
git push -q origin "$CHAIN:$CHAIN_REF"

# Production callers acquire/renew the reconciliation lease before retiring.
# That migration serializes the newly-added operation field as one empty value;
# repair-retire must accept it as legacy state and replace it on first use.
lease_out=$("$TD" reconcile-lease "$REPO" "$BRANCH" --owner="$OWNER" \
  --now=2030-01-01T00:00:30Z --fence="$FENCE" --json); lease_rc=$?
CHAIN=$(jq -r .commit <<<"$lease_out")
if [ "$lease_rc" -eq 0 ] && [ -z "$(git log -1 --format=%B "$CHAIN" | sed -n 's/^Reconcile-Operation-ID: //p')" ]; then
  ok "0: lease renewal migrates a legacy chain with an empty operation id"
else bad "0: legacy lease migration rc=$lease_rc out=$lease_out"; fi

OBS="$ROOT/observation.json"
jq -n --arg repository "$REPO" --arg branch "$BRANCH" --arg firstRed "$FIRST_RED" \
  --argjson number "$ISSUE" --arg url "https://github.com/$REPO/issues/$ISSUE" \
  --arg body "$SLOT
$FR

Repair this branch." \
  '{version:1,repository:$repository,branch:$branch,firstRed:$firstRed,
    issue:{kind:"issue",number:$number,url:$url,body:$body}}' >"$OBS"

remote_sha() { git ls-remote origin "$1" | awk '{print $1}'; }
retire() { # <now> <token>
  "$TD" repair-retire "$REPO" "$BRANCH" --observation="$OBS" \
    --owner="$OWNER" --now="$1" --fence="$FENCE" --chain-token="$2" \
    --reason=green --json
}
IDENTITY=$(printf 'repair-superseded-v1\0%s\0%s\0%s\0%s' \
  "$REPO" "$BRANCH" "$FIRST_RED" "$ISSUE" | sha256sum | awk '{print $1}')
AUDIT_REF="refs/heads/tasks/repair-superseded/$IDENTITY"
FRONTIER_REF="refs/heads/tasks/frontier/${CHILD:0:7}"
PENDING_REF="refs/heads/tasks/pending/$ISSUE"

out=$(retire "$NOW1" "$CHAIN"); rc=$?
CHAIN1=$(remote_sha "$CHAIN_REF")
if [ "$rc" -eq 0 ] && jq -e '.outcome=="clean-current" and .remainingCandidates==0' <<<"$out" >/dev/null \
   && [ -n "$(remote_sha "$AUDIT_REF")" ] && [ -z "$(remote_sha "$FRONTIER_REF")" ] \
   && [ -z "$(remote_sha "$PENDING_REF")" ] && [ "$(remote_sha "refs/heads/gh/issues/$ISSUE")" = "$ROOT_TASK" ] \
   && [ "$(git rev-parse "$CHAIN1^")" = "$CHAIN" ] \
   && [[ "$(git log -1 --format=%B "$CHAIN1" | sed -n 's/^Reconcile-Operation-ID: //p')" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  ok "1: audit creation, chain fence transition, and all classified deletions are one confirmed transaction"
else bad "1: initial retirement rc=$rc out=$out chain=$CHAIN1"; fi

if "$TD" validate --strict >/dev/null 2>&1; then
  ok "2: generated audit and chain pass strict validation"
else bad "2: generated retirement state failed strict validation"; fi

# Existing-audit replay obtains fresh live authority and removes a late ref.
git push -q origin "$CHILD:$FRONTIER_REF"
out=$(retire "$NOW2" "$CHAIN1"); rc=$?; CHAIN2=$(remote_sha "$CHAIN_REF")
if [ "$rc" -eq 0 ] && jq -e '.outcome=="clean-current"' <<<"$out" >/dev/null \
   && [ -z "$(remote_sha "$FRONTIER_REF")" ] && [ "$(git rev-parse "$CHAIN2^")" = "$CHAIN1" ] \
   && [ "$(remote_sha "$AUDIT_REF")" = "$(jq -r .auditOid <<<"$out")" ]; then
  ok "3: existing audit authorizes idempotent late-projection cleanup under a new live token"
else bad "3: late cleanup rc=$rc out=$out"; fi

# A stale token cannot delete a projection.
git push -q origin "$CHILD:$FRONTIER_REF"
before=$(remote_sha "$CHAIN_REF"); out=$(retire "$NOW3" "$CHAIN1" 2>/dev/null); rc=$?
if [ "$rc" -eq 5 ] && jq -e '.outcome=="authority-token-changed"' <<<"$out" >/dev/null \
   && [ "$(remote_sha "$FRONTIER_REF")" = "$CHILD" ] && [ "$(remote_sha "$CHAIN_REF")" = "$before" ]; then
  ok "4: stale chain token cannot mutate scheduling refs"
else bad "4: stale-token refusal rc=$rc out=$out"; fi

# Test-only git shim injects deterministic races exactly around the destructive
# atomic push. All non-matching git invocations delegate unchanged.
mkdir "$ROOT/bin"
REAL_GIT=$(command -v git)
cat >"$ROOT/bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
real=${REAL_GIT:?}
mode=${RETIRE_RACE_MODE:-}
if [ "$mode" = delayed-stale ] && [ -f "$RACE_STATE" ] && [[ " $* " = *fresh.git*fetch* ]]; then
  rm -f "$RACE_STATE"
  tip=$("$real" --git-dir="$RACE_ORIGIN" rev-parse "$RACE_CHAIN_REF")
  tree=$("$real" --git-dir="$RACE_ORIGIN" rev-parse "$tip^{tree}")
  msg=$("$real" --git-dir="$RACE_ORIGIN" log -1 --format=%B "$tip" \
    | sed 's/^Reconcile-Operation-ID:.*/Reconcile-Operation-ID: sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/')
  next=$(printf '%s' "$msg" | GIT_AUTHOR_NAME=race GIT_AUTHOR_EMAIL=race@t \
    GIT_COMMITTER_NAME=race GIT_COMMITTER_EMAIL=race@t \
    "$real" --git-dir="$RACE_ORIGIN" commit-tree "$tree" -p "$tip")
  "$real" --git-dir="$RACE_ORIGIN" update-ref "$RACE_CHAIN_REF" "$next" "$tip"
fi
if [ "$mode" != "" ] && [ "${1:-}" = push ] && [ "${2:-}" = --atomic ] && [ "${3:-}" = origin ]; then
  if [ "$mode" = replace-before ]; then
    "$real" --git-dir="$RACE_ORIGIN" update-ref "$RACE_FRONTIER_REF" "$RACE_REPLACEMENT"
    exec "$real" "$@"
  fi
  rc=0; "$real" "$@" || rc=$?
  if [ "$rc" -eq 0 ] && [ "$mode" = late-after ]; then
    "$real" --git-dir="$RACE_ORIGIN" update-ref "$RACE_FRONTIER_REF" "$RACE_CHILD"
  elif [ "$rc" -eq 0 ] && [ "$mode" = merge-after ]; then
    tip=$("$real" --git-dir="$RACE_ORIGIN" rev-parse "$RACE_CHAIN_REF")
    tree=$("$real" --git-dir="$RACE_ORIGIN" rev-parse "$tip^{tree}")
    base=$("$real" --git-dir="$RACE_ORIGIN" rev-parse "$tip^")
    msg=$("$real" --git-dir="$RACE_ORIGIN" log -1 --format=%B "$tip" \
      | sed 's/^Reconcile-Operation-ID:.*/Reconcile-Operation-ID: sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff/')
    other=$(printf '%s' "$msg" | GIT_AUTHOR_NAME=race GIT_AUTHOR_EMAIL=race@t \
      GIT_COMMITTER_NAME=race GIT_COMMITTER_EMAIL=race@t \
      "$real" --git-dir="$RACE_ORIGIN" commit-tree "$tree" -p "$base")
    merge=$(printf '%s' "$msg" | GIT_AUTHOR_NAME=race GIT_AUTHOR_EMAIL=race@t \
      GIT_COMMITTER_NAME=race GIT_COMMITTER_EMAIL=race@t \
      "$real" --git-dir="$RACE_ORIGIN" commit-tree "$tree" -p "$other" -p "$tip")
    "$real" --git-dir="$RACE_ORIGIN" update-ref "$RACE_CHAIN_REF" "$merge" "$tip"
  elif [ "$rc" -eq 0 ] && [ "$mode" = merge-first-late ]; then
    "$real" --git-dir="$RACE_ORIGIN" update-ref "$RACE_FRONTIER_REF" "$RACE_CHILD"
    tip=$("$real" --git-dir="$RACE_ORIGIN" rev-parse "$RACE_CHAIN_REF")
    tree=$("$real" --git-dir="$RACE_ORIGIN" rev-parse "$tip^{tree}")
    base=$("$real" --git-dir="$RACE_ORIGIN" rev-parse "$tip^")
    msg=$("$real" --git-dir="$RACE_ORIGIN" log -1 --format=%B "$tip" \
      | sed 's/^Reconcile-Operation-ID:.*/Reconcile-Operation-ID: sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee/')
    other=$(printf '%s' "$msg" | GIT_AUTHOR_NAME=race GIT_AUTHOR_EMAIL=race@t \
      GIT_COMMITTER_NAME=race GIT_COMMITTER_EMAIL=race@t \
      "$real" --git-dir="$RACE_ORIGIN" commit-tree "$tree" -p "$base")
    merge=$(printf '%s' "$msg" | GIT_AUTHOR_NAME=race GIT_AUTHOR_EMAIL=race@t \
      GIT_COMMITTER_NAME=race GIT_COMMITTER_EMAIL=race@t \
      "$real" --git-dir="$RACE_ORIGIN" commit-tree "$tree" -p "$tip" -p "$other")
    "$real" --git-dir="$RACE_ORIGIN" update-ref "$RACE_CHAIN_REF" "$merge" "$tip"
  elif [ "$rc" -eq 0 ] && [ "$mode" = delayed-stale ]; then
    : >"$RACE_STATE"
  fi
  exit "$rc"
fi
exec "$real" "$@"
EOF
chmod +x "$ROOT/bin/git"
export REAL_GIT RACE_ORIGIN="$ROOT/origin.git" RACE_FRONTIER_REF="$FRONTIER_REF"
export RACE_REPLACEMENT="$ROOT_TASK" RACE_CHILD="$CHILD" RACE_CHAIN_REF="$CHAIN_REF"
export RACE_STATE="$ROOT/race-state"

# A replacement after classification makes the exact lease reject the whole
# transaction; readback reports conflict and never deletes the replacement.
out=$(RETIRE_RACE_MODE=replace-before PATH="$ROOT/bin:$PATH" retire "$NOW3" "$CHAIN2" 2>/dev/null); rc=$?
if [ "$rc" -eq 12 ] && jq -e '.outcome=="conflict"' <<<"$out" >/dev/null \
   && [ "$(remote_sha "$FRONTIER_REF")" = "$ROOT_TASK" ] && [ "$(remote_sha "$CHAIN_REF")" = "$CHAIN2" ]; then
  ok "5: exact leases preserve a racing replacement and abort every transaction effect"
else bad "5: replacement race rc=$rc out=$out"; fi
git push -q --force origin "$CHILD:$FRONTIER_REF"

# A projection recreated immediately after an accepted transaction is found by
# unconditional fresh reclassification, not hidden by candidate-only readback.
out=$(RETIRE_RACE_MODE=late-after PATH="$ROOT/bin:$PATH" retire "$NOW3" "$CHAIN2" 2>/dev/null); rc=$?
CHAIN3=$(remote_sha "$CHAIN_REF")
if [ "$rc" -eq 11 ] && jq -e '.outcome=="accepted-incomplete" and .remainingCandidates==1' <<<"$out" >/dev/null \
   && [ "$(remote_sha "$FRONTIER_REF")" = "$CHILD" ]; then
  ok "6: late accepted projection is reported as incomplete"
else bad "6: late-projection race rc=$rc out=$out"; fi

# General ancestry is insufficient: a replacement that carries the accepted
# child only as a non-first parent is a conflict, never stale-accepted.
out=$(retire "$NOW4" "$CHAIN3"); rc=$?; CHAIN4=$(remote_sha "$CHAIN_REF")
[ "$rc" -eq 0 ] || bad "7a: merge-race setup cleanup failed rc=$rc out=$out"
git push -q origin "$CHILD:$FRONTIER_REF"
out=$(RETIRE_RACE_MODE=merge-after PATH="$ROOT/bin:$PATH" retire "$NOW4" "$CHAIN4" 2>/dev/null); rc=$?
merge_tip=$(remote_sha "$CHAIN_REF")
accepted_child=$(git --git-dir="$ROOT/origin.git" rev-parse "$merge_tip^2")
if [ "$rc" -eq 12 ] && jq -e '.outcome=="conflict"' <<<"$out" >/dev/null; then
  ok "7: non-first-parent transaction ancestry is rejected"
else bad "7: non-first-parent race rc=$rc out=$out"; fi
git --git-dir="$ROOT/origin.git" update-ref "$CHAIN_REF" "$accepted_child" "$merge_tip"
CHAIN4="$accepted_child"

# Even when the accepted child is the first parent, a merge tip is malformed
# authority and wins over a simultaneously observed late-candidate outcome.
git push -q --force origin "$CHILD:$FRONTIER_REF"
out=$(RETIRE_RACE_MODE=merge-first-late PATH="$ROOT/bin:$PATH" retire "$NOW4" "$CHAIN4" 2>/dev/null); rc=$?
merge_tip=$(remote_sha "$CHAIN_REF")
accepted_child=$(git --git-dir="$ROOT/origin.git" rev-parse "$merge_tip^1")
if [ "$rc" -eq 12 ] && jq -e '.outcome=="conflict" and .remainingCandidates==1' <<<"$out" >/dev/null; then
  ok "8: malformed descendant authority takes precedence over late-projection status"
else bad "8: malformed descendant with late projection rc=$rc out=$out"; fi
git --git-dir="$ROOT/origin.git" update-ref "$CHAIN_REF" "$accepted_child" "$merge_tip"
CHAIN4="$accepted_child"

# First clean the late ref, then inject a valid descendant after the next
# transaction. This race advances authority only when the fresh projection
# snapshot starts, after the command's first readback. The final checked chain
# read must still detect it.
git push -q --force origin "$CHILD:$FRONTIER_REF"
out=$(RETIRE_RACE_MODE=delayed-stale PATH="$ROOT/bin:$PATH" retire "$NOW4" "$CHAIN4" 2>/dev/null); rc=$?
if [ "$rc" -eq 10 ] && jq -e '.outcome=="stale-accepted" and .remainingCandidates==0' <<<"$out" >/dev/null \
   && [ -z "$(remote_sha "$FRONTIER_REF")" ]; then
  ok "9: final chain read detects authority advancing during fresh classification"
else bad "9: delayed stale-accepted race rc=$rc out=$out"; fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
