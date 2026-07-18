#!/usr/bin/env bash
set -uo pipefail
TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0 FAIL=0
ok() { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.test GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.test
git init -q "$ROOT/repo"; cd "$ROOT/repo" || exit 1
# shellcheck source=../../scripts/task-dag.d/comment-watchdog.sh
source "$(dirname "$TD")/task-dag.d/comment-watchdog.sh"

activation='{"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","epoch":1,"guardVersion":1}'
registry=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
reviewed=$(printf '%s' '[{"ingestionStartAt":"2026-06-01T00:00:00Z","repository":"virusdave/top-level"}]' | sha256sum | awk '{print $1}')
runtime1=1111111111111111111111111111111111111111
runtime2=2222222222222222222222222222222222222222
cycle=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
append_record() {
    local record=$1 seq path tree commit type last_attempt=${LAST_ATTEMPT:-none} recent_success=${RECENT_SUCCESS:-none} complete_success=${COMPLETE_SUCCESS:-none}
    seq=$(jq -r .sequence <<<"$record"); path=$(printf 'records/%016d.json' "$seq")
    git read-tree --empty
    mkdir -p "$(dirname "$path")"; printf '%s\n' "$record" >"$path"; git add "$path"
    type=$(jq -r .type <<<"$record"); [[ "$type" != attempt ]] || last_attempt=$(jq -r .observedAt <<<"$record")
    if [[ "$type" == fleet && "$(jq -r .success <<<"$record")" == true ]]; then
        [[ "$(jq -r .mode <<<"$record")" != recent ]] || recent_success=$(jq -r .completedAt <<<"$record")
        [[ "$(jq -r .mode <<<"$record")" != complete ]] || complete_success=$(jq -r .completedAt <<<"$record")
    fi
    tree=$(git write-tree); commit=$(printf 'record\n\nWatchdog-Last-Attempt: %s\nWatchdog-Recent-Success: %s\nWatchdog-Complete-Success: %s\n' "$last_attempt" "$recent_success" "$complete_success" | { [[ -n "${TIP:-}" ]] && git commit-tree "$tree" -p "$TIP" || git commit-tree "$tree"; })
    LAST_ATTEMPT=$last_attempt RECENT_SUCCESS=$recent_success COMPLETE_SUCCESS=$complete_success
    TIP=$commit
}
lease() {
    jq -ncS --argjson sequence "$1" --arg holder "$2" --argjson fence "$3" --arg runtime "$4" --arg acquired "$5" --arg observed "$6" --arg expires "$7" --arg registry "$registry" --arg reviewed "$reviewed" --argjson activation "$activation" '{schema:1,type:"lease",sequence:$sequence,holder:$holder,fence:$fence,runtimeCommit:$runtime,registrySnapshotId:$registry,reviewedRegistryDigest:$reviewed,coordinationRepository:"virusdave/top-level",activation:$activation,acquiredAt:$acquired,observedAt:$observed,expiresAt:$expires}'
}
result() {
    local base=$1 sequence=$2 observed=$3
    jq -ncS --argjson lease "$base" --argjson sequence "$sequence" --arg observed "$observed" --arg cycle "$cycle" '$lease+{type:"result",sequence:$sequence,observedAt:$observed,cycle:$cycle,repository:"virusdave/top-level",result:{mode:"recent",status:"success",dryRun:false,exhausted:true,applied:0,deferred:0,failures:0}}'
}

r0=$(lease 0 holder-a 1 "$runtime1" 2026-07-18T00:00:00Z 2026-07-18T00:00:00Z 2026-07-18T00:05:00Z); append_record "$r0"
r1=$(jq -ncS --argjson lease "$r0" --arg cycle "$cycle" '$lease+{type:"attempt",sequence:1,observedAt:"2026-07-18T00:01:00Z",cycle:$cycle,mode:"recent",registry:[{ingestionStartAt:"2026-06-01T00:00:00Z",repository:"virusdave/top-level"}]}'); append_record "$r1"
r2=$(result "$r0" 2 2026-07-18T00:02:00Z); append_record "$r2"
r3=$(lease 3 holder-a 1 "$runtime1" 2026-07-18T00:00:00Z 2026-07-18T00:03:00Z 2026-07-18T00:06:00Z); append_record "$r3"
r4=$(jq -ncS --argjson lease "$r3" --arg cycle "$cycle" '$lease+{type:"fleet",sequence:4,observedAt:"2026-07-18T00:04:00Z",completedAt:"2026-07-18T00:04:00Z",cycle:$cycle,mode:"recent",repositories:["virusdave/top-level"],success:true}'); append_record "$r4"
r5=$(lease 5 holder-b 2 "$runtime2" 2026-07-18T00:07:00Z 2026-07-18T00:07:00Z 2026-07-18T00:12:00Z); append_record "$r5"
taskdag_comment_watchdog_validate_tip "$TIP" && ok "valid renew, result, and expired takeover history" || bad "valid history rejected"
git update-ref refs/heads/tasks/v1/comment-watchdog "$TIP"
"$TD" validate --strict >/dev/null 2>&1 && ok "strict audit accepts exact watchdog authority" || bad "strict audit rejected watchdog authority"

bad_result=$(result "$r5" 6 2026-07-18T00:08:00Z | jq -cS '.fence=1'); append_record "$bad_result"
if taskdag_comment_watchdog_validate_tip "$TIP"; then bad "stale result fence accepted"; else ok "stale result fence rejected"; fi

cd "$ROOT" || exit 1
"$TD" comment-watchdog --help | grep -q '^Usage:' && ok "command has effect-free help" || bad "command help"
echo "PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]
