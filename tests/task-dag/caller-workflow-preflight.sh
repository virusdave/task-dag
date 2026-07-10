#!/usr/bin/env bash
# Fixture checks for scripts/validate-caller-workflow.sh. This is a read-only
# rollout preflight: it parses workflow YAML with a real YAML parser and fails
# closed on missing events, permissions, secrets, backstops, graph convergence,
# or reusable-workflow source drift.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VALIDATE="$ROOT/scripts/validate-caller-workflow.sh"
SELF_CALLER="$ROOT/.github/workflows/task-dag.yml"
REUSABLE="$ROOT/.github/workflows/sync-comment-to-task.yml"
COMMENT_SHIM="$ROOT/scripts/sync-comment-to-tasks.sh"
DOCS="$ROOT/docs/MIGRATION.md"

if ! command -v ruby >/dev/null 2>&1; then
    if command -v nix-shell >/dev/null 2>&1; then
        cmd=$(printf '%q ' "$0" "$@")
        exec nix-shell -p ruby --run "$cmd"
    fi
    echo "ruby is required to parse workflow YAML (or install nix-shell for the ruby fallback)" >&2
    exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

if bash "$VALIDATE" --require-materialise --require-comment-sync-app "$SELF_CALLER" >/dev/null 2>&1; then
    ok "1: self-hosting caller satisfies the full required contract"
else
    bad "1: self-hosting caller failed validation"
fi

awk '
    /^```yaml$/ { in_yaml=1; next }
    /^```$/ && in_yaml { exit }
    in_yaml { print }
' "$DOCS" > "$TMP/docs-template.yml"
if bash "$VALIDATE" --require-materialise "$TMP/docs-template.yml" >/dev/null 2>&1; then
    ok "2: docs/MIGRATION.md caller template satisfies rollout contract"
else
    bad "2: docs/MIGRATION.md caller template failed validation"
fi

awk '
    /^  graph-converge:/ { skip=1; next }
    /^  completion-aggregate:/ { skip=0 }
    !skip { print }
' "$SELF_CALLER" > "$TMP/no-graph.yml"
if bash "$VALIDATE" --require-materialise --require-comment-sync-app "$TMP/no-graph.yml" >/dev/null 2>&1; then
    bad "3: caller without graph-converge unexpectedly passed"
else
    ok "3: missing graph-converge is rejected"
fi

sed '/app_private_key:.*TASK_DAG_APP_PRIVATE_KEY/d' "$SELF_CALLER" > "$TMP/missing-app-key.yml"
if bash "$VALIDATE" --require-materialise --require-comment-sync-app "$TMP/missing-app-key.yml" >/dev/null 2>&1; then
    bad "4: caller with partial/missing App secret unexpectedly passed"
else
    ok "4: missing paired App secret is rejected"
fi

sed 's#virusdave/task-dag/.github/workflows/graph-converge.yml@master#./.github/workflows/graph-converge.yml#' \
    "$SELF_CALLER" > "$TMP/local-cli-source.yml"
if bash "$VALIDATE" --require-materialise --require-comment-sync-app "$TMP/local-cli-source.yml" >/dev/null 2>&1; then
    bad "5: caller using a non-canonical workflow source unexpectedly passed"
else
    ok "5: non-canonical reusable workflow source is rejected"
fi

sed '/^[[:space:]]*ref: master$/s/master/task-dag-v1/' "$SELF_CALLER" > "$TMP/mismatched-runtime-ref.yml"
if bash "$VALIDATE" --require-materialise --require-comment-sync-app "$TMP/mismatched-runtime-ref.yml" >/dev/null 2>&1; then
    bad "6: caller with a mismatched comment runtime ref unexpectedly passed"
else
    ok "6: comment runtime ref must match the reusable workflow ref"
fi

if ruby -ryaml - "$REUSABLE" <<'RUBY'
path = ARGV.fetch(0)
workflow = YAML.load_file(path)
jobs = workflow.fetch('jobs')
job = jobs.fetch('sync-comment-to-task')
steps = job.fetch('steps')
named = steps.to_h { |step| [step['name'], step] }

caller = named.fetch('Checkout repository')
raise 'caller checkout action drifted' unless caller['uses'] == 'actions/checkout@v4'
raise 'caller checkout lost full history' unless caller.dig('with', 'fetch-depth') == 0
expected_token = '${{ steps.mint.outputs.token || secrets.token }}'
raise 'caller checkout lost App-token fallback semantics' unless caller.dig('with', 'token') == expected_token

runtime = named.fetch('Checkout coherent task-dag runtime')
raise 'runtime checkout action drifted' unless runtime['uses'] == 'actions/checkout@v4'
expected_runtime = {
  'repository' => 'virusdave/task-dag',
  'ref' => '${{ inputs.ref }}',
  'path' => '.task-dag-runtime',
  'fetch-depth' => 1,
  'persist-credentials' => false
}
raise 'runtime checkout is not one coherent non-credentialed revision' unless runtime['with'] == expected_runtime

sync = named.fetch('Sync comment to task-dag')
raise 'sync does not run explicitly in caller repository' unless sync['working-directory'] == '${{ github.workspace }}'
raise 'sync does not use checked-out helper' unless sync['run'].to_s.strip == '.task-dag-runtime/scripts/sync-comment-to-tasks.sh'
raise 'raw-file download remains in reusable workflow' if steps.any? { |step| step['run'].to_s.match?(/curl|raw\.githubusercontent\.com/) }

raise 'workflow permissions drifted' unless workflow['permissions'] == { 'contents' => 'write', 'issues' => 'write' }
raise 'App token mint action drifted' unless named.fetch('Mint App installation token (opt-in)')['uses'] == 'actions/create-github-app-token@v1'
RUBY
then
    ok "7: reusable workflow uses one coherent runtime checkout and preserves credentials"
else
    bad "7: reusable workflow runtime checkout contract failed"
fi

# Exercise the helper against a fake sibling CLI from a separate caller repo.
# This proves that the checked-out helper delegates without network access and
# keeps every field from one event observation intact.
mkdir -p "$TMP/runtime/scripts" "$TMP/caller" "$TMP/output" "$TMP/bin"
cp "$COMMENT_SHIM" "$TMP/runtime/scripts/sync-comment-to-tasks.sh"
cat > "$TMP/runtime/scripts/task-dag" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s' "$PWD" > "$OUTPUT_DIR/cwd"
printf '%s\0' "$@" > "$OUTPUT_DIR/args"
while [ "$#" -gt 0 ]; do
    if [ "$1" = --body-file ]; then
        cp "$2" "$OUTPUT_DIR/body"
        exit 0
    fi
    shift
done
echo "missing --body-file" >&2
exit 2
EOF
chmod +x "$TMP/runtime/scripts/task-dag"
cat > "$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo called > "$OUTPUT_DIR/curl-called"
exit 99
EOF
chmod +x "$TMP/bin/curl"
git -C "$TMP/caller" init -q
printf 'line one\nline two\n' > "$TMP/expected-body"
COMMENT_BODY="$(cat "$TMP/expected-body"; printf x)"
COMMENT_BODY="${COMMENT_BODY%x}"
export COMMENT_BODY
if (
    cd "$TMP/caller" || exit 1
    OUTPUT_DIR="$TMP/output" PATH="$TMP/bin:$PATH" \
      GITHUB_TOKEN=test ISSUE_NUMBER=42 COMMENT_ID=99 \
      COMMENT_URL=https://example.test/comment/99 COMMENT_AUTHOR=alice \
      COMMENT_CREATED_AT=2026-07-10T01:02:03Z \
      COMMENT_UPDATED_AT=2026-07-10T04:05:06Z \
      "$TMP/runtime/scripts/sync-comment-to-tasks.sh"
) >/dev/null 2>&1; then
    mapfile -d '' -t args < "$TMP/output/args"
    expected=(ingest-comment --issue 42 --comment-id 99 --author alice \
      --comment-url https://example.test/comment/99 \
      --created-at 2026-07-10T01:02:03Z \
      --updated-at 2026-07-10T04:05:06Z)
    if [ "${args[*]:0:${#expected[@]}}" = "${expected[*]}" ] \
      && [ "${args[${#args[@]}-2]}" = --body-file ] \
      && [ "$(cat "$TMP/output/cwd")" = "$TMP/caller" ] \
      && cmp -s "$TMP/expected-body" "$TMP/output/body" \
      && [ ! -e "$TMP/output/curl-called" ]; then
        ok "8: shim preserves caller cwd and the complete event observation without network"
    else
        bad "8: shim changed cwd, arguments, body bytes, or attempted network access"
    fi
else
    bad "8: shim failed to invoke its fake sibling CLI"
fi
unset COMMENT_BODY

mkdir -p "$TMP/incomplete/scripts"
cp "$COMMENT_SHIM" "$TMP/incomplete/scripts/sync-comment-to-tasks.sh"
if (cd "$TMP/caller" && "$TMP/incomplete/scripts/sync-comment-to-tasks.sh") >"$TMP/missing.out" 2>&1; then
    bad "9: shim with a missing sibling CLI unexpectedly passed"
elif grep -q 'coherent task-dag checkout is incomplete' "$TMP/missing.out"; then
    ok "9: missing sibling CLI fails loudly without fallback"
else
    bad "9: missing sibling CLI failed without the actionable error"
fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
