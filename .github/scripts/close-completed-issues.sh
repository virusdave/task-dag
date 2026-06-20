#!/usr/bin/env bash
# Close task-epic issues whose epic-task commit has just been merged
# into master.  The completion signal has two parts that BOTH must be
# present:
#
#   1. Structure: the merge commit on master lists a metadata commit at
#      refs/heads/tasks/pending/<N> as one of its non-primary parents.
#   2. Trailer:   the merge commit's message carries an explicit
#                 `Closes-Epic: #<N>` trailer matching the same <N>.
#
# Both conditions are required because `scripts/task-dag complete`
# uses the same parent structure to *attach* an implementation commit
# to an in-progress epic — that is NOT a completion signal and must
# not auto-close the epic. See docs/task_dag/EPIC_CLOSURE.md and
# virusdave/top-level#8 for the rationale and the incident on #7 that
# motivated this gate.
#
# The canonical way to emit the trailer is `scripts/task-dag close-epic
# <N>`, which constructs a tree-equal merge commit with the trailer
# baked in.  Operators can also add the trailer by hand when landing
# an epic-closing merge directly.
#
# When both conditions are met, this script:
#
#   1. closes issue #<N> via `gh issue close`, including an @-mention
#      of the issue author so they get a GitHub notification (this is
#      the operator paging path operators rely on to know an epic
#      finally wrapped up — see virusdave/top-level#3),
#   2. cleans up the remote `refs/heads/tasks/pending/<N>` ref.
#
# Idempotent but NOT silent: re-closing an already-closed issue and
# deleting an already-absent ref are both treated as success, but a REAL
# close/delete failure (e.g. insufficient `contents` permission) fails the
# run loudly via exit 1 — see ensure_issue_closed / delete_remote_ref_if_present.
#
# Invoked by .github/workflows/close-completed-issues.yml with these
# env vars set:
#   BEFORE_SHA  — push event's before SHA (40-zero string on first push)
#   AFTER_SHA   — push event's after SHA
#   GH_TOKEN    — workflow token, scoped issues:write

set -euo pipefail

: "${BEFORE_SHA:?BEFORE_SHA is required}"
: "${AFTER_SHA:?AFTER_SHA is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

# Track whether any close/cleanup step failed so we can exit non-zero at the
# end. Historically every close + ref-delete was `... || true`, which hid
# exactly the failure that orphaned tasks/pending/<N> for closed issues when
# the workflow token only had `contents: read` (the delete needs
# `contents: write`). We now FAIL LOUDLY: a real failure must turn the
# workflow red so the regression is visible, not silently swallowed. Only
# "already in the desired state" (issue already closed, ref already absent)
# is treated as success.
SAW_FAILURE=0

# Close the issue, tolerating "already closed" but failing on real errors.
# Returns non-zero ONLY if the issue is still open after we tried.
ensure_issue_closed() {
    local issue_num="$1" comment="$2"
    if gh issue close "$issue_num" --comment "$comment"; then
        return 0
    fi
    local state
    state="$(gh issue view "$issue_num" --json state --jq '.state' 2>/dev/null || true)"
    if [ "$state" = "CLOSED" ]; then
        echo "Issue #$issue_num already CLOSED; continuing with ref cleanup"
        return 0
    fi
    echo "ERROR: failed to close issue #$issue_num (state='${state:-unknown}')" >&2
    return 1
}

# Tri-state remote ref existence against origin (the source of truth):
#   0 present, 1 absent, 3 transport/auth error.
_remote_ref_exists() {
    git ls-remote --exit-code origin "$1" >/dev/null 2>&1
    case "$?" in
        0) return 0 ;;
        2) return 1 ;;
        *) return 3 ;;
    esac
}

# Delete a remote ref if present. Missing is success; a real delete failure
# (or an indeterminate existence probe) is loud and sets SAW_FAILURE.
delete_remote_ref_if_present() {
    local ref="$1"
    _remote_ref_exists "$ref"
    case "$?" in
        1) echo "$ref already absent"; return 0 ;;
        3) echo "ERROR: could not query origin for $ref" >&2; SAW_FAILURE=1; return 1 ;;
    esac
    echo "Deleting $ref"
    if git push origin --delete "$ref"; then
        return 0
    fi
    echo "ERROR: failed to delete $ref (needs contents: write?)" >&2
    SAW_FAILURE=1
    return 1
}

# Walk every new commit landing on master in this push.  On the very
# first push to a new branch BEFORE_SHA is all-zeros — fall back to
# "just the head commit" in that case.
if [[ "$BEFORE_SHA" =~ ^0+$ ]]; then
    new_commits=("$AFTER_SHA")
else
    mapfile -t new_commits < <(git rev-list --reverse "${BEFORE_SHA}..${AFTER_SHA}")
fi

# Make sure we can resolve refs/heads/tasks/pending/* — push events
# don't pre-fetch them on the workflow checkout.
git fetch --quiet origin '+refs/heads/tasks/pending/*:refs/remotes/origin-tasks-pending/*' 2>/dev/null || true

for commit in "${new_commits[@]}"; do
    [ -z "$commit" ] && continue

    # Only merge commits can complete an epic.
    read -r -a parents < <(git rev-list --parents -n 1 "$commit" | cut -d' ' -f2-)
    if [ "${#parents[@]}" -lt 2 ]; then
        continue
    fi

    # Gate 2: explicit `Closes-Epic: #<N>` trailer must be present on
    # the merge commit.  Without it, we treat the merge as a normal
    # task-attach (`scripts/task-dag complete`) and skip closure.
    # `git interpret-trailers` is the supported way to parse trailers
    # consistently; we accept either `#42` or bare `42` after the colon.
    mapfile -t closes_epic_issues < <(
        git log -1 --format='%B' "$commit" \
            | git interpret-trailers --parse 2>/dev/null \
            | sed -nE 's/^Closes-Epic:[[:space:]]*#?([0-9]+).*$/\1/p'
    )
    if [ "${#closes_epic_issues[@]}" -eq 0 ]; then
        continue
    fi

    # For each non-primary parent, see if it's the tip of a
    # tasks/pending/<N> ref (locally or via the fetched mirror).
    for parent in "${parents[@]:1}"; do
        issue_num="$(
            { git for-each-ref --points-at="$parent" 'refs/heads/tasks/pending/*' --format='%(refname:short)';
              git for-each-ref --points-at="$parent" 'refs/remotes/origin-tasks-pending/*' --format='%(refname:short)';
            } | sed -E 's#^(tasks/pending/|origin-tasks-pending/)##' | head -n1
        )"

        [ -z "$issue_num" ] && continue

        # Gate 2 (cont.): the trailer must reference THIS issue, not
        # just any issue.  Closing #42 must not collaterally close #41
        # because the same merge happened to attach an unrelated task.
        matched="false"
        for trailer_issue in "${closes_epic_issues[@]}"; do
            if [ "$trailer_issue" = "$issue_num" ]; then
                matched="true"
                break
            fi
        done
        if [ "$matched" != "true" ]; then
            echo "Skipping issue #$issue_num: merge $commit has no matching Closes-Epic trailer (trailers: ${closes_epic_issues[*]})"
            continue
        fi

        echo "Found completion of task epic for issue #$issue_num in commit $commit"

        # Look up the issue author so we can @-mention them in the close
        # comment.  GitHub will send them a notification email — this
        # is the "page operator on epic closure" mechanism the cross-
        # repo task-dag design references (see
        # docs/epics/customer-sentiment/EPIC_PLAN.md rollout phases).
        author="$(gh issue view "$issue_num" --json author --jq '.author.login' 2>/dev/null || true)"
        if [ -n "$author" ]; then
            mention="@${author} — "
        else
            mention=""
        fi

        issue_url="$(gh issue view "$issue_num" --json url --jq '.url' 2>/dev/null || true)"
        commit_url="https://github.com/${GITHUB_REPOSITORY:-${GH_REPO:-virusdave/top-level}}/commit/${commit}"

        comment="${mention}task epic completed in commit [\`${commit:0:12}\`](${commit_url}).${issue_url:+ }${issue_url:+(Epic: ${issue_url})}"

        # Close the issue FIRST; only clean up its task refs once it is
        # confirmed closed (closing is the user-visible signal; deleting refs
        # for a still-open issue would strand its epic). A real close failure
        # is loud and skips ref cleanup for this issue.
        if ! ensure_issue_closed "$issue_num" "$comment"; then
            SAW_FAILURE=1
            continue
        fi

        # Drop any orchestration lock (tasks/root-active/<N>) FIRST, then
        # the pending identity ref, so the frontier stays clean. Order
        # matters: breakdown keys "is this an epic root?" off pending/<N>,
        # so removing root-active before pending narrows the window in which
        # a stale worker could see the root-lock gone but pending still
        # present. (breakdown also fails closed when an epic root's pending
        # identity is missing, so neither ordering can resurrect the root.)
        delete_remote_ref_if_present "refs/heads/tasks/root-active/${issue_num}" || true
        delete_remote_ref_if_present "refs/heads/tasks/pending/${issue_num}" || true
        # Re-delete root-active in case a worker re-claimed the (now closed)
        # root in the window between the two deletes above, leaving a stale
        # orchestration lock for a closed issue. (breakdown already fails
        # closed once pending is gone, so this is debris cleanup, not safety.)
        delete_remote_ref_if_present "refs/heads/tasks/root-active/${issue_num}" || true
    done
done

# Surface any close/cleanup failure as a red workflow run so silent ref
# orphaning (the contents:read regression) can never recur unnoticed.
if [ "$SAW_FAILURE" -ne 0 ]; then
    echo "ERROR: one or more issue closes or task-ref deletions failed (see above)" >&2
    exit 1
fi
