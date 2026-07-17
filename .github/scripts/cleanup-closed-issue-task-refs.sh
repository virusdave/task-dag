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

usage() {
    cat <<'EOF'
Usage: cleanup-closed-issue-task-refs.sh <issue-number> [<extra-task-sha> ...]

Clean lingering task-dag scheduling refs for a confirmed-closed issue by
delegating to the canonical task-dag reconcile-closed-issue command. Extra
task SHAs are passed as --hint-sha values so the epic-close path still tries
to clean the matched epic root by name (after same-issue verification) even if
the general candidate scan is incomplete; that incomplete sweep remains a loud
non-zero exit.
EOF
}

case "${1:-}" in
    --help|-h) usage; exit 0 ;;
esac

ISSUE_NUM="${1:-}"
[ -n "$ISSUE_NUM" ] || { echo "ERROR: <issue-number> is required" >&2; exit 2; }
[[ "$ISSUE_NUM" =~ ^[0-9]+$ ]] || { echo "ERROR: <issue-number> must be numeric, got: $ISSUE_NUM" >&2; exit 2; }
shift || true
HINT_SHAS=("$@")
for hint_sha in "${HINT_SHAS[@]}"; do
    [[ "$hint_sha" =~ ^[0-9a-fA-F]{40}$ ]] || { echo "ERROR: extra task SHAs must be full 40-hex values, got: $hint_sha" >&2; exit 2; }
done

_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_migration_lib="$_here/../../scripts/task-dag.d/semantic-migration.sh"
[ -r "$_migration_lib" ] || { echo "ERROR: coherent semantic migration guard not found: $_migration_lib" >&2; exit 1; }
# shellcheck source=/dev/null
source "$_migration_lib"
taskdag_migration_guard projection || exit $?
unset _here _migration_lib

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required (owner/repo for the repo match)}"

command -v git >/dev/null 2>&1 || { echo "ERROR: git is required" >&2; exit 2; }

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
    # branch, tag, OR commit sha — so init + fetch + checkout, which accepts
    # all three. Clone stderr is suppressed because the URL can carry a token;
    # the fetch/checkout errors below are token-free.
    if git init --quiet "$CLONE_DIR/task-dag" >/dev/null 2>&1 \
        && git -C "$CLONE_DIR/task-dag" fetch --quiet --depth 1 \
                "$clone_url" "${TASK_DAG_REF:-master}" 2>/dev/null \
        && git -C "$CLONE_DIR/task-dag" checkout --quiet FETCH_HEAD 2>/dev/null; then
        TASK_DAG="$CLONE_DIR/task-dag/scripts/task-dag"
    else
        echo "ERROR: could not obtain canonical task-dag CLI (ref '${TASK_DAG_REF:-master}') to reconcile closed-issue refs" >&2
        exit 1
    fi
fi

[ -x "$TASK_DAG" ] || { echo "ERROR: task-dag CLI not executable at: $TASK_DAG" >&2; exit 1; }

hint_args=()
for sha in "${HINT_SHAS[@]}"; do
    [ -n "$sha" ] && hint_args+=("--hint-sha=$sha")
done

"$TASK_DAG" reconcile-closed-issue "$ISSUE_NUM" \
    --repo="$GITHUB_REPOSITORY" \
    --yes \
    "${hint_args[@]}"
