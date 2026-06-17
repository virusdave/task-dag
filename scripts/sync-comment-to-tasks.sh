#!/usr/bin/env bash
# Sync GitHub issue comment to task-dag message task
# Part of Nicponskis/shared-workflows

set -euo pipefail

# Required environment variables:
# - GITHUB_TOKEN
# - ISSUE_NUMBER
# - ISSUE_REPO
# - COMMENT_ID
# - COMMENT_BODY
# - COMMENT_URL
# - COMMENT_AUTHOR
# - MAX_COMMENT_SIZE (optional, default 2048)
# - ENABLE_AUTO_FRONTIER (optional, default true)
#
# Optional (used when auto-creating an epic because none exists yet):
# - ISSUE_TITLE
# - ISSUE_BODY
# - ISSUE_URL
# - ISSUE_AUTHOR
# If these are absent, the script falls back to GET /repos/.../issues/N
# via the GitHub API so the auto-created epic still carries the original
# issue body, title, and author -- otherwise agents would be left with a
# placeholder and no idea what the issue is about.

MAX_COMMENT_SIZE="${MAX_COMMENT_SIZE:-2048}"
ENABLE_AUTO_FRONTIER="${ENABLE_AUTO_FRONTIER:-true}"
EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" >&2
}

# Anti-loop check: ignore bot/agent comments — EXCEPT the structured
# cross-repo completion signal posted by aggregate-cross-repo-completions.
# That comment intentionally carries a <!-- task-dag:completion --> marker
# precisely so it can be ingested as a first-class task-dag event; the
# old blanket skip was the silent-drop failure mode the new design
# explicitly forbids.
if echo "$COMMENT_BODY" | grep -q "<!-- task-dag:"; then
    if echo "$COMMENT_BODY" | head -n1 | grep -q "<!-- task-dag:completion -->"; then
        log "Cross-repo completion comment detected; will ingest"
    else
        log "Skipping agent comment (has task-dag marker other than :completion)"
        exit 0
    fi
fi

# Delegate all comment ingestion to the canonical task-dag CLI so the
# smart logic lives in ONE place (completion routing -> ingest-completion,
# leading-`<!--`-marker skip, human-comment minting). The CLI is sourced
# in this order:
#   1. a vendored `./scripts/task-dag` in the target repo (transitional —
#      most repos have retired it per the CLI-distribution migration), or
#   2. the canonical CLI downloaded from the task-dag repo into a temp dir.
#
# The standalone inline fallback further below predates the CLI and does
# NOT route cross-repo completion comments: it silently drops the
# completion and mints a junk `intent: clarification` task (the dispatch
# loop — virusdave/top-level#20). So we try hard to obtain the real CLI and
# only fall through to the inline path if it is genuinely unreachable.
TASK_DAG_REPO="${TASK_DAG_REPO:-virusdave/task-dag}"
TASK_DAG_REF="${TASK_DAG_REF:-master}"
TASK_DAG_CLI_TMPDIR=""

cli_has_ingest_comment() {
    "$1" help 2>&1 | grep -q '^[[:space:]]*ingest-comment'
}

# Sets globals TASK_DAG_CLI (path to an executable CLI with ingest-comment)
# and, when downloaded, TASK_DAG_CLI_TMPDIR (caller removes it). Returns 0
# on success, 1 if no CLI could be obtained. NOT run in a subshell so the
# temp-dir global survives for cleanup.
TASK_DAG_CLI=""
resolve_task_dag_cli() {
    # 1. Vendored copy in the target repo (transitional fallback).
    if [ -x "./scripts/task-dag" ] && cli_has_ingest_comment "./scripts/task-dag"; then
        TASK_DAG_CLI="./scripts/task-dag"
        return 0
    fi

    # 2. Download the canonical CLI (script + its task-dag.d/ modules).
    local dir base
    dir="$(mktemp -d)"
    base="https://raw.githubusercontent.com/${TASK_DAG_REPO}/${TASK_DAG_REF}/scripts"
    mkdir -p "$dir/task-dag.d"
    if curl -fsSL "$base/task-dag"                  -o "$dir/task-dag" \
        && curl -fsSL "$base/task-dag.d/cross-repo.sh" -o "$dir/task-dag.d/cross-repo.sh"; then
        # phase-gates.conf is optional config; absence must not fail.
        curl -fsSL "$base/task-dag.d/phase-gates.conf" -o "$dir/task-dag.d/phase-gates.conf" 2>/dev/null || true
        chmod +x "$dir/task-dag"
        if cli_has_ingest_comment "$dir/task-dag"; then
            TASK_DAG_CLI_TMPDIR="$dir"
            TASK_DAG_CLI="$dir/task-dag"
            return 0
        fi
    fi
    rm -rf "$dir"
    return 1
}

if resolve_task_dag_cli; then
    BODY_FILE="$(mktemp)"
    printf '%s' "$COMMENT_BODY" > "$BODY_FILE"

    # Configure git for any refs/commits the CLI will push.
    git config user.name "github-actions[bot]"
    git config user.email "github-actions[bot]@users.noreply.github.com"

    log "Delegating to ${TASK_DAG_CLI} ingest-comment (task-dag@${TASK_DAG_REF})"
    rc=0
    "$TASK_DAG_CLI" ingest-comment \
        --issue "$ISSUE_NUMBER" \
        --comment-id "$COMMENT_ID" \
        --author "$COMMENT_AUTHOR" \
        --comment-url "$COMMENT_URL" \
        --body-file "$BODY_FILE" || rc=$?

    rm -f "$BODY_FILE"
    [ -n "$TASK_DAG_CLI_TMPDIR" ] && rm -rf "$TASK_DAG_CLI_TMPDIR"
    exit "$rc"
fi

log "WARNING: could not obtain the task-dag CLI (vendored or downloaded from ${TASK_DAG_REPO}@${TASK_DAG_REF}); falling back to inline ingestion. Cross-repo completion comments will NOT be routed by this path."

# Check if this comment was already processed
STATE_DIR=".github/task-dag-state"
mkdir -p "$STATE_DIR"
PROCESSED_FILE="$STATE_DIR/processed_comments.txt"
touch "$PROCESSED_FILE"

if grep -q "^${COMMENT_ID}$" "$PROCESSED_FILE"; then
    log "Comment $COMMENT_ID already processed, skipping"
    exit 0
fi

# Configure git
git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

# Resolve epic task.
#
# GitHub refuses pushes to refs outside the standard pushable namespaces
# (refs/heads/* and refs/tags/*) -- attempting to push refs/gh/* yields
# "deny updating a hidden ref". We therefore keep the conceptual
# refs/gh/... layout but materialise the refs under refs/heads/gh/...
# so they can be pushed back to origin and observed by other agents.
# refs/heads/tasks/pending/<N> remains the canonical agent-visible
# pointer to the epic SHA; refs/heads/gh/issues/<N> is the GitHub-side
# mapping that lets the comment-sync script find an existing epic for
# an issue without walking the DAG.
EPIC_REF="refs/heads/gh/issues/${ISSUE_NUMBER}"
if git show-ref --verify --quiet "$EPIC_REF"; then
    EPIC_SHA=$(git rev-parse "$EPIC_REF")
    log "Found epic task: $EPIC_SHA"
else
    log "WARNING: No epic task found for issue #${ISSUE_NUMBER}, creating one"

    # The auto-created epic MUST carry the original issue's body so that
    # agents picking it up know what to actually do. Prefer env vars
    # injected by the workflow (github.event.issue.*); if those are
    # missing (older workflow caller), fall back to a GitHub API fetch.
    ISSUE_TITLE="${ISSUE_TITLE:-}"
    ISSUE_BODY="${ISSUE_BODY:-}"
    ISSUE_URL="${ISSUE_URL:-https://github.com/${ISSUE_REPO}/issues/${ISSUE_NUMBER}}"
    ISSUE_AUTHOR="${ISSUE_AUTHOR:-}"

    if [ -z "$ISSUE_BODY" ] || [ -z "$ISSUE_TITLE" ] || [ -z "$ISSUE_AUTHOR" ]; then
        log "Issue metadata missing from env, fetching from GitHub API"
        API_RESPONSE=$(curl -fsSL \
            -H "Authorization: token ${GITHUB_TOKEN}" \
            -H "Accept: application/vnd.github+json" \
            "https://api.github.com/repos/${ISSUE_REPO}/issues/${ISSUE_NUMBER}" \
            2>/dev/null || echo '{}')
        [ -z "$ISSUE_TITLE" ]  && ISSUE_TITLE=$(echo "$API_RESPONSE"  | jq -r '.title // ""')
        [ -z "$ISSUE_BODY" ]   && ISSUE_BODY=$(echo "$API_RESPONSE"   | jq -r '.body // ""')
        [ -z "$ISSUE_AUTHOR" ] && ISSUE_AUTHOR=$(echo "$API_RESPONSE" | jq -r '.user.login // ""')
    fi

    # Ensure a non-empty body so downstream tools don't choke on missing
    # YAML scalars; loudly mark the fallback so a human can investigate.
    if [ -z "$ISSUE_BODY" ]; then
        log "ERROR: Could not obtain issue body for #${ISSUE_NUMBER} from env or API"
        ISSUE_BODY="(ERROR: Original issue body could not be retrieved when this epic was auto-created. See ${ISSUE_URL})"
    fi

    # Indent each body line by two spaces for the YAML block scalar.
    EPIC_BODY_INDENTED=$(echo "$ISSUE_BODY" | sed 's/^/  /')

    EPIC_MSG="kind: epic
role: human
intent: issue

issue:
  number: ${ISSUE_NUMBER}
  repo: ${ISSUE_REPO}
  title: ${ISSUE_TITLE}
  url: ${ISSUE_URL}

github:
  actor: ${ISSUE_AUTHOR:-unknown}

body: |
${EPIC_BODY_INDENTED}"

    CURRENT_HEAD=$(git rev-parse HEAD)
    EPIC_SHA=$(echo "$EPIC_MSG" | git commit-tree "$EMPTY_TREE" -p "$CURRENT_HEAD")
    git update-ref "$EPIC_REF" "$EPIC_SHA"
    git update-ref "refs/heads/tasks/pending/${ISSUE_NUMBER}" "$EPIC_SHA"
    log "Created epic task: $EPIC_SHA"
fi

# Detect reply context (simplified for V1)
REPLY_TO_COMMENT_ID=""
# TODO: Parse quoted comment URLs from COMMENT_BODY

# Create message task commit
MESSAGE_ID="msg_$(date +%s)_${COMMENT_ID}"

# Truncate body if needed
BODY_LENGTH=${#COMMENT_BODY}
if [ "$BODY_LENGTH" -gt "$MAX_COMMENT_SIZE" ]; then
    log "WARNING: Comment body truncated from $BODY_LENGTH to $MAX_COMMENT_SIZE bytes"
    COMMENT_BODY="${COMMENT_BODY:0:$MAX_COMMENT_SIZE}

[... truncated ...]"
fi

MESSAGE_TASK="kind: message
role: human
intent: clarification

issue:
  number: ${ISSUE_NUMBER}
  repo: ${ISSUE_REPO}

github:
  comment_id: ${COMMENT_ID}
  actor: ${COMMENT_AUTHOR}
  url: ${COMMENT_URL}

conversation:
  reply_to_comment_id: ${REPLY_TO_COMMENT_ID}
  thread_root_comment_id: ${COMMENT_ID}

flags:
  post_to_github: false

message_id: ${MESSAGE_ID}

body: |
$(echo "$COMMENT_BODY" | sed 's/^/  /')"

MESSAGE_SHA=$(echo "$MESSAGE_TASK" | git commit-tree "$EMPTY_TREE" -p "$EPIC_SHA")

log "Created message task: $MESSAGE_SHA"

# Create mapping ref (under refs/heads/gh so it is pushable; see comment
# at EPIC_REF above for why refs/gh/* cannot be used directly).
COMMENT_REF="refs/heads/gh/comments/${ISSUE_NUMBER}/${COMMENT_ID}"
git update-ref "$COMMENT_REF" "$MESSAGE_SHA"

# Mark as frontier if auto-frontier enabled and no reply context
if [ "$ENABLE_AUTO_FRONTIER" = "true" ] && [ -z "$REPLY_TO_COMMENT_ID" ]; then
    FRONTIER_REF="refs/heads/tasks/frontier/$(git rev-parse --short $MESSAGE_SHA)"
    git update-ref "$FRONTIER_REF" "$MESSAGE_SHA"
    log "Marked as frontier: $FRONTIER_REF"
fi

# Record as processed
echo "$COMMENT_ID" >> "$PROCESSED_FILE"
git add "$PROCESSED_FILE"
git commit -m "Track processed comment $COMMENT_ID" || true

# Push refs
git push origin "$COMMENT_REF" || log "WARNING: Failed to push comment ref"
if [ "$ENABLE_AUTO_FRONTIER" = "true" ] && [ -z "$REPLY_TO_COMMENT_ID" ]; then
    git push origin "$FRONTIER_REF" || log "WARNING: Failed to push frontier ref"
fi

log "Successfully synced comment $COMMENT_ID to task-dag"
