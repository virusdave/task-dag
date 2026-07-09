#!/usr/bin/env bash
# Post a single "monotonic completion" notice when a GitHub issue is REOPENED.
#
# Triggered by reopen-notice.yml on issues:[reopened] (see the caller job in
# .github/workflows/task-dag.yml).
#
# Why this exists (issue #13, operator decision #2): task-dag completion is
# MONOTONIC. Reopening an issue must NOT resurrect or re-create the completed
# task. The create-task-commit.sh path is already create-only, so it never
# rewrites the tasks/pending/<N> dispatch root on reopen — i.e. a reopen never
# mints a phantom task. This script adds the *operator-facing* half of that
# contract: one comment explaining that the finished task stays done and that a
# human must tell a worker IN-THREAD to open a NEW task if more work is needed.
#
# Deliberately NON-task-creating and idempotent:
#   - The body leads with the `<!-- task-dag:status -->` marker as physical
#     line 1. `task-dag ingest-comment` skips any comment with a leading HTML
#     marker (see cmd_ingest_comment in scripts/task-dag.d/cross-repo.sh), so
#     this comment is NEVER ingested as a new pickable task — no dispatch loop.
#   - A second, issue-scoped identity marker `<!-- reopen-notice:<N> -->`
#     (its own namespace, like `<!-- manual-close-page:<N> -->`) lets us find
#     our own prior notice and skip re-posting. Any number of reopen events
#     therefore leave EXACTLY ONE such comment on the issue. We match on the
#     issue-scoped identity marker (not the shared `task-dag:status` marker) so
#     we never collide with other status-markered comments (close notices, ci
#     tickets, …) that may also sit on the issue.
#
# This script touches NO git refs — it cannot create a task even in principle.
#
# Not latency-sensitive: a missed reopen event is harmless (nothing to
# reconcile — no task is created either way; the notice is purely advisory).

set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GH_REPO:?GH_REPO is required}"
: "${ISSUE_NUMBER:?ISSUE_NUMBER is required}"

STATUS_MARKER='<!-- task-dag:status -->'
IDENT_MARKER="<!-- reopen-notice:${ISSUE_NUMBER} -->"

# Idempotency: if our issue-scoped notice is already present, this reopen is a
# no-op (upsert = leave the single existing comment in place). Matching on the
# issue-scoped identity marker avoids clobbering other `task-dag:status`
# comments that may exist on the issue.
if gh issue view "$ISSUE_NUMBER" \
        --repo "$GH_REPO" \
        --json comments \
        --jq '.comments[].body' 2>/dev/null \
    | grep -Fq "$IDENT_MARKER"; then
    echo "Reopen notice already present on #${ISSUE_NUMBER} — skipping (idempotent no-op)."
    exit 0
fi

body="$(cat <<EOF
${STATUS_MARKER}
${IDENT_MARKER}

**Reopen noted — task-dag completion is monotonic.**

Reopening issue #${ISSUE_NUMBER} does **not** resurrect or re-create the
completed task: a finished task stays done. task-dag never rewrites the
\`tasks/pending/${ISSUE_NUMBER}\` dispatch root on reopen, so this event creates
**no** new (phantom) task.

If more work is genuinely needed, a human must tell a worker **in this thread**
to open a **NEW** task — post the follow-up as a fresh prose comment here (a
plain comment with no leading \`<!-- … -->\` marker is what mints pickable work).

_(Automated monotonic-completion notice — issue #13 / operator decision #2.)_
EOF
)"

printf '%s\n' "$body" > /tmp/reopen-notice-body.md

echo "Posting monotonic-completion reopen notice on #${ISSUE_NUMBER} ..."
gh issue comment "$ISSUE_NUMBER" \
    --repo "$GH_REPO" \
    --body-file /tmp/reopen-notice-body.md
