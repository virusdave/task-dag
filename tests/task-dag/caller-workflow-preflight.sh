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
MATERIALISE_REUSABLE="$ROOT/.github/workflows/materialise-child-epic.yml"
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

if bash "$VALIDATE" --require-comment-sync-app "$SELF_CALLER" >/dev/null 2>&1; then
    ok "1: dormant self-hosting caller satisfies the pre-rollout contract"
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

cp "$TMP/docs-template.yml" "$TMP/missing-materialise-ref.yml"
sed -i '/^[[:space:]]*ref: 0123456789abcdef/d' "$TMP/missing-materialise-ref.yml"
if bash "$VALIDATE" --require-materialise --require-comment-sync-app "$TMP/missing-materialise-ref.yml" >/dev/null 2>&1; then
    bad "7: materialise caller without an exact runtime ref unexpectedly passed"
else
    ok "7: materialise caller must supply its authorized runtime commit"
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
sync_run = sync['run'].to_s
raise 'sync does not use checked-out helper' unless sync_run.include?('.task-dag-runtime/scripts/sync-comment-to-tasks.sh')
raise 'sync does not defer exact migration status 75' unless sync_run.include?('if [ "$rc" -eq 75 ]')
raise 'sync masks non-migration failures' unless sync_run.include?('exit "$rc"')
raise 'raw-file download remains in reusable workflow' if steps.any? { |step| step['run'].to_s.match?(/curl|raw\.githubusercontent\.com/) }

raise 'workflow permissions drifted' unless workflow['permissions'] == { 'contents' => 'write', 'issues' => 'write' }
raise 'App token mint action drifted' unless named.fetch('Mint App installation token (opt-in)')['uses'] == 'actions/create-github-app-token@v1'
RUBY
then
    ok "7: reusable workflow uses one coherent runtime checkout and preserves credentials"
else
    bad "7: reusable workflow runtime checkout contract failed"
fi

if ruby -ryaml - "$MATERIALISE_REUSABLE" <<'RUBY'
path = ARGV.fetch(0)
workflow = YAML.load_file(path)
job = workflow.fetch('jobs').fetch('materialise')
steps = job.fetch('steps')
named = steps.to_h { |step| [step['name'], step] }

expected_concurrency = {
  'group' => 'materialise-child-epic-${{ github.repository }}',
  'cancel-in-progress' => false
}
raise 'materialisation workflow is not serialized per source repository' unless job['concurrency'] == expected_concurrency

runtime = named.fetch('Check out pinned canonical task-dag runtime')
expected_runtime = {
  'repository' => 'virusdave/task-dag',
  'ref' => '${{ inputs.ref }}',
  'path' => '.task-dag-runtime',
  'fetch-depth' => 0,
  'persist-credentials' => false
}
raise 'materialisation runtime checkout is not full and non-credentialed' unless runtime['with'] == expected_runtime

verify = named.fetch('Verify pinned canonical task-dag runtime')['run'].to_s
raise 'materialisation runtime does not use the canonical full-history validator' unless verify.include?('taskdag_full_history_checkout .task-dag-runtime')

reconcile = named.fetch('Reconcile immutable materialisation intents')['run'].to_s
raise 'materialisation workflow does not use the pinned public reconciler' unless reconcile.include?('.task-dag-runtime/scripts/task-dag" materialise-reconcile')
RUBY
then
    ok "8: materialisation workflow requires one full pinned public runtime"
else
    bad "8: materialisation workflow runtime contract failed"
fi

mkdir -p "$TMP/full-history"
git -C "$TMP/full-history" init -q
git -C "$TMP/full-history" config user.name fixture
git -C "$TMP/full-history" config user.email fixture@example.test
printf 'fixture\n' >"$TMP/full-history/file"
git -C "$TMP/full-history" add file
git -C "$TMP/full-history" commit -qm fixture
source "$ROOT/scripts/task-dag.d/activation.sh"
full_history_matrix=true
taskdag_full_history_checkout "$TMP/full-history" || full_history_matrix=false
git -C "$TMP/full-history" config extensions.partialClone ''
! taskdag_full_history_checkout "$TMP/full-history" || full_history_matrix=false
git -C "$TMP/full-history" config --unset extensions.partialClone
git -C "$TMP/full-history" config remote.origin.promisor false
! taskdag_full_history_checkout "$TMP/full-history" || full_history_matrix=false
git -C "$TMP/full-history" config --unset remote.origin.promisor
git -C "$TMP/full-history" config remote.origin.partialCloneFilter blob:none
! taskdag_full_history_checkout "$TMP/full-history" || full_history_matrix=false
git -C "$TMP/full-history" config --unset remote.origin.partialCloneFilter
git -C "$TMP/full-history" config extensions.worktreeConfig true
git -C "$TMP/full-history" config --worktree remote.origin.promisor true
! taskdag_full_history_checkout "$TMP/full-history" || full_history_matrix=false
git -C "$TMP/full-history" config --worktree --unset remote.origin.promisor
git -C "$TMP/full-history" config --unset extensions.worktreeConfig
common=$(git -C "$TMP/full-history" rev-parse --path-format=absolute --git-common-dir)
: >"$common/objects/pack/fixture.promisor"
! taskdag_full_history_checkout "$TMP/full-history" || full_history_matrix=false
rm "$common/objects/pack/fixture.promisor"
mkdir "$TMP/shallow-origin"
git -C "$TMP/full-history" clone -q --bare . "$TMP/shallow-origin/repo.git"
git clone -q --depth 1 "file://$TMP/shallow-origin/repo.git" "$TMP/shallow"
! taskdag_full_history_checkout "$TMP/shallow" || full_history_matrix=false
cp "$TMP/full-history/.git/config" "$TMP/full-history/.git/config.good"
printf '[malformed\n' >>"$TMP/full-history/.git/config"
! taskdag_full_history_checkout "$TMP/full-history" || full_history_matrix=false
mv "$TMP/full-history/.git/config.good" "$TMP/full-history/.git/config"
[ "$full_history_matrix" = true ] && ok "9: canonical runtime validator rejects shallow, partial, promisor, and unreadable state" \
    || bad "9: canonical runtime full-history validation matrix failed"

mkdir -p "$TMP/identity-home" "$TMP/identity-env" "$TMP/identity-partial"
git -C "$TMP/identity-env" init -q
if (
    cd "$TMP/identity-env" || exit 1
    export HOME="$TMP/identity-home" XDG_CONFIG_HOME="$TMP/identity-home/.config" GIT_CONFIG_NOSYSTEM=1
    export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.test
    export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.test
    source "$ROOT/scripts/task-dag.d/cross-repo.sh"
    _xrepo_ensure_git_identity
    ! git config --local --get user.name >/dev/null \
      && ! git config --local --get user.email >/dev/null
); then
    ok "8a: complete environment identity does not mutate caller config"
else
    bad "8a: complete environment identity mutated caller config"
fi

git -C "$TMP/identity-partial" init -q
if (
    cd "$TMP/identity-partial" || exit 1
    export HOME="$TMP/identity-home" XDG_CONFIG_HOME="$TMP/identity-home/.config" GIT_CONFIG_NOSYSTEM=1
    export GIT_AUTHOR_NAME=partial
    unset GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
    source "$ROOT/scripts/task-dag.d/cross-repo.sh"
    _xrepo_ensure_git_identity
    [ "$(git config --local --get user.name)" = "github-actions[bot]" ] \
      && [ "$(git config --local --get user.email)" = "github-actions[bot]@users.noreply.github.com" ]
); then
    ok "8b: partial environment identity retains canonical fallback"
else
    bad "8b: partial environment identity bypassed canonical fallback"
fi

# Exercise the helper against a coherent runtime in a separate caller repo.
# Completion comments are receipt-only hints: they write the durable receipt
# without GitHub API access, task effects, or caller-local identity mutation.
mkdir -p "$TMP/runtime" "$TMP/caller" "$TMP/output" "$TMP/bin"
cp -R "$ROOT/scripts" "$TMP/runtime/scripts"
cat > "$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
echo called > "$OUTPUT_DIR/curl-called"
exit 99
EOF
cat > "$TMP/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo called > "$OUTPUT_DIR/gh-called"
exit 99
EOF
chmod +x "$TMP/bin/curl" "$TMP/bin/gh"
git init -q --bare "$TMP/caller-origin"
git -C "$TMP/caller" init -q
git -C "$TMP/caller" remote add origin "$TMP/caller-origin"
git -C "$TMP/caller" config taskdag.current-repo acme/widgets
printf '<!-- task-dag:completion --> Satisfies acme/widgets#42 via peer/repo@abcdef1' > "$TMP/expected-body"
COMMENT_BODY="$(cat "$TMP/expected-body"; printf x)"
COMMENT_BODY="${COMMENT_BODY%x}"
export COMMENT_BODY
(
    cd "$TMP/caller" || exit 1
    OUTPUT_DIR="$TMP/output" PATH="$TMP/bin:$PATH" \
      GITHUB_TOKEN=test ISSUE_NUMBER=42 COMMENT_ID=99 \
      COMMENT_URL=https://example.test/comment/99 COMMENT_AUTHOR=alice \
      COMMENT_CREATED_AT=2026-07-10T01:02:03Z \
      COMMENT_UPDATED_AT=2026-07-10T04:05:06Z \
      "$TMP/runtime/scripts/sync-comment-to-tasks.sh"
) >"$TMP/drain.out" 2>&1
rc=$?
if [ "$rc" -eq 0 ] \
  && [ ! -e "$TMP/output/curl-called" ] \
  && [ ! -e "$TMP/output/gh-called" ] \
  && git --git-dir="$TMP/caller-origin" show-ref --verify --quiet refs/heads/gh/comments/42/99 \
  && [ "$(git --git-dir="$TMP/caller-origin" for-each-ref --format='%(refname)')" = refs/heads/gh/comments/42/99 ] \
  && ! git -C "$TMP/caller" config --local --get user.name >/dev/null; then
    ok "9: shim writes a receipt-only completion hint without GitHub or task effects"
else
    bad "9: shim receipt-only completion rc=$rc used GitHub, task effects, or local identity"
    sed 's/^/    drain: /' "$TMP/drain.out"
fi
unset COMMENT_BODY

mkdir -p "$TMP/human-runtime/scripts" "$TMP/human-output"
cp "$COMMENT_SHIM" "$TMP/human-runtime/scripts/sync-comment-to-tasks.sh"
cat > "$TMP/human-runtime/scripts/task-dag" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cat >"$OUTPUT_DIR/body"
printf '%s\0' "$@" >"$OUTPUT_DIR/args"
EOF
chmod +x "$TMP/human-runtime/scripts/task-dag"
printf 'human line one\nhuman line two\n' >"$TMP/human-body"
COMMENT_BODY="$(cat "$TMP/human-body"; printf x)"
COMMENT_BODY="${COMMENT_BODY%x}"
export COMMENT_BODY
if (
  cd "$TMP/caller" || exit 1
  OUTPUT_DIR="$TMP/human-output" GITHUB_TOKEN=test ISSUE_NUMBER=42 COMMENT_ID=100 \
    COMMENT_URL=https://example.test/comment/100 COMMENT_AUTHOR=alice \
    COMMENT_CREATED_AT=2026-07-10T01:02:03Z \
    COMMENT_UPDATED_AT=2026-07-10T01:02:03Z \
    "$TMP/human-runtime/scripts/sync-comment-to-tasks.sh"
) >/dev/null 2>&1; then
  mapfile -d '' -t human_args <"$TMP/human-output/args"
  if cmp -s "$TMP/human-body" "$TMP/human-output/body" \
    && [ "${human_args[${#human_args[@]}-1]}" = --body-stdin ]; then
    ok "9: shim preserves multiline human body bytes through canonical stdin"
  else
    bad "9: shim changed human body bytes or omitted --body-stdin"
  fi
else
  bad "9: shim failed to stream a human body to its coherent CLI"
fi
unset COMMENT_BODY

mkdir -p "$TMP/incomplete/scripts"
cp "$COMMENT_SHIM" "$TMP/incomplete/scripts/sync-comment-to-tasks.sh"
if (cd "$TMP/caller" && "$TMP/incomplete/scripts/sync-comment-to-tasks.sh") >"$TMP/missing.out" 2>&1; then
    bad "10: shim with a missing sibling CLI unexpectedly passed"
elif grep -q 'coherent task-dag checkout is incomplete' "$TMP/missing.out"; then
    ok "10: missing sibling CLI fails loudly without fallback"
else
    bad "10: missing sibling CLI failed without the actionable error"
fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
