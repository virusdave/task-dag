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
if grep -q '^| `resolve_sha` | `scripts/task-dag:91` |' "$REPO_ROOT/docs/task-dag-function-inventory.md" \
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
early=(semantic-migration.sh materialise.sh materialise-census-capture.sh materialise-producer.sh materialise-reconcile.sh activation.sh)
if [ "${direct[*]:0:${#early[@]}}" = "${early[*]}" ]; then
  ok "six explicit early loads retain their order"
else bad "early source order changed: ${direct[*]}"; fi
glob=("$REPO_ROOT"/scripts/task-dag.d/*.sh); expected=(); for f in "${glob[@]}"; do expected+=("${f##*/}"); done
tail=("${direct[@]:${#early[@]}}")
if [ "${tail[*]}" = "${expected[*]}" ] && [ "$(printf '%s\n' "${direct[@]}" | grep -cx activation.sh)" -eq 2 ]; then
  ok "late bytewise glob and current double-load are characterized"
else bad "late glob/double-load changed: ${tail[*]}"; fi

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
