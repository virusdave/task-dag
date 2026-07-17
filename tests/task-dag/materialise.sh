#!/usr/bin/env bash
set -uo pipefail
TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
TD="$(cd "$(dirname "$TD")" && pwd)/$(basename "$TD")"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
pass=0; fail=0
ok() { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; fail=$((fail+1)); }

printf 'body with trailing lines\n\n' >"$ROOT/body"
printf 'second body\n' >"$ROOT/body-2"
jq -n '{schema:1,actor:"fixture",authoritativeTimestamp:"2026-07-17T00:00:00Z",provenance:["test"],declarations:[{sourceRepo:{id:"src-1",name:"o/source"},parentIssue:{id:"issue-21",number:21},peerRepo:{id:"peer-2",name:"o/peer"},title:"Immutable child",bodyFile:"body",provenance:"fixture"}]}' >"$ROOT/spec"

"$TD" materialise-batch --spec-file "$ROOT/spec" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 75 ] && ok "valid public batch is migration-drained" || bad "public batch rc=$rc"
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
  _taskdag_materialise_batch_json "$p" | jq -r .batchId
)
expected=$'205a028163b8c8da6fb3505e7b4169231e76a1adb5869204ea12cda91f9d60e7:ca0423b62c4ba49dc9f2e2f102cc338e335d5ff7cf8174fa8fb5ca36a42db7e0:786b2daa911b565593d5ddfde62833094fd1c70ba2e6c02625124b7090b10675\n0b99fd235effc12e3a2e0545e29327abeee1cfd90bd78062a1bd79beb42002fc'
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
  [ "$(_taskdag_materialise_batch_json "$first")" = "$(_taskdag_materialise_batch_json "$second")" ]
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
jq '.declarations[0].title="Conflicting child"' "$ROOT/spec" >"$ROOT/conflict-spec"
(
  cd "$ROOT/wc" || exit 1
  source "$(dirname "$TD")/task-dag.d/materialise.sh"
  taskdag_materialise_reserve_core "$ROOT/conflict-spec" >/dev/null
); rc=$?
[ "$rc" -eq 3 ] && [ "$tip" = "$(git --git-dir="$ROOT/origin" rev-parse refs/heads/tasks/v1/materialisation)" ] \
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
  content_out=$(taskdag_materialisation_tree_violations "$bad_content")
  path_out=$(taskdag_materialisation_tree_violations "$bad_path")
  merge_out=$(taskdag_materialisation_tree_violations "$bad_merge")
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
  orphan_out=$(taskdag_materialisation_tree_violations "$orphan_commit")
  no_op_out=$(taskdag_materialisation_tree_violations "$no_op")
  empty_out=$(taskdag_materialisation_tree_violations "$empty_root")
  unsafe_out=$(taskdag_materialisation_tree_violations "$unsafe_commit")
  mktemp_out=$(TMPDIR="$ROOT/absent-tmp" taskdag_materialisation_tree_violations "$no_op" 2>/dev/null)
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
  taskdag_materialisation_tree_violations "$(git rev-parse HEAD)"
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
  taskdag_materialisation_tree_violations "$missing_tip"
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
  PATH="$ROOT/failing-tools:$PATH" taskdag_materialisation_tree_violations "$tip2" 2>/dev/null
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
  PATH="$ROOT/failing-tools:$PATH" taskdag_materialisation_tree_violations "$tip2" 2>/dev/null
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
  PATH="$ROOT/failing-tools:$PATH" taskdag_materialisation_tree_violations "$tip2" 2>/dev/null
)
[ -n "$jq_failure_out" ] && ok "strict validator turns jq failure into a violation" || bad "jq failure disappeared from validation"

if ! rg -n 'gh issue create|curl .*(POST|-X[[:space:]]+POST)' "$(dirname "$TD")/task-dag.d/materialise.sh" >/dev/null; then
  ok "materialisation module has no issue POST"
else bad "materialisation module contains issue POST"; fi

echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
