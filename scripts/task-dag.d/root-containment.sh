#!/usr/bin/env bash
# Root containment snapshot, semantic subtree, and local-close policy.
# Loaded late by the entrypoint: command adapters remain in task-dag.

for prerequisite in parse_commit_metadata extract_field \
    taskdag_prepare_child_map taskdag_sync_root_refs taskdag_recon_prepare \
    taskdag_current_repo taskdag_node_complete taskdag_issue_closed_at_tip \
    get_first_parent is_task_commit pending_sha_on_remote_checked task_is_root_shaped_epic \
    fetch_task_refs_strict \
    taskdag_consumer_prepare taskdag_root_status_json taskdag_migration_guard \
    taskdag_materialisation_intents_durable; do
    if ! declare -F "$prerequisite" >/dev/null; then
        echo "Error: root-containment.sh requires provider for $prerequisite to be loaded first" >&2
        return 2 2>/dev/null || exit 2
    fi
done
unset prerequisite

fetch_root_refs() {
    taskdag_sync_root_refs || return 1
    taskdag_prepare_child_map || return 1
}

# Origin-authoritative root classification. A transport failure is
# indeterminate unless the local mirror confirms the identity; root-shaped
# uncertainty returns 3 so completion callers fail closed.
task_is_pending_root() {
    local sha="$1" issue remote rc
    issue=$(extract_field "$(parse_commit_metadata "$sha")" "Issue" 2>/dev/null | sed 's/^#//' || true)
    [ -n "$issue" ] || return 1
    remote=$(pending_sha_on_remote_checked "$issue"); rc=$?
    if [ "$rc" = 0 ]; then
        [ "$remote" = "$sha" ] || return 1
    elif [ "$rc" = 2 ]; then
        # Cleanly absent on origin: origin is authoritative, so this is NOT a
        # current pending root (the epic was closed/retired, or never had a
        # root). Do not consult the local mirror here — a stale local
        # refs/heads/tasks/pending/<N> must not resurrect a retired root and
        # spuriously refuse the legitimate historical/tombstone completion.
        return 1
    else
        # rc 3: origin indeterminate (transport/auth). Prefer the local
        # mirror; if it confirms our root, treat as root. Otherwise, if the
        # commit is SHAPED like a top-level epic root we cannot prove it is
        # NOT a live (possibly decomposed) root, so signal indeterminate and
        # let the caller fail closed rather than completing it blindly.
        if [ "$(git rev-parse --verify -q "refs/heads/tasks/pending/$issue" 2>/dev/null)" = "$sha" ]; then
            : # local mirror confirms → root
        elif task_is_root_shaped_epic "$sha"; then
            return 3
        else
            return 1
        fi
    fi
    printf '%s\n' "$issue"
    return 0
}

epic_subtree_complete() {
    local node="$1" cur
    taskdag_recon_prepare --no-fetch || return 2
    cur=$(taskdag_current_repo) || return 2
    taskdag_node_complete "task:${cur}@${node}"
}

epic_has_delegated_children() {
    local issue="$1" rc
    git ls-remote --exit-code origin "refs/heads/tasks/delegated/$issue/*" >/dev/null 2>&1
    rc=$?
    case "$rc" in
        0) return 0 ;;   # delegated refs present on origin
        2) return 1 ;;   # ls-remote confirms: no matching refs
        *) return 0 ;;   # transport/auth error → fail closed (assume delegated)
    esac
}

epic_already_closed_on() {
    local issue="$1" epic_sha="$2" base_ref="$3"
    taskdag_issue_closed_at_tip "$base_ref" "$issue" "$epic_sha"
}

maybe_emit_local_epic_close() {
    local task_sha="$1"

    local root_sha
    root_sha=$(get_first_parent "$task_sha" 2>/dev/null || true)
    [ -n "$root_sha" ] || return 0
    is_task_commit "$root_sha" || return 0

    # Walk the structural (first-parent) lineage up to the TOP pending
    # root. A leaf whose first parent is an intermediate sub-epic is not
    # the root, but completing it can still finish the whole tree.
    local node="$root_sha" issue="" up
    while :; do
        issue=$(task_is_pending_root "$node" 2>/dev/null || true)
        [ -n "$issue" ] && break
        up=$(get_first_parent "$node" 2>/dev/null || true)
        [ -n "$up" ] || return 0
        is_task_commit "$up" || return 0
        node=$up
    done
    root_sha=$node

    # Purely-local epics only; defer delegated/mixed epics to close-epic.
    epic_has_delegated_children "$issue" && return 0

    # Sync the FULL task-ref namespace (and origin/master) BEFORE judging
    # completeness. FAIL CLOSED if either authoritative sync is unavailable.
    if ! fetch_task_refs_strict; then
        printf "${YELLOW}⚠ Could not sync task refs from origin; not auto-closing epic #%s. Retry the close after origin is reachable.${RESET}\n" \
            "$issue" >&2
        return 0
    fi
    if ! git fetch --quiet --no-tags origin \
            '+refs/heads/master:refs/remotes/origin/master' >/dev/null 2>&1; then
        printf "${YELLOW}⚠ Could not sync origin/master; not auto-closing epic #%s. Retry the close after origin is reachable.${RESET}\n" \
            "$issue" >&2
        return 0
    fi

    # Whole subtree must be complete (this completion is already on HEAD).
    taskdag_consumer_prepare local-epic-close --tip HEAD || return 0
    if [ "$TASKDAG_CONSUMER_MODE" = canonical ]; then
        local root_status
        root_status=$(taskdag_root_status_json "task:${TASKDAG_RECON_CUR}@${root_sha}" "$issue") || return 0
        [ "$(jq -r '.complete and (.blocked|not) and .requirementsSatisfied' <<<"$root_status")" = true ] || return 0
    else
        taskdag_migration_guard epic-close || return $?
        epic_subtree_complete "$root_sha" || return 0
    fi

    # Materialisation intent must be durable before closure.
    if ! taskdag_materialisation_intents_durable "$issue" "$root_sha" HEAD; then
        printf "${YELLOW}⚠ Epic #%s has child-epic materialisation intent that is not durable yet; not auto-closing.${RESET}\n" \
            "$issue" >&2
        return 0
    fi

    # Don't duplicate an existing close locally or on the synced origin.
    epic_already_closed_on "$issue" "$root_sha" HEAD && return 0
    if git rev-parse --verify -q origin/master >/dev/null 2>&1; then
        epic_already_closed_on "$issue" "$root_sha" origin/master && return 0
    fi
    local head_sha head_tree close_msg close_sha
    head_sha=$(git rev-parse HEAD)
    head_tree=$(git rev-parse "HEAD^{tree}")
    close_msg="Close epic #${issue} (all tasks complete)

All child tasks of this epic have completed.

Closes-Epic: #${issue}"
    close_sha=$(git commit-tree "$head_tree" -p "$head_sha" -p "$root_sha" -m "$close_msg") || return 0
    git update-ref -m 'task-dag: local epic close commit' HEAD "$close_sha" "$head_sha" || return 0
    printf "${GREEN}🎉 Epic #%s complete — appended local Closes-Epic commit %s.${RESET}\n" \
        "$issue" "$(git rev-parse --short "$close_sha")"
}
