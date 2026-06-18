#!/usr/bin/env bash
# Fixture test for the enriched `task-dag blocked --json` output that the
# operator-blocked #29 dashboard consumes (virusdave/top-level#29, epic
# operator-blocked-aggregator task @4).
#
# The dashboard must be able to render purely from `blocked --json`
# WITHOUT reparsing any commit body, so this exercises:
#   * a regular task commit (Issue:/URL: trailers) blocked with operator
#     metadata: repo/issue/issueUrl/kind/reason/requestUrl/blockedAt/
#     blockedBy/hasMeta all present and correct;
#   * a --downstream block sets kind=downstream;
#   * an ingested-comment task node (YAML github.url, no Issue:/URL:
#     trailers) derives repo/issue/issueUrl into the JSON;
#   * a LEGACY block (overlay ref, no blocked-meta) reports kind=unknown,
#     hasMeta=false, null reason/requestUrl/blockedAt, and best-effort
#     repo/issue/issueUrl from the task commit;
#   * --operator / --downstream / --kind=unknown filtering;
#   * the emitted JSON is valid (parses with jq) and string fields with
#     embedded quotes are escaped (no broken JSON).
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

command -v jq >/dev/null 2>&1 || { echo "jq is required for this test"; echo "PASS=0 FAIL=1"; exit 1; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_CLAIMER=alice TASK_DAG_CLAIMER_HOST=host7

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc" 2>/dev/null
cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master 2>/dev/null

EMPTY_TREE=$(git hash-object -t tree /dev/null)
EPIC=$(git commit-tree "$EMPTY_TREE" -p HEAD -m "Task: Test epic

Issue: #777
URL: https://github.com/acme/widgets/issues/777
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/gh/issues/777 "$EPIC"
git update-ref refs/heads/tasks/pending/777 "$EPIC"
git push -q origin refs/heads/gh/issues/777 refs/heads/tasks/pending/777 2>/dev/null

mk_task() {  # prints the new leaf task short sha
  local title="$1"
  printf '[{"title":"%s","type":"leaf"}]' "$title" > "$ROOT/spec.json"
  # Decomposing the epic root requires (and consumes) the orchestration
  # lock (issue #2). --force re-acquires it for each incremental breakdown.
  "$TD" claim-root 777 --force >/dev/null 2>&1
  "$TD" breakdown "$EPIC" --spec-file="$ROOT/spec.json" --force --json 2>/dev/null \
    | grep -oE '"shortSha":"[0-9a-f]+"' | head -1 | cut -d'"' -f4
}

# jq selector for the object whose .shortSha == $s in the blocked --json array.
sel() { jq -e --arg s "$1" '.[] | select(.shortSha==$s)'; }

# ---------------------------------------------------------------------------
# TEST 1: a regular task, operator-blocked with full metadata, round-trips
# every enriched field into blocked --json.
T1=$(mk_task "operator-blocked regular task")
[ -n "$T1" ] || { echo "could not create task"; echo "PASS=0 FAIL=1"; exit 1; }
T1_FULL=$(git rev-parse "refs/heads/tasks/frontier/$T1")
"$TD" block "$T1" --reason="awaiting go/no-go" \
    --request-url="https://github.com/acme/widgets/issues/777#issuecomment-5" >/dev/null 2>&1

JSON=$("$TD" blocked --issue=777 --no-fetch --json 2>/dev/null)
if echo "$JSON" | jq -e . >/dev/null 2>&1; then
  ok "1: blocked --json emits valid JSON"
else
  bad "1: blocked --json is not valid JSON"
  echo "$JSON"
fi

OBJ=$(echo "$JSON" | sel "$T1") || OBJ=""
check() {  # $1 jq-filter $2 expected $3 label
  local got; got=$(echo "$OBJ" | jq -r "$1" 2>/dev/null)
  if [ "$got" = "$2" ]; then ok "1: $3"; else bad "1: $3 (got '$got', want '$2')"; fi
}
check '.sha'        "$T1_FULL"                                              "full sha"
check '.shortSha'   "$T1"                                                   "short sha"
check '.title'      "operator-blocked regular task"                        "title"
check '.issue'      "777"                                                  "issue number"
check '.repo'       "acme/widgets"                                         "derived repo"
check '.issueUrl'   "https://github.com/acme/widgets/issues/777"          "issue url"
check '.kind'       "operator"                                            "default operator kind"
check '.reason'     "awaiting go/no-go"                                   "durable reason"
check '.requestUrl' "https://github.com/acme/widgets/issues/777#issuecomment-5" "request url"
check '.blockedBy'  "alice"                                              "blocked actor"
check '.hasMeta'    "true"                                               "hasMeta true"
if [ -n "$(echo "$OBJ" | jq -r '.blockedAt // empty')" ]; then
  ok "1: blockedAt present"
else
  bad "1: blockedAt missing"
fi

# TEST 2: --downstream block reports kind=downstream.
T2=$(mk_task "downstream-blocked task")
"$TD" block "$T2" --downstream --reason="waiting on child epic" >/dev/null 2>&1
K=$("$TD" blocked --issue=777 --no-fetch --json 2>/dev/null | sel "$T2" | jq -r '.kind')
[ "$K" = "downstream" ] && ok "2: --downstream sets kind=downstream" \
                        || bad "2: kind was '$K' (want downstream)"

# TEST 3: a legacy block (overlay ref only, NO meta) reports kind=unknown,
# hasMeta=false, null reason/requestUrl/blockedAt, and best-effort origin.
T3=$(mk_task "legacy blocked task")
T3_FULL=$(git rev-parse "refs/heads/tasks/frontier/$T3")
git update-ref "refs/heads/tasks/blocked/$T3_FULL" "$T3_FULL"
git push -q origin "refs/heads/tasks/blocked/$T3_FULL:refs/heads/tasks/blocked/$T3_FULL" 2>/dev/null
L=$("$TD" blocked --issue=777 --no-fetch --json 2>/dev/null | sel "$T3") || L=""
lcheck() { local got; got=$(echo "$L" | jq -r "$1" 2>/dev/null); [ "$got" = "$2" ] && ok "3: $3" || bad "3: $3 (got '$got', want '$2')"; }
lcheck '.kind'      "unknown"        "legacy kind=unknown"
lcheck '.hasMeta'   "false"          "legacy hasMeta=false"
lcheck '.reason'    "null"           "legacy reason null"
lcheck '.requestUrl' "null"          "legacy requestUrl null"
lcheck '.blockedAt' "null"           "legacy blockedAt null"
lcheck '.repo'      "acme/widgets"   "legacy repo derived from task commit"
lcheck '.issue'     "777"            "legacy issue derived from task commit"
lcheck '.issueUrl'  "https://github.com/acme/widgets/issues/777" "legacy issueUrl derived"

# TEST 4: an ingested-comment task node (YAML body, no Issue:/URL: trailers)
# derives repo/issue/issueUrl into the JSON.
CTASK=$(git commit-tree "$EMPTY_TREE" -p "$EPIC" -m "kind: message
role: human
intent: comment

issue:
  number: 777

github:
  comment_id: 99
  actor: tester
  url: https://github.com/acme/widgets/issues/777#issuecomment-99

message_id: msg_1_99

body: |
  please decide")
CSHORT=$(git rev-parse --short "$CTASK")
git update-ref "refs/heads/tasks/frontier/$CSHORT" "$CTASK"
git push -q origin "refs/heads/tasks/frontier/$CSHORT:refs/heads/tasks/frontier/$CSHORT" 2>/dev/null
"$TD" block "$CSHORT" --reason="needs operator clarification" >/dev/null 2>&1
C=$("$TD" blocked --issue=777 --no-fetch --json 2>/dev/null | sel "$CSHORT") || C=""
ccheck() { local got; got=$(echo "$C" | jq -r "$1" 2>/dev/null); [ "$got" = "$2" ] && ok "4: $3" || bad "4: $3 (got '$got', want '$2')"; }
ccheck '.repo'     "acme/widgets" "ingested-comment repo"
ccheck '.issue'    "777"          "ingested-comment issue"
ccheck '.issueUrl' "https://github.com/acme/widgets/issues/777#issuecomment-99" "ingested-comment issueUrl"
ccheck '.kind'     "operator"     "ingested-comment kind operator"

# TEST 5: --operator / --downstream / --kind=unknown filtering.
# Now blocked: T1 (operator), CTASK (operator), T2 (downstream), T3 (unknown/legacy).
OPS=$("$TD" blocked --issue=777 --no-fetch --json --operator 2>/dev/null)
if echo "$OPS" | jq -e --arg a "$T1" --arg b "$CSHORT" --arg c "$T2" --arg d "$T3" '
      ([.[].shortSha] | sort) as $s
      | ($s | index($a)) and ($s | index($b))
      and ($s | index($c) | not) and ($s | index($d) | not)' >/dev/null 2>&1; then
  ok "5: --operator lists only operator-kind tasks"
else
  bad "5: --operator filter wrong: $(echo "$OPS" | jq -c '[.[].shortSha]')"
fi
DOWN=$("$TD" blocked --issue=777 --no-fetch --json --downstream 2>/dev/null)
if [ "$(echo "$DOWN" | jq -r '[.[].shortSha]==["'"$T2"'"]')" = "true" ]; then
  ok "5: --downstream lists only the downstream task"
else
  bad "5: --downstream filter wrong: $(echo "$DOWN" | jq -c '[.[].shortSha]')"
fi
UNK=$("$TD" blocked --issue=777 --no-fetch --json --kind=unknown 2>/dev/null)
if [ "$(echo "$UNK" | jq -r '[.[].shortSha]==["'"$T3"'"]')" = "true" ]; then
  ok "5: --kind=unknown lists only the legacy task"
else
  bad "5: --kind=unknown filter wrong: $(echo "$UNK" | jq -c '[.[].shortSha]')"
fi

# TEST 6: an invalid --kind value is rejected.
if "$TD" blocked --kind=bogus --no-fetch --json >/dev/null 2>&1; then
  bad "6: blocked accepted an invalid --kind"
else
  ok "6: blocked rejects an invalid --kind"
fi

# TEST 7: string fields with embedded double quotes are JSON-escaped so the
# output still parses (a dashboard must never choke on a quoted reason).
T7=$(mk_task "quote test task")
"$TD" block "$T7" --reason='he said "ship it" now' >/dev/null 2>&1
Q=$("$TD" blocked --issue=777 --no-fetch --json 2>/dev/null)
if echo "$Q" | jq -e . >/dev/null 2>&1 \
   && [ "$(echo "$Q" | sel "$T7" | jq -r '.reason')" = 'he said "ship it" now' ]; then
  ok "7: a reason containing double quotes is escaped and round-trips"
else
  bad "7: quoted reason broke JSON or did not round-trip"
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
