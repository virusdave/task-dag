#!/bin/bash
# Create an epic task commit for a GitHub issue, exactly once.
#
# Triggered by issue-to-task.yml on issues:[opened, reopened, edited].
#
# Create-only (F2 of virusdave/top-level#22):
#   - First time we see an issue, create the epic task commit, set both
#       refs/heads/tasks/pending/<N>   (agent-visible epic / dispatch root)
#       refs/heads/gh/issues/<N>       (GitHub-side epic mapping)
#     to point at it, push both atomically, and post the
#     "Task metadata commit:" comment exactly once.
#   - On any subsequent edit/reopen, DO NOTHING that moves tasks/pending/<N>.
#
# Why create-only: this workflow used to mint a *new* revision commit on
# every edit and fast-forward tasks/pending/<N> to it. The dispatcher
# (github-worker) treats tasks/pending/<N> as pickable and dedups by exact
# commit SHA, so every issue body-edit produced a fresh root SHA that
# bypassed dedup (and any `task-dag block` on the prior root), spawning a
# worker onto an already-handled issue — pure wasted agent runs. Nothing
# consumes the epic commit's *body*: `task-dag delegate` reads the issue
# body live (`gh issue view`) and uses the epic ref only as an existence
# check + parent SHA; comment-sync likewise uses the ref only as a parent
# anchor and reads issue text from the event/API. So freezing the ref
# loses nothing and stops the re-dispatch loop. The pending/<N> ref is
# also the epic *identity* (closure/delegation/comment ancestry), so it is
# kept (never deleted), just not rewritten.
#
# Authority: existence decisions use ORIGIN only (a local stale ref must
# not influence what we create/move). Pushes are atomic + race-tolerant so
# this is safe to run concurrently across opened/reopened/edited events.

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

# Origin is the single source of truth for "does this epic already exist".
remote_ref_sha() { git ls-remote origin "$1" | awk 'NR == 1 {print $1}'; }

EXISTING_PENDING="$(remote_ref_sha "$PENDING_REF")"
EXISTING_GH="$(remote_ref_sha "$GH_ISSUES_REF")"

# Anomaly: gh/issues/<N> exists but the dispatch root is missing. Do NOT
# recreate the dispatch root (that would re-dispatch). Fail closed.
if [ -z "$EXISTING_PENDING" ] && [ -n "$EXISTING_GH" ]; then
    echo "WARNING: ${GH_ISSUES_REF} exists at ${EXISTING_GH} but ${PENDING_REF} is missing; \
not recreating dispatch root (create-only)." >&2
    exit 0
fi

if [ -n "$EXISTING_PENDING" ]; then
    # Issue already tracked -> create-only no-op for the dispatch root.
    echo "Issue #${ISSUE_NUMBER} already tracked at ${EXISTING_PENDING}; \
leaving ${PENDING_REF} unchanged (create-only)."

    # If both refs exist but disagree, leave both alone and surface it for
    # a human; never silently rewrite either.
    if [ -n "$EXISTING_GH" ] && [ "$EXISTING_GH" != "$EXISTING_PENDING" ]; then
        echo "WARNING: ${GH_ISSUES_REF}=${EXISTING_GH} differs from \
${PENDING_REF}=${EXISTING_PENDING}; leaving both unchanged." >&2
        exit 0
    fi

    # Backfill gh/issues/<N> only if it is absent on origin (epics created
    # before that ref existed). Point it at the existing epic SHA; never
    # move pending.
    if [ -z "$EXISTING_GH" ]; then
        echo "Backfilling ${GH_ISSUES_REF} -> ${EXISTING_PENDING}"
        # Make sure the epic object is present locally before pointing a
        # ref at it (cheap no-op when fetch-depth:0 already has it).
        git cat-file -e "${EXISTING_PENDING}^{commit}" 2>/dev/null \
            || git fetch --no-tags origin "$PENDING_REF" >/dev/null 2>&1 || true
        git update-ref "$GH_ISSUES_REF" "$EXISTING_PENDING"
        if ! git push origin "$GH_ISSUES_REF"; then
            if [ "$(remote_ref_sha "$GH_ISSUES_REF")" = "$EXISTING_PENDING" ]; then
                echo "Lost backfill race; ${GH_ISSUES_REF} already present at ${EXISTING_PENDING}."
                exit 0
            fi
            echo "ERROR: failed to backfill ${GH_ISSUES_REF}." >&2
            exit 1
        fi
    fi
    exit 0
fi

# ---- First sighting: create the epic, anchored to master HEAD. ----
PARENT_SHA="$(git rev-parse HEAD)"
EMPTY_TREE="$(git mktree </dev/null)"

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
echo "Created epic task commit: ${TASK_COMMIT} (parent=${PARENT_SHA}, first_seen=true)"

git update-ref "$PENDING_REF" "$TASK_COMMIT"
git update-ref "$GH_ISSUES_REF" "$TASK_COMMIT"

# Atomic so we never leave one ref created and the other rejected.
if ! git push --atomic origin "$PENDING_REF" "$GH_ISSUES_REF"; then
    # A concurrent first-seen run may have won. If the dispatch root now
    # exists on origin, the desired end state is reached; don't double-post.
    AFTER_PENDING="$(remote_ref_sha "$PENDING_REF")"
    if [ -n "$AFTER_PENDING" ]; then
        echo "Lost first-seen race; ${PENDING_REF} now exists at ${AFTER_PENDING}. Not commenting."
        exit 0
    fi
    echo "ERROR: first-seen push failed and ${PENDING_REF} still does not exist." >&2
    exit 1
fi

gh issue comment "${ISSUE_NUMBER}" \
    --body "Task metadata commit: ${TASK_COMMIT} | Branch: tasks/pending/${ISSUE_NUMBER}"
