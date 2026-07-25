# shellcheck shell=bash
# Ref namespaces, exact control-ref classifiers, strict tree-shape validators,
# and task-ref synchronization primitives.

if ! declare -F json_escape >/dev/null; then
    echo "Error: ref-schema.sh requires json.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi
if ! declare -F task_is_root_shaped_epic >/dev/null; then
    echo "Error: ref-schema.sh requires task-model.sh to be loaded first" >&2
    return 2 2>/dev/null || exit 2
fi

TASKDAG_KNOWN_TASK_NS="pending root-active frontier active blocked blocked-meta delegated delegated-close completions ci-chains repair-superseded"
TASKDAG_KNOWN_GH_NS="issues comments child-epics child-epic-slots materialisation-markers"
TASKDAG_GRAPH_REF="refs/heads/tasks/v1/graph"
TASKDAG_RECONCILE_COMMENTS_INDEX_REF="refs/heads/tasks/v1/reconcile-comments-index"
TASKDAG_MAILBOX_REF_GLOB="refs/heads/tasks/v1/mailbox"

taskdag_parse_delegation_v2_ref() { # ref; prints parent-digest<TAB>declaration-digest
    local ref=${1#refs/heads/}
    if [[ "$ref" =~ ^tasks/delegated/v2/([0-9a-f]{64})/([0-9a-f]{64})$ ]]; then
        printf '%s\t%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
        return 0
    fi
    return 1
}

taskdag_parse_delegated_close_v2_ref() { # ref; prints parent-digest<TAB>declaration-digest
    local ref=${1#refs/heads/}
    if [[ "$ref" =~ ^tasks/delegated-close/v2/([0-9a-f]{64})/([0-9a-f]{64})$ ]]; then
        printf '%s\t%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
        return 0
    fi
    return 1
}

taskdag_is_reconcile_comments_index_ref() {
    case "$1" in
        refs/heads/tasks/v1/reconcile-comments-index|tasks/v1/reconcile-comments-index) return 0 ;;
        *) return 1 ;;
    esac
}

taskdag_is_activation_ref() {
    case "$1" in
        refs/heads/tasks/v1/activation|tasks/v1/activation) return 0 ;;
        *) return 1 ;;
    esac
}

taskdag_is_materialisation_ref() {
    case "$1" in
        refs/heads/tasks/v1/materialisation|tasks/v1/materialisation) return 0 ;;
        *) return 1 ;;
    esac
}

taskdag_is_materialisation_producer_ref() {
    case "$1" in
        refs/heads/tasks/v1/materialisation-producer|tasks/v1/materialisation-producer) return 0 ;;
        *) return 1 ;;
    esac
}

taskdag_is_comment_watchdog_ref() {
    case "$1" in
        refs/heads/tasks/v1/comment-watchdog|tasks/v1/comment-watchdog) return 0 ;;
        *) return 1 ;;
    esac
}

taskdag_is_graph_ref() {
    case "$1" in
        refs/heads/tasks/v1/graph|tasks/v1/graph) return 0 ;;
        *) return 1 ;;
    esac
}

taskdag_is_mailbox_ref() {
    case "$1" in
        refs/heads/tasks/v1/mailbox/0[0-9a-f]|tasks/v1/mailbox/0[0-9a-f]) return 0 ;;
        *) return 1 ;;
    esac
}

taskdag_graph_tree_violations() {
    local sha="$1" mode type obj path
    while read -r mode type obj path; do
        [ -n "$type" ] || continue
        if [ "$type" != blob ]; then
            echo "✗ ${TASKDAG_GRAPH_REF} tree entry '${path}' is a ${type}, expected a blob (edges/<edge-id>.json or tombstones/<edge-id>.json)"
            continue
        fi
        if [ "$mode" != 100644 ]; then
            echo "✗ ${TASKDAG_GRAPH_REF} tree entry '${path}' has mode ${mode}, expected a regular file (100644)"
            continue
        fi
        case "$path" in
            edges/[0-9a-f]*.json)
                local base="${path#edges/}"; base="${base%.json}"
                if ! [[ "$base" =~ ^[0-9a-f]{64}$ ]]; then
                    echo "✗ ${TASKDAG_GRAPH_REF} edge blob '${path}' has a malformed edge-id (expected edges/<64-hex>.json)"
                fi
                ;;
            tombstones/[0-9a-f]*.json)
                local tbase="${path#tombstones/}"; tbase="${tbase%.json}"
                if ! [[ "$tbase" =~ ^[0-9a-f]{64}$ ]]; then
                    echo "✗ ${TASKDAG_GRAPH_REF} tombstone blob '${path}' has a malformed edge-id (expected tombstones/<64-hex>.json)"
                fi
                ;;
            *) echo "✗ ${TASKDAG_GRAPH_REF} tree contains unexpected path '${path}' (only edges/<edge-id>.json and tombstones/<edge-id>.json blobs are allowed)" ;;
        esac
    done < <(git ls-tree -r "$sha" 2>/dev/null)
    return 0
}

taskdag_mailbox_tree_violations() {
    local sha="$1" ref="$2" mode type obj path shard
    shard="${ref##*/}"
    while read -r mode type obj path; do
        [ -n "$type" ] || continue
        if [ "$type" != blob ]; then
            echo "✗ ${TASKDAG_MAILBOX_REF_GLOB} shard tree entry '${path}' is a ${type}, expected a blob (msg/<message-id>.json)"
            continue
        fi
        if [ "$mode" != 100644 ]; then
            echo "✗ ${TASKDAG_MAILBOX_REF_GLOB} shard tree entry '${path}' has mode ${mode}, expected a regular file (100644)"
            continue
        fi
        case "$path" in
            msg/[0-9a-f]*.json)
                local base="${path#msg/}"; base="${base%.json}"
                if ! [[ "$base" =~ ^[0-9a-f]{64}$ ]]; then
                    echo "✗ ${TASKDAG_MAILBOX_REF_GLOB} message blob '${path}' has a malformed message-id (expected msg/<64-hex>.json)"
                    continue
                fi
                local want_shard
                want_shard=$(printf '%02x' "$((16#${base:0:1}))")
                if [ "$want_shard" != "$shard" ]; then
                    echo "✗ ${ref} message ${base} is in shard ${shard} but derives to shard ${want_shard} (mis-sharded blob is corruption)"
                fi
                ;;
            *) echo "✗ ${TASKDAG_MAILBOX_REF_GLOB} shard tree contains unexpected path '${path}' (only msg/<message-id>.json blobs are allowed in schema v1)" ;;
        esac
    done < <(git ls-tree -r "$sha" 2>/dev/null)
    return 0
}

list_task_refs() {
    git for-each-ref refs/heads/tasks/ --format='%(objectname) %(refname:short)'
}

fetch_task_refs_strict() {
    git fetch --quiet --prune origin \
        '+refs/heads/tasks/frontier/*:refs/heads/tasks/frontier/*' \
        '+refs/heads/tasks/active/*:refs/heads/tasks/active/*' \
        '+refs/heads/tasks/blocked/*:refs/heads/tasks/blocked/*' \
        '+refs/heads/tasks/blocked-meta/*:refs/heads/tasks/blocked-meta/*' \
        '+refs/heads/tasks/root-active/*:refs/heads/tasks/root-active/*' \
        '+refs/heads/tasks/pending/*:refs/heads/tasks/pending/*' \
        '+refs/heads/tasks/v1/*:refs/heads/tasks/v1/*' \
        '+refs/heads/gh/issues/*:refs/heads/gh/issues/*'
}

fetch_task_refs() {
    fetch_task_refs_strict 2>/dev/null || true
}

normalize_task_ref() {
    local ref="$1"
    ref="${ref#refs/heads/}"
    case "$ref" in
        tasks/*) : ;;
        *) return 1 ;;
    esac
    case "$ref" in
        *' '*|*'	'*|*'*'*|*'..'*|*'~'*|*'^'*|*':'*|*'?'*|*'['*|*'\'*|*'+'*) return 1 ;;
        */) return 1 ;;
    esac
    printf '%s\n' "$ref"
}

fetch_task_ref_exact() {
    local ref="$1"
    git fetch --quiet --no-tags origin "+refs/heads/${ref}:refs/heads/${ref}"
}
