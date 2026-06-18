#!/usr/bin/env bash
# Operator-blocked dashboard renderer (virusdave/top-level#29, epic
# operator-blocked-aggregator task @5).
#
# Scans each configured fleet repo's task-dag blocked refs, renders ONE
# deterministic Markdown dashboard of everything currently blocked on the
# operator, and find/create/patches a single marked comment on the target
# issue. No-ops when the rendered content is unchanged.
#
# Source of truth is the per-repo `refs/heads/tasks/blocked/*` (+
# `tasks/blocked-meta/*`) overlay that `task-dag block` already maintains
# (see EPIC_PLAN.md). We DO NOT reparse commit bodies here: every field
# comes from `task-dag blocked --json`, which task @4 enriched for exactly
# this consumer. An item leaves the dashboard automatically on the next
# run once its blocked ref is gone (unblock / complete / drop).
#
# Why git-fetch (not the refs API): rendering reuses `task-dag blocked
# --json`, which needs the actual task + blocked-meta commit objects, not
# just ref SHAs. A shallow fetch of the two ref globs brings exactly those
# objects. Authenticated reads use the GitHub App installation token
# (Contents: read — the permission the preflight verified) the same way
# `gh api` uses it for the comment write.
#
# Required env:
#   GH_TOKEN   GitHub App installation token (or PAT in dev). Used both to
#              build authenticated git fetch URLs and by `gh api` for the
#              comment write. Optional only with --dry-run + explicit
#              per-repo `=<giturl>` overrides (e.g. fixture tests).
#
# Usage:
#   operator-blocked-dashboard.sh \
#       --target-repo=virusdave/top-level --target-issue=29 \
#       --repos="virusdave/top-level virusdave/task-dag FreshlyBakedNYC/automation ..."
#
# See `--help` for all options.

set -euo pipefail

# ---------------------------------------------------------------------------
# Markers. The first line MUST be the status marker so the comment is never
# re-ingested as a task by sync-comment-to-task; the second uniquely
# identifies THIS dashboard comment so we can find/patch it idempotently.
STATUS_MARKER='<!-- task-dag:status -->'
DASHBOARD_MARKER='<!-- operator-blocked-dashboard:v1 -->'

GIT_HOST_BASE="${GIT_HOST_BASE:-https://github.com}"

log()  { echo "[$(date -u +%FT%TZ)] $*" >&2; }
warn() { echo "::warning::$*" >&2; }
die()  { echo "::error::$*" >&2; exit 1; }

usage() {
    cat <<EOF
Usage: operator-blocked-dashboard.sh --target-repo=O/R --target-issue=N \\
           --repos="o/r1 o/r2[=<giturl>] ..." [options]

Render the operator-blocked dashboard from fleet repos' task-dag blocked
refs and publish it as one marked comment on the target issue.

Required:
  --target-repo=OWNER/REPO   Repo whose issue hosts the dashboard comment.
  --target-issue=N           Issue number for the dashboard comment.
  --repos="..."              Space/comma list of repos to scan. Each entry
                             is "owner/repo" or "owner/repo=<git-fetch-url>"
                             (the override is mainly for fixture tests).
  --repos-file=FILE          Alternative: one repo entry per line.

Options:
  --task-dag=PATH            Path to the task-dag CLI (default: the copy
                             next to this script).
  --dry-run                  Render to stdout only; never touch GitHub.
  --output=FILE              Also write the rendered body to FILE.
  -h, --help                 This help.

Environment:
  GH_TOKEN                   GitHub App installation token (or PAT). Used to
                             build authenticated git fetch URLs and for the
                             gh api comment write.
  GIT_HOST_BASE              Git host base (default https://github.com).

The published comment always begins with:
  ${STATUS_MARKER}
  ${DASHBOARD_MARKER}
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing.
TARGET_REPO=""
TARGET_ISSUE=""
REPOS_RAW=""
REPOS_FILE=""
DRY_RUN=false
OUTPUT_FILE=""
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASK_DAG="${HERE}/task-dag"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --target-repo=*)  TARGET_REPO="${1#*=}"; shift ;;
        --target-issue=*) TARGET_ISSUE="${1#*=}"; shift ;;
        --repos=*)        REPOS_RAW="${1#*=}"; shift ;;
        --repos-file=*)   REPOS_FILE="${1#*=}"; shift ;;
        --task-dag=*)     TASK_DAG="${1#*=}"; shift ;;
        --dry-run)        DRY_RUN=true; shift ;;
        --output=*)       OUTPUT_FILE="${1#*=}"; shift ;;
        -h|--help)        usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

command -v jq  >/dev/null 2>&1 || die "jq is required"
command -v git >/dev/null 2>&1 || die "git is required"
[ -x "$TASK_DAG" ] || die "task-dag CLI not found/executable at: $TASK_DAG"

[ -n "$TARGET_REPO" ]  || { echo "--target-repo is required" >&2; usage >&2; exit 2; }
[ -n "$TARGET_ISSUE" ] || { echo "--target-issue is required" >&2; usage >&2; exit 2; }

# Assemble the repo list (de-duplicated, order-preserving).
REPO_ENTRIES=()
add_repo_entry() {
    local e="$1"
    [ -n "$e" ] || return 0
    local existing
    for existing in "${REPO_ENTRIES[@]:-}"; do
        [ "$existing" = "$e" ] && return 0
    done
    REPO_ENTRIES+=("$e")
}
if [ -n "$REPOS_FILE" ]; then
    [ -f "$REPOS_FILE" ] || die "--repos-file not found: $REPOS_FILE"
    while IFS= read -r line; do
        line="${line%%#*}"                       # strip comments
        line="$(printf '%s' "$line" | tr -d '[:space:]')"
        add_repo_entry "$line"
    done < "$REPOS_FILE"
fi
# Split --repos on whitespace and commas.
if [ -n "$REPOS_RAW" ]; then
    REPOS_RAW="${REPOS_RAW//,/ }"
    for entry in $REPOS_RAW; do
        add_repo_entry "$entry"
    done
fi
[ "${#REPO_ENTRIES[@]}" -gt 0 ] || die "no repos to scan (pass --repos or --repos-file)"

# ---------------------------------------------------------------------------
# Collect enriched blocked JSON across all repos.
#
# For each repo we fetch ONLY the blocked + blocked-meta ref globs into a
# throwaway local repo, then run `task-dag blocked --json --no-fetch`
# there. Each emitted object is tagged with `scanRepo` (the repo we
# actually read it from) so the dashboard's repo column is authoritative
# even for legacy refs whose commit body lacks an origin.
WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# Build a fetch URL for a repo entry "owner/repo" or "owner/repo=url".
fetch_url_for() {
    local entry="$1"
    if [[ "$entry" == *"="* ]]; then
        printf '%s' "${entry#*=}"
        return 0
    fi
    if [ -n "${GH_TOKEN:-}" ]; then
        printf 'https://x-access-token:%s@%s/%s.git' \
            "$GH_TOKEN" "${GIT_HOST_BASE#https://}" "$entry"
    else
        printf '%s/%s.git' "$GIT_HOST_BASE" "$entry"
    fi
}

ALL_JSON="$WORK/all.json"
echo "[]" > "$ALL_JSON"

scanned=0
for entry in "${REPO_ENTRIES[@]}"; do
    repo="${entry%%=*}"
    url="$(fetch_url_for "$entry")"
    sandbox="$WORK/repos/$repo"
    mkdir -p "$sandbox"
    git -C "$sandbox" init -q

    if ! git -C "$sandbox" fetch --quiet --no-tags "$url" \
            '+refs/heads/tasks/blocked/*:refs/heads/tasks/blocked/*' \
            '+refs/heads/tasks/blocked-meta/*:refs/heads/tasks/blocked-meta/*' \
            2>"$sandbox/fetch.err"; then
        warn "failed to fetch blocked refs from $repo: $(tr '\n' ' ' < "$sandbox/fetch.err")"
        continue
    fi
    scanned=$((scanned + 1))

    repo_json="$(cd "$sandbox" && "$TASK_DAG" blocked --json --no-fetch 2>/dev/null || echo '[]')"
    if ! printf '%s' "$repo_json" | jq -e . >/dev/null 2>&1; then
        warn "blocked --json produced invalid JSON for $repo; skipping"
        continue
    fi

    # Tag every entry with the repo we read it from and merge into ALL_JSON.
    jq -s --arg r "$repo" \
        '(.[0]) + ((.[1] // []) | map(. + {scanRepo: $r}))' \
        "$ALL_JSON" <(printf '%s' "$repo_json") > "$WORK/merge.json"
    mv "$WORK/merge.json" "$ALL_JSON"
done

[ "$scanned" -gt 0 ] || die "could not read blocked refs from any configured repo"
log "scanned $scanned repo(s); $(jq 'length' "$ALL_JSON") blocked task(s) total"

# ---------------------------------------------------------------------------
# Render the deterministic Markdown body.
#
# Layout (EPIC_PLAN "Dashboard comment format"):
#   * operator blockers (kind=operator) -> the main "needs you" table;
#   * legacy/unknown blockers (no metadata) -> a separate section for
#     triage (they MIGHT need the operator);
#   * downstream blockers (kind=downstream) are intentionally omitted —
#     they wait on other tasks, not on the operator.
# Sort key is deterministic: (repo, issue, blockedAt, sha).

# jq helpers shared by both tables. `dispRepo` prefers the commit-derived
# repo (where the issue actually lives) and falls back to scanRepo.
read -r -d '' JQ_COMMON <<'JQ' || true
def dispRepo: (.repo // .scanRepo // "—");
def cell($s): ($s // "") | tostring | gsub("\\|"; "\\|") | gsub("[\n\r]"; " ");
def issueCell:
  if (.issueUrl // "") != "" and (.issue // null) != null then "[#\(.issue)](\(.issueUrl))"
  elif (.issue // null) != null then "#\(.issue)"
  else "—" end;
def taskCell: "`\(.shortSha)` — " + cell(.title);
def sortKey: [ (dispRepo|ascii_downcase), ((.issue // 0)|tostring), (.blockedAt // ""), (.sha // "") ];
JQ

operator_rows() {
    jq -r "$JQ_COMMON"'
        map(select(.kind == "operator"))
        | sort_by(sortKey)
        | .[]
        | "| " + ([
            dispRepo,
            issueCell,
            taskCell,
            cell(.reason // "—"),
            ( if (.requestUrl // "") != "" then "[request](\(.requestUrl))"
              elif (.issueUrl // "") != "" then "[issue](\(.issueUrl))"
              else "—" end )
          ] | join(" | ")) + " |"
    ' "$ALL_JSON"
}

legacy_rows() {
    jq -r "$JQ_COMMON"'
        map(select(.hasMeta == false))
        | sort_by(sortKey)
        | .[]
        | "| " + ([ dispRepo, issueCell, taskCell ] | join(" | ")) + " |"
    ' "$ALL_JSON"
}

OP_COUNT=$(jq '[.[] | select(.kind == "operator")] | length' "$ALL_JSON")
LEGACY_COUNT=$(jq '[.[] | select(.hasMeta == false)] | length' "$ALL_JSON")

BODY_FILE="$WORK/body.md"
{
    echo "$STATUS_MARKER"
    echo "$DASHBOARD_MARKER"
    echo
    echo "# Operator-blocked tasks"
    echo
    echo "_Last rebuilt: $(date -u +%FT%TZ)_"
    echo
    echo "> Reply on the linked source issue/comment, not here. This comment is"
    echo "> generated from task-dag blocked refs; resolved items disappear after"
    echo "> \`unblock\`/\`complete\`/\`drop\`."
    echo
    if [ "$OP_COUNT" -eq 0 ] && [ "$LEGACY_COUNT" -eq 0 ]; then
        echo "✅ Nothing is currently blocked on the operator."
    else
        echo "| Repo | Issue | Blocked task | Needed from operator | Source |"
        echo "|---|---:|---|---|---|"
        if [ "$OP_COUNT" -gt 0 ]; then
            operator_rows
        else
            echo "| _none_ | | | | |"
        fi
        if [ "$LEGACY_COUNT" -gt 0 ]; then
            echo
            echo "### Legacy blocked refs (no metadata)"
            echo
            echo "These were parked before durable operator/downstream metadata"
            echo "existed; reclassify with \`task-dag block --operator\`/\`--downstream\`,"
            echo "or clear with \`unblock\`/\`drop\`."
            echo
            echo "| Repo | Issue | Blocked task |"
            echo "|---|---:|---|"
            legacy_rows
        fi
    fi
} > "$BODY_FILE"

if [ -n "$OUTPUT_FILE" ]; then
    cp "$BODY_FILE" "$OUTPUT_FILE"
    log "wrote rendered body to $OUTPUT_FILE"
fi

if [ "$DRY_RUN" = true ]; then
    cat "$BODY_FILE"
    log "dry-run: not posting to ${TARGET_REPO}#${TARGET_ISSUE}"
    exit 0
fi

# ---------------------------------------------------------------------------
# Publish: find the marked comment, then no-op / patch / create.
command -v gh >/dev/null 2>&1 || die "gh is required to publish (use --dry-run to skip)"

# Strip the volatile timestamp line so an otherwise-identical rebuild is a
# no-op (we don't churn the comment just to bump the clock).
strip_volatile() { grep -v '^_Last rebuilt: ' || true; }

existing="$(
    gh api --paginate "repos/${TARGET_REPO}/issues/${TARGET_ISSUE}/comments?per_page=100" \
        | jq -s --arg m "$DASHBOARD_MARKER" \
            'add | map(select(.body | contains($m))) | first // empty'
)"

new_norm="$(strip_volatile < "$BODY_FILE")"

if [ -n "$existing" ]; then
    comment_id="$(printf '%s' "$existing" | jq -r '.id')"
    old_body="$(printf '%s' "$existing" | jq -r '.body')"
    old_norm="$(printf '%s' "$old_body" | strip_volatile)"
    if [ "$old_norm" = "$new_norm" ]; then
        log "dashboard unchanged on ${TARGET_REPO}#${TARGET_ISSUE} (comment ${comment_id}); no-op"
        exit 0
    fi
    url="$(
        jq -n --rawfile b "$BODY_FILE" '{body: $b}' \
            | gh api --method PATCH \
                -H "Accept: application/vnd.github+json" \
                "repos/${TARGET_REPO}/issues/comments/${comment_id}" \
                --input - --jq .html_url
    )" || die "failed to patch dashboard comment ${comment_id} on ${TARGET_REPO}#${TARGET_ISSUE}"
    log "patched dashboard comment: $url"
else
    url="$(
        jq -n --rawfile b "$BODY_FILE" '{body: $b}' \
            | gh api --method POST \
                -H "Accept: application/vnd.github+json" \
                "repos/${TARGET_REPO}/issues/${TARGET_ISSUE}/comments" \
                --input - --jq .html_url
    )" || die "failed to create dashboard comment on ${TARGET_REPO}#${TARGET_ISSUE}"
    log "created dashboard comment: $url"
fi
