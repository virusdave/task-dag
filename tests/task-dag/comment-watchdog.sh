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
activation_v2='{"commit":"dddddddddddddddddddddddddddddddddddddddd","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","epoch":1,"guardVersion":1,"minimumCompatibleTaskDagCommit":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}'
registry=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
reviewed=$(printf '%s' '[{"ingestionStartAt":"2026-06-01T00:00:00Z","repository":"virusdave/top-level"}]' | sha256sum | awk '{print $1}')
runtime1=1111111111111111111111111111111111111111
runtime2=2222222222222222222222222222222222222222
cycle=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
cat >"$ROOT/reviewed.json" <<'EOF'
{"schema":1,"repositories":[{"ingestionStartAt":"2026-06-01T00:00:00Z","name":"top-level","repository":"virusdave/top-level"}]}
EOF
activation_record='{"registrySnapshot":{"repositories":[{"repository":"virusdave/task-dag"},{"repository":"virusdave/top-level"}]}}'
if _taskdag_comment_watchdog_registry_allowed "$activation_record" "$ROOT/reviewed.json" virusdave/top-level; then
    ok "reviewed watchdog registry may be a strict activation subset"
else bad "valid strict activation subset rejected"; fi
if _taskdag_comment_watchdog_registry_allowed "$activation_record" "$ROOT/reviewed.json" virusdave/missing; then
    bad "coordination repository outside reviewed registry accepted"
else ok "coordination repository must be reviewed"; fi
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

r6=$(lease 6 holder-c 3 "$runtime2" 2026-07-18T00:12:00Z 2026-07-18T00:12:00Z 2026-07-18T00:17:00Z | jq -cS --argjson activation "$activation_v2" '.schema=2 | .activation=$activation | .activationGeneration=1')
LAST_ATTEMPT=none; RECENT_SUCCESS=none; COMPLETE_SUCCESS=none; append_record "$r6"
if taskdag_comment_watchdog_validate_tip "$TIP"; then ok "v1 to v2 rollover after expiry resets watermarks"; else bad "valid v1 to v2 rollover rejected"; fi
schema2_genesis=$(jq -cS '.sequence=0' <<<"$r6")
if _taskdag_comment_watchdog_validate_lease_transition "" "$schema2_genesis"; then bad "schema-v2 genesis accepted"; else ok "schema-v2 genesis rejected"; fi
pre_expiry=$(jq -cS '.sequence=6 | .acquiredAt="2026-07-18T00:11:00Z" | .observedAt="2026-07-18T00:11:00Z"' <<<"$r6")
if _taskdag_comment_watchdog_validate_lease_transition "$r5" "$pre_expiry"; then bad "pre-expiry v1 to v2 accepted"; else ok "pre-expiry v1 to v2 rejected"; fi
changed_coordination=$(jq -cS '.coordinationRepository="virusdave/other"' <<<"$r6")
if _taskdag_comment_watchdog_validate_lease_transition "$r5" "$changed_coordination"; then bad "coordination repository mutation accepted"; else ok "coordination repository mutation rejected"; fi

r7=$(jq -ncS --argjson lease "$r6" --arg cycle "$cycle" '$lease+{type:"attempt",sequence:7,observedAt:"2026-07-18T00:13:00Z",cycle:$cycle,mode:"recent",registry:[{ingestionStartAt:"2026-06-01T00:00:00Z",repository:"virusdave/top-level"}]}'); append_record "$r7"
r8=$(result "$r6" 8 2026-07-18T00:14:00Z); append_record "$r8"
r9=$(jq -ncS --argjson lease "$r6" --arg cycle "$cycle" '$lease+{type:"fleet",sequence:9,observedAt:"2026-07-18T00:15:00Z",completedAt:"2026-07-18T00:15:00Z",cycle:$cycle,mode:"recent",repositories:["virusdave/top-level"],success:true}'); append_record "$r9"
r10c=$(jq -ncS --argjson lease "$r6" --arg cycle "$cycle" '$lease+{type:"attempt",sequence:10,observedAt:"2026-07-18T00:15:30Z",cycle:$cycle,mode:"complete",registry:[{ingestionStartAt:"2026-06-01T00:00:00Z",repository:"virusdave/top-level"}]}'); append_record "$r10c"
r11c=$(result "$r6" 11 2026-07-18T00:16:00Z | jq -cS '.result.mode="complete"'); append_record "$r11c"
r12c=$(jq -ncS --argjson lease "$r6" --arg cycle "$cycle" '$lease+{type:"fleet",sequence:12,observedAt:"2026-07-18T00:16:30Z",completedAt:"2026-07-18T00:16:30Z",cycle:$cycle,mode:"complete",repositories:["virusdave/top-level"],success:true}'); append_record "$r12c"
tip_success=$TIP
r10=$(lease 13 holder-d 4 "$runtime2" 2026-07-18T00:17:00Z 2026-07-18T00:17:00Z 2026-07-18T00:22:00Z | jq -cS --argjson activation "$activation_v2" '.schema=2 | .activation=$activation | .activationGeneration=1')
append_record "$r10"
if taskdag_comment_watchdog_validate_tip "$TIP"; then ok "same generation takeover preserves current watermarks"; else bad "same generation takeover rejected"; fi
same_tuple_increment=$(jq -cS '.activationGeneration=2' <<<"$r10")
if _taskdag_comment_watchdog_validate_lease_transition "$r6" "$same_tuple_increment"; then bad "same tuple generation increment accepted"; else ok "same tuple generation increment rejected"; fi
changed_tuple_same_generation=$(jq -cS --arg runtime "$runtime1" '.runtimeCommit=$runtime' <<<"$r10")
if _taskdag_comment_watchdog_validate_lease_transition "$r6" "$changed_tuple_same_generation"; then bad "changed tuple without generation increment accepted"; else ok "changed tuple without generation increment rejected"; fi
v2_to_v1=$(jq -cS 'del(.activationGeneration) | .schema=1 | .activation={digest:.activation.digest,epoch:.activation.epoch,guardVersion:.activation.guardVersion}' <<<"$r10")
if _taskdag_comment_watchdog_validate_lease_transition "$r6" "$v2_to_v1"; then bad "v2 to v1 transition accepted"; else ok "v2 to v1 transition rejected"; fi

r11=$(lease 14 holder-e 5 "$runtime1" 2026-07-18T00:22:00Z 2026-07-18T00:22:00Z 2026-07-18T00:27:00Z | jq -cS --argjson activation "$activation_v2" '.schema=2 | .activation=$activation | .activationGeneration=2')
LAST_ATTEMPT=none; RECENT_SUCCESS=none; COMPLETE_SUCCESS=none; append_record "$r11"
if taskdag_comment_watchdog_validate_tip "$TIP"; then ok "changed generation increments and clears stale watermarks"; else bad "changed generation rollover rejected"; fi

# Exercise the production trailer writer rather than only the fixture commit
# helper: same-generation takeover preserves all watermarks; changed generation
# clears all three.
taskdag_activation_fenced_multi_push() { :; }
same_commit=$(_taskdag_comment_watchdog_append '{}' "$tip_success" "$r10" holder-d acquire)
if [ "$(git show -s --format='%(trailers:key=Watchdog-Last-Attempt,valueonly)' "$same_commit")" = 2026-07-18T00:15:30Z ] \
  && [ "$(git show -s --format='%(trailers:key=Watchdog-Recent-Success,valueonly)' "$same_commit")" = 2026-07-18T00:15:00Z ] \
  && [ "$(git show -s --format='%(trailers:key=Watchdog-Complete-Success,valueonly)' "$same_commit")" = 2026-07-18T00:16:30Z ]; then
    ok "production append preserves same-generation watermarks"
else bad "production append lost same-generation watermarks"; fi
changed_commit=$(_taskdag_comment_watchdog_append '{}' "$same_commit" "$r11" holder-e acquire)
if git show -s --format=%B "$changed_commit" | grep -Fxq 'Watchdog-Last-Attempt: none' \
  && git show -s --format=%B "$changed_commit" | grep -Fxq 'Watchdog-Recent-Success: none' \
  && git show -s --format=%B "$changed_commit" | grep -Fxq 'Watchdog-Complete-Success: none'; then
    ok "production append clears changed-generation watermarks"
else bad "production append retained stale generation watermarks"; fi

bad_result=$(result "$r11" 15 2026-07-18T00:23:00Z | jq -cS '.fence=1'); append_record "$bad_result"
if taskdag_comment_watchdog_validate_tip "$TIP"; then bad "stale result fence accepted"; else ok "stale result fence rejected"; fi

cd "$ROOT" || exit 1
"$TD" comment-watchdog --help | grep -q '^Usage:' && ok "command has effect-free help" || bad "command help"
echo "PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]
