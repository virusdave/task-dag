#!/usr/bin/env bash
set -uo pipefail
TD=${1:-"$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag"}
TD=$(realpath "$TD")
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
pass=0 fail=0
ok() { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; fail=$((fail+1)); }
export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.test GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.test

runtime=$(git -C "$(dirname "$TD")/.." rev-parse HEAD)
for name in task-dag top-level; do git init -q --bare "$ROOT/$name.git"; done
git -C "$(dirname "$TD")/.." push -q "$ROOT/task-dag.git" "$runtime:refs/heads/master"
git init -q "$ROOT/top-source"; mkdir -p "$ROOT/top-source/scripts/ephemeral_checkout.d"
cat >"$ROOT/top-source/scripts/ephemeral_checkout.d/repos.conf" <<EOF
task-dag git@github-task-dag:virusdave/task-dag.git
top-level git@github-top-level:virusdave/top-level.git
EOF
git -C "$ROOT/top-source" add .; git -C "$ROOT/top-source" commit -qm registry
git -C "$ROOT/top-source" remote add origin "$ROOT/top-level.git"; git -C "$ROOT/top-source" push -q origin HEAD:master
git clone -q "$ROOT/top-level.git" "$ROOT/registry"

export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=url.file://$ROOT/task-dag.git.insteadOf GIT_CONFIG_VALUE_0=git@github-task-dag:virusdave/task-dag.git
export GIT_CONFIG_KEY_1=url.file://$ROOT/top-level.git.insteadOf GIT_CONFIG_VALUE_1=git@github-top-level:virusdave/top-level.git
mkdir "$ROOT/bin"
cat >"$ROOT/bin/gh" <<'EOF'
#!/usr/bin/env bash
case " $* " in
  *" --include "*) printf 'HTTP/2 200\r\ndate: Sat, 18 Jul 2026 12:00:00 GMT\r\n\r\n{}\n' ;;
  *" repos/virusdave/task-dag "*) printf '{"full_name":"virusdave/task-dag","node_id":"R_taskdag"}\n' ;;
  *" repos/virusdave/top-level "*) printf '{"full_name":"virusdave/top-level","node_id":"R_toplevel"}\n' ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$ROOT/bin/gh"; export PATH="$ROOT/bin:$PATH"
mkdir "$ROOT/fleet"
git clone -q "$ROOT/task-dag.git" "$ROOT/fleet/task-dag"; git -C "$ROOT/fleet/task-dag" remote set-url origin git@github-task-dag:virusdave/task-dag.git
git clone -q "$ROOT/top-level.git" "$ROOT/fleet/top-level"; git -C "$ROOT/fleet/top-level" remote set-url origin git@github-top-level:virusdave/top-level.git

if "$TD" activation fleet-plan --registry-checkout "$ROOT/registry" --work-root "$ROOT/fleet" --output "$ROOT/plan" --actor fixture >/dev/null \
  && jq -e '.schema==1 and .target.state=="enabled" and .target.authoritativeTimestamp=="2026-07-18T12:00:00Z" and (.target.registrySnapshot.repositories|length)==2 and (.target.sourceTips|length)==2 and all(.expected[];.state=="absent")' "$ROOT/plan" >/dev/null; then
  ok "fleet plan freezes registry, identities, tips, runtime, and server time"
else bad "fleet plan"; fi

status=$($TD activation fleet-status --spec-file "$ROOT/plan" --work-root "$ROOT/fleet")
[ "$(jq -r .overall <<<"$status")" = expected ] && ok "fresh fleet matches the frozen predecessor" || bad "fresh status: $status"

jq '.target.state="disabled"|.target' "$ROOT/plan" >"$ROOT/disabled"
(cd "$ROOT/fleet/task-dag" && "$TD" activation apply --spec-file "$ROOT/disabled" --expect-old absent >/dev/null) || bad "fixture partial disable"
status=$($TD activation fleet-status --spec-file "$ROOT/plan" --work-root "$ROOT/fleet")
[ "$(jq -r '.repositories[]|select(.repository=="virusdave/task-dag")|.phase' <<<"$status")" = intermediate ] && ok "partial disabled rollout is explicit and valid" || bad "partial status: $status"

if result=$($TD activation fleet-apply --spec-file "$ROOT/plan" --work-root "$ROOT/fleet") \
  && [ "$(jq -r .overall <<<"$result")" = enabled ]; then ok "retry converges disabled barrier then enables fleet"; else bad "fleet apply"; fi
task_tip=$(git --git-dir="$ROOT/task-dag.git" rev-parse refs/heads/tasks/v1/activation)
top_tip=$(git --git-dir="$ROOT/top-level.git" rev-parse refs/heads/tasks/v1/activation)
if "$TD" activation fleet-apply --spec-file "$ROOT/plan" --work-root "$ROOT/fleet" >/dev/null \
  && [ "$task_tip" = "$(git --git-dir="$ROOT/task-dag.git" rev-parse refs/heads/tasks/v1/activation)" ] \
  && [ "$top_tip" = "$(git --git-dir="$ROOT/top-level.git" rev-parse refs/heads/tasks/v1/activation)" ]; then
  ok "identical fleet retry is idempotent"
else bad "idempotent retry advanced authority"; fi

rm -f "$ROOT/rollback"
if "$TD" activation fleet-plan --registry-checkout "$ROOT/registry" --work-root "$ROOT/fleet" --output "$ROOT/rollback" --actor fixture --state disabled >/dev/null \
  && result=$($TD activation fleet-apply --spec-file "$ROOT/rollback" --work-root "$ROOT/fleet") \
  && [ "$(jq -r .overall <<<"$result")" = disabled ]; then ok "reviewed disabled plan rolls the whole fleet back safely"; else bad "disabled fleet apply"; fi
if "$TD" activation fleet-apply --spec-file "$ROOT/plan" --work-root "$ROOT/fleet" >/dev/null 2>&1; then bad "stale enable plan undid rollback"; else ok "rollback fences stale enable retries"; fi
git clone -q --mirror "$ROOT/task-dag.git" "$ROOT/substitute.git"
substitute_tip=$(git --git-dir="$ROOT/substitute.git" rev-parse refs/heads/tasks/v1/activation)
rm -f "$ROOT/reenable"
if "$TD" activation fleet-plan --registry-checkout "$ROOT/registry" --work-root "$ROOT/fleet" --output "$ROOT/reenable" --actor fixture >/dev/null \
  && result=$($TD activation fleet-apply --spec-file "$ROOT/reenable" --work-root "$ROOT/fleet") \
  && [ "$(jq -r .overall <<<"$result")" = enabled ]; then ok "fresh reviewed plan re-enables a disabled fleet"; else bad "fleet re-enable"; fi

jq '.target.actor="different"' "$ROOT/reenable" >"$ROOT/conflict"
if "$TD" activation fleet-status --spec-file "$ROOT/conflict" --work-root "$ROOT/fleet" >/dev/null 2>&1; then bad "conflicting provenance accepted"; else ok "conflicting frozen plan fails closed"; fi
mv "$ROOT/fleet/task-dag" "$ROOT/fleet/swap"; mv "$ROOT/fleet/top-level" "$ROOT/fleet/task-dag"; mv "$ROOT/fleet/swap" "$ROOT/fleet/top-level"
if "$TD" activation fleet-status --spec-file "$ROOT/reenable" --work-root "$ROOT/fleet" >/dev/null 2>&1; then bad "swapped checkout identities accepted"; else ok "swapped checkout identities fail closed"; fi
mv "$ROOT/fleet/task-dag" "$ROOT/fleet/swap"; mv "$ROOT/fleet/top-level" "$ROOT/fleet/task-dag"; mv "$ROOT/fleet/swap" "$ROOT/fleet/top-level"
git -C "$ROOT/fleet/task-dag" config url."file://$ROOT/substitute.git".insteadOf git@backup:virusdave/task-dag.git
git -C "$ROOT/fleet/task-dag" remote set-url origin git@backup:virusdave/task-dag.git
if "$TD" activation fleet-apply --spec-file "$ROOT/reenable" --work-root "$ROOT/fleet" >/dev/null 2>&1; then bad "substitute endpoint accepted"
elif [ "$substitute_tip" != "$(git --git-dir="$ROOT/substitute.git" rev-parse refs/heads/tasks/v1/activation)" ]; then bad "substitute endpoint was mutated"
else ok "same-path substitute endpoint fails closed without mutation"; fi
git -C "$ROOT/fleet/task-dag" remote set-url origin git@github-task-dag:virusdave/task-dag.git
ln -s "$ROOT/reenable" "$ROOT/plan-link"
if "$TD" activation fleet-apply --spec-file "$ROOT/plan-link" --work-root "$ROOT/fleet" >/dev/null 2>&1; then bad "symlink plan accepted"; else ok "fleet apply snapshots one regular plan file"; fi

echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
