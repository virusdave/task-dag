# shellcheck shell=bash
# Minimal task classification and ancestry predicates.

if ! declare -F parse_commit_metadata >/dev/null \
    || ! declare -F extract_field >/dev/null \
    || ! declare -F get_first_parent >/dev/null \
    || ! declare -F is_task_commit >/dev/null; then
    echo "Error: task-model.sh requires git-objects.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi

# True only for the exact human GitHub comment task dialect. Ordinary task
# children, bot/system messages, and malformed messages remain fail-closed.
is_human_comment_task() {
    local sha="$1" msg
    msg=$(parse_commit_metadata "$sha" 2>/dev/null) || return 1
    [ "$(extract_field "$msg" "kind")" = "message" ] &&
    [ "$(extract_field "$msg" "role")" = "human" ] &&
    [ "$(extract_field "$msg" "intent")" = "comment" ]
}

# A top-level epic root is Type: epic and is not parented on another task
# object. Child epics therefore remain distinct from repository-history roots.
task_is_root_shaped_epic() {
    local sha="$1" type first
    type=$(extract_field "$(parse_commit_metadata "$sha")" "Type" 2>/dev/null || true)
    [ "$type" = epic ] || return 1
    first=$(get_first_parent "$sha" 2>/dev/null || true)
    if [ -n "$first" ] && is_task_commit "$first"; then
        return 1
    fi
    return 0
}
