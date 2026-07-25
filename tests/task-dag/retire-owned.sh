#!/usr/bin/env bash
set -euo pipefail
TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_GIT_NAME=t TASK_DAG_GIT_EMAIL=t@t
export TASK_DAG_CLAIMER=owner TASK_DAG_CLAIMER_HOST=test-host TASK_DAG_CLAIMER_PID=4242

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"
cd "$ROOT/wc"
echo seed >seed; git add seed; git commit -qm seed; git push -q origin HEAD:master
tree=$(git rev-parse HEAD^{tree})

new_task() {
    local title=$1 parent=${2:-HEAD} task short
    task=$(git commit-tree "$tree" -p "$parent" -m "Task: $title
Type: task")
    short=$(git rev-parse --short "$task")
    git update-ref "refs/heads/tasks/frontier/$short" "$task"
    git push -q origin "refs/heads/tasks/frontier/$short"
    printf '%s\n' "$task"
}

# Exact owned leaf release and JSON/readback contract.
task=$(new_task release-me)
"$TD" claim "$task" >/dev/null
out=$("$TD" retire-owned --task "$task" --release --json)
jq -e '.schema==1 and .ok and .results[0].kind=="leaf" and
  .results[0].outcome=="retired" and (.results[0].claimOid|test("^[0-9a-f]+$"))' <<<"$out" >/dev/null
short=$(git rev-parse --short "$task")
[ "$(git ls-remote origin "refs/heads/tasks/frontier/$short" | awk '{print $1}')" = "$task" ]
[ -z "$(git ls-remote origin "refs/heads/tasks/active/$short")" ]

# Park installs only the authoritative overlay and retires the claim.
"$TD" claim "$task" >/dev/null
"$TD" retire-owned --task "$task" --park >/dev/null
[ "$(git ls-remote origin "refs/heads/tasks/blocked/$task" | awk '{print $1}')" = "$task" ]
[ -z "$(git ls-remote origin "refs/heads/tasks/blocked-meta/$task")" ]

# Legacy root release removes exactly its lock and preserves pending identity.
root=$(git commit-tree "$tree" -p HEAD -m "Task: root
Type: epic
Issue: #71")
git push -q origin "$root:refs/heads/tasks/pending/71"
"$TD" claim-root 71 >/dev/null
"$TD" retire-owned --root 71 --release --json | jq -e '.ok and .results[0].kind=="root"' >/dev/null
[ "$(git ls-remote origin refs/heads/tasks/pending/71 | awk '{print $1}')" = "$root" ]
[ -z "$(git ls-remote origin refs/heads/tasks/root-active/71)" ]

# Foreign identity and malformed claim generations are reported and untouched.
foreign=$(new_task foreign)
TASK_DAG_CLAIMER=other TASK_DAG_CLAIMER_PID=99 "$TD" claim "$foreign" >/dev/null
fshort=$(git rev-parse --short "$foreign")
before=$(git ls-remote origin "refs/heads/tasks/active/$fshort" | awk '{print $1}')
if "$TD" retire-owned --task "$foreign" --release --json >"$ROOT/foreign.json"; then exit 1; fi
jq -e '.ok==false and .results[0].outcome=="foreign-claim"' "$ROOT/foreign.json" >/dev/null
[ "$(git ls-remote origin "refs/heads/tasks/active/$fshort" | awk '{print $1}')" = "$before" ]

malformed=$(new_task malformed)
mshort=$(git rev-parse --short "$malformed")
bad=$(git commit-tree "$tree" -p "$malformed" -m 'Claim: malformed')
git push -q origin ":refs/heads/tasks/frontier/$mshort" "$bad:refs/heads/tasks/active/$mshort"
if "$TD" retire-owned --task "$malformed" --park --json >"$ROOT/all.json"; then exit 1; fi
jq -e --arg oid "$bad" 'any(.results[]; .claimOid==$oid and .outcome=="malformed-claim")' "$ROOT/all.json" >/dev/null
[ "$(git ls-remote origin "refs/heads/tasks/active/$mshort" | awk '{print $1}')" = "$bad" ]

# --all ignores unrelated foreign claims rather than failing owned cleanup.
all_owned=$(new_task all-owned)
"$TD" claim "$all_owned" >/dev/null
"$TD" retire-owned --all --release --json | jq -e '.ok and (.results|length)==1' >/dev/null
[ "$(git ls-remote origin "refs/heads/tasks/active/$fshort" | awk '{print $1}')" = "$before" ]

# Capability output is byte-stable and works outside a repository.
expected='{"schema":1,"epicIdRootReaders":1,"ownedClaimRetirement":1}'
[ "$(cd "$ROOT" && "$TD" capabilities --json)" = "$expected" ]
echo "PASS: retire-owned release/park/all/foreign/malformed/root and capabilities"
