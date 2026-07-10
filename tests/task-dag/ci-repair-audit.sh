#!/usr/bin/env bash
# Deterministic strict-schema fixture for repair-superseded audit refs.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_CLAIMER=test TASK_DAG_CLAIMER_HOST=test TASK_DAG_CLAIMER_PID=$$

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc" 2>/dev/null
cd "$ROOT/wc" || exit 1
echo seed > seed; git add seed; git commit -qm seed; git push -q origin HEAD:master
MASTER=$(git rev-parse HEAD)
EMPTY_TREE=$(git hash-object -t tree /dev/null)
REPO=acme/widgets BRANCH=master ISSUE=7
FIRST_RED=$(printf '1%.0s' {1..40})
REGISTRY_COMMIT=$(printf '2%.0s' {1..40})
REGISTRY_BLOB=$(printf '3%.0s' {1..40})
DECISION="sha256:$(printf '4%.0s' {1..64})"
FENCE=9 UPDATED=2030-01-01T00:00:00Z RETIRED=2030-01-01T00:01:00Z LEASE_UNTIL=2030-01-01T00:05:00Z

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
Head-First-Seen-At: $UPDATED
Observed-At: $UPDATED
Evidence-Key: sha256:$(printf '6%.0s' {1..64})
Decision-Key: $DECISION
Registry-Commit: $REGISTRY_COMMIT
Registry-Blob: $REGISTRY_BLOB
Enrollment-Mode: enforce
Reconcile-Status: projection-pending
Reconcile-Error:
Reconcile-Lease-Owner: pass-A
Reconcile-Lease-Until: $LEASE_UNTIL
Reconcile-Fence: $FENCE
Updated-At: $UPDATED
EOF
)
CHAIN_REF="refs/heads/tasks/ci-chains/$REPO/$BRANCH"
git update-ref "$CHAIN_REF" "$CHAIN"
IDENTITY=$(printf 'repair-superseded-v1\0%s\0%s\0%s\0%s' \
  "$REPO" "$BRANCH" "$FIRST_RED" "$ISSUE" | sha256sum | awk '{print $1}')
AUDIT_REF="refs/heads/tasks/repair-superseded/$IDENTITY"

audit_message() {
  cat <<EOF
Repair-Superseded: v1

Repository: $REPO
Branch: $BRANCH
Issue: #$ISSUE
First-Red: $FIRST_RED
Canonical-Issue: none
Reason: green
Registry-Commit: $REGISTRY_COMMIT
Registry-Blob: $REGISTRY_BLOB
Decision-Key: $DECISION
Reconcile-Fence: $FENCE
Retired-At: $RETIRED
EOF
}

make_audit() { # [parent] [tree]
  local parent="${1:-$CHAIN}" tree="${2:-$EMPTY_TREE}"
  audit_message | git commit-tree "$tree" -p "$parent"
}

VALID=$(make_audit)
git update-ref "$AUDIT_REF" "$VALID"
if "$TD" validate --strict >/dev/null 2>&1; then
  ok "1: valid repair-superseded audit passes strict validation"
else
  bad "1: valid repair-superseded audit failed strict validation"
fi

expect_invalid() { # <label> <needle> <ref> <commit>
  local label="$1" needle="$2" ref="$3" commit="$4" out rc=0
  git update-ref -d "$AUDIT_REF" 2>/dev/null || true
  git update-ref "$ref" "$commit"
  out=$("$TD" validate --strict 2>&1) || rc=$?
  git update-ref -d "$ref"
  git update-ref "$AUDIT_REF" "$VALID"
  if [ "$rc" -eq 3 ] && grep -qF "$needle" <<<"$out"; then
    ok "$label"
  else
    bad "$label (rc=$rc out=$out)"
  fi
}

expect_invalid "2: malformed audit path is rejected" "malformed repair-superseded ref" \
  refs/heads/tasks/repair-superseded/not-a-hash "$VALID"
expect_invalid "2b: bare audit namespace root is rejected" "malformed repair-superseded ref" \
  refs/heads/tasks/repair-superseded "$VALID"
expect_invalid "3: semantic hash mismatch is rejected" "semantic audit tuple" \
  "refs/heads/tasks/repair-superseded/$(printf 'f%.0s' {1..64})" "$VALID"

MISSING=$(audit_message | sed '/^Decision-Key:/d' | git commit-tree "$EMPTY_TREE" -p "$CHAIN")
expect_invalid "4: missing field is rejected" "exactly one Decision-Key" "$AUDIT_REF" "$MISSING"
DUPLICATE=$( { audit_message; echo "Reason: green"; } | git commit-tree "$EMPTY_TREE" -p "$CHAIN")
expect_invalid "5: duplicate field is rejected" "exactly one Reason" "$AUDIT_REF" "$DUPLICATE"
EXTRA=$( { audit_message; echo "Unexpected: value"; } | git commit-tree "$EMPTY_TREE" -p "$CHAIN")
expect_invalid "6: unknown field is rejected" "unexpected audit protocol line" "$AUDIT_REF" "$EXTRA"
MALFORMED_KNOWN=$( { audit_message; echo "Reason:evil"; } | git commit-tree "$EMPTY_TREE" -p "$CHAIN")
expect_invalid "6b: malformed known-key line is rejected" "unexpected audit protocol line" "$AUDIT_REF" "$MALFORMED_KNOWN"
DUP_SUBJECT=$( { audit_message; echo "Repair-Superseded: v1"; } | git commit-tree "$EMPTY_TREE" -p "$CHAIN")
expect_invalid "6c: duplicate subject is rejected" "audit subject must be" "$AUDIT_REF" "$DUP_SUBJECT"

WRONG_PARENT=$(audit_message | git commit-tree "$EMPTY_TREE" -p "$MASTER")
expect_invalid "7: non-chain parent is rejected" "authorizing parent must be an empty-tree CI-chain commit" "$AUDIT_REF" "$WRONG_PARENT"
MULTI_PARENT=$(audit_message | git commit-tree "$EMPTY_TREE" -p "$CHAIN" -p "$MASTER")
expect_invalid "8: multiple parents are rejected" "exactly one authorizing chain parent" "$AUDIT_REF" "$MULTI_PARENT"
BAD_FENCE=$(audit_message | sed 's/^Reconcile-Fence:.*/Reconcile-Fence: 0/' | git commit-tree "$EMPTY_TREE" -p "$CHAIN")
expect_invalid "9: zero fence is rejected" "canonical positive bounded integer" "$AUDIT_REF" "$BAD_FENCE"
BAD_TIME=$(audit_message | sed 's/^Retired-At:.*/Retired-At: not-a-time/' | git commit-tree "$EMPTY_TREE" -p "$CHAIN")
expect_invalid "10: malformed retirement time is rejected" "Retired-At must be canonical UTC" "$AUDIT_REF" "$BAD_TIME"
BAD_OID=$(audit_message | sed "s/^Registry-Blob:.*/Registry-Blob: $(printf 'a%.0s' {1..41})/" | git commit-tree "$EMPTY_TREE" -p "$CHAIN")
expect_invalid "10b: noncanonical object-id length is rejected" "Registry-Blob must be" "$AUDIT_REF" "$BAD_OID"
BEFORE_LEASE=$(audit_message | sed 's/^Retired-At:.*/Retired-At: 2029-12-31T23:59:59Z/' | git commit-tree "$EMPTY_TREE" -p "$CHAIN")
expect_invalid "10c: retirement before lease state is rejected" "predates the authorizing lease state" "$AUDIT_REF" "$BEFORE_LEASE"
AT_EXPIRY=$(audit_message | sed "s/^Retired-At:.*/Retired-At: $LEASE_UNTIL/" | git commit-tree "$EMPTY_TREE" -p "$CHAIN")
expect_invalid "10d: retirement at lease expiry is rejected" "not within the authorizing lease" "$AUDIT_REF" "$AT_EXPIRY"
MISMATCH=$(audit_message | sed "s/^Registry-Commit:.*/Registry-Commit: $(printf 'a%.0s' {1..40})/" | git commit-tree "$EMPTY_TREE" -p "$CHAIN")
expect_invalid "10e: copied parent authority mismatch is rejected" "Registry-Commit disagrees" "$AUDIT_REF" "$MISMATCH"

echo payload > payload; git add payload; NONEMPTY_TREE=$(git write-tree); git reset -q
NONEMPTY=$(make_audit "$CHAIN" "$NONEMPTY_TREE")
expect_invalid "11: nonempty audit tree is rejected" "must use the empty tree" "$AUDIT_REF" "$NONEMPTY"

# Publish the valid audit and prove every scheduling discovery surface ignores
# it. The ref remains visible to strict validation, but never as work.
git push -q origin "$AUDIT_REF"
frontier_out=$("$TD" frontier 2>&1 || true)
roots_out=$("$TD" roots 2>&1 || true)
claim_rc=0; "$TD" claim "$VALID" >/dev/null 2>&1 || claim_rc=$?
if ! grep -Eq "$IDENTITY|$VALID|${VALID:0:7}|Repair-Superseded: v1" <<<"$frontier_out$roots_out" \
   && [ "$claim_rc" -ne 0 ] \
   && [ -z "$(git ls-remote origin \
        'refs/heads/tasks/pending/*' 'refs/heads/tasks/frontier/*' 'refs/heads/tasks/active/*' \
        | awk -v sha="$VALID" '$1 == sha { print }')" ]; then
  ok "12: audit is invisible to frontier, roots, and claim discovery"
else
  bad "12: audit leaked into scheduling discovery"
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
