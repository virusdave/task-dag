#!/usr/bin/env bash
set -uo pipefail
TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
pass=0 fail=0
ok() { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; fail=$((fail+1)); }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

git init -q --bare "$ROOT/origin"
git init -q "$ROOT/wc"; git -C "$ROOT/wc" remote add origin "$ROOT/origin"
runtime=$(git -C "$(dirname "$TD")/.." rev-parse HEAD)
registry_commit=1111111111111111111111111111111111111111
registry_blob=2222222222222222222222222222222222222222
registry=$(jq -ncS --arg commit "$registry_commit" --arg blob "$registry_blob" '{schema:1,source:{repository:"virusdave/top-level",path:"registry.json",commit:$commit,blob:$blob},repositories:[{repository:"virusdave/task-dag",repositoryId:"1",name:"task-dag",repairMode:"off",repairBranch:null}]}')
registry_file="$ROOT/registry"; printf '%s\n' "$registry" >"$registry_file"
TASKDAG_SCRIPT_DIR="$(dirname "$TD")"; source "$TASKDAG_SCRIPT_DIR/task-dag.d/materialise.sh"; source "$TASKDAG_SCRIPT_DIR/task-dag.d/activation.sh"; source "$TASKDAG_SCRIPT_DIR/task-dag.d/materialise-producer.sh"
_xrepo_current_repo() { printf '%s\n' virusdave/task-dag; }
registry_id=$(_taskdag_activation_registry_id "$registry_file")
jq -ncS --arg runtime "$runtime" --arg registry_commit "$registry_commit" --arg registry_blob "$registry_blob" --arg id "$registry_id" '{actor:"fixture",authoritativeTimestamp:"2026-07-17T00:00:00Z",minimumCompatibleTaskDagCommit:$runtime,registrySnapshot:{id:$id,schema:1,source:{repository:"virusdave/top-level",path:"registry.json",commit:$registry_commit,blob:$registry_blob},repositories:[{repository:"virusdave/task-dag",repositoryId:"1",name:"task-dag",repairMode:"off",repairBranch:null}]},sourceTips:[{repository:"virusdave/task-dag",repositoryId:"1",ref:"refs/heads/master",commit:$runtime}],state:"enabled"}' >"$ROOT/spec"

out=$(cd "$ROOT/wc" && "$TD" activation apply --spec-file "$ROOT/spec" 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && jq -e '.present and .record.epoch==1 and .record.predecessor==null and .record.state=="enabled"' <<<"$out" >/dev/null; then ok "epoch one activation applies and reads back"; else bad "epoch one apply rc=$rc out=$out"; fi
tip=$(git --git-dir="$ROOT/origin" rev-parse refs/heads/tasks/v1/activation)
record_path=records/0000000000000001.json
git --git-dir="$ROOT/origin" show "$tip:$record_path" >"$ROOT/epoch1-record"
jq -cS '. + {schema:1,epoch:1,predecessor:null,guardVersion:1}' "$ROOT/spec" >"$ROOT/epoch1-expected"
epoch1_digest=$(sha256sum "$ROOT/epoch1-record" | awk '{print $1}')
if cmp -s "$ROOT/epoch1-record" "$ROOT/epoch1-expected" \
  && [ "$(git --git-dir="$ROOT/origin" ls-tree -r --name-only "$tip")" = "$record_path" ] \
  && [ "$epoch1_digest" = "$(sha256sum "$ROOT/epoch1-expected" | awk '{print $1}')" ] \
  && [ "$registry_id" = sha256:def3c707c0a375eb4116fc031127d40d425a91b7d8ea156fad4cbe0b43cf272e ]; then
  ok "epoch-one golden bytes, digest, path, and registry identity are exact"
else bad "epoch-one golden identity changed (record=$epoch1_digest registry=$registry_id)"; fi
(cd "$ROOT/wc" && "$TD" activation apply --spec-file "$ROOT/spec" >/dev/null 2>&1); rc=$?
[ "$rc" -eq 0 ] && [ "$tip" = "$(git --git-dir="$ROOT/origin" rev-parse refs/heads/tasks/v1/activation)" ] && ok "identical apply converges" || bad "identical apply advanced authority"

# Two writes in one epoch replace, rather than stack, sibling guards.  The
# second guard leases and records the first guard as its expected authority.
empty=$(git -C "$ROOT/wc" mktree </dev/null)
one=$(printf 'one\n' | git -C "$ROOT/wc" commit-tree "$empty")
token=$(cd "$ROOT/wc" && taskdag_activation_snapshot_token)
snapshot_record=$(cd "$ROOT/wc" && taskdag_activation_record_for_snapshot "$token")
if [ "$(jq -r .registrySnapshot.id <<<"$snapshot_record")" = "$registry_id" ] \
  && [ "$(jq -r .epoch <<<"$snapshot_record")" = "$(jq -r .epoch <<<"$token")" ]; then
  ok "snapshot token resolves its exact immutable activation record"
else bad "snapshot token lost its registry-bound activation record"; fi
authority_before=$(git --git-dir="$ROOT/origin" rev-parse "$TASKDAG_ACTIVATION_REF")
for forged in \
  "$(jq -c '.origin="other-origin"' <<<"$token")" \
  "$(jq -c '.state="disabled"' <<<"$token")" \
  "$(jq -c '.digest="ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"' <<<"$token")" \
  "$(jq -c '.epoch=2' <<<"$token")" \
  "$(jq -c '.minimumCompatibleTaskDagCommit="0000000000000000000000000000000000000000"' <<<"$token")"; do
  candidate=$(printf 'forged\n' | git -C "$ROOT/wc" commit-tree "$empty")
  (cd "$ROOT/wc" && taskdag_activation_fenced_push "$forged" fixture forged fixture 2026-07-17T00:00:01Z refs/heads/forged-target "" "$candidate" >/dev/null 2>&1); rc=$?
  [ "$rc" -eq 3 ] && [ "$authority_before" = "$(git --git-dir="$ROOT/origin" rev-parse "$TASKDAG_ACTIVATION_REF")" ] \
    && ! git --git-dir="$ROOT/origin" show-ref --verify --quiet refs/heads/forged-target || bad "forged activation token moved a ref"
done
ok "cross-origin and forged state/digest/epoch/floor tokens move neither ref"
(cd "$ROOT/wc" && taskdag_activation_fenced_push "$token" fixture mutate fixture 2026-07-17T00:00:01Z refs/heads/fixture-target "" "$one"); first_guard=$(git --git-dir="$ROOT/origin" rev-parse refs/heads/tasks/v1/activation)
two=$(printf 'two\n' | git -C "$ROOT/wc" commit-tree "$empty" -p "$one")
token=$(cd "$ROOT/wc" && taskdag_activation_snapshot_token)
result=$(cd "$ROOT/wc" && taskdag_activation_fenced_push "$token" fixture mutate fixture 2026-07-17T00:00:02Z refs/heads/fixture-target "$one" "$two" && printf '%s\n' "$TASKDAG_ACTIVATION_FENCED_PUSH_RESULT"); second_guard=$(git --git-dir="$ROOT/origin" rev-parse refs/heads/tasks/v1/activation)
stale_token=$token
active=$(jq -r .activationCommit <<<"$token")
if [ "$(git --git-dir="$ROOT/origin" rev-parse "$second_guard^")" = "$active" ] \
  && git --git-dir="$ROOT/origin" log -1 --format=%B "$second_guard" | grep -qx "Expected-Authority-Tip: $first_guard" \
  && jq -e '.schema==1 and .outcome=="applied" and .push.exit==0 and .authority.observed==.authority.guard and (.readback.targets|length)==1' <<<"$result" >/dev/null; then
  ok "consecutive fenced writes retain one current sibling guard and structured applied evidence"
else bad "repeated guard or applied evidence contract failed"; fi

jq '.state="disabled" | .authoritativeTimestamp="2026-07-17T00:00:01Z"' "$ROOT/spec" >"$ROOT/disabled"
out=$(cd "$ROOT/wc" && "$TD" activation apply --spec-file "$ROOT/disabled" 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && jq -e '.record.epoch==2 and .record.state=="disabled" and .record.predecessor.epoch==1 and (.record.predecessor.digest|test("^[0-9a-f]{64}$"))' <<<"$out" >/dev/null; then ok "disabled transition advances digest-linked epoch"; else bad "disabled transition rc=$rc out=$out"; fi
(cd "$ROOT/wc" && taskdag_activation_snapshot_token >/dev/null 2>&1); rc=$?
[ "$rc" -eq 3 ] && ok "disabled activation rejects writer snapshots" || bad "disabled writer snapshot rc=$rc"
(cd "$ROOT/wc" && "$TD" activation check-compatible --candidate-task-dag-commit "$runtime" >/dev/null 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "disabled activation still permits offline compatibility checks" || bad "disabled compatibility check rc=$rc"

# A token from the prior enabled epoch cannot move either side of the atomic
# transaction after activation advances to disabled.
before_activation=$(git --git-dir="$ROOT/origin" rev-parse refs/heads/tasks/v1/activation)
before_target=$(git --git-dir="$ROOT/origin" rev-parse refs/heads/fixture-target)
three=$(printf 'three\n' | git -C "$ROOT/wc" commit-tree "$empty" -p "$two")
(cd "$ROOT/wc" && taskdag_activation_fenced_push "$stale_token" fixture stale fixture 2026-07-17T00:00:03Z refs/heads/fixture-target "$two" "$three" >/dev/null 2>&1); rc=$?
[ "$rc" -eq 3 ] && [ "$before_activation" = "$(git --git-dir="$ROOT/origin" rev-parse refs/heads/tasks/v1/activation)" ] \
  && [ "$before_target" = "$(git --git-dir="$ROOT/origin" rev-parse refs/heads/fixture-target)" ] \
  && ok "stale activation token moves neither authority nor target" || bad "stale activation token mutated refs"

jq '.authoritativeTimestamp="2026-07-17T00:00:02Z"' "$ROOT/spec" >"$ROOT/re-enabled"
out=$(cd "$ROOT/wc" && "$TD" activation apply --spec-file "$ROOT/re-enabled" 2>/dev/null); rc=$?
epoch2_digest=$(git --git-dir="$ROOT/origin" show "$(git --git-dir="$ROOT/origin" rev-parse refs/heads/tasks/v1/activation)^:records/0000000000000002.json" | sha256sum | awk '{print $1}')
if [ "$rc" -eq 0 ] && jq -e --arg digest "$epoch2_digest" '.record.epoch==3 and .record.state=="enabled" and .record.predecessor=={epoch:2,digest:$digest}' <<<"$out" >/dev/null; then
  ok "enabled-disabled-enabled reaches epoch three with exact predecessor digest"
else bad "epoch-three transition or predecessor digest failed (rc=$rc)"; fi

# A current activation lease is still insufficient when its target lease is
# stale; atomic push must preserve both refs.
current_token=$(cd "$ROOT/wc" && taskdag_activation_snapshot_token)
target_snapshot=$(git --git-dir="$ROOT/origin" rev-parse refs/heads/fixture-target)
contender=$(printf 'contender\n' | git -C "$ROOT/wc" commit-tree "$empty" -p "$target_snapshot")
git -C "$ROOT/wc" push -q origin "$contender:refs/heads/fixture-target"
authority_snapshot=$(git --git-dir="$ROOT/origin" rev-parse refs/heads/tasks/v1/activation)
candidate=$(printf 'candidate\n' | git -C "$ROOT/wc" commit-tree "$empty" -p "$target_snapshot")
(cd "$ROOT/wc" && taskdag_activation_fenced_push "$current_token" fixture contention fixture 2026-07-17T00:00:04Z refs/heads/fixture-target "$target_snapshot" "$candidate" >/dev/null 2>&1); rc=$?
[ "$rc" -eq 3 ] && [ "$authority_snapshot" = "$(git --git-dir="$ROOT/origin" rev-parse refs/heads/tasks/v1/activation)" ] \
  && [ "$contender" = "$(git --git-dir="$ROOT/origin" rev-parse refs/heads/fixture-target)" ] \
  && ok "target contention moves neither activation nor target" || bad "target contention was not atomic"

# Every non-success outcome has stable machine-readable evidence while the
# legacy return-code contract remains 3.  These seams run only in fixtures.
target_changed=$(cd "$ROOT/wc"; taskdag_activation_fenced_push "$current_token" fixture target-changed fixture 2026-07-17T00:00:04Z refs/heads/fixture-target "$target_snapshot" "$candidate" >/dev/null 2>&1; rc=$?; printf '%s\n' "$TASKDAG_ACTIVATION_FENCED_PUSH_RESULT"; exit "$rc"); rc=$?
[ "$rc" -eq 3 ] && jq -e '.outcome=="target-changed" and .readback.targets[0].oid!=""' <<<"$target_changed" >/dev/null \
  && ok "target movement has structured evidence and legacy rc 3" || bad "target movement outcome contract failed"

current_token=$(cd "$ROOT/wc" && taskdag_activation_snapshot_token)
side=$(printf 'side\n' | git -C "$ROOT/wc" commit-tree "$empty")
next=$(printf 'next\n' | git -C "$ROOT/wc" commit-tree "$empty" -p "$contender")
taskdag_activation_test_pre_fenced_push_hook() {
  unset -f taskdag_activation_test_pre_fenced_push_hook
  taskdag_activation_fenced_push "$current_token" fixture authority-winner fixture 2026-07-17T00:00:05Z refs/heads/fixture-side "" "$side" >/dev/null
}
authority_contention=$(cd "$ROOT/wc"; taskdag_activation_fenced_push "$current_token" fixture authority-loser fixture 2026-07-17T00:00:05Z refs/heads/fixture-target "$contender" "$next" >/dev/null 2>&1; rc=$?; printf '%s\n' "$TASKDAG_ACTIVATION_FENCED_PUSH_RESULT"; exit "$rc"); rc=$?
unset -f taskdag_activation_test_pre_fenced_push_hook
[ "$rc" -eq 3 ] && jq -e '.outcome=="authority-contention" and .authority.observed!=.authority.expected and .readback.targets[0].oid==.updates[0].old' <<<"$authority_contention" >/dev/null \
  && ok "authority contention has retryable structured evidence and legacy rc 3" || bad "authority contention outcome contract failed"

current_token=$(cd "$ROOT/wc" && taskdag_activation_snapshot_token)
cat >"$ROOT/origin/hooks/pre-receive" <<'EOF'
#!/usr/bin/env bash
echo 'rejected https://secret@example.invalid/private and https://other-secret@example.invalid/again' >&2
head -c 5000 /dev/zero | tr '\0' x >&2
exit 1
EOF
chmod +x "$ROOT/origin/hooks/pre-receive"
rejected=$(cd "$ROOT/wc"; taskdag_activation_fenced_push "$current_token" fixture rejected fixture 2026-07-17T00:00:06Z refs/heads/fixture-target "$contender" "$next" >/dev/null 2>&1; rc=$?; printf '%s\n' "$TASKDAG_ACTIVATION_FENCED_PUSH_RESULT"; exit "$rc"); rc=$?
rm -f "$ROOT/origin/hooks/pre-receive"
[ "$rc" -eq 3 ] && jq -e '.outcome=="rejected-no-effect" and .push.exit!=0 and (.push.diagnostic|contains("rejected https://[redacted]@example.invalid/private and https://[redacted]@example.invalid/again")) and (.push.diagnostic|contains("secret")|not) and (.push.diagnostic|length)<=4096 and .authority.observed==.authority.expected' <<<"$rejected" >/dev/null \
  && ok "confirmed no-effect rejection retains sanitized evidence and legacy rc 3" || bad "no-effect rejection outcome contract failed"

current_token=$(cd "$ROOT/wc" && taskdag_activation_snapshot_token)
fail_fenced_readback=false
git() {
  if [ "$fail_fenced_readback" = true ] && [ "${1:-}" = ls-remote ]; then return 1; fi
  command git "$@"
}
taskdag_activation_test_after_fenced_push_hook() { fail_fenced_readback=true; }
indeterminate=$(cd "$ROOT/wc"; taskdag_activation_fenced_push "$current_token" fixture ambiguous fixture 2026-07-17T00:00:07Z refs/heads/fixture-target "$contender" "$next" >/dev/null 2>&1; rc=$?; printf '%s\n' "$TASKDAG_ACTIVATION_FENCED_PUSH_RESULT"; exit "$rc"); rc=$?
unset -f taskdag_activation_test_after_fenced_push_hook git
[ "$rc" -eq 3 ] && jq -e '.outcome=="indeterminate" and .readback==null' <<<"$indeterminate" >/dev/null \
  && ok "unavailable readback is indeterminate with legacy rc 3" || bad "indeterminate outcome contract failed"

# Accepted outer target plus a later unrelated fenced successor remains
# provably applied because the successor names the outer guard as authority.
current_token=$(cd "$ROOT/wc" && taskdag_activation_snapshot_token)
after_next=$(printf 'after-next\n' | git -C "$ROOT/wc" commit-tree "$empty" -p "$next")
side2=$(printf 'side-two\n' | git -C "$ROOT/wc" commit-tree "$empty" -p "$side")
taskdag_activation_test_after_fenced_push_hook() {
  unset -f taskdag_activation_test_after_fenced_push_hook
  local successor_token
  successor_token=$(taskdag_activation_snapshot_token) || return
  taskdag_activation_fenced_push "$successor_token" fixture successor fixture 2026-07-17T00:00:08Z refs/heads/fixture-side "$side" "$side2" >/dev/null
}
successor=$(cd "$ROOT/wc"; taskdag_activation_fenced_push "$current_token" fixture predecessor fixture 2026-07-17T00:00:08Z refs/heads/fixture-target "$next" "$after_next" >/dev/null 2>&1; rc=$?; printf '%s\n' "$TASKDAG_ACTIVATION_FENCED_PUSH_RESULT"; exit "$rc"); rc=$?
unset -f taskdag_activation_test_after_fenced_push_hook
[ "$rc" -eq 0 ] && jq -e '.outcome=="applied" and .authority.observed!=.authority.guard and .readback.targets[0].oid==.updates[0].new' <<<"$successor" >/dev/null \
  && ok "accepted fenced push survives an unrelated authority successor before readback" || bad "fenced successor was not proven applied"

# A syntactically malformed advertisement can never prove success, including
# a deletion where a dropped row would otherwise resemble an absent ref.
current_token=$(cd "$ROOT/wc" && taskdag_activation_snapshot_token)
malformed_candidate=$(printf 'malformed-readback\n' | git -C "$ROOT/wc" commit-tree "$empty" -p "$after_next")
malformed_readback=false
git() {
  if [ "$malformed_readback" = true ] && [ "${1:-}" = ls-remote ]; then
    command git "$@" | sed -n '1p;1p;2,$p'
    return "${PIPESTATUS[0]}"
  fi
  command git "$@"
}
taskdag_activation_test_after_fenced_push_hook() { malformed_readback=true; }
malformed_result=$(cd "$ROOT/wc"; taskdag_activation_fenced_push "$current_token" fixture malformed-readback fixture 2026-07-17T00:00:09Z refs/heads/fixture-target "$after_next" "$malformed_candidate" >/dev/null 2>&1; rc=$?; printf '%s\n' "$TASKDAG_ACTIVATION_FENCED_PUSH_RESULT"; exit "$rc"); rc=$?
unset -f taskdag_activation_test_after_fenced_push_hook git
[ "$rc" -eq 3 ] && jq -e '.outcome=="indeterminate" and .readback==null' <<<"$malformed_result" >/dev/null \
  && ok "duplicate readback rows are indeterminate" || bad "malformed readback was treated as coherent"

# A hex-shaped but non-guard authority cannot be called retryable contention.
current_token=$(cd "$ROOT/wc" && taskdag_activation_snapshot_token)
authority_now=$(jq -r .authorityTip <<<"$current_token")
arbitrary=$(printf 'not a guard\n' | git -C "$ROOT/wc" commit-tree "$(git -C "$ROOT/wc" rev-parse "$authority_now^{tree}")" -p "$authority_now")
taskdag_activation_test_pre_fenced_push_hook() {
  unset -f taskdag_activation_test_pre_fenced_push_hook
  command git push -q origin "$arbitrary:$TASKDAG_ACTIVATION_REF"
}
untrusted_authority=$(cd "$ROOT/wc"; taskdag_activation_fenced_push "$current_token" fixture untrusted-authority fixture 2026-07-17T00:00:10Z refs/heads/fixture-side "$side2" "$side" >/dev/null 2>&1; rc=$?; printf '%s\n' "$TASKDAG_ACTIVATION_FENCED_PUSH_RESULT"; exit "$rc"); rc=$?
unset -f taskdag_activation_test_pre_fenced_push_hook
[ "$rc" -eq 3 ] && jq -e '.outcome=="indeterminate" and .authority.observed!=.authority.expected' <<<"$untrusted_authority" >/dev/null \
  && ok "unvalidated authority movement is indeterminate, not retryable" || bad "unvalidated authority was classified as contention"
git -C "$ROOT/wc" push -q origin --force-with-lease="$TASKDAG_ACTIVATION_REF:$arbitrary" "$authority_now:$TASKDAG_ACTIVATION_REF"

cp "$ROOT/spec" "$ROOT/bad"; jq '.unknown=true' "$ROOT/bad" >"$ROOT/bad.n"; mv "$ROOT/bad.n" "$ROOT/bad"
(cd "$ROOT/wc" && "$TD" activation apply --spec-file "$ROOT/bad" >/dev/null 2>&1); rc=$?
[ "$rc" -eq 2 ] && ok "unknown spec key is rejected" || bad "unknown key rc=$rc"

schema_matrix_ok=true
for filter in \
  '.registrySnapshot.repositories[0].repairMode="none"' \
  '.registrySnapshot.repositories[0].repairBranch="master"' \
  '.registrySnapshot.source.repository="VirusDave/top-level"' \
  '.registrySnapshot.source.path="../registry.json"' \
  '.sourceTips[0].ref="refs/tags/master"' \
  '.sourceTips[0].repositoryId="other"' \
  '.registrySnapshot.repositories += [.registrySnapshot.repositories[0]]' \
  '.sourceTips += [.sourceTips[0]]'; do
  jq "$filter" "$ROOT/spec" >"$ROOT/schema-bad"
  jq -cS '.registrySnapshot' "$ROOT/schema-bad" >"$ROOT/schema-registry"
  bad_registry_id=$(_taskdag_activation_registry_id "$ROOT/schema-registry")
  jq --arg id "$bad_registry_id" '.registrySnapshot.id=$id' "$ROOT/schema-bad" >"$ROOT/schema-bad.n" && mv "$ROOT/schema-bad.n" "$ROOT/schema-bad"
  (cd "$ROOT/wc" && cmd_activation_apply --spec-file "$ROOT/schema-bad" >/dev/null 2>&1) && schema_matrix_ok=false
done
[ "$schema_matrix_ok" = true ] && ok "strict schema rejects repair, source, ref, correspondence, and duplicate violations" || bad "strict schema matrix accepted an adversary"

# Malformed and oversized input must fail before the first Git/network effect.
mkdir "$ROOT/no-effect-bin"; real_git=$(command -v git)
cat >"$ROOT/no-effect-bin/git" <<EOF
#!/usr/bin/env bash
printf x >>"$ROOT/git-effects"
exec "$real_git" "\$@"
EOF
chmod +x "$ROOT/no-effect-bin/git"
printf '{"actor":"x","actor":"y"}\n' >"$ROOT/duplicate"
head -c 262145 /dev/zero >"$ROOT/oversized"
for invalid in duplicate oversized; do
  : >"$ROOT/git-effects"
  (cd "$ROOT/wc" && PATH="$ROOT/no-effect-bin:$PATH" cmd_activation_apply --spec-file "$ROOT/$invalid" >/dev/null 2>&1); rc=$?
  [ "$rc" -eq 2 ] && [ ! -s "$ROOT/git-effects" ] || bad "$invalid spec performed Git/network effects"
done
[ ! -s "$ROOT/git-effects" ] && ok "malformed and oversized specs perform no Git/network operation"

# Deterministic crash and accepted-but-ambiguous seams exercise apply itself.
git init -q --bare "$ROOT/apply-origin"; git init -q "$ROOT/apply-wc"; git -C "$ROOT/apply-wc" remote add origin "$ROOT/apply-origin"
taskdag_activation_test_pre_cas_hook() { return 86; }
export -f taskdag_activation_test_pre_cas_hook
(cd "$ROOT/apply-wc" && "$TD" activation apply --spec-file "$ROOT/spec" >/dev/null); rc=$?
unset -f taskdag_activation_test_pre_cas_hook
if [ "$rc" -eq 86 ] \
   && ! git --git-dir="$ROOT/apply-origin" show-ref --verify --quiet "$TASKDAG_ACTIVATION_REF" \
   && (cd "$ROOT/apply-wc" && "$TD" activation apply --spec-file "$ROOT/spec" >/dev/null); then
  retry_tip=$(git --git-dir="$ROOT/apply-origin" rev-parse "$TASKDAG_ACTIVATION_REF")
  [ "$(git --git-dir="$ROOT/apply-origin" rev-list --count "$retry_tip")" -eq 1 ] \
    && ok "public activation retry converges to one epoch after a pre-CAS crash" \
    || bad "public activation retry created multiple epochs after a pre-CAS crash"
else
  bad "public pre-CAS crash changed authority or clean retry failed"
fi
# Use a fresh origin so accepted-response-loss still starts from epoch one.
rm -rf "$ROOT/apply-origin" "$ROOT/apply-wc"
git init -q --bare "$ROOT/apply-origin"; git init -q "$ROOT/apply-wc"; git -C "$ROOT/apply-wc" remote add origin "$ROOT/apply-origin"
mkdir "$ROOT/ambiguous-bin"; ambiguous_real_git=$(command -v git)
cat >"$ROOT/ambiguous-bin/git" <<EOF
#!/usr/bin/env bash
for arg in "\$@"; do
  if [ "\$arg" = push ] && [ ! -e "$ROOT/ambiguous-push-seen" ]; then
    "$ambiguous_real_git" "\$@" || exit \$?
    : >"$ROOT/ambiguous-push-seen"
    exit 91
  fi
done
exec "$ambiguous_real_git" "\$@"
EOF
chmod +x "$ROOT/ambiguous-bin/git"
(cd "$ROOT/apply-wc" && PATH="$ROOT/ambiguous-bin:$PATH" "$TD" activation apply --spec-file "$ROOT/spec" >/dev/null); rc=$?
apply_tip=$(git --git-dir="$ROOT/apply-origin" rev-parse "$TASKDAG_ACTIVATION_REF")
[ "$rc" -eq 0 ] && [ -e "$ROOT/ambiguous-push-seen" ] && [ "$(git --git-dir="$ROOT/apply-origin" rev-list --count "$apply_tip")" -eq 1 ] \
  && ok "post-accept ambiguity converges by readback without second epoch" || bad "ambiguous apply did not converge"

# A successor may land after this writer's accepted CAS but before its
# readback. The accepted candidate remains provable in permanent first-parent
# history and must be classified as success rather than invite a retry epoch.
jq '.state="disabled" | .authoritativeTimestamp="2026-07-17T00:00:08Z"' "$ROOT/spec" >"$ROOT/apply-candidate"
jq '.state="enabled" | .authoritativeTimestamp="2026-07-17T00:00:09Z"' "$ROOT/spec" >"$ROOT/apply-successor"
taskdag_activation_test_after_accepted_hook() {
  unset -f taskdag_activation_test_after_accepted_hook
  cmd_activation_apply --spec-file "$ROOT/apply-successor" >/dev/null
}
(cd "$ROOT/apply-wc" && cmd_activation_apply --spec-file "$ROOT/apply-candidate" >/dev/null); rc=$?
unset -f taskdag_activation_test_after_accepted_hook 2>/dev/null || true
successor_tip=$(git --git-dir="$ROOT/apply-origin" rev-parse "$TASKDAG_ACTIVATION_REF")
[ "$rc" -eq 0 ] && [ "$(git --git-dir="$ROOT/apply-origin" rev-list --count "$successor_tip")" -eq 3 ] \
  && [ "$(git --git-dir="$ROOT/apply-origin" show "$successor_tip:records/0000000000000002.json" | jq -r .state)" = disabled ] \
  && [ "$(git --git-dir="$ROOT/apply-origin" show "$successor_tip:records/0000000000000003.json" | jq -r .state)" = enabled ] \
  && ok "accepted activation converges when a valid successor lands before readback" || bad "successor-before-readback misclassified accepted activation"

# Advance the ref specifically between classifier ls-remote and fetch. Fetch's
# coherent result must reach ancestry classification rather than fail on the
# stale ls-remote OID.
jq '.state="disabled" | .authoritativeTimestamp="2026-07-17T00:00:10Z"' "$ROOT/spec" >"$ROOT/fetch-race-candidate"
jq '.state="enabled" | .authoritativeTimestamp="2026-07-17T00:00:11Z"' "$ROOT/spec" >"$ROOT/fetch-race-successor"
: >"$ROOT/fetch-hook-count"
taskdag_activation_test_after_ls_remote_hook() {
  local count
  count=$(wc -c <"$ROOT/fetch-hook-count"); printf x >>"$ROOT/fetch-hook-count"
  if [ "$count" -eq 1 ]; then
    unset -f taskdag_activation_test_after_ls_remote_hook
    cmd_activation_apply --spec-file "$ROOT/fetch-race-successor" >/dev/null
  fi
}
(cd "$ROOT/apply-wc" && cmd_activation_apply --spec-file "$ROOT/fetch-race-candidate" >/dev/null); rc=$?
unset -f taskdag_activation_test_after_ls_remote_hook 2>/dev/null || true
fetch_race_tip=$(git --git-dir="$ROOT/apply-origin" rev-parse "$TASKDAG_ACTIVATION_REF")
[ "$rc" -eq 0 ] && [ "$(git --git-dir="$ROOT/apply-origin" rev-list --count "$fetch_race_tip")" -eq 5 ] \
  && ok "successor between ls-remote and fetch remains coherently classifiable" || bad "ls-remote/fetch successor race misclassified accepted activation"

# Real concurrent clients: equivalent requests converge, while requests with
# the same empty base but different desired records cannot serialize as epochs
# one and two.
git init -q --bare "$ROOT/concurrent-origin"
for client in same-a same-b; do git init -q "$ROOT/$client"; git -C "$ROOT/$client" remote add origin "$ROOT/concurrent-origin"; done
for client in same-a same-b; do (cd "$ROOT/$client" && cmd_activation_apply --spec-file "$ROOT/spec" >/dev/null; echo $? >"$ROOT/$client.rc") & done
wait
concurrent_tip=$(git --git-dir="$ROOT/concurrent-origin" rev-parse "$TASKDAG_ACTIVATION_REF")
if [ "$(cat "$ROOT/same-a.rc")" -eq 0 ] && [ "$(cat "$ROOT/same-b.rc")" -eq 0 ] \
  && [ "$(git --git-dir="$ROOT/concurrent-origin" rev-list --count "$concurrent_tip")" -eq 1 ]; then
  ok "concurrent identical frozen specs converge on one epoch"
else bad "identical activation concurrency failed"; fi

git init -q --bare "$ROOT/different-origin"
for client in different-a different-b; do git init -q "$ROOT/$client"; git -C "$ROOT/$client" remote add origin "$ROOT/different-origin"; done
jq '.actor="other"' "$ROOT/spec" >"$ROOT/different-spec"
taskdag_activation_test_pre_cas_hook() {
  local name
  name=$(basename "$PWD")
  : >"$ROOT/$name.ready"
  while [ ! -e "$ROOT/different-a.ready" ] || [ ! -e "$ROOT/different-b.ready" ]; do sleep 0.01; done
}
(cd "$ROOT/different-a" && cmd_activation_apply --spec-file "$ROOT/spec" >/dev/null; echo $? >"$ROOT/different-a.rc") &
(cd "$ROOT/different-b" && cmd_activation_apply --spec-file "$ROOT/different-spec" >/dev/null; echo $? >"$ROOT/different-b.rc") &
wait
unset -f taskdag_activation_test_pre_cas_hook
different_tip=$(git --git-dir="$ROOT/different-origin" rev-parse "$TASKDAG_ACTIVATION_REF")
different_rcs="$(cat "$ROOT/different-a.rc") $(cat "$ROOT/different-b.rc")"
if [[ "$different_rcs" = "0 3" || "$different_rcs" = "3 0" ]] \
  && [ "$(git --git-dir="$ROOT/different-origin" rev-list --count "$different_tip")" -eq 1 ]; then
  ok "concurrent differing requests choose one winner and one stale failure"
else bad "differing activation concurrency serialized unexpectedly (rc=$different_rcs)"; fi

# The private materialisation core uses the real authority reader and must
# refuse disabled state without creating its own authority.
jq '.state="disabled" | .authoritativeTimestamp="2026-07-17T00:00:05Z"' "$ROOT/re-enabled" >"$ROOT/disabled-again"
(cd "$ROOT/wc" && cmd_activation_apply --spec-file "$ROOT/disabled-again" >/dev/null); rc=$?
printf 'private body\n' >"$ROOT/material-body"
jq -n '{schema:1,actor:"fixture",authoritativeTimestamp:"2026-07-17T00:00:06Z",provenance:["activation-test"],declarations:[{sourceRepo:{id:"s",name:"o/source"},parentIssue:{id:"i",number:1},peerRepo:{id:"p",name:"o/peer"},title:"Private",bodyFile:"material-body",provenance:"activation-test"}]}' >"$ROOT/material-spec"
(cd "$ROOT/wc" && taskdag_materialise_reserve_core "$ROOT/material-spec" >/dev/null 2>&1); material_rc=$?
[ "$rc" -eq 0 ] && [ "$material_rc" -eq 3 ] && ! git --git-dir="$ROOT/origin" show-ref --verify --quiet refs/heads/tasks/v1/materialisation \
  && ok "disabled real authority blocks private materialisation without a ref" || bad "disabled private materialisation escaped (rc=$material_rc)"

# Re-enable and exercise the real two-ref activation/materialisation fence.
jq '.state="enabled" | .authoritativeTimestamp="2026-07-17T00:00:07Z"' "$ROOT/disabled-again" >"$ROOT/enabled-again"
(cd "$ROOT/wc" && cmd_activation_apply --spec-file "$ROOT/enabled-again" >/dev/null); rc=$?
(cd "$ROOT/wc" && taskdag_materialise_reserve_core "$ROOT/material-spec" >"$ROOT/real-material-result"); material_rc=$?
real_activation_tip=$(git --git-dir="$ROOT/origin" rev-parse "$TASKDAG_ACTIVATION_REF")
real_material_tip=$(git --git-dir="$ROOT/origin" rev-parse refs/heads/tasks/v1/materialisation)
real_active=$(git --git-dir="$ROOT/origin" rev-parse "$real_activation_tip^")
real_batch=$(jq -r .batchId "$ROOT/real-material-result")
real_slot=$(jq -r '.members[0].slotId' "$ROOT/real-material-result")
real_provenance=$(git --git-dir="$ROOT/origin" show "$real_material_tip:batches/$real_batch.json" | jq -c .activation)
if [ "$rc" -eq 0 ] && [ "$material_rc" -eq 0 ] \
  && [ "$(git --git-dir="$ROOT/origin" rev-parse "$real_activation_tip^{tree}")" = "$(git --git-dir="$ROOT/origin" rev-parse "$real_active^{tree}")" ] \
  && [ "$real_provenance" = "$(git --git-dir="$ROOT/origin" show "$real_material_tip:slots/$real_slot/states/0000000000000000.json" | jq -c .activation)" ] \
  && (cd "$ROOT/wc" && taskdag_activation_validate_provenance "$real_activation_tip" "$real_provenance"); then
  ok "real enabled materialisation atomically advances both fenced authorities"
else bad "real enabled materialisation fence/provenance integration failed"; fi

# Recompute an otherwise internally coherent materialisation root around a
# forged activation digest. Strict semantic validation must reject it against
# the permanent activation epoch rather than trusting tuple shape or batch ID.
git --git-dir="$ROOT/origin" show "$real_material_tip:batches/$real_batch.json" >"$ROOT/forged-batch"
disabled_path=""
while IFS= read -r candidate_path; do
  if [ "$(git --git-dir="$ROOT/origin" show "$real_active:$candidate_path" | jq -r .state)" = disabled ]; then disabled_path=$candidate_path; break; fi
done < <(git --git-dir="$ROOT/origin" ls-tree -r --name-only "$real_active" | grep '^records/')
disabled_record="$ROOT/disabled-record"
git --git-dir="$ROOT/origin" show "$real_active:$disabled_path" >"$disabled_record"
forged_digest=$(sha256sum "$disabled_record" | awk '{print $1}')
forged_epoch=$(jq -r .epoch "$disabled_record")
jq --arg digest "$forged_digest" --argjson epoch "$forged_epoch" '.activation.digest=$digest | .activation.epoch=$epoch' "$ROOT/forged-batch" >"$ROOT/forged-batch.n" && mv "$ROOT/forged-batch.n" "$ROOT/forged-batch"
forged_batch_id=$(_taskdag_materialise_id batch "$(jq -c .members "$ROOT/forged-batch")" "$(jq -c .provenance "$ROOT/forged-batch")" "$(jq -c .activation "$ROOT/forged-batch")")
jq -cS --arg batch "$forged_batch_id" '.batchId=$batch' "$ROOT/forged-batch" >"$ROOT/forged-batch.n" && mv "$ROOT/forged-batch.n" "$ROOT/forged-batch"
git --git-dir="$ROOT/origin" show "$real_material_tip:slots/$real_slot/states/0000000000000000.json" \
  | jq -cS --arg digest "$forged_digest" --argjson epoch "$forged_epoch" --arg batch "$forged_batch_id" '.activation.digest=$digest | .activation.epoch=$epoch | .batchId=$batch' >"$ROOT/forged-slot"
forged_index="$ROOT/forged-material-index"
GIT_INDEX_FILE="$forged_index" git -C "$ROOT/wc" read-tree "$real_material_tip"
GIT_INDEX_FILE="$forged_index" git -C "$ROOT/wc" update-index --force-remove "batches/$real_batch.json"
GIT_INDEX_FILE="$forged_index" git -C "$ROOT/wc" update-index --add --cacheinfo "100644,$(git -C "$ROOT/wc" hash-object -w "$ROOT/forged-batch"),batches/$forged_batch_id.json"
GIT_INDEX_FILE="$forged_index" git -C "$ROOT/wc" update-index --add --cacheinfo "100644,$(git -C "$ROOT/wc" hash-object -w "$ROOT/forged-slot"),slots/$real_slot/states/0000000000000000.json"
forged_tree=$(GIT_INDEX_FILE="$forged_index" git -C "$ROOT/wc" write-tree)
forged_material=$(printf 'forged activation provenance\n' | git -C "$ROOT/wc" commit-tree "$forged_tree")
forged_out=$(cd "$ROOT/wc" && taskdag_materialisation_tree_violations "$forged_material" "$real_activation_tip")
grep -q 'forged activation provenance' <<<"$forged_out" \
  && ok "strict materialisation rejects exact provenance from a disabled epoch" || bad "disabled-epoch activation provenance passed strict validation"

# Digest-tool failure cannot disappear into a valid activation history.
mkdir "$ROOT/fail-sha"; real_sha=$(command -v sha256sum)
cat >"$ROOT/fail-sha/sha256sum" <<'EOF'
#!/usr/bin/env bash
exit 92
EOF
chmod +x "$ROOT/fail-sha/sha256sum"
(cd "$ROOT/wc" && PATH="$ROOT/fail-sha:$PATH" taskdag_activation_validate_history "$real_activation_tip" >/dev/null 2>&1); digest_rc=$?
[ "$digest_rc" -ne 0 ] && ok "strict history rejects activation digest-tool failure" || bad "activation digest-tool failure disappeared"

# Strict history adversaries. Each candidate is local-only and must fail the
# same full validator used by strict dispatch.
active_tip=$(git --git-dir="$ROOT/origin" rev-parse "$TASKDAG_ACTIVATION_REF")
git -C "$ROOT/wc" fetch -q origin "$TASKDAG_ACTIVATION_REF"; active_tip=$(git -C "$ROOT/wc" rev-parse FETCH_HEAD)
active_tree=$(git -C "$ROOT/wc" rev-parse "$active_tip^{tree}")
other_root=$(printf 'other\n' | git -C "$ROOT/wc" commit-tree "$empty")
bad_merge=$(printf 'merge\n' | git -C "$ROOT/wc" commit-tree "$active_tree" -p "$active_tip" -p "$other_root")
bad_message=$(printf 'Task-Dag-Activation-Guard: v1\nwrong\n' | git -C "$ROOT/wc" commit-tree "$active_tree" -p "$active_tip")
bad_guard_parent=$(printf 'Task-Dag-Activation-Guard: v1\nwrong\n' | git -C "$ROOT/wc" commit-tree "$active_tree" -p "$other_root")
idx="$ROOT/corrupt-index"; GIT_INDEX_FILE="$idx" git -C "$ROOT/wc" read-tree "$active_tree"
GIT_INDEX_FILE="$idx" git -C "$ROOT/wc" update-index --add --cacheinfo "100644,$(printf '{}\n' | git -C "$ROOT/wc" hash-object -w --stdin),extra.json"
extra_tree=$(GIT_INDEX_FILE="$idx" git -C "$ROOT/wc" write-tree); rm -f "$idx"
bad_extra=$(printf 'extra\n' | git -C "$ROOT/wc" commit-tree "$extra_tree" -p "$active_tip")
corrupt_ok=true
for pair in "merge:$bad_merge" "guard-message:$bad_message" "guard-parent:$bad_guard_parent" "extra-record:$bad_extra"; do
  name=${pair%%:*}; candidate=${pair#*:}
  (cd "$ROOT/wc" && taskdag_activation_validate_history "$candidate" >/dev/null 2>&1) && { echo "accepted corruption: $name" >&2; corrupt_ok=false; }
done
[ "$corrupt_ok" = true ] && ok "strict history rejects merge, malformed guard, wrong parent, and extra path" || bad "strict history accepted corruption"

# Missing ancestry and an unreadable Git producer are explicit failures.
git init -q "$ROOT/missing"
missing_tree=$(git -C "$ROOT/missing" mktree </dev/null)
missing_parent=$(cd "$ROOT/missing" && printf 'p\n' | git commit-tree "$missing_tree")
missing_tip=$(cd "$ROOT/missing" && printf 'c\n' | git commit-tree "$missing_tree" -p "$missing_parent")
rm "$ROOT/missing/.git/objects/${missing_parent:0:2}/${missing_parent:2}"
(cd "$ROOT/missing" && taskdag_activation_validate_history "$missing_tip" >/dev/null 2>&1); missing_rc=$?
mkdir "$ROOT/fail-git"; cat >"$ROOT/fail-git/git" <<EOF
#!/usr/bin/env bash
[ "\${1:-}" != rev-list ] || exit 91
exec "$real_git" "\$@"
EOF
chmod +x "$ROOT/fail-git/git"
(cd "$ROOT/wc" && PATH="$ROOT/fail-git:$PATH" taskdag_activation_validate_history "$active_tip" >/dev/null 2>&1); unreadable_rc=$?
[ "$missing_rc" -ne 0 ] && [ "$unreadable_rc" -ne 0 ] && ok "strict history rejects missing ancestry and unreadable Git" || bad "strict infrastructure failure disappeared"

git -C "$ROOT/wc" fetch -q origin refs/heads/tasks/v1/activation
git -C "$ROOT/wc" update-ref refs/heads/tasks/v1/activation FETCH_HEAD
git -C "$ROOT/wc" fetch -q origin refs/heads/tasks/v1/materialisation
git -C "$ROOT/wc" update-ref refs/heads/tasks/v1/materialisation FETCH_HEAD
(cd "$ROOT/wc" && "$TD" validate --strict >/dev/null 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "strict validator accepts exact activation ref" || bad "strict activation validation rc=$rc"
git -C "$ROOT/wc" update-ref -d refs/heads/tasks/v1/activation
(cd "$ROOT/wc" && "$TD" validate --strict >/dev/null 2>&1); rc=$?
[ "$rc" -eq 3 ] && ok "strict materialisation requires the exact activation authority" || bad "strict materialisation accepted absent activation authority"
git -C "$ROOT/wc" update-ref refs/heads/tasks/v1/activation "$real_activation_tip"
delete_target=$(printf 'delete target\n' | git -C "$ROOT/wc" commit-tree "$empty")
git -C "$ROOT/wc" push -q origin "$delete_target:refs/heads/fixture-delete"
delete_token=$(cd "$ROOT/wc" && taskdag_activation_snapshot_token)
delete_updates=$(jq -ncS --arg old "$delete_target" '[{ref:"refs/heads/fixture-delete",old:$old,new:""}]')
(cd "$ROOT/wc" && taskdag_activation_fenced_multi_push "$delete_token" fixture delete fixture 2026-07-17T00:00:10Z "$delete_updates"); rc=$?
[ "$rc" -eq 0 ] && ! git --git-dir="$ROOT/origin" show-ref --verify --quiet refs/heads/fixture-delete \
  && ok "fenced multi-push supports leased ref deletion" || bad "fenced ref deletion rc=$rc"
git -C "$ROOT/wc" update-ref refs/heads/tasks/v1/activation-junk FETCH_HEAD
(cd "$ROOT/wc" && "$TD" validate --strict >/dev/null 2>&1); rc=$?
[ "$rc" -eq 3 ] && ok "strict validator rejects broad activation namespace" || bad "broad activation ref rc=$rc"

echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
