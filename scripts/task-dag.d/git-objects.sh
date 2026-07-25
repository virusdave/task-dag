# shellcheck shell=bash
# Canonical Git object and commit-metadata primitives.

if [ -z "${EMPTY_TREE:-}" ]; then
    echo "Error: git-objects.sh requires source-contract.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi

resolve_sha() {
    local ref_or_sha="$1"
    git rev-parse "$ref_or_sha" 2>/dev/null || {
        echo "Error: Cannot resolve '$ref_or_sha'" >&2
        return 1
    }
}

parse_commit_metadata() {
    local sha="$1"
    git log -1 --format='%B' "$sha"
}

extract_field() {
    local message="$1"
    local field="$2"
    # A missing field is normal and emits an empty value successfully.
    echo "$message" | grep "^${field}:" | sed "s/^${field}: *//" | head -1 || true
}

get_task_title() {
    local sha="$1"
    git log -1 --format='%s' "$sha" | sed 's/^Task: *//'
}

get_parents() {
    local sha="$1"
    git rev-list --parents -1 "$sha" | awk '{for(i=2;i<=NF;i++) print $i}'
}

get_first_parent() {
    local sha="$1"
    get_parents "$sha" | head -1
}

get_dep_parents() {
    local sha="$1"
    get_parents "$sha" | tail -n +2
}

# Task/control objects use the canonical empty tree. Any other tree is real
# implementation history and therefore outside the live task DAG.
is_task_commit() {
    local sha="$1" tree
    tree=$(git rev-parse "$sha^{tree}" 2>/dev/null) || return 1
    [ "$tree" = "$EMPTY_TREE" ]
}
