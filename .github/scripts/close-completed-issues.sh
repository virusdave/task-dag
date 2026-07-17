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
#   2. cleans up the remote `refs/heads/tasks/pending/<N>` ref, and
#   3. cleans up any lingering `tasks/blocked/<sha>` overlay (+ frontier /
#      blocked-meta) refs for the closed issue — delegated to
#      cleanup-closed-issue-task-refs.sh. Without this, an epic ROOT that
#      was auto-parked by github-worker (agent abandoned the claim) keeps a
#      blocked overlay forever — the epic root is closed via this merge, not
#      via `task-dag complete`, so nothing else clears it — and the closed
#      issue lingers in the operator-blocked #29 dashboard. See
#      FreshlyBakedNYC/automation#6.
#
# Idempotent but NOT silent: re-closing an already-closed issue and
# deleting an already-absent ref are both treated as success, but a REAL
# close/delete failure (e.g. insufficient `contents` permission) fails the
# run loudly via exit 1 — see ensure_issue_closed / delete_remote_ref_if_present.
#
# Invoked by .github/workflows/close-completed-issues.yml with:
#   BEFORE_SHA  — optional push event's before SHA (40-zero on first push)
#   AFTER_SHA   — optional push event's after SHA / current master tip
#   GH_TOKEN    — workflow token, scoped issues:write
#
# If BEFORE_SHA is empty, the script runs as a projection backstop: it derives
# every sanctioned `Closes-Epic:` fact reachable from the current master tip
# and repairs the GitHub issue / task-ref projection idempotently. This is the
# schedule/manual path for missed push workflows and bot pushes that did not
# trigger the push-range close job.

set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    echo "Usage: close-completed-issues.sh"
    echo "Project legacy epic-close commits to GitHub issues and task refs."
    exit 0
fi
[ "$#" -eq 0 ] || { echo "Error: close-completed-issues.sh accepts no arguments" >&2; exit 2; }

_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_migration_lib="$_here/../../scripts/task-dag.d/semantic-migration.sh"
[ -r "$_migration_lib" ] || { echo "Error: coherent semantic migration guard not found: $_migration_lib" >&2; exit 1; }
# shellcheck source=/dev/null
source "$_migration_lib"
taskdag_migration_guard projection || exit $?
unset _here _migration_lib

BEFORE_SHA="${BEFORE_SHA:-}"
AFTER_SHA="${AFTER_SHA:-}"
: "${GH_TOKEN:?GH_TOKEN is required}"

# Companion script that clears blocked/frontier overlay refs for a closed
# issue. The workflow downloads it next to this one and points
# CLEANUP_REFS_SCRIPT at it; fall back to a sibling path for local runs.
CLEANUP_REFS_SCRIPT="${CLEANUP_REFS_SCRIPT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cleanup-closed-issue-task-refs.sh}"

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

# Walk every new commit landing on master in a push. When no push range is
# supplied (schedule / workflow_dispatch), derive from the current master tip
# instead: the operation is idempotent, so scanning old close facts is safe and
# is exactly how we repair a missed push-triggered projection update.
if [ -z "$AFTER_SHA" ]; then
    AFTER_SHA="$(git rev-parse --verify -q refs/remotes/origin/master^{commit} 2>/dev/null \
        || git rev-parse --verify -q refs/heads/master^{commit} 2>/dev/null \
        || git rev-parse --verify -q HEAD^{commit})" \
        || { echo "ERROR: could not resolve master/HEAD to reconcile completed issues" >&2; exit 1; }
fi

if [ -z "$BEFORE_SHA" ]; then
    echo "No BEFORE_SHA supplied; running full master-derived projection backstop at ${AFTER_SHA:0:12}."
    mapfile -t new_commits < <(git rev-list --reverse "$AFTER_SHA")
elif [[ "$BEFORE_SHA" =~ ^0+$ ]]; then
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

        # Clear any lingering blocked/frontier overlay refs for the closed
        # issue (most often the epic ROOT auto-parked by github-worker), so
        # it stops showing in the operator-blocked #29 dashboard. We pass the
        # matched epic-root parent as a belt-and-braces hint (cleaned by name
        # even if the enumeration fetch/CLI fails). A real failure here is
        # loud: propagate it into SAW_FAILURE so the workflow goes red.
        if [ -x "$CLEANUP_REFS_SCRIPT" ]; then
            if ! GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-}" \
                    bash "$CLEANUP_REFS_SCRIPT" "$issue_num" "$parent"; then
                echo "ERROR: blocked-ref cleanup failed for issue #$issue_num" >&2
                SAW_FAILURE=1
            fi
        else
            echo "ERROR: cleanup-closed-issue-task-refs.sh not found/executable at '$CLEANUP_REFS_SCRIPT'; blocked overlay refs for issue #$issue_num were NOT cleaned (it would linger in the operator-blocked #29 dashboard)" >&2
            SAW_FAILURE=1
        fi
    done
done

# Surface any close/cleanup failure as a red workflow run so silent ref
# orphaning (the contents:read regression) can never recur unnoticed.
if [ "$SAW_FAILURE" -ne 0 ]; then
    echo "ERROR: one or more issue closes or task-ref deletions failed (see above)" >&2
    exit 1
fi
