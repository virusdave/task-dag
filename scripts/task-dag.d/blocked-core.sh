#!/usr/bin/env bash
# Blocked-overlay names, metadata, and structural ancestry primitives.
# Loaded by the entrypoint after git-objects.sh and github-origin.sh.

if ! declare -F get_first_parent >/dev/null || ! declare -F is_task_commit >/dev/null \
    || ! declare -F get_task_title >/dev/null; then
    echo "Error: blocked-core.sh requires git-objects.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F derive_task_origin >/dev/null; then
    echo "Error: blocked-core.sh requires github-origin.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi

# Blocked refs are an overlay pointing directly at the task commit. Full SHA
# names avoid the short-prefix collisions possible in frontier/active refs.
blocked_ref_for() {
    local sha="$1"
    echo "refs/heads/tasks/blocked/$sha"
}

is_task_blocked() {
    local sha="$1"
    git show-ref --verify --quiet "$(blocked_ref_for "$sha")"
}

# Descriptive metadata is separate from the authoritative blocked overlay;
# legacy blocked refs without metadata remain valid.
blocked_meta_ref_for() {
    local sha="$1"
    echo "refs/heads/tasks/blocked-meta/$sha"
}

has_blocked_meta() {
    local sha="$1"
    git show-ref --verify --quiet "$(blocked_meta_ref_for "$sha")"
}

# Missing refs and fields deliberately produce empty output with status zero.
read_blocked_meta_field() {
    local sha="$1" field="$2"
    local ref; ref=$(blocked_meta_ref_for "$sha")
    git show-ref --verify --quiet "$ref" || return 0
    git log -1 --format='%B' "$ref" | awk -v f="$field" '
        index($0, f ":") == 1 { sub("^[^:]+:[[:space:]]*", ""); print; exit }'
}

# Walk first-parent decomposition ancestry, excluding the task itself. Stop at
# real repository history, which bounds this to structural DAG depth.
blocked_structural_ancestor() {
    local cur="$1" parent
    while :; do
        parent="$(get_first_parent "$cur" 2>/dev/null || true)"
        [ -n "$parent" ] || return 1
        is_task_commit "$parent" || return 1
        if is_task_blocked "$parent"; then
            printf '%s\n' "$parent"
            return 0
        fi
        cur="$parent"
    done
}

# Deterministic metadata minting: fixed identity and the recorded block time as
# both commit dates make identical fields produce an identical object ID.
build_blocked_meta_commit() {
    local task_sha="$1" kind="$2" reason="$3" request_url="$4" \
          repo="$5" issue="$6" source_url="$7" actor="$8" host="$9" blocked_at="${10}"

    local task_title task_tree
    task_title=$(get_task_title "$task_sha")
    task_tree=$(git rev-parse "$task_sha^{tree}")
    reason=$(printf '%s' "$reason" | tr '\n' ' ')
    request_url=$(printf '%s' "$request_url" | tr '\n' ' ')

    local msg="Blocked-Meta: ${task_title}

Task-Commit: ${task_sha}
Blocker-Kind: ${kind}"
    [ -n "$reason" ]      && msg="${msg}
Reason: ${reason}"
    [ -n "$request_url" ] && msg="${msg}
Request-URL: ${request_url}"
    [ -n "$repo" ]        && msg="${msg}
Repo: ${repo}"
    [ -n "$issue" ]       && msg="${msg}
Issue: #${issue}"
    [ -n "$source_url" ]  && msg="${msg}
Source-URL: ${source_url}"
    [ -n "$actor" ]       && msg="${msg}
Blocked-By: ${actor}"
    [ -n "$host" ]        && msg="${msg}
Blocked-Host: ${host}"
    msg="${msg}
Blocked-At: ${blocked_at}"

    GIT_AUTHOR_NAME="task-dag" GIT_AUTHOR_EMAIL="task-dag@localhost" \
    GIT_COMMITTER_NAME="task-dag" GIT_COMMITTER_EMAIL="task-dag@localhost" \
    GIT_AUTHOR_DATE="$blocked_at" GIT_COMMITTER_DATE="$blocked_at" \
        git commit-tree "$task_tree" -p "$task_sha" -m "$msg"
}
