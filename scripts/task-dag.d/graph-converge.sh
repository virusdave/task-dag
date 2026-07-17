# shellcheck shell=bash
# ═══════════════════════════════════════════════════════════════════════
# task-dag GRAPH CONVERGENCE WIRING (issue #13 north-star)
#
# Mutating layer above the read-only facts/reconcile predicates:
#   • fold satisfied same-repo edges by pruning them from this repo's
#     refs/heads/tasks/v1/graph via the existing direct FF-CAS writer;
#   • deliver cross-repo completion hints through the bounded mailbox;
#   • run a periodic backstop that re-derives satisfied edges from master and
#     the local graph, so a lost mailbox hint still converges;
#   • cascade only from newly durable completions (not from mere readiness).
#
# The read-only `reconcile` command remains read-only. This file deliberately
# creates no per-fact refs and does not publish frontier refs; the graph index
# and master history stay the authoritative state.
# ═══════════════════════════════════════════════════════════════════════

TASKDAG_GRAPH_CONVERGE_CLI="${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}"

taskdag_node_repo() {
    local node="$1" rest
    node=$(taskdag_normalize_node "$node") || return 1
    rest="${node#*:}"
    rest="${rest%%@*}"
    rest="${rest%%#*}"
    printf '%s\n' "$rest"
}

taskdag_peer_path_config_key() {
    local repo
    repo=$(taskdag_norm_owner_repo "$1") || return 1
    printf 'taskdag.peer-path.%s.path\n' "$repo"
}

taskdag_peer_worktree_for() {
    local repo key path
    repo=$(taskdag_norm_owner_repo "$1") || return 1
    key=$(taskdag_peer_path_config_key "$repo") || return 1
    path=$(git config --get "$key" 2>/dev/null || true)
    [ -n "$path" ] || path="${TASKDAG_PEER_PATH_PREFIX:-}/${repo}"
    [ -n "$path" ] && [ -d "$path/.git" ] || return 1
    printf '%s\n' "$path"
}

taskdag_node_done_in_worktree() {
    local wt="$1" node="$2" rest repo ref tip scan commit first parents commit_tree first_tree found=false
    node=$(taskdag_normalize_node "$node") || return 2
    repo=$(taskdag_node_repo "$node") || return 2
    tip=$(git -C "$wt" rev-parse --verify -q refs/remotes/origin/master^{commit} 2>/dev/null \
        || git -C "$wt" rev-parse --verify -q refs/heads/master^{commit} 2>/dev/null \
        || git -C "$wt" rev-parse --verify -q HEAD^{commit} 2>/dev/null) || return 2
    case "$node" in
        task:*)
            rest="${node#task:}"; ref="${rest##*@}"
            [ "$(git -C "$wt" rev-parse "$ref^{tree}" 2>/dev/null)" = "$EMPTY_TREE" ] || return 1
            scan=$(git -C "$wt" rev-list --first-parent --parents "$tip" 2>/dev/null) || return 2
            while read -r commit first parents; do
                [ -n "$commit" ] && [ -n "$first" ] && [ -n "$parents" ] || continue
                case " $parents " in *" $ref "*) ;; *) continue ;; esac
                commit_tree=$(git -C "$wt" rev-parse "$commit^{tree}" 2>/dev/null || true)
                first_tree=$(git -C "$wt" rev-parse "$first^{tree}" 2>/dev/null || true)
                if [ -n "$commit_tree" ] && [ "$commit_tree" = "$first_tree" ]; then found=true; break; fi
            done <<< "$scan"
            [ "$found" = true ] || return 1
            ;;
        issue:*)
            rest="${node#issue:}"; ref="${rest##*#}"
            git -C "$wt" log "$tip" --merges --no-color \
                --format='%(trailers:key=Closes-Epic,valueonly,separator=%x0A)' 2>/dev/null \
                | sed 's/^#//' | grep -qx "$ref" || return 1
            ;;
    esac
}

taskdag_pending_root_for_task_sha() {
    local task_sha="$1" node="$task_sha" issue="" up="" rc=0
    while :; do
        issue=$(task_is_pending_root "$node" 2>/dev/null) || rc=$?
        if [ "$rc" -eq 0 ]; then
            printf '%s\t%s\n' "$issue" "$node"
            return 0
        fi
        [ "$rc" -eq 3 ] && return 2
        rc=0
        up=$(get_first_parent "$node" 2>/dev/null || true)
        [ -n "$up" ] || return 1
        is_task_commit "$up" || return 1
        node="$up"
    done
}

taskdag_emit_origin_epic_close() {
    local issue="$1" root_sha="$2" do_fetch="${3:-true}"
    _xrepo_ensure_git_identity

    if [ "$do_fetch" != false ]; then
        git fetch --quiet --no-tags origin '+refs/heads/master:refs/remotes/origin/master' >/dev/null 2>&1 \
            || { echo "Error: could not sync origin/master before auto-closing epic #${issue}" >&2; return 1; }
    fi

    if epic_already_closed_on "$issue" "$root_sha" "HEAD"; then
        return 0
    fi
    if git rev-parse --verify -q origin/master >/dev/null 2>&1 \
        && epic_already_closed_on "$issue" "$root_sha" "origin/master"; then
        return 0
    fi

    local intent_tip
    intent_tip=$(git rev-parse --verify -q refs/remotes/origin/master^{commit} 2>/dev/null \
        || git rev-parse --verify -q refs/heads/master^{commit} 2>/dev/null \
        || git rev-parse --verify -q HEAD^{commit}) || return 1
    if ! taskdag_materialisation_intents_durable "$issue" "$root_sha" "$intent_tip"; then
        echo "Epic #${issue} has child-epic materialisation intent that is not durable; deferring auto-close." >&2
        return 0
    fi

    local base tree msg close_sha readback
    base=$(git rev-parse --verify -q refs/remotes/origin/master^{commit} 2>/dev/null \
        || git rev-parse --verify -q refs/heads/master^{commit} 2>/dev/null \
        || git rev-parse --verify -q HEAD^{commit}) \
        || { echo "Error: cannot resolve master tip before auto-closing epic #${issue}" >&2; return 1; }
    tree=$(git rev-parse "${base}^{tree}") || return 1
    msg="Close epic #${issue} (obligations satisfied)

All task-dag obligations for this epic are satisfied.

Closes-Epic: #${issue}"
    close_sha=$(printf '%s' "$msg" | git commit-tree "$tree" -p "$base" -p "$root_sha") || return 1
    git push origin "--force-with-lease=refs/heads/master:${base}" \
        "${close_sha}:refs/heads/master" >/dev/null \
        || { echo "Error: failed to push auto-close commit for epic #${issue}" >&2; return 1; }
    readback=$(git ls-remote origin refs/heads/master 2>/dev/null | awk '{print $1}')
    [ "$readback" = "$close_sha" ] \
        || { echo "Error: auto-close push for epic #${issue} was not confirmed" >&2; return 1; }
    git update-ref refs/remotes/origin/master "$close_sha" 2>/dev/null || true
    git update-ref refs/heads/master "$close_sha" 2>/dev/null || true
    TASKDAG_FACTS_TIP_OID=""
    printf "${GREEN}✓ Auto-closed epic #%s with %s${RESET}\n" "$issue" "$(git rev-parse --short "$close_sha")" >&2
    printf '%s\n' "$close_sha"
}

# taskdag_auto_close_epic_for_task <task-sha> <do-fetch> [satisfied-edge-id]
# Evaluate the pending root containing <task-sha> with the reconcile
# obligations predicate and emit a normal Closes-Epic merge if it is complete.
# When called from a requires-edge fold, the edge is still active but may be a
# foreign target facts.sh cannot derive; the optional edge id is marked
# satisfied in memory after graph-converge has verified the target.
taskdag_auto_close_epic_for_task() {
    local task_sha="$1" do_fetch="${2:-true}" satisfied_eid="${3:-}"
    local found issue root_sha cur node prep=() rc=0 close_sha=""
    found=$(taskdag_pending_root_for_task_sha "$task_sha" 2>/dev/null) || rc=$?
    [ "$rc" -eq 2 ] && return 1
    [ -n "$found" ] || return 0
    IFS=$'\t' read -r issue root_sha <<< "$found"
    cur=$(taskdag_current_repo) || return 1
    node="task:${cur}@${root_sha}"

    [ "$do_fetch" = false ] && prep+=(--no-fetch)
    taskdag_recon_prepare "${prep[@]}" || return 1
    if [ -n "$satisfied_eid" ]; then
        TASKDAG_RECON_EDGES_JSON=$(printf '%s' "$TASKDAG_RECON_EDGES_JSON" \
            | jq --arg eid "$satisfied_eid" \
                'map(if .edgeId == $eid then (. + {satisfied:true}) else . end)') \
            || return 1
    fi

    taskdag_node_complete "$node" || rc=$?
    [ "$rc" -eq 2 ] && return 1
    [ "$rc" -eq 0 ] || return 0
    close_sha=$(taskdag_emit_origin_epic_close "$issue" "$root_sha" "$do_fetch") || return 1
    [ -n "$close_sha" ] && printf '%s\t%s\n' "issue:${cur}#${issue}" "$close_sha"
    return 0
}

# taskdag_verify_completed_node <node> [witness]: verify a completion fact from
# authoritative master history. Current-repo nodes use facts.sh. Foreign nodes
# require an explicit local peer worktree configured by
# taskdag.peer-path.<owner/repo> (or TASKDAG_PEER_PATH_PREFIX/<owner>/<repo>),
# so a mailbox hint is never trusted as authority.
taskdag_verify_completed_node() {
    local node="$1" witness="${2:-}" nrepo cur rc=0 wt
    node=$(taskdag_normalize_node "$node") || { echo "Error: invalid completed node: $node" >&2; return 2; }
    nrepo=$(taskdag_node_repo "$node") || return 2
    cur=$(taskdag_current_repo) || { echo "Error: cannot resolve current repo" >&2; return 2; }
    if [ "$nrepo" = "$cur" ]; then
        taskdag_node_done "$node" || rc=$?
        [ "$rc" -eq 0 ] || { [ "$rc" -eq 2 ] && return 2; return 1; }
        return 0
    fi

    wt=$(taskdag_peer_worktree_for "$nrepo") || {
        echo "Error: cannot verify foreign completion ${node}; configure $(taskdag_peer_path_config_key "$nrepo") to a local peer checkout" >&2
        return 2
    }
    taskdag_node_done_in_worktree "$wt" "$node" || rc=$?
    [ "$rc" -eq 0 ] || return "$rc"
    if [[ "$witness" =~ ^[0-9a-f]{40}$ ]]; then
        git -C "$wt" merge-base --is-ancestor "$witness" \
            "$(git -C "$wt" rev-parse --verify -q refs/remotes/origin/master^{commit} 2>/dev/null \
                || git -C "$wt" rev-parse --verify -q refs/heads/master^{commit} 2>/dev/null \
                || git -C "$wt" rev-parse --verify -q HEAD^{commit})" 2>/dev/null \
            || { echo "Error: witness ${witness:0:12} is not reachable from ${nrepo} master" >&2; return 2; }
    fi
}

taskdag_graph_prune_edge_with_witness() {
    local eid="$1" relation="$2" from="$3" to="$4" trigger="$5" witness="$6" mid="${7:-}"
    local msg rc=0
    [[ "$eid" =~ ^[0-9a-f]{64}$ ]] || return 1
    msg="Fold dependency edge ${eid:0:12} (${relation})

Edge-Id: ${eid}
Relation: ${relation}
From: ${from}
To: ${to}
Trigger-Node: ${trigger}
Trigger-Witness: ${witness}"
    if [ -n "$mid" ]; then
        msg="${msg}
Mailbox-Message-Id: ${mid}"
    fi
    _taskdag_graph_cas "$msg" remove "edges/${eid}.json" "" || rc=$?
    case "$rc" in
        0) printf "${GREEN}✓ Folded edge %s${RESET} (%s %s %s)\n" "${eid:0:12}" "$from" "$relation" "$to" >&2 ;;
        2) printf "${BLUE}• Edge %s already folded${RESET} (idempotent no-op)\n" "${eid:0:12}" >&2 ;;
        *) return 1 ;;
    esac
}

taskdag_synth_supersede_completion() {
    local from="$1" edge_id="$2" trigger="$3" witness="$4" mid="${5:-}"
    local cur rest repo task short children="" active_ref base tree msg new_commit lease readback rc=0
    from=$(taskdag_normalize_node "$from") || return 2
    case "$from" in task:*) ;; *) echo "Error: cannot synth-complete non-task supersede target: $from" >&2; return 2 ;; esac
    repo=$(taskdag_node_repo "$from") || return 2
    cur=$(taskdag_current_repo) || return 2
    [ "$repo" = "$cur" ] || { echo "Error: refusing to synth-complete foreign task in local repo: $from" >&2; return 2; }
    rest="${from#task:}"; task="${rest##*@}"
    git rev-parse -q --verify "$task^{commit}" >/dev/null 2>&1 || return 2
    is_task_commit "$task" || { echo "Error: supersede target is not an empty-tree task commit: $task" >&2; return 2; }
    taskdag_recon_build_child_map
    children="${TASKDAG_RECON_FP_CHILDREN[$task]:-}"
    [ -z "$children" ] || { echo "Error: refusing to synth-complete decomposed task/epic ${task:0:12}; supersede completion for epics is not safe in this phase" >&2; return 2; }

    taskdag_node_done "$from" >/dev/null 2>&1 && return 0
    short=$(git rev-parse --short "$task") || return 2
    active_ref="refs/heads/tasks/active/$short"
    if git show-ref --verify --quiet "$active_ref" || git ls-remote --exit-code origin "$active_ref" >/dev/null 2>&1; then
        echo "Error: refusing to auto-complete ${short}; it is actively claimed" >&2
        return 2
    fi

    taskdag_sync_master || { echo "Error: could not sync origin/master before synth completion" >&2; return 2; }
    base=$(git rev-parse --verify -q refs/remotes/origin/master^{commit} 2>/dev/null \
        || git rev-parse --verify -q refs/heads/master^{commit} 2>/dev/null \
        || git rev-parse --verify -q HEAD^{commit}) || return 2
    tree=$(git rev-parse "$base^{tree}") || return 2
    msg="Supersede task ${short}

Task-Commit: ${task}
Status: completed
Superseded-By: ${trigger}
Supersede-Edge-Id: ${edge_id}
Trigger-Witness: ${witness}"
    if [ -n "$mid" ]; then
        msg="${msg}
Mailbox-Message-Id: ${mid}"
    fi
    new_commit=$(printf '%s' "$msg" | git commit-tree "$tree" -p "$base" -p "$task") || return 1
    lease="--force-with-lease=refs/heads/master:${base}"
    git push origin "$lease" "${new_commit}:refs/heads/master" >/dev/null || return 1
    readback=$(git ls-remote origin refs/heads/master 2>/dev/null | awk '{print $1}')
    [ "$readback" = "$new_commit" ] || { echo "Error: synth completion push for ${short} was not confirmed" >&2; return 1; }
    git fetch --quiet --no-tags origin '+refs/heads/master:refs/remotes/origin/master' 2>/dev/null || true
    git update-ref refs/heads/master "$new_commit" 2>/dev/null || true
    TASKDAG_FACTS_TIP_OID="" # invalidate facts cache after master moved
    printf "${GREEN}✓ Synth-completed superseded task %s${RESET}\n" "$short" >&2
    printf '%s\n' "$new_commit"
}

taskdag_propagate_one_node() {
    local node="$1" witness="$2" mid="${3:-}" do_fetch="${4:-true}"
    local args=() edges cur nrepo out rc=0
    [ "$do_fetch" = false ] && args+=(--no-fetch)
    node=$(taskdag_normalize_node "$node") || return 2
    taskdag_verify_completed_node "$node" "$witness" || return $?
    edges=$(taskdag_read_edges "${args[@]}") || return 2
    cur=$(taskdag_current_repo) || return 2
    while IFS=$'\t' read -r eid from to relation; do
        [ -n "$eid" ] || continue
        [ "$to" = "$node" ] || continue
        nrepo=$(taskdag_node_repo "$from") || return 2
        if [ "$nrepo" != "$cur" ]; then
            echo "Error: local graph contains foreign dependent ${from}; refusing to mutate wrong repo" >&2
            return 2
        fi
        case "$relation" in
            requires)
                # If this satisfied requires-edge completes an epic, close it
                # BEFORE folding the edge away. A requires-only epic would
                # otherwise lose its last non-empty obligation and never emit
                # the durable Closes-Epic fact. If close emission is due but
                # fails, leave the edge in place so a later backstop can retry.
                out=$(taskdag_auto_close_epic_for_task "${from##*@}" "$do_fetch" "$eid") || { rc=1; continue; }
                [ -n "$out" ] && printf '%s\n' "$out"
                taskdag_graph_prune_edge_with_witness "$eid" "$relation" "$from" "$to" "$node" "$witness" "$mid" || rc=1
                # If the dependent was already durable-done, cascade from it;
                # readiness alone is not completion and does not cascade.
                if taskdag_verify_completed_node "$from" "$witness" >/dev/null 2>&1; then
                    printf '%s\t%s\n' "$from" "$witness"
                fi
                ;;
            satisfies)
                out=$(taskdag_synth_supersede_completion "$from" "$eid" "$node" "$witness" "$mid") || { rc=1; continue; }
                [ -n "$out" ] && printf '%s\t%s\n' "$from" "$(printf '%s\n' "$out" | tail -n1)"
                taskdag_graph_prune_edge_with_witness "$eid" "$relation" "$from" "$to" "$node" "$witness" "$mid" || rc=1
                ;;
            *) echo "Error: unknown edge relation: $relation" >&2; return 2 ;;
        esac
    done < <(printf '%s' "$edges" | jq -r '.[] | [.edgeId, .from, .to, .relation] | @tsv')
    return "$rc"
}

taskdag_notify_peers() {
    local node="$1" witness="$2" spec remote dest repo_id
    shift 2
    for spec in "$@"; do
        [ -n "$spec" ] || continue
        remote="${spec%%:*}"; dest="${spec#*:}"
        [ "$remote" != "$spec" ] || { echo "Error: --notify-peer expects <remote>:<owner/repo>" >&2; return 2; }
        repo_id=$(taskdag_repo_numeric_id "$(taskdag_node_repo "$node")") || return 1
        taskdag_mailbox_put completion "$node" "$witness" "$dest" "$(taskdag_node_repo "$node")" "$repo_id" "$remote" "completion propagation hint" || return 1
    done
}

cmd_propagate_completion() {
    local node="" witness="" mid="" do_fetch=true notify=()
    while [ $# -gt 0 ]; do
        case "$1" in
            --node|--witness|--mailbox-message-id|--notify-peer)
                [ $# -ge 2 ] || { echo "Error: $1 requires a value" >&2; return 2; } ;;
        esac
        case "$1" in
            --node) node="$2"; shift 2 ;;
            --witness) witness="$2"; shift 2 ;;
            --mailbox-message-id) mid="$2"; shift 2 ;;
            --notify-peer) notify+=("$2"); shift 2 ;;
            --no-fetch) do_fetch=false; shift ;;
            --help|-h)
                cat <<'EOF'
Usage: task-dag propagate-completion --node <node> --witness <sha> [--no-fetch]
                                     [--mailbox-message-id <id>]
                                     [--notify-peer <remote>:<owner/repo>]

Fold the effects of one durable completion into this repo's graph and enqueue
optional cross-repo mailbox hints. Mutates only refs/heads/tasks/v1/graph
(and, for a local leaf superseded by a satisfies edge, a standard completion
merge on master). Mailbox hints are triggers, not facts; every fold verifies
the completed node from master before mutating.
EOF
                return 0 ;;
            *) echo "Error: unknown option to propagate-completion: $1" >&2; return 2 ;;
        esac
    done
    [ -n "$node" ] || { echo "Error: propagate-completion requires --node" >&2; return 2; }
    [ -n "$witness" ] || { echo "Error: propagate-completion requires --witness" >&2; return 2; }
    local normalized_node spec remote dest
    normalized_node="$(taskdag_normalize_node "$node")" || { echo "Error: invalid completion node: $node" >&2; return 2; }
    [[ "$witness" =~ ^[0-9a-f]{40}$|^[0-9a-f]{64}$ ]] || { echo "Error: --witness must be 40 or 64 lowercase hex" >&2; return 2; }
    [ -z "$mid" ] || [[ "$mid" =~ ^[0-9a-f]{64}$ ]] || { echo "Error: --mailbox-message-id must be 64 lowercase hex" >&2; return 2; }
    for spec in "${notify[@]}"; do
        remote="${spec%%:*}"; dest="${spec#*:}"
        [ -n "$remote" ] && [ "$dest" != "$spec" ] && taskdag_norm_owner_repo "$dest" >/dev/null \
            || { echo "Error: --notify-peer expects <remote>:<owner/repo>" >&2; return 2; }
    done
    taskdag_migration_guard projection || return $?
    local seen=$'\n' n w cn cw next rc=0 idx=0
    local -a q_nodes=() q_witnesses=()
    q_nodes+=("$normalized_node")
    q_witnesses+=("$witness")
    taskdag_verify_completed_node "${q_nodes[0]}" "$witness" || return $?
    taskdag_notify_peers "$node" "$witness" "${notify[@]}" || return $?
    while [ "$idx" -lt "${#q_nodes[@]}" ]; do
        n="${q_nodes[$idx]}"
        w="${q_witnesses[$idx]}"
        idx=$((idx + 1))
        [ -n "$n" ] || continue
        case "$seen" in *$'\n'"$n"$'\n'*) continue ;; esac
        seen+="$n"$'\n'
        case "$n" in
            task:*)
                next=$(taskdag_auto_close_epic_for_task "${n##*@}" "$do_fetch") || return $?
                while IFS=$'\t' read -r cn cw; do
                    [ -n "$cn" ] || continue
                    q_nodes+=("$cn")
                    q_witnesses+=("$cw")
                done <<< "$next"
                ;;
        esac
        next=$(taskdag_propagate_one_node "$n" "$w" "$mid" "$do_fetch") || rc=$?
        [ "$rc" -eq 0 ] || return "$rc"
        while IFS=$'\t' read -r cn cw; do
            [ -n "$cn" ] || continue
            q_nodes+=("$cn")
            q_witnesses+=("$cw")
        done <<< "$next"
    done
}

cmd_reconcile_backstop() {
    local do_fetch=true consume=true remote=origin
    while [ $# -gt 0 ]; do
        case "$1" in
            --no-fetch) do_fetch=false; shift ;;
            --no-mailbox) consume=false; shift ;;
            --remote) [ $# -ge 2 ] || { echo "Error: --remote requires a value" >&2; return 2; }; remote="$2"; shift 2 ;;
            --help|-h)
                cat <<'EOF'
Usage: task-dag reconcile-backstop [--no-fetch] [--no-mailbox] [--remote <name>]

Periodic convergence backstop: consume this repo's mailbox and re-derive every
satisfied local graph edge from authoritative master history (including
configured peer worktrees for foreign targets). Idempotent and safe to rerun.
EOF
                return 0 ;;
            *) echo "Error: unknown option to reconcile-backstop: $1" >&2; return 2 ;;
        esac
    done

    taskdag_migration_guard projection || return $?
    local rc=0 helper args=() edges n w helper_fetch_arg=""
    if [ "$consume" = true ]; then
        [ "$do_fetch" = false ] && helper_fetch_arg="--no-fetch"
        helper=$(mktemp "${TMPDIR:-/tmp}/taskdag-fold.XXXXXX") || return 1
        cat > "$helper" <<EOF
#!/usr/bin/env bash
set -euo pipefail
"$TASKDAG_GRAPH_CONVERGE_CLI" propagate-completion --node "\$TASKDAG_MAILBOX_NODE" --witness "\$TASKDAG_MAILBOX_WITNESS" --mailbox-message-id "\$TASKDAG_MAILBOX_MESSAGE_ID" $helper_fetch_arg
EOF
        chmod 0755 "$helper"
        local mb_args=(--remote "$remote" --fold-cmd "$helper")
        [ "$do_fetch" = false ] && mb_args+=(--no-fetch)
        cmd_mailbox consume "${mb_args[@]}" || rc=1
        rm -f "$helper"
    fi

    [ "$do_fetch" = false ] && args+=(--no-fetch)
    edges=$(taskdag_read_edges "${args[@]}") || return 2
    while IFS=$'\t' read -r n w; do
        [ -n "$n" ] || continue
        if taskdag_verify_completed_node "$n" "$w" >/dev/null 2>&1; then
            cmd_propagate_completion --node "$n" --witness "$w" "${args[@]}" || rc=1
        fi
    done < <(printf '%s' "$edges" | jq -r '.[] | [.to, .origin.witness] | @tsv' | sort -u)
    return "$rc"
}

taskdag_push_completed_nodes() {
    local range="$1" cur commit parents first p tree issue commits commit_tree first_tree
    cur=$(taskdag_current_repo) || return 2
    commits=$(git rev-list --reverse --first-parent "$range" 2>/dev/null) || {
        echo "Error: cannot scan pushed range '$range' for completion facts" >&2
        return 2
    }
    while IFS= read -r commit; do
        [ -n "$commit" ] || continue
        parents=$(git show -s --format='%P' "$commit")
        first="${parents%% *}"
        commit_tree=$(git rev-parse "$commit^{tree}" 2>/dev/null || true)
        first_tree=$(git rev-parse "$first^{tree}" 2>/dev/null || true)
        if [ -n "$first" ] && [ "$commit_tree" = "$first_tree" ]; then
            parents="${parents#"$first"}"
        else
            parents=""
        fi
        for p in $parents; do
            tree=$(git rev-parse -q --verify "$p^{tree}" 2>/dev/null || true)
            if [ "$tree" = "$EMPTY_TREE" ]; then
                printf 'task:%s@%s\t%s\n' "$cur" "$p" "$commit"
            fi
        done
        while IFS= read -r issue; do
            [ -n "$issue" ] && printf 'issue:%s#%s\t%s\n' "$cur" "${issue#\#}" "$commit"
        done < <(git show -s --format='%(trailers:key=Closes-Epic,valueonly,separator=%x0A)' "$commit" | grep -E '^#?[1-9][0-9]*$' || true)
    done <<< "$commits"
}

cmd_graph_converge() {
    local range="" do_fetch=true notify=()
    while [ $# -gt 0 ]; do
        case "$1" in
            --range|--notify-peer) [ $# -ge 2 ] || { echo "Error: $1 requires a value" >&2; return 2; } ;;
        esac
        case "$1" in
            --range) range="$2"; shift 2 ;;
            --notify-peer) notify+=("$2"); shift 2 ;;
            --no-fetch) do_fetch=false; shift ;;
            --help|-h)
                cat <<'EOF'
Usage: task-dag graph-converge [--range <git-range>] [--notify-peer <remote>:<owner/repo>] [--no-fetch]

Push-reaction entry point: fold completions found in a pushed master range,
deliver optional mailbox hints, run the periodic graph backstop, then repair
stale scheduling refs from durable completion parentage on origin/master.
EOF
                return 0 ;;
            *) echo "Error: unknown option to graph-converge: $1" >&2; return 2 ;;
        esac
    done
    local spec remote dest
    for spec in "${notify[@]}"; do
        remote="${spec%%:*}"; dest="${spec#*:}"
        [ -n "$remote" ] && [ "$dest" != "$spec" ] && taskdag_norm_owner_repo "$dest" >/dev/null \
            || { echo "Error: --notify-peer expects <remote>:<owner/repo>" >&2; return 2; }
    done
    taskdag_migration_guard projection || return $?
    local args=() rc=0 n w completed
    [ "$do_fetch" = false ] && args+=(--no-fetch)
    if [ -n "$range" ]; then
        local notify_args=() spec
        for spec in "${notify[@]}"; do
            notify_args+=(--notify-peer "$spec")
        done
        if completed=$(taskdag_push_completed_nodes "$range"); then
            while IFS=$'\t' read -r n w; do
                [ -n "$n" ] || continue
                cmd_propagate_completion --node "$n" --witness "$w" "${args[@]}" "${notify_args[@]}" || rc=1
            done <<< "$completed"
        else
            rc=1
        fi
    fi
    cmd_reconcile_backstop "${args[@]}" || rc=1
    if [ "$do_fetch" = true ]; then
        reconcile_completed_task_refs origin || rc=1
    else
        echo "Note: --no-fetch skips completed scheduling-ref reconciliation (an authoritative origin snapshot is required)." >&2
    fi
    return "$rc"
}
