#!/usr/bin/env bash
# Sync a GitHub issue comment into the task-dag DAG.
# Part of Nicponskis/shared-workflows; downloaded and run by the reusable
# virusdave/task-dag:.github/workflows/sync-comment-to-task.yml against the
# caller repo's checkout.
#
# This script is intentionally a THIN shim: it obtains the canonical task-dag
# CLI and delegates everything to `task-dag ingest-comment`, which is the
# single home for the real logic (cross-repo completion routing, leading-
# marker machine-comment skipping, and human-comment minting).
#
# There is deliberately NO vendored-`./scripts/task-dag` preference and NO
# inline reimplementation fallback. No repo vendors task-dag tooling anymore;
# a tempting-but-divergent local copy or inline path only invites future
# agents to use the wrong thing (it is what produced the dispatch loop in
# virusdave/top-level#20: the old inline fallback minted junk
# `intent: clarification` tasks and silently dropped cross-repo completions).
# If the canonical CLI cannot be obtained, FAIL LOUD rather than fall back.

set -euo pipefail

# Required environment variables:
# - GITHUB_TOKEN     (token for git push + gh API; the CLI uses it)
# - ISSUE_NUMBER
# - COMMENT_ID
# - COMMENT_BODY
# - COMMENT_URL
# - COMMENT_AUTHOR
#
# Optional:
# - TASK_DAG_REPO    (default: virusdave/task-dag) — where to fetch the CLI
# - TASK_DAG_REF     (default: master)            — which ref of the CLI

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" >&2
}

TASK_DAG_REPO="${TASK_DAG_REPO:-virusdave/task-dag}"
TASK_DAG_REF="${TASK_DAG_REF:-master}"

# Download the canonical CLI (the `task-dag` entrypoint plus its task-dag.d/
# modules, which it sources relative to itself) into TASK_DAG_CLI_DIR and set
# TASK_DAG_CLI to the executable. Returns non-zero (without setting
# TASK_DAG_CLI) if anything is missing. Each step is checked explicitly so a
# failure is caught regardless of `set -e` suppression in the caller's `if`.
TASK_DAG_CLI=""
TASK_DAG_CLI_DIR=""
download_task_dag_cli() {
    local base
    TASK_DAG_CLI_DIR="$(mktemp -d)"
    base="https://raw.githubusercontent.com/${TASK_DAG_REPO}/${TASK_DAG_REF}/scripts"
    mkdir -p "$TASK_DAG_CLI_DIR/task-dag.d"
    curl -fsSL "$base/task-dag"                    -o "$TASK_DAG_CLI_DIR/task-dag"                || return 1
    curl -fsSL "$base/task-dag.d/cross-repo.sh"    -o "$TASK_DAG_CLI_DIR/task-dag.d/cross-repo.sh" || return 1
    # phase-gates.conf is optional config; its absence must not fail the run.
    curl -fsSL "$base/task-dag.d/phase-gates.conf" -o "$TASK_DAG_CLI_DIR/task-dag.d/phase-gates.conf" 2>/dev/null || true
    chmod +x "$TASK_DAG_CLI_DIR/task-dag" || return 1
    # Sanity-check it loaded its modules and exposes ingest-comment.
    "$TASK_DAG_CLI_DIR/task-dag" help 2>&1 | grep -q '^[[:space:]]*ingest-comment' || return 1
    TASK_DAG_CLI="$TASK_DAG_CLI_DIR/task-dag"
    return 0
}

if ! download_task_dag_cli; then
    log "FATAL: could not obtain the task-dag CLI from ${TASK_DAG_REPO}@${TASK_DAG_REF}. Refusing to fall back to inline ingestion (that path mints junk tasks and drops completions). Fix CLI reachability and re-run."
    [ -n "$TASK_DAG_CLI_DIR" ] && rm -rf "$TASK_DAG_CLI_DIR"
    exit 1
fi
trap 'rm -rf "$TASK_DAG_CLI_DIR"' EXIT

# Configure git for the refs/commits the CLI will push.
git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

BODY_FILE="$(mktemp)"
printf '%s' "$COMMENT_BODY" > "$BODY_FILE"
trap 'rm -rf "$TASK_DAG_CLI_DIR" "$BODY_FILE"' EXIT

log "Delegating to task-dag ingest-comment (${TASK_DAG_REPO}@${TASK_DAG_REF})"
"$TASK_DAG_CLI" ingest-comment \
    --issue "$ISSUE_NUMBER" \
    --comment-id "$COMMENT_ID" \
    --author "$COMMENT_AUTHOR" \
    --comment-url "$COMMENT_URL" \
    --body-file "$BODY_FILE"
