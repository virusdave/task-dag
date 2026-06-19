#!/usr/bin/env bash
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
echo seed >seed; git add seed; git commit -qm seed; git push -q origin HEAD:master
HOST=$(hostname -s 2>/dev/null || echo unknown)

mk_task(){
  local name="$1" issue="${2:-1}" epic task short
  epic=$(git commit-tree "$(git rev-parse 'HEAD^{tree}')" -p HEAD -m "Task: epic $name

Issue: #$issue
Type: epic")
  task=$(git commit-tree "$(git rev-parse 'HEAD^{tree}')" -p "$epic" -m "Task: leaf $name

Issue: #$issue
Type: leaf")
  short=$(git rev-parse --short "$task")
  git update-ref "refs/heads/tasks/frontier/$short" "$task"
  git push -q origin "refs/heads/tasks/frontier/$short"
  printf '%s %s\n' "$task" "$short"
}

claim_msg(){
  local task="$1" host="$2" pid="$3" when="$4" ttl="$5" note="$6" msg
  msg="Claim: $note

Task-Commit: $task
Claimer: test
Claimer-Host: $host"
  [ -n "$pid" ] && msg="$msg
Claimer-PID: $pid"
  msg="$msg
Claimed-At: $when
TTL-Hours: $ttl"
  git commit-tree "$(git rev-parse "$task^{tree}")" -p "$task" -m "$msg"
}

activate(){
  local task="$1" short="$2" claim="$3"
  git update-ref -d "refs/heads/tasks/frontier/$short" 2>/dev/null || true
  git update-ref "refs/heads/tasks/active/$short" "$claim"
  git push -q origin ":refs/heads/tasks/frontier/$short" "refs/heads/tasks/active/$short"
}

remote_sha(){ git ls-remote origin "$1" | awk '{print $1; exit}'; }
past=$(date -u -d '2 days ago' +%Y-%m-%dT%H:%M:%SZ)
future=$(date -u -d '2 hours' +%Y-%m-%dT%H:%M:%SZ)
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

read -r LIVE LIVE_SHORT < <(mk_task live 1)
LIVE_CLAIM=$(claim_msg "$LIVE" "$HOST" $$ "$now" 1 live)
activate "$LIVE" "$LIVE_SHORT" "$LIVE_CLAIM"
"$TD" reap >/dev/null 2>&1
if [ "$(remote_sha "refs/heads/tasks/active/$LIVE_SHORT")" = "$LIVE_CLAIM" ] && [ -z "$(remote_sha "refs/heads/tasks/frontier/$LIVE_SHORT")" ]; then
  ok "live same-host pid claim is not reaped"
else
  bad "live claim was reaped"
fi

read -r DEADPID DEADPID_SHORT < <(mk_task deadpid 2)
DEADPID_CLAIM=$(claim_msg "$DEADPID" "$HOST" 2147483646 "$now" 12 deadpid)
activate "$DEADPID" "$DEADPID_SHORT" "$DEADPID_CLAIM"
"$TD" reap >/dev/null 2>&1
if [ -z "$(remote_sha "refs/heads/tasks/active/$DEADPID_SHORT")" ] && [ "$(remote_sha "refs/heads/tasks/frontier/$DEADPID_SHORT")" = "$DEADPID" ]; then
  ok "dead-by-pid leaf is reaped and frontier restored"
else
  bad "dead-by-pid leaf not reaped"
fi

read -r DEADTTL DEADTTL_SHORT < <(mk_task deadttl 3)
DEADTTL_CLAIM=$(claim_msg "$DEADTTL" otherhost "" "$past" 1 deadttl)
activate "$DEADTTL" "$DEADTTL_SHORT" "$DEADTTL_CLAIM"
"$TD" reap >/dev/null 2>&1
if [ -z "$(remote_sha "refs/heads/tasks/active/$DEADTTL_SHORT")" ] && [ "$(remote_sha "refs/heads/tasks/frontier/$DEADTTL_SHORT")" = "$DEADTTL" ]; then
  ok "dead-by-ttl leaf is reaped"
else
  bad "dead-by-ttl leaf not reaped"
fi

read -r INDET INDET_SHORT < <(mk_task indeterminate 4)
INDET_CLAIM=$(claim_msg "$INDET" otherhost "" "$future" 1 indet)
activate "$INDET" "$INDET_SHORT" "$INDET_CLAIM"
"$TD" reap >/dev/null 2>&1
if [ "$(remote_sha "refs/heads/tasks/active/$INDET_SHORT")" = "$INDET_CLAIM" ]; then
  ok "indeterminate claim is not reaped"
else
  bad "indeterminate claim reaped"
fi

read -r DRY DRY_SHORT < <(mk_task dryrun 5)
DRY_CLAIM=$(claim_msg "$DRY" "$HOST" 2147483646 "$now" 12 dryrun)
activate "$DRY" "$DRY_SHORT" "$DRY_CLAIM"
out=$("$TD" reap --dry-run 2>&1)
if echo "$out" | grep -q "Would reap leaf $DRY_SHORT" && [ "$(remote_sha "refs/heads/tasks/active/$DRY_SHORT")" = "$DRY_CLAIM" ]; then
  ok "dry-run reports but does not modify origin"
else
  bad "dry-run modified origin or did not report"
fi

ROOT_EPIC=$(git commit-tree "$(git rev-parse 'HEAD^{tree}')" -p HEAD -m "Task: root

Issue: #99
Type: epic")
git update-ref refs/heads/tasks/pending/99 "$ROOT_EPIC"
ROOT_CLAIM=$(claim_msg "$ROOT_EPIC" otherhost "" "$past" 1 root)
git update-ref refs/heads/tasks/root-active/99 "$ROOT_CLAIM"
git push -q origin refs/heads/tasks/pending/99 refs/heads/tasks/root-active/99
"$TD" reap >/dev/null 2>&1
if [ -z "$(remote_sha refs/heads/tasks/root-active/99)" ] && [ "$(remote_sha refs/heads/tasks/pending/99)" = "$ROOT_EPIC" ]; then
  ok "dead root-active is reaped and pending remains"
else
  bad "root reap failed"
fi

read -r LEASE LEASE_SHORT < <(mk_task lease 6)
LEASE_OLD=$(claim_msg "$LEASE" "$HOST" 2147483646 "$now" 12 lease-old)
LEASE_NEW=$(claim_msg "$LEASE" otherhost "" "$future" 1 lease-new)
activate "$LEASE" "$LEASE_SHORT" "$LEASE_OLD"
git update-ref "refs/heads/tasks/active/$LEASE_SHORT" "$LEASE_NEW"
git push -q --force origin "refs/heads/tasks/active/$LEASE_SHORT"
"$TD" reap --no-fetch >/dev/null 2>&1
if [ "$(remote_sha "refs/heads/tasks/active/$LEASE_SHORT")" = "$LEASE_NEW" ]; then
  ok "lease protects against changed active ref"
else
  bad "reap clobbered changed active ref"
fi

json=$("$TD" reap --json)
if command -v jq >/dev/null 2>&1; then
  if echo "$json" | jq -e 'type == "array"' >/dev/null; then
    ok "reap --json is valid JSON"
  else
    bad "reap --json invalid"
  fi
else
  ok "jq unavailable; skipped JSON parser check"
fi

echo "-----"; echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
