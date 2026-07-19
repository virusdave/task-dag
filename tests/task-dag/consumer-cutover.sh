#!/usr/bin/env bash
set -uo pipefail
TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0 FAIL=0
ok() { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_CLAIMER=fixture TASK_DAG_CLAIMER_HOST=fixture TASK_DAG_CLAIMER_PID=4242

fixture_fail_publish_readback=false
git() {
  if [ "$fixture_fail_publish_readback" = true ] && [ "${1:-}" = ls-remote ]; then return 1; fi
  command git "$@"
}

git init -q --bare "$ROOT/origin"
git clone -q "$ROOT/origin" "$ROOT/wc"
cd "$ROOT/wc"
echo seed >seed; git add seed; git commit -qm seed; git push -q origin HEAD:master
git config taskdag.current-repo virusdave/task-dag
git config taskdag.virusdave/task-dag.id 1
EMPTY_TREE=4b825dc642cb6eb9a060e54bf8d69288fbee4904

dep=$(git commit-tree "$EMPTY_TREE" -p HEAD -m 'Task: dependency')
wait=$(git commit-tree "$EMPTY_TREE" -p HEAD -m 'Task: waiting leaf')
short=$(git rev-parse --short "$wait")
git update-ref "refs/heads/tasks/frontier/$short" "$wait"
git push -q origin "refs/heads/tasks/frontier/$short"
"$TD" dep add --from "task:virusdave/task-dag@$wait" --to "task:virusdave/task-dag@$dep" \
  --relation requires --repo-id 1 --witness fixture >/dev/null

if "$TD" frontier --json | jq -e --arg wait "$wait" 'any(.[]; .sha==$wait)' >/dev/null; then
  ok "pre-activation consumer preserves legacy parent semantics"
else bad "pre-activation consumer unexpectedly authorized graph semantics"; fi

runtime=$(git -C "$(dirname "$TD")/.." rev-parse HEAD)
registry_commit=1111111111111111111111111111111111111111
registry_blob=2222222222222222222222222222222222222222
registry=$(jq -ncS --arg commit "$registry_commit" --arg blob "$registry_blob" '{schema:1,source:{repository:"virusdave/top-level",path:"registry.json",commit:$commit,blob:$blob},repositories:[{repository:"virusdave/task-dag",repositoryId:"1",name:"task-dag",repairMode:"off",repairBranch:null}]}')
printf '%s\n' "$registry" >"$ROOT/registry"
TASKDAG_SCRIPT_DIR=$(dirname "$TD"); source "$TASKDAG_SCRIPT_DIR/task-dag.d/materialise.sh"; source "$TASKDAG_SCRIPT_DIR/task-dag.d/activation.sh"; source "$TASKDAG_SCRIPT_DIR/task-dag.d/cross-repo.sh"
registry_id=$(_taskdag_activation_registry_id "$ROOT/registry")
jq -ncS --arg runtime "$runtime" --arg registry_commit "$registry_commit" --arg registry_blob "$registry_blob" --arg id "$registry_id" \
  '{actor:"fixture",authoritativeTimestamp:"2026-07-18T00:00:00Z",minimumCompatibleTaskDagCommit:$runtime,registrySnapshot:{id:$id,schema:1,source:{repository:"virusdave/top-level",path:"registry.json",commit:$registry_commit,blob:$registry_blob},repositories:[{repository:"virusdave/task-dag",repositoryId:"1",name:"task-dag",repairMode:"off",repairBranch:null}]},sourceTips:[{repository:"virusdave/task-dag",repositoryId:"1",ref:"refs/heads/master",commit:$runtime}],state:"enabled"}' >"$ROOT/enabled"
"$TD" activation apply --spec-file "$ROOT/enabled" >/dev/null

frontier=$($TD frontier --json)
"$TD" deps "$wait" --check-complete >/dev/null 2>&1; deps_rc=$?
if ! jq -e --arg wait "$wait" 'any(.[]; .sha==$wait)' <<<"$frontier" >/dev/null && [ "$deps_rc" -eq 2 ]; then
  ok "activated frontier and deps share canonical unsatisfied requirements"
else bad "activated consumers disagreed (deps=$deps_rc frontier=$frontier)"; fi

jq '.state="disabled" | .authoritativeTimestamp="2026-07-18T00:00:01Z"' "$ROOT/enabled" >"$ROOT/disabled"
"$TD" activation apply --spec-file "$ROOT/disabled" >/dev/null
if ! "$TD" frontier --json | jq -e --arg wait "$wait" 'any(.[]; .sha==$wait)' >/dev/null; then
  ok "disabled rollback epoch remains on canonical graph semantics"
else bad "disabled rollback epoch revived legacy semantics"; fi

git clone -q "$ROOT/origin" "$ROOT/fresh"
git -C "$ROOT/fresh" config taskdag.current-repo virusdave/task-dag
git -C "$ROOT/fresh" config taskdag.virusdave/task-dag.id 1
if (cd "$ROOT/fresh" && "$TD" frontier --no-fetch --json >/dev/null 2>&1); then
  bad "fresh offline checkout inferred legacy from missing activation"
else ok "missing local activation is unproven and fails closed offline"; fi

tip=$(git rev-parse HEAD); tree=$(git rev-parse HEAD^{tree})
done_commit=$(git commit-tree "$tree" -p "$tip" -p "$dep" -m 'Complete dependency')
git update-ref refs/heads/master "$done_commit"; git reset -q --soft "$done_commit"
if "$TD" deps "$wait" --no-fetch --check-complete >/dev/null 2>&1; then
  ok "explicit-tip offline consumer uses its pinned local facts tip"
else bad "explicit-tip consumer leaked ambient origin/master facts"; fi
git push -q origin master:master
frontier=$($TD frontier --json)
"$TD" deps "$wait" --check-complete >/dev/null 2>&1; deps_rc=$?
if jq -e --arg wait "$wait" 'any(.[]; .sha==$wait)' <<<"$frontier" >/dev/null && [ "$deps_rc" -eq 0 ]; then
  ok "canonical completion makes every dispatch consumer ready"
else bad "canonical completion did not converge consumers"; fi

if "$TD" claim "$wait" >/dev/null 2>&1; then
  bad "disabled epoch allowed a scheduling mutation"
else ok "disabled rollback epoch fences scheduling effects"; fi
jq '.authoritativeTimestamp="2026-07-18T00:00:02Z"' "$ROOT/enabled" >"$ROOT/re-enabled"
"$TD" activation apply --spec-file "$ROOT/re-enabled" >/dev/null
authority_before_claim=$(git ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')
if "$TD" claim "$wait" >/dev/null && git --git-dir="$ROOT/origin" show-ref --verify --quiet "refs/heads/tasks/active/$short" \
   && [ "$(git ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')" != "$authority_before_claim" ]; then
  ok "direct claim consumes the same verdict and advances the semantic generation"
else bad "direct claim disagreed with frontier and deps"; fi

root=$(git commit-tree "$EMPTY_TREE" -p HEAD -m $'Task: canonical root\nIssue: #77\nType: epic')
git update-ref refs/heads/tasks/pending/77 "$root"; git push -q origin refs/heads/tasks/pending/77
if "$TD" claim-root 77 >/dev/null && git --git-dir="$ROOT/origin" show-ref --verify --quiet refs/heads/tasks/root-active/77; then
  ok "root claim uses the activated fenced scheduling path"
else bad "activated root claim did not converge"; fi

# Consumer preparation may overlap ordinary task writers. It must rebuild a
# complete snapshot under the canonical bounded retry budget rather than fail
# after three hot-loop attempts or misreport every changed ref as activation.
make_contention_root() {
  local issue=$1 root
  root=$(git commit-tree "$EMPTY_TREE" -p HEAD -m "Task: contention root $issue
Issue: #$issue
Type: epic")
  git update-ref "refs/heads/tasks/pending/$issue" "$root"
  git push -q origin "refs/heads/tasks/pending/$issue"
  printf '%s\n' "$root"
}
export ROOT EMPTY_TREE
settling_root=$(make_contention_root 81)
: >"$ROOT/consumer-settling-count"
taskdag_consumer_test_after_prepare_hook() {
  local attempt side
  attempt=$(( $(wc -c <"$ROOT/consumer-settling-count") + 1 ))
  [ "$attempt" -le 3 ] || return 0
  printf x >>"$ROOT/consumer-settling-count"
  side=$(printf 'consumer settling %s\n' "$attempt" | git --git-dir="$ROOT/origin" commit-tree "$EMPTY_TREE") || return
  git --git-dir="$ROOT/origin" update-ref refs/heads/tasks/frontier/consumer-settling "$side"
}
export -f taskdag_consumer_test_after_prepare_hook
settling_out=$(TASKDAG_CAS_BASE_MS=0 TASKDAG_CAS_CAP_MS=0 TASKDAG_CAS_JITTER_MS=0 \
  TASKDAG_CAS_MAX_ATTEMPTS=3 "$TD" claim-root 81 2>&1); settling_rc=$?
unset -f taskdag_consumer_test_after_prepare_hook
if [ "$settling_rc" -eq 0 ] && [ "$(wc -c <"$ROOT/consumer-settling-count")" -eq 3 ] \
   && git --git-dir="$ROOT/origin" show-ref --verify --quiet refs/heads/tasks/root-active/81; then
  ok "consumer snapshot settles on the fourth initial-plus-retry attempt"
else
  bad "consumer snapshot did not recover after bounded task-ref contention (rc=$settling_rc out=$settling_out)"
fi

persistent_root=$(make_contention_root 82)
: >"$ROOT/consumer-persistent-count"
taskdag_consumer_test_after_prepare_hook() {
  local attempt=$1 side
  printf x >>"$ROOT/consumer-persistent-count"
  side=$(printf 'consumer persistent %s\n' "$attempt" | git --git-dir="$ROOT/origin" commit-tree "$EMPTY_TREE") || return
  git --git-dir="$ROOT/origin" update-ref refs/heads/tasks/frontier/consumer-persistent "$side"
}
export -f taskdag_consumer_test_after_prepare_hook
persistent_master=$(git ls-remote origin refs/heads/master | awk '{print $1}')
persistent_graph=$(git ls-remote origin refs/heads/tasks/v1/graph | awk '{print $1}')
persistent_activation=$(git ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')
persistent_out=$(TASKDAG_CAS_BASE_MS=0 TASKDAG_CAS_CAP_MS=0 TASKDAG_CAS_JITTER_MS=0 \
  TASKDAG_CAS_MAX_ATTEMPTS=2 "$TD" claim-root 82 2>&1); persistent_rc=$?
unset -f taskdag_consumer_test_after_prepare_hook
persistent_json=$(grep -E '^\{"attempts":' <<<"$persistent_out" | tail -1)
if [ "$persistent_rc" -eq 3 ] && [ "$(wc -c <"$ROOT/consumer-persistent-count")" -eq 3 ] \
   && jq -e '.status=="exhausted" and .reason=="task-refs" and .attempts==3
      and (.local.taskRefsDigest|test("^[0-9a-f]{64}$"))
      and (.observed.taskRefsDigest|test("^[0-9a-f]{64}$"))
      and .local.taskRefsDigest != .observed.taskRefsDigest' <<<"$persistent_json" >/dev/null \
   && [ "$(git ls-remote origin refs/heads/tasks/pending/82 | awk '{print $1}')" = "$persistent_root" ] \
   && [ -z "$(git ls-remote origin refs/heads/tasks/root-active/82)" ] \
   && [ "$(git ls-remote origin refs/heads/master | awk '{print $1}')" = "$persistent_master" ] \
   && [ "$(git ls-remote origin refs/heads/tasks/v1/graph | awk '{print $1}')" = "$persistent_graph" ] \
   && [ "$(git ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')" = "$persistent_activation" ]; then
  ok "persistent consumer contention exhausts with bounded task-ref evidence and no semantic effect"
else
  bad "persistent consumer contention lost its budget, evidence, or safety (rc=$persistent_rc out=$persistent_out)"
fi

zero_root=$(make_contention_root 84)
: >"$ROOT/consumer-zero-count"
taskdag_consumer_test_after_prepare_hook() {
  local attempt=$1 side
  printf x >>"$ROOT/consumer-zero-count"
  side=$(printf 'consumer zero %s\n' "$attempt" | git --git-dir="$ROOT/origin" commit-tree "$EMPTY_TREE") || return
  git --git-dir="$ROOT/origin" update-ref refs/heads/tasks/frontier/consumer-zero "$side"
}
export -f taskdag_consumer_test_after_prepare_hook
zero_consumer_out=$(TASKDAG_CAS_BASE_MS=0 TASKDAG_CAS_CAP_MS=0 TASKDAG_CAS_JITTER_MS=0 \
  TASKDAG_CAS_MAX_ATTEMPTS=0 "$TD" claim-root 84 2>&1); zero_consumer_rc=$?
unset -f taskdag_consumer_test_after_prepare_hook
if [ "$zero_consumer_rc" -eq 3 ] && [ "$(wc -c <"$ROOT/consumer-zero-count")" -eq 1 ] \
   && grep -q '"attempts":1' <<<"$zero_consumer_out" \
   && [ -z "$(git ls-remote origin refs/heads/tasks/root-active/84)" ]; then
  ok "zero consumer retry budget performs exactly one fail-closed attempt"
else
  bad "zero consumer retry budget skipped or retried its initial attempt (rc=$zero_consumer_rc out=$zero_consumer_out)"
fi

touch "$ROOT/invalid-budget-hook-not-called"
rm "$ROOT/invalid-budget-hook-not-called"
taskdag_consumer_test_after_prepare_hook() { : >"$ROOT/invalid-budget-hook-not-called"; }
export -f taskdag_consumer_test_after_prepare_hook
invalid_budget_out=$(TASKDAG_CAS_MAX_ATTEMPTS=9223372036854775807 "$TD" roots --json 2>&1); invalid_budget_rc=$?
unset -f taskdag_consumer_test_after_prepare_hook
if [ "$invalid_budget_rc" -eq 2 ] \
   && grep -q 'TASKDAG_CAS_MAX_ATTEMPTS must be a decimal integer from 0 through 100' <<<"$invalid_budget_out" \
   && [ ! -e "$ROOT/invalid-budget-hook-not-called" ]; then
  ok "overflowing consumer retry budget fails before preparation"
else
  bad "overflowing consumer retry budget entered preparation (rc=$invalid_budget_rc out=$invalid_budget_out)"
fi
if ! TASKDAG_CAS_MAX_ATTEMPTS=003 "$TD" roots --json >/dev/null 2>&1; then
  bad "leading-zero consumer retry budget was not normalized as decimal"
elif TASKDAG_CAS_MAX_ATTEMPTS=invalid "$TD" roots --json >/dev/null 2>&1; then
  bad "invalid consumer retry budget was accepted"
else
  ok "consumer retry budgets normalize decimal zeros and reject non-digits"
fi
if "$TD" claim-root 82 >/dev/null && git --git-dir="$ROOT/origin" show-ref --verify --quiet refs/heads/tasks/root-active/82; then
  ok "clean retry succeeds after exhausted consumer contention"
else
  bad "clean retry did not replace exhausted consumer state with a ready snapshot"
fi

cat >"$ROOT/breakdown.json" <<'EOF'
[{"title":"Born-claimed activated child","type":"leaf","status":"pending","claim":true}]
EOF
authority_before_breakdown=$(git ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')
breakdown=$($TD breakdown "$root" --spec-file="$ROOT/breakdown.json" --json)
child=$(jq -r '.tasks[0].sha // empty' <<<"$breakdown")
child_short=$(jq -r '.tasks[0].shortSha // empty' <<<"$breakdown")
active_claim=$(git ls-remote origin "refs/heads/tasks/active/$child_short" | awk '{print $1}')
git fetch -q origin "$active_claim"
if [[ "$child" =~ ^[0-9a-f]{40}$ ]] \
   && [ "$(git show -s --format='%(trailers:key=Task-Commit,valueonly)' FETCH_HEAD)" = "$child" ] \
   && [ -z "$(git ls-remote origin refs/heads/tasks/root-active/77)" ] \
   && [ "$(git ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')" != "$authority_before_breakdown" ]; then
  ok "activated breakdown atomically publishes a born-claimed child"
else
  bad "activated breakdown did not publish its fenced update set"
fi

"$TD" block "$dep" --reason="fixture" >/dev/null
authority_before_unblock=$(git ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')
if "$TD" unblock "$dep" >/dev/null \
   && [ -z "$(git ls-remote origin "refs/heads/tasks/blocked/$dep" "refs/heads/tasks/blocked-meta/$dep")" ] \
   && [ "$(git ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')" != "$authority_before_unblock" ]; then
  ok "activated unblock publishes its fenced deletion set"
else bad "activated unblock did not publish its fenced deletion set"; fi

printf 'new incident detail' >"$ROOT/human-comment"
authority_before_comment=$(git ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')
if "$TD" ingest-comment --issue 77 --comment-id 7701 --author human \
     --comment-url https://github.com/virusdave/task-dag/issues/77#issuecomment-7701 \
     --created-at 2026-07-18T00:00:03Z --updated-at 2026-07-18T00:00:03Z \
     --body-file "$ROOT/human-comment" >/dev/null \
   && [ -n "$(git ls-remote origin refs/heads/gh/comments/77/7701 | awk '{print $1}')" ] \
   && [ "$(git ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')" != "$authority_before_comment" ]; then
  ok "activated human ingestion atomically advances the semantic generation"
else
  bad "activated human ingestion bypassed its semantic-generation fence"
fi

jq '.state="disabled" | .authoritativeTimestamp="2026-07-18T00:00:04Z"' "$ROOT/enabled" >"$ROOT/disabled-comment"
"$TD" activation apply --spec-file "$ROOT/disabled-comment" >/dev/null
if "$TD" ingest-comment --issue 77 --comment-id 7702 --author human \
     --comment-url https://github.com/virusdave/task-dag/issues/77#issuecomment-7702 \
     --created-at 2026-07-18T00:00:04Z --updated-at 2026-07-18T00:00:04Z \
     --body-file "$ROOT/human-comment" >/dev/null 2>&1 \
   || [ -n "$(git ls-remote origin refs/heads/gh/comments/77/7702 | awk '{print $1}')" ]; then
  bad "disabled epoch allowed human comment ingestion"
else
  ok "disabled epoch rejects human ingestion without a receipt"
fi
jq '.authoritativeTimestamp="2026-07-18T00:00:05Z"' "$ROOT/enabled" >"$ROOT/re-enabled-comment"
"$TD" activation apply --spec-file "$ROOT/re-enabled-comment" >/dev/null

export ISSUE_TITLE="Backfill an activated issue"
export ISSUE_AUTHOR=fixture
export ISSUE_URL=https://github.com/virusdave/task-dag/issues/78
export ISSUE_BODY="Issue created before canonical task refs existed."
authority_before_backfill=$(git ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')
if "$TD" ingest-comment --issue 78 --comment-id 7801 --author human \
     --comment-url https://github.com/virusdave/task-dag/issues/78#issuecomment-7801 \
     --created-at 2026-07-18T00:00:05Z --updated-at 2026-07-18T00:00:05Z \
     --body-file "$ROOT/human-comment" >/dev/null \
   && [ -n "$(git ls-remote origin refs/heads/tasks/pending/78 | awk '{print $1}')" ] \
   && [ "$(git ls-remote origin refs/heads/tasks/pending/78 | awk '{print $1}')" = "$(git ls-remote origin refs/heads/gh/issues/78 | awk '{print $1}')" ] \
   && [ -n "$(git ls-remote origin refs/heads/gh/comments/78/7801 | awk '{print $1}')" ] \
   && [ "$(git ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')" != "$authority_before_backfill" ]; then
  ok "activated missing-epic ingestion fences backfill and comment effects"
else
  bad "activated missing-epic ingestion escaped canonical generation fencing"
fi

jq '.state="disabled" | .authoritativeTimestamp="2026-07-18T00:00:06Z"' "$ROOT/enabled" >"$ROOT/disabled-backfill"
"$TD" activation apply --spec-file "$ROOT/disabled-backfill" >/dev/null
if "$TD" ingest-comment --issue 79 --comment-id 7901 --author human \
     --comment-url https://github.com/virusdave/task-dag/issues/79#issuecomment-7901 \
     --created-at 2026-07-18T00:00:06Z --updated-at 2026-07-18T00:00:06Z \
     --body-file "$ROOT/human-comment" >/dev/null 2>&1 \
   || [ -n "$(git ls-remote origin refs/heads/tasks/pending/79 refs/heads/gh/issues/79 refs/heads/gh/comments/79/7901 | awk 'NR==1{print $1}')" ]; then
  bad "disabled epoch allowed missing-epic ingestion effects"
else
  ok "disabled epoch rejects missing-epic ingestion before any semantic effect"
fi
jq '.authoritativeTimestamp="2026-07-18T00:00:07Z"' "$ROOT/enabled" >"$ROOT/re-enabled-backfill"
"$TD" activation apply --spec-file "$ROOT/re-enabled-backfill" >/dev/null

# Establish the materialisation authority that an enabled fleet carries. The
# unrelated reservation keeps the close fixture free of materialisation work.
printf 'unrelated child\n' >"$ROOT/unrelated-body"
jq -n '{schema:1,actor:"fixture",authoritativeTimestamp:"2026-07-18T00:00:08Z",provenance:["consumer-cutover"],declarations:[{sourceRepo:{id:"1",name:"virusdave/task-dag"},parentIssue:{id:"issue-999",number:999},peerRepo:{id:"1",name:"virusdave/task-dag"},title:"Unrelated child",bodyFile:"unrelated-body",provenance:"consumer-cutover"}]}' >"$ROOT/unrelated-materialisation"
taskdag_materialise_reserve_core "$ROOT/unrelated-materialisation" >/dev/null

close_root=$(git commit-tree "$EMPTY_TREE" -p HEAD -m $'Task: activated close root\nIssue: #80\nType: epic')
git update-ref refs/heads/tasks/pending/80 "$close_root"
git update-ref refs/heads/gh/issues/80 "$close_root"
git push -q origin refs/heads/tasks/pending/80 refs/heads/gh/issues/80
"$TD" claim-root 80 >/dev/null
cat >"$ROOT/close-breakdown.json" <<'EOF'
[{"title":"Final activated close child","type":"leaf","status":"pending","claim":true}]
EOF
close_breakdown=$($TD breakdown "$close_root" --spec-file="$ROOT/close-breakdown.json" --json)
close_child=$(jq -r '.tasks[0].sha // empty' <<<"$close_breakdown")
echo close-implementation >close-implementation; git add close-implementation; git commit -qm 'Implement activated close child'
close_out=$($TD complete "$close_child")
close_tip=$(git rev-parse HEAD)
authority_before_close_publish=$(git ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')
if git log -1 --format=%B "$close_tip" | grep -q '^Closes-Epic: #80$' \
   && ! grep -q 'deferred by migration drain' <<<"$close_out" \
   && "$TD" publish >/dev/null \
   && [ "$(git ls-remote origin refs/heads/master | awk '{print $1}')" = "$close_tip" ] \
   && [ "$(git ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')" != "$authority_before_close_publish" ]; then
  ok "enabled activation closes the final local epic child through fenced publication"
else
  bad "enabled activation left local epic closure on the legacy migration drain"
fi

remote_master=$(git ls-remote origin refs/heads/master | awk '{print $1}')
malformed=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -p "$wait" -p "$dep" -m 'Malformed extra-parent completion')
if "$TD" publish "$malformed" >/dev/null 2>&1 \
   || [ "$(git ls-remote origin refs/heads/master | awk '{print $1}')" != "$remote_master" ]; then
  bad "publish accepted a non-canonical completion shape"
else
  ok "publish rejects extra-parent completion shapes without moving master"
fi

echo implementation >implementation; git add implementation; git commit -qm 'Implement waiting leaf'
"$TD" complete "$wait" >/dev/null
completion_tip=$(git rev-parse HEAD)
authority_before_publish=$(git ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')
if env -u TASK_DAG_CLAIMER -u TASK_DAG_CLAIMER_HOST -u TASK_DAG_CLAIMER_PID \
     "$TD" guard-pre-push origin "file://$ROOT/origin" \
     <<<"refs/heads/master $completion_tip refs/heads/master $remote_master" >/dev/null 2>&1; then
  bad "activated raw semantic push bypassed the guard without a claimer identity"
else
  ok "activated raw semantic push is rejected even without claimer identity"
fi
contention_side_zero=$(printf 'publication contention zero\n' | git commit-tree "$EMPTY_TREE")
contention_side_retry=$(printf 'publication contention retry\n' | git commit-tree "$EMPTY_TREE")
contention_marker="$ROOT/publish-contention-zero"
contention_ref=refs/heads/fixture-publish-contention-zero
contention_value=$contention_side_zero
export ROOT contention_marker contention_ref contention_value
taskdag_activation_test_pre_fenced_push_hook() {
  [ ! -e "$contention_marker" ] || return 0
  : >"$contention_marker"
  unset -f taskdag_activation_test_pre_fenced_push_hook
  taskdag_activation_fenced_push "$token" fixture publish-contender fixture 2026-07-18T00:00:10Z \
    "$contention_ref" "" "$contention_value" >/dev/null
}
export -f taskdag_activation_test_pre_fenced_push_hook
zero_output=$(TASKDAG_CAS_MAX_ATTEMPTS=0 "$TD" publish 2>&1); zero_rc=$?
if [ "$zero_rc" -eq 3 ] \
   && grep -q 'attempt=1 classification=authority-contention' <<<"$zero_output" \
   && grep -q 'exhausted 0 retries after 1 fenced attempts' <<<"$zero_output" \
   && [ "$(git ls-remote origin refs/heads/master | awk '{print $1}')" = "$remote_master" ]; then
  ok "zero retry budget still performs one fenced attempt and fails loud on contention"
else
  bad "zero retry budget skipped or retried its initial push (rc=$zero_rc out=$zero_output)"
fi

# Persistent contention consumes the complete nonzero retry budget: one
# initial attempt plus exactly MAX retries, with master unchanged throughout.
: >"$ROOT/publish-contention-count"
fixture_nested_contender=false
export fixture_nested_contender EMPTY_TREE
taskdag_activation_test_pre_fenced_push_hook() {
  [ "$fixture_nested_contender" = false ] || return 0
  fixture_nested_contender=true
  local n side
  n=$(( $(wc -c <"$ROOT/publish-contention-count") + 1 ))
  printf x >>"$ROOT/publish-contention-count"
  side=$(printf 'persistent contention %s\n' "$n" | git commit-tree "$EMPTY_TREE") || return
  taskdag_activation_fenced_push "$token" fixture persistent-contender fixture 2026-07-18T00:00:10Z \
    "refs/heads/fixture-publish-persistent-$n" "" "$side" >/dev/null
  fixture_nested_contender=false
}
export -f taskdag_activation_test_pre_fenced_push_hook
exhausted_output=$(TASKDAG_CAS_BASE_MS=0 TASKDAG_CAS_CAP_MS=0 TASKDAG_CAS_JITTER_MS=0 TASKDAG_CAS_MAX_ATTEMPTS=2 "$TD" publish 2>&1); exhausted_rc=$?
unset -f taskdag_activation_test_pre_fenced_push_hook
if [ "$exhausted_rc" -eq 3 ] \
   && [ "$(wc -c <"$ROOT/publish-contention-count")" -eq 3 ] \
   && grep -q "candidate=$completion_tip attempt=3 classification=authority-contention" <<<"$exhausted_output" \
   && grep -Eq 'push-exit=[1-9][0-9]* readback=coherent' <<<"$exhausted_output" \
   && grep -q "master-before=$remote_master master-candidate=$completion_tip master-observed=$remote_master" <<<"$exhausted_output" \
   && grep -Eq 'authority-before=[0-9a-f]{40} authority-observed=[0-9a-f]{40} authority-guard=[0-9a-f]{40}' <<<"$exhausted_output" \
   && grep -q "exhausted 2 retries after 3 fenced attempts" <<<"$exhausted_output" \
   && grep -q "Recovery command: task-dag publish $completion_tip" <<<"$exhausted_output" \
   && [ "$(git ls-remote origin refs/heads/master | awk '{print $1}')" = "$remote_master" ]; then
  ok "persistent contention exhausts exactly MAX retries with complete evidence"
else
  bad "persistent contention exhaustion lost attempts, evidence, or master safety (rc=$exhausted_rc out=$exhausted_output)"
fi

# A local/setup failure before structured push evidence still reports the same
# complete field set, with every unprovable value explicit as unknown.
taskdag_activation_test_pre_fenced_push_hook() { return 91; }
export -f taskdag_activation_test_pre_fenced_push_hook
unavailable_output=$($TD publish 2>&1); unavailable_rc=$?
unset -f taskdag_activation_test_pre_fenced_push_hook
if [ "$unavailable_rc" -eq 91 ] \
   && grep -q "candidate=$completion_tip attempt=1 classification=unavailable push-exit=unknown readback=unknown" <<<"$unavailable_output" \
   && grep -q "master-before=unknown master-candidate=$completion_tip master-observed=unknown" <<<"$unavailable_output" \
   && grep -q 'authority-before=unknown authority-observed=unknown authority-guard=unknown' <<<"$unavailable_output" \
   && grep -q "Recovery command: task-dag publish $completion_tip" <<<"$unavailable_output" \
   && [ "$(git ls-remote origin refs/heads/master | awk '{print $1}')" = "$remote_master" ]; then
  ok "pre-result failure emits a complete explicit-unknown evidence record"
else
  bad "pre-result failure omitted evidence or changed master (rc=$unavailable_rc out=$unavailable_output)"
fi

contention_marker="$ROOT/publish-contention-retry"
contention_ref=refs/heads/fixture-publish-contention-retry
contention_value=$contention_side_retry
export contention_marker contention_ref contention_value
taskdag_activation_test_pre_fenced_push_hook() {
  [ ! -e "$contention_marker" ] || return 0
  : >"$contention_marker"
  unset -f taskdag_activation_test_pre_fenced_push_hook
  taskdag_activation_fenced_push "$token" fixture publish-contender fixture 2026-07-18T00:00:10Z \
    "$contention_ref" "" "$contention_value" >/dev/null
}
export -f taskdag_activation_test_pre_fenced_push_hook
publish_output=$(TASKDAG_CAS_BASE_MS=0 TASKDAG_CAS_CAP_MS=0 TASKDAG_CAS_JITTER_MS=0 TASKDAG_CAS_MAX_ATTEMPTS=1 "$TD" publish 2>&1); publish_rc=$?
unset -f taskdag_activation_test_pre_fenced_push_hook
if [ "$publish_rc" -eq 0 ] \
   && grep -q 'revalidating the same candidate before bounded retry 1/1' <<<"$publish_output" \
   && [ "$(git ls-remote origin refs/heads/master | awk '{print $1}')" = "$completion_tip" ] \
   && [ "$(git ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')" != "$authority_before_publish" ]; then
  ok "canonical publish revalidates and recovers from authority contention"
else
  bad "canonical completion publication did not recover from contention (rc=$publish_rc out=$publish_output)"
fi
if "$TD" publish "$completion_tip" >/dev/null; then
  ok "accepted publication retry converges idempotently"
else
  bad "accepted publication retry did not converge"
fi

# A contention retry re-runs canonical requirements, rather than blindly
# replaying the candidate. Inject a new unsatisfied dependency while advancing
# activation authority between validation and the first push.
invalid_task=$(git commit-tree "$EMPTY_TREE" -p "$completion_tip" -m 'Task: invalidated publication candidate')
invalid_short=$(git rev-parse --short "$invalid_task")
unmet_task=$(git commit-tree "$EMPTY_TREE" -p "$completion_tip" -m 'Task: newly required work')
git update-ref "refs/heads/tasks/frontier/$invalid_short" "$invalid_task"
git push -q origin "refs/heads/tasks/frontier/$invalid_short"
"$TD" claim "$invalid_task" >/dev/null
echo invalidated >invalidated; git add invalidated; git commit -qm 'Implement invalidated candidate'
"$TD" complete "$invalid_task" >/dev/null
master_before_invalid=$(git ls-remote origin refs/heads/master | awk '{print $1}')
export TD invalid_task unmet_task
taskdag_activation_test_pre_fenced_push_hook() {
  [ ! -e "$ROOT/publish-invalidation-injected" ] || return 0
  : >"$ROOT/publish-invalidation-injected"
  "$TD" dep add --from "task:virusdave/task-dag@$invalid_task" --to "task:virusdave/task-dag@$unmet_task" \
    --relation requires --repo-id 1 --witness publication-invalidation >/dev/null
}
export -f taskdag_activation_test_pre_fenced_push_hook
invalid_output=$(TASKDAG_CAS_BASE_MS=0 TASKDAG_CAS_CAP_MS=0 TASKDAG_CAS_JITTER_MS=0 "$TD" publish 2>&1); invalid_rc=$?
unset -f taskdag_activation_test_pre_fenced_push_hook
if [ "$invalid_rc" -eq 2 ] \
   && grep -q 'revalidating the same candidate before bounded retry 1/' <<<"$invalid_output" \
   && grep -q 'canonical requirements changed' <<<"$invalid_output" \
   && [ "$(git ls-remote origin refs/heads/master | awk '{print $1}')" = "$master_before_invalid" ]; then
  ok "contention retry rejects a semantically invalidated completion"
else
  bad "contention retry skipped semantic revalidation (rc=$invalid_rc out=$invalid_output)"
fi
git reset -q --hard "$completion_tip"
if ! "$TD" release "$invalid_task" >/dev/null 2>&1; then
  bad "semantic invalidation fixture could not release its synthetic claim"
fi

prepare_publish_candidate() {
  local label=$1 base short
  base=$(git ls-remote origin refs/heads/master | awk '{print $1}')
  git fetch -q origin "$base"; git reset -q --hard FETCH_HEAD
  prepared_task=$(git commit-tree "$EMPTY_TREE" -p "$base" -m "Task: publication $label")
  short=$(git rev-parse --short "$prepared_task")
  git update-ref "refs/heads/tasks/frontier/$short" "$prepared_task"
  git push -q origin "refs/heads/tasks/frontier/$short"
  "$TD" claim "$prepared_task" >/dev/null
  printf '%s\n' "$label" >"publication-$label"
  git add "publication-$label"; git commit -qm "Implement publication $label"
  "$TD" complete "$prepared_task" >/dev/null
  prepared_tip=$(git rev-parse HEAD)
  prepared_base=$base
}

# A hook rejection proves no effect, preserves the exact candidate, and never
# triggers an automatic retry. Removing the rejection allows that candidate to
# publish without recreation.
prepare_publish_candidate rejection
: >"$ROOT/rejection-attempts"
cat >"$ROOT/origin/hooks/pre-receive" <<EOF
#!/usr/bin/env bash
printf x >>'$ROOT/rejection-attempts'
echo 'fixture rejects publication' >&2
exit 1
EOF
chmod +x "$ROOT/origin/hooks/pre-receive"
rejection_output=$($TD publish 2>&1); rejection_rc=$?
rm -f "$ROOT/origin/hooks/pre-receive"
master_after_rejection=$(git ls-remote origin refs/heads/master | awk '{print $1}')
rejection_retry_output=$($TD publish "$prepared_tip" 2>&1); rejection_retry_rc=$?
if [ "$rejection_rc" -eq 3 ] \
   && grep -q 'rejected with confirmed no remote effect' <<<"$rejection_output" \
   && [ "$(wc -c <"$ROOT/rejection-attempts")" -eq 1 ] \
   && [ "$master_after_rejection" = "$prepared_base" ] \
   && [ "$rejection_retry_rc" -eq 0 ] \
   && [ "$(git ls-remote origin refs/heads/master | awk '{print $1}')" = "$prepared_tip" ]; then
  ok "confirmed no-effect rejection preserves a retryable exact candidate"
else
  bad "confirmed rejection retried, moved master, or lost its candidate (rc=$rejection_rc retry=$rejection_retry_rc out=$rejection_output retry-out=$rejection_retry_output)"
fi

# Simulate an accepted push whose readback is unavailable. Publish must stop as
# indeterminate; an explicit retry then converges from remote ancestry.
prepare_publish_candidate ambiguous
fixture_fail_publish_readback=false
taskdag_activation_test_after_fenced_push_hook() { fixture_fail_publish_readback=true; }
export fixture_fail_publish_readback
export -f git taskdag_activation_test_after_fenced_push_hook
ambiguous_output=$($TD publish 2>&1); ambiguous_rc=$?
unset -f git taskdag_activation_test_after_fenced_push_hook
authority_before_ambiguous_retry=$(git ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')
ambiguous_retry_output=$($TD publish "$prepared_tip" 2>&1); ambiguous_retry_rc=$?
authority_after_ambiguous_retry=$(git ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')
if [ "$ambiguous_rc" -eq 3 ] \
   && grep -q 'outcome is indeterminate' <<<"$ambiguous_output" \
   && grep -q "candidate=$prepared_tip attempt=1 classification=indeterminate push-exit=0 readback=unavailable" <<<"$ambiguous_output" \
   && grep -q "master-before=$prepared_base master-candidate=$prepared_tip master-observed=unknown" <<<"$ambiguous_output" \
   && grep -Eq 'authority-before=[0-9a-f]{40} authority-observed=unknown authority-guard=[0-9a-f]{40}' <<<"$ambiguous_output" \
   && grep -q "Recovery command: task-dag publish $prepared_tip" <<<"$ambiguous_output" \
   && [ "$(git ls-remote origin refs/heads/master | awk '{print $1}')" = "$prepared_tip" ] \
   && [ "$ambiguous_retry_rc" -eq 0 ] \
   && [ "$authority_before_ambiguous_retry" = "$authority_after_ambiguous_retry" ]; then
  ok "accepted response loss stops indeterminate and explicit retry converges"
else
  bad "accepted response loss retried or advanced authority twice (rc=$ambiguous_rc retry=$ambiguous_retry_rc out=$ambiguous_output retry-out=$ambiguous_retry_output)"
fi

# A later unrelated guard can replace our accepted guard before readback. Its
# Expected-Authority-Tip permanently proves our publication was applied.
prepare_publish_candidate successor
successor_side=$(printf 'publish successor\n' | git commit-tree "$EMPTY_TREE")
export successor_side
authority_before_successor=$(git ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')
taskdag_activation_test_after_fenced_push_hook() {
  unset -f taskdag_activation_test_after_fenced_push_hook
  local successor_token
  successor_token=$(taskdag_activation_snapshot_token) || return
  taskdag_activation_fenced_push "$successor_token" fixture publish-successor fixture 2026-07-18T00:00:11Z \
    refs/heads/fixture-publish-successor "" "$successor_side" >/dev/null
}
export -f taskdag_activation_test_after_fenced_push_hook
successor_output=$($TD publish 2>&1); successor_rc=$?
unset -f taskdag_activation_test_after_fenced_push_hook
authority_after_successor=$(git ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')
git fetch -q origin "$authority_after_successor"
successor_message=$(git log -1 --format=%B FETCH_HEAD)
if [ "$successor_rc" -eq 0 ] \
   && [ "$(git ls-remote origin refs/heads/master | awk '{print $1}')" = "$prepared_tip" ] \
   && [ "$(git ls-remote origin refs/heads/fixture-publish-successor | awk '{print $1}')" = "$successor_side" ] \
   && [ "$authority_after_successor" != "$authority_before_successor" ] \
   && grep -q '^Operation: publish-successor$' <<<"$successor_message" \
   && grep -q 'Published canonical task-dag completion' <<<"$successor_output"; then
  ok "authority successor before readback preserves applied publication"
else
  bad "authority successor made an applied publication ambiguous (rc=$successor_rc out=$successor_output)"
fi

stale_task=$(git commit-tree "$EMPTY_TREE" -p "$remote_master" -m 'Task: stale completion candidate')
stale_tip=$(git commit-tree "$(git rev-parse "$remote_master^{tree}")" -p "$remote_master" -p "$stale_task" -m 'Stale completion candidate')
current_master=$(git ls-remote origin refs/heads/master | awk '{print $1}')
if "$TD" publish "$stale_tip" >/dev/null 2>&1 \
   || [ "$(git ls-remote origin refs/heads/master | awk '{print $1}')" != "$current_master" ]; then
  bad "stale publication rewound a concurrently advanced master"
else
  ok "stale publication cannot rewind an advanced master"
fi

activation_tip=$(git ls-remote origin refs/heads/tasks/v1/activation | awk '{print $1}')
git push -q origin "--force-with-lease=refs/heads/tasks/v1/activation:$activation_tip" :refs/heads/tasks/v1/activation
if "$TD" frontier --json >/dev/null 2>&1; then
  bad "online activation disappearance revived legacy semantics"
else
  ok "online disappearance after observed activation fails closed"
fi

# The reason classifier is deliberately pure so precedence cannot drift as
# new consumer call sites are added. Activation generation outranks all
# dependent dimensions; explicit --tip reads ignore ambient master movement.
source "$(dirname "$TD")/task-dag.d/reconcile.sh"
reason_token=$(_taskdag_consumer_mismatch_reason a b c g h m n r s "")
reason_authority=$(_taskdag_consumer_mismatch_reason a a b g h m n r s "")
reason_graph=$(_taskdag_consumer_mismatch_reason a a a g h m n r s "")
reason_master=$(_taskdag_consumer_mismatch_reason a a a g g m n r s "")
reason_refs=$(_taskdag_consumer_mismatch_reason a a a g g m m r s "")
reason_tip=$(_taskdag_consumer_mismatch_reason a a a g g m n r r explicit-tip)
TASKDAG_CONSUMER_PREPARE_RESULT=$(_taskdag_consumer_result exhausted task-refs 3 a a g m r a g m s)
TASKDAG_CONSUMER_PREPARE_RESULT=$(_taskdag_consumer_result ready "" 1 a a g m r a g m r)
if [ "$reason_token" = activation-token ] \
   && [ "$reason_authority" = activation-authority ] \
   && [ "$reason_graph" = graph-tip ] \
   && [ "$reason_master" = master-tip ] \
   && [ "$reason_refs" = task-refs ] \
   && [ -z "$reason_tip" ] \
   && jq -e '.status=="ready" and .reason==null and .attempts==1' <<<"$TASKDAG_CONSUMER_PREPARE_RESULT" >/dev/null; then
  ok "consumer mismatch reasons and replacement result have deterministic semantics"
else
  bad "consumer mismatch reason precedence drifted (token=$reason_token authority=$reason_authority graph=$reason_graph master=$reason_master refs=$reason_refs tip=$reason_tip)"
fi

# Exercise actual prepare calls in one shell with deterministic stubs. The
# first call exhausts an authority mismatch, the second replaces that result
# with READY, and a separate mismatch-then-hook-error call clears both ready
# flags and replaces RETRYING evidence with ERROR.
if (
  TASKDAG_ACTIVATION_REF=refs/heads/tasks/v1/activation
  TASKDAG_GRAPH_REF=refs/heads/tasks/v1/graph
  TASKDAG_CAS_MAX_ATTEMPTS=0
  fixture_authority_mismatch=true
  fixture_authority_calls="$ROOT/unit-authority-calls"
  : >"$fixture_authority_calls"
  _taskdag_consumer_local_activation_authority() {
    local n
    n=$(( $(wc -c <"$fixture_authority_calls") + 1 )); printf x >>"$fixture_authority_calls"
    if [ "$fixture_authority_mismatch" = true ] && [ $(( n % 2 )) -eq 0 ]; then printf 'b\n'; else printf 'a\n'; fi
  }
  _taskdag_consumer_activation_token_at() { printf '%s\n' '{"authorityTip":"a","record":{"minimumCompatibleTaskDagCommit":"runtime"}}'; }
  _taskdag_activation_runtime_commit() { printf 'runtime\n'; }
  taskdag_recon_prepare() { TASKDAG_RECON_FACTS_TIP=m; TASKDAG_FACTS_TIP_OID=m; TASKDAG_RECON_READY=true; }
  taskdag_resolve_facts_tip() { printf 'm\n'; }
  taskdag_cas_sleep() { return 0; }
  taskdag_sha256_hex() { sha256sum | awk '{print $1}'; }
  git() {
    case "$*" in
      *'merge-base --is-ancestor'*) return 0 ;;
      *'rev-parse --verify -q refs/heads/tasks/v1/graph'*) printf 'g\n' ;;
      *'for-each-ref'*) printf 'r refs/heads/tasks/pending/1\n' ;;
      *) command git "$@" ;;
    esac
  }
  taskdag_consumer_prepare unit-exhaust --no-fetch >/dev/null 2>&1 && exit 1
  jq -e '.status=="exhausted" and .reason=="activation-authority"' <<<"$TASKDAG_CONSUMER_PREPARE_RESULT" >/dev/null || exit 1
  [ "$TASKDAG_CONSUMER_READY" = false ] && [ "$TASKDAG_RECON_READY" = false ] || exit 1
  fixture_authority_mismatch=false; : >"$fixture_authority_calls"
  taskdag_consumer_prepare unit-ready --no-fetch >/dev/null 2>&1 || exit 1
  jq -e '.status=="ready" and .reason==null' <<<"$TASKDAG_CONSUMER_PREPARE_RESULT" >/dev/null || exit 1
  [ "$TASKDAG_CONSUMER_READY" = true ] && [ "$TASKDAG_RECON_READY" = true ] || exit 1
  taskdag_sha256_hex() { return 91; }
  taskdag_consumer_prepare unit-digest-error --no-fetch >/dev/null 2>&1; digest_rc=$?
  [ "$digest_rc" -eq 2 ] || exit 1
  jq -e '.status=="error" and .reason==null and .attempts==1' <<<"$TASKDAG_CONSUMER_PREPARE_RESULT" >/dev/null || exit 1
  [ "$TASKDAG_CONSUMER_READY" = false ] && [ "$TASKDAG_RECON_READY" = false ] || exit 1
  taskdag_sha256_hex() { sha256sum | awk '{print $1}'; }
  fixture_authority_mismatch=true; : >"$fixture_authority_calls"; TASKDAG_CAS_MAX_ATTEMPTS=1
  taskdag_consumer_test_after_prepare_hook() { [ "$1" -eq 1 ] || return 91; }
  taskdag_consumer_prepare unit-hard-error --no-fetch >/dev/null 2>&1; hard_rc=$?
  [ "$hard_rc" -eq 91 ] || exit 1
  jq -e '.status=="error" and .reason==null and .attempts==2' <<<"$TASKDAG_CONSUMER_PREPARE_RESULT" >/dev/null || exit 1
  [ "$TASKDAG_CONSUMER_READY" = false ] && [ "$TASKDAG_RECON_READY" = false ]
); then
  ok "actual consumer calls replace exhausted state and clear candidates on hard error"
else
  bad "actual consumer calls leaked exhausted, retrying, or reconciliation state"
fi

SOURCE=$(cd "$(dirname "$TD")/.." && pwd)/scripts/task-dag
if ! sed -n '/^reap_leaf_claim()/,/^}/p; /^cmd_breakdown()/,/^}/p; /^cmd_complete_batch()/,/^}/p; /^cmd_show()/,/^}/p; /^cmd_context()/,/^}/p; /^owned_unresolved_active_claims()/,/^}/p' "$SOURCE" \
  | grep -Eq 'is_task_completed|get_dep_parents'; then
  ok "live consumer census contains no duplicate parent/witness decisions"
else bad "live consumer census found a duplicate legacy semantic decision"; fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
