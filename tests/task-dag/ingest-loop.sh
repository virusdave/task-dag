#!/usr/bin/env bash
# Fixture test for cmd_ingest_comment dispatch-loop skip (issue #22 / FIX D).
set -uo pipefail
TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok(){ echo "PASS: $1"; PASS=$((PASS+1)); }
bad(){ echo "FAIL: $1"; FAIL=$((FAIL+1)); }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_GIT_NAME=t TASK_DAG_GIT_EMAIL=t@t

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"; cd "$ROOT/wc"
echo s>s; git add s; git commit -qm s; git push -q origin HEAD:master
# epic refs for issue 999
EPIC=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: epic
Issue: #999
Type: epic")
git update-ref refs/heads/gh/issues/999 "$EPIC"
git push -q origin refs/heads/gh/issues/999

git config taskdag.current-repo acme/widgets
runtime=$(git -C "$(dirname "$TD")/.." rev-parse HEAD)
master=$(git rev-parse HEAD)
registry_commit=1111111111111111111111111111111111111111
registry_blob=2222222222222222222222222222222222222222
registry=$(jq -ncS --arg commit "$registry_commit" --arg blob "$registry_blob" '{schema:1,source:{repository:"virusdave/top-level",path:"registry.json",commit:$commit,blob:$blob},repositories:[{repository:"acme/widgets",repositoryId:"R_fixture",name:"widgets",repairMode:"off",repairBranch:null},{repository:"virusdave/task-dag",repositoryId:"R_taskdag",name:"task-dag",repairMode:"off",repairBranch:null}]}')
printf '%s\n' "$registry" >"$ROOT/registry"
registry_id=$(source "$TD" --help >/dev/null; _taskdag_activation_registry_id "$ROOT/registry")
jq -ncS --arg runtime "$runtime" --arg master "$master" --arg registry_commit "$registry_commit" --arg registry_blob "$registry_blob" --arg id "$registry_id" '{actor:"fixture",authoritativeTimestamp:"2026-07-26T00:00:00Z",minimumCompatibleTaskDagCommit:$runtime,registrySnapshot:{id:$id,schema:1,source:{repository:"virusdave/top-level",path:"registry.json",commit:$registry_commit,blob:$registry_blob},repositories:[{repository:"acme/widgets",repositoryId:"R_fixture",name:"widgets",repairMode:"off",repairBranch:null},{repository:"virusdave/task-dag",repositoryId:"R_taskdag",name:"task-dag",repairMode:"off",repairBranch:null}]},sourceTips:[{repository:"acme/widgets",repositoryId:"R_fixture",ref:"refs/heads/master",commit:$master},{repository:"virusdave/task-dag",repositoryId:"R_taskdag",ref:"refs/heads/master",commit:$runtime}],state:"enabled"}' >"$ROOT/activation-spec"
"$TD" activation apply --spec-file "$ROOT/activation-spec" >/dev/null || exit 1

frontier_count(){ git ls-remote origin "refs/heads/tasks/frontier/*" 2>/dev/null | wc -l; }

ingest(){  # $1=comment_id $2=body
  printf '%s' "$2" > "$ROOT/body.txt"
  "$TD" ingest-comment --issue 999 --comment-id "$1" --author virusdave \
    --comment-url "https://x/$1" --created-at 2026-01-02T03:04:05Z \
    --updated-at 2026-01-02T03:04:05Z --body-file "$ROOT/body.txt" >/dev/null 2>&1
}

before=$(frontier_count)
ingest 1 "Please add a dark mode toggle to the header."   # plain operator prose
after=$(frontier_count)
[ "$after" -eq $((before+1)) ] && ok "plain prose comment mints a frontier task" \
  || bad "plain prose did not mint a task (before=$before after=$after)"

before=$(frontier_count)
ingest 2 "<!-- task-dag:status -->
progress update, nothing to pick up"
after=$(frontier_count)
[ "$after" -eq "$before" ] && ok "task-dag:status comment is skipped" \
  || bad "status comment minted a task (before=$before after=$after)"

before=$(frontier_count)
ingest 3 "<!-- post-comment:abc123:docs/x.md -->
Mirrored design doc body here."
after=$(frontier_count)
[ "$after" -eq "$before" ] && ok "post-comment machine comment is skipped (was a loop source)" \
  || bad "post-comment comment minted a task (before=$before after=$after)"

before=$(frontier_count)
ingest 4 "<!-- manual-close-page:999 -->
auto page note"
after=$(frontier_count)
[ "$after" -eq "$before" ] && ok "manual-close-page machine comment is skipped" \
  || bad "manual-close-page minted a task (before=$before after=$after)"

echo "-----"; echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
