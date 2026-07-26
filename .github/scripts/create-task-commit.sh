#!/usr/bin/env bash
# Compatibility ingress only. Root semantics belong exclusively to epic-create.
set -euo pipefail

if [ "${1:-}" = --help ] || [ "${1:-}" = -h ]; then
    cat <<'EOF'
Usage: create-task-commit.sh

Translate one GitHub issue event into task-dag epic-create. Required event
environment: ISSUE_NUMBER, ISSUE_TITLE, ISSUE_AUTHOR, ISSUE_URL,
ISSUE_REPOSITORY, ISSUE_REPOSITORY_ID, and ISSUE_NODE_ID. A materialisation
marker can replay an existing binding but cannot establish one; the projector
must run epic-bind-projection with its source checkout first.
EOF
    exit 0
fi
: "${TASK_DAG_CLI:?TASK_DAG_CLI is required}"
: "${ISSUE_NUMBER:?ISSUE_NUMBER is required}"
: "${ISSUE_TITLE:?ISSUE_TITLE is required}"
: "${ISSUE_AUTHOR:?ISSUE_AUTHOR is required}"
: "${ISSUE_URL:?ISSUE_URL is required}"
: "${ISSUE_REPOSITORY:?ISSUE_REPOSITORY is required}"
: "${ISSUE_REPOSITORY_ID:?ISSUE_REPOSITORY_ID is required; refusing legacy root mint}"
: "${ISSUE_NODE_ID:?ISSUE_NODE_ID is required; refusing legacy root mint}"

marker_args=()
reserved=$(printf '%s\n' "${ISSUE_BODY:-}" | grep -F 'task-dag-materialisation:' || true)
marker=$(printf '%s' "${ISSUE_BODY:-}" | sed -n 's|^<!-- task-dag-materialisation:v1 source=\([^ ]\+/[^ ]\+\) source-id=\([^ ]\+\) operation=\([0-9a-f]\{64\}\) declaration=\([0-9a-f]\{64\}\) -->$|\1 \2 \3 \4|p')
if [ -n "$reserved" ]; then
    [ "$(printf '%s\n' "$reserved" | wc -l)" -eq 1 ] && [ -n "$marker" ] \
        && [ "$(printf '%s\n' "$marker" | wc -l)" -eq 1 ] \
        || { echo "create-task-commit: reserved materialisation marker is not exactly one current canonical marker" >&2; exit 2; }
    read -r marker_source marker_source_id marker_operation marker_declaration <<<"$marker"
    marker_args=(--materialisation-source-repository "$marker_source" --materialisation-source-repository-id "$marker_source_id" --materialisation-operation-id "$marker_operation" --materialisation-declaration-digest "$marker_declaration")
fi

if [[ ",${ISSUE_LABELS:-}," == *,blocked-at-birth,* ]]; then
    echo "create-task-commit: blocked-at-birth requires a canonical atomic blocked overlay; refusing to create a pickable root" >&2
    exit 3
fi

exec "$TASK_DAG_CLI" epic-create --json \
    --title "$ISSUE_TITLE" --author "$ISSUE_AUTHOR" \
    --description "${ISSUE_BODY:-}" --repository "$ISSUE_REPOSITORY" \
    --repository-id "$ISSUE_REPOSITORY_ID" --issue-id "$ISSUE_NODE_ID" \
    --issue-number "$ISSUE_NUMBER" --issue-url "$ISSUE_URL" \
    "${marker_args[@]}"
