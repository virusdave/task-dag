#!/usr/bin/env bash
# Clean up task-dag blocked/frontier overlay refs for a CLOSED task-epic
# issue.
#
# When an epic issue is closed (its `Closes-Epic: #<N>` merge lands on
# master), close-completed-issues.sh retires the epic IDENTITY refs
# (tasks/pending/<N>, tasks/root-active/<N>). But a task belonging to that
# issue can ALSO carry a `tasks/blocked/<sha>` overlay (+ a
# tasks/blocked-meta/<sha> side ref) — most often the epic ROOT itself,
# auto-parked by github-worker when an agent abandoned the claim
# (Blocker-Kind: operator). The epic root is closed via the Closes-Epic
# merge, NEVER via `task-dag complete`, so nothing ever cleared its blocked
# overlay. Result: the closed issue lingered forever in the operator-blocked
# #29 dashboard, which rebuilds purely from the live blocked refs. See
# FreshlyBakedNYC/automation#6.
#
# For the closed issue, this script deletes each matching task's:
#   1. tasks/frontier/<short>  FIRST (points-at-leased) — so a leaf whose
#      blocked overlay we are about to remove cannot briefly become pickable
#      again and get re-dispatched for a now-closed issue (zombie dispatch).
#   2. tasks/blocked/<full-sha>       (overlay ref; its name embeds the full
#      sha, so `cmd_block` only ever lets it point at that one task commit —
#      delete-by-name here cannot clobber a different task).
#   3. tasks/blocked-meta/<full-sha>  (mutable descriptive side ref).
# It deliberately leaves tasks/active/* alone: a live claim's owning worker
# CAS-cleans it on `complete`; deleting it here would only make that worker
# fail loud. A stale active ref for a closed issue is harmless debris.
#
# "Which tasks match" = resolved (repo, issue) == (this repo, N). The issue
# and repo are read via the canonical `task-dag blocked --json` (so we never
# reparse commit bodies or drift from the CLI): it reports the meta-
# overridden issue and the meta/derived repo. A cross-repo-referencing block
# (Repo: other/repo, Issue: #N) is therefore NOT deleted when closing THIS
# repo's #N.
#
# Belt-and-braces: any task SHAs passed as extra args (the close path passes
# the epic-root merge parent) are cleaned even if the blocked-ref
# fetch/enumeration fails — so the common epic-root case self-heals despite a
# transient CLI/fetch problem. (They still honour the frontier-first
# invariant, so a failure to READ the frontier listing does skip them too.)
#
# Idempotent but NOT silent: an already-absent ref is success; a real delete
# failure — or a failure to enumerate (fetch/CLI) that leaves matching
# blocked refs un-swept — exits non-zero so the calling workflow goes red
# and the regression is visible, never silently swallowed.
#
# Usage:  cleanup-closed-issue-task-refs.sh <issue-number> [<extra-task-sha> ...]
#
# Env:
#   GITHUB_REPOSITORY  owner/repo of THIS repo (used for the repo match).
#                      Required.
#   GH_TOKEN           token for the canonical CLI clone (task-dag is public;
#                      only needed if API-rate-limited). Optional.
#   TASK_DAG_CLI       path to a task-dag CLI (fixture tests inject this). If
#                      unset, the canonical CLI is cloned from
#                      virusdave/task-dag.
#   TASK_DAG_REF       ref to clone the CLI at (default: master).
#
# Operates on the `origin` remote of the CURRENT git repo (the caller's
# checkout), which close-completed-issues.yml authenticates for ref deletes.
# NB: the enumeration fetches the blocked/blocked-meta globs into the current
# checkout's local `refs/heads/tasks/blocked*` (required — `task-dag blocked`
# reads local `refs/heads/`); harmless in an ephemeral CI checkout, but it
# does write those local branches if you run it in a dev clone.

set -euo pipefail

ISSUE_NUM="${1:-}"
[ -n "$ISSUE_NUM" ] || { echo "ERROR: <issue-number> is required" >&2; exit 2; }
[[ "$ISSUE_NUM" =~ ^[0-9]+$ ]] || { echo "ERROR: <issue-number> must be numeric, got: $ISSUE_NUM" >&2; exit 2; }
shift || true
HINT_SHAS=("$@")

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required (owner/repo for the repo match)}"

command -v git >/dev/null 2>&1 || { echo "ERROR: git is required" >&2; exit 2; }
command -v jq  >/dev/null 2>&1 || { echo "ERROR: jq is required"  >&2; exit 2; }

SAW_FAILURE=0

# Tri-state remote ref existence against origin (the source of truth):
#   0 present, 1 absent, 3 transport/auth error. The `|| rc=$?` keeps the
# `--exit-code` non-zero (2 = absent) from tripping `set -e`.
_remote_ref_exists() {
    local rc=0
    git ls-remote --exit-code origin "$1" >/dev/null 2>&1 || rc=$?
    case "$rc" in
        0) return 0 ;;
        2) return 1 ;;
        *) return 3 ;;
    esac
}

# Delete a remote ref by name if present. Missing is success; a real delete
# failure (or an indeterminate existence probe) is loud and sets SAW_FAILURE.
# Always returns 0 (failures are recorded in SAW_FAILURE, not the exit code)
# so `set -e` never aborts on an expected absent ref or a recorded failure.
delete_remote_ref_if_present() {
    local ref="$1" ex=0
    _remote_ref_exists "$ref" || ex=$?
    case "$ex" in
        1) return 0 ;;  # already absent — success
        3) echo "ERROR: could not query origin for $ref" >&2; SAW_FAILURE=1; return 0 ;;
    esac
    echo "Deleting $ref"
    if git push origin --delete "$ref"; then
        return 0
    fi
    echo "ERROR: failed to delete $ref (needs contents: write?)" >&2
    SAW_FAILURE=1
    return 0
}

# Snapshot of `git ls-remote origin refs/heads/tasks/frontier/*` (captured
# ONCE, before any deletes, so a big sweep is not O(tasks) round-trips).
# Residual TOCTOU (by design): a frontier ref CREATED for a target task
# after this snapshot is invisible here (the lease only guards refs in the
# snapshot). For a just-closed issue that needs a concurrent breakdown
# racing the close — vanishingly narrow, and re-running the cleaner heals it.
FRONTIER_LISTING=""
capture_frontier_listing() {
    if FRONTIER_LISTING=$(git ls-remote origin 'refs/heads/tasks/frontier/*'); then
        return 0
    fi
    echo "ERROR: could not list frontier refs from origin; refusing to delete any blocked overlay (would risk zombie dispatch)" >&2
    SAW_FAILURE=1
    return 1
}

# Delete any tasks/frontier/<short> ref that currently points at $1, leased
# to the exact sha we observed so a concurrent breakdown that re-pointed the
# short-sha ref at a DIFFERENT task can never be clobbered (frontier refs are
# short-sha-named and a collision must not delete someone else's entry).
# Returns 0 IFF the task's frontier is confirmed clear (deleted, absent, or
# re-pointed elsewhere); non-zero if a genuine failure may have left a
# frontier ref still pointing at THIS task (so the caller must NOT then
# delete the blocked overlay and reopen the pickable window).
delete_frontier_pointing_at() {
    local task_sha="$1" fref fsha now rc=0
    # `git ls-remote` prints "<sha>\t<ref>"; only the exact task match is deleted.
    while read -r fsha fref; do
        [ -n "$fref" ] || continue
        [ "$fsha" = "$task_sha" ] || continue
        echo "Deleting $fref (frontier overlay for closed-issue task ${task_sha:0:12})"
        if git push origin --force-with-lease="$fref:$fsha" ":$fref" 2>/dev/null; then
            continue
        fi
        # Lease failed: re-probe origin. Gone, or re-pointed at a DIFFERENT
        # task, means it is not (any longer) ours to delete — success. Still
        # pointing at THIS task is a genuine failure that leaves the pickable
        # window open.
        if ! now=$(git ls-remote origin "$fref" 2>/dev/null | awk '{print $1; exit}'); then
            echo "ERROR: could not re-query origin for $fref" >&2; rc=1; continue
        fi
        if [ -z "$now" ] || [ "$now" != "$task_sha" ]; then
            : # gone or re-pointed elsewhere — not ours, success
        else
            echo "ERROR: failed to lease-delete $fref (still points at ${task_sha:0:12})" >&2; rc=1
        fi
    done <<< "$FRONTIER_LISTING"
    return "$rc"
}

# Clean one task sha's overlay refs: frontier FIRST (no pickable window),
# then — ONLY once the frontier is confirmed clear — the blocked overlay +
# its meta side ref. If the frontier could not be confirmed clear we skip
# the blocked delete (leaving visible debris) rather than create a zombie-
# dispatch window; the failure is already recorded loud in SAW_FAILURE.
clean_task_sha() {
    local task_sha="$1"
    if ! delete_frontier_pointing_at "$task_sha"; then
        echo "Skipping blocked/meta delete for ${task_sha:0:12} (frontier not confirmed clear)" >&2
        SAW_FAILURE=1
        return 0
    fi
    delete_remote_ref_if_present "refs/heads/tasks/blocked/${task_sha}"
    delete_remote_ref_if_present "refs/heads/tasks/blocked-meta/${task_sha}"
    return 0
}

# ---------------------------------------------------------------------------
# Build the set of task SHAs to clean: the explicitly-passed hint SHAs (the
# epic-root merge parent — belt-and-braces, cleaned even if enumeration
# fails), plus every blocked task the canonical CLI resolves to THIS
# (repo, issue). The enumeration covers autoparked leaves and superseded
# epic roots whose sha is not the merge parent.
declare -A TARGETS=()
for sha in "${HINT_SHAS[@]:-}"; do
    [ -n "$sha" ] && TARGETS["$sha"]=1
done

# Fetch ONLY the blocked + blocked-meta ref globs so `task-dag blocked
# --json --no-fetch` can read the task/meta commit objects locally. A fetch
# failure is loud (SAW_FAILURE): silently skipping the sweep would silently
# reintroduce exactly this bug. The hint-SHA deletes above still stand.
if git fetch --quiet --no-tags origin \
        '+refs/heads/tasks/blocked/*:refs/heads/tasks/blocked/*' \
        '+refs/heads/tasks/blocked-meta/*:refs/heads/tasks/blocked-meta/*' 2>/dev/null; then

    # Locate the canonical task-dag CLI (tests inject TASK_DAG_CLI).
    TASK_DAG="${TASK_DAG_CLI:-}"
    CLONE_DIR=""
    if [ -z "$TASK_DAG" ]; then
        CLONE_DIR="$(mktemp -d)"
        trap '[ -n "$CLONE_DIR" ] && rm -rf "$CLONE_DIR"' EXIT
        clone_url="https://github.com/virusdave/task-dag"
        if [ -n "${GH_TOKEN:-}" ]; then
            clone_url="https://x-access-token:${GH_TOKEN}@github.com/virusdave/task-dag"
        fi
        # `git clone --branch` rejects a bare SHA, but TASK_DAG_REF may be a
        # branch, tag, OR commit sha — so init + fetch + checkout, which
        # accepts all three. Clone stderr is suppressed because the URL can
        # carry a token; the fetch/checkout errors below are token-free.
        if git init --quiet "$CLONE_DIR/task-dag" >/dev/null 2>&1 \
            && git -C "$CLONE_DIR/task-dag" fetch --quiet --depth 1 \
                    "$clone_url" "${TASK_DAG_REF:-master}" 2>/dev/null \
            && git -C "$CLONE_DIR/task-dag" checkout --quiet FETCH_HEAD 2>/dev/null; then
            TASK_DAG="$CLONE_DIR/task-dag/scripts/task-dag"
        else
            echo "ERROR: could not obtain canonical task-dag CLI (ref '${TASK_DAG_REF:-master}') to enumerate blocked refs" >&2
            SAW_FAILURE=1
        fi
    fi

    if [ -n "$TASK_DAG" ] && [ -x "$TASK_DAG" ]; then
        # Capture the CLI's exit code: a non-zero MUST be loud, never coerced
        # into an empty list (that would silently skip the sweep — the very
        # bug this script fixes).
        # Keep stderr OUT of the captured JSON (benign CLI chatter would
        # otherwise corrupt it); surface it only in the loud error message.
        cli_rc=0 cli_err="$(mktemp)"
        blocked_json="$("$TASK_DAG" blocked --json --no-fetch 2>"$cli_err")" || cli_rc=$?
        if [ "$cli_rc" -ne 0 ]; then
            echo "ERROR: 'task-dag blocked --json' failed (rc=$cli_rc): $(tr '\n' ' ' < "$cli_err")" >&2
            SAW_FAILURE=1
        elif printf '%s' "$blocked_json" | jq -e . >/dev/null 2>&1; then
            # Match resolved issue == N AND (repo empty/legacy OR repo == this repo).
            while IFS= read -r sha; do
                [ -n "$sha" ] && TARGETS["$sha"]=1
            done < <(
                printf '%s' "$blocked_json" | jq -r \
                    --argjson n "$ISSUE_NUM" --arg repo "$GITHUB_REPOSITORY" '
                    .[]
                    | select((.issue // null) == $n)
                    | select((.repo // "") == "" or (.repo == $repo))
                    | .sha'
            )
        else
            echo "ERROR: 'task-dag blocked --json' produced invalid JSON; blocked sweep incomplete" >&2
            SAW_FAILURE=1
        fi
        rm -f "$cli_err"
    elif [ -n "$TASK_DAG" ]; then
        echo "ERROR: task-dag CLI not executable at: $TASK_DAG" >&2
        SAW_FAILURE=1
    fi
else
    echo "ERROR: could not fetch blocked/blocked-meta refs from origin; blocked sweep incomplete (hint SHAs still cleaned)" >&2
    SAW_FAILURE=1
fi

# ---------------------------------------------------------------------------
# Clean the collected targets. Capture the frontier snapshot ONCE first; if
# that read fails we cannot honour the frontier-first invariant, so we skip
# all blocked deletes (loud) rather than risk zombie dispatch.
if [ "${#TARGETS[@]}" -gt 0 ]; then
    if capture_frontier_listing; then
        for sha in "${!TARGETS[@]}"; do
            clean_task_sha "$sha"
        done
    fi
fi

if [ "$SAW_FAILURE" -ne 0 ]; then
    echo "ERROR: one or more blocked-ref cleanups failed for issue #${ISSUE_NUM} (see above)" >&2
    exit 1
fi
echo "Blocked-ref cleanup complete for issue #${ISSUE_NUM}"
