#!/usr/bin/env bash
set -uo pipefail
TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
TD="$(cd "$(dirname "$TD")" && pwd)/$(basename "$TD")"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
pass=0; fail=0
ok() { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; fail=$((fail+1)); }

# This fixture exercises materialisation mechanics independently. Activation's
# own fixture covers authority acquisition and atomic guard publication; bind a
# stable enabled token and retain the old local-CAS seam here.
taskdag_activation_snapshot_token() {
  jq -ncS '{activationCommit:"1111111111111111111111111111111111111111",authorityTip:"2222222222222222222222222222222222222222",digest:"3333333333333333333333333333333333333333333333333333333333333333",epoch:1,guardVersion:1,minimumCompatibleTaskDagCommit:"4444444444444444444444444444444444444444",origin:"fixture",runtimeCommit:"5555555555555555555555555555555555555555",state:"enabled"}'
}
taskdag_activation_fenced_push() {
  local target=$6 old=$7 new=$8
  git push -q origin --force-with-lease="$target:$old" "$new:$target" 2>/dev/null
}
taskdag_activation_fenced_multi_push() {
  local updates=$6 ref old new
  ref=$(jq -r '.[0].ref' <<<"$updates"); old=$(jq -r '.[0].old' <<<"$updates"); new=$(jq -r '.[0].new' <<<"$updates")
  git push -q origin --force-with-lease="$ref:$old" "$new:$ref" 2>/dev/null
}
taskdag_activation_validate_history() { [[ "$1" = 2222222222222222222222222222222222222222 || "$1" = bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ]]; }
taskdag_activation_validate_provenance() {
  [[ "$1" = 2222222222222222222222222222222222222222 || "$1" = bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ]] \
    && jq -e '.guardVersion==1 and ((.epoch==1 and .digest=="3333333333333333333333333333333333333333333333333333333333333333") or (.epoch==2 and .digest=="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"))' <<<"$2" >/dev/null
}
_xrepo_current_repo() { printf '%s\n' o/source; }
export -f taskdag_activation_snapshot_token taskdag_activation_fenced_push taskdag_activation_fenced_multi_push \
  taskdag_activation_validate_history taskdag_activation_validate_provenance \
  _xrepo_current_repo

printf 'body with trailing lines\n\n' >"$ROOT/body"
printf 'second body\n' >"$ROOT/body-2"
jq -n '{schema:1,actor:"fixture",authoritativeTimestamp:"2026-07-17T00:00:00Z",provenance:["test"],declarations:[{sourceRepo:{id:"src-1",name:"o/source"},parentIssue:{id:"issue-21",number:21},peerRepo:{id:"peer-2",name:"o/peer"},title:"Immutable child",bodyFile:"body",provenance:"fixture"}]}' >"$ROOT/spec"

"$TD" materialise-batch --spec-file "$ROOT/spec" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 3 ] && ok "public batch fails closed without producer authority" || bad "public batch rc=$rc"
printf '{"schema":1,"schema":1}\n' >"$ROOT/bad"
"$TD" materialise-batch --spec-file "$ROOT/bad" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 2 ] && ok "duplicate keys fail before drain" || bad "duplicate keys rc=$rc"
duplicate_matrix_ok=true
while IFS= read -r duplicate_json; do
  printf '%s\n' "$duplicate_json" >"$ROOT/duplicate-shape"
  (
    source "$(dirname "$TD")/task-dag.d/materialise.sh"
    _taskdag_materialise_no_duplicate_keys "$ROOT/duplicate-shape"
  ) && duplicate_matrix_ok=false
done <<'DUPLICATES'
{"a":{"x":1},"a":2}
{"a":1,"a":{"x":2}}
{"a":{"x":1},"a":{"y":2}}
{"a":[1,2],"a":[3]}
{"a":[{"x":1,"x":2}]}
{"a":1,"\u0061":2}
DUPLICATES
printf '%s\n' '{"a":{"x":1,"y":2},"b":[1,2]}' >"$ROOT/unique-shape"
(
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  _taskdag_materialise_no_duplicate_keys "$ROOT/unique-shape"
) || duplicate_matrix_ok=false
[ "$duplicate_matrix_ok" = true ] && ok "decoded duplicate keys fail for scalar/container/array/nested shapes" || bad "duplicate-key shape matrix"
printf 'bad\000body' >"$ROOT/control-body"
jq '.declarations[0].bodyFile="control-body"' "$ROOT/spec" >"$ROOT/control-spec"
"$TD" materialise-batch --spec-file "$ROOT/control-spec" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 2 ] && ok "unsafe body bytes fail before drain" || bad "unsafe body rc=$rc"
jq '.declarations += [.declarations[0]]' "$ROOT/spec" >"$ROOT/two-spec"
"$TD" materialise-child --spec-file "$ROOT/two-spec" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 2 ] && ok "child adapter requires exactly one declaration" || bad "child adapter rc=$rc"

ids=$(
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  p=$(taskdag_materialise_prepare "$ROOT/spec")
  printf '%s\n' "$p" | jq -r '.declarations[0]|[.slotId,.declarationDigest,.operationId]|join(":")'
  _taskdag_materialise_batch_json "$p" "$(taskdag_activation_snapshot_token)" | jq -r .batchId
)
expected=$'205a028163b8c8da6fb3505e7b4169231e76a1adb5869204ea12cda91f9d60e7:ca0423b62c4ba49dc9f2e2f102cc338e335d5ff7cf8174fa8fb5ca36a42db7e0:786b2daa911b565593d5ddfde62833094fd1c70ba2e6c02625124b7090b10675\n5b5e6e4f3c3531addc2a01566c65a415b1ce4255412af9acfc90ca8918659b50'
[ "$ids" = "$expected" ] && ok "golden slot, declaration, operation, and batch IDs" || bad "golden IDs changed: $ids"

# Duplicate declarations coalesce with sorted provenance; declaration and
# batch order cannot affect IDs or the resulting authority tree.
jq '.declarations += [(.declarations[0] | .provenance="second")]' "$ROOT/spec" >"$ROOT/duplicate-spec"
jq '.declarations += [(.declarations[0] | .parentIssue={id:"issue-22",number:22} | .title="Second child" | .bodyFile="body-2")]' "$ROOT/spec" >"$ROOT/batch-spec"
jq '.declarations |= reverse' "$ROOT/batch-spec" >"$ROOT/permuted-spec"
partial_output=$(
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  taskdag_materialise_prepare "$ROOT/batch-spec" fail-second-declaration 2>/dev/null
); rc=$?
[ "$rc" -eq 2 ] && [ -z "$partial_output" ] && ok "declaration transform failure cannot shrink a batch" || bad "partial preparation escaped (rc=$rc)"
if (
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  duplicate=$(taskdag_materialise_prepare "$ROOT/duplicate-spec")
  first=$(taskdag_materialise_prepare "$ROOT/batch-spec")
  second=$(taskdag_materialise_prepare "$ROOT/permuted-spec")
  [ "$(jq '.declarations|length' <<<"$duplicate")" -eq 1 ] && [ "$(jq -c '.declarations[0].memberProvenance' <<<"$duplicate")" = '["fixture","second"]' ]
  [ "$first" = "$second" ]
  token=$(taskdag_activation_snapshot_token)
  [ "$(_taskdag_materialise_batch_json "$first" "$token")" = "$(_taskdag_materialise_batch_json "$second" "$token")" ]
); then ok "duplicates coalesce and declaration order is identity-neutral"; else bad "coalescing/order independence failed"; fi

jq '.declarations += [(.declarations[0] | .title="Conflicting duplicate")]' "$ROOT/spec" >"$ROOT/in-batch-conflict"
(
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  taskdag_materialise_prepare "$ROOT/in-batch-conflict" >/dev/null 2>&1
); rc=$?
[ "$rc" -eq 2 ] && ok "same-slot conflicting duplicates fail independent of scan order" || bad "conflicting duplicate rc=$rc"

mkdir "$ROOT/snapshot-case"
printf 'captured once\n\n' >"$ROOT/snapshot-case/body"
jq '.declarations[0].bodyFile="body"' "$ROOT/spec" >"$ROOT/snapshot-case/spec"
snapshot_prepared=$(
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  taskdag_materialise_prepare "$ROOT/snapshot-case/spec" replace-source-after-snapshot
)
snapshot_hash=$(printf 'captured once\n\n' | sha256sum | awk '{print $1}')
if [ "$(jq -r '.declarations[0].bodySha256' <<<"$snapshot_prepared")" = "$snapshot_hash" ] \
  && [ "$(jq -rj '.declarations[0].body' <<<"$snapshot_prepared" | sha256sum | awk '{print $1}')" = "$snapshot_hash" ] \
  && [ "$(sha256sum "$ROOT/snapshot-case/body" | awk '{print $1}')" != "$snapshot_hash" ]; then
  ok "body replacement after snapshot cannot change prepared bytes or identity"
else bad "body snapshot race changed prepared bytes or identity"; fi

mkdir "$ROOT/spec-snapshot-case"
printf 'spec snapshot body\n' >"$ROOT/spec-snapshot-case/body"
jq '.declarations[0].bodyFile="body"' "$ROOT/spec" >"$ROOT/spec-snapshot-case/spec"
spec_snapshot=$(
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  taskdag_materialise_prepare "$ROOT/spec-snapshot-case/spec" replace-spec-after-snapshot
)
if jq -e '.actor=="fixture" and .authoritativeTimestamp=="2026-07-17T00:00:00Z" and .batchProvenance==["test"] and (.declarations|length)==1' <<<"$spec_snapshot" >/dev/null \
  && jq -e 'keys==["schema"]' "$ROOT/spec-snapshot-case/spec" >/dev/null; then
  ok "spec replacement after snapshot cannot mix request generations"
else bad "spec snapshot race mixed request generations"; fi
cat "$ROOT/spec" "$ROOT/spec" >"$ROOT/multiple-json-spec"
"$TD" materialise-batch --spec-file "$ROOT/multiple-json-spec" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 2 ] && ok "multiple top-level JSON values fail before drain" || bad "multiple JSON values rc=$rc"

git init -q --bare "$ROOT/crash-origin"
git init -q "$ROOT/crash-wc"; git -C "$ROOT/crash-wc" remote add origin "$ROOT/crash-origin"
(
  cd "$ROOT/crash-wc" || exit 1
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  TASKDAG_MATERIALISE_TEST_CRASH_BEFORE_CAS=1 taskdag_materialise_reserve_core "$ROOT/spec" >/dev/null
); rc=$?
if [ "$rc" -eq 86 ] && ! git --git-dir="$ROOT/crash-origin" show-ref --verify --quiet refs/heads/tasks/v1/materialisation \
  && ! git -C "$ROOT/crash-wc" for-each-ref refs/task-dag-tmp | grep -q .; then
  ok "deterministic pre-CAS crash leaves authority and temp refs untouched"
else bad "pre-CAS crash leaked authority (rc=$rc)"; fi

git init -q --bare "$ROOT/candidate-origin"
git init -q "$ROOT/candidate-wc"; git -C "$ROOT/candidate-wc" remote add origin "$ROOT/candidate-origin"
(
  cd "$ROOT/candidate-wc" || exit 1
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  TASKDAG_MATERIALISE_TEST_CORRUPT_CANDIDATE=1 taskdag_materialise_reserve_core "$ROOT/spec" >/dev/null
); rc=$?
if [ "$rc" -eq 3 ] && ! git --git-dir="$ROOT/candidate-origin" show-ref --verify --quiet refs/heads/tasks/v1/materialisation; then
  ok "strict candidate assertion prevents malformed authority before CAS"
else bad "malformed candidate reached authority (rc=$rc)"; fi

git init -q --bare "$ROOT/ambiguous-origin"
git init -q "$ROOT/ambiguous-wc"; git -C "$ROOT/ambiguous-wc" remote add origin "$ROOT/ambiguous-origin"
(
  cd "$ROOT/ambiguous-wc" || exit 1
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  TASKDAG_MATERIALISE_TEST_AMBIGUOUS_SUCCESS=1 taskdag_materialise_reserve_core "$ROOT/batch-spec" >/dev/null
); rc=$?
ambiguous_tip=$(git --git-dir="$ROOT/ambiguous-origin" rev-parse refs/heads/tasks/v1/materialisation 2>/dev/null || true)
if [ "$rc" -eq 0 ] && [ "$(git --git-dir="$ROOT/ambiguous-origin" rev-list --count "$ambiguous_tip")" -eq 1 ] \
  && [ "$(git --git-dir="$ROOT/ambiguous-origin" ls-tree -r --name-only "$ambiguous_tip" | grep -c '^slots/')" -eq 2 ]; then
  ok "ambiguous CAS success converges by complete authoritative readback"
else bad "ambiguous CAS readback failed or wrote twice (rc=$rc)"; fi

git init -q --bare "$ROOT/origin"
git init -q "$ROOT/wc"; git -C "$ROOT/wc" remote add origin "$ROOT/origin"
(
  cd "$ROOT/wc" || exit 1
  # shellcheck source=../../scripts/task-dag.d/materialise.sh
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  taskdag_materialise_reserve_core "$ROOT/spec" >"$ROOT/result"
); rc=$?
if [ "$rc" -eq 0 ]; then ok "private core reserves in local fixture origin"; else bad "private core rc=$rc"; fi
tip=$(git --git-dir="$ROOT/origin" rev-parse refs/heads/tasks/v1/materialisation 2>/dev/null || true)
body_sha=$(sha256sum "$ROOT/body" | awk '{print $1}')
if [ "$(git --git-dir="$ROOT/origin" cat-file -s "$tip:bodies/$body_sha.body")" = "$(wc -c <"$ROOT/body")" ] \
  && cmp -s "$ROOT/body" <(git --git-dir="$ROOT/origin" show "$tip:bodies/$body_sha.body"); then
  ok "exact body bytes and trailing newlines persist"
else bad "body snapshot differs"; fi
paths=$(git --git-dir="$ROOT/origin" ls-tree -r --name-only "$tip" | sort)
if [ "$(wc -l <<<"$paths")" -eq 4 ] \
  && git --git-dir="$ROOT/origin" show "$tip:$(grep '^declarations/' <<<"$paths")" | jq -ceS . >/dev/null \
  && git --git-dir="$ROOT/origin" show "$tip:$(grep '^batches/' <<<"$paths")" | jq -ceS . >/dev/null; then
  ok "golden authority tree contains one canonical body/declaration/batch/slot set"
else bad "golden authority tree shape or JSON is not canonical: $paths"; fi
(
  cd "$ROOT/wc" || exit 1
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  taskdag_materialise_reserve_core "$ROOT/spec" >/dev/null
); rc=$?
[ "$rc" -eq 0 ] && [ "$tip" = "$(git --git-dir="$ROOT/origin" rev-parse refs/heads/tasks/v1/materialisation)" ] \
  && ok "identical retry is idempotent" || bad "identical retry changed authority"

# The same semantic request under a later activation has a different immutable
# batch path. It may append that receipt, but must not overwrite epoch one's
# receipt, declaration, body, or slot.
(
  cd "$ROOT/wc" || exit 1
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  taskdag_activation_snapshot_token() {
    jq -ncS '{activationCommit:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",authorityTip:"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",digest:"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",epoch:2,guardVersion:1,minimumCompatibleTaskDagCommit:"4444444444444444444444444444444444444444",origin:"fixture",runtimeCommit:"5555555555555555555555555555555555555555",state:"enabled"}'
  }
  taskdag_materialise_reserve_core "$ROOT/spec" >"$ROOT/epoch2-result"
); rc=$?
cross_epoch_tip=$(git --git-dir="$ROOT/origin" rev-parse refs/heads/tasks/v1/materialisation)
if [ "$rc" -eq 0 ] && [ "$cross_epoch_tip" != "$tip" ] \
  && [ "$(git --git-dir="$ROOT/origin" ls-tree -r --name-only "$cross_epoch_tip" | grep -c '^batches/')" -eq 2 ] \
  && git --git-dir="$ROOT/origin" diff --quiet "$tip" "$cross_epoch_tip" -- bodies declarations slots \
  && [ "$(jq -r .activation.epoch "$ROOT/epoch2-result")" -eq 2 ]; then
  ok "cross-epoch exact retry appends a distinct receipt without immutable mutation"
else bad "cross-epoch retry mutated immutable content or reused a batch path (rc=$rc)"; fi
jq '.declarations[0].title="Conflicting child"' "$ROOT/spec" >"$ROOT/conflict-spec"
(
  cd "$ROOT/wc" || exit 1
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  taskdag_materialise_reserve_core "$ROOT/conflict-spec" >/dev/null
); rc=$?
[ "$rc" -eq 3 ] && [ "$cross_epoch_tip" = "$(git --git-dir="$ROOT/origin" rev-parse refs/heads/tasks/v1/materialisation)" ] \
  && ok "same-slot conflict rejects whole request without mutation" || bad "conflict mutated authority (rc=$rc)"

# A batch that combines an existing-identical slot with a new slot adds the
# latter atomically while preserving the former byte-for-byte. New observation
# provenance is durable in the batch receipt, not the semantic declaration.
jq '.declarations[0].provenance="new-observation"' "$ROOT/batch-spec" >"$ROOT/provenance-spec"
(
  cd "$ROOT/wc" || exit 1
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  taskdag_materialise_reserve_core "$ROOT/provenance-spec" >"$ROOT/provenance-result"
); rc=$?
tip2=$(git --git-dir="$ROOT/origin" rev-parse refs/heads/tasks/v1/materialisation)
if [ "$rc" -eq 0 ] && [ "$tip2" != "$tip" ] \
  && [ "$(git --git-dir="$ROOT/origin" ls-tree -r --name-only "$tip2" | grep -c '^slots/')" -eq 2 ] \
  && git --git-dir="$ROOT/origin" diff --quiet "$tip" "$tip2" -- "$(grep '^slots/' <<<"$paths")" \
  && jq -e 'any(.members[];.provenance==["new-observation"])' "$ROOT/provenance-result" >/dev/null \
  && ! git --git-dir="$ROOT/origin" show "$tip2:$(grep '^declarations/' <<<"$paths")" | jq -e 'has("provenance")' >/dev/null; then
  ok "mixed batch atomically preserves new provenance outside declarations"
else bad "mixed existing/new batch was partial or changed existing state (rc=$rc)"; fi
(
  cd "$ROOT/wc" || exit 1
  "$TD" validate --strict >/dev/null
); rc=$?
[ "$rc" -eq 0 ] && ok "strict offline validation accepts reservation" || bad "strict validation rc=$rc"

# Identical concurrent batches converge; overlapping conflicting batches have
# one winner and cannot leak either loser's unique slot.
git init -q --bare "$ROOT/same-origin"
for wc in same-a same-b; do git init -q "$ROOT/$wc"; git -C "$ROOT/$wc" remote add origin "$ROOT/same-origin"; done
for wc in same-a same-b; do (
  cd "$ROOT/$wc" || exit 1
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  taskdag_materialise_reserve_core "$ROOT/batch-spec" >/dev/null
  echo $? >"$ROOT/$wc.rc"
) & done
wait
same_tip=$(git --git-dir="$ROOT/same-origin" rev-parse refs/heads/tasks/v1/materialisation 2>/dev/null || true)
if [ "$(cat "$ROOT/same-a.rc")" -eq 0 ] && [ "$(cat "$ROOT/same-b.rc")" -eq 0 ] \
  && [ "$(git --git-dir="$ROOT/same-origin" ls-tree -r --name-only "$same_tip" | grep -c '^slots/')" -eq 2 ]; then
  ok "concurrent identical batches converge on one complete reservation"
else bad "concurrent identical batches did not converge"; fi

jq '.declarations[0].title="Race A" | .declarations[1].parentIssue={id:"issue-23",number:23} | .declarations[1].title="Unique A"' "$ROOT/batch-spec" >"$ROOT/race-a-spec"
jq '.declarations[0].title="Race B" | .declarations[1].parentIssue={id:"issue-24",number:24} | .declarations[1].title="Unique B"' "$ROOT/batch-spec" >"$ROOT/race-b-spec"
git init -q --bare "$ROOT/race-origin"
for wc in race-a race-b; do git init -q "$ROOT/$wc"; git -C "$ROOT/$wc" remote add origin "$ROOT/race-origin"; done
for side in a b; do (
  cd "$ROOT/race-$side" || exit 1
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  taskdag_materialise_reserve_core "$ROOT/race-$side-spec" >/dev/null
  echo $? >"$ROOT/race-$side.rc"
) & done
wait
race_tip=$(git --git-dir="$ROOT/race-origin" rev-parse refs/heads/tasks/v1/materialisation 2>/dev/null || true)
races="$(cat "$ROOT/race-a.rc") $(cat "$ROOT/race-b.rc")"
if [[ "$races" = "0 3" || "$races" = "3 0" ]] \
  && [ "$(git --git-dir="$ROOT/race-origin" ls-tree -r --name-only "$race_tip" | grep -c '^slots/')" -eq 2 ]; then
  ok "overlapping conflicting batches choose one whole-batch winner"
else bad "overlapping race was not atomic: rc=$races"; fi

# Strict history validation rejects content/hash, unexpected-path, and merge
# ancestry corruption rather than merely checking that the tip is a commit.
(
  cd "$ROOT/wc" || exit 1
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  base_tree=$(git rev-parse "$tip2^{tree}")
  idx="$ROOT/corrupt-index"
  GIT_INDEX_FILE="$idx" git read-tree "$base_tree"
  bad_blob=$(printf '{"schema":2}\n' | git hash-object -w --stdin)
  batch_path=$(git ls-tree -r --name-only "$tip2" | grep '^batches/' | head -1)
  GIT_INDEX_FILE="$idx" git update-index --cacheinfo "100644,$bad_blob,$batch_path"
  bad_tree=$(GIT_INDEX_FILE="$idx" git write-tree)
  bad_content=$(printf 'corrupt\n' | git commit-tree "$bad_tree" -p "$tip2")
  rm -f "$idx"
  path_blob=$(printf 'junk\n' | git hash-object -w --stdin)
  GIT_INDEX_FILE="$idx" git read-tree "$base_tree"
  GIT_INDEX_FILE="$idx" git update-index --add --cacheinfo "100644,$path_blob,unexpected/path"
  path_tree=$(GIT_INDEX_FILE="$idx" git write-tree)
  bad_path=$(printf 'corrupt\n' | git commit-tree "$path_tree" -p "$tip2")
  second_parent=$(printf 'other\n' | git commit-tree "$base_tree")
  bad_merge=$(printf 'merge\n' | git commit-tree "$base_tree" -p "$tip2" -p "$second_parent")
  content_out=$(taskdag_materialisation_tree_violations "$bad_content" 2222222222222222222222222222222222222222)
  path_out=$(taskdag_materialisation_tree_violations "$bad_path" 2222222222222222222222222222222222222222)
  merge_out=$(taskdag_materialisation_tree_violations "$bad_merge" 2222222222222222222222222222222222222222)
  grep -q 'invalid batch\|append-only path changed' <<<"$content_out" \
    && grep -q 'unexpected path' <<<"$path_out" \
    && grep -q 'not linear\|malformed or non-linear ancestry' <<<"$merge_out"
); rc=$?
[ "$rc" -eq 0 ] && ok "strict validator rejects schema/hash/path/history corruption" || bad "strict validator accepted forged authority"

# Reverse closure and generation checks reject representable-looking orphan,
# empty/no-op, unsafe-body, and shallow-history authorities.
(
  cd "$ROOT/wc" || exit 1
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  jq '.declarations=[(.declarations[0] | .parentIssue={id:"issue-25",number:25} | .title="Orphan")]' "$ROOT/spec" >"$ROOT/orphan-spec"
  orphan=$(taskdag_materialise_prepare "$ROOT/orphan-spec")
  orphan_dd=$(jq -r '.declarations[0].declarationDigest' <<<"$orphan")
  idx="$ROOT/closure-index"; GIT_INDEX_FILE="$idx" git read-tree "$tip2^{tree}"
  orphan_blob=$(jq -cS '.declarations[0]|del(.body,.memberProvenance)' <<<"$orphan" | git hash-object -w --stdin)
  GIT_INDEX_FILE="$idx" git update-index --add --cacheinfo "100644,$orphan_blob,declarations/$orphan_dd.json"
  orphan_tree=$(GIT_INDEX_FILE="$idx" git write-tree); rm -f "$idx"
  orphan_commit=$(printf 'orphan\n' | git commit-tree "$orphan_tree" -p "$tip2")
  no_op=$(printf 'no op\n' | git commit-tree "$(git rev-parse "$tip2^{tree}")" -p "$tip2")
  empty_root=$(printf 'empty\n' | git commit-tree "$(git mktree </dev/null)")
  unsafe_blob=$(printf '\001unsafe\n' | git hash-object -w --stdin)
  unsafe_sha=$(printf '\001unsafe\n' | sha256sum | awk '{print $1}')
  GIT_INDEX_FILE="$idx" git read-tree "$tip2^{tree}"
  GIT_INDEX_FILE="$idx" git update-index --add --cacheinfo "100644,$unsafe_blob,bodies/$unsafe_sha.body"
  unsafe_tree=$(GIT_INDEX_FILE="$idx" git write-tree); rm -f "$idx"
  unsafe_commit=$(printf 'unsafe\n' | git commit-tree "$unsafe_tree" -p "$tip2")
  orphan_out=$(taskdag_materialisation_tree_violations "$orphan_commit" 2222222222222222222222222222222222222222)
  no_op_out=$(taskdag_materialisation_tree_violations "$no_op" 2222222222222222222222222222222222222222)
  empty_out=$(taskdag_materialisation_tree_violations "$empty_root" 2222222222222222222222222222222222222222)
  unsafe_out=$(taskdag_materialisation_tree_violations "$unsafe_commit" 2222222222222222222222222222222222222222)
  mktemp_out=$(TMPDIR="$ROOT/absent-tmp" taskdag_materialisation_tree_violations "$no_op" 2222222222222222222222222222222222222222 2>/dev/null)
  grep -q 'lacks matching slot\|not reachable from a batch' <<<"$orphan_out" \
    && grep -q 'must add exactly one batch' <<<"$no_op_out" \
    && grep -q 'must add exactly one batch' <<<"$empty_out" \
    && grep -q 'unsafe controls' <<<"$unsafe_out" \
    && grep -q 'validator cannot create private workspace' <<<"$mktemp_out"
); rc=$?
[ "$rc" -eq 0 ] && ok "strict validator rejects partial authority and workspace failure" || bad "strict closure validator accepted partial authority"

git clone -q --depth=1 --branch tasks/v1/materialisation "file://$ROOT/origin" "$ROOT/shallow"
shallow_out=$(
  cd "$ROOT/shallow" || exit 1
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  taskdag_materialisation_tree_violations "$(git rev-parse HEAD)" 2222222222222222222222222222222222222222
)
grep -q 'shallow repository' <<<"$shallow_out" && ok "strict validator rejects shallow authority history" || bad "shallow authority was accepted"

git init -q "$ROOT/missing-ancestry"
missing_tree=$(git -C "$ROOT/missing-ancestry" mktree </dev/null)
missing_root=$(cd "$ROOT/missing-ancestry" && printf 'root\n' | git commit-tree "$missing_tree")
missing_tip=$(cd "$ROOT/missing-ancestry" && printf 'tip\n' | git commit-tree "$missing_tree" -p "$missing_root")
rm "$ROOT/missing-ancestry/.git/objects/${missing_root:0:2}/${missing_root:2}"
missing_out=$(
  cd "$ROOT/missing-ancestry" || exit 1
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  taskdag_materialisation_tree_violations "$missing_tip" 2222222222222222222222222222222222222222
)
grep -q 'ancestry is incomplete or unreadable' <<<"$missing_out" && ok "strict validator rejects missing non-shallow ancestry" || bad "missing ancestry was accepted"

mkdir "$ROOT/failing-tools"
real_git=$(command -v git)
cat >"$ROOT/failing-tools/git" <<EOF
#!/usr/bin/env bash
[ "\${1:-}" != show ] || exit 91
exec "$real_git" "\$@"
EOF
chmod +x "$ROOT/failing-tools/git"
read_failure_out=$(
  cd "$ROOT/wc" || exit 1
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  PATH="$ROOT/failing-tools:$PATH" taskdag_materialisation_tree_violations "$tip2" 2222222222222222222222222222222222222222 2>/dev/null
)
grep -q 'validator cannot read batch\|unreadable' <<<"$read_failure_out" && ok "strict validator turns Git read failure into a violation" || bad "Git read failure disappeared from validation"

cat >"$ROOT/failing-tools/git" <<EOF
#!/usr/bin/env bash
[ "\${1:-}" != ls-tree ] || exit 91
exec "$real_git" "\$@"
EOF
chmod +x "$ROOT/failing-tools/git"
tree_failure_out=$(
  cd "$ROOT/wc" || exit 1
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  PATH="$ROOT/failing-tools:$PATH" taskdag_materialisation_tree_violations "$tip2" 2222222222222222222222222222222222222222 2>/dev/null
)
grep -q 'validator cannot read snapshot tree\|validator cannot list' <<<"$tree_failure_out" && ok "strict validator turns tree enumeration failure into a violation" || bad "tree enumeration failure disappeared from validation"
rm "$ROOT/failing-tools/git"

git -C "$ROOT/wc" update-ref refs/heads/tasks/v1/materialisation "$tip2"
cat >"$ROOT/failing-tools/git" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = cat-file ] && [ "\${2:-}" = -t ] && [ "\${3:-}" = "$tip2" ]; then exit 91; fi
exec "$real_git" "\$@"
EOF
chmod +x "$ROOT/failing-tools/git"
set +e
unreadable_ref_out=$(cd "$ROOT/wc" && PATH="$ROOT/failing-tools:$PATH" "$TD" validate --strict 2>&1)
unreadable_ref_rc=$?
set -e
git -C "$ROOT/wc" update-ref -d refs/heads/tasks/v1/materialisation
rm "$ROOT/failing-tools/git"
[ "$unreadable_ref_rc" -eq 3 ] && grep -q 'tasks/v1/materialisation.*missing or unreadable' <<<"$unreadable_ref_out" \
  && ok "strict dispatch rejects an unreadable materialisation tip" || bad "strict dispatch skipped an unreadable materialisation tip"

cat >"$ROOT/failing-tools/jq" <<'EOF'
#!/usr/bin/env bash
exit 92
EOF
chmod +x "$ROOT/failing-tools/jq"
jq_failure_out=$(
  cd "$ROOT/wc" || exit 1
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  PATH="$ROOT/failing-tools:$PATH" taskdag_materialisation_tree_violations "$tip2" 2222222222222222222222222222222222222222 2>/dev/null
)
[ -n "$jq_failure_out" ] && ok "strict validator turns jq failure into a violation" || bad "jq failure disappeared from validation"

if ! rg -n 'gh issue create|curl .*(POST|-X[[:space:]]+POST)' "$(dirname "$TD")/task-dag.d/materialise.sh" >/dev/null; then
  ok "materialisation module has no issue POST"
else bad "materialisation module contains issue POST"; fi

# The transition CAS distinguishes its exact winner from an equivalent/stale
# observer. Only that winner is allowed to issue the one provider POST.
(
  cd "$ROOT/wc" || exit 1
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  source "$(dirname "$TD")/task-dag.d/materialise-producer.sh"
  source "$(dirname "$TD")/task-dag.d/materialise-reconcile.sh"
  token=$(taskdag_activation_snapshot_token)
  slot=$(git ls-tree -r --name-only "$tip2" | sed -n '/^slots\/.*\/states\/0000000000000000\.json$/{p;q;}'); slot=${slot#slots/}; slot=${slot%%/*}
  prior=$(git show "$tip2:slots/$slot/states/0000000000000000.json")
  declaration=$(git show "$tip2:declarations/$(jq -r .declarationDigest <<<"$prior").json")
  producer=$(jq -ncS '{schema:1,state:"enabled",activationEpoch:1,activationRecordDigest:("3"*64),censusDigest:("6"*64),censusBlob:("7"*40),importBatchBlob:("8"*40),registrySnapshotId:("sha256:"+("9"*64)),repositories:["o/peer","o/source"],runtimeCommit:("5"*40),appCreatorNodeId:"BOT_fixture",actor:"fixture",authoritativeTimestamp:"2026-07-18T00:00:00Z"}')
  producer_blob=$(printf '%s\n' "$producer" | git hash-object -w --stdin)
  producer_tree=$(printf '100644 blob %s\tproducer-enable.json\n' "$producer_blob" | git mktree)
  producer_commit=$(printf 'Fixture producer\n' | git commit-tree "$producer_tree")
  git update-ref "$TASKDAG_MATERIALISE_PRODUCER_REF" "$producer_commit"
  git push -q origin "$producer_commit:$TASKDAG_MATERIALISE_PRODUCER_REF"
  producer_digest=$(printf '%s\n' "$producer" | sha256sum | awk '{print $1}')
  prior_digest=$(printf '%s\n' "$prior" | sha256sum | awk '{print $1}')
  common=$(jq -ncS --argjson prior "$prior" --arg actor fixture --arg now 2026-07-18T00:00:00Z --arg tip "$tip2" --arg authorityTip "$(jq -r .authorityTip <<<"$token")" --arg priorDigest "$prior_digest" --arg producerDigest "$producer_digest" --arg repository "$(jq -r .peerRepo.name <<<"$declaration")" --arg repositoryId "$(jq -r .peerRepo.id <<<"$declaration")" '{schema:1,state:"create-in-flight-or-uncertain",slotId:$prior.slotId,declarationDigest:$prior.declarationDigest,operationId:$prior.operationId,generation:1,fence:2,activation:$prior.activation,actor:$actor,authoritativeTimestamp:$now,predecessorStateDigest:$priorDigest,originReadback:{activationAuthorityTip:$authorityTip,materialisationTip:$tip},producerRecordDigest:$producerDigest,provider:{repository:$repository,repositoryId:$repositoryId,timeFloor:$now}}')
  first=$(jq -cS '.+{createAttemptId:("a"*64)}' <<<"$common")
  second=$(jq -cS '.+{createAttemptId:("b"*64)}' <<<"$common")
  if _taskdag_materialise_append_state "$tip2" "$token" "$slot" "$first"; then first_rc=0; else first_rc=$?; fi
  if _taskdag_materialise_append_state "$tip2" "$token" "$slot" "$second"; then second_rc=0; else second_rc=$?; fi
  current=$(git ls-remote --refs origin "$TASKDAG_MATERIALISATION_REF" | awk 'NF==2{print $1}')
  git fetch -q origin "$TASKDAG_MATERIALISATION_REF"
  [ "$first_rc" -eq 0 ] && [ "$second_rc" -eq 10 ] \
    && [ "$(git show "$current:slots/$slot/states/0000000000000001.json" | jq -r .createAttemptId)" = "$(printf 'a%.0s' {1..64})" ] \
    && [ -z "$(taskdag_materialisation_tree_violations "$current" "$(jq -r .authorityTip <<<"$token")" o/source)" ]

  first=$(git show "$current:slots/$slot/states/0000000000000001.json")
  body="$ROOT/recovery-body"
  { git show "$current:bodies/$(jq -r .bodySha256 <<<"$declaration").body"; printf '\n\n<!-- task-dag-materialisation:v1 operation=%s declaration=%s -->\n' "$(jq -r .operationId <<<"$first")" "$(jq -r .declarationDigest <<<"$first")"; } >"$body"
  adopted=$(jq -ncS --argjson prior "$first" --arg actor fixture --arg now 2026-07-18T00:00:01Z --arg tip "$current" --arg authorityTip "$(jq -r .authorityTip <<<"$token")" --arg priorDigest "$(printf '%s\n' "$first" | sha256sum | awk '{print $1}')" --arg bodySha "$(sha256sum "$body" | awk '{print $1}')" --arg title "$(jq -r .title <<<"$declaration")" '{schema:1,state:"issue-adopted",slotId:$prior.slotId,declarationDigest:$prior.declarationDigest,operationId:$prior.operationId,generation:2,fence:3,activation:$prior.activation,actor:$actor,authoritativeTimestamp:$now,predecessorStateDigest:$priorDigest,originReadback:{activationAuthorityTip:$authorityTip,materialisationTip:$tip},createAttemptId:$prior.createAttemptId,adoptedIssue:{repositoryId:$prior.provider.repositoryId,issueNodeId:"PI_fixture",number:7},providerReceipt:{repositoryId:$prior.provider.repositoryId,creatorNodeId:"BOT_fixture",observedAt:$now,paginationQuery:"fixture",pagesFetched:1,exhausted:true,matchCount:1,matchedIdentity:{issueNodeId:"PI_fixture",number:7,createdAt:$now,title:$title,bodySha256:$bodySha,operationId:$prior.operationId,declarationDigest:$prior.declarationDigest}}}')
  _taskdag_materialise_append_state "$current" "$token" "$slot" "$adopted"
  adopted_tip=$(git ls-remote --refs origin "$TASKDAG_MATERIALISATION_REF" | awk 'NF==2{print $1}')
  git fetch -q origin "$TASKDAG_MATERIALISATION_REF"
  git update-ref -d "$TASKDAG_MATERIALISE_PRODUCER_REF"
  taskdag_materialise_fetch_producer_if_required "$adopted_tip"
  [ "$(git rev-parse "$TASKDAG_MATERIALISE_PRODUCER_REF")" = "$producer_commit" ]
  [ -z "$(taskdag_materialisation_tree_violations "$adopted_tip" "$(jq -r .authorityTip <<<"$token")" o/source)" ]
  while IFS=$'\t' read -r mutation expected; do
    tampered=$(jq -cS "$mutation" <<<"$adopted")
    tampered_blob=$(printf '%s\n' "$tampered" | git hash-object -w --stdin)
    idx="$ROOT/recovery-index"; GIT_INDEX_FILE="$idx" git read-tree "$adopted_tip^{tree}"
    GIT_INDEX_FILE="$idx" git update-index --cacheinfo "100644,$tampered_blob,slots/$slot/states/0000000000000002.json"
    tampered_tree=$(GIT_INDEX_FILE="$idx" git write-tree); rm -f "$idx"
    tampered_tip=$(printf 'Tamper receipt\n' | git commit-tree "$tampered_tree" -p "$adopted_tip")
    violations=$(taskdag_materialisation_tree_violations "$tampered_tip" "$(jq -r .authorityTip <<<"$token")" o/source)
    grep -q "$expected" <<<"$violations" || exit 1
  done <<'TAMPERS'
.providerReceipt.matchedIdentity.bodySha256=("0"*64)	recovery body digest mismatch
.createAttemptId=("f"*64)	changed create or provider identity
.adoptedIssue.repositoryId="other" | .providerReceipt.repositoryId="other"	changed create or provider identity
.adoptedIssue.issueNodeId="" | .providerReceipt.matchedIdentity.issueNodeId=""	invalid fresh transition
TAMPERS
); rc=$?
[ "$rc" -eq 0 ] && ok "unique create winner and exact durable recovery receipt validate" || bad "create ownership or recovery receipt validation failed"

# Recovery compares every exact identity field and visible body bytes; zero
# and duplicate exact matches remain fail-closed rather than authorizing POST.
(
  source "$(dirname "$TD")/task-dag.d/materialise-reconcile.sh"
  expected="$ROOT/exact-body"; printf 'body\n\n<!-- task-dag-materialisation:v1 operation=op declaration=dd -->\n' >"$expected"
  declaration='{"title":"Title"}'
  issue=$(jq -nc --rawfile body "$expected" '{title:"Title",body:$body,node_id:"I_1",number:1,created_at:"2026-07-18T00:00:01Z",user:{node_id:"BOT"}}')
  _taskdag_materialise_exact_matches "[$issue]" "$declaration" "$expected" 2026-07-18T00:00:00Z BOT "$ROOT/matches"
  [ "$(wc -l <"$ROOT/matches")" -eq 1 ]
  _taskdag_materialise_exact_matches "[$issue,$issue]" "$declaration" "$expected" 2026-07-18T00:00:00Z BOT "$ROOT/matches"
  [ "$(wc -l <"$ROOT/matches")" -eq 2 ]
  _taskdag_materialise_exact_matches "[$(jq -c '.body="different"' <<<"$issue")]" "$declaration" "$expected" 2026-07-18T00:00:00Z BOT "$ROOT/matches"
  [ ! -s "$ROOT/matches" ]
); rc=$?
[ "$rc" -eq 0 ] && ok "recovery distinguishes one, zero, and multiple exact matches" || bad "recovery identity predicate accepted an inexact match"

# Aggregate reconciliation must never let a later uncertain slot downgrade an
# earlier hard semantic failure.
set +e
(
  source "$(dirname "$TD")/task-dag.d/materialise-reconcile.sh"
  _taskdag_materialise_fetch_authority() { printf 'tip\t{}\t{}\n'; }
  _taskdag_materialise_reconcile_slot() { [ "$1" = "$(printf 'a%.0s' {1..64})" ] && return 3; return 75; }
  git() {
    if [ "$1" = ls-tree ]; then
      printf 'slots/%s/states/0000000000000000.json\n' "$(printf 'a%.0s' {1..64})" "$(printf 'b%.0s' {1..64})"
      return 0
    fi
    command git "$@"
  }
  cmd_materialise_reconcile
); rc=$?
set -e
[ "$rc" -eq 3 ] && ok "aggregate reconciliation keeps hard failure sticky" || bad "later uncertainty downgraded hard failure (rc=$rc)"

# Finalization orchestration must use the private canonical projection and
# append `final` only after exact marker/delegation/edge readbacks succeed.
set +e
(
  source "$(dirname "$TD")/task-dag.d/materialise-reconcile.sh"
  op=$(printf '1%.0s' {1..64}); dd=$(printf '2%.0s' {1..64}); sid=$(printf '3%.0s' {1..64})
  TEST_MARKER="refs/heads/gh/materialisation-markers/$op"; TEST_COMMIT=$(printf '4%.0s' {1..40}); TEST_EDGE=$(printf '5%.0s' {1..64})
  adopted=$(jq -ncS --arg op "$op" --arg dd "$dd" --arg sid "$sid" --arg marker "$TEST_MARKER" --arg commit "$TEST_COMMIT" '{schema:1,state:"marker-durable-delegation-pending",slotId:$sid,declarationDigest:$dd,operationId:$op,generation:2,fence:3,activation:{epoch:1,digest:("a"*64),guardVersion:1},actor:"fixture",authoritativeTimestamp:"2026-07-18T00:00:00Z",predecessorStateDigest:("b"*64),originReadback:{activationAuthorityTip:("c"*40),materialisationTip:("d"*40)},adoptedIssue:{repositoryId:"peer-id",issueNodeId:"issue-id",number:9},markerRef:$marker,markerCommit:$commit}')
  declaration=$(jq -ncS --arg op "$op" --arg dd "$dd" --arg sid "$sid" '{operationId:$op,declarationDigest:$dd,slotId:$sid,parentIssue:{number:7},peerRepo:{name:"peer/repo"},delegationNote:"note"}')
  token=$(jq -ncS '{epoch:1,digest:("a"*64),guardVersion:1,authorityTip:("c"*40)}')
  _taskdag_materialise_delegate_projection() { :; }
  taskdag_materialise_delegation_valid() { [ "$5" = note ]; }
  taskdag_sync_graph_ref() { :; }
  taskdag_edge_id() { printf '%s\n' "$TEST_EDGE"; }
  taskdag_materialise_edge_durable() { [ "$1" = "$TEST_EDGE" ]; }
  taskdag_materialise_operation_marker_write() { printf '%s\t%s\n' "$TEST_MARKER" "$TEST_COMMIT"; }
  _taskdag_materialise_latest_state() { printf '%s\n' "$adopted"; }
  _taskdag_materialise_append_state() { jq -e '.state=="final" and .delegationRef=="refs/heads/tasks/delegated/7/peer/repo/9" and .edgeId==$edge' --arg edge "$TEST_EDGE" <<<"$4" >/dev/null; }
  _xrepo_current_repo() { printf 'source/repo\n'; }
  git() { [ "$1" = rev-parse ] && { printf 'root-sha\n'; return 0; }; command git "$@"; }
  _taskdag_materialise_finalize "$(printf 'd%.0s' {1..40})" "$token" "$sid" "$adopted" "$declaration"
); rc=$?
set -e
[ "$rc" -eq 0 ] && ok "finalization waits for canonical projection readback" || bad "finalization orchestration failed (rc=$rc)"

echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
