#!/usr/bin/env bash
# Scan commits in $BEFORE_SHA..$AFTER_SHA for `Post-Comment:` /
# `Comment-File:` trailer pairs and post the corresponding files as
# issue comments via `gh`.  See .github/workflows/post-issue-comment.yml
# for the trailer contract.
#
# Idempotency: each comment we post carries an HTML marker
#   <!-- post-comment:<commit-sha>:<file-path> -->
# embedded as the first line of the body.  Before posting we list the
# target issue's existing comments and skip any (sha, file) pair whose
# marker is already present.  Re-running the workflow on the same push,
# or a second push that re-introduces the same trailer commit, is a
# no-op.

set -euo pipefail

: "${BEFORE_SHA:?BEFORE_SHA is required}"
: "${AFTER_SHA:?AFTER_SHA is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GH_REPO:?GH_REPO is required}"

# On the very first push to a new branch GitHub reports BEFORE_SHA as
# 0000... — fall back to "just the head commit" in that case.
if [[ "$BEFORE_SHA" =~ ^0+$ ]]; then
    commit_range=("$AFTER_SHA" "-1")
else
    commit_range=("${BEFORE_SHA}..${AFTER_SHA}")
fi

posted_any=false

# `git rev-list --reverse` so we process commits in chronological order;
# this only matters when a single push contains multiple trailer commits
# touching the same issue (we still post them in order).
while IFS= read -r commit; do
    [ -z "$commit" ] && continue

    msg="$(git log -1 --format=%B "$commit")"

    # Use git interpret-trailers to extract Post-Comment / Comment-File pairs.
    # Multiple pairs in a single commit are allowed; we walk them in
    # declaration order and assume a `Comment-File:` belongs to the most
    # recent `Post-Comment:` above it.  Trailers are case-insensitive on
    # the key per RFC 822 conventions; git interpret-trailers preserves
    # case but we lowercase the key for matching.
    trailers="$(printf '%s\n' "$msg" | git interpret-trailers --parse)"
    [ -z "$trailers" ] && continue

    current_issue=""
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        key="${line%%:*}"
        val="${line#*:}"
        # Trim leading whitespace from val
        val="${val#"${val%%[![:space:]]*}"}"
        key_lc="$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')"

        case "$key_lc" in
            post-comment)
                # Accept either `#<N>` or `<owner/repo>#<N>` (latter must
                # match $GH_REPO; we don't post cross-repo here).
                if [[ "$val" =~ ^#([0-9]+)$ ]]; then
                    current_issue="${BASH_REMATCH[1]}"
                elif [[ "$val" =~ ^([^/]+/[^#]+)#([0-9]+)$ ]]; then
                    if [ "${BASH_REMATCH[1]}" != "$GH_REPO" ]; then
                        echo "::warning ::Commit $commit Post-Comment trailer targets $val; this workflow only posts to $GH_REPO. Skipping."
                        current_issue=""
                    else
                        current_issue="${BASH_REMATCH[2]}"
                    fi
                else
                    echo "::warning ::Commit $commit has malformed Post-Comment trailer: '$val' (expected '#<N>' or '<owner/repo>#<N>'). Skipping."
                    current_issue=""
                fi
                ;;
            comment-file)
                if [ -z "$current_issue" ]; then
                    echo "::warning ::Commit $commit Comment-File trailer with no preceding Post-Comment: '$val'. Skipping."
                    continue
                fi

                file_path="$val"
                # Read the file from the trailer commit's tree (NOT the
                # workflow checkout tip) so the comment reflects exactly
                # what the author committed.
                if ! file_blob="$(git show "${commit}:${file_path}" 2>/dev/null)"; then
                    echo "::error ::Commit $commit Comment-File '$file_path' not found in that commit's tree."
                    continue
                fi

                marker="<!-- post-comment:${commit}:${file_path} -->"

                # Check whether this marker already exists on the target
                # issue (any prior workflow run posted it).
                if gh issue view "$current_issue" \
                        --repo "$GH_REPO" \
                        --json comments \
                        --jq '.comments[].body' 2>/dev/null \
                    | grep -Fq "$marker"; then
                    echo "Already posted marker '$marker' on #$current_issue — skipping."
                    continue
                fi

                {
                    printf '%s\n' "$marker"
                    printf '\n'
                    printf '%s\n' "$file_blob"
                } > /tmp/comment-body.md

                echo "Posting $file_path (from $commit) as comment on #$current_issue ..."
                if gh issue comment "$current_issue" \
                        --repo "$GH_REPO" \
                        --body-file /tmp/comment-body.md; then
                    posted_any=true
                else
                    echo "::error ::Failed to post comment on #$current_issue from commit $commit file $file_path"
                fi
                ;;
            *)
                : # ignore other trailers
                ;;
        esac
    done <<< "$trailers"

done < <(git rev-list --reverse "${commit_range[@]}")

if [ "$posted_any" = "true" ]; then
    echo "Posted one or more issue comments."
else
    echo "No Post-Comment trailers found in $BEFORE_SHA..$AFTER_SHA — nothing to post."
fi
