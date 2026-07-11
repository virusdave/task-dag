#!/usr/bin/env bash
# Deterministic canonical-observation decision fixture. All refs and commits
# live in a throwaway bare origin; the collector is replaced by a typed fixture
# observation so this test exercises only atomic classification persistence.
set -uo pipefail

ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc" 2>/dev/null
cd "$ROOT/wc"
echo a >f; git add f; git commit -qm c1; C1=$(git rev-parse HEAD)
echo b >f; git commit -qam c2; C2=$(git rev-parse HEAD)
echo c >f; git commit -qam c3; C3=$(git rev-parse HEAD)
git push -q origin HEAD:master
EMPTY_TREE=$(git hash-object -t tree /dev/null)

RED='' GREEN='' YELLOW='' BLUE='' BOLD='' RESET=''
json_escape() { printf '%s' "$1" | jq -Rs .; }
# shellcheck source=../../scripts/task-dag.d/ci-chains.sh
source "$REPO_ROOT/scripts/task-dag.d/ci-chains.sh"
# shellcheck source=../../scripts/task-dag.d/ci-repair.sh
source "$REPO_ROOT/scripts/task-dag.d/ci-repair.sh"

REPO=acme/widgets
OBS_HEAD="$C1" OBS_MODE=enforce OBS_AGG=unknown OBS_REASON=grace-pending
OBS_DECISION=$(printf '1%.0s' {1..64}) OBS_POLICY=$(printf '2%.0s' {1..64})
OBS_EVIDENCE=$(printf '3%.0s' {1..64})
EVIDENCE='[{"appId":1,"appSlug":"github-actions","completedAt":null,"conclusion":null,"createdAt":null,"name":"Presubmit","runId":null,"startedAt":null,"status":"absent"}]'

_ci_repair_collect_evidence() {
    local encoded evidence_key decision_key branch="$2" ref failure='[]' evidence="$EVIDENCE"
    ref="$(_cichain_ref "$1" "$branch")"
    _CI_REPAIR_CHAIN_COMMIT="$(_cichain_remote_sha "$ref")" || return 2
    if [ "$OBS_AGG" = green ]; then
        evidence='[{"appId":1,"appSlug":"github-actions","completedAt":"2030-01-02T03:03:00Z","conclusion":"success","createdAt":"2030-01-02T03:00:00Z","name":"Presubmit","runId":"1","startedAt":"2030-01-02T03:01:00Z","status":"completed"}]'
    elif [ "$OBS_REASON" = nonaccepted ]; then
        evidence='[{"appId":1,"appSlug":"github-actions","completedAt":"2030-01-02T03:03:00Z","conclusion":"failure","createdAt":"2030-01-02T03:00:00Z","name":"Presubmit","runId":"1","startedAt":"2030-01-02T03:01:00Z","status":"completed"}]'
    fi
    encoded="$(printf '%s' "$evidence" | base64 -w0 | tr -d '=' | tr '/+' '_-')"
    evidence_key="$(jq -cnS --arg version ci-repair-evidence-v1 --arg head "$OBS_HEAD" \
      --arg policyDigest "sha256:$OBS_POLICY" --argjson evidence "$evidence" \
      '{version:$version,head:$head,policyDigest:$policyDigest,evidence:$evidence}' | _ci_repair_sha256)"
    decision_key="$(jq -cnS --arg version ci-repair-decision-v1 --arg evidenceKey "$evidence_key" \
      --arg firstSeen '2030-01-02T03:04:05Z' --arg deadline '2030-01-02T03:19:05Z' \
      --arg aggregate "$OBS_AGG" --arg reason "$OBS_REASON" --arg mode "$OBS_MODE" \
      '{version:$version,evidenceKey:$evidenceKey,firstSeen:$firstSeen,deadline:$deadline,aggregate:$aggregate,reason:$reason,enrollmentMode:$mode}' | _ci_repair_sha256)"
    if [ "$OBS_REASON" = grace-expired ]; then
        failure='[{"appId":1,"appSlug":"github-actions","category":"absent","conclusion":null,"name":"Presubmit"}]'
    elif [ "$OBS_REASON" = nonaccepted ]; then
        failure='[{"appId":1,"appSlug":"github-actions","category":"nonaccepted","conclusion":"failure","name":"Presubmit"}]'
    fi
    jq -cn --arg head "$OBS_HEAD" --arg mode "$OBS_MODE" --arg aggregate "$OBS_AGG" \
        --arg reason "$OBS_REASON" --arg decision "$decision_key" --arg branch "$branch" \
        --arg policy "sha256:$OBS_POLICY" --arg evidenceKey "$evidence_key" --arg evidence "$encoded" \
        --argjson failure "$failure" \
        '{outcome:"observation",authority:{commit:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",blob:"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",mode:$mode,branch:$branch,repositoryFound:true},head:$head,observedAt:"2030-01-02T03:04:05Z",headFirstSeenAt:"2030-01-02T03:04:05Z",deadline:"2030-01-02T03:19:05Z",policyDigest:$policy,requiredEvidence:$evidence,failureEvidence:$failure,evidenceKey:$evidenceKey,decisionKey:$decision,aggregate:$aggregate,reason:$reason}'
}
_ci_repair_verify_target_head() { [ "$3" = "$OBS_HEAD" ]; }

field() { cmd_chain_read "$REPO" "$1" --json 2>/dev/null | jq -r ".$2"; }
tip() { git ls-remote origin "$(_cichain_ref "$REPO" "$1")" | awk '{print $1}'; }

out=$(cmd_classify "$REPO" grace --canonical-observation --json); rc=$?
if [ "$rc" -eq 0 ] && jq -e '.action=="noop-unknown" and .applied' <<<"$out" >/dev/null \
    && [ "$(field grace observedHead)" = "$C1" ] && [ "$(field grace state)" = unknown ] \
    && [ -z "$(field grace currentHead)" ] && [ "$(field grace reconcileStatus)" = ok ]; then
  ok "1: unknown persists evidence and grace while preserving desired head"
else bad "1: unknown persistence rc=$rc out=$out"; fi

before=$(tip grace)
out=$(cmd_classify "$REPO" grace --canonical-observation --json); rc=$?
after=$(tip grace)
if [ "$rc" -eq 0 ] && [ "$before" = "$after" ] && jq -e '.action=="noop-decision" and (.applied|not)' <<<"$out" >/dev/null; then
  ok "2: identical decision creates no chain commit"
else bad "2: replay rc=$rc before=$before after=$after out=$out"; fi

OBS_AGG=red; OBS_REASON=grace-expired; OBS_DECISION=$(printf '4%.0s' {1..64})
out=$(cmd_classify "$REPO" grace --canonical-observation --json); rc=$?
if [ "$rc" -eq 0 ] && jq -e '.action=="open" and .ticket=="open"' <<<"$out" >/dev/null \
    && [ "$(field grace state)" = red ] && [ "$(field grace currentHead)" = "$C1" ]; then
  ok "3: grace expiry atomically opens the policy-red chain"
else bad "3: grace expiry rc=$rc out=$out"; fi

OBS_HEAD="$C2"; OBS_MODE=observe; OBS_AGG=green; OBS_REASON=all-accepted
OBS_DECISION=$(printf '5%.0s' {1..64}); OBS_POLICY=$(printf '6%.0s' {1..64})
out=$(cmd_classify "$REPO" grace --canonical-observation --json); rc=$?
if [ "$rc" -eq 0 ] && jq -e '.action=="noop-observe" and .ticket=="none"' <<<"$out" >/dev/null \
    && [ "$(field grace state)" = red ] && [ "$(field grace currentHead)" = "$C1" ] \
    && [ "$(field grace observedHead)" = "$C2" ] && [ "$(field grace enrollmentMode)" = observe ]; then
  ok "4: observe policy edit records evidence without changing desired red state"
else bad "4: observe preservation rc=$rc out=$out"; fi

OBS_MODE=enforce; OBS_DECISION=$(printf '7%.0s' {1..64})
out=$(cmd_classify "$REPO" grace --canonical-observation --json); rc=$?
if [ "$rc" -eq 0 ] && jq -e '.action=="close" and .ticket=="close"' <<<"$out" >/dev/null \
    && [ "$(field grace state)" = green ] && [ "$(field grace currentHead)" = "$C2" ]; then
  ok "5: observe-to-enforce replays the decision and closes on current green"
else bad "5: enforce replay rc=$rc out=$out"; fi

# Unknown must preserve an escalation-blocked desired state byte-for-byte.
cmd_chain_write "$REPO" blocked --for-sha="$C2" --state=blocked --first-red="$C1" \
    --repair-mode=continue --repair-attempt=4 >/dev/null
OBS_HEAD="$C2"; OBS_AGG=unknown; OBS_REASON=grace-pending
OBS_DECISION=$(printf '8%.0s' {1..64})
out=$(cmd_classify "$REPO" blocked --canonical-observation --json); rc=$?
if [ "$rc" -eq 0 ] && [ "$(field blocked state)" = blocked ] \
    && [ "$(field blocked currentHead)" = "$C2" ] && [ "$(field blocked repairAttempt)" = 4 ]; then
  ok "6: unknown observation preserves every blocked desired-state field"
else bad "6: blocked preservation rc=$rc out=$out"; fi

# A rewound/unrelated authoritative head cannot overwrite the desired chain.
git checkout -q --detach "$C1"
echo fork >f; git commit -qam fork; FORK=$(git rev-parse HEAD)
OBS_HEAD="$FORK"; OBS_AGG=red; OBS_REASON=nonaccepted
OBS_DECISION=$(printf '9%.0s' {1..64})
before=$(tip blocked)
cmd_classify "$REPO" blocked --canonical-observation --json >/dev/null 2>&1; rc=$?
after=$(tip blocked)
if [ "$rc" -eq 4 ] && [ "$before" = "$after" ]; then
  ok "7: non-fast-forward observation fails closed without a commit"
else bad "7: non-fast-forward rc=$rc before=$before after=$after"; fi

# Collector errors, including malformed policy/API/registry rollback outcomes,
# are not classification authority and cannot alter desired state.
_ci_repair_collect_evidence() { jq -cn '{outcome:"policy-invalid",error:"malformed-policy",authority:null}'; return 2; }
before=$(tip blocked)
cmd_classify "$REPO" blocked --canonical-observation --json >/dev/null 2>&1; rc=$?
after=$(tip blocked)
if [ "$rc" -eq 4 ] && [ "$before" = "$after" ]; then
  ok "8: invalid policy or evidence fails closed without desired-state mutation"
else bad "8: evidence failure rc=$rc before=$before after=$after"; fi

echo "-----"
echo "ci-repair-decisions: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
