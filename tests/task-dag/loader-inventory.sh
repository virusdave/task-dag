#!/usr/bin/env bash
# Wave-0 characterization: intentionally locks the pre-refactor loader shape.
set -uo pipefail
TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok(){ echo "PASS: $1"; PASS=$((PASS+1)); }
bad(){ echo "FAIL: $1"; FAIL=$((FAIL+1)); }
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

if python3 "$REPO_ROOT/scripts/task-dag-inventory.py" --check; then
  ok "committed provider/consumer inventory is current"
else bad "generated inventory is stale"; fi
if grep -Eq '^\| `resolve_sha` \| `scripts/task-dag.d/git-objects.sh:[0-9]+` \|' "$REPO_ROOT/docs/task-dag-function-inventory.md" \
  && grep -q '^| `TASKDAG_GRAPH_CONVERGE_CLI` |' "$REPO_ROOT/docs/task-dag-function-inventory.md" \
  && ! grep -Eq '^\| `(BEGIN|END|if)` \|' "$REPO_ROOT/docs/task-dag-function-inventory.md"; then
  ok "inventory distinguishes Bash providers from embedded-language blocks"
else bad "inventory contains false providers or omits known providers"; fi

# Xtrace observes executed source operations without adding production hooks.
trace="$ROOT/trace"
if (PS4='+${BASH_SOURCE}:${LINENO}: ' bash -x "$TD" --version) >"$ROOT/version" 2>"$trace" \
  && grep -qx 'task-dag v0.1.0' "$ROOT/version"; then
  ok "version output is stable under the characterized loader"
else bad "version invocation failed or output changed"; fi
mapfile -t direct < <(grep -F "+$TD:" "$trace" | sed -n 's/.* source .*\/task-dag.d\/\([^ ]*\.sh\)$/\1/p')
expected=(source-contract.sh json.sh cas-retry.sh git-objects.sh task-model.sh child-map.sh claim-model.sh ref-schema.sh repository-identity.sh github-origin.sh blocked-core.sh activation-fleet.sh activation.sh ci-chains.sh ci-repair.sh comment-watchdog.sh edges.sh facts.sh reconciliation-core.sh semantic-consumer.sh status-projection.sh cross-repo.sh edges-prune.sh edges-write.sh graph-converge.sh legacy-edges.sh mailbox.sh materialise-census-capture.sh materialise-intent.sh materialise-producer.sh materialise-reconcile.sh materialise.sh reconcile.sh semantic-migration.sh root-containment.sh)
if [ "${direct[*]}" = "${expected[*]}" ] \
  && [ "$(printf '%s\n' "${direct[@]}" | LC_ALL=C sort -u | wc -l)" -eq "${#expected[@]}" ]; then
  ok "explicit bottom manifest loads every module exactly once in canonical order"
else bad "explicit module manifest changed: ${direct[*]}"; fi

if bash -c 'source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/source-contract.sh" >"$ROOT/standalone-out" 2>"$ROOT/standalone-err"; then
  bad "source contract accepted a standalone/out-of-order import"
elif grep -q 'must be loaded by the task-dag entrypoint' "$ROOT/standalone-err"; then
  ok "source contract fails loudly outside the canonical entrypoint"
else bad "source contract standalone failure was not actionable"; fi

cat >"$ROOT/wrapper" <<'EOF'
#!/usr/bin/env bash
source "$1"
exit $?
EOF
if bash "$ROOT/wrapper" "$REPO_ROOT/scripts/task-dag.d/source-contract.sh" >"$ROOT/wrapper-out" 2>"$ROOT/wrapper-err"; then
  bad "source contract accepted a non-entrypoint wrapper"
elif grep -q 'must be loaded by the task-dag entrypoint' "$ROOT/wrapper-err"; then
  ok "source contract rejects a forged wrapper caller"
else bad "source contract wrapper failure was not actionable"; fi

if bash "$REPO_ROOT/scripts/task-dag.d/source-contract.sh" >"$ROOT/executed-out" 2>"$ROOT/executed-err"; then
  bad "source contract executed directly"
elif grep -q 'must be loaded by the task-dag entrypoint' "$ROOT/executed-err"; then
  ok "source contract direct execution fails loudly"
else bad "source contract direct-execution failure was not actionable"; fi

if bash -c 'source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/json.sh" >"$ROOT/json-order-out" 2>"$ROOT/json-order-err"; then
  bad "JSON foundation loaded without its source-contract prerequisite"
elif grep -q 'requires source-contract.sh to be loaded first' "$ROOT/json-order-err"; then
  ok "JSON foundation fails loudly when loaded out of order"
else bad "JSON foundation source-order failure was not actionable"; fi

cat >"$ROOT/json-wrapper" <<EOF
#!/usr/bin/env bash
TASKDAG_SCRIPT_DIR='$REPO_ROOT/scripts'
TASKDAG_ENTRYPOINT='$REPO_ROOT/scripts/task-dag'
source '$REPO_ROOT/scripts/task-dag.d/json.sh'
EOF
if bash "$ROOT/json-wrapper" >"$ROOT/json-wrapper-out" 2>"$ROOT/json-wrapper-err"; then
  bad "JSON foundation accepted a non-entrypoint wrapper"
elif grep -q 'must be loaded by the task-dag entrypoint' "$ROOT/json-wrapper-err"; then
  ok "JSON foundation rejects a forged wrapper caller"
else bad "JSON foundation wrapper failure was not actionable"; fi

if bash -c 'source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/git-objects.sh" >"$ROOT/git-order-out" 2>"$ROOT/git-order-err"; then
  bad "Git-object foundation loaded without its source-contract prerequisite"
elif grep -q 'requires source-contract.sh to be loaded first' "$ROOT/git-order-err"; then
  ok "Git-object foundation fails loudly when loaded out of order"
else bad "Git-object foundation source-order failure was not actionable"; fi

if EMPTY_TREE=fixture bash -c 'source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/task-model.sh" >"$ROOT/model-order-out" 2>"$ROOT/model-order-err"; then
  bad "task model loaded without its Git-object prerequisites"
elif grep -q 'requires git-objects.sh to be loaded first' "$ROOT/model-order-err"; then
  ok "task model fails loudly when loaded out of order"
else bad "task-model source-order failure was not actionable"; fi

if bash -c 'source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/child-map.sh" >"$ROOT/child-map-order-out" 2>"$ROOT/child-map-order-err"; then
  bad "child map loaded without its source-contract prerequisite"
elif grep -q 'requires source-contract.sh to be loaded first' "$ROOT/child-map-order-err"; then
  ok "child map fails loudly without its source-contract prerequisite"
else bad "child-map source-order failure was not actionable"; fi

if bash -c 'source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/claim-model.sh" >"$ROOT/claim-order-out" 2>"$ROOT/claim-order-err"; then
  bad "claim model loaded without its Git-object prerequisite"
elif grep -q 'requires git-objects.sh to be loaded first' "$ROOT/claim-order-err"; then
  ok "claim model fails loudly without Git-object primitives"
else bad "claim-model source-order failure was not actionable"; fi

if bash -c 'task_is_root_shaped_epic(){ :; }; source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/ref-schema.sh" >"$ROOT/ref-json-out" 2>"$ROOT/ref-json-err"; then
  bad "ref schema loaded without its JSON prerequisite"
elif grep -q 'requires json.sh to be loaded first' "$ROOT/ref-json-err"; then
  ok "ref schema fails loudly without its JSON prerequisite"
else bad "ref-schema JSON source-order failure was not actionable"; fi

if bash -c 'json_escape(){ :; }; source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/ref-schema.sh" >"$ROOT/ref-model-out" 2>"$ROOT/ref-model-err"; then
  bad "ref schema loaded without its task-model prerequisite"
elif grep -q 'requires task-model.sh to be loaded first' "$ROOT/ref-model-err"; then
  ok "ref schema fails loudly without its task-model prerequisite"
else bad "ref-schema task-model source-order failure was not actionable"; fi

if bash -c 'source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/edges.sh" >"$ROOT/identity-order-out" 2>"$ROOT/identity-order-err"; then
  bad "edges loaded without its repository-identity prerequisite"
elif grep -q 'requires repository-identity.sh to be loaded first' "$ROOT/identity-order-err"; then
  ok "feature modules fail loudly without their repository-identity prerequisite"
else bad "repository-identity source-order failure was not actionable"; fi

if bash -c 'source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/github-origin.sh" >"$ROOT/origin-order-out" 2>"$ROOT/origin-order-err"; then
  bad "GitHub/origin foundation loaded without Git-object primitives"
elif grep -q 'requires git-objects.sh to be loaded first' "$ROOT/origin-order-err"; then
  ok "GitHub/origin foundation fails loudly without Git-object primitives"
else bad "GitHub/origin Git-object source-order failure was not actionable"; fi

if bash -c 'parse_commit_metadata(){ :; }; extract_field(){ :; }; source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/github-origin.sh" >"$ROOT/origin-repo-order-out" 2>"$ROOT/origin-repo-order-err"; then
  bad "GitHub/origin foundation loaded without repository identity"
elif grep -q 'requires repository-identity.sh to be loaded first' "$ROOT/origin-repo-order-err"; then
  ok "GitHub/origin foundation fails loudly without repository identity"
else bad "GitHub/origin repository source-order failure was not actionable"; fi

if bash -c 'parse_commit_metadata(){ :; }; extract_field(){ :; }; taskdag_current_repo(){ :; }; source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/github-origin.sh" >"$ROOT/origin-map-order-out" 2>"$ROOT/origin-map-order-err"; then
  bad "GitHub/origin foundation loaded without child-map primitives"
elif grep -q 'requires child-map.sh to be loaded first' "$ROOT/origin-map-order-err"; then
  ok "GitHub/origin foundation fails loudly without child-map primitives"
else bad "GitHub/origin child-map source-order failure was not actionable"; fi

if bash -c 'source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/blocked-core.sh" >"$ROOT/blocked-order-out" 2>"$ROOT/blocked-order-err"; then
  bad "blocked core loaded without Git-object primitives"
elif grep -q 'requires git-objects.sh to be loaded first' "$ROOT/blocked-order-err"; then
  ok "blocked core fails loudly without Git-object primitives"
else bad "blocked-core Git-object source-order failure was not actionable"; fi

if bash -c 'get_first_parent(){ :; }; is_task_commit(){ :; }; get_task_title(){ :; }; source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/blocked-core.sh" >"$ROOT/blocked-origin-out" 2>"$ROOT/blocked-origin-err"; then
  bad "blocked core loaded without GitHub/origin prerequisite"
elif grep -q 'requires github-origin.sh to be loaded first' "$ROOT/blocked-origin-err"; then
  ok "blocked core fails loudly without GitHub/origin prerequisite"
else bad "blocked-core GitHub/origin source-order failure was not actionable"; fi

if bash -c 'source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/cross-repo.sh" >"$ROOT/cross-order-out" 2>"$ROOT/cross-order-err"; then
  bad "cross-repo loaded without its GitHub/origin prerequisite"
elif grep -q 'requires github-origin.sh to be loaded first' "$ROOT/cross-order-err"; then
  ok "feature consumers fail loudly without their GitHub/origin prerequisite"
else bad "GitHub/origin consumer source-order failure was not actionable"; fi

if bash -c 'remote_ref_sha_checked(){ :; }; source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/cross-repo.sh" >"$ROOT/cross-blocked-out" 2>"$ROOT/cross-blocked-err"; then
  bad "cross-repo loaded without blocked core"
elif grep -q 'requires blocked-core.sh to be loaded first' "$ROOT/cross-blocked-err"; then
  ok "feature consumers fail loudly without blocked core"
else bad "blocked-core consumer source-order failure was not actionable"; fi

if bash -c 'remote_ref_sha_checked(){ :; }; is_task_blocked(){ :; }; read_blocked_meta_field(){ :; }; source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/cross-repo.sh" >"$ROOT/cross-claim-out" 2>"$ROOT/cross-claim-err"; then
  bad "cross-repo loaded without claim model"
elif grep -q 'requires claim-model.sh to be loaded first' "$ROOT/cross-claim-err"; then
  ok "feature consumers fail loudly without claim model"
else bad "claim-model consumer source-order failure was not actionable"; fi

if bash -c 'source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/ci-repair.sh" >"$ROOT/repair-claim-out" 2>"$ROOT/repair-claim-err"; then
  bad "CI repair loaded without claim model"
elif grep -q 'requires claim-model.sh to be loaded first' "$ROOT/repair-claim-err"; then
  ok "CI repair fails loudly without claim model"
else bad "CI repair claim-model source-order failure was not actionable"; fi

if bash -c 'source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/reconciliation-core.sh" >"$ROOT/recon-core-out" 2>"$ROOT/recon-core-err"; then
  bad "reconciliation core loaded without child-map primitives"
elif grep -q 'requires child-map.sh to be loaded first' "$ROOT/recon-core-err"; then
  ok "reconciliation core fails loudly without its first prerequisite"
else bad "reconciliation-core source-order failure was not actionable"; fi

if rg -n 'edges-write|cmd_' "$REPO_ROOT/scripts/task-dag.d/reconciliation-core.sh" >"$ROOT/recon-core-cycles"; then
  bad "reconciliation core depends on a writer or command adapter: $(cat "$ROOT/recon-core-cycles")"
else ok "reconciliation core is independent of edge writers and command adapters"; fi

recon_core_prereqs='taskdag_prepare_child_map_from taskdag_prepare_child_map taskdag_reset_child_map taskdag_normalize_node taskdag_edges_with_facts taskdag_node_done taskdag_load_facts taskdag_current_repo taskdag_sync_root_refs is_task_commit is_task_blocked blocked_structural_ancestor'
if bash -c 'for n in $2; do eval "$n(){ :; }"; done; source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/reconciliation-core.sh" "$recon_core_prereqs" >/dev/null 2>"$ROOT/recon-core-complete-err"; then
  ok "reconciliation core accepts its complete prerequisite set"
else bad "reconciliation core rejected its complete prerequisite set: $(cat "$ROOT/recon-core-complete-err")"; fi

consumer_prereqs='taskdag_activation_validate_history _taskdag_activation_fetch_authority _taskdag_activation_authority_token _taskdag_activation_runtime_commit taskdag_cas_sleep taskdag_capture_child_map_refs taskdag_reset_child_map taskdag_recon_prepare taskdag_sha256_hex'
if bash -c 'for n in $2; do eval "$n(){ :; }"; done; source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/semantic-consumer.sh" "$consumer_prereqs" >/dev/null 2>"$ROOT/consumer-complete-err"; then
  ok "semantic consumer accepts its complete prerequisite set"
else bad "semantic consumer rejected its complete prerequisite set: $(cat "$ROOT/consumer-complete-err")"; fi

projection_prereqs='taskdag_task_completed_at_tip taskdag_normalize_node is_task_blocked blocked_structural_ancestor taskdag_node_complete taskdag_recon_resolve_task_node taskdag_consumer_require_prepared get_dep_parents task_has_children is_human_comment_task'
if bash -c 'for n in $2; do [ "$n" = taskdag_task_completed_at_tip ] || eval "$n(){ :; }"; done; source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/status-projection.sh" "$projection_prereqs" >"$ROOT/projection-order-out" 2>"$ROOT/projection-order-err"; then
  bad "status projection loaded without facts provider"
elif grep -q 'requires facts.sh provider taskdag_task_completed_at_tip' "$ROOT/projection-order-err"; then
  ok "status projection fails loudly without a prerequisite"
else bad "status projection prerequisite failure was not actionable"; fi

if bash -c 'for n in $2; do eval "$n(){ :; }"; done; source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/status-projection.sh" "$projection_prereqs" >/dev/null 2>"$ROOT/projection-complete-err"; then
  ok "status projection accepts its complete prerequisite set"
else bad "status projection rejected its complete prerequisite set: $(cat "$ROOT/projection-complete-err")"; fi

if bash -c 'taskdag_node_complete(){ :; }; taskdag_leaf_ready(){ :; }; taskdag_normalize_node(){ :; }; source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/reconcile.sh" >"$ROOT/reconcile-core-out" 2>"$ROOT/reconcile-core-err"; then
  bad "reconcile loaded without reconciliation preparation"
elif grep -q 'requires reconciliation-core.sh to be loaded first' "$ROOT/reconcile-core-err"; then
  ok "reconcile fails loudly without an actual command prerequisite"
else bad "reconcile prerequisite failure was not actionable"; fi

if bash -c 'remote_ref_sha_checked(){ :; }; is_task_blocked(){ :; }; read_blocked_meta_field(){ :; }; claim_is_dead(){ :; }; source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/cross-repo.sh" >"$ROOT/cross-consumer-out" 2>"$ROOT/cross-consumer-err"; then
  bad "early production consumer loaded without semantic consumer"
elif grep -q 'requires semantic-consumer.sh to be loaded first' "$ROOT/cross-consumer-err"; then
  ok "early production consumer fails loudly without semantic consumer"
else bad "early production semantic-consumer failure was not actionable"; fi

if bash -c 'taskdag_node_repo(){ :; }; source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/graph-converge.sh" >"$ROOT/converge-core-out" 2>"$ROOT/converge-core-err"; then
  bad "graph convergence loaded without reconciliation core"
elif grep -q 'requires reconciliation-core.sh to be loaded first' "$ROOT/converge-core-err"; then
  ok "graph convergence fails loudly without reconciliation core"
else bad "graph convergence source-order failure was not actionable"; fi

root_prereqs='taskdag_prepare_child_map taskdag_sync_root_refs taskdag_recon_prepare taskdag_current_repo taskdag_node_complete taskdag_issue_closed_at_tip get_first_parent is_task_commit pending_sha_on_remote_checked task_is_root_shaped_epic fetch_task_refs_strict taskdag_consumer_prepare taskdag_root_status_json taskdag_migration_guard taskdag_materialisation_intents_durable'
if bash -c 'for n in $2; do eval "$n(){ :; }"; done; source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/root-containment.sh" "$root_prereqs" >"$ROOT/root-order-out" 2>"$ROOT/root-order-err"; then
  bad "root containment loaded without Git-object metadata providers"
elif grep -q 'requires provider for parse_commit_metadata' "$ROOT/root-order-err"; then
  ok "root containment fails loudly without Git-object metadata providers"
else bad "root-containment source-order failure was not actionable"; fi

if bash -c 'for n in parse_commit_metadata extract_field $2; do eval "$n(){ :; }"; done; source "$1"' _ "$REPO_ROOT/scripts/task-dag.d/root-containment.sh" "$root_prereqs" >/dev/null 2>"$ROOT/root-complete-err"; then
  ok "root containment accepts its complete prerequisite set"
else bad "root containment rejected its complete prerequisite set: $(cat "$ROOT/root-complete-err")"; fi

# Source from an unrelated peer CWD. The loaded graph module must capture the
# canonical absolute CLI; exercise the exact helper-generation/subprocess path
# with a recorder replacing only the final CLI process.
mkdir "$ROOT/peer"; cat >"$ROOT/probe.sh" <<'EOF'
set -- --version
source "$TD" >/dev/null
printf '%s\n' "$TASKDAG_GRAPH_CONVERGE_CLI" >"$ROOT/captured"
TASKDAG_GRAPH_CONVERGE_CLI="$ROOT/recorder"
taskdag_migration_guard(){ return 0; }
taskdag_read_edges(){ printf '[]\n'; }
cmd_mailbox(){
  local helper=""; while [ $# -gt 0 ]; do [ "$1" = --fold-cmd ] && { helper=$2; break; }; shift; done
  TASKDAG_MAILBOX_NODE=n TASKDAG_MAILBOX_WITNESS=w TASKDAG_MAILBOX_MESSAGE_ID=m "$helper"
}
cmd_reconcile_backstop --no-fetch
EOF
cat >"$ROOT/recorder" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$PWD" >"$ROOT/subprocess-cwd"
printf '%s\n' "$*" >"$ROOT/subprocess-args"
EOF
chmod +x "$ROOT/recorder"
(cd "$ROOT/peer" && TD="$TD" ROOT="$ROOT" bash "$ROOT/probe.sh")
if [ "$(cat "$ROOT/captured")" = "$TD" ] && [ "$(cat "$ROOT/subprocess-cwd")" = "$ROOT/peer" ] \
  && grep -qx 'propagate-completion --node n --witness w --mailbox-message-id m --no-fetch' "$ROOT/subprocess-args"; then
  ok "absolute peer-CWD invocation is preserved through graph-converge helper subprocess"
else bad "peer/subprocess path characterization failed"; fi

# Collect cold starts as diagnostics, asserting only shape/non-negativity—not
# a machine-dependent latency threshold. EPOCHREALTIME is a bash builtin.
times=()
for _ in 1 2 3; do
  start=$EPOCHREALTIME; "$TD" --version >/dev/null
  times+=("$(awk -v a="$start" -v b="$EPOCHREALTIME" 'BEGIN { printf "%.6f", b-a }')")
done
if [ "${#times[@]}" -eq 3 ] && printf '%s\n' "${times[@]}" | awk '/^[0-9]+\.[0-9]{6}$/ && $0>=0 {n++} END{exit n!=3}'; then
  printf 'cold-start-seconds: %s\n' "${times[*]}"
  ok "cold-start timing samples collected without a flaky threshold"
else bad "invalid cold-start samples: ${times[*]}"; fi

echo "loader-inventory: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
