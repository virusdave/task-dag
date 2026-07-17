#!/usr/bin/env bash
set -uo pipefail
TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok() { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
REPO_ROOT="$(cd "$(dirname "$TD")/.." && pwd)"

status="$($TD migration-status --json 2>/dev/null)"
if jq -e '.schema == 1 and .mode == "draining-legacy-writers" and .recognizedReadSchemas == ["legacy"] and .authorizedSemantics == ["legacy-read-only"]' <<<"$status" >/dev/null; then ok "strict status JSON"; else bad "strict status JSON"; fi

printf '<!-- task-dag:completion --> Satisfies virusdave/task-dag#1 via peer/repo@abcdef1' >"$ROOT/completion-body"
for spec in "close-epic --issue 1" "close-ops-epic --issue 1 --yes" "close-completed-epic --issue 1 --reason evidence --yes" "delegate --issue 1 --to peer/repo#2" "reconcile-closed-issue 1 --yes" "ingest-comment --issue 1 --comment-id 1 --author bot --comment-url https://example.test/1 --created-at 2026-07-17T00:00:00Z --updated-at 2026-07-17T00:00:00Z --body-file $ROOT/completion-body" "propagate-completion --node issue:virusdave/task-dag#1 --witness aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "reconcile-backstop --no-fetch" "graph-converge --no-fetch"; do
    read -r -a args <<<"$spec"
    out="$($TD "${args[@]}" 2>&1)"; rc=$?
    if [ "$rc" -eq 75 ] && grep -q '^MIGRATION REQUIRED$' <<<"$out" && grep -q '^mode: draining-legacy-writers$' <<<"$out"; then ok "${args[0]} drains before effects"; else bad "${args[0]} rc=$rc: $out"; fi
done

for spec in \
  "close-epic --issue nope" \
  "delegate --issue nope --to bad" \
  "reconcile-closed-issue 1 --hint-sha=bad" \
  "propagate-completion --node x --witness y" \
  "graph-converge --notify-peer bad"; do
    read -r -a args <<<"$spec"
    "$TD" "${args[@]}" >/dev/null 2>&1; rc=$?
    [ "$rc" -eq 2 ] && ok "${args[0]} validates malformed arguments before drain" \
      || bad "${args[0]} malformed arguments returned rc=$rc"
done

mkdir -p "$ROOT/bin"
for command in git gh curl; do
    cat > "$ROOT/bin/$command" <<'EOF'
#!/usr/bin/env bash
echo "$0 $*" >> "$EFFECT_LOG"
exit 99
EOF
    chmod +x "$ROOT/bin/$command"
done
export EFFECT_LOG="$ROOT/effects"
for spec in \
  "$REPO_ROOT/scripts/aggregate-cross-repo-completions.sh" \
  "$REPO_ROOT/.github/scripts/materialise-child-epics.sh" \
  "$REPO_ROOT/.github/scripts/close-completed-issues.sh" \
  "$REPO_ROOT/.github/scripts/cleanup-closed-issue-task-refs.sh 1"; do
    read -r -a args <<<"$spec"
    out="$(PATH="$ROOT/bin:$PATH" "${args[@]}" 2>&1)"; rc=$?
    if [ "$rc" -eq 75 ] && grep -q '^MIGRATION REQUIRED$' <<<"$out"; then
        ok "$(basename "${args[0]}") drains before effects"
    else
        bad "$(basename "${args[0]}") rc=$rc: $out"
    fi
done
out="$(_XREPO_PREPARE_COMPLETION=true PATH="$ROOT/bin:$PATH" "$TD" ingest-completion \
  --issue 1 --comment-id 1 --comment-url https://example.test/1 \
  --from peer/repo@abcdef1 2>&1)"; rc=$?
if [ "$rc" -eq 75 ] && grep -q '^MIGRATION REQUIRED$' <<<"$out"; then
  ok "exported internal completion sentinel cannot bypass the drain"
else
  bad "exported internal completion sentinel returned rc=$rc: $out"
fi
[ ! -e "$EFFECT_LOG" ] && ok "drained direct writers made no git/GitHub/network calls" || bad "drained writers called: $(cat "$EFFECT_LOG")"

for script in \
  "$REPO_ROOT/scripts/aggregate-cross-repo-completions.sh" \
  "$REPO_ROOT/.github/scripts/materialise-child-epics.sh" \
  "$REPO_ROOT/.github/scripts/close-completed-issues.sh"; do
    "$script" unexpected >/dev/null 2>&1; rc=$?
    [ "$rc" -eq 2 ] && ok "$(basename "$script") validates arguments before drain" \
      || bad "$(basename "$script") unexpected argument returned rc=$rc"
done
"$REPO_ROOT/.github/scripts/cleanup-closed-issue-task-refs.sh" 1 bad >/dev/null 2>&1; rc=$?
[ "$rc" -eq 2 ] && ok "cleanup validates hint SHAs before drain" || bad "cleanup bad hint returned rc=$rc"

set +u
source "$REPO_ROOT/scripts/task-dag.d/semantic-migration.sh"
taskdag_migration_guard misspelled >/dev/null 2>&1; rc=$?
set -u
[ "$rc" -ne 0 ] && [ "$rc" -ne 75 ] && ok "unknown writer class fails closed" || bad "unknown writer class returned rc=$rc"

mkdir -p "$ROOT/mixed/.github/scripts"
cp "$REPO_ROOT/.github/scripts/close-completed-issues.sh" "$ROOT/mixed/.github/scripts/"
cp "$REPO_ROOT/scripts/task-dag.d/semantic-migration.sh" "$ROOT/mixed/.github/scripts/semantic-migration.sh"
bash "$ROOT/mixed/.github/scripts/close-completed-issues.sh" >/dev/null 2>&1; rc=$?
[ "$rc" -ne 0 ] && [ "$rc" -ne 75 ] && ok "standalone projection refuses a sibling mixed-runtime guard" \
  || bad "standalone projection accepted mixed-runtime guard rc=$rc"

cat >"$ROOT/evil-intent.sh" <<EOF
printf effect >'$ROOT/materialise-override-effect'
EOF
MATERIALISE_INTENT_LIB="$ROOT/evil-intent.sh" \
  bash "$REPO_ROOT/.github/scripts/materialise-child-epics.sh" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 75 ] && [ ! -e "$ROOT/materialise-override-effect" ] \
  && ok "materialisation drains before an intent-parser override can execute" \
  || bad "materialisation override ran before drain or returned rc=$rc"
MATERIALISE_LIB_ONLY=1 MATERIALISE_INTENT_LIB="$ROOT/evil-intent.sh" \
  bash "$REPO_ROOT/.github/scripts/materialise-child-epics.sh" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 75 ] && [ ! -e "$ROOT/materialise-override-effect" ] \
  && ok "executed materialisation cannot use library-mode env to bypass drain" \
  || bad "materialisation library-mode env bypassed drain or returned rc=$rc"

mkdir "$ROOT/offline-comment-repo" "$ROOT/offline-bin"
git -C "$ROOT/offline-comment-repo" init -q
git -C "$ROOT/offline-comment-repo" remote add origin https://github.com/virusdave/task-dag.git
cat >"$ROOT/offline-bin/gh" <<'EOF'
#!/usr/bin/env bash
echo called >"$GH_CALL_LOG"
exit 99
EOF
chmod +x "$ROOT/offline-bin/gh"
(
  cd "$ROOT/offline-comment-repo" || exit 1
  GH_CALL_LOG="$ROOT/gh-called" PATH="$ROOT/offline-bin:$PATH" \
    "$TD" ingest-comment --issue 1 --comment-id 1 --author bot \
      --comment-url https://example.test/1 \
      --created-at 2026-07-17T00:00:00Z --updated-at 2026-07-17T00:00:00Z \
      --body-file "$ROOT/completion-body" >/dev/null 2>&1
); rc=$?
[ "$rc" -eq 75 ] && [ ! -e "$ROOT/gh-called" ] \
  && ok "completion preclassification resolves origin without GitHub calls" \
  || bad "completion preclassification returned rc=$rc or called GitHub"

for spec in \
  "ingest-comment --issue nope --comment-id 1 --author bot --comment-url https://example.test/1 --created-at 2026-07-17T00:00:00Z --updated-at 2026-07-17T00:00:00Z --body-file $ROOT/completion-body" \
  "ingest-comment --issue 1 --comment-id nope --author bot --comment-url https://example.test/1 --created-at 2026-07-17T00:00:00Z --updated-at 2026-07-17T00:00:00Z --body-file $ROOT/completion-body" \
  "ingest-comment --issue 1 --comment-id 1 --author bot --comment-url https://example.test/1 --created-at bad --updated-at bad --body-file $ROOT/completion-body"; do
    read -r -a args <<<"$spec"
    "$TD" "${args[@]}" >/dev/null 2>&1; rc=$?
    [ "$rc" -eq 2 ] && ok "ingest-comment validates malformed observation before drain" \
      || bad "ingest-comment malformed observation returned rc=$rc"
done

mkdir "$ROOT/comment-repo"
git -C "$ROOT/comment-repo" init -q
git -C "$ROOT/comment-repo" config taskdag.current-repo virusdave/task-dag
out="$(
  cd "$ROOT/comment-repo" || exit 1
  GITHUB_TOKEN=test ISSUE_NUMBER=1 COMMENT_ID=1 \
    COMMENT_BODY="$(cat "$ROOT/completion-body")" \
    COMMENT_URL=https://example.test/1 COMMENT_AUTHOR=bot \
    COMMENT_CREATED_AT=2026-07-17T00:00:00Z \
    COMMENT_UPDATED_AT=2026-07-17T00:00:00Z \
    "$REPO_ROOT/scripts/sync-comment-to-tasks.sh" 2>&1
)"; rc=$?
if [ "$rc" -eq 75 ] && grep -q '^MIGRATION REQUIRED$' <<<"$out" \
  && [ -z "$(git -C "$ROOT/comment-repo" for-each-ref --format='%(refname)')" ] \
  && ! git -C "$ROOT/comment-repo" config --local --get user.name >/dev/null; then
    ok "sync-comment-to-tasks.sh drains completion before receipt/config effects"
else
    bad "sync-comment-to-tasks.sh completion drain rc=$rc: $out"
fi

for arg in -h --help; do
    "$(dirname "$TD")/aggregate-cross-repo-completions.sh" "$arg" >/dev/null 2>&1 && ok "aggregate $arg is effect-free" || bad "aggregate $arg"
    "$(dirname "$TD")/../.github/scripts/materialise-child-epics.sh" "$arg" >/dev/null 2>&1 && ok "materialise $arg is effect-free" || bad "materialise $arg"
    "$(dirname "$TD")/../.github/scripts/close-completed-issues.sh" "$arg" >/dev/null 2>&1 && ok "close projection $arg is effect-free" || bad "close projection $arg"
    "$(dirname "$TD")/../.github/scripts/cleanup-closed-issue-task-refs.sh" "$arg" >/dev/null 2>&1 && ok "cleanup projection $arg is effect-free" || bad "cleanup projection $arg"
    "$(dirname "$TD")/sync-comment-to-tasks.sh" "$arg" >/dev/null 2>&1 && ok "comment sync $arg is effect-free" || bad "comment sync $arg"
done

for workflow in aggregate-cross-repo-completions close-completed-issues graph-converge materialise-child-epic sync-comment-to-task; do
    wf="$REPO_ROOT/.github/workflows/$workflow.yml"
    if grep -Fq 'if [ "$rc" -eq 75 ]' "$wf" \
      && grep -Fq 'exit "$rc"' "$wf" \
      && ! grep -Fq 'migration-status' "$wf"; then
        ok "$workflow maps only exact drain status"
    else
        bad "$workflow does not preserve non-75 failures"
    fi
done
if ! grep -Eq 'raw\.githubusercontent\.com/.+close-completed-issues|raw\.githubusercontent\.com/.+cleanup-closed' "$REPO_ROOT/.github/workflows/close-completed-issues.yml" \
  && grep -q 'Checkout coherent task-dag runtime' "$REPO_ROOT/.github/workflows/close-completed-issues.yml"; then
    ok "close workflow uses one coherent immutable runtime"
else
    bad "close workflow mixes runtime revisions"
fi

cp -R "$(dirname "$TD")" "$ROOT/scripts"
rm "$ROOT/scripts/task-dag.d/semantic-migration-policy.json"
"$ROOT/scripts/task-dag" migration-status --json >/dev/null 2>&1
rc=$?
[ "$rc" -ne 0 ] && [ "$rc" -ne 75 ] && ok "missing policy fails closed" || bad "missing policy returned rc=$rc"
printf '{}\n' > "$ROOT/scripts/task-dag.d/semantic-migration-policy.json"
"$ROOT/scripts/task-dag" close-epic --issue 1 >/dev/null 2>&1
rc=$?
[ "$rc" -ne 0 ] && [ "$rc" -ne 75 ] && ok "malformed policy fails closed" || bad "malformed policy returned rc=$rc"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
