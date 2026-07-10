#!/usr/bin/env bash
# Deterministic fixture for the metadata-only CI reconciliation lease. Every
# mutation targets a throwaway bare origin; fixed UTC values prove host time is
# not lease authority.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

command -v jq >/dev/null 2>&1 || { echo "jq is required"; exit 1; }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc" 2>/dev/null
cd "$ROOT/wc"
echo a > f; git add f; git commit -qm c1; C1=$(git rev-parse HEAD)
echo b > f; git commit -qam c2; C2=$(git rev-parse HEAD)
git push -q origin HEAD:master

REPO=acme/widgets
EMPTY_TREE=$(git hash-object -t tree /dev/null)
ref_for() { printf 'refs/heads/tasks/ci-chains/acme/widgets/%s' "$1"; }
remote_sha() { git ls-remote origin "$(ref_for "$1")" | awk '{print $1}'; }
field() { "$TD" chain-read "$REPO" "$1" --json 2>/dev/null | jq -r ".$2"; }

forge_chain() { # <branch> <message-body>
  local branch="$1" body="$2" commit
  commit=$(printf 'CI-Chain: %s@%s\n\n%s\n' "$REPO" "$branch" "$body" \
    | git commit-tree "$EMPTY_TREE") || return 1
  git push -q origin "$commit:$(ref_for "$branch")"
}

expect_unchanged() { # <branch> <expected-rc> <command...>
  local branch="$1" expected="$2"; shift 2
  local before after rc=0
  before=$(remote_sha "$branch")
  "$@" >/dev/null 2>&1 || rc=$?
  after=$(remote_sha "$branch")
  [ "$rc" -eq "$expected" ] && [ "$before" = "$after" ]
}

expect_namespace_unchanged() { # <expected-rc> <command...>
  local expected="$1"; shift
  local before after rc=0
  before=$(git ls-remote origin 'refs/heads/tasks/ci-chains/*')
  "$@" >/dev/null 2>&1 || rc=$?
  after=$(git ls-remote origin 'refs/heads/tasks/ci-chains/*')
  [ "$rc" -eq "$expected" ] && [ "$before" = "$after" ]
}

# Help is innocuous and available without required arguments.
if "$TD" reconcile-lease --help 2>/dev/null | grep -q '^Usage:'; then
  ok "1: reconcile-lease --help is side-effect free"
else
  bad "1: reconcile-lease --help failed"
fi

# Absent/legacy fence zero acquisition accepts an explicit zero precondition.
out=$(TZ=Pacific/Honolulu "$TD" reconcile-lease "$REPO" absent \
  --owner=pass-A --now=2030-01-02T03:04:05Z --fence=0 --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | jq -e \
    '.ok and .reason=="acquired" and .rc==0 and .fence==1
     and .leaseUntil=="2030-01-02T03:09:05Z"' >/dev/null \
    && [ "$(field absent updatedAt)" = 2030-01-02T03:04:05Z ] \
    && [ -z "$(field absent state)" ] \
    && [ -z "$(field absent currentHead)" ]; then
  ok "2: absent lease acquires at fence 1 using supplied UTC, not host clock"
else
  bad "2: absent acquisition rc=$rc out=$out"
fi

# A valid unlocked retained fence exercises migration and field preservation.
forge_chain preserve "Current-Head: $C1
State: red
Repair-Mode: continue
Repair-Issue: creating@12345
Repair-Attempt: 7
Fail-Signature: sig
Same-Sig-Count: 2
Observed-Head: $C1
Policy-Digest: sha256:policy
Aggregate: red
Required-Evidence: ZXZpZGVuY2U
Head-First-Seen-At: 2029-01-01T00:00:00Z
Observed-At: 2030-01-01T00:00:00Z
Evidence-Key: sha256:evidence
Decision-Key: sha256:decision
Registry-Commit: $C1
Registry-Blob: $C2
Enrollment-Mode: observe
Reconcile-Status: projection-pending
Reconcile-Error: api-unavailable
Reconcile-Lease-Owner:
Reconcile-Lease-Until:
Reconcile-Fence: 4
Updated-At: 2029-01-01T00:00:00Z"
before_state=$("$TD" chain-read "$REPO" preserve --json 2>/dev/null | jq -S \
  'del(.commit,.updatedAt,.reconcileLeaseOwner,.reconcileLeaseUntil,.reconcileFence)')
out=$("$TD" reconcile-lease "$REPO" preserve --owner=pass-B \
  --now=2030-02-01T00:00:00Z --fence=4 --json 2>/dev/null); rc=$?
after_state=$("$TD" chain-read "$REPO" preserve --json 2>/dev/null | jq -S \
  'del(.commit,.updatedAt,.reconcileLeaseOwner,.reconcileLeaseUntil,.reconcileFence)')
if [ "$rc" -eq 0 ] && printf '%s' "$out" | jq -e '.fence==5' >/dev/null \
    && [ "$before_state" = "$after_state" ] \
    && [ "$(field preserve repairIssue)" = 'creating@12345' ]; then
  ok "3: retained fence increments and every legacy/evidence field survives"
else
  bad "3: retained-fence acquisition rc=$rc out=$out"
fi

# A normal classifier write preserves fields it cannot directly mutate.
"$TD" chain-write "$REPO" preserve --for-sha="$C2" --state=red >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ "$(field preserve reconcileFence)" = 5 ] \
    && [ "$(field preserve reconcileLeaseOwner)" = pass-B ] \
    && [ "$(field preserve policyDigest)" = sha256:policy ]; then
  ok "4: chain-write preserves lease, registry, evidence, and diagnostics"
else
  bad "4: chain-write did not preserve new-format fields"
fi

# Live same-owner renewal requires and retains the matching fence.
out=$("$TD" reconcile-lease "$REPO" preserve --owner=pass-B \
  --now=2030-02-01T00:01:00Z --fence=5 --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | jq -e \
    '.reason=="renewed" and .fence==5 and .leaseUntil=="2030-02-01T00:06:00Z"' >/dev/null; then
  ok "5: matching live owner renews without incrementing the fence"
else
  bad "5: renewal rc=$rc out=$out"
fi

if expect_unchanged preserve 7 "$TD" reconcile-lease "$REPO" preserve \
    --owner=pass-B --now=2030-02-01T00:02:00Z \
  && expect_unchanged preserve 7 "$TD" reconcile-lease "$REPO" preserve \
    --owner=pass-B --now=2030-02-01T00:02:00Z --fence=4 \
  && expect_unchanged preserve 7 "$TD" reconcile-lease "$REPO" preserve \
    --owner=pass-C --now=2030-02-01T00:02:00Z --fence=5; then
  ok "6: missing/stale fences and a different live owner cannot mutate"
else
  bad "6: a live-lease refusal changed origin"
fi

# At now == lease-until the old lease is expired and takeover increments once.
out=$("$TD" reconcile-lease "$REPO" preserve --owner=pass-C \
  --now=2030-02-01T00:06:00Z --fence=5 --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | jq -e \
    '.reason=="acquired" and .fence==6' >/dev/null; then
  ok "7: exact expiry boundary permits fenced takeover"
else
  bad "7: expiry takeover rc=$rc out=$out"
fi

# Public chain-write cannot inject lines or mutate protected/derived fields.
forge_chain reject "Current-Head: $C1
State: red
Reconcile-Fence: 0"
if expect_unchanged reject 1 "$TD" chain-write "$REPO" reject --for-sha="$C2" --set Reconcile-Fence=9 \
  && expect_unchanged reject 1 "$TD" chain-write "$REPO" reject --for-sha="$C2" --set Current-Head="$C1" \
  && expect_unchanged reject 1 "$TD" chain-write "$REPO" reject --for-sha="$C2" --set $'State=red\nFirst-Red: forged' \
  && expect_unchanged reject 1 "$TD" chain-write "$REPO" reject --for-sha="$C2" --state=$'red\nFirst-Red: forged' \
  && expect_namespace_unchanged 1 "$TD" chain-write "$REPO" $'reject\nforged' --for-sha="$C2" \
  && expect_namespace_unchanged 1 "$TD" chain-write $'acme/widgets\nforged' reject --for-sha="$C2"; then
  ok "8: protected fields and every line-protocol injection path fail closed"
else
  bad "8: chain-write validation allowed a mutation"
fi

# Malformed CLI inputs are argument errors and create no absent ref.
for args in \
  '--owner=bad! --now=2030-01-01T00:00:00Z' \
  '--owner=pass --now=2030-1-1T00:00:00Z' \
  '--owner=pass --now=2030-01-01T00:00:00Z --fence=01' \
  '--owner=pass --now=9999-12-31T23:59:59Z'; do
  # shellcheck disable=SC2086 # deliberate fixed fixture argument splitting
  "$TD" reconcile-lease "$REPO" invalid $args >/dev/null 2>&1; rc=$?
  if [ "$rc" -ne 1 ] || [ -n "$(remote_sha invalid)" ]; then
    bad "9: invalid arguments mutated origin: $args (rc=$rc)"
  fi
done
[ "$FAIL" -eq 0 ] && ok "9: malformed and unrepresentable CLI inputs write nothing"

# Stored partial/duplicate tuples and exhausted fences fail closed.
forge_chain partial "Current-Head: $C1
State: red
Reconcile-Lease-Owner: old
Reconcile-Fence: 1"
forge_chain duplicate "Current-Head: $C1
State: red
Reconcile-Lease-Owner:
Reconcile-Lease-Until:
Reconcile-Fence: 1
Reconcile-Fence: 2"
forge_chain exhausted "Current-Head: $C1
State: red
Reconcile-Lease-Owner:
Reconcile-Lease-Until:
Reconcile-Fence: 999999999999999999"
if expect_unchanged partial 8 "$TD" reconcile-lease "$REPO" partial --owner=new --now=2030-01-01T00:00:00Z \
  && expect_unchanged duplicate 8 "$TD" reconcile-lease "$REPO" duplicate --owner=new --now=2030-01-01T00:00:00Z \
  && expect_unchanged exhausted 9 "$TD" reconcile-lease "$REPO" exhausted --owner=new --now=2030-01-01T00:00:00Z; then
  ok "10: malformed stored tuples and fence exhaustion fail without mutation"
else
  bad "10: malformed stored-state refusal changed origin"
fi

# Nonmatching supplied fence against a prior zero is a refusal, not acquisition.
forge_chain zero "Current-Head: $C1
State: red
Reconcile-Lease-Owner:
Reconcile-Lease-Until:
Reconcile-Fence: 0"
if expect_unchanged zero 7 "$TD" reconcile-lease "$REPO" zero \
    --owner=new --now=2030-01-01T00:00:00Z --fence=1; then
  ok "11: acquisition honors a supplied fence-zero precondition"
else
  bad "11: mismatched acquisition fence changed origin"
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
