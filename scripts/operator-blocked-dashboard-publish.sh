#!/usr/bin/env bash
# Operator-blocked dashboard publisher / GitHub App token front-end
# (virusdave/top-level#29, epic operator-blocked-aggregator task @6).
#
# This is the thin, CI-facing wrapper around the renderer
# (scripts/operator-blocked-dashboard.sh, task @5). The renderer already
# knows how to scan a list of repos' task-dag blocked refs and
# find/create/patch ONE dashboard comment; the only thing it can't do by
# itself is authenticate to MULTIPLE GitHub accounts at once. That is this
# script's whole job.
#
# Why a separate front-end: the fleet's operator-blocked tasks live in
# repos owned by several different accounts (e.g. `virusdave/*`,
# `Nicponskis/*`, `FreshlyBakedNYC/*` — see the epic's
# PREFLIGHT_AUTH_AND_INVENTORY.md). A single GitHub App installation token
# only ever covers ONE account, so a single token cannot read blocked refs
# across accounts. We therefore mint one installation token per scanned
# repo from the App's private key (the same JWT -> installation-token dance
# `top-level/.github/scripts/materialise-child-epics.sh` already uses) and
# hand each repo to the renderer as an `owner/repo=<authenticated-url>`
# override (the override hook the renderer exposes for exactly this). The
# comment write uses a separate Issues:write token minted on the target
# repo.
#
# Graceful degradation: if a repo's token can't be minted (e.g. an org
# installation hasn't accepted Contents:read yet — epic task @2), that repo
# is WARNED and SKIPPED rather than failing the whole run, mirroring the
# renderer's per-repo fetch resilience. So the dashboard works for the
# already-authorised accounts today and automatically picks up the rest
# once their permissions land.
#
# Offline / dev / test path: any repo entry that already contains `=`
# (a `owner/repo=<giturl>` override) is passed through untouched and never
# triggers minting; if GH_TOKEN is already set in the environment it is
# reused for the comment write instead of minting one. This lets the
# fixture test drive the full pipeline against file:// repos with no
# network and no App key.
#
# Required env (production):
#   APP_ID            GitHub App ID (numeric).
#   APP_PRIVATE_KEY   PEM-encoded private key for that App.
# Optional env:
#   GH_TOKEN          Pre-supplied token for the comment write (dev/test);
#                     when set, the publish token is NOT minted.
#   GIT_HOST_BASE     Git host base (default https://github.com).
#   GH_API_BASE       GitHub API base (default https://api.github.com).
#
# Usage:
#   operator-blocked-dashboard-publish.sh \
#       --target-repo=virusdave/top-level --target-issue=29 \
#       --repos="virusdave/top-level virusdave/task-dag Nicponskis/nixos-sbc ..."
#
# See `--help` for all options. Unrecognised options are forwarded to the
# renderer (so --dry-run / --output just work).

set -euo pipefail

GIT_HOST_BASE="${GIT_HOST_BASE:-https://github.com}"
GH_API_BASE="${GH_API_BASE:-https://api.github.com}"

log()  { echo "[$(date -u +%FT%TZ)] $*" >&2; }
warn() { echo "::warning::$*" >&2; }
die()  { echo "::error::$*" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RENDERER="${OBD_RENDERER:-$HERE/operator-blocked-dashboard.sh}"
TASK_DAG="${TASK_DAG:-$HERE/task-dag}"

usage() {
    cat <<EOF
Usage: operator-blocked-dashboard-publish.sh \\
           --target-repo=OWNER/REPO --target-issue=N \\
           --repos="o/r1 o/r2 ..." [renderer options...]

Mint per-account GitHub App installation tokens and publish the
operator-blocked dashboard via scripts/operator-blocked-dashboard.sh.

Required:
  --target-repo=OWNER/REPO   Repo whose issue hosts the dashboard comment.
  --target-issue=N           Issue number for the dashboard comment.
  --repos="..."              Space/comma list of repos to scan. A bare
                             "owner/repo" gets an App token minted for it;
                             an "owner/repo=<giturl>" override is passed
                             through verbatim (dev/test, no minting).
  --repos-file=FILE          Alternative: one repo entry per line.

Any other option (e.g. --dry-run, --output=FILE, --task-dag=PATH) is
forwarded unchanged to the renderer.

Environment: APP_ID, APP_PRIVATE_KEY (required unless every repo is an
override and GH_TOKEN is preset / --dry-run); GH_TOKEN, GIT_HOST_BASE,
GH_API_BASE (optional). See the header comment for details.
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing. We only need to *understand* a handful of options; the
# rest are forwarded to the renderer untouched.
TARGET_REPO=""
TARGET_ISSUE=""
REPOS_RAW=""
REPOS_FILE=""
DRY_RUN=false
PASSTHRU=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --target-repo=*)  TARGET_REPO="${1#*=}"; shift ;;
        --target-issue=*) TARGET_ISSUE="${1#*=}"; shift ;;
        --repos=*)        REPOS_RAW="${1#*=}"; shift ;;
        --repos-file=*)   REPOS_FILE="${1#*=}"; shift ;;
        --dry-run)        DRY_RUN=true; PASSTHRU+=("$1"); shift ;;
        -h|--help)        usage; exit 0 ;;
        --task-dag=*)     TASK_DAG="${1#*=}"; shift ;;  # re-added explicitly below
        *)                PASSTHRU+=("$1"); shift ;;
    esac
done

command -v jq   >/dev/null 2>&1 || die "jq is required"
command -v git  >/dev/null 2>&1 || die "git is required"
command -v curl >/dev/null 2>&1 || die "curl is required"
[ -x "$RENDERER" ] || die "renderer not found/executable at: $RENDERER"

[ -n "$TARGET_REPO" ]  || { echo "--target-repo is required" >&2; usage >&2; exit 2; }
[ -n "$TARGET_ISSUE" ] || { echo "--target-issue is required" >&2; usage >&2; exit 2; }

# ---------------------------------------------------------------------------
# Assemble the repo list (de-duplicated, order-preserving) the same way the
# renderer does, so behaviour matches.
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
        line="${line%%#*}"
        line="$(printf '%s' "$line" | tr -d '[:space:]')"
        add_repo_entry "$line"
    done < "$REPOS_FILE"
fi
if [ -n "$REPOS_RAW" ]; then
    REPOS_RAW="${REPOS_RAW//,/ }"
    for entry in $REPOS_RAW; do
        add_repo_entry "$entry"
    done
fi
[ "${#REPO_ENTRIES[@]}" -gt 0 ] || die "no repos to scan (pass --repos or --repos-file)"

# ---------------------------------------------------------------------------
# GitHub App token helpers (compact form of the proven implementation in
# top-level/.github/scripts/materialise-child-epics.sh). Only invoked for
# bare "owner/repo" entries; override entries never reach here.
APP_KEY_FILE=""
JWT=""

b64url() { base64 -w0 | tr '+/' '-_' | tr -d '='; }

# Register a runtime-minted token with the Actions log masker. Tokens
# minted at job time are NOT covered by the secrets masker, and they get
# embedded in git fetch URLs / passed to gh, so mask them defensively.
gha_mask() {
    [ "${GITHUB_ACTIONS:-}" = "true" ] || return 0
    local v="$1"
    [ -n "$v" ] || return 0
    v="${v//'%'/'%25'}"; v="${v//$'\r'/'%0D'}"; v="${v//$'\n'/'%0A'}"
    printf '::add-mask::%s\n' "$v" >&2
}

ensure_app_jwt() {
    [ -z "$JWT" ] || return 0
    : "${APP_ID:?APP_ID is required to mint App tokens (or use owner/repo=<url> overrides)}"
    : "${APP_PRIVATE_KEY:?APP_PRIVATE_KEY is required to mint App tokens}"
    APP_KEY_FILE="$(mktemp)"
    chmod 600 "$APP_KEY_FILE"
    printf '%s\n' "$APP_PRIVATE_KEY" > "$APP_KEY_FILE"
    local now exp header payload sig
    now="$(date +%s)"
    exp=$((now + 540))                       # ~9 min; GitHub max is 10.
    header="$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)"
    payload="$(jq -jcn --argjson iat "$((now - 30))" --argjson exp "$exp" \
        --arg iss "$APP_ID" '{iat:$iat,exp:$exp,iss:$iss}' | b64url)"
    sig="$(printf '%s.%s' "$header" "$payload" \
        | openssl dgst -sha256 -sign "$APP_KEY_FILE" -binary | b64url)"
    JWT="$header.$payload.$sig"
}

cleanup() { [ -n "$APP_KEY_FILE" ] && rm -f "$APP_KEY_FILE"; APP_KEY_FILE=""; }
trap cleanup EXIT

# Mint an installation token for one repo with the given permission set.
# Args: $1=owner $2=repo $3=permissions-json (e.g. '{"contents":"read"}')
# Stdout: token (empty on failure); diagnostics on stderr.
mint_repo_token() {
    local owner="$1" repo="$2" perms="$3"
    ensure_app_jwt
    local resp http_code body install_id token
    resp="$(curl -sS -w '\n%{http_code}' \
        -H "Authorization: Bearer $JWT" \
        -H "Accept: application/vnd.github+json" \
        "$GH_API_BASE/repos/${owner}/${repo}/installation" || true)"
    http_code="$(printf '%s' "$resp" | tail -n1)"
    body="$(printf '%s' "$resp" | sed '$d')"
    if [ "$http_code" != "200" ]; then
        warn "App not installed (or no access) on ${owner}/${repo} (HTTP $http_code on installation lookup)"
        return 1
    fi
    install_id="$(printf '%s' "$body" | jq -r '.id // empty')"
    [ -n "$install_id" ] || { warn "installation lookup for ${owner}/${repo} returned no .id"; return 1; }
    resp="$(curl -sS -w '\n%{http_code}' -X POST \
        -H "Authorization: Bearer $JWT" \
        -H "Accept: application/vnd.github+json" \
        "$GH_API_BASE/app/installations/${install_id}/access_tokens" \
        -d "$(jq -nc --arg repo "$repo" --argjson perms "$perms" \
                '{repositories:[$repo],permissions:$perms}')" || true)"
    http_code="$(printf '%s' "$resp" | tail -n1)"
    body="$(printf '%s' "$resp" | sed '$d')"
    if [ "$http_code" != "201" ]; then
        warn "could not mint token for ${owner}/${repo} (HTTP $http_code); skipping (permission not yet granted?)"
        return 1
    fi
    token="$(printf '%s' "$body" | jq -r '.token // empty')"
    [ -n "$token" ] || { warn "installation-token response for ${owner}/${repo} had no .token"; return 1; }
    printf '%s' "$token"
}

# ---------------------------------------------------------------------------
# Build the renderer's --repos argument: override entries pass through;
# bare entries get a Contents:read token minted and become authenticated
# git-fetch URLs. Repos whose token can't be minted are skipped (warned).
RENDER_ENTRIES=()
for entry in "${REPO_ENTRIES[@]}"; do
    if [[ "$entry" == *"="* ]]; then
        RENDER_ENTRIES+=("$entry")               # dev/test override, verbatim.
        continue
    fi
    owner="${entry%%/*}"
    repo="${entry#*/}"
    if [ -z "$owner" ] || [ -z "$repo" ] || [ "$owner" = "$entry" ]; then
        warn "ignoring malformed repo entry (want owner/repo): $entry"
        continue
    fi
    if tok="$(mint_repo_token "$owner" "$repo" '{"contents":"read","metadata":"read"}')" && [ -n "$tok" ]; then
        gha_mask "$tok"
        RENDER_ENTRIES+=("${entry}=https://x-access-token:${tok}@${GIT_HOST_BASE#https://}/${entry}.git")
    else
        warn "skipping ${entry} (no readable token)"
    fi
done
[ "${#RENDER_ENTRIES[@]}" -gt 0 ] || die "no repos could be authenticated for scanning"

# ---------------------------------------------------------------------------
# Comment-write token for the target repo (Issues:write). Skip when the
# caller pre-set GH_TOKEN (dev/test) or when only rendering (--dry-run).
if [ "$DRY_RUN" != true ] && [ -z "${GH_TOKEN:-}" ]; then
    t_owner="${TARGET_REPO%%/*}"
    t_repo="${TARGET_REPO#*/}"
    GH_TOKEN="$(mint_repo_token "$t_owner" "$t_repo" '{"issues":"write","metadata":"read"}')" \
        || die "could not mint Issues:write token for ${TARGET_REPO} (needed to publish the comment)"
    [ -n "$GH_TOKEN" ] || die "empty publish token for ${TARGET_REPO}"
    gha_mask "$GH_TOKEN"
    export GH_TOKEN
fi

# Join RENDER_ENTRIES with spaces for the renderer's --repos.
REPOS_ARG=""
for e in "${RENDER_ENTRIES[@]}"; do
    REPOS_ARG="${REPOS_ARG:+$REPOS_ARG }$e"
done

log "publishing dashboard to ${TARGET_REPO}#${TARGET_ISSUE} from ${#RENDER_ENTRIES[@]} repo(s)"
# `exec` replaces this shell, so the EXIT trap would never fire — remove the
# App private key now (the renderer never needs it) and drop the trap.
cleanup
trap - EXIT
exec "$RENDERER" \
    --target-repo="$TARGET_REPO" \
    --target-issue="$TARGET_ISSUE" \
    --repos="$REPOS_ARG" \
    --task-dag="$TASK_DAG" \
    ${PASSTHRU[@]+"${PASSTHRU[@]}"}
