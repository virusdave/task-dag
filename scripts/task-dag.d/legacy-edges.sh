# shellcheck shell=bash
# ═══════════════════════════════════════════════════════════════════════
# task-dag LEGACY DEPENDENCY ENCODING → edge migration (issue #13)
#
# One-time/back-compat bridge for dependency semantics that predate the
# bounded graph index. It scans the current task refs/history and backfills
# machine-readable edges into refs/heads/tasks/v1/graph via the normal
# direct-CAS `dep add` writer. It never hand-edits the graph tree.
# ═══════════════════════════════════════════════════════════════════════

taskdag_legacy_edge_nodes_from_text() {
    grep -Eo '(task|issue):[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(@[A-Fa-f0-9]{40}|@[A-Fa-f0-9]{64}|#[1-9][0-9]*)' <<<"$1" || true
}

taskdag_legacy_edges_rows() {
    local cur
    cur=$(taskdag_current_repo) || { echo "Error: cannot resolve current repo to migrate legacy edges" >&2; return 2; }

    local us=$'\x1f' commit tree subject parents first dep
    while IFS="$us" read -r commit tree subject parents; do
        [ -n "$commit" ] || continue
        [ "$tree" = "$EMPTY_TREE" ] || continue
        case "$subject" in Claim:*|Blocked-Meta:*) continue ;; esac
        set -- $parents
        [ $# -gt 1 ] || continue
        first="$1"; shift
        for dep in "$@"; do
            is_task_commit "$dep" || continue
            printf '%s\t%s\t%s\t%s\t%s\n' \
                "task:${cur}@${commit}" "task:${cur}@${dep}" requires \
                "$commit" "legacy-extra-parent:${first}"
        done
    done < <(git log --all --format="%H${us}%T${us}%s${us}%P" 2>/dev/null)

    local ref obj rest top owner repo issue epic
    while read -r ref obj; do
        [ -n "$ref" ] || continue
        rest="${ref#refs/heads/tasks/delegated/}"
        IFS=/ read -r top owner repo issue _extra <<<"$rest"
        [ -n "$top" ] && [ -n "$owner" ] && [ -n "$repo" ] && [[ "$issue" =~ ^[1-9][0-9]*$ ]] || continue
        epic=$(get_first_parent "$obj" 2>/dev/null || true)
        [ -n "$epic" ] && is_task_commit "$epic" || continue
        local delegated_to
        delegated_to=$(taskdag_normalize_node "issue:${owner}/${repo}#${issue}") || continue
        printf '%s\t%s\t%s\t%s\t%s\n' \
            "task:${cur}@${epic}" "$delegated_to" requires \
            "$obj" "legacy-delegated:${top}/${owner}/${repo}/${issue}"
    done < <(git for-each-ref refs/heads/tasks/delegated/ --format='%(refname) %(objectname)' 2>/dev/null)

    local sha meta kind body node task_msg by
    while read -r sha _ref; do
        [ -n "$sha" ] || continue
        meta=""
        if has_blocked_meta "$sha"; then
            kind=$(read_blocked_meta_field "$sha" "Blocker-Kind")
        else
            kind=""
        fi
        [ "$kind" = downstream ] || continue
        body=$(printf '%s\n%s\n%s\n%s\n%s\n' \
            "$(read_blocked_meta_field "$sha" "Downstream-On")" \
            "$(read_blocked_meta_field "$sha" "On")" \
            "$(read_blocked_meta_field "$sha" "Depends-On")" \
            "$(read_blocked_meta_field "$sha" "Reason")" \
            "$(read_blocked_meta_field "$sha" "Request-URL")")
        while IFS= read -r node; do
            [ -n "$node" ] || continue
            node=$(taskdag_normalize_node "$node") || continue
            printf '%s\t%s\t%s\t%s\t%s\n' \
                "task:${cur}@${sha}" "$node" requires "$sha" "legacy-downstream-block"
        done < <(taskdag_legacy_edge_nodes_from_text "$body")
    done < <(git for-each-ref refs/heads/tasks/blocked/ --format='%(objectname) %(refname)' 2>/dev/null)

    while IFS="$us" read -r commit tree subject _parents; do
        [ -n "$commit" ] || continue
        [ "$tree" = "$EMPTY_TREE" ] || continue
        case "$subject" in Claim:*|Blocked-Meta:*) continue ;; esac
        task_msg=$(parse_commit_metadata "$commit" 2>/dev/null || true)
        body=$(printf '%s\n%s\n%s\n' \
            "$(extract_field "$task_msg" "Superseded-By")" \
            "$(extract_field "$task_msg" "Rescoped-By")" \
            "$(extract_field "$task_msg" "Re-Scoped-By")")
        if [ -z "$(taskdag_legacy_edge_nodes_from_text "$body")" ] \
           && grep -qiE 'supersed|re-?scope|rescop' <<<"$task_msg"; then
            body="$task_msg"
        fi
        by=$(taskdag_legacy_edge_nodes_from_text "$body" | head -1 || true)
        [ -n "$by" ] || continue
        by=$(taskdag_normalize_node "$by") || continue
        printf '%s\t%s\t%s\t%s\t%s\n' \
            "task:${cur}@${commit}" "$by" satisfies "$commit" "legacy-supersede-prose"
    done < <(git log --all --format="%H${us}%T${us}%s${us}%P" 2>/dev/null)
}

cmd_migrate_legacy_edges() {
    local dry_run=false json=false do_fetch=true
    while [ $# -gt 0 ]; do
        case "$1" in
            --dry-run) dry_run=true; shift ;;
            --json) json=true; shift ;;
            --no-fetch) do_fetch=false; shift ;;
            --help|-h)
                cat <<'EOF'
Usage: task-dag migrate-legacy-edges [--dry-run] [--json] [--no-fetch]

Backfill legacy dependency encodings into the bounded edge graph:
  • in-repo extra task parents        → requires edges
  • tasks/delegated/* refs            → requires edges to child issues
  • blocked-meta downstream explicit nodes (Downstream-On/On/Depends-On)
                                      → requires edges
  • explicit Superseded-By/Rescoped-By task trailers
                                      → satisfies edges

Writes use the normal `dep add` direct-CAS path and are idempotent by
semantic edge-id. Prose-only downstream/re-scope notes with no canonical
task:/issue: node are intentionally not guessed; their legacy blocked refs
continue to withhold work until an operator records an explicit `--on` or
`supersede` edge.

Rollback: ignore or delete refs/heads/tasks/v1/graph; the historical legacy
refs/parents are not changed by this command.
EOF
                return 0 ;;
            *) echo "Error: unknown option to migrate-legacy-edges: $1" >&2; return 2 ;;
        esac
    done

    command -v jq >/dev/null 2>&1 || { echo "Error: jq is required for migrate-legacy-edges" >&2; return 2; }
    if [ "$do_fetch" = true ]; then
        fetch_task_refs
    fi

    local rows row from to rel witness source eid rc=0 count=0
    rows=$(taskdag_legacy_edges_rows) || return $?

    if [ "$json" = true ]; then
        local -a objs=()
        while IFS=$'\t' read -r from to rel witness source; do
            [ -n "$from" ] || continue
            from=$(taskdag_normalize_node "$from") || return 1
            to=$(taskdag_normalize_node "$to") || return 1
            eid=$(taskdag_edge_id "$from" "$to" "$rel" "$( [ "$rel" = satisfies ] && echo any || echo all )") || return 1
            objs+=("$(jq -nc --arg from "$from" --arg to "$to" --arg relation "$rel" \
                --arg edgeId "$eid" --arg witness "$witness" --arg source "$source" \
                '{edgeId:$edgeId, from:$from, to:$to, relation:$relation, witness:$witness, legacySource:$source}')")
        done <<<"$rows"
        if [ "${#objs[@]}" -eq 0 ]; then printf '[]\n'; else printf '%s\n' "${objs[@]}" | jq -sc 'sort_by(.edgeId)'; fi
        [ "$dry_run" = true ] && return 0
    fi

    while IFS=$'\t' read -r from to rel witness source; do
        [ -n "$from" ] || continue
        count=$((count + 1))
        if [ "$dry_run" = true ]; then
            printf '%s\t%s\t%s\t%s\n' "$rel" "$from" "$to" "$source"
            continue
        fi
        _cmd_dep_add --from "$from" --to "$to" --relation "$rel" --witness "$witness" \
            --reason "legacy edge migration: ${source}" || rc=1
    done <<<"$rows"
    [ "$dry_run" = true ] && printf "${BLUE}• Would migrate %d legacy edge(s)${RESET}\n" "$count" >&2
    return "$rc"
}
