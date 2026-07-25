# shellcheck shell=bash
# Canonical GitHub/origin identity and normalized remote-ref readers. The
# entrypoint loads this acyclic foundation after repository-identity.sh and
# before every feature consumer. It deliberately does not construct child
# maps: synchronization only updates the normalized local ref view.

if ! declare -F parse_commit_metadata >/dev/null || ! declare -F extract_field >/dev/null; then
    echo "Error: github-origin.sh requires git-objects.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F taskdag_current_repo >/dev/null; then
    echo "Error: github-origin.sh requires repository-identity.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi

task_is_claimed_on_remote() {
    local short_sha="$1"
    git ls-remote --exit-code origin "refs/heads/tasks/active/$short_sha" \
        >/dev/null 2>&1 && echo "yes" || echo "no"
}

task_active_sha_on_remote() {
    local short_sha="$1"
    git ls-remote origin "refs/heads/tasks/active/$short_sha" 2>/dev/null \
        | awk '{print $1; exit}'
}

task_frontier_on_remote() {
    local short_sha="$1"
    git ls-remote origin "refs/heads/tasks/frontier/$short_sha" 2>/dev/null \
        | awk '{print $1; exit}'
}

remote_ref_sha() {
    git ls-remote origin "$1" 2>/dev/null | awk '{print $1; exit}'
}

remote_ref_sha_checked() {
    local out rc
    out=$(git ls-remote --exit-code origin "$1" 2>/dev/null)
    rc=$?
    case "$rc" in
        0) printf '%s\n' "$out" | awk '{print $1; exit}'; return 0 ;;
        2) return 2 ;;
        *) return 3 ;;
    esac
}

pending_sha_on_remote() {
    remote_ref_sha "refs/heads/tasks/pending/$1"
}

pending_sha_on_remote_checked() {
    local out rc
    out=$(git ls-remote --exit-code origin "refs/heads/tasks/pending/$1" 2>/dev/null)
    rc=$?
    case "$rc" in
        0) printf '%s\n' "$out" | awk '{print $1; exit}'; return 0 ;;
        2) return 2 ;;
        *) return 3 ;;
    esac
}

root_active_sha_on_remote() {
    remote_ref_sha "refs/heads/tasks/root-active/$1"
}

# Synchronize the complete authoritative decomposition snapshot. This keeps
# the historical refspec/atomic/prune contract but intentionally does not
# derive or cache a child map; that remains the feature consumer's job.
taskdag_sync_root_refs() {
    TASKDAG_CHILD_MAP_READY=false
    TASKDAG_RECON_READY=false
    git fetch --quiet --atomic --prune --no-tags origin \
        '+refs/heads/master:refs/remotes/origin/master' \
        '+refs/heads/tasks/pending/*:refs/heads/tasks/pending/*' \
        '+refs/heads/tasks/root-active/*:refs/heads/tasks/root-active/*' \
        '+refs/heads/tasks/frontier/*:refs/heads/tasks/frontier/*' \
        '+refs/heads/tasks/active/*:refs/heads/tasks/active/*' \
        '+refs/heads/tasks/blocked/*:refs/heads/tasks/blocked/*' \
        '+refs/heads/tasks/blocked-meta/*:refs/heads/tasks/blocked-meta/*' \
        '+refs/heads/gh/issues/*:refs/heads/gh/issues/*' \
        2>/dev/null
}

derive_task_origin() {
    local sha="$1"
    local msg; msg=$(parse_commit_metadata "$sha")
    local issue url repo
    issue=$(extract_field "$msg" "Issue" 2>/dev/null || true); issue="${issue#\#}"
    if [ -z "$issue" ]; then
        issue=$(echo "$msg" | awk '/^issue:[[:space:]]*$/{f=1;next} f&&/number:/{sub(/^[[:space:]]*number:[[:space:]]*/,"");print;exit}')
    fi
    url=$(extract_field "$msg" "URL" 2>/dev/null || true)
    if [ -z "$url" ]; then
        url=$(echo "$msg" | awk '/^github:[[:space:]]*$/{f=1;next} f&&/url:/{sub(/^[[:space:]]*url:[[:space:]]*/,"");print;exit}')
    fi
    repo=""
    if [[ "$url" =~ ^https?://github\.com/([^/]+/[^/]+)(/.*)?$ ]]; then
        repo="${BASH_REMATCH[1]}"
    fi
    if [ -z "$repo" ]; then
        repo=$(echo "$msg" | awk '/^issue:[[:space:]]*$/{f=1;next} f&&/repo:/{sub(/^[[:space:]]*repo:[[:space:]]*/,"");print;exit}')
    fi
    printf '%s\t%s\t%s\n' "$repo" "$issue" "$url"
}

parse_owner_repo_from_url() {
    local url="$1" stripped
    [ -n "$url" ] || return 0
    stripped=$(printf '%s' "$url" | sed -E \
        's#^(https?://[^/]+/|git@[^:]+:|ssh://[^/]+/|git://[^/]+/)##; s#\.git/?$##; s#/$##')
    if [[ "$stripped" =~ ^([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)(/.*)?$ ]]; then
        printf '%s\n' "${BASH_REMATCH[1]}"
    fi
}

issue_is_closed_remote() {
    local repo="$1" issue="$2" state
    [ -n "$repo" ] && [ -n "$issue" ] || return 1
    command -v gh >/dev/null 2>&1 || return 1
    state="$(gh issue view "$issue" --repo "$repo" --json state --jq '.state' 2>/dev/null || true)"
    [ "$state" = "CLOSED" ]
}

issue_state_remote() {
    local repo="$1" issue="$2" state
    [ -n "$repo" ] && [ -n "$issue" ] || return 3
    command -v gh >/dev/null 2>&1 || return 3
    state="$(gh issue view "$issue" --repo "$repo" --json state --jq '.state' 2>/dev/null)" || return 3
    [ -n "$state" ] || return 3
    printf '%s\n' "$state"
    return 0
}
