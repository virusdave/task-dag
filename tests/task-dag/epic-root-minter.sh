#!/usr/bin/env bash
set -uo pipefail
TD=${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}
TASKDAG_SCRIPT_DIR=$(dirname "$TD")
LIB=$TASKDAG_SCRIPT_DIR/task-dag.d ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
pass=0 fail=0; ok(){ echo "PASS: $1"; pass=$((pass+1)); }; bad(){ echo "FAIL: $1"; fail=$((fail+1)); }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
EMPTY_TREE=4b825dc642cb6eb9a060e54bf8d69288fbee4904
taskdag_json_file_is_single_strict(){ jq -e . "$1" >/dev/null 2>&1; }
source "$LIB/git-objects.sh"; source "$LIB/task-model.sh"; source "$LIB/claim-model.sh"; source "$LIB/repository-identity.sh"
_taskdag_materialise_no_duplicate_keys(){ jq -e . "$1" >/dev/null 2>&1; }
source "$LIB/activation.sh"; source "$LIB/epic-registry.sh"
TASKDAG_MATERIALISATION_REF=refs/heads/tasks/v1/materialisation
git init -q --bare "$ROOT/origin"; git init -q "$ROOT/wc"; cd "$ROOT/wc" || exit; git remote add origin "$ROOT/origin"
echo seed >seed; git add seed; git commit -qm seed; parent=$(git rev-parse HEAD); git push -q origin HEAD:master
git init -q --bare "$ROOT/source-origin"; git init -q "$ROOT/source-wc"
git -C "$ROOT/source-wc" remote add origin "$ROOT/source-origin"
git -C "$ROOT/source-wc" config taskdag.current-repo source/repo
echo source >"$ROOT/source-wc/seed"; git -C "$ROOT/source-wc" add seed; git -C "$ROOT/source-wc" commit -qm seed
source_parent=$(git -C "$ROOT/source-wc" rev-parse HEAD); git -C "$ROOT/source-wc" push -q origin HEAD:master
runtime=$(git -C "$TASKDAG_SCRIPT_DIR/.." rev-parse HEAD)
registry_commit=1111111111111111111111111111111111111111
registry_blob=2222222222222222222222222222222222222222
registry=$(jq -ncS --arg commit "$registry_commit" --arg blob "$registry_blob" '{schema:1,source:{repository:"virusdave/top-level",path:"registry.json",commit:$commit,blob:$blob},repositories:[{repository:"owner/repo",repositoryId:"R_target",name:"target",repairMode:"off",repairBranch:null},{repository:"source/repo",repositoryId:"R_source",name:"source",repairMode:"off",repairBranch:null},{repository:"virusdave/task-dag",repositoryId:"1",name:"task-dag",repairMode:"off",repairBranch:null}]}')
printf '%s\n' "$registry" >"$ROOT/registry"
registry_id=$(_taskdag_activation_registry_id "$ROOT/registry")
jq -ncS --arg runtime "$runtime" --arg source "$source_parent" --arg floor "$TASKDAG_EPIC_WRITER_CUTOVER" --arg registry_commit "$registry_commit" --arg registry_blob "$registry_blob" --arg id "$registry_id" --argjson repositories "$(jq -c .repositories "$ROOT/registry")" '{actor:"fixture",authoritativeTimestamp:"2026-07-25T00:00:00Z",minimumCompatibleTaskDagCommit:$floor,registrySnapshot:{id:$id,schema:1,source:{repository:"virusdave/top-level",path:"registry.json",commit:$registry_commit,blob:$registry_blob},repositories:$repositories},sourceTips:[{repository:"owner/repo",repositoryId:"R_target",ref:"refs/heads/master",commit:$runtime},{repository:"source/repo",repositoryId:"R_source",ref:"refs/heads/master",commit:$source},{repository:"virusdave/task-dag",repositoryId:"1",ref:"refs/heads/master",commit:$runtime}],state:"enabled"}' >"$ROOT/activation-spec"
# Plan4 epoch 13 intentionally enables the internal minter/readers while the
# public writer remains dormant. Advance to the dedicated writer prerequisite
# only after proving the plan4 floor is mutation-free.
jq -cS '.minimumCompatibleTaskDagCommit="73bfe103b6f5e1bddc318e5592085619c7f0f2f4"' "$ROOT/activation-spec" >"$ROOT/plan4-spec"
"$TD" activation apply --spec-file "$ROOT/plan4-spec" >/dev/null || exit 1
before=$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)
"$TD" epic-create --json --title dormant --author fixture --description dormant \
  --repository owner/repo --repository-id R_target --origin-repository source/repo --origin-repository-id R_source \
  --operation-id "$(printf '8%.0s' {1..64})" --timestamp 2026-07-25T00:00:00Z >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 3 ] && [ "$before" = "$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)" ]; then ok "plan4 floor 73bfe remains writer NO-GO"; else bad "plan4 floor enabled public writer"; fi
"$TD" activation apply --spec-file "$ROOT/activation-spec" >/dev/null || exit 1

# Exercise the public operation ingress. Semantic replay must resolve the
# authoritative Epic-ID record before mutable payload, parent, time, or PID
# can influence object authoring; a later --claim is an independent claim-root.
public_operation=$(printf '9%.0s' {1..64})
public_create=$(TASK_DAG_CLAIMER_HOST=first-host TASK_DAG_CLAIMER_PID=111 "$TD" epic-create --json \
  --title 'Public root' --author first --description 'first body' \
  --repository owner/repo --repository-id R_target \
  --origin-repository source/repo --origin-repository-id R_source \
  --operation-id "$public_operation" --timestamp 2026-07-25T00:00:00Z)
public_root=$(jq -r .rootCommit <<<"$public_create")
echo moved >>seed; git add seed; git commit -qm 'move master'; git push -q origin HEAD:master
parent=$(git rev-parse HEAD)
public_replay=$(TASK_DAG_CLAIMER_HOST=changed-host TASK_DAG_CLAIMER_PID=222 "$TD" epic-create --json \
  --title 'Changed title' --author changed --description 'changed body' \
  --repository owner/repo --repository-id R_target \
  --origin-repository source/repo --origin-repository-id R_source \
  --operation-id "$public_operation" --timestamp 2030-01-01T00:00:00Z)
if jq -e '.created==false and .claimCommit==null' <<<"$public_replay" >/dev/null \
  && [ "$(jq -r .rootCommit <<<"$public_replay")" = "$public_root" ]; then
  ok "public operation replay ignores changed metadata, master, time and PID"
else bad "public operation replay rewrote immutable state"; fi

# Typed leaf completion is a distinct transition from typed root closure. The
# public completion path must remain dormant below its dedicated prerequisite,
# then resolve the immutable registry root (not the child that inherited the
# same Epic-ID) and allow a real leaf completion while the root remains open.
git config taskdag.current-repo owner/repo
typed_operation=$(printf '7%.0s' {1..64})
typed_create=$("$TD" epic-create --json --title 'Typed completion root' --author fixture --description '' \
  --repository owner/repo --repository-id R_target --origin-repository source/repo --origin-repository-id R_source \
  --operation-id "$typed_operation" --timestamp 2026-07-25T00:00:01Z)
typed_root=$(jq -r .rootCommit <<<"$typed_create")
typed_epic=$(jq -r .epicId <<<"$typed_create")
"$TD" claim-root "$typed_epic" >/dev/null || exit 1
printf '[{"title":"typed completion leaf","type":"leaf"}]' >"$ROOT/public-breakdown.json"
"$TD" breakdown "$typed_root" --spec-file="$ROOT/public-breakdown.json" --json >"$ROOT/public-children.json" || exit 1
public_leaf=$(jq -r '.tasks[0].sha' "$ROOT/public-children.json")
TASK_DAG_CLAIMER=fixture TASK_DAG_CLAIMER_HOST=fixture TASK_DAG_CLAIMER_PID=$$ "$TD" claim "$public_leaf" >/dev/null || exit 1
echo typed-completion >typed-completion; git add typed-completion; git commit -qm 'Implement typed completion fixture'
impl=$(git rev-parse HEAD); before=$(git rev-parse HEAD)
before_local_refs=$(git for-each-ref refs/heads --format='%(refname) %(objectname)' | sort)
before_origin_refs=$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)
real_git=$(command -v git); mkdir -p "$ROOT/git-probe"
cat >"$ROOT/git-probe/git" <<EOF
#!/bin/sh
[ "\$1" != commit-tree ] || echo commit-tree >>"$ROOT/commit-tree.log"
exec "$real_git" "\$@"
EOF
chmod +x "$ROOT/git-probe/git"
PATH="$ROOT/git-probe:$PATH" TASK_DAG_CLAIMER=fixture TASK_DAG_CLAIMER_HOST=fixture TASK_DAG_CLAIMER_PID=$$ "$TD" complete "$public_leaf" >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 3 ] && [ "$(git rev-parse HEAD)" = "$before" ] \
  && [ "$before_local_refs" = "$(git for-each-ref refs/heads --format='%(refname) %(objectname)' | sort)" ] \
  && [ "$before_origin_refs" = "$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)" ] \
  && [ ! -s "$ROOT/commit-tree.log" ]; then
  ok "typed completion remains dormant below its dedicated activation prerequisite"
else bad "typed completion activated below its prerequisite (rc=$rc)"; fi

if [ "$TASKDAG_TYPED_COMPLETION_CUTOVER" != 0000000000000000000000000000000000000000 ]; then
  stale_candidate=$(git commit-tree "$(git rev-parse "$impl^{tree}")" -p "$impl" -p "$public_leaf" -m "Implement typed completion fixture

Task-Commit: $public_leaf
Status: completed")
  before_origin_refs=$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)
  "$TD" publish "$stale_candidate" >/dev/null 2>&1; rc=$?
  if [ "$rc" -ne 0 ] && [ "$before_origin_refs" = "$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)" ]; then
    ok "publication independently rejects a typed completion below the activation prerequisite"
  else bad "publication admitted a typed completion below the activation prerequisite (rc=$rc)"; fi

  jq -cS --arg floor "$TASKDAG_TYPED_COMPLETION_CUTOVER" '.minimumCompatibleTaskDagCommit=$floor' "$ROOT/activation-spec" >"$ROOT/typed-completion-spec"
  "$TD" activation apply --spec-file "$ROOT/typed-completion-spec" >/dev/null || exit 1
  TASK_DAG_CLAIMER=fixture TASK_DAG_CLAIMER_HOST=fixture TASK_DAG_CLAIMER_PID=$$ "$TD" complete "$public_leaf" >/dev/null 2>&1; rc=$?
  completion=$(git rev-parse HEAD)
  if [ "$rc" -eq 0 ] && [ "$(git rev-parse "$completion^1")" = "$impl" ] \
    && [ "$(git rev-parse "$completion^2")" = "$public_leaf" ] \
    && ! git show -s --format=%B "$completion" | grep -q '^Closes-Epic-ID:' \
    && [ "$(jq -r .rootCommit <<<"$(taskdag_epic_registry_record "$typed_epic")")" = "$typed_root" ]; then
    ok "activated typed leaf completion uses registry containment and leaves root open"
  else bad "activated typed leaf completion failed or closed its root (rc=$rc)"; fi
  if git --git-dir="$ROOT/origin" show-ref --verify --quiet "refs/heads/tasks/pending/epic-v1/${typed_epic#epic-v1:}"; then
    ok "local typed leaf completion preserves the open pending root"
  else bad "local typed leaf completion retired the open root"; fi
fi
public_claimed=$(TASK_DAG_CLAIMER=ambient-worker TASK_DAG_CLAIMER_HOST=ambient-host TASK_DAG_CLAIMER_PID=333 "$TD" epic-create --json --claim \
  --title irrelevant --author irrelevant --description irrelevant \
  --repository owner/repo --repository-id R_target \
  --origin-repository source/repo --origin-repository-id R_source \
  --operation-id "$public_operation" --timestamp 2031-01-01T00:00:00Z)
public_claim=$(jq -r .claimCommit <<<"$public_claimed")
if [ "$(git show -s --format='%(trailers:key=Claimer,valueonly)' "$public_claim")" = ambient-worker ] \
  && [ "$(git show -s --format='%(trailers:key=Claimer-Host,valueonly)' "$public_claim")" = ambient-host ] \
  && [ "$(git show -s --format='%(trailers:key=Claimer-PID,valueonly)' "$public_claim")" = 333 ]; then
  ok "public replay later --claim uses canonical ambient claim-root identity"
else bad "public replay claim did not preserve ambient worker identity"; fi

operation=$(printf 'a%.0s' {1..64}); epic=$(taskdag_epic_id_for_operation R_source "$operation")
descriptor=$(jq -ncS --arg epic "$epic" --arg op "$operation" '{epicId:$epic,origin:{kind:"operation",operationId:$op,repositoryId:"R_source"},projection:{issueId:null,issueNumber:null,issueUrl:null,provider:"github",repository:"owner/repo",repositoryId:"R_target"},schema:1,task:{author:"worker",description:"",status:"pending",title:"Root",type:"epic"}}')
spec=$(jq -ncS --argjson descriptor "$descriptor" --arg parent "$parent" '{actor:"worker",authoritativeTimestamp:"2026-07-25T00:00:00Z",claim:{claimId:"stable",claimer:"worker",host:"host",note:"",pid:"123",ttlHours:"12"},descriptor:$descriptor,legacyAdoption:null,parentCommit:$parent,schema:1}')
out=$(taskdag_internal_mint_epic_root "$spec")
if jq -e '.created==true' <<<"$out" >/dev/null && taskdag_epic_registry_validate_history "$(git --git-dir="$ROOT/origin" rev-parse refs/heads/tasks/v1/epics)"; then ok "creates root, registry, binding state and root claim atomically"; else bad "create failed"; fi
export GIT_AUTHOR_NAME=ambient-two GIT_AUTHOR_EMAIL=two@example.invalid GIT_COMMITTER_NAME=ambient-two GIT_COMMITTER_EMAIL=two@example.invalid
again=$(taskdag_internal_mint_epic_root "$spec")
if jq -e '.created==false' <<<"$again" >/dev/null \
  && [ "$(jq -r .rootCommit <<<"$out")" = "$(jq -r .rootCommit <<<"$again")" ] \
  && [ "$(jq -r .claimCommit <<<"$out")" = "$(jq -r .claimCommit <<<"$again")" ]; then ok "replay is deterministic across ambient Git identities"; else bad "replay was not idempotent"; fi

# The hidden projector marker carries only immutable operation/declaration
# identity. Adoption proves both against the canonical declaration and the
# existing unbound root, then appends paired indexes without changing it.
declaration_digest=$(printf 'd%.0s' {1..64})
declaration=$(jq -ncS --arg op "$operation" --arg dd "$declaration_digest" '{schema:1,operationId:$op,declarationDigest:$dd,sourceRepo:{name:"source/repo",id:"R_source"},peerRepo:{name:"owner/repo",id:"R_target"}}')
idx="$ROOT/materialisation-index"; printf '%s\n' "$declaration" >"$ROOT/declaration"
GIT_INDEX_FILE=$idx git update-index --add --cacheinfo "100644,$(git hash-object -w "$ROOT/declaration"),declarations/$declaration_digest.json"
materialisation_tree=$(GIT_INDEX_FILE=$idx git write-tree); materialisation_commit=$(printf 'fixture materialisation\n' | git commit-tree "$materialisation_tree")
git push -q "$ROOT/source-origin" "$materialisation_commit:$TASKDAG_MATERIALISATION_REF"
before=$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)
taskdag_internal_bind_operation_projection "$ROOT/source-wc" source/repo R_wrong "$operation" "$(printf 'f%.0s' {1..64})" github owner/repo R_target I_42 42 https://github.com/owner/repo/issues/42 worker 2026-07-25T00:00:01Z >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 3 ] && [ "$before" = "$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)" ]; then ok "forged marker is mutation-free"; else bad "forged marker mutated state"; fi
taskdag_internal_bind_operation_projection "$ROOT/source-wc" source/repo R_source "$operation" "$declaration_digest" gitlab owner/repo R_target I_42 42 https://github.com/owner/repo/issues/42 worker 2026-07-25T00:00:01Z >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 2 ] && [ "$before" = "$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)" ]; then ok "invalid binding provider is rejected before publication"; else bad "invalid binding provider mutated state"; fi
taskdag_internal_bind_operation_projection "$ROOT/source-wc" source/repo R_source "$operation" "$declaration_digest" github owner/repo R_target I_42 42 https://github.com/owner/repo/issues/42 worker 2026-07-25T00:00:01Z >/dev/null || bad "valid marker adoption failed"
bound_registry=$(git --git-dir="$ROOT/origin" rev-parse "$TASKDAG_EPIC_REGISTRY_REF")
bound_root=$(git --git-dir="$ROOT/origin" rev-parse "$(jq -r .rootRef <<<"$out")")
if [ "$bound_root" = "$(jq -r .rootCommit <<<"$out")" ] && taskdag_epic_registry_validate_history "$bound_registry"; then ok "valid marker appends paired binding without rewriting root"; else bad "valid marker binding invalid"; fi
replay_bound=$(taskdag_internal_bind_operation_projection "$ROOT/source-wc" source/repo R_source "$operation" "$declaration_digest" github owner/repo R_target I_42 42 https://github.com/owner/repo/issues/42 worker 2026-07-25T00:00:02Z)
if jq -e '.created==false' <<<"$replay_bound" >/dev/null && [ "$bound_registry" = "$(git --git-dir="$ROOT/origin" rev-parse "$TASKDAG_EPIC_REGISTRY_REF")" ]; then ok "marker replay is idempotent"; else bad "marker replay appended duplicate state"; fi

# The opposite delivery order is equally convergent: an issue marker observed
# before its operation root is mutation-free, then an exact replay binds the
# same authoritative root after the root writer wins.
reverse_operation=$(printf '8%.0s' {1..64}); reverse_digest=$(printf '7%.0s' {1..64})
reverse_epic=$(taskdag_epic_id_for_operation R_source "$reverse_operation")
reverse_declaration=$(jq -ncS --arg op "$reverse_operation" --arg dd "$reverse_digest" '{schema:1,operationId:$op,declarationDigest:$dd,sourceRepo:{name:"source/repo",id:"R_source"},peerRepo:{name:"owner/repo",id:"R_target"}}')
printf '%s\n' "$reverse_declaration" >"$ROOT/reverse-declaration"
reverse_idx="$ROOT/reverse-materialisation-index"; GIT_INDEX_FILE=$reverse_idx git read-tree "$materialisation_commit"
GIT_INDEX_FILE=$reverse_idx git update-index --add --cacheinfo "100644,$(git hash-object -w "$ROOT/reverse-declaration"),declarations/$reverse_digest.json"
reverse_tree=$(GIT_INDEX_FILE=$reverse_idx git write-tree); rm -f "$reverse_idx"
reverse_materialisation=$(printf 'second declaration\n' | git commit-tree "$reverse_tree" -p "$materialisation_commit")
git push -q "$ROOT/source-origin" "$reverse_materialisation:$TASKDAG_MATERIALISATION_REF"
before=$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)
taskdag_internal_bind_operation_projection "$ROOT/source-wc" source/repo R_source "$reverse_operation" "$reverse_digest" github owner/repo R_target I_43 43 https://github.com/owner/repo/issues/43 worker 2026-07-25T00:00:03Z >/dev/null 2>&1; reverse_rc=$?
after_early_marker=$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)
reverse_descriptor=$(jq -ncS --arg epic "$reverse_epic" --arg op "$reverse_operation" '{epicId:$epic,origin:{kind:"operation",operationId:$op,repositoryId:"R_source"},projection:{issueId:null,issueNumber:null,issueUrl:null,provider:"github",repository:"owner/repo",repositoryId:"R_target"},schema:1,task:{author:"worker",description:"",status:"pending",title:"Reverse root",type:"epic"}}')
reverse_spec=$(jq -ncS --argjson descriptor "$reverse_descriptor" --arg parent "$parent" '{actor:"worker",authoritativeTimestamp:"2026-07-25T00:00:04Z",claim:null,descriptor:$descriptor,legacyAdoption:null,parentCommit:$parent,schema:1}')
reverse_created=$(taskdag_internal_mint_epic_root "$reverse_spec")
reverse_bound=$(taskdag_internal_bind_operation_projection "$ROOT/source-wc" source/repo R_source "$reverse_operation" "$reverse_digest" github owner/repo R_target I_43 43 https://github.com/owner/repo/issues/43 worker 2026-07-25T00:00:05Z)
if [ "$reverse_rc" -eq 3 ] && [ "$before" = "$after_early_marker" ] \
  && [ "$(jq -r .rootCommit <<<"$reverse_bound")" = "$(jq -r .rootCommit <<<"$reverse_created")" ] \
  && [ "$(jq -r .epicId <<<"$reverse_bound")" = "$reverse_epic" ]; then
  ok "two delivery orders converge on one operation root and binding"
else bad "marker-first replay did not converge"; fi

# Every useful strict subset of {registry,pending,active} is indeterminate. In
# particular, immutable registry bytes alone never resurrect native refs.
registry=refs/heads/tasks/v1/epics
native_pending=$(jq -r .rootRef <<<"$out"); native_active=$(jq -r .activeRef <<<"$out")
registry_oid=$(git --git-dir="$ROOT/origin" rev-parse "$registry")
native_root=$(jq -r .rootCommit <<<"$out"); native_claim=$(jq -r .claimCommit <<<"$out")
assert_native_partial_fails() { # label keep-registry keep-pending keep-active
  local label=$1 keep_registry=$2 keep_pending=$3 keep_active=$4 before rc
  git --git-dir="$ROOT/origin" update-ref -d "$registry"
  git --git-dir="$ROOT/origin" update-ref -d "$native_pending"
  git --git-dir="$ROOT/origin" update-ref -d "$native_active"
  [ "$keep_registry" = true ] && git --git-dir="$ROOT/origin" update-ref "$registry" "$registry_oid"
  [ "$keep_pending" = true ] && git --git-dir="$ROOT/origin" update-ref "$native_pending" "$native_root"
  [ "$keep_active" = true ] && git --git-dir="$ROOT/origin" update-ref "$native_active" "$native_claim"
  before=$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)
  taskdag_internal_mint_epic_root "$spec" >/dev/null 2>&1; rc=$?
  if [ "$rc" -eq 3 ] && [ "$before" = "$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)" ]; then ok "$label partial state fails closed"; else bad "$label partial state mutated"; fi
}
assert_native_partial_fails registry-only true false false
assert_native_partial_fails pending-only false true false
assert_native_partial_fails active-only false false true
assert_native_partial_fails registry-pending true true false
assert_native_partial_fails registry-active true false true
assert_native_partial_fails pending-active false true true
git --git-dir="$ROOT/origin" update-ref "$registry" "$registry_oid"
git --git-dir="$ROOT/origin" update-ref "$native_pending" "$native_root"
git --git-dir="$ROOT/origin" update-ref "$native_active" "$native_claim"

saved_snapshot_function=$(declare -f taskdag_activation_snapshot_token)
taskdag_activation_snapshot_token(){ return 3; }
before=$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)
taskdag_internal_mint_epic_root "$spec" >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 3 ] && [ "$before" = "$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)" ]; then ok "disabled activation is mutation-free"; else bad "disabled activation escaped"; fi
eval "$saved_snapshot_function"
bad_spec=$(jq -cS '.descriptor.task.title="Different"' <<<"$spec")
before=$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)
taskdag_internal_mint_epic_root "$bad_spec" >/dev/null 2>&1; rc=$?
if [ "$rc" -ne 0 ] && [ "$before" = "$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)" ]; then ok "same-ID payload conflict is mutation-free"; else bad "payload conflict mutated"; fi
malformed=$(jq -c '.claim.pid="0"' <<<"$spec"); taskdag_internal_mint_epic_root "$malformed" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 2 ] && ok "malformed spec fails before publication" || bad "malformed spec rc=$rc"

# A competing exact-lease winner cannot be overwritten.
digest=${epic#epic-v1:}; active=refs/heads/tasks/root-active/epic-v1/$digest
git --git-dir="$ROOT/origin" update-ref -d "$active"
foreign=$(printf foreign | git commit-tree "$EMPTY_TREE" -p "$parent")
git push -q origin "$foreign:$active"
taskdag_internal_mint_epic_root "$spec" >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 3 ] && [ "$(git --git-dir="$ROOT/origin" rev-parse "$active")" = "$foreign" ]; then ok "foreign root-claim race loses without overwrite"; else bad "race fence failed"; fi

# Legacy migration adopts exact existing bytes rather than minting a new root.
legacy_epic=$(taskdag_epic_id_for_provider github R_target I_9)
legacy_desc=$(jq -ncS --arg epic "$legacy_epic" '{epicId:$epic,origin:{issueId:"I_9",kind:"provider",provider:"github",repositoryId:"R_target"},projection:{issueId:"I_9",issueNumber:"9",issueUrl:"https://github.com/owner/repo/issues/9",provider:"github",repository:"owner/repo",repositoryId:"R_target"},schema:1,task:{author:"worker",description:"",status:"pending",title:"Legacy",type:"epic"}}')
taskdag_serialize_task_message Legacy '#9' worker https://github.com/owner/repo/issues/9 pending epic '' >"$ROOT/legacy"
legacy_root=$(git commit-tree "$EMPTY_TREE" -p "$parent" <"$ROOT/legacy")
legacy_claim=$(GIT_AUTHOR_NAME=task-dag GIT_AUTHOR_EMAIL=task-dag@freshlybaked.us GIT_COMMITTER_NAME=task-dag GIT_COMMITTER_EMAIL=task-dag@freshlybaked.us GIT_AUTHOR_DATE=2026-07-25T00:00:01Z GIT_COMMITTER_DATE=2026-07-25T00:00:01Z git commit-tree "$EMPTY_TREE" -p "$legacy_root" -m $'Claim: Legacy\n\nClaim-Kind: root\nIssue: #9\nClaim-ID: legacy\nTask-Commit: '"$legacy_root"$'\nClaimer: worker\nClaimer-Host: host\nClaimer-PID: 123\nClaimed-At: 2026-07-25T00:00:01Z\nTTL-Hours: 12')
git push -q --atomic origin "$legacy_root:refs/heads/gh/issues/9" "$legacy_root:refs/heads/tasks/pending/9" "$legacy_claim:refs/heads/tasks/root-active/9"
legacy_spec=$(jq -ncS --argjson descriptor "$legacy_desc" --arg parent "$parent" '{actor:"worker",authoritativeTimestamp:"2026-07-25T00:00:01Z",claim:{claimId:"legacy",claimer:"worker",host:"host",note:"",pid:"123",ttlHours:"12"},descriptor:$descriptor,legacyAdoption:{issueNumber:"9",issueRef:"refs/heads/gh/issues/9",pendingRef:"refs/heads/tasks/pending/9"},parentCommit:$parent,schema:1}')

# Typed and numeric locators for one provider root are a split-brain conflict.
legacy_digest=${legacy_epic#epic-v1:}; typed_pending=refs/heads/tasks/pending/epic-v1/$legacy_digest
git push -q origin "$legacy_root:$typed_pending"
before=$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)
taskdag_internal_mint_epic_root "$legacy_spec" >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 3 ] && [ "$before" = "$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)" ]; then ok "typed duplicate locator fails closed"; else bad "typed duplicate locator was accepted"; fi
git push -q origin ":$typed_pending"

# Retire numeric active through repair-retire's exact canonical transaction
# helper after the minter snapshot but immediately before its receive-pack.
legacy_foreign=$(printf legacy-race | git commit-tree "$EMPTY_TREE" -p "$legacy_root")
race_expected_authority=""
race_winning_guard=""
taskdag_activation_test_pre_fenced_push_hook(){
  unset -f taskdag_activation_test_pre_fenced_push_hook
  local race_token race_updates
  race_token=$(taskdag_activation_snapshot_token) || return 3
  race_expected_authority=$(jq -r .authorityTip <<<"$race_token")
  race_updates=$(jq -ncS --arg ref refs/heads/tasks/root-active/9 --arg old "$legacy_claim" --arg new "$legacy_foreign" '[{ref:$ref,old:$old,new:$new}]')
  taskdag_internal_repair_retire_transaction "$race_token" fixture 2026-07-25T00:00:02Z "$race_updates" || return 3
  race_winning_guard=$(git --git-dir="$ROOT/origin" rev-parse "$TASKDAG_ACTIVATION_REF")
}
before_registry=$(git --git-dir="$ROOT/origin" rev-parse refs/heads/tasks/v1/epics)
taskdag_internal_mint_epic_root "$legacy_spec" >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 3 ] \
  && [ "$(git --git-dir="$ROOT/origin" rev-parse refs/heads/tasks/v1/epics)" = "$before_registry" ] \
  && [ "$(git --git-dir="$ROOT/origin" rev-parse refs/heads/tasks/root-active/9)" = "$legacy_foreign" ] \
  && ! git --git-dir="$ROOT/origin" show-ref --verify --quiet "$typed_pending" \
  && [ "$(git --git-dir="$ROOT/origin" log -1 --format=%B "$race_winning_guard" | sed -n 's/^Expected-Authority-Tip: //p')" = "$race_expected_authority" ]; then
  ok "injected numeric legacy-writer race cannot publish a typed duplicate"
else bad "activation generation lease did not fence live adoption (rc=$rc expected=$race_expected_authority guard=$race_winning_guard)"; fi
restore_token=$(taskdag_activation_snapshot_token)
restore_updates=$(jq -ncS --arg ref refs/heads/tasks/root-active/9 --arg old "$legacy_foreign" --arg new "$legacy_claim" '[{ref:$ref,old:$old,new:$new}]')
taskdag_activation_fenced_multi_push "$restore_token" scheduling fixture-active-restore fixture 2026-07-25T00:00:03Z "$restore_updates" >/dev/null || exit 1
legacy_out=$("$TD" epic-create --json --title Legacy --author worker --description '' \
  --repository owner/repo --repository-id R_target --issue-id I_9 --issue-number 9 \
  --issue-url https://github.com/owner/repo/issues/9 --timestamp 2026-07-25T00:00:04Z)
if [ "$(jq -r .rootCommit <<<"$legacy_out")" = "$legacy_root" ] \
  && [ "$(jq -r .claimCommit <<<"$legacy_out")" = "$legacy_claim" ]; then
  ok "raw pre-snapshot provider ingress adopts exact numeric root and claim"
else bad "provider ingress reminted the legacy root"; fi

native_spec() { # operation-char timestamp title
  local operation descriptor epic
  operation=$(printf "$1%.0s" {1..64}); epic=$(taskdag_epic_id_for_operation R_source "$operation")
  descriptor=$(jq -ncS --arg epic "$epic" --arg op "$operation" --arg title "$3" '{epicId:$epic,origin:{kind:"operation",operationId:$op,repositoryId:"R_source"},projection:{issueId:null,issueNumber:null,issueUrl:null,provider:"github",repository:"owner/repo",repositoryId:"R_target"},schema:1,task:{author:"worker",description:"",status:"pending",title:$title,type:"epic"}}')
  jq -ncS --argjson descriptor "$descriptor" --arg parent "$parent" --arg timestamp "$2" '{actor:"worker",authoritativeTimestamp:$timestamp,claim:{claimId:"stable",claimer:"worker",host:"host",note:"",pid:"123",ttlHours:"12"},descriptor:$descriptor,legacyAdoption:null,parentCommit:$parent,schema:1}'
}

# One provider tuple is immutable even if a competing operation-derived
# Epic-ID presents the same projection.
competing=$(native_spec e 2026-07-25T00:00:05Z Competing)
competing=$(jq -cS --argjson projection "$(jq -c .projection <<<"$legacy_desc")" '.descriptor.projection=$projection' <<<"$competing")
before=$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)
taskdag_internal_mint_epic_root "$competing" >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 3 ] && [ "$before" = "$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)" ]; then ok "competing Epic-IDs cannot bind one provider tuple"; else bad "provider tuple was rebound"; fi

# A clone with no ambient legacy refs must validate the prior adoption from one
# origin snapshot and append normally.
git clone -q "$ROOT/origin" "$ROOT/fresh"; cd "$ROOT/fresh" || exit
fresh_out=$(taskdag_internal_mint_epic_root "$(native_spec b 2026-07-25T00:00:02Z Fresh)")
if jq -e '.created==true' <<<"$fresh_out" >/dev/null \
  && ! git show-ref --verify --quiet refs/heads/gh/issues/9; then
  ok "fresh clone appends after legacy adoption without materialising legacy refs"
else bad "fresh clone could not append after legacy adoption"; fi

# Deliberately wrong local legacy refs are non-authoritative to the writer.
stale=$(printf stale | git commit-tree "$EMPTY_TREE" -p "$parent")
git update-ref refs/heads/gh/issues/9 "$stale"; git update-ref refs/heads/tasks/pending/9 "$stale"
stale_out=$(taskdag_internal_mint_epic_root "$(native_spec c 2026-07-25T00:00:03Z Stale)")
if jq -e '.created==true' <<<"$stale_out" >/dev/null \
  && [ "$(git rev-parse refs/heads/gh/issues/9)" = "$stale" ]; then
  ok "stale local legacy history cannot affect append or get rewritten"
else bad "ambient stale legacy refs affected append"; fi

# Retirement is proved only by the captured origin master and does not require
# recreating the deleted pending ref before a later native append.
close=$(git commit-tree "$(git rev-parse "$parent^{tree}")" -p "$parent" -p "$legacy_root" -m $'Close legacy epic\n\nCloses-Epic: #9')
git push -q --atomic origin "$close:refs/heads/master" :refs/heads/tasks/pending/9
retired_out=$(taskdag_internal_mint_epic_root "$(native_spec d 2026-07-25T00:00:04Z Retired)")
if jq -e '.created==true' <<<"$retired_out" >/dev/null \
  && ! git --git-dir="$ROOT/origin" show-ref --verify --quiet refs/heads/tasks/pending/9; then
  ok "retired legacy adoption permits native append without resurrection"
else bad "retired legacy root blocked append or was resurrected"; fi

# Registry bytes alone cannot resurrect a legacy root absent at origin, even
# when stale local issue/pending refs still point at its historical commit.
git push -q origin :refs/heads/gh/issues/9
before=$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)
taskdag_internal_mint_epic_root "$legacy_spec" >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 3 ] && [ "$before" = "$(git --git-dir="$ROOT/origin" for-each-ref --format='%(refname) %(objectname)' | sort)" ]; then
  ok "origin-absent legacy root fails closed without registry-only resurrection"
else bad "registry or stale local refs resurrected origin-absent legacy root"; fi

if "$TD" epic-create --help | grep -q 'Atomically create or replay an Epic-ID root'; then ok "public epic-create exposes minter contract"; else bad "epic-create help missing"; fi
echo "PASS=$pass FAIL=$fail"; [ "$fail" -eq 0 ]
