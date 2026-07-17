#!/usr/bin/env bash
# Fixture test for `task-dag frontier --json`, the readiness feed the
# github-worker dispatcher parses (lib/git-refs.sh: ready_frontier_shas,
# `jq -r '.[].sha'`). A single task whose title contains characters that
# are special in JSON (double quotes, backslashes) must NOT break the
# output: an unescaped title silently produced invalid JSON, which made
# the launcher fail closed and skip the whole repo every cycle
# (regression guard for the "Invalid numeric literal" launcher outage).
#
# It exercises:
#   * a plain task -> frontier --json is valid JSON and lists its sha;
#   * a task whose title has embedded double quotes AND a backslash ->
#     output still parses with jq and the title round-trips verbatim;
#   * the dispatcher's exact extraction (`jq -r '.[].sha'`) succeeds and
#     yields the full task SHA.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

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

mk_task() {  # $1=title -> prints the new leaf task short sha
  # jq -n builds a spec with the (possibly quote-laden) title correctly
  # escaped, so the harness itself never depends on the CLI's escaping.
  jq -n --arg t "$1" '[{"title":$t,"type":"leaf"}]' > "$ROOT/spec.json"
  "$TD" claim-root 777 --force >/dev/null 2>&1
  "$TD" breakdown "$EPIC" --spec-file="$ROOT/spec.json" --force --json 2>/dev/null \
    | grep -oE '"shortSha":"[0-9a-f]+"' | head -1 | cut -d'"' -f4
}

sel() { jq -e --arg s "$1" '.[] | select(.shortSha==$s)'; }

# TEST 1: a plain-titled task -> valid JSON, sha listed.
T1=$(mk_task "plain frontier task")
[ -n "$T1" ] || { echo "could not create task"; echo "PASS=0 FAIL=1"; exit 1; }
T1_FULL=$(git rev-parse "refs/heads/tasks/frontier/$T1")
J=$("$TD" frontier --no-fetch --json 2>/dev/null)
if echo "$J" | jq -e . >/dev/null 2>&1; then
  ok "1: frontier --json emits valid JSON"
else
  bad "1: frontier --json is not valid JSON"; echo "$J"
fi
if echo "$J" | jq -e --arg s "$T1_FULL" 'any(.[]; .sha == $s)' >/dev/null 2>&1; then
  ok "1: plain task appears in frontier"
else
  bad "1: plain task missing from frontier"
fi

# TEST 2: a title with embedded double quotes AND a backslash must not
# break the JSON, and must round-trip verbatim. This is the exact class
# of title (Canon #41 "…one strong \"always…\" rule…") that took the
# launcher down.
TITLE2='Canon: one strong "always use the tooling" rule \ end'
T2=$(mk_task "$TITLE2")
T2_FULL=$(git rev-parse "refs/heads/tasks/frontier/$T2")
J2=$("$TD" frontier --no-fetch --json 2>/dev/null)
if echo "$J2" | jq -e . >/dev/null 2>&1; then
  ok "2: quote/backslash title keeps frontier --json valid"
else
  bad "2: quote/backslash title broke frontier --json"; echo "$J2"
fi
GOT=$(echo "$J2" | sel "$T2" | jq -r '.title' 2>/dev/null)
if [ "$GOT" = "$TITLE2" ]; then
  ok "2: quoted title round-trips verbatim"
else
  bad "2: title did not round-trip (got '$GOT', want '$TITLE2')"
fi

# TEST 3: the dispatcher's exact extraction succeeds and yields full SHAs.
# (github-worker lib/git-refs.sh ready_frontier_shas: `jq -r '.[].sha'`.)
if SHAS=$(echo "$J2" | jq -r '.[].sha' 2>&1) \
   && printf '%s\n' "$SHAS" | grep -Fxq "$T2_FULL"; then
  ok "3: dispatcher's jq -r '.[].sha' extraction works"
else
  bad "3: jq -r '.[].sha' failed or missing sha: $SHAS"
fi

# TEST 4: a malformed `Issue:` trailer must NOT be interpolated raw into
# the bare numeric `issue` field (that is the same "invalid JSON skips the
# repo" failure class as the title bug). A non-numeric issue value must
# degrade to JSON null, keeping the output valid.
BAD_ISSUE_TASK=$(git commit-tree "$EMPTY_TREE" -p "$EPIC" -m "Task: task with bad issue trailer

Issue: #41abc
Author: tester
Status: pending
Type: task")
BAD_SHORT=$(git rev-parse --short "$BAD_ISSUE_TASK")
git update-ref "refs/heads/tasks/frontier/$BAD_SHORT" "$BAD_ISSUE_TASK"
J4=$("$TD" frontier --no-fetch --json 2>/dev/null)
if echo "$J4" | jq -e . >/dev/null 2>&1; then
  ok "4: malformed Issue: trailer keeps frontier --json valid"
else
  bad "4: malformed Issue: trailer broke frontier --json"; echo "$J4"
fi
ISS=$(echo "$J4" | sel "$BAD_SHORT" | jq -r '.issue' 2>/dev/null)
if [ "$ISS" = "null" ]; then
  ok "4: non-numeric issue degrades to JSON null"
else
  bad "4: non-numeric issue was '$ISS' (want null)"
fi

# TEST 5: frontier and deps must consume the same strict completion fact.
# Completing a descendant makes its parent reachable, but does not complete
# that parent; both callers must keep a task depending on the parent parked.
DEP=$(git commit-tree "$EMPTY_TREE" -p "$EPIC" -m "Task: strict dependency")
DESC=$(git commit-tree "$EMPTY_TREE" -p "$DEP" -m "Task: dependency descendant")
tip=$(git rev-parse HEAD); tree=$(git rev-parse "${tip}^{tree}")
desc_done=$(git commit-tree "$tree" -p "$tip" -p "$DESC" -m "Complete descendant only")
git update-ref refs/heads/master "$desc_done"; git reset -q --soft "$desc_done"
WAIT=$(git commit-tree "$EMPTY_TREE" -p "$EPIC" -p "$DEP" -m "Task: waits for strict dependency")
WAIT_SHORT=$(git rev-parse --short "$WAIT")
git update-ref "refs/heads/tasks/frontier/$WAIT_SHORT" "$WAIT"
J5=$("$TD" frontier --no-fetch --json 2>/dev/null)
"$TD" deps "$WAIT" --no-fetch --check-complete >/dev/null 2>&1; deps_rc=$?
if ! echo "$J5" | jq -e --arg s "$WAIT" 'any(.[]; .sha == $s)' >/dev/null \
  && [ "$deps_rc" -eq 2 ]; then
  ok "5: frontier and deps agree that arbitrary ancestry does not complete a dependency"
else
  bad "5: frontier/deps disagreed on the false parent completion (deps rc $deps_rc)"
fi

tip=$(git rev-parse HEAD); tree=$(git rev-parse "${tip}^{tree}")
dep_done=$(git commit-tree "$tree" -p "$tip" -p "$DEP" -m "Complete exact dependency")
git update-ref refs/heads/master "$dep_done"; git reset -q --soft "$dep_done"
J5_DONE=$("$TD" frontier --no-fetch --json 2>/dev/null)
"$TD" deps "$WAIT" --no-fetch --check-complete >/dev/null 2>&1; deps_rc=$?
if echo "$J5_DONE" | jq -e --arg s "$WAIT" 'any(.[]; .sha == $s)' >/dev/null \
  && [ "$deps_rc" -eq 0 ]; then
  ok "5: frontier and deps agree when the exact dependency witness exists"
else
  bad "5: frontier/deps disagreed on the exact completion (deps rc $deps_rc)"
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
