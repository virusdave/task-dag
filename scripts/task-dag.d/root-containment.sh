#!/usr/bin/env bash
# Root containment snapshot, semantic subtree, and local-close policy.
# Loaded late by the entrypoint: command adapters remain in task-dag.

for prerequisite in parse_commit_metadata extract_field \
    taskdag_prepare_child_map taskdag_sync_root_refs taskdag_recon_prepare \
    taskdag_current_repo taskdag_node_complete taskdag_root_closed_at_tip \
    get_first_parent is_task_commit pending_sha_on_remote_checked task_is_root_shaped_epic \
    fetch_task_refs_strict \
    taskdag_consumer_prepare taskdag_root_status_json taskdag_migration_guard \
    taskdag_materialisation_intents_durable taskdag_activation_snapshot_token \
    taskdag_epic_registry_record taskdag_root_locator taskdag_resolve_typed_root; do
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
    local sha="$1" issue epic_id root_format remote rc suffix locator msg
    msg=$(parse_commit_metadata "$sha") || return 1
    root_format=$(extract_field "$msg" "Epic-Root-Format" 2>/dev/null || true)
    epic_id=$(extract_field "$msg" "Epic-ID" 2>/dev/null || true)
    if [ -n "$root_format" ] || [ -n "$epic_id" ]; then
        [ "$root_format" = 1 ] || return 1
        [[ "$epic_id" =~ ^epic-v1:[0-9a-f]{64}$ ]] || return 1
        suffix="epic-v1/${epic_id#epic-v1:}"
        locator=$(taskdag_root_locator "$epic_id") || return 1
        taskdag_resolve_typed_root "$locator" "$sha" >/dev/null || return 1
    else
        issue=$(extract_field "$msg" "Issue" 2>/dev/null | sed 's/^#//' || true)
        [ -n "$issue" ] || return 1
        suffix=$issue
    fi
    remote=$(pending_sha_on_remote_checked "$suffix"); rc=$?
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
        if [ "$(git rev-parse --verify -q "refs/heads/tasks/pending/$suffix" 2>/dev/null)" = "$sha" ]; then
            : # local mirror confirms → root
        elif task_is_root_shaped_epic "$sha"; then
            return 3
        else
            return 1
        fi
    fi
    printf '%s\n' "$suffix"
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
    local locator="$1" epic_sha="$2" base_ref="$3"
    locator=${locator/epic-v1\//epic-v1:}
    taskdag_root_closed_at_tip "$base_ref" "$locator" "$epic_sha"
}

# Typed leaf completion and typed root closure are separate transitions.  This
# admission check authorizes only the former: the registered root may remain
# open while children complete.  The dedicated activation floor keeps this
# path dormant until every participating runtime understands that lifecycle.
taskdag_typed_root_completion_preflight() { # task [authority-tip]
    local node=$1 authority=${2:-HEAD} parent epic_id="" msg token floor rows registry master record root
    local node_epic close_rc
    msg=$(parse_commit_metadata "$node" 2>/dev/null || true)
    epic_id=$(extract_field "$msg" Epic-ID 2>/dev/null || true)
    [ -n "$epic_id" ] || return 0
    [[ "$epic_id" =~ ^epic-v1:[0-9a-f]{64}$ ]] || return 2

    token=$(taskdag_activation_snapshot_token) || return 3
    floor=$(jq -er .minimumCompatibleTaskDagCommit <<<"$token") || return 3
    git -C "$TASKDAG_SCRIPT_DIR/.." cat-file -e "$TASKDAG_TYPED_COMPLETION_CUTOVER^{commit}" 2>/dev/null || return 3
    git -C "$TASKDAG_SCRIPT_DIR/.." merge-base --is-ancestor "$TASKDAG_TYPED_COMPLETION_CUTOVER" "$floor" || return 3

    rows=$(git ls-remote --refs origin "$TASKDAG_EPIC_REGISTRY_REF" refs/heads/master) || return 3
    registry=$(awk -v r="$TASKDAG_EPIC_REGISTRY_REF" '$2==r{print $1}' <<<"$rows")
    master=$(awk '$2=="refs/heads/master"{print $1}' <<<"$rows")
    [ -n "$registry" ] && [ -n "$master" ] || return 3
    git fetch -q --no-tags origin "$registry" "$master" || return 3
    record=$(taskdag_epic_registry_record "$epic_id" "$registry" "$master") || return 3
    root=$(jq -er .rootCommit <<<"$record") || return 3

    # The registry is root authority.  Children inherit Epic-ID, so stopping
    # at the first task carrying that field would incorrectly treat the leaf
    # as its own root.  Walk strict first-parent containment to the exact
    # immutable registry root and reject a lineage that changes Epic-ID.
    while :; do
        [ "$node" = "$root" ] && break
        msg=$(parse_commit_metadata "$node" 2>/dev/null || true)
        node_epic=$(extract_field "$msg" Epic-ID 2>/dev/null || true)
        [ "$node_epic" = "$epic_id" ] || return 2
        parent=$(get_first_parent "$node" 2>/dev/null || true)
        [ -n "$parent" ] && is_task_commit "$parent" || return 2
        node=$parent
    done
    [ "$(taskdag_resolve_typed_root "$(taskdag_root_locator "$epic_id")" "$root")" = "$(jq -cS .descriptor <<<"$record")" ] || return 2

    # A root that was closed before this child acquired a durable completion
    # fact is corrupt/premature; never add work beneath a closed root.
    close_rc=0; epic_already_closed_on "$epic_id" "$root" "$authority" || close_rc=$?
    case "$close_rc" in 0) return 2 ;; 1) return 0 ;; 2) return 2 ;; *) return 2 ;; esac
}

maybe_emit_local_epic_close() {
    local task_sha="$1" close_rc

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

    # A typed close already present on either local authority is an idempotent
    # success. Otherwise keep typed writers closed before any fetch, object
    # creation, ref update, or origin mutation.
    if [[ "$issue" = epic-v1/* ]]; then
        close_rc=0; epic_already_closed_on "$issue" "$root_sha" HEAD || close_rc=$?
        case "$close_rc" in 0) return 0 ;; 1) ;; 2) return 2 ;; *) return 2 ;; esac
        if git rev-parse --verify -q origin/master >/dev/null 2>&1; then
            close_rc=0; epic_already_closed_on "$issue" "$root_sha" origin/master || close_rc=$?
            case "$close_rc" in 0) return 0 ;; 1) ;; 2) return 2 ;; *) return 2 ;; esac
        fi
        printf "${YELLOW}⚠ Epic-ID root %s is complete, but typed close writers remain gated pending external reader rollout and the Closes-Epic-ID codec.${RESET}\n" \
            "${issue/epic-v1\//epic-v1:}" >&2
        return 75
    fi

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
    close_rc=0; epic_already_closed_on "$issue" "$root_sha" HEAD || close_rc=$?
    case "$close_rc" in 0) return 0 ;; 1) ;; 2) return 2 ;; *) return 2 ;; esac
    if git rev-parse --verify -q origin/master >/dev/null 2>&1; then
        close_rc=0; epic_already_closed_on "$issue" "$root_sha" origin/master || close_rc=$?
        case "$close_rc" in 0) return 0 ;; 1) ;; 2) return 2 ;; *) return 2 ;; esac
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
