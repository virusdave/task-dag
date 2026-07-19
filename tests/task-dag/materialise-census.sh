#!/usr/bin/env bash
set -uo pipefail
TD=${1:-"$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag"}
TD=$(realpath "$TD")
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
pass=0 fail=0
ok() { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; fail=$((fail+1)); }
git init -q "$ROOT/repo"; git -C "$ROOT/repo" config user.name fixture; git -C "$ROOT/repo" config user.email fixture@example.test
git -C "$ROOT/repo" config taskdag.current-repo virusdave/task-dag
printf x >"$ROOT/repo/x"; git -C "$ROOT/repo" add x; git -C "$ROOT/repo" commit -qm fixture
tip=$(git -C "$ROOT/repo" rev-parse HEAD)
git -C "$ROOT/repo" update-ref refs/heads/gh/child-epic-slots/1/virusdave/task-dag/slot "$tip"
git -C "$ROOT/repo" update-ref refs/heads/tasks/completions/1/virusdave/task-dag/2/abcdef0 "$tip"
git -C "$ROOT/repo" update-ref refs/heads/tasks/delegated/1/virusdave/task-dag/2 "$tip"
jq -ncS --arg tip "$tip" '{schema:1,sourceTips:[{repository:"virusdave/task-dag",ref:"refs/heads/master",commit:$tip}],registrySnapshot:{repositories:[{repository:"virusdave/task-dag",repositoryId:"R_fixture",name:"task-dag"}]}}' >"$ROOT/activation"
jq '.state="enabled"' "$ROOT/activation" >"$ROOT/capture-activation"
mkdir "$ROOT/capture-bin"
cat >"$ROOT/capture-bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
endpoint="${*: -1}"
if [[ "$endpoint" == repos/virusdave/task-dag ]]; then
  printf '%s\n' '{"full_name":"virusdave/task-dag","node_id":"R_fixture"}'
else
  count=0; [ ! -n "${CAPTURE_COUNTER:-}" ] || { count=$(cat "$CAPTURE_COUNTER" 2>/dev/null || echo 0); count=$((count+1)); printf '%s\n' "$count" >"$CAPTURE_COUNTER"; }
  [ "${CAPTURE_MODE:-}" != mutate-ref ] || [ "$count" -ne 1 ] || git -C "$CAPTURE_REPO" update-ref refs/heads/tasks/mutated "$CAPTURE_TIP"
  case "${CAPTURE_MODE:-}" in
    pages) printf '%s\n' '[[{"body":"fixture body\n","created_at":"2026-07-17T00:00:00Z","node_id":"I_fixture","number":1,"state":"open","title":"Fixture","user":{"login":"fixture"}}],[{"body":"pr\n","created_at":"2026-07-17T00:00:01Z","node_id":"PR_fixture","number":2,"pull_request":{},"state":"open","title":"PR","user":{"login":"fixture"}},{"body":"second\n","created_at":"2026-07-17T00:00:02Z","node_id":"I_second","number":3,"state":"closed","title":"Second","user":{"login":"fixture"}}]]' ;;
    unstable) printf '[[{"body":"fixture body\\n","created_at":"2026-07-17T00:00:00Z","node_id":"I_fixture","number":1,"state":"open","title":"Fixture %s","user":{"login":"fixture"}}]]\n' "$count" ;;
    pr-unstable) printf '[[{"body":"fixture body\\n","created_at":"2026-07-17T00:00:00Z","node_id":"I_fixture","number":1,"state":"open","title":"Fixture","user":{"login":"fixture"}},{"body":"pr\\n","created_at":"2026-07-17T00:00:01Z","node_id":"PR_fixture","number":2,"pull_request":{},"state":"open","title":"PR %s","user":{"login":"fixture"}}]]\n' "$count" ;;
    *) printf '%s\n' '[[{"body":"fixture body\n","created_at":"2026-07-17T00:00:00Z","node_id":"I_fixture","number":1,"state":"open","title":"Fixture","user":{"login":"fixture"}}]]' ;;
  esac
fi
EOF
chmod +x "$ROOT/capture-bin/gh"
jq -ncS --arg activation "$ROOT/capture-activation" --arg path "$ROOT/repo" \
  '{schema:1,activationRecord:$activation,repositories:[{path:$path,repository:"virusdave/task-dag"}]}' >"$ROOT/capture-input"
PATH="$ROOT/capture-bin:$PATH" "$TD" materialise-census-capture --spec-file "$ROOT/capture-input" --output-dir "$ROOT/captured" >/dev/null \
  && jq -e '.issues[0].completionEvidence[0].disposition=="partial-implementation" and .issues[0].liveDelegations[0].disposition=="live-obligation"' "$ROOT/captured/pages/virusdave_task-dag.0001.json" >/dev/null \
  && ok "capture emits validated conservative census inputs" || bad "valid census capture"
git clone -q "$ROOT/repo" "$ROOT/mixed-repo"; git -C "$ROOT/mixed-repo" config user.name fixture; git -C "$ROOT/mixed-repo" config user.email fixture@example.test; git -C "$ROOT/mixed-repo" config taskdag.current-repo virusdave/task-dag
printf body >"$ROOT/mixed-repo/body"; git -C "$ROOT/mixed-repo" add body; git -C "$ROOT/mixed-repo" commit -qm $'fixture\n\nMaterialise-Child-Epic: VirusDave/Task-Dag\nChild-Epic-Title: Mixed case fixture\nChild-Epic-Body-File: body\nParent-Issue: 1'
mixed_tip=$(git -C "$ROOT/mixed-repo" rev-parse HEAD); jq --arg tip "$mixed_tip" '.sourceTips[0].commit=$tip' "$ROOT/capture-activation" >"$ROOT/mixed-activation"
jq -ncS --arg activation "$ROOT/mixed-activation" --arg path "$ROOT/mixed-repo" '{schema:1,activationRecord:$activation,repositories:[{path:$path,repository:"virusdave/task-dag"}]}' >"$ROOT/mixed-input"
PATH="$ROOT/capture-bin:$PATH" "$TD" materialise-census-capture --spec-file "$ROOT/mixed-input" --output-dir "$ROOT/mixed-capture" >/dev/null \
  && jq -e '.issues[0].declarations[0].peerRepo.name=="VirusDave/Task-Dag"' "$ROOT/mixed-capture/pages/virusdave_task-dag.0001.json" >/dev/null \
  && ok "capture preserves mixed-case legacy declaration identity" || bad "mixed-case census capture"
if PATH="$ROOT/capture-bin:$PATH" "$TD" materialise-census-capture --spec-file "$ROOT/capture-input" --output-dir "$ROOT/captured" >/dev/null 2>&1; then bad "capture overwrote existing output"; else ok "capture output is no-clobber"; fi
CAPTURE_MODE=pages CAPTURE_COUNTER="$ROOT/pages-counter" PATH="$ROOT/capture-bin:$PATH" "$TD" materialise-census-capture --spec-file "$ROOT/capture-input" --output-dir "$ROOT/captured-pages" >/dev/null \
  && [ "$(jq '.issuePages|length' "$ROOT/captured-pages/spec.json")" -eq 2 ] \
  && jq -se '[.[].issues[]|.number]==[1,2,3]' "$ROOT/captured-pages/pages/"*.json >/dev/null \
  && ok "capture preserves complete issues-endpoint pagination" || bad "paginated census capture"
if CAPTURE_MODE=unstable CAPTURE_COUNTER="$ROOT/unstable-counter" PATH="$ROOT/capture-bin:$PATH" "$TD" materialise-census-capture --spec-file "$ROOT/capture-input" --output-dir "$ROOT/unstable" >/dev/null 2>&1 \
  || [ -e "$ROOT/unstable" ]; then bad "capture accepted changing API snapshots"; else ok "capture rejects changing API snapshots without output"; fi
if CAPTURE_MODE=pr-unstable CAPTURE_COUNTER="$ROOT/pr-unstable-counter" PATH="$ROOT/capture-bin:$PATH" "$TD" materialise-census-capture --spec-file "$ROOT/capture-input" --output-dir "$ROOT/pr-unstable" >/dev/null 2>&1 \
  || [ -e "$ROOT/pr-unstable" ]; then bad "capture accepted changing pull request snapshots"; else ok "capture rejects pull request-only API mutation"; fi
if CAPTURE_MODE=mutate-ref CAPTURE_COUNTER="$ROOT/mutate-counter" CAPTURE_REPO="$ROOT/repo" CAPTURE_TIP="$tip" PATH="$ROOT/capture-bin:$PATH" "$TD" materialise-census-capture --spec-file "$ROOT/capture-input" --output-dir "$ROOT/mutated" >/dev/null 2>&1 \
  || [ -e "$ROOT/mutated" ]; then bad "capture accepted repository mutation"; else ok "capture rejects repository mutation without output"; fi
git -C "$ROOT/repo" update-ref -d refs/heads/tasks/mutated
"$TD" materialise-census --spec-file "$ROOT/captured/spec.json" --artifact "$ROOT/captured-again" --digest-file "$ROOT/captured-again.digest" \
  && ok "published capture is a self-contained offline input" || bad "self-contained capture replay"
jq -ncS --arg oid "$tip" '{schema:1,issues:[{body:"fixture body\n",completionEvidence:[{disposition:"partial-implementation",oid:$oid,ref:"refs/heads/tasks/completions/1/virusdave/task-dag/2/abcdef0"}],createdAt:"2026-07-17T00:00:00Z",creator:"fixture",declarations:[],id:"I_fixture",liveDelegations:[{disposition:"live-obligation",oid:$oid,parentIssue:1,parentRepo:"virusdave/task-dag",peerIssue:2,peerRepo:"virusdave/task-dag",ref:"refs/heads/tasks/delegated/1/virusdave/task-dag/2"}],markers:[{oid:$oid,ref:"refs/heads/gh/child-epic-slots/1/virusdave/task-dag/slot"}],number:1,repositoryId:"R_fixture",state:"OPEN",title:"Fixture"}]}' >"$ROOT/page"
jq -ncS --arg activation "$ROOT/activation" --arg path "$ROOT/repo" --arg tip "$tip" --arg page "$ROOT/page" '{schema:1,activationRecord:$activation,repositories:[{path:$path,repository:"virusdave/task-dag",tip:$tip}],issuePages:[{file:$page,hasNextPage:false,page:1,repository:"virusdave/task-dag"}]}' >"$ROOT/spec"
"$TD" materialise-census --spec-file "$ROOT/spec" --artifact "$ROOT/a" --digest-file "$ROOT/ad" || bad "valid census"
"$TD" materialise-census --spec-file "$ROOT/spec" --artifact "$ROOT/b" --digest-file "$ROOT/bd" || bad "repeat census"
cmp -s "$ROOT/a" "$ROOT/b" && cmp -s "$ROOT/ad" "$ROOT/bd" && ok "artifact and digest are deterministic" || bad "deterministic bytes"
jq -e 'keys==["activationRecordDigest","issues","legacyCompletionRefs","liveDelegations","schema","slots"] and .slots==[] and (.legacyCompletionRefs|length)==1 and .legacyCompletionRefs[0].disposition=="partial-implementation" and (.liveDelegations|length)==1 and .liveDelegations[0].disposition=="live-obligation"' "$ROOT/a" >/dev/null && ok "marker is not completion and old/live refs have independent dispositions" || bad "artifact disposition arrays"
git -C "$ROOT/repo" config taskdag.current-repo substitute/repo
if "$TD" materialise-census --spec-file "$ROOT/spec" --artifact "$ROOT/wrong-repo" --digest-file "$ROOT/wrong-repo-digest" >/dev/null 2>&1; then bad "mislabeled source checkout accepted"; else ok "source checkout identity is registry-bound"; fi
git -C "$ROOT/repo" config taskdag.current-repo virusdave/task-dag
jq '.sourceTips[0].ref="refs/heads/missing"' "$ROOT/activation" >"$ROOT/activation.bad"; jq --arg a "$ROOT/activation.bad" '.activationRecord=$a' "$ROOT/spec" >"$ROOT/spec.bad"
if "$TD" materialise-census --spec-file "$ROOT/spec.bad" --artifact "$ROOT/wrong-ref" --digest-file "$ROOT/wrong-ref-digest" >/dev/null 2>&1; then bad "unresolved activation source ref accepted"; else ok "activation source ref is frozen to its commit"; fi
cp "$ROOT/page" "$ROOT/page.saved"; jq '.issues[0].markers=[]' "$ROOT/page.saved" >"$ROOT/page"
if "$TD" materialise-census --spec-file "$ROOT/spec" --artifact "$ROOT/omitted" --digest-file "$ROOT/omitted-digest" >/dev/null 2>&1; then bad "omitted frozen marker accepted"; else ok "omitted frozen marker fails closed"; fi
mv "$ROOT/page.saved" "$ROOT/page"
git -C "$ROOT/repo" update-ref refs/heads/gh/child-epics/1/unknown/repo "$tip"
jq --arg oid "$tip" '.issues[0].markers += [{oid:$oid,ref:"refs/heads/gh/child-epics/1/unknown/repo"}] | .issues[0].markers |= sort_by(.ref)' "$ROOT/page" >"$ROOT/page.bad"
if mv "$ROOT/page" "$ROOT/page.saved" && mv "$ROOT/page.bad" "$ROOT/page" && "$TD" materialise-census --spec-file "$ROOT/spec" --artifact "$ROOT/unknown-marker" --digest-file "$ROOT/unknown-marker-digest" >/dev/null 2>&1; then bad "unknown marker peer accepted"; else ok "marker peer is registry-bound"; fi
mv "$ROOT/page.saved" "$ROOT/page"; git -C "$ROOT/repo" update-ref -d refs/heads/gh/child-epics/1/unknown/repo
jq '.issues[0].liveDelegations[0].peerRepo="unknown/repo"' "$ROOT/page" >"$ROOT/page.bad"
if mv "$ROOT/page" "$ROOT/page.saved" && mv "$ROOT/page.bad" "$ROOT/page" && "$TD" materialise-census --spec-file "$ROOT/spec" --artifact "$ROOT/unknown" --digest-file "$ROOT/unknown-digest" >/dev/null 2>&1; then bad "unknown delegation peer accepted"; else ok "unknown delegation peer fails closed"; fi
mv "$ROOT/page.saved" "$ROOT/page"
jq '.issues[0].repositoryId="R_substitute"' "$ROOT/page" >"$ROOT/page.bad"
if mv "$ROOT/page" "$ROOT/page.saved" && mv "$ROOT/page.bad" "$ROOT/page" && "$TD" materialise-census --spec-file "$ROOT/spec" --artifact "$ROOT/substitute" --digest-file "$ROOT/substitute-digest" >/dev/null 2>&1; then bad "repository identity substitution accepted"; else ok "page repository identity is registry-bound"; fi
mv "$ROOT/page.saved" "$ROOT/page"
jq '.repositories[0].tip="0000000000000000000000000000000000000000"' "$ROOT/spec" >"$ROOT/bad"
if "$TD" materialise-census --spec-file "$ROOT/bad" --artifact "$ROOT/no" --digest-file "$ROOT/nod" >/dev/null 2>&1; then bad "changed tip accepted"; else ok "changed tip fails"; fi; [ ! -e "$ROOT/no" ] || bad "changed tip wrote artifact"
jq '.issuePages[0].hasNextPage=true' "$ROOT/spec" >"$ROOT/bad"
if "$TD" materialise-census --spec-file "$ROOT/bad" --artifact "$ROOT/no2" --digest-file "$ROOT/no2d" >/dev/null 2>&1; then bad "incomplete pagination accepted"; else ok "incomplete pagination fails"; fi; [ ! -e "$ROOT/no2" ] || bad "incomplete pagination wrote artifact"
jq '.issues += [.issues[0]]' "$ROOT/page" >"$ROOT/page.n"; mv "$ROOT/page.n" "$ROOT/page"
if "$TD" materialise-census --spec-file "$ROOT/spec" --artifact "$ROOT/no3" --digest-file "$ROOT/no3d" >/dev/null 2>&1; then bad "issue node collision accepted"; else ok "issue node collision fails"; fi; [ ! -e "$ROOT/no3" ] || bad "collision wrote artifact"

# Full enabled import: both frozen repositories contain the real histories
# consumed by the strict delegated-close validator.
I="$ROOT/integration"; mkdir -p "$I"; REPO_ROOT=$(cd "$(dirname "$TD")/.." && pwd); runtime=$(git -C "$REPO_ROOT" rev-parse HEAD); activation_floor=$(git -C "$REPO_ROOT" rev-list --max-parents=0 "$runtime" | head -1)
git init -q --bare "$I/origin"; git clone -q "$REPO_ROOT" "$I/parent"; git -C "$I/parent" remote set-url origin "$I/origin"; git -C "$I/parent" push -q origin HEAD:master
git -C "$I/parent" config taskdag.current-repo virusdave/task-dag
git init -q "$I/peer"; git -C "$I/peer" config user.name fixture; git -C "$I/peer" config user.email fixture@example.test
git -C "$I/peer" config taskdag.current-repo peer/repo
printf peer >"$I/peer/file"; git -C "$I/peer" add file; git -C "$I/peer" commit -qm base
empty=$(git -C "$I/peer" mktree </dev/null); peer_root=$(git -C "$I/peer" commit-tree "$empty" -p HEAD -m $'Task: Peer epic\n\nIssue: #2\nType: epic')
git -C "$I/peer" update-ref refs/heads/gh/issues/2 "$peer_root"; peer_first=$(git -C "$I/peer" rev-parse HEAD)
peer_close=$(git -C "$I/peer" commit-tree "$(git -C "$I/peer" rev-parse "$peer_first^{tree}")" -p "$peer_first" -p "$peer_root" -m $'Close peer epic\n\nCloses-Epic: #2')
git -C "$I/peer" update-ref refs/heads/master "$peer_close"
git init -q --bare "$I/peer-origin"; git -C "$I/peer" remote add origin "$I/peer-origin"
git -C "$I/peer" push -q origin refs/heads/master refs/heads/gh/issues/2
parent_empty=$(git -C "$I/parent" mktree </dev/null); dd=$(printf declaration | sha256sum | awk '{print $1}')
delegation=$(git -C "$I/parent" commit-tree "$parent_empty" -m $'kind: delegated\nrole: system\nintent: delegated-child\n\nissue:\n  repo: virusdave/task-dag\n  number: 1\n\ndelegated:\n  repo: peer/repo\n  number: 2\n\nParent-Repo-Node-Id: PR_parent\nParent-Issue-Node-Id: PI_parent\nPeer-Repo-Node-Id: PR_peer\nPeer-Issue-Node-Id: PI_peer\nMaterialisation-Operation-Id: operation-1\nDeclaration-Digest: '"$dd")
git -C "$I/parent" update-ref refs/heads/tasks/delegated/1/peer/repo/2 "$delegation"
orphan=$(git -C "$I/parent" commit-tree "$parent_empty" -m 'orphan legacy completion')
git -C "$I/parent" update-ref refs/heads/tasks/completions/1/peer/repo/2/deadbee "$orphan"
git -C "$I/parent" push -q origin refs/heads/tasks/delegated/1/peer/repo/2 refs/heads/tasks/completions/1/peer/repo/2/deadbee
historical_index="$I/historical-index"; GIT_INDEX_FILE="$historical_index" git -C "$REPO_ROOT" read-tree "$runtime"
for historical_body in adopt rearm initial; do
  historical_blob=$(printf %s "$historical_body body" | git -C "$REPO_ROOT" hash-object -w --stdin)
  GIT_INDEX_FILE="$historical_index" git -C "$REPO_ROOT" update-index --add --cacheinfo "100644,$historical_blob,$historical_body-body"
done
historical_tree=$(GIT_INDEX_FILE="$historical_index" git -C "$REPO_ROOT" write-tree); rm -f "$historical_index"
parent_tip=$(printf '%s\n' $'Record historical materialisation declarations\n\nMaterialise-Child-Epic: peer/repo\nChild-Epic-Title: Adopt\nChild-Epic-Body-File: adopt-body\nParent-Issue: 1\nChild-Epic-Slug: fixture\n\nMaterialise-Child-Epic: Peer/Repo\nChild-Epic-Title: Rearm\nChild-Epic-Body-File: rearm-body\nParent-Issue: 1\nChild-Epic-Slug: rearm\n\nMaterialise-Child-Epic: peer/repo\nChild-Epic-Title: Initial\nChild-Epic-Body-File: initial-body\nParent-Issue: 1\nChild-Epic-Slug: initial' | git -C "$REPO_ROOT" commit-tree "$historical_tree" -p "$activation_floor")
git --git-dir="$I/origin" update-ref -d refs/heads/master
git -C "$REPO_ROOT" push -q "$I/origin" "$parent_tip:refs/heads/master"
git -C "$I/parent" fetch -q origin master; git -C "$I/parent" reset -q --hard "$parent_tip"
registry_commit=1111111111111111111111111111111111111111; registry_blob=2222222222222222222222222222222222222222
jq -ncS --arg c "$registry_commit" --arg b "$registry_blob" '{schema:1,source:{repository:"virusdave/top-level",path:"registry.json",commit:$c,blob:$b},repositories:[{repository:"peer/repo",repositoryId:"PR_peer",name:"repo",repairMode:"off",repairBranch:null},{repository:"virusdave/task-dag",repositoryId:"PR_parent",name:"task-dag",repairMode:"off",repairBranch:null}]}' >"$I/registry"
TASKDAG_SCRIPT_DIR=$(dirname "$TD"); source "$TASKDAG_SCRIPT_DIR/task-dag.d/activation.sh"; source "$TASKDAG_SCRIPT_DIR/task-dag.d/cross-repo.sh"
registry_id=$(_taskdag_activation_registry_id "$I/registry")
jq -ncS --arg floor "$activation_floor" --arg parent "$parent_tip" --arg pc "$peer_close" --arg rc "$registry_commit" --arg rb "$registry_blob" --arg rid "$registry_id" '{actor:"fixture",authoritativeTimestamp:"2026-07-17T00:00:00Z",minimumCompatibleTaskDagCommit:$floor,registrySnapshot:{id:$rid,schema:1,source:{repository:"virusdave/top-level",path:"registry.json",commit:$rc,blob:$rb},repositories:[{repository:"peer/repo",repositoryId:"PR_peer",name:"repo",repairMode:"off",repairBranch:null},{repository:"virusdave/task-dag",repositoryId:"PR_parent",name:"task-dag",repairMode:"off",repairBranch:null}]},sourceTips:[{repository:"peer/repo",repositoryId:"PR_peer",ref:"refs/heads/master",commit:$pc},{repository:"virusdave/task-dag",repositoryId:"PR_parent",ref:"refs/heads/master",commit:$parent}],state:"enabled"}' >"$I/activation-spec"
(cd "$I/parent" && "$TD" activation apply --spec-file "$I/activation-spec" >/dev/null) || bad "integration activation"
authority=$(git --git-dir="$I/origin" rev-parse refs/heads/tasks/v1/activation); active=$authority
git --git-dir="$I/origin" show "$active:records/0000000000000001.json" >"$I/activation-record"
source "$TASKDAG_SCRIPT_DIR/task-dag.d/materialise.sh"
source "$TASKDAG_SCRIPT_DIR/task-dag.d/materialise-producer.sh"
make_declaration() { # disposition, title, body, slug, output
  local disposition=$1 title=$2 body=$3 slug=$4 out=$5 body_sha body_len slot declaration operation slug_presence peer_name=peer/repo
  [ "$title" != Rearm ] || peer_name=Peer/Repo
  body_sha=$(printf %s "$body" | sha256sum | awk '{print $1}'); body_len=$(printf %s "$body" | wc -c)
  if [ -n "$slug" ]; then slug_presence=present; else slug_presence=absent; fi
  slot=$(_taskdag_materialise_id slot PR_parent PI_parent 1 PR_peer "$slug_presence" "$slug")
  declaration=$(_taskdag_materialise_id declaration PR_parent virusdave/task-dag PI_parent 1 PR_peer "$peer_name" "$title" "$body_sha" "$body_len" "$slug_presence" "$slug" absent '')
  operation=$(_taskdag_materialise_id operation "$slot" "$declaration")
  jq -ncS --arg body "$body" --argjson bodyLength "$body_len" --arg bodySha256 "$body_sha" --arg declarationDigest "$declaration" --arg disposition "$disposition" --arg operationId "$operation" --arg slotId "$slot" --arg title "$title" --arg slug "$slug" --arg peerName "$peer_name" '{schema:1,sourceRepo:{id:"PR_parent",name:"virusdave/task-dag"},parentIssue:{id:"PI_parent",number:1},peerRepo:{id:"PR_peer",name:$peerName},title:$title,body:$body,bodyLength:$bodyLength,bodySha256:$bodySha256,slotId:$slotId,declarationDigest:$declarationDigest,operationId:$operationId,disposition:$disposition} + (if $slug=="" then {} else {slug:$slug} end)' >"$out"
}
make_declaration blocked-repair Adopt 'adopt body' fixture "$I/adopt-declaration"
make_declaration create-in-flight-or-uncertain Rearm 'rearm body' rearm "$I/rearm-declaration"
make_declaration issue-adopted Initial 'initial body' initial "$I/initial-declaration"
jq '.adoptedIssue={issueNodeId:"PI_initial",repositoryId:"PR_peer",number:4}' "$I/initial-declaration" >"$I/initial-declaration.n"; mv "$I/initial-declaration.n" "$I/initial-declaration"
jq -ncS --arg d "$delegation" --arg dd "$dd" --arg pt "$peer_close" --arg pc "$peer_close" --arg pe "$peer_root" --arg orphan "$orphan" --slurpfile adopt "$I/adopt-declaration" --slurpfile rearm "$I/rearm-declaration" --slurpfile initial "$I/initial-declaration" '{schema:1,issues:[{body:"parent\n",completionEvidence:[{disposition:"malformed-evidence",oid:$orphan,ref:"refs/heads/tasks/completions/1/peer/repo/2/deadbee"}],createdAt:"2026-07-17T00:00:00Z",creator:"fixture",declarations:[$adopt[0],$rearm[0],$initial[0]]|sort_by(.slotId),id:"PI_parent",liveDelegations:[{declarationDigest:$dd,delegationCommit:$d,disposition:"verified-child-close",materialisationOperationId:"operation-1",oid:$d,parentIssue:1,parentIssueNodeId:"PI_parent",parentRepo:"virusdave/task-dag",parentRepoNodeId:"PR_parent",peerClose:$pc,peerEpic:$pe,peerIssue:2,peerIssueNodeId:"PI_peer",peerRepo:"peer/repo",peerRepoNodeId:"PR_peer",peerTip:$pt,ref:"refs/heads/tasks/delegated/1/peer/repo/2"}],markers:[],number:1,repositoryId:"PR_parent",state:"OPEN",title:"Parent"}]}' >"$I/parent-page"
jq -ncS '{schema:1,issues:[{body:"adoption target\n",completionEvidence:[],createdAt:"2026-07-17T00:00:00Z",creator:"fixture",declarations:[],id:"PI_adopted",liveDelegations:[],markers:[],number:3,repositoryId:"PR_peer",state:"OPEN",title:"Adopted issue"},{body:"initial adoption target\n",completionEvidence:[],createdAt:"2026-07-17T00:00:00Z",creator:"fixture",declarations:[],id:"PI_initial",liveDelegations:[],markers:[],number:4,repositoryId:"PR_peer",state:"OPEN",title:"Initial adopted issue"}]}' >"$I/peer-page"
jq -ncS --arg a "$I/activation-record" --arg pp "$I/parent-page" --arg ep "$I/peer-page" --arg parent "$I/parent" --arg peer "$I/peer" --arg pt "$parent_tip" --arg pct "$peer_close" '{schema:1,activationRecord:$a,issuePages:[{file:$ep,hasNextPage:false,page:1,repository:"peer/repo"},{file:$pp,hasNextPage:false,page:1,repository:"virusdave/task-dag"}],repositories:[{path:$peer,repository:"peer/repo",tip:$pct},{path:$parent,repository:"virusdave/task-dag",tip:$pt}]}' >"$I/spec"
jq --arg wrong "$peer_root" '.issues[0].liveDelegations[0].peerClose=$wrong' "$I/parent-page" >"$I/wrong-page"
jq --arg page "$I/wrong-page" '(.issuePages[]|select(.repository=="virusdave/task-dag").file)=$page' "$I/spec" >"$I/wrong-spec"
if (cd "$I/parent" && "$TD" materialise-census --spec-file "$I/wrong-spec" --artifact "$I/wrong-census" --digest-file "$I/wrong-digest" >/dev/null 2>&1) \
  || git --git-dir="$I/origin" show-ref --verify --quiet refs/heads/tasks/v1/materialisation \
  || git --git-dir="$I/origin" show-ref --verify --quiet refs/heads/tasks/delegated-close/v1/1/peer/repo/2; then bad "wrong peer close published refs"; else ok "wrong peer close fails with zero publication"; fi
(cd "$I/parent" && "$TD" materialise-census --spec-file "$I/spec" --artifact "$I/census" --digest-file "$I/digest") || bad "valid integration census"
if (cd "$I/parent" && "$TD" materialise-import --spec-file "$I/spec" --artifact "$I/census" --digest-file "$I/digest" >/dev/null 2>&1) \
  || git --git-dir="$I/origin" show-ref --verify --quiet refs/heads/tasks/v1/materialisation; then bad "malformed evidence imported"; else ok "malformed evidence permits zero import"; fi
jq '(.issues[0].completionEvidence[0]) += {disposition:"verified-child-close",delegationRef:"refs/heads/tasks/delegated/1/peer/repo/2"}' "$I/parent-page" >"$I/parent-page.n"; mv "$I/parent-page.n" "$I/parent-page"
jq '(.issues[0].completionEvidence[0].delegationRef)="refs/heads/tasks/delegated/1/peer/repo/99"' "$I/parent-page" >"$I/mismatched-page"
jq --arg page "$I/mismatched-page" '(.issuePages[]|select(.repository=="virusdave/task-dag").file)=$page' "$I/spec" >"$I/mismatched-spec"
if (cd "$I/parent" && "$TD" materialise-census --spec-file "$I/mismatched-spec" --artifact "$I/mismatched" --digest-file "$I/mismatched-digest" >/dev/null 2>&1); then bad "completion/delegation identity mismatch accepted"; else ok "verified completion requires its exact delegation identity"; fi
jq '.issues[0].declarations = .issues[0].declarations[1:]' "$I/parent-page" >"$I/omitted-declaration-page"
jq --arg page "$I/omitted-declaration-page" '(.issuePages[]|select(.repository=="virusdave/task-dag").file)=$page' "$I/spec" >"$I/omitted-declaration-spec"
if (cd "$I/parent" && "$TD" materialise-census --spec-file "$I/omitted-declaration-spec" --artifact "$I/omitted-declaration" --digest-file "$I/omitted-declaration-digest" >/dev/null 2>&1) \
  || git --git-dir="$I/origin" show-ref --verify --quiet refs/heads/tasks/v1/materialisation; then bad "omitted historical declaration published"; else ok "historical declaration omission fails before publication"; fi
make_declaration blocked-repair Invented 'invented body' invented "$I/invented-declaration"
jq --slurpfile invented "$I/invented-declaration" '.issues[0].declarations += $invented | .issues[0].declarations |= sort_by(.slotId)' "$I/parent-page" >"$I/invented-declaration-page"
jq --arg page "$I/invented-declaration-page" '(.issuePages[]|select(.repository=="virusdave/task-dag").file)=$page' "$I/spec" >"$I/invented-declaration-spec"
if (cd "$I/parent" && "$TD" materialise-census --spec-file "$I/invented-declaration-spec" --artifact "$I/invented-declaration-census" --digest-file "$I/invented-declaration-digest" >/dev/null 2>&1) \
  || git --git-dir="$I/origin" show-ref --verify --quiet refs/heads/tasks/v1/materialisation; then bad "invented historical declaration published"; else ok "declaration without historical source fails before publication"; fi
conflict_tip=$(printf '%s\n' $'Conflicting historical materialisation declaration\n\nMaterialise-Child-Epic: peer/repo\nChild-Epic-Title: Conflicting Adopt\nChild-Epic-Body-File: adopt-body\nParent-Issue: 1\nChild-Epic-Slug: fixture' | git -C "$REPO_ROOT" commit-tree "$historical_tree" -p "$parent_tip")
git -C "$REPO_ROOT" push -q "$I/origin" "$conflict_tip:refs/heads/master"; git -C "$I/parent" fetch -q origin master; git -C "$I/parent" reset -q --hard "$conflict_tip"
jq --arg tip "$conflict_tip" '(.sourceTips[]|select(.repository=="virusdave/task-dag").commit)=$tip' "$I/activation-record" >"$I/conflict-activation"
jq --arg activation "$I/conflict-activation" --arg tip "$conflict_tip" '.activationRecord=$activation | (.repositories[]|select(.repository=="virusdave/task-dag").tip)=$tip' "$I/spec" >"$I/conflict-history-spec"
if (cd "$I/parent" && "$TD" materialise-census --spec-file "$I/conflict-history-spec" --artifact "$I/conflict-history" --digest-file "$I/conflict-history-digest" >/dev/null 2>&1) \
  || git --git-dir="$I/origin" show-ref --verify --quiet refs/heads/tasks/v1/materialisation; then bad "same-slot historical conflict published"; else ok "same-slot historical conflict fails before publication"; fi
git --git-dir="$I/origin" update-ref refs/heads/master "$parent_tip" "$conflict_tip"; git -C "$I/parent" fetch -q origin master; git -C "$I/parent" reset -q --hard "$parent_tip"
make_declaration blocked-repair 'Empty Slug' 'adopt body' '' "$I/empty-slug-declaration"
jq --slurpfile declaration "$I/empty-slug-declaration" '.issues[0].declarations += $declaration | .issues[0].declarations |= sort_by(.slotId)' "$I/parent-page" >"$I/empty-slug-page"
empty_slug_tip=$(printf '%s\n' $'Present-empty slug declaration\n\nMaterialise-Child-Epic: peer/repo\nChild-Epic-Title: Empty Slug\nChild-Epic-Body-File: adopt-body\nParent-Issue: 1\nChild-Epic-Slug:' | git -C "$REPO_ROOT" commit-tree "$historical_tree" -p "$parent_tip")
git -C "$REPO_ROOT" push -q "$I/origin" "$empty_slug_tip:refs/heads/master"; git -C "$I/parent" fetch -q origin master; git -C "$I/parent" reset -q --hard "$empty_slug_tip"
jq --arg tip "$empty_slug_tip" '(.sourceTips[]|select(.repository=="virusdave/task-dag").commit)=$tip' "$I/activation-record" >"$I/empty-slug-activation"
jq --arg activation "$I/empty-slug-activation" --arg page "$I/empty-slug-page" --arg tip "$empty_slug_tip" '.activationRecord=$activation | (.issuePages[]|select(.repository=="virusdave/task-dag").file)=$page | (.repositories[]|select(.repository=="virusdave/task-dag").tip)=$tip' "$I/spec" >"$I/empty-slug-spec"
if (cd "$I/parent" && "$TD" materialise-census --spec-file "$I/empty-slug-spec" --artifact "$I/empty-slug-census" --digest-file "$I/empty-slug-digest" >/dev/null 2>&1) \
  || git --git-dir="$I/origin" show-ref --verify --quiet refs/heads/tasks/v1/materialisation; then bad "present-empty slug matched absent slug"; else ok "present-empty slug is not treated as absent"; fi
git --git-dir="$I/origin" update-ref refs/heads/master "$parent_tip" "$empty_slug_tip"; git -C "$I/parent" fetch -q origin master; git -C "$I/parent" reset -q --hard "$parent_tip"
make_declaration blocked-repair 'Empty Note' 'adopt body' '' "$I/empty-note-declaration"
jq --slurpfile declaration "$I/empty-note-declaration" '.issues[0].declarations += $declaration | .issues[0].declarations |= sort_by(.slotId)' "$I/parent-page" >"$I/empty-note-page"
empty_note_tip=$(printf '%s\n' $'Present-empty note declaration\n\nMaterialise-Child-Epic: peer/repo\nChild-Epic-Title: Empty Note\nChild-Epic-Body-File: adopt-body\nParent-Issue: 1\nDelegation-Note:' | git -C "$REPO_ROOT" commit-tree "$historical_tree" -p "$parent_tip")
git -C "$REPO_ROOT" push -q "$I/origin" "$empty_note_tip:refs/heads/master"; git -C "$I/parent" fetch -q origin master; git -C "$I/parent" reset -q --hard "$empty_note_tip"
jq --arg tip "$empty_note_tip" '(.sourceTips[]|select(.repository=="virusdave/task-dag").commit)=$tip' "$I/activation-record" >"$I/empty-note-activation"
jq --arg activation "$I/empty-note-activation" --arg page "$I/empty-note-page" --arg tip "$empty_note_tip" '.activationRecord=$activation | (.issuePages[]|select(.repository=="virusdave/task-dag").file)=$page | (.repositories[]|select(.repository=="virusdave/task-dag").tip)=$tip' "$I/spec" >"$I/empty-note-spec"
if (cd "$I/parent" && "$TD" materialise-census --spec-file "$I/empty-note-spec" --artifact "$I/empty-note-census" --digest-file "$I/empty-note-digest" >/dev/null 2>&1) \
  || git --git-dir="$I/origin" show-ref --verify --quiet refs/heads/tasks/v1/materialisation; then bad "present-empty note matched absent note"; else ok "present-empty note is not treated as absent"; fi
git --git-dir="$I/origin" update-ref refs/heads/master "$parent_tip" "$empty_note_tip"; git -C "$I/parent" fetch -q origin master; git -C "$I/parent" reset -q --hard "$parent_tip"
(cd "$I/parent" && "$TD" materialise-census --spec-file "$I/spec" --artifact "$I/census" --digest-file "$I/digest") || bad "resolved integration census"
conflict=$(git -C "$I/parent" commit-tree "$parent_empty" -m conflict); git -C "$I/parent" push -q origin "$conflict:refs/heads/tasks/delegated-close/v1/1/peer/repo/2"
if (cd "$I/parent" && "$TD" materialise-import --spec-file "$I/spec" --artifact "$I/census" --digest-file "$I/digest" >/dev/null 2>&1) \
  || git --git-dir="$I/origin" show-ref --verify --quiet refs/heads/tasks/v1/materialisation \
  || [ "$conflict" != "$(git --git-dir="$I/origin" rev-parse refs/heads/tasks/delegated-close/v1/1/peer/repo/2)" ]; then bad "conflicting close target partially published import"; else ok "conflicting close target prevents materialisation and completion"; fi
git --git-dir="$I/origin" update-ref -d refs/heads/tasks/delegated-close/v1/1/peer/repo/2
if (cd "$I/parent" && "$TD" materialise-import --spec-file "$I/spec" --artifact "$I/census" --digest-file "$I/digest"); then
  material=$(git --git-dir="$I/origin" rev-parse refs/heads/tasks/v1/materialisation); close=$(git --git-dir="$I/origin" rev-parse refs/heads/tasks/delegated-close/v1/1/peer/repo/2)
  export TASKDAG_PEER_PATH_PREFIX="$I/no-prefix"
  taskdag_peer_worktree_for() { printf '%s\n' "$I/peer"; }
  if (cd "$I/parent" && git fetch -q origin refs/heads/tasks/delegated-close/v1/1/peer/repo/2 && _xrepo_validate_delegated_close_v1 "$close" "$delegation" virusdave/task-dag 1 peer/repo 2) && [ -n "$material" ]; then ok "enabled import atomically publishes materialisation and strict delegated close"; else bad "published delegated close failed strict validation"; fi
else bad "enabled census import failed"; fi
before_material=$(git --git-dir="$I/origin" rev-parse refs/heads/tasks/v1/materialisation); before_close=$(git --git-dir="$I/origin" rev-parse refs/heads/tasks/delegated-close/v1/1/peer/repo/2)
(cd "$I/parent" && "$TD" materialise-import --spec-file "$I/spec" --artifact "$I/census" --digest-file "$I/digest" >/dev/null); retry_rc=$?
[ "$retry_rc" -eq 0 ] && [ "$before_material" = "$(git --git-dir="$I/origin" rev-parse refs/heads/tasks/v1/materialisation)" ] && [ "$before_close" = "$(git --git-dir="$I/origin" rev-parse refs/heads/tasks/delegated-close/v1/1/peer/repo/2)" ] && ok "exact import retry converges" || bad "exact import retry did not converge"

census_digest=$(cat "$I/digest"); adopt_slot=$(jq -r .slotId "$I/adopt-declaration"); rearm_slot=$(jq -r .slotId "$I/rearm-declaration"); initial_slot=$(jq -r .slotId "$I/initial-declaration")
jq -ncS --arg runtime "$(_taskdag_materialise_runtime_commit)" --arg census "$census_digest" '{actor:"fixture",appCreatorNodeId:"BOT_fixture",authoritativeTimestamp:"2026-07-18T00:00:00Z",censusDigest:$census,runtimeCommit:$runtime}' >"$I/producer-spec"
eval "$(declare -f taskdag_activation_fenced_multi_push | sed '1s/taskdag_activation_fenced_multi_push/_fixture_real_fenced_multi_push/')"
taskdag_activation_fenced_multi_push() {
  _fixture_real_fenced_multi_push "$@" || return
  return 2 # Simulate a transport failure after the remote accepted the CAS.
}
if (cd "$I/parent" && cmd_materialise_producer_enable --spec-file "$I/producer-spec" >/dev/null) \
  && (cd "$I/parent" && taskdag_materialise_producer_check >/dev/null); then
  ok "producer enable converges after accepted ambiguous push"
else
  bad "producer enable did not converge after accepted ambiguous push"
fi
unset -f taskdag_activation_fenced_multi_push
eval "$(declare -f _fixture_real_fenced_multi_push | sed '1s/_fixture_real_fenced_multi_push/taskdag_activation_fenced_multi_push/')"
material_tip() { git --git-dir="$I/origin" rev-parse refs/heads/tasks/v1/materialisation; }
state_json() { git --git-dir="$I/origin" show "$(material_tip):slots/$1/states/$(printf '%016d' "$2").json"; }
tree_clean() { local violations; violations=$(cd "$I/parent" && taskdag_materialisation_tree_violations "$(material_tip)" "$authority"); [ -z "$violations" ] || { printf '%s\n' "$violations" >&2; return 1; }; }
initial_state=$(state_json "$initial_slot" 0)
jq -e '.state=="issue-adopted" and .adoptedIssue=={issueNodeId:"PI_initial",number:4,repositoryId:"PR_peer"}' <<<"$initial_state" >/dev/null \
  && ! git --git-dir="$I/origin" show "$(material_tip):declarations/$(jq -r .declarationDigest "$I/initial-declaration").json" | jq -e 'has("adoptedIssue")' >/dev/null \
  && ok "initial adopted import keeps issue identity only in state" || bad "initial adopted import invalid"
prior_adopt=$(state_json "$adopt_slot" 0); prior_adopt_digest=$(printf '%s\n' "$prior_adopt" | sha256sum | awk '{print $1}')
jq -ncS --arg censusDigest "$census_digest" --arg slotId "$adopt_slot" --arg priorStateDigest "$prior_adopt_digest" '{schema:1,mode:"adopt",slotId:$slotId,generation:1,censusDigest:$censusDigest,priorStateDigest:$priorStateDigest,adoptedIssue:{issueNodeId:"PI_adopted",repositoryId:"PR_peer",number:3},approval:"fixture approval",evidence:["audit://fixture/adopt"],actor:"fixture",timestamp:"2026-07-17T00:01:00Z"}' >"$I/adopt-spec"
for mutation in '.adoptedIssue.issueNodeId="stale"' '.adoptedIssue.number=999' '.adoptedIssue.repositoryId="PR_parent"' '.priorStateDigest="0000000000000000000000000000000000000000000000000000000000000000"' '.censusDigest="0000000000000000000000000000000000000000000000000000000000000000"'; do
  before=$(material_tip); jq "$mutation" "$I/adopt-spec" >"$I/rejected-spec"
  if (cd "$I/parent" && "$TD" materialise-adopt --spec-file "$I/rejected-spec" >/dev/null 2>&1) || [ "$before" != "$(material_tip)" ]; then bad "invalid adoption moved authority ($mutation)"; else ok "invalid adoption fails without movement ($mutation)"; fi
done
(cd "$I/parent" && "$TD" materialise-adopt --spec-file "$I/adopt-spec") || bad "valid adoption"
adopted_tip=$(material_tip); adopted=$(state_json "$adopt_slot" 1)
jq -e '.state=="issue-adopted" and .adoptedIssue.issueNodeId=="PI_adopted" and .adoptedIssue.repositoryId=="PR_peer" and .adoptedIssue.number==3' <<<"$adopted" >/dev/null && tree_clean && ok "adoption binds exact census issue and leaves valid successor" || bad "adoption successor invalid"
(cd "$I/parent" && "$TD" materialise-adopt --spec-file "$I/adopt-spec" >/dev/null) && [ "$adopted_tip" = "$(material_tip)" ] && ok "exact adoption retry converges" || bad "adoption retry moved authority"
jq '.mode="rearm" | del(.adoptedIssue) | .approval="late rearm"' "$I/adopt-spec" >"$I/late-rearm"; before=$(material_tip)
if (cd "$I/parent" && "$TD" materialise-rearm --spec-file "$I/late-rearm" >/dev/null 2>&1) || [ "$before" != "$(material_tip)" ]; then bad "rearm appended beside adopted generation"; else ok "rearm cannot be appended after same-generation adoption"; fi

prior_rearm=$(state_json "$rearm_slot" 0); prior_rearm_digest=$(printf '%s\n' "$prior_rearm" | sha256sum | awk '{print $1}')
jq -ncS --arg censusDigest "$census_digest" --arg slotId "$rearm_slot" --arg priorStateDigest "$prior_rearm_digest" '{schema:1,mode:"adopt",slotId:$slotId,generation:1,censusDigest:$censusDigest,priorStateDigest:$priorStateDigest,adoptedIssue:{issueNodeId:"PI_adopted",repositoryId:"PR_peer",number:3},approval:"collision",evidence:["audit://fixture/collision"],actor:"fixture",timestamp:"2026-07-17T00:01:30Z"}' >"$I/collision-spec"; before=$(material_tip)
if (cd "$I/parent" && "$TD" materialise-adopt --spec-file "$I/collision-spec" >/dev/null 2>&1) || [ "$before" != "$(material_tip)" ]; then bad "adopted issue collision accepted"; else ok "adopted issue is globally unique across slots"; fi
jq -ncS --arg censusDigest "$census_digest" --arg slotId "$rearm_slot" --arg priorStateDigest "$prior_rearm_digest" '{schema:1,mode:"rearm",slotId:$slotId,generation:1,censusDigest:$censusDigest,priorStateDigest:$priorStateDigest,approval:"fixture approval",evidence:["audit://fixture/rearm"],actor:"fixture",timestamp:"2026-07-17T00:02:00Z"}' >"$I/rearm-spec"
(cd "$I/parent" && "$TD" materialise-rearm --spec-file "$I/rearm-spec") || bad "valid rearm"
rearm_tip=$(material_tip); authorization=$(git --git-dir="$I/origin" show "$rearm_tip:slots/$rearm_slot/authorizations/0000000000000001.json"); authorization_digest=$(jq -r .authorizationDigest <<<"$authorization")
jq -e '.state=="rearm-authorized" and .generation==1' <<<"$authorization" >/dev/null && tree_clean && ok "rearm appends one immutable generation-one authorization" || bad "rearm authorization invalid"
(cd "$I/parent" && "$TD" materialise-rearm --spec-file "$I/rearm-spec" >/dev/null) && [ "$rearm_tip" = "$(material_tip)" ] && ok "exact rearm retry converges" || bad "rearm retry moved authority"
jq '.approval="conflicting approval"' "$I/rearm-spec" >"$I/rearm-conflict"; before=$(material_tip)
if (cd "$I/parent" && "$TD" materialise-rearm --spec-file "$I/rearm-conflict" >/dev/null 2>&1) || [ "$before" != "$(material_tip)" ]; then bad "conflicting second authorization accepted"; else ok "conflicting second authorization rejected"; fi

# Inspection models a crash before consume: authorization remains available.
git --git-dir="$I/origin" show "$rearm_tip:slots/$rearm_slot/authorizations/0000000000000001.json" >/dev/null
jq -ncS --arg censusDigest "$census_digest" --arg slotId "$rearm_slot" --arg priorStateDigest "$prior_rearm_digest" --arg authorizationDigest "$authorization_digest" '{schema:1,mode:"consume",slotId:$slotId,generation:1,censusDigest:$censusDigest,priorStateDigest:$priorStateDigest,authorizationDigest:$authorizationDigest,evidence:["audit://fixture/consume"],actor:"fixture",timestamp:"2026-07-17T00:03:00Z"}' >"$I/consume-spec"
before=$(material_tip); if (cd "$I/parent" && "$TD" materialise-consume --spec-file "$I/consume-spec" >/dev/null 2>&1) || [ "$before" != "$(material_tip)" ]; then bad "public consume command exists or moved authority"; else ok "rearm consumption has no public non-POST command"; fi
jq '.authorizationDigest="0000000000000000000000000000000000000000000000000000000000000000"' "$I/consume-spec" >"$I/consume-wrong"; before=$(material_tip)
if (cd "$I/parent" && _taskdag_materialise_transition_command "$I/consume-wrong" consume >/dev/null 2>&1) || [ "$before" != "$(material_tip)" ]; then bad "wrong authorization digest consumed"; else ok "consume requires exact authorization digest"; fi
(cd "$I/parent" && _taskdag_materialise_transition_command "$I/consume-spec" consume) || bad "consume after inspection"
consume_tip=$(material_tip); consumed=$(state_json "$rearm_slot" 1)
jq -e --arg digest "$authorization_digest" '.state=="create-in-flight-or-uncertain" and .authorizationDigest==$digest' <<<"$consumed" >/dev/null && tree_clean && ok "consume creates valid uncertain generation-one state" || bad "consumed state invalid"
(cd "$I/parent" && _taskdag_materialise_transition_command "$I/consume-spec" consume >/dev/null) && [ "$consume_tip" = "$(material_tip)" ] && ok "exact consume retry converges" || bad "consume retry moved authority"
jq '.evidence=["audit://fixture/other-payload"]' "$I/consume-spec" >"$I/consume-other"; before=$(material_tip)
if (cd "$I/parent" && _taskdag_materialise_transition_command "$I/consume-other" consume >/dev/null 2>&1) || [ "$before" != "$(material_tip)" ]; then bad "authorization reused for another payload"; else ok "consumed authorization cannot create another payload"; fi

idx="$I/corrupt-index"; GIT_INDEX_FILE="$idx" git -C "$I/parent" read-tree "$consume_tip"; corrupt_blob=$(jq '.state="blocked-repair"' <<<"$consumed" | git -C "$I/parent" hash-object -w --stdin); GIT_INDEX_FILE="$idx" git -C "$I/parent" update-index --cacheinfo "100644,$corrupt_blob,slots/$rearm_slot/states/0000000000000001.json"; corrupt_tree=$(GIT_INDEX_FILE="$idx" git -C "$I/parent" write-tree); corrupt=$(cd "$I/parent" && printf 'corrupt\n' | git commit-tree "$corrupt_tree" -p "$consume_tip"); rm -f "$idx"
[ -n "$(cd "$I/parent" && taskdag_materialisation_tree_violations "$corrupt" "$authority")" ] && ok "strict validator detects transition corruption" || bad "strict validator missed transition corruption"
idx="$I/subset-index"; GIT_INDEX_FILE="$idx" git -C "$I/parent" read-tree "$consume_tip"; subset_blob=$(git --git-dir="$I/origin" show "$consume_tip:import-batches/$census_digest.json" | jq '.slots=[]' | git -C "$I/parent" hash-object -w --stdin); GIT_INDEX_FILE="$idx" git -C "$I/parent" update-index --cacheinfo "100644,$subset_blob,import-batches/$census_digest.json"; subset_tree=$(GIT_INDEX_FILE="$idx" git -C "$I/parent" write-tree); subset=$(cd "$I/parent" && printf 'subset\n' | git commit-tree "$subset_tree" -p "$consume_tip"); rm -f "$idx"
[ -n "$(cd "$I/parent" && taskdag_materialisation_tree_violations "$subset" "$authority")" ] && ok "strict validator rejects incomplete census partition" || bad "strict validator accepted incomplete census partition"
idx="$I/mixed-index"; GIT_INDEX_FILE="$idx" git -C "$I/parent" read-tree "$consume_tip"; mixed_blob=$(printf '{}\n' | git -C "$I/parent" hash-object -w --stdin); GIT_INDEX_FILE="$idx" git -C "$I/parent" update-index --add --cacheinfo "100644,$mixed_blob,slots/$adopt_slot/state.json"; mixed_tree=$(GIT_INDEX_FILE="$idx" git -C "$I/parent" write-tree); mixed=$(cd "$I/parent" && printf 'mixed\n' | git commit-tree "$mixed_tree" -p "$consume_tip"); rm -f "$idx"
[ -n "$(cd "$I/parent" && taskdag_materialisation_tree_violations "$mixed" "$authority")" ] && ok "strict validator rejects mixed slot state models" || bad "strict validator accepted mixed slot state models"
[ -n "$(cd "$I/parent" && taskdag_materialisation_tree_violations "$consume_tip" "$authority" unknown/repo)" ] && ok "strict validator rejects foreign origin partition" || bad "strict validator accepted foreign origin partition"
printf 'foreign extension body\n' >"$I/foreign-extension-body"
jq -ncS --arg body "$I/foreign-extension-body" '{schema:1,actor:"fixture",authoritativeTimestamp:"2026-07-17T00:04:00Z",provenance:["test"],declarations:[{sourceRepo:{id:"PR_parent",name:"virusdave/task-dag"},parentIssue:{id:"PI_parent",number:1},peerRepo:{id:"PR_peer",name:"peer/repo"},title:"Foreign extension",bodyFile:$body,provenance:"fixture"}]}' >"$I/foreign-extension-spec"
git -C "$I/parent" config taskdag.current-repo unknown/repo; before=$(material_tip)
if (cd "$I/parent" && taskdag_materialise_reserve_core "$I/foreign-extension-spec" >/dev/null 2>&1) \
  || [ "$before" != "$(material_tip)" ]; then bad "ordinary reservation extended foreign-origin authority"; else ok "ordinary reservation rejects foreign-origin authority without moving it"; fi
git -C "$I/parent" config taskdag.current-repo virusdave/task-dag
git -C "$I/parent" push -q origin "$subset:refs/heads/test-fixture-corrupt"
git --git-dir="$I/origin" update-ref refs/heads/tasks/v1/materialisation "$subset" "$consume_tip"
if (cd "$I/parent" && "$TD" materialise-import --spec-file "$I/spec" --artifact "$I/census" --digest-file "$I/digest" >/dev/null 2>&1) \
  || [ "$subset" != "$(git --git-dir="$I/origin" rev-parse refs/heads/tasks/v1/materialisation)" ]; then bad "corrupt re-entry authority accepted or moved"; else ok "import rejects corrupt existing-census re-entry authority"; fi
git --git-dir="$I/origin" update-ref refs/heads/tasks/v1/materialisation "$consume_tip" "$subset"
git --git-dir="$I/origin" update-ref -d refs/heads/test-fixture-corrupt
git -C "$I/parent" fetch -q origin \
  +refs/heads/tasks/v1/activation:refs/heads/tasks/v1/activation \
  +refs/heads/tasks/v1/materialisation:refs/heads/tasks/v1/materialisation
if (cd "$I/parent" && "$TD" validate --strict >/dev/null); then ok "public strict audit accepts exact current-origin authority"; else bad "public strict audit rejected valid authority"; fi
git -C "$I/parent" config taskdag.current-repo unknown/repo
if (cd "$I/parent" && "$TD" validate --strict >/dev/null 2>&1); then bad "public strict audit accepted foreign origin partition"; else ok "public strict audit binds current origin partition"; fi
git -C "$I/parent" config taskdag.current-repo virusdave/task-dag
forged_census=$(jq -ncS '{schema:1,activationRecordDigest:"0000000000000000000000000000000000000000000000000000000000000000",issues:[],legacyCompletionRefs:[],liveDelegations:[],slots:[]}'); forged_digest=$(printf '%s\n' "$forged_census" | sha256sum | awk '{print $1}'); forged_batch=$(jq -ncS --arg d "$forged_digest" '{schema:1,censusDigest:$d,repository:"virusdave/task-dag",slots:[]}')
idx="$I/forged-index"; GIT_INDEX_FILE="$idx" git -C "$I/parent" read-tree "$(git -C "$I/parent" mktree </dev/null)"; census_blob=$(printf '%s\n' "$forged_census" | git -C "$I/parent" hash-object -w --stdin); batch_blob=$(printf '%s\n' "$forged_batch" | git -C "$I/parent" hash-object -w --stdin); GIT_INDEX_FILE="$idx" git -C "$I/parent" update-index --add --cacheinfo "100644,$census_blob,censuses/$forged_digest.json"; GIT_INDEX_FILE="$idx" git -C "$I/parent" update-index --add --cacheinfo "100644,$batch_blob,import-batches/$forged_digest.json"; forged_tree=$(GIT_INDEX_FILE="$idx" git -C "$I/parent" write-tree); forged=$(cd "$I/parent" && printf 'forged activation digest\n' | git commit-tree "$forged_tree"); rm -f "$idx"
git -C "$I/parent" update-ref refs/heads/tasks/v1/materialisation "$forged" "$consume_tip"
if (cd "$I/parent" && "$TD" validate --strict >/dev/null 2>&1); then bad "public strict audit accepted unknown census activation digest"; else ok "public strict audit binds census to enabled activation record"; fi
git -C "$I/parent" update-ref refs/heads/tasks/v1/materialisation "$consume_tip" "$forged"
echo "PASS=$pass FAIL=$fail"; [ "$fail" -eq 0 ]
