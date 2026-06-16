#!/usr/bin/env bash
# Sync task-dag agent messages to GitHub issue comments
# Part of Nicponskis/shared-workflows

set -euo pipefail

# Required environment variables:
# - GITHUB_TOKEN
# - MAX_BATCH_SIZE (optional, default 10)

MAX_BATCH_SIZE="${MAX_BATCH_SIZE:-10}"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" >&2
}

# TODO: Implement full sync logic
# For now, placeholder

log "Sync tasks to GitHub - placeholder implementation"
log "Would process up to $MAX_BATCH_SIZE messages"

# Logic:
# 1. Find task commits with flags.post_to_github: true and no github.comment_id
# 2. Check refs/task-messages/sent/<message_id> (skip if exists)
# 3. Parse metadata to build comment body
# 4. POST to GitHub API
# 5. Store comment_id in metadata (amend or new commit)
# 6. Create refs/heads/gh/comments/<issue>/<comment_id> mapping
#    (under refs/heads/* because GitHub rejects pushes to other namespaces)
# 7. Mark sent: refs/task-messages/sent/<message_id>

log "Not yet implemented - see V1 design docs"
exit 0
