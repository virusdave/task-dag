#!/usr/bin/env bash
# Offline, two-repository integration fixture for epic-compose.  In particular
# this does not weaken the production all-f cutover: only a disposable copy of
# the runtime is activated.
set -uo pipefail
PROD_TD=${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
pass=0 fail=0
ok(){ echo "PASS: $1"; pass=$((pass+1)); }
bad(){ echo "FAIL: $1"; fail=$((fail+1)); }
refs(){ git --git-dir="$1" for-each-ref --format='%(refname) %(objectname)' | sort; }
export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
export TASK_DAG_CLAIMER=compose-worker TASK_DAG_CLAIMER_HOST=compose-host TASK_DAG_CLAIMER_PID=$$
export TASKDAG_CAS_MAX_ATTEMPTS=0

project=$(cd "$(dirname "$PROD_TD")/.." && pwd)
runtime=$(git -C "$project" rev-parse HEAD)
grep -qx 'readonly TASKDAG_EPIC_COMPOSE_CUTOVER=ffffffffffffffffffffffffffffffffffffffff' "$project/scripts/task-dag.d/epic-registry.sh" \
  || { echo 'FAIL: production compose cutover is not the immutable all-f sentinel'; exit 1; }
# Preserve the candidate working tree (epic-compose may itself be an
# uncommitted change under test) while retaining its object database.
cp -a "$project" "$ROOT/runtime"
sed -i "s/^readonly TASKDAG_EPIC_COMPOSE_CUTOVER=ffffffffffffffffffffffffffffffffffffffff$/readonly TASKDAG_EPIC_COMPOSE_CUTOVER=$runtime/" "$ROOT/runtime/scripts/task-dag.d/epic-registry.sh"
TD="$ROOT/runtime/scripts/task-dag"

for r in source target; do
  git init -q --bare "$ROOT/$r.git"
  git -C "$project" push -q "$ROOT/$r.git" "$runtime:refs/heads/master"
  git clone -q "$ROOT/$r.git" "$ROOT/$r"
done
git -C "$ROOT/source" config taskdag.current-repo acme/source
git -C "$ROOT/target" config taskdag.current-repo acme/target

# One byte-identical registry and activation declaration is installed in both
# origins.  It names both repositories and both (currently equal) source tips.
registry_commit=1111111111111111111111111111111111111111
registry_blob=2222222222222222222222222222222222222222
registry=$(jq -ncS --arg c "$registry_commit" --arg b "$registry_blob" '{schema:1,source:{repository:"virusdave/top-level",path:"registry.json",commit:$c,blob:$b},repositories:[{repository:"acme/source",repositoryId:"R_source",name:"source",repairMode:"off",repairBranch:null},{repository:"acme/target",repositoryId:"R_target",name:"target",repairMode:"off",repairBranch:null},{repository:"virusdave/task-dag",repositoryId:"1",name:"task-dag",repairMode:"off",repairBranch:null}]}')
printf '%s\n' "$registry" >"$ROOT/registry"
TASKDAG_SCRIPT_DIR="$ROOT/runtime/scripts"
source "$TASKDAG_SCRIPT_DIR/task-dag.d/repository-identity.sh"
source "$TASKDAG_SCRIPT_DIR/task-dag.d/activation.sh"
rid=$(_taskdag_activation_registry_id "$ROOT/registry")
jq -ncS --arg run "$runtime" --arg c "$registry_commit" --arg b "$registry_blob" --arg rid "$rid" --argjson repos "$(jq -c .repositories "$ROOT/registry")" \
  '{actor:"fixture",authoritativeTimestamp:"2026-07-26T00:00:00Z",minimumCompatibleTaskDagCommit:$run,registrySnapshot:{id:$rid,schema:1,source:{repository:"virusdave/top-level",path:"registry.json",commit:$c,blob:$b},repositories:$repos},sourceTips:[{repository:"acme/source",repositoryId:"R_source",ref:"refs/heads/master",commit:$run},{repository:"acme/target",repositoryId:"R_target",ref:"refs/heads/master",commit:$run},{repository:"virusdave/task-dag",repositoryId:"1",ref:"refs/heads/master",commit:$run}],state:"enabled"}' >"$ROOT/activation"
for r in source target; do (cd "$ROOT/$r" && "$TD" activation apply --spec-file "$ROOT/activation" >/dev/null) || exit 1; done

# Keep the visible/effective checkout identity GitHub-shaped.  The executable
# shim adds narrowly-scoped transport rewrites only to commands which can
# contact an origin; unlike global insteadOf it does not alter `remote get-url`.
git -C "$ROOT/source" remote set-url origin https://github.com/acme/source.git
git -C "$ROOT/target" remote set-url origin https://github.com/acme/target.git
mkdir "$ROOT/bin"; REAL_GIT=$(command -v git)
cat >"$ROOT/bin/git" <<EOF
#!/usr/bin/env bash
case " \$* " in
  *' fetch '*|*' push '*|*' ls-remote '*) exec "$REAL_GIT" -c url.file://$ROOT/source.git.insteadOf=https://github.com/acme/source.git -c url.file://$ROOT/target.git.insteadOf=https://github.com/acme/target.git "\$@";;
  *) exec "$REAL_GIT" "\$@";;
esac
EOF
cat >"$ROOT/bin/gh" <<EOF
#!/bin/sh
echo called >>'$ROOT/provider-calls'; exit 97
EOF
chmod +x "$ROOT/bin/git" "$ROOT/bin/gh"; export PATH="$ROOT/bin:$PATH" HOME="$ROOT/home"; mkdir "$HOME"

# Mint a genuine source task and then claim it through the public claim path.
EMPTY_TREE=4b825dc642cb6eb9a060e54bf8d69288fbee4904
task=$(git -C "$ROOT/source" commit-tree "$EMPTY_TREE" -p "$runtime" -m $'Task: compose source\n\nAuthor: fixture\nStatus: pending\nType: leaf')
task2=$(git -C "$ROOT/source" commit-tree "$EMPTY_TREE" -p "$runtime" -m $'Task: compose peer\n\nAuthor: fixture\nStatus: pending\nType: leaf')
short=${task:0:7}; git -C "$ROOT/source" push -q origin "$task:refs/heads/tasks/frontier/$short"
(cd "$ROOT/source" && "$TD" claim "$task" >/dev/null) || exit 1
claim=$(git --git-dir="$ROOT/source.git" rev-parse "refs/heads/tasks/active/$short")
operation=$(printf '9%.0s' {1..64})
cat >"$ROOT/spec" <<EOF
{"schema":1,"epicCreate":{"author":"fixture","claimNote":"compose","description":"integration root","operationId":"$operation","originRepository":"acme/source","originRepositoryId":"R_source","parent":"$runtime","provider":"github","repository":"acme/target","repositoryId":"R_target","timestamp":"2026-07-26T00:00:01Z","title":"Composed root"},"breakdown":[{"title":"first exact child","type":"leaf"},{"title":"second exact child","type":"task","dependencies":["@1"]}],"sourceClaim":{"activeRefSuffix":"$short","claimOid":"$claim","taskSha":"$task"},"sourceOps":[{"from":"task:acme/source@$task","mode":"all","reason":"compose fixture","relation":"requires","repoId":1001,"to":"\$targetRoot","witness":"fixture-one"},{"from":"task:acme/source@$task2","mode":"all","reason":"compose fixture peer","relation":"requires","repoId":1001,"to":"\$targetRoot","witness":"fixture-two"}]}
EOF
run(){ "$TD" epic-compose --json --source-checkout "$ROOT/source" --target-checkout "$ROOT/target" --spec-file "$1"; }

out=$(run "$ROOT/spec" 2>"$ROOT/err"); rc=$?
full_rc=$rc
root=$(jq -r '.epic.rootCommit//empty' <<<"$out")
if [ "$rc" -eq 0 ] && jq -e '.ok and .sourceOperationCount==2 and (.breakdown.tasks|length)==2 and .breakdown.tasks[0].claimed==true' <<<"$out" >/dev/null \
 && [ "$(git --git-dir="$ROOT/target.git" show -s --format=%s "$root")" = 'Task: Composed root' ] \
 && [ "$(cd "$ROOT/source" && "$TD" edges --json 2>/dev/null | jq 'length')" = 2 ]; then ok "valid compose creates exact root/breakdown and both source edges"; else bad "end-to-end compose failed rc=$rc: $(cat "$ROOT/err")"; fi

replay=$(run "$ROOT/spec" 2>"$ROOT/replay.err"); rc=$?
[ "$rc" -eq 0 ] && jq -e '.breakdown.replayed==true' <<<"$replay" >/dev/null \
 && git --git-dir="$ROOT/target.git" cat-file -e "$root^{commit}" \
 && [ "$(cd "$ROOT/source" && "$TD" edges --json 2>/dev/null | jq length)" = 2 ] \
  && ok "idempotent replay returns the exact root/breakdown/edge set" || bad "idempotent replay changed semantic state (rc=$rc)"

# Lost and foreign claims are rejected before any target mutation.
git --git-dir="$ROOT/source.git" update-ref -d "refs/heads/tasks/active/$short"
bt=$(refs "$ROOT/target.git"); run "$ROOT/spec" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 3 ] && [ "$bt" = "$(refs "$ROOT/target.git")" ] && ok "lost source claim rejects before target mutation" || bad "lost claim was not fenced"
git --git-dir="$ROOT/source.git" update-ref "refs/heads/tasks/active/$short" "$claim"
foreign=$(jq '.sourceClaim.claimOid="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' "$ROOT/spec"); printf '%s\n' "$foreign" >"$ROOT/foreign"
bt=$(refs "$ROOT/target.git"); run "$ROOT/foreign" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 3 ] && [ "$bt" = "$(refs "$ROOT/target.git")" ] && ok "foreign source claim rejects before target mutation" || bad "foreign claim was not fenced"

# Planner errors and an exact same-operation payload conflict are immutable.
jq '.breakdown[1].dependencies=["@2"]' "$ROOT/spec" >"$ROOT/malformed"
bs=$(refs "$ROOT/source.git"); bt=$(refs "$ROOT/target.git"); run "$ROOT/malformed" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 2 ] && [ "$bs" = "$(refs "$ROOT/source.git")" ] && [ "$bt" = "$(refs "$ROOT/target.git")" ] && ok "malformed plan is mutation-free" || bad "malformed plan mutated"
jq '.breakdown[1].title="conflicting replay"' "$ROOT/spec" >"$ROOT/conflict"
bs=$(refs "$ROOT/source.git"); bt=$(refs "$ROOT/target.git"); run "$ROOT/conflict" >/dev/null 2>&1; rc=$?
[ "$rc" -ne 0 ] && [ "$bs" = "$(refs "$ROOT/source.git")" ] && [ "$bt" = "$(refs "$ROOT/target.git")" ] && ok "exact operation conflict is mutation-free" || bad "payload conflict mutated"

# A later replay may legitimately add another pointwise operation to the same
# exact root/breakdown. Existing operations remain idempotent while the new
# operation converges; no whole-spec identity is imposed.
task3=$(git -C "$ROOT/source" commit-tree "$EMPTY_TREE" -p "$runtime" -m $'Task: compose third\n\nAuthor: fixture\nStatus: pending\nType: leaf')
jq --arg task "$task3" '.sourceOps += [{from:("task:acme/source@"+$task),mode:"all",reason:"compose fixture third",relation:"requires",repoId:1001,to:"$targetRoot",witness:"fixture-three"}]' "$ROOT/spec" >"$ROOT/expanded"
run "$ROOT/expanded" >/dev/null 2>&1; partial_replay_rc=$?
[ "$partial_replay_rc" -eq 0 ] && [ "$(cd "$ROOT/source" && "$TD" edges --json 2>/dev/null | jq length)" = 3 ] \
  && ok "partial source-op replay converges pointwise" || bad "partial replay did not converge"

[ ! -e "$ROOT/provider-calls" ] && ok "provider sentinel observed zero calls" || bad "compose invoked provider tooling"

# The untouched production runtime is gated before checkout/network effects.
prod_before_s=$(refs "$ROOT/source.git"); prod_before_t=$(refs "$ROOT/target.git")
"$PROD_TD" epic-compose --json --source-checkout "$ROOT/source" --target-checkout "$ROOT/target" --spec-file "$ROOT/spec" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 3 ] && [ "$prod_before_s" = "$(refs "$ROOT/source.git")" ] && [ "$prod_before_t" = "$(refs "$ROOT/target.git")" ] \
 && grep -qx 'readonly TASKDAG_EPIC_COMPOSE_CUTOVER=ffffffffffffffffffffffffffffffffffffffff' "$project/scripts/task-dag.d/epic-registry.sh" \
 && ok "inactive production gate changes no refs and remains all-f" || bad "production gate escaped"

echo "-----"; echo "PASS=$pass FAIL=$fail"; [ "$fail" -eq 0 ]
