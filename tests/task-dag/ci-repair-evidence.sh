#!/usr/bin/env bash
# Deterministic read-only fixture for repair-reconcile authority/evidence
# internals. The fake GitHub API is paginated and every git ref is local.
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
echo seed >seed; git add seed; git commit -qm seed; git push -q origin HEAD:master
EMPTY_TREE=$(git hash-object -t tree /dev/null)

# Source only the private modules: the public task-dag executable always calls
# main, and this leaf deliberately does not register a partial public command.
# shellcheck source=../../scripts/task-dag.d/ci-chains.sh
source "$REPO_ROOT/scripts/task-dag.d/ci-chains.sh"
# shellcheck source=../../scripts/task-dag.d/ci-repair.sh
source "$REPO_ROOT/scripts/task-dag.d/ci-repair.sh"

mkdir -p "$ROOT/bin"
export REAL_DATE="$(command -v date)" REAL_SHA256SUM="$(command -v sha256sum)" REAL_JQ="$(command -v jq)"
cat >"$ROOT/bin/date" <<'EOF'
#!/usr/bin/env bash
if [ "$#" -eq 2 ] && [ "$1" = -u ] && [ "$2" = +%s ]; then
  echo 1893553445
elif [ "$#" -eq 2 ] && [ "$1" = -u ] && [[ "$2" == +%a,* ]]; then
  echo 'Wed, 02 Jan 2030 03:04:05 GMT'
else
  [ "${SCENARIO:-}" = date-render-failure ] && [ "$2" = -d ] && exit 1
  "$REAL_DATE" "$@"
fi
EOF
cat >"$ROOT/bin/sha256sum" <<'EOF'
#!/usr/bin/env bash
[ "${SCENARIO:-}" = canonical-failure ] && exit 1
"$REAL_SHA256SUM" "$@"
EOF
cat >"$ROOT/bin/jq" <<'EOF'
#!/usr/bin/env bash
args="$*"
[ "${SCENARIO:-}" = off-serialization-failure ] && [[ "$args" == *'{outcome:"off"'* ]] && exit 1
[ "${SCENARIO:-}" = grace-failure ] && [[ "$args" == *'-er .missingGateGraceSeconds | select'* ]] && exit 1
"$REAL_JQ" "$@"
EOF
cat >"$ROOT/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
endpoint="${*: -1}"
NOW=$(date -u +'%a, %d %b %Y %H:%M:%S GMT')
[ "${SCENARIO:-}" = clock-skew ] && NOW='Sat, 01 Jan 2000 00:00:00 GMT'
HEAD_SHA=2222222222222222222222222222222222222222
REGISTRY_SHA=1111111111111111111111111111111111111111
BLOB_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
POLICY_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

respond() { # <status> <json>
  printf 'HTTP/2.0 %s fixture\r\ndate: %s\r\n\r\n%s\n' "$1" "$NOW" "$2"
}
content_json() { # <sha> <content>
  jq -cn --arg sha "$1" --arg content "$(printf '%s' "$2" | base64 -w0)" \
    '{type:"file",encoding:"base64",sha:$sha,content:$content}'
}
policy='{"version":1,"missingGateGraceSeconds":900,"requiredChecks":[{"name":"Presubmit","appId":15368,"appSlug":"github-actions","acceptedConclusions":["success"]}]}'
registry='task-dag git@github-task-dag:virusdave/task-dag.git enforce master'

case "$SCENARIO" in
  off|off-serialization-failure) registry='task-dag git@github-task-dag:virusdave/task-dag.git' ;;
  slash-branch) registry='task-dag git@github-task-dag:virusdave/task-dag.git enforce release/v1' ;;
  utf8-branch) registry='task-dag git@github-task-dag:virusdave/task-dag.git enforce release/é' ;;
  malformed-registry) registry='task-dag git@github-task-dag:virusdave/task-dag.git observe' ;;
  malformed-policy) policy='{"version":1,"version":1,"missingGateGraceSeconds":900,"requiredChecks":[]}' ;;
  duplicate-checks) policy='{"version":1,"missingGateGraceSeconds":900,"requiredChecks":[{"name":"Presubmit","appId":15368,"appSlug":"github-actions","acceptedConclusions":["success"]},{"name":"Presubmit","appId":15368,"appSlug":"github-actions","acceptedConclusions":["success"]}]}' ;;
esac

case "$endpoint" in
  repos/virusdave/top-level/git/ref/heads/master)
    respond 200 "$(jq -cn --arg sha "$REGISTRY_SHA" '{object:{type:"commit",sha:$sha}}')" ;;
  repos/virusdave/top-level/contents/scripts/ephemeral_checkout.d/repos.conf?ref=*)
    respond 200 "$(content_json "$BLOB_SHA" "$registry")" ;;
  repos/virusdave/top-level/compare/*)
    [ "$SCENARIO" = rollback ] && respond 200 '{"status":"behind"}' || respond 200 '{"status":"ahead"}' ;;
  repos/virusdave/task-dag/git/ref/heads/master|repos/virusdave/task-dag/git/ref/heads/release%2Fv1|repos/virusdave/task-dag/git/ref/heads/release%2F%C3%A9)
    respond 200 "$(jq -cn --arg sha "$HEAD_SHA" '{object:{type:"commit",sha:$sha}}')" ;;
  repos/virusdave/task-dag/contents/.github/ci-repair-policy.json?ref=*)
    [ "$SCENARIO" = missing-policy ] && { respond 404 '{"message":"Not Found"}'; exit 1; }
    respond 200 "$(content_json "$POLICY_SHA" "$policy")" ;;
  repos/virusdave/task-dag/commits/*/check-runs?filter=all\&per_page=100\&page=1)
    [ "$SCENARIO" = api-failure ] && exit 1
    case "$SCENARIO" in
      missing|clock-skew|malformed-policy|duplicate-checks) respond 200 '{"total_count":0,"check_runs":[]}' ;;
      identity)
        respond 200 "$(jq -cn --arg head "$HEAD_SHA" '{total_count:1,check_runs:[{id:9,head_sha:$head,name:"Presubmit",app:{id:999,slug:"other"},status:"completed",conclusion:"success",created_at:"2026-01-01T00:00:00Z",started_at:"2026-01-01T00:00:01Z",completed_at:"2026-01-01T00:00:02Z"}]}')" ;;
      red)
        respond 200 "$(jq -cn --arg head "$HEAD_SHA" '{total_count:1,check_runs:[{id:10,head_sha:$head,name:"Presubmit",app:{id:15368,slug:"github-actions"},status:"completed",conclusion:"failure",created_at:"2026-01-01T00:00:00Z",started_at:"2026-01-01T00:00:01Z",completed_at:"2026-01-01T00:00:02Z"}]}')" ;;
      malformed-date)
        respond 200 "$(jq -cn --arg head "$HEAD_SHA" '{total_count:1,check_runs:[{id:10,head_sha:$head,name:"Presubmit",app:{id:15368,slug:"github-actions"},status:"completed",conclusion:"success",created_at:"2026-99-01T00:00:00Z",started_at:"2026-99-01T00:00:01Z",completed_at:"2026-99-01T00:00:02Z"}]}')" ;;
      duplicated-page|overlap|paginated)
        total=101; [ "$SCENARIO" = overlap ] && total=100
        jq -cn --arg head "$HEAD_SHA" --argjson total "$total" '{total_count:$total,check_runs:([{id:10,head_sha:$head,name:"Presubmit",app:{id:15368,slug:"github-actions"},status:"completed",conclusion:"success",created_at:"2026-01-01T00:00:00Z",started_at:"2026-01-01T00:00:01Z",completed_at:"2026-01-01T00:00:02Z"}] + [range(1;100) as $id | {id:(1000+$id),head_sha:$head,name:("Other-"+($id|tostring)),app:{id:15368,slug:"github-actions"},status:"completed",conclusion:"success",created_at:"2026-01-01T00:00:00Z",started_at:null,completed_at:"2026-01-01T00:00:02Z"}])}' >"${TMPDIR:-/tmp}/fake-gh-page.$$"
        respond 200 "$(cat "${TMPDIR:-/tmp}/fake-gh-page.$$")"; rm -f "${TMPDIR:-/tmp}/fake-gh-page.$$" ;;
      *)
        respond 200 "$(jq -cn --arg head "$HEAD_SHA" '{total_count:1,check_runs:[{id:10,head_sha:$head,name:"Presubmit",app:{id:15368,slug:"github-actions"},status:"completed",conclusion:"success",created_at:"2026-01-01T00:00:00Z",started_at:"2026-01-01T00:00:01Z",completed_at:"2026-01-01T00:00:02Z"}]}')" ;;
    esac ;;
  repos/virusdave/task-dag/commits/*/check-runs?filter=all\&per_page=100\&page=2)
    if [ "$SCENARIO" = paginated ]; then
      respond 200 "$(jq -cn --arg head "$HEAD_SHA" '{total_count:101,check_runs:[{id:9007199254740991,head_sha:$head,name:"Presubmit",app:{id:15368,slug:"github-actions"},status:"queued",conclusion:null,created_at:"2026-01-02T00:00:00Z",started_at:null,completed_at:null}]}')"
    elif [ "$SCENARIO" = duplicated-page ]; then
      respond 200 "$(jq -cn --arg head "$HEAD_SHA" '{total_count:101,check_runs:[{id:10,head_sha:$head,name:"Presubmit",app:{id:15368,slug:"github-actions"},status:"completed",conclusion:"success",created_at:"2026-01-01T00:00:00Z",started_at:"2026-01-01T00:00:01Z",completed_at:"2026-01-01T00:00:02Z"}]}')"
    elif [ "$SCENARIO" = overlap ]; then
      respond 200 "$(jq -cn --arg head "$HEAD_SHA" '{total_count:100,check_runs:[{id:10,head_sha:$head,name:"Presubmit",app:{id:15368,slug:"github-actions"},status:"completed",conclusion:"success",created_at:"2026-01-01T00:00:00Z",started_at:"2026-01-01T00:00:01Z",completed_at:"2026-01-01T00:00:02Z"}]}')"
    else
      respond 200 '{"total_count":0,"check_runs":[]}'
    fi ;;
  *) respond 404 '{"message":"fixture endpoint absent"}' ;;
esac
EOF
chmod +x "$ROOT/bin/gh"
chmod +x "$ROOT/bin/date" "$ROOT/bin/sha256sum" "$ROOT/bin/jq"
export PATH="$ROOT/bin:$PATH"

collect() {
  local scenario="$1" rc=0
  SCENARIO="$scenario" _ci_repair_collect_evidence virusdave/task-dag master || rc=$?
  return "$rc"
}
collect_branch() {
  local scenario="$1" branch="$2" rc=0
  SCENARIO="$scenario" _ci_repair_collect_evidence virusdave/task-dag "$branch" || rc=$?
  return "$rc"
}

out=$(collect green); rc=$?
if [ "$rc" -eq 0 ] && jq -e '.outcome=="observation" and .aggregate=="green"
    and .reason=="all-accepted" and .authority.mode=="enforce"
    and .policyDigest=="sha256:f3254ab0f3dead69aa7d520c1026c319cded6e7436c7e821777cd7c4d3019c8c"
    and .requiredEvidence=="W3siYXBwSWQiOjE1MzY4LCJhcHBTbHVnIjoiZ2l0aHViLWFjdGlvbnMiLCJjb21wbGV0ZWRBdCI6IjIwMjYtMDEtMDFUMDA6MDA6MDJaIiwiY29uY2x1c2lvbiI6InN1Y2Nlc3MiLCJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDAwOjAwOjAwWiIsIm5hbWUiOiJQcmVzdWJtaXQiLCJydW5JZCI6IjEwIiwic3RhcnRlZEF0IjoiMjAyNi0wMS0wMVQwMDowMDowMVoiLCJzdGF0dXMiOiJjb21wbGV0ZWQifV0"
    and .evidenceKey=="sha256:5900ec01887e7fe3d2c48d6f96167bd922f9d39dc116eab24d1c4a275ecdb3af"
    and .observedAt=="2030-01-02T03:04:05Z"
    and .headFirstSeenAt=="2030-01-02T03:04:05Z"
    and .deadline=="2030-01-02T03:19:05Z"
    and .decisionKey=="sha256:6be486f56842a079b9ef359c11e2b3adffbfcdc87a2070f3f40ddb04f146407f"' <<<"$out" >/dev/null; then
  ok "1: enrolled authority produces golden canonical green evidence and digests"
else bad "1: green evidence rc=$rc out=$out"; fi

out=$(collect paginated); rc=$?
decoded=$(jq -r .requiredEvidence <<<"$out" | tr '_-' '/+' | awk '{p=length($0)%4; if(p==2)$0=$0"=="; else if(p==3)$0=$0"="; print}' | base64 -d 2>/dev/null)
if [ "$rc" -eq 0 ] && jq -e '.aggregate=="unknown" and .reason=="grace-pending"' <<<"$out" >/dev/null \
    && jq -e '.[0].runId=="9007199254740991" and .[0].status=="queued"' <<<"$decoded" >/dev/null; then
  ok "2: pagination and lifecycle tuple select the newer nonterminal rerun losslessly"
else bad "2: paginated rerun rc=$rc out=$out decoded=$decoded"; fi

for spec in \
  'malformed-policy policy-invalid malformed-policy' \
  'duplicate-checks policy-invalid malformed-policy' \
  'identity policy-invalid identity-mismatch' \
  'missing-policy policy-invalid policy-missing' \
  'api-failure evidence-error api-failure' \
  'clock-skew evidence-error clock-skew' \
  'date-render-failure evidence-error missing-or-invalid-date' \
  'malformed-date evidence-error malformed-check-run' \
  'duplicated-page evidence-error inconsistent-pagination' \
  'canonical-failure evidence-error canonicalization-failed' \
  'malformed-registry evidence-error malformed-registry'; do
  read -r scenario outcome error <<<"$spec"
  out=$(collect "$scenario"); rc=$?
  if [ "$rc" -eq 2 ] && jq -e --arg o "$outcome" --arg e "$error" \
      '.outcome==$o and .error==$e' <<<"$out" >/dev/null; then
    ok "strict failure: $scenario -> $outcome/$error"
  else bad "strict failure: $scenario rc=$rc out=$out"; fi
done

out=$(collect off); rc=$?
if [ "$rc" -eq 0 ] && jq -e '.outcome=="off" and .authority.mode=="off"' <<<"$out" >/dev/null; then
  ok "9: exact two-column registry row resolves to off without target evidence"
else bad "9: off authority rc=$rc out=$out"; fi

out=$(collect off-serialization-failure); rc=$?
if [ "$rc" -eq 2 ] && jq -e '.error=="canonicalization-failed"' <<<"$out" >/dev/null; then
  ok "9b: failed off serialization cannot emit a successful outcome"
else bad "9b: off serialization failure rc=$rc out=$out"; fi

out=$(collect grace-failure); rc=$?
if [ "$rc" -eq 2 ] && jq -e '.error=="canonicalization-failed"' <<<"$out" >/dev/null; then
  ok "9c: failed grace extraction cannot fabricate terminal evidence"
else bad "9c: grace extraction failure rc=$rc out=$out"; fi

out=$(_ci_repair_collect_evidence virusdave/task-dag master enforce 2>/dev/null); rc=$?
if [ "$rc" -eq 2 ] && jq -e '.error=="caller-authority-rejected"' <<<"$out" >/dev/null; then
  ok "10: caller-supplied mode or generation is rejected"
else bad "10: caller authority rejection rc=$rc out=$out"; fi

out=$(collect_branch slash-branch release/v1); rc=$?
if [ "$rc" -eq 0 ] && jq -e '.outcome=="observation" and .authority.branch=="release/v1"' <<<"$out" >/dev/null; then
  ok "11: URL-special branch names are encoded for the GitHub ref endpoint"
else bad "11: encoded branch rc=$rc out=$out"; fi

out=$(collect_branch utf8-branch release/é); rc=$?
if [ "$rc" -eq 0 ] && jq -e '.outcome=="observation" and .authority.branch=="release/é"' <<<"$out" >/dev/null; then
  ok "12: non-ASCII branches are percent-encoded as UTF-8 bytes"
else bad "12: UTF-8 encoded branch rc=$rc out=$out"; fi

out=$(collect overlap); rc=$?
if [ "$rc" -eq 0 ] && jq -e '.aggregate=="green"' <<<"$out" >/dev/null; then
  ok "13: identical pagination overlap is accepted when unique IDs are complete"
else bad "13: pagination overlap rc=$rc out=$out"; fi

# Seed a complete stored authority tuple whose generation is not current; the
# fake compare endpoint reports rollback, which must fail before target reads.
chain_ref=$(_cichain_ref virusdave/task-dag master)
chain=$(cat <<EOF | git commit-tree "$EMPTY_TREE"
CI-Chain: virusdave/task-dag@master

Registry-Commit: 9999999999999999999999999999999999999999
Registry-Blob: 8888888888888888888888888888888888888888
Enrollment-Mode: enforce
EOF
)
git push -q origin "$chain:$chain_ref"
out=$(collect rollback); rc=$?
if [ "$rc" -eq 2 ] && jq -e '.error=="registry-rollback"' <<<"$out" >/dev/null \
    && ! git show-ref --verify --quiet "$chain_ref"; then
  ok "14: registry rollback fails closed without creating a local chain ref"
else bad "14: registry rollback rc=$rc out=$out"; fi

# A partial stored observation tuple is invalid and cannot reset grace.
partial=$(cat <<EOF | git commit-tree "$EMPTY_TREE" -p "$chain"
CI-Chain: virusdave/task-dag@master

Observed-Head: malformed
Registry-Commit: 1111111111111111111111111111111111111111
Registry-Blob: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Enrollment-Mode: enforce
EOF
)
git push -q --force origin "$partial:$chain_ref"
out=$(collect green); rc=$?
if [ "$rc" -eq 2 ] && jq -e '.error=="stored-authority-invalid"' <<<"$out" >/dev/null; then
  ok "15: malformed or partial stored observations fail closed"
else bad "15: malformed stored observation rc=$rc out=$out"; fi

# Same-head durable first-seen drives a missing check red after grace instead
# of silently resetting the deadline. Use current API time minus one hour.
first_seen=$(date -u -d '1 hour ago' +'%Y-%m-%dT%H:%M:%SZ')
observed=$(date -u -d '30 minutes ago' +'%Y-%m-%dT%H:%M:%SZ')
chain=$(cat <<EOF | git commit-tree "$EMPTY_TREE" -p "$chain"
CI-Chain: virusdave/task-dag@master

Observed-Head: 2222222222222222222222222222222222222222
Head-First-Seen-At: $first_seen
Observed-At: $observed
Registry-Commit: 1111111111111111111111111111111111111111
Registry-Blob: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Enrollment-Mode: enforce
EOF
)
git push -q --force origin "$chain:$chain_ref"
out=$(collect missing); rc=$?
if [ "$rc" -eq 0 ] && jq -e --arg first "$first_seen" \
    '.aggregate=="red" and .reason=="grace-expired" and .headFirstSeenAt==$first' <<<"$out" >/dev/null; then
  ok "16: durable first-seen makes delayed/missing checks red at the grace deadline"
else bad "16: grace expiry rc=$rc out=$out"; fi

echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
