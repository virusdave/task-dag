#!/usr/bin/env bash
# Post a one-shot "page-author" comment on an issue that was just
# closed manually.  Invoked by .github/workflows/
# page-on-manual-issue-close.yml.
#
# Idempotent via the marker `<!-- manual-close-page:<N> -->` embedded
# as the first line of the comment body.  If a prior run on the same
# issue already left that marker, this run is a no-op.

set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GH_REPO:?GH_REPO is required}"
: "${ISSUE_NUMBER:?ISSUE_NUMBER is required}"
: "${AUTHOR_LOGIN:?AUTHOR_LOGIN is required}"
: "${CLOSED_BY_LOGIN:?CLOSED_BY_LOGIN is required}"
: "${ISSUE_URL:?ISSUE_URL is required}"
: "${ISSUE_TITLE:?ISSUE_TITLE is required}"

marker="<!-- manual-close-page:${ISSUE_NUMBER} -->"

# Idempotency: skip if the marker is already present on any existing
# comment.  Reruns of this workflow (or repeated close/reopen/close
# cycles on the same issue) won't re-page.
if gh issue view "$ISSUE_NUMBER" \
        --repo "$GH_REPO" \
        --json comments \
        --jq '.comments[].body' 2>/dev/null \
    | grep -Fq "$marker"; then
    echo "Manual-close page already posted on #$ISSUE_NUMBER — skipping."
    exit 0
fi

# Build the body.  Include both the author (always — they're who
# asked to be paged) AND the closer (if different from author), so an
# operator can tell at-a-glance who hit the button.
if [ "$AUTHOR_LOGIN" = "$CLOSED_BY_LOGIN" ]; then
    closer_line=""
else
    closer_line=" (closed by @${CLOSED_BY_LOGIN})"
fi

body="$(cat <<EOF
${marker}

@${AUTHOR_LOGIN} — issue #${ISSUE_NUMBER} "${ISSUE_TITLE}" was just closed${closer_line}.

Epic URL: ${ISSUE_URL}

This is the manual-close page-author path requested on
virusdave/top-level#3.  The push-triggered close path posts its own
@-mention from .github/scripts/close-completed-issues.sh, so you'll
see exactly one page either way.
EOF
)"

printf '%s\n' "$body" > /tmp/page-comment-body.md

echo "Posting manual-close page on #$ISSUE_NUMBER (author=@$AUTHOR_LOGIN, closer=@$CLOSED_BY_LOGIN) ..."
gh issue comment "$ISSUE_NUMBER" \
    --repo "$GH_REPO" \
    --body-file /tmp/page-comment-body.md
