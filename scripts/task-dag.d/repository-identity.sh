# shellcheck shell=bash
# Canonical repository and graph-node identity helpers. This foundation is
# loaded after ref-schema.sh and before feature modules by the entrypoint.

taskdag_norm_owner_repo() {
    local or="$1"
    or=$(printf '%s' "$or" | tr '[:upper:]' '[:lower:]')
    if [[ "$or" =~ ^[a-z0-9._-]+/[a-z0-9._-]+$ ]]; then
        printf '%s\n' "$or"
    else
        return 1
    fi
}

taskdag_normalize_node() {
    local node="$1" kind rest or ref cor
    case "$node" in
        task:*) kind=task; rest="${node#task:}" ;;
        issue:*) kind=issue; rest="${node#issue:}" ;;
        *) return 1 ;;
    esac
    case "$kind" in
        task)
            or="${rest%@*}"; ref="${rest##*@}"
            [ "$or" != "$rest" ] || return 1
            ref=$(printf '%s' "$ref" | tr '[:upper:]' '[:lower:]')
            [[ "$ref" =~ ^[0-9a-f]{40}$|^[0-9a-f]{64}$ ]] || return 1
            cor=$(taskdag_norm_owner_repo "$or") || return 1
            printf 'task:%s@%s\n' "$cor" "$ref"
            ;;
        issue)
            or="${rest%#*}"; ref="${rest##*#}"
            [ "$or" != "$rest" ] || return 1
            [[ "$ref" =~ ^[1-9][0-9]*$ ]] || return 1
            cor=$(taskdag_norm_owner_repo "$or") || return 1
            printf 'issue:%s#%s\n' "$cor" "$ref"
            ;;
    esac
}

taskdag_repo_config_key() {
    local cor
    cor=$(taskdag_norm_owner_repo "$1") || return 1
    printf 'taskdag.%s.id\n' "$cor"
}

taskdag_repo_numeric_id() {
    local cor key cached id
    cor=$(taskdag_norm_owner_repo "$1") || { echo "Error: malformed owner/repo: $1" >&2; return 1; }
    key=$(taskdag_repo_config_key "$cor") || return 1
    cached=$(git config --get "$key" 2>/dev/null || true)
    if [ -n "$cached" ]; then
        if [[ "$cached" =~ ^[1-9][0-9]*$ ]]; then
            printf '%s\n' "$cached"; return 0
        fi
        echo "Error: cached repo-id for ${cor} is not a positive integer: ${cached}" >&2
        return 1
    fi
    command -v gh >/dev/null 2>&1 || { echo "Error: cannot resolve repo-id for ${cor}: gh unavailable and no ${key} override set" >&2; return 1; }
    id=$(gh api "repos/${cor}" --jq .id 2>/dev/null || true)
    if [[ "$id" =~ ^[1-9][0-9]*$ ]]; then
        printf '%s\n' "$id"; return 0
    fi
    echo "Error: could not resolve numeric repo-id for ${cor} via gh" >&2
    return 1
}

taskdag_current_repo() {
    local r=""
    if [ -n "${TASKDAG_CURRENT_REPO:-}" ]; then
        r="$TASKDAG_CURRENT_REPO"
    else
        r=$(git config --get taskdag.current-repo 2>/dev/null || true)
        if [ -z "$r" ] && declare -F _xrepo_current_repo >/dev/null 2>&1; then
            r=$(_xrepo_current_repo 2>/dev/null || true)
        fi
    fi
    [ -n "$r" ] || return 1
    taskdag_norm_owner_repo "$r"
}

taskdag_node_repo() {
    local node="$1" rest
    node=$(taskdag_normalize_node "$node") || return 1
    rest="${node#*:}"
    rest="${rest%%@*}"
    rest="${rest%%#*}"
    printf '%s\n' "$rest"
}

taskdag_remote_owner_repo() {
    local remote="$1" override raw
    override=$(git config --get "taskdag.remote-repo.${remote}" 2>/dev/null || true)
    if [ -n "$override" ]; then
        taskdag_norm_owner_repo "$override"; return
    fi
    if [ "$remote" = origin ]; then
        taskdag_current_repo && return 0
    fi
    raw=$(git config --get "remote.${remote}.url" 2>/dev/null || true)
    [ -n "$raw" ] || raw="$remote"
    raw="${raw%.git}"
    case "$raw" in
        *@*:*) raw="${raw#*:}" ;;
        *://*) raw="${raw#*://}"; raw="${raw#*/}" ;;
        *) return 1 ;;
    esac
    taskdag_norm_owner_repo "$raw"
}

taskdag_full_history_checkout() { # checkout
    local repo=$1 shallow common config_matches rc promisor_pack
    shallow=$(git -C "$repo" rev-parse --is-shallow-repository) || return 1
    [ "$shallow" = false ] || return 1
    common=$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir) || return 1
    [ -d "$common/objects/pack" ] || return 1
    config_matches=$(git -C "$repo" config --get-regexp \
        '^(extensions\.partialclone|remote\..*\.(promisor|partialclonefilter))$' 2>/dev/null); rc=$?
    case "$rc" in 0) return 1;; 1) ;; *) return 1;; esac
    promisor_pack=$(find "$common/objects/pack" -maxdepth 1 -type f -name '*.promisor' -print -quit) || return 1
    [ -z "$promisor_pack" ]
}

taskdag_remote_head() { # checkout; ref<TAB>commit
    local checkout=$1 advertisement ref commit
    advertisement=$(git -C "$checkout" ls-remote --symref origin HEAD) || return 1
    ref=$(awk '$1=="ref:" && $3=="HEAD" {print $2}' <<<"$advertisement")
    commit=$(awk '$2=="HEAD" && $1 ~ /^[0-9a-f]{40,64}$/ {print $1}' <<<"$advertisement")
    [[ "$ref" =~ ^refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] \
        && [[ "$commit" =~ ^[0-9a-f]{40}$|^[0-9a-f]{64}$ ]] || return 1
    git -C "$checkout" fetch -q --no-tags origin "$commit" || return 1
    [ "$(git -C "$checkout" rev-parse FETCH_HEAD)" = "$commit" ] || return 1
    printf '%s\t%s\n' "$ref" "$commit"
}

# Validate a checkout against one exact immutable target tuple. The tuple is a
# schema-1 JSON object: repository, repositoryId, url, headRef, headCommit.
taskdag_validate_target_checkout() ( # checkout tuple-json-or-file
    local checkout=$1 tuple=$2 input raw push info ref commit expected
    [ -d "$checkout/.git" ] && taskdag_full_history_checkout "$checkout" || return 1
    declare -F taskdag_json_file_is_single_strict >/dev/null || return 1
    input=$(mktemp) || return 1
    trap 'rm -f "$input"' EXIT
    if [ -f "$tuple" ]; then cat "$tuple" >"$input" || return 1; else printf '%s\n' "$tuple" >"$input"; fi
    taskdag_json_file_is_single_strict "$input" || return 1
    jq -e 'type=="object" and keys==["headCommit","headRef","repository","repositoryId","schema","url"] and .schema==1 and
      (.repository|test("^[a-z0-9_.-]+/[a-z0-9_.-]+$")) and (.repositoryId|type=="string" and length>0) and
      (.url|type=="string" and length>0) and (.headRef|test("^refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]*$")) and
      (.headCommit|test("^([0-9a-f]{40}|[0-9a-f]{64})$"))' "$input" >/dev/null || return 1
    expected=$(jq -r .repository "$input")
    raw=$(git -C "$checkout" config --get remote.origin.url 2>/dev/null) || return 1
    push=$(git -C "$checkout" config --get-all remote.origin.pushurl 2>/dev/null || true)
    [ -z "$push" ] && [ "$raw" = "$(jq -r .url "$input")" ] || return 1
    info=$(gh api "repos/$expected" 2>/dev/null) || return 1
    [ "$(jq -r '.full_name|ascii_downcase' <<<"$info")" = "$expected" ] \
        && [ "$(jq -r .node_id <<<"$info")" = "$(jq -r .repositoryId "$input")" ] || return 1
    IFS=$'\t' read -r ref commit < <(taskdag_remote_head "$checkout") || return 1
    [ "$ref" = "$(jq -r .headRef "$input")" ] \
        && [ "$commit" = "$(jq -r .headCommit "$input")" ]
)
