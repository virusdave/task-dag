#!/bin/bash
# Create or revise an epic task commit for a GitHub issue.
#
# Triggered by issue-to-task.yml on issues:[opened, edited].
#
# Idempotency / edit safety:
#   - First time we see an issue, create the epic task commit, set both
#       refs/heads/tasks/pending/<N>
#       refs/heads/gh/issues/<N>
#     to point at it, push both, and post the "Task metadata commit:"
#     comment exactly once.
#   - On any subsequent edit, create a *revision* commit parented to
#     the current pending/<N> tip, fast-forward both refs, and push.
#     The refs themselves are never lost and pending/<N> is always the
#     latest epic revision (which `scripts/task-dag delegate` resolves
#     against). No additional comment is posted on edits — the noise
#     from a comment per edit is worse than the signal.

set -euo pipefail

: "${ISSUE_NUMBER:?ISSUE_NUMBER is required}"
: "${ISSUE_TITLE:?ISSUE_TITLE is required}"
: "${ISSUE_AUTHOR:?ISSUE_AUTHOR is required}"
: "${ISSUE_URL:?ISSUE_URL is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

ISSUE_BODY="${ISSUE_BODY:-}"

git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

PENDING_REF="refs/heads/tasks/pending/${ISSUE_NUMBER}"
GH_ISSUES_REF="refs/heads/gh/issues/${ISSUE_NUMBER}"

EMPTY_TREE="$(git hash-object -t tree /dev/null)"

# Determine parent for the new (or revised) epic commit.
# - First-seen: parent is master HEAD so the epic chain is anchored.
# - Edit: parent is the current pending ref so the revision is additive.
EXISTING_PENDING="$(git rev-parse --verify --quiet "$PENDING_REF" || true)"
EXISTING_REMOTE_PENDING="$(git ls-remote origin "$PENDING_REF" | awk '{print $1}')"

# Prefer the remote tip if it diverges from local; that's the authoritative
# state across concurrent workflow runs.
if [ -n "$EXISTING_REMOTE_PENDING" ]; then
    PARENT_SHA="$EXISTING_REMOTE_PENDING"
    FIRST_SEEN="false"
elif [ -n "$EXISTING_PENDING" ]; then
    PARENT_SHA="$EXISTING_PENDING"
    FIRST_SEEN="false"
else
    PARENT_SHA="$(git rev-parse HEAD)"
    FIRST_SEEN="true"
fi

cat > /tmp/msg.txt <<EOF
Task: ${ISSUE_TITLE}

Issue: #${ISSUE_NUMBER}
Author: ${ISSUE_AUTHOR}
URL: ${ISSUE_URL}
Status: pending
Type: epic

${ISSUE_BODY}
EOF

TASK_COMMIT="$(git commit-tree "$EMPTY_TREE" -p "$PARENT_SHA" -F /tmp/msg.txt)"
echo "Created task commit: ${TASK_COMMIT} (parent=${PARENT_SHA}, first_seen=${FIRST_SEEN})"

# Update both refs locally, then push them together.
git update-ref "$PENDING_REF" "$TASK_COMMIT"
git update-ref "$GH_ISSUES_REF" "$TASK_COMMIT"

# Fast-forward push for the pending ref (force-with-lease equivalent:
# the parent we used was the remote tip, so a normal push is a fast
# forward unless someone raced us — in which case the rerun by the
# next push event will catch up).
git push origin "$PENDING_REF" "$GH_ISSUES_REF"

if [ "$FIRST_SEEN" = "true" ]; then
    gh issue comment "${ISSUE_NUMBER}" \
        --body "Task metadata commit: ${TASK_COMMIT} | Branch: tasks/pending/${ISSUE_NUMBER}"
else
    echo "Skipped issue comment — this is an edit revision, not the initial create"
fi
