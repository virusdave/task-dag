#!/usr/bin/env bash
# Fixture checks for scripts/validate-caller-workflow.sh. This is a read-only
# rollout preflight: it parses workflow YAML with a real YAML parser and fails
# closed on missing events, permissions, secrets, backstops, graph convergence,
# or reusable-workflow source drift.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VALIDATE="$ROOT/scripts/validate-caller-workflow.sh"
SELF_CALLER="$ROOT/.github/workflows/task-dag.yml"
DOCS="$ROOT/docs/MIGRATION.md"
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

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
