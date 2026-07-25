#!/usr/bin/env bash
# Read-only Epic-ID registry and typed close codec fixtures.
set -uo pipefail

TD=${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}
LIB_DIR=$(dirname "$TD")/task-dag.d
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0 FAIL=0
ok() { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
EMPTY_TREE=4b825dc642cb6eb9a060e54bf8d69288fbee4904
taskdag_json_file_is_single_strict() {
    jq -e . "$1" >/dev/null 2>&1
}
source "$LIB_DIR/git-objects.sh"
source "$LIB_DIR/task-model.sh"
source "$LIB_DIR/epic-registry.sh"

if [ "$(taskdag_provider_binding_key github R_target I_80)" = "129d204244299cb69e42e96ecfe025a5de86b3d939588bd68988197d5c5dd885" ]; then
    ok "provider binding domain has the fixed golden vector"
else bad "provider binding key domain drifted"; fi

git init -q "$ROOT/repo"
cd "$ROOT/repo"
printf seed >seed; git add seed; git commit -qm seed
operation=$(printf 'a%.0s' {1..64})
epic_id=$(taskdag_epic_id_for_operation R_source "$operation")
descriptor=$(jq -ncS --arg epic "$epic_id" --arg operation "$operation" '{schema:1,epicId:$epic,origin:{kind:"operation",operationId:$operation,repositoryId:"R_source"},projection:{issueId:null,issueNumber:null,issueUrl:null,provider:"github",repository:"owner/repo",repositoryId:"R_target"},task:{author:"worker",description:"",status:"pending",title:"Typed root",type:"epic"}}')
taskdag_serialize_epic_root_message <<<"$descriptor" >"$ROOT/root-message"
root_commit=$(git commit-tree "$EMPTY_TREE" -p HEAD <"$ROOT/root-message")
record=$(jq -ncS --argjson descriptor "$descriptor" --arg epic "$epic_id" --arg root "$root_commit" '{descriptor:$descriptor,epicId:$epic,kind:"native-epic-v1",legacyAdoption:null,rootCommit:$root,schema:1}')
printf '%s\n' "$record" >"$ROOT/record"
blob=$(git hash-object -w "$ROOT/record")
digest=${epic_id#epic-v1:}
idx=$ROOT/index
GIT_INDEX_FILE=$idx git update-index --add --cacheinfo "100644,$blob,roots/$digest.json"
tree=$(GIT_INDEX_FILE=$idx git write-tree)
registry=$(git commit-tree "$tree" -m 'Epic registry genesis')

if taskdag_epic_registry_validate_history "$registry" "$(git rev-parse HEAD)" \
    && [ "$(taskdag_epic_registry_record "$epic_id" "$registry")" = "$record" ]; then
    ok "unbound native registry genesis and Epic-ID lookup validate"
else
    bad "valid native registry was rejected"
fi

provider_epic=$(taskdag_epic_id_for_provider github R_target I_80)
provider_descriptor=$(jq -ncS --arg epic "$provider_epic" '{schema:1,epicId:$epic,origin:{issueId:"I_80",kind:"provider",provider:"github",repositoryId:"R_target"},projection:{issueId:"I_80",issueNumber:"80",issueUrl:"https://github.com/owner/repo/issues/80",provider:"github",repository:"owner/repo",repositoryId:"R_target"},task:{author:"worker",description:"",status:"pending",title:"Bound root",type:"epic"}}')
taskdag_serialize_epic_root_message <<<"$provider_descriptor" >"$ROOT/provider-message"
provider_root=$(git commit-tree "$EMPTY_TREE" -p HEAD <"$ROOT/provider-message")
provider_record=$(jq -ncS --argjson descriptor "$provider_descriptor" --arg epic "$provider_epic" --arg root "$provider_root" '{descriptor:$descriptor,epicId:$epic,kind:"native-epic-v1",legacyAdoption:null,rootCommit:$root,schema:1}')
binding=$(jq -ncS --argjson projection "$(jq -c .projection <<<"$provider_descriptor")" --arg epic "$provider_epic" '{epicId:$epic,projection:$projection,schema:1}')
printf '%s\n' "$provider_record" >"$ROOT/provider-record"; printf '%s\n' "$binding" >"$ROOT/binding"
provider_record_blob=$(git hash-object -w "$ROOT/provider-record"); binding_blob=$(git hash-object -w "$ROOT/binding")
provider_digest=${provider_epic#epic-v1:}; provider_key=$(taskdag_provider_binding_key github R_target I_80)
bound_idx=$ROOT/bound-index; GIT_INDEX_FILE=$bound_idx git read-tree "$tree"
GIT_INDEX_FILE=$bound_idx git update-index --add --cacheinfo "100644,$provider_record_blob,roots/$provider_digest.json"
GIT_INDEX_FILE=$bound_idx git update-index --add --cacheinfo "100644,$binding_blob,bindings/by-epic/$provider_digest.json"
GIT_INDEX_FILE=$bound_idx git update-index --add --cacheinfo "100644,$binding_blob,bindings/by-provider/$provider_key.json"
bound_tree=$(GIT_INDEX_FILE=$bound_idx git write-tree); bound_registry=$(git commit-tree "$bound_tree" -p "$registry" -m 'Add bound root')
if taskdag_epic_registry_validate_history "$bound_registry" "$(git rev-parse HEAD)" \
    && [ "$(taskdag_epic_registry_binding "$provider_epic" "$bound_registry")" = "$binding" ] \
    && [ "$(taskdag_epic_registry_provider_binding github R_target I_80 "$bound_registry")" = "$binding" ]; then
    ok "bound native root has paired canonical binding and reverse lookup"
else bad "bound native registry or lookup was rejected"; fi

orphan_idx=$ROOT/orphan-index; GIT_INDEX_FILE=$orphan_idx git read-tree "$tree"
GIT_INDEX_FILE=$orphan_idx git update-index --add --cacheinfo "100644,$binding_blob,bindings/by-epic/$provider_digest.json"
orphan=$(git commit-tree "$(GIT_INDEX_FILE=$orphan_idx git write-tree)" -m orphan)
one_side_idx=$ROOT/one-side-index; GIT_INDEX_FILE=$one_side_idx git read-tree "$tree"
GIT_INDEX_FILE=$one_side_idx git update-index --add --cacheinfo "100644,$provider_record_blob,roots/$provider_digest.json"
GIT_INDEX_FILE=$one_side_idx git update-index --add --cacheinfo "100644,$binding_blob,bindings/by-epic/$provider_digest.json"
one_side=$(git commit-tree "$(GIT_INDEX_FILE=$one_side_idx git write-tree)" -m one-sided)
if ! taskdag_epic_registry_validate_history "$orphan" >/dev/null 2>&1 \
    && ! taskdag_epic_registry_validate_history "$one_side" >/dev/null 2>&1; then
    ok "orphan and one-sided binding snapshots fail closed"
else bad "orphan or one-sided binding was accepted"; fi

legacy_epic=$(taskdag_epic_id_for_provider github R_target I_81)
legacy_descriptor=$(jq -ncS --arg epic "$legacy_epic" '{schema:1,epicId:$epic,origin:{issueId:"I_81",kind:"provider",provider:"github",repositoryId:"R_target"},projection:{issueId:"I_81",issueNumber:"81",issueUrl:"https://github.com/owner/repo/issues/81",provider:"github",repository:"owner/repo",repositoryId:"R_target"},task:{author:"worker",description:"legacy body",status:"pending",title:"Legacy adopted",type:"epic"}}')
taskdag_serialize_task_message 'Legacy adopted' '#81' worker https://github.com/owner/repo/issues/81 pending epic 'legacy body' >"$ROOT/legacy-message"
legacy_root=$(git commit-tree "$EMPTY_TREE" -p HEAD <"$ROOT/legacy-message")
git update-ref refs/heads/gh/issues/81 "$legacy_root"; git update-ref refs/heads/tasks/pending/81 "$legacy_root"
legacy_record=$(jq -ncS --argjson descriptor "$legacy_descriptor" --arg epic "$legacy_epic" --arg root "$legacy_root" '{descriptor:$descriptor,epicId:$epic,kind:"legacy-adoption-v1",legacyAdoption:{issueNumber:"81",issueRef:"refs/heads/gh/issues/81",pendingRef:"refs/heads/tasks/pending/81"},rootCommit:$root,schema:1}')
legacy_binding=$(jq -ncS --argjson projection "$(jq -c .projection <<<"$legacy_descriptor")" --arg epic "$legacy_epic" '{epicId:$epic,projection:$projection,schema:1}')
printf '%s\n' "$legacy_record" >"$ROOT/legacy-record"; printf '%s\n' "$legacy_binding" >"$ROOT/legacy-binding"
legacy_record_blob=$(git hash-object -w "$ROOT/legacy-record"); legacy_binding_blob=$(git hash-object -w "$ROOT/legacy-binding")
legacy_digest=${legacy_epic#epic-v1:}; legacy_key=$(taskdag_provider_binding_key github R_target I_81)
legacy_idx=$ROOT/legacy-index; GIT_INDEX_FILE=$legacy_idx git read-tree "$bound_tree"
GIT_INDEX_FILE=$legacy_idx git update-index --add --cacheinfo "100644,$legacy_record_blob,roots/$legacy_digest.json"
GIT_INDEX_FILE=$legacy_idx git update-index --add --cacheinfo "100644,$legacy_binding_blob,bindings/by-epic/$legacy_digest.json"
GIT_INDEX_FILE=$legacy_idx git update-index --add --cacheinfo "100644,$legacy_binding_blob,bindings/by-provider/$legacy_key.json"
legacy_tree=$(GIT_INDEX_FILE=$legacy_idx git write-tree); legacy_registry=$(git commit-tree "$legacy_tree" -p "$bound_registry" -m 'Adopt legacy root')
if taskdag_epic_registry_validate_history "$legacy_registry" "$(git rev-parse HEAD)"; then
    ok "live legacy adoption validates exact root, refs, message, and projection"
else bad "live legacy adoption was rejected"; fi
legacy_close=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -p "$legacy_root" -m $'Close legacy epic\n\nCloses-Epic: #81')
git update-ref -d refs/heads/tasks/pending/81
if taskdag_epic_registry_validate_history "$legacy_registry" "$legacy_close"; then
    ok "retired legacy adoption validates through narrow authority close fact"
else bad "retired legacy adoption was rejected"; fi
wrong_adoption=$(jq -cS '.legacyAdoption.issueNumber="82"' <<<"$legacy_record"); printf '%s\n' "$wrong_adoption" >"$ROOT/wrong-adoption"
wrong_blob=$(git hash-object -w "$ROOT/wrong-adoption"); wrong_idx=$ROOT/wrong-adoption-index; GIT_INDEX_FILE=$wrong_idx git read-tree "$legacy_tree"
GIT_INDEX_FILE=$wrong_idx git update-index --cacheinfo "100644,$wrong_blob,roots/$legacy_digest.json"
wrong_registry=$(git commit-tree "$(GIT_INDEX_FILE=$wrong_idx git write-tree)" -m wrong-adoption)
if ! taskdag_epic_registry_validate_history "$wrong_registry" "$legacy_close" >/dev/null 2>&1; then
    ok "wrong legacy adoption metadata fails closed"
else bad "wrong legacy adoption metadata was accepted"; fi

tip=$(git rev-parse HEAD); close=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p "$tip" -p "$root_commit" -m "Close typed epic

Closes-Epic-ID: $epic_id")
if [ "$(taskdag_parse_epic_close_commit "$close" "$registry")" = "$epic_id"$'\t'"$close"$'\t'"$root_commit" ]; then
    ok "canonical typed close resolves its registry-declared root"
else
    bad "canonical typed close was rejected"
fi

export TASKDAG_CURRENT_REPO=owner/repo
source "$LIB_DIR/repository-identity.sh"
source "$LIB_DIR/edges.sh"
source "$LIB_DIR/facts.sh"
git update-ref refs/heads/tasks/v1/epics "$registry"
git update-ref HEAD "$close"
if taskdag_root_closed_at_tip HEAD "$epic_id" "$root_commit" \
    && taskdag_node_done "task:owner/repo@$root_commit" HEAD; then
    ok "typed close is a dual root-close fact and completes its root task node"
else bad "typed close was not exposed through facts.sh root readers"; fi

taskdag_recon_prepare() { :; }
taskdag_node_complete() { :; }
taskdag_consumer_prepare() { :; }
TASKDAG_ENTRYPOINT=$TD
source "$LIB_DIR/graph-converge.sh"
typed_nodes=$(taskdag_push_completed_nodes "$close")
if [ "$typed_nodes" = "task:owner/repo@$root_commit"$'\t'"$close" ]; then
    ok "graph convergence emits the registry root task node for typed close"
else bad "graph convergence typed close output was wrong: $typed_nodes"; fi

mixed=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p "$tip" -p "$root_commit" -m "Mixed close

Closes-Epic: #80
Closes-Epic-ID: $epic_id")
wrong=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p "$tip" -p "$tip" -m "Wrong root

Closes-Epic-ID: $epic_id")
if ! taskdag_parse_epic_close_commit "$mixed" "$registry" >/dev/null 2>&1 \
    && ! taskdag_parse_epic_close_commit "$wrong" "$registry" >/dev/null 2>&1 \
    && ! taskdag_parse_epic_close_commit "$close" deadbeef >/dev/null 2>&1; then
    ok "mixed, wrong-root, and missing-registry typed closes fail closed"
else
    bad "malformed typed close was accepted"
fi
git update-ref HEAD "$mixed"
if [ -z "$(taskdag_push_completed_nodes "$mixed")" ]; then
    ok "graph convergence emits no completion for mixed close facts"
else bad "graph convergence trusted a mixed close fact"; fi
git update-ref -d refs/heads/tasks/v1/epics
git update-ref HEAD "$close"
missing_registry_rc=0
taskdag_push_completed_nodes "$close" >/dev/null 2>&1 || missing_registry_rc=$?
if [ "$missing_registry_rc" -eq 2 ]; then
    ok "graph convergence propagates rc 2 for typed completion without registry authority"
else bad "graph convergence did not fail indeterminate without registry authority (rc $missing_registry_rc)"; fi

# Every reachable typed key selects the typed dialect. Empty/duplicate values,
# absent authority, and malformed authority all fail indeterminate without
# changing HEAD, refs, or the object database.
assert_typed_predicate_rc2_no_mutation() { # label tip registry-or-empty
    local label=$1 bad_tip=$2 registry_ref=$3 before_head before_refs before_objects rc=0
    if [ -n "$registry_ref" ]; then
        git update-ref refs/heads/tasks/v1/epics "$registry_ref"
    else
        git update-ref -d refs/heads/tasks/v1/epics
    fi
    git update-ref HEAD "$bad_tip"
    before_head=$(git rev-parse HEAD)
    before_refs=$(git for-each-ref --format='%(refname) %(objectname)' | sort)
    before_objects=$(git count-objects -v | awk '$1=="count:"{print $2}')
    rc=0; taskdag_typed_root_completed_at_tip HEAD "$root_commit" >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq 2 ] \
        && [ "$(git rev-parse HEAD)" = "$before_head" ] \
        && [ "$(git for-each-ref --format='%(refname) %(objectname)' | sort)" = "$before_refs" ] \
        && [ "$(git count-objects -v | awk '$1=="count:"{print $2}')" = "$before_objects" ]; then
        ok "$label returns rc 2 without mutating objects, HEAD, or refs"
    else
        bad "$label did not preserve indeterminate/no-mutation contract (rc $rc)"
    fi
}

empty_typed=$(git commit-tree "$(git rev-parse "$tip^{tree}")" -p "$tip" -p "$root_commit" -m $'Empty typed close\n\nCloses-Epic-ID:')
duplicate_typed=$(git commit-tree "$(git rev-parse "$tip^{tree}")" -p "$tip" -p "$root_commit" -m "Duplicate typed close

Closes-Epic-ID: $epic_id
Closes-Epic-ID: $epic_id")
assert_typed_predicate_rc2_no_mutation "typed key with no registry" "$close" ""
assert_typed_predicate_rc2_no_mutation "empty typed key" "$empty_typed" "$registry"
assert_typed_predicate_rc2_no_mutation "duplicate typed keys" "$duplicate_typed" "$registry"

printf '%s\n\n' "$record" >"$ROOT/noncanonical"
bad_blob=$(git hash-object -w "$ROOT/noncanonical")
bad_idx=$ROOT/bad-index
GIT_INDEX_FILE=$bad_idx git update-index --add --cacheinfo "100644,$bad_blob,roots/$digest.json"
bad_tree=$(GIT_INDEX_FILE=$bad_idx git write-tree)
bad_registry=$(git commit-tree "$bad_tree" -m bad)
assert_typed_predicate_rc2_no_mutation "typed key with malformed registry" "$close" "$bad_registry"
replace_idx=$ROOT/replace-index
GIT_INDEX_FILE=$replace_idx git read-tree "$tree"
GIT_INDEX_FILE=$replace_idx git update-index --cacheinfo "100644,$bad_blob,roots/$digest.json"
replace_tree=$(GIT_INDEX_FILE=$replace_idx git write-tree)
replacement=$(git commit-tree "$replace_tree" -p "$registry" -m replacement)
if ! taskdag_epic_registry_validate_history "$bad_registry" >/dev/null 2>&1 \
    && ! taskdag_epic_registry_validate_history "$replacement" >/dev/null 2>&1; then
    ok "noncanonical blobs and replacement history are rejected"
else
    bad "malformed registry history was accepted"
fi

if ! "$TD" --help | grep -Eq 'epic-adopt|epic-registry-append|typed-close'; then
    ok "registry, adoption, and typed-close writers remain unavailable"
else
    bad "a reader-only protocol writer was exposed"
fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
