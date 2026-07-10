#!/usr/bin/env bash
# Sync a GitHub issue comment into the task-dag DAG.
# Run by virusdave/task-dag:.github/workflows/sync-comment-to-task.yml from a
# coherent task-dag checkout, with the caller repository as the working tree.
#
# This script is intentionally a THIN shim: it delegates to the sibling
# canonical task-dag CLI's `ingest-comment`, which is the single home for the
# real logic (cross-repo completion routing, leading-marker machine-comment
# skipping, and human-comment minting).
#
# There is deliberately NO download, caller-local CLI preference, or inline
# fallback. The helper, CLI, modules, and config must all come from the same
# checkout revision. If that checkout is incomplete, fail loudly.

set -euo pipefail

usage() {
    cat <<'EOF'
Usage: sync-comment-to-tasks.sh

Ingest the GitHub issue-comment observation supplied through the workflow
environment by delegating to the task-dag CLI beside this helper.
EOF
}

case "${1:-}" in
    -h|--help) usage; exit 0 ;;
    '') ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
esac

# Required environment variables:
# - GITHUB_TOKEN     (token for git push + gh API; the CLI uses it)
# - ISSUE_NUMBER
# - COMMENT_ID
# - COMMENT_BODY
# - COMMENT_URL
# - COMMENT_AUTHOR
# - COMMENT_CREATED_AT
# - COMMENT_UPDATED_AT

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" >&2
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASK_DAG_CLI="$HERE/task-dag"
if [ ! -x "$TASK_DAG_CLI" ]; then
    log "FATAL: coherent task-dag checkout is incomplete: sibling CLI is not executable at $TASK_DAG_CLI. Refusing to download or use a caller-local fallback."
    exit 1
fi

# Configure git for the refs/commits the CLI will push.
git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

BODY_FILE="$(mktemp)"
printf '%s' "$COMMENT_BODY" > "$BODY_FILE"
trap 'rm -f "$BODY_FILE"' EXIT

log "Delegating coherent event observation to sibling task-dag ingest-comment"
"$TASK_DAG_CLI" ingest-comment \
    --issue "$ISSUE_NUMBER" \
    --comment-id "$COMMENT_ID" \
    --author "$COMMENT_AUTHOR" \
    --comment-url "$COMMENT_URL" \
    --created-at "$COMMENT_CREATED_AT" \
    --updated-at "$COMMENT_UPDATED_AT" \
    --body-file "$BODY_FILE"
