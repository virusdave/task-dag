# shellcheck shell=bash
# ═══════════════════════════════════════════════════════════════════════
# task-dag RECONCILE PREDICATES: complete() + leaf-readiness over the edge
# graph (issue #13 north-star — the AGGREGATION layer above the raw facts).
#
# The fact layer (scripts/task-dag.d/facts.sh) emits only two EDGE-LOCAL
# booleans, purely from master's completion history and in memory:
#   • done(node)      — is a node's completion a durable git fact on master?
#   • satisfied(edge) — done(edge.to), the SAME boolean for both relations.
#
# This module turns those raw facts into BEHAVIOR by aggregating them across
# the containment tree (first-parent children) and the two edge relations,
# implementing the north-star predicates:
#
#   complete(node):
#     if ANY outgoing satisfies-edge is satisfied: return true   # supersede
#     if node is an EPIC (first-parent children, or Type: epic with outgoing
#                        requires-edges):
#         return obligations non-empty
#            AND every requires-edge satisfied
#            AND every child subtree complete()                  # obligations
#     else (a LEAF / issue / foreign node):
#         return done(node)                                      # authoritative
#
#   leaf-readiness(node) = NOT complete(node)  AND  every requires-edge
#     satisfied  AND (for a current-repo task node) unclaimed AND unblocked.
#
# A node is classified EPIC vs LEAF by CONTAINMENT (does it have first-parent
# children?) and explicit Type: epic roots BEFORE the raw done() fact is
# trusted, and this ordering is load-bearing: the fact layer derives done()
# from ANY parent-field token reachable from master, and an epic root is its
# children's FIRST-parent token — so a decomposed epic false-positives as
# done() the instant any one child completes. Completeness of an epic is
# therefore always derived from its obligations (exactly like the legacy
# epic_subtree_complete), never from done(); done() stays authoritative only
# for a leaf (which appears solely as the 2nd parent of its own completion
# merge) and an issue (Closes-Epic). A LEAF's outgoing requires-edges gate
# READINESS, not completeness.
#
# Semantics locked by the operator on issue #13: requires = ALL (a plain AND
# — OR-deps are out of scope), satisfies = ANY (supersede). A requires-edge
# uses the edge-local `satisfied` (= done(.to)); a node completed ONLY via
# supersede becomes `done` once the reconciler backstop synthesizes its
# completion merge on master (a SEPARATE sibling task — see the scope
# boundary below), so `satisfied` converges without this layer recursing over
# edges. The ONLY recursion here is over the containment FOREST (each task
# commit has exactly one first parent), which is inherently acyclic and
# bounded by the decomposition depth.
#
# READ-ONLY / ADDITIVE. This module computes predicates and reports them; it
# NEVER writes a ref. Mutating graph convergence and epic close emission live
# in sibling modules and call this predicate layer instead of re-implementing
# its semantics.
#
# Relies on: facts.sh (taskdag_node_done, taskdag_edges_with_facts,
# taskdag_current_repo, taskdag_sync_master), edges.sh (taskdag_normalize_node),
# and the containment-tree / block helpers from the main script
# (is_task_commit, get_first_parent, is_task_blocked,
# blocked_structural_ancestor). Requires jq.
# ═══════════════════════════════════════════════════════════════════════

# The canonical empty tree — also defined in the main script; a fallback so
# this module is correct when sourced standalone (tests).
: "${EMPTY_TREE:=4b825dc642cb6eb9a060e54bf8d69288fbee4904}"

# Per-invocation state, prepared ONCE by taskdag_recon_prepare so the
# recursion never re-fetches / re-scans:
#   • the active edge set annotated with `satisfied` (from facts.sh),
#   • the containment child map (first-parent -> newline-joined child SHAs),
#   • the resolved current repo (to address current-repo task nodes).
TASKDAG_RECON_EDGES_JSON=""
TASKDAG_RECON_FACTS_TIP=""
declare -gA TASKDAG_RECON_FP_CHILDREN=()
declare -gA TASKDAG_RECON_NODE_STATE=()
TASKDAG_RECON_CUR=""
TASKDAG_RECON_READY=false   # set by prepare; guards use-before-prepare

# One attested semantic snapshot per live consumer operation. Pre-activation
# readers retain the parent-encoded bridge; once any activation exists they
# use graph semantics forever (including disabled rollback epochs).
TASKDAG_CONSUMER_READY=false
TASKDAG_CONSUMER_MODE=""
TASKDAG_CONSUMER_ID=""
TASKDAG_CONSUMER_TIP=""
TASKDAG_CONSUMER_ACTIVATION='null'
TASKDAG_CONSUMER_GRAPH_TIP=""
TASKDAG_CONSUMER_MASTER_TIP=""

_taskdag_consumer_local_activation_authority() {
    local observed=""
    observed=$(git rev-parse --verify -q 'refs/task-dag/activation-observed^{commit}' 2>/dev/null || true)
    [ -n "$observed" ] || observed=$(git rev-parse --verify -q "${TASKDAG_ACTIVATION_REF}^{commit}" 2>/dev/null || true)
    if [ -z "$observed" ]; then
        echo "Error: offline activation absence is unproven; prepare online before using semantic consumers" >&2
        return 2
    fi
    printf '%s\n' "$observed"
}

_taskdag_consumer_activation_token_at() {
    local tip=$1 info active authority path digest record
    info=$(taskdag_activation_validate_history "$tip") || return 2
    IFS=$'\t' read -r active authority path digest <<<"$info"
    record=$(git show "$active:$path") || return 2
    jq -ncS --argjson record "$record" --arg activationCommit "$active" --arg authorityTip "$authority" --arg digest "$digest" \
      '{activationCommit:$activationCommit,authorityTip:$authorityTip,digest:$digest,record:$record}'
}

_taskdag_consumer_remote_advertisement() {
    git ls-remote --refs origin refs/heads/master "$TASKDAG_ACTIVATION_REF" "$TASKDAG_GRAPH_REF" \
      'refs/heads/tasks/frontier/*' 'refs/heads/tasks/active/*' 'refs/heads/tasks/blocked/*' \
      'refs/heads/tasks/blocked-meta/*' 'refs/heads/tasks/root-active/*' 'refs/heads/tasks/pending/*' \
      'refs/heads/gh/issues/*'
}

_taskdag_consumer_advertised_oid() { awk -v r="$2" '$2==r {print $1}' <<<"$1"; }

_taskdag_consumer_task_refs_match() {
    local advertisement=$1 remote local_refs
    remote=$(awk '$2 ~ /^refs\/heads\/(tasks\/(frontier|active|blocked|blocked-meta|root-active|pending)\/|gh\/issues\/)/ {print $1" "$2}' <<<"$advertisement" | sort)
    local_refs=$(git for-each-ref --format='%(objectname) %(refname)' \
      refs/heads/tasks/frontier/ refs/heads/tasks/active/ refs/heads/tasks/blocked/ \
      refs/heads/tasks/blocked-meta/ refs/heads/tasks/root-active/ refs/heads/tasks/pending/ \
      refs/heads/gh/issues/ | sort)
    [ "$remote" = "$local_refs" ]
}

taskdag_consumer_prepare() { # <consumer-id> [--tip TIP] [--no-fetch]
    local consumer=${1:-} requested_tip="" nofetch=false before after token runtime attempt arg advertisement graph_tip master_tip
    local prior_ready=${TASKDAG_CONSUMER_READY:-false} prior_mode=${TASKDAG_CONSUMER_MODE:-}
    [ -n "$consumer" ] || return 2
    shift
    while [ "$#" -gt 0 ]; do
        arg=$1; shift
        case "$arg" in
            --tip) requested_tip=${1:-}; [ -n "$requested_tip" ] || return 2; shift ;;
            --tip=*) requested_tip=${arg#*=} ;;
            --no-fetch) nofetch=true ;;
            *) return 2 ;;
        esac
    done
    TASKDAG_CONSUMER_READY=false
    for attempt in 1 2 3; do
        if [ "$nofetch" = true ] && [ "$prior_ready" = true ] && [ "$prior_mode" = legacy ] \
          && ! git show-ref --verify --quiet refs/task-dag/activation-observed \
          && ! git show-ref --verify --quiet "$TASKDAG_ACTIVATION_REF"; then
            # A nested offline helper may reuse the enclosing operation's
            # freshly observed pre-activation absence. This is process-local
            # evidence only; a standalone offline command still fails closed.
            before=""
        elif [ "$nofetch" = true ]; then before=$(_taskdag_consumer_local_activation_authority) || return 2
        else before=$(_taskdag_activation_fetch_authority) || return 2
        fi
        token=null
        if [ -n "$before" ]; then
            if [ "$nofetch" = true ]; then token=$(_taskdag_consumer_activation_token_at "$before") || return 2
            else token=$(_taskdag_activation_authority_token) || return 2
            fi
            [ "$(jq -r .authorityTip <<<"$token")" = "$before" ] || continue
            runtime=$(_taskdag_activation_runtime_commit) || return 2
            git -C "$TASKDAG_SCRIPT_DIR/.." merge-base --is-ancestor \
                "$(jq -r .record.minimumCompatibleTaskDagCommit <<<"$token")" "$runtime" || return 2
            TASKDAG_CONSUMER_MODE=canonical
        else
            # Cutover is permanent for a checkout once it has observed any
            # valid authority.  A deleted/hidden remote ref after that point
            # is rollback damage or an indeterminate advertisement, never
            # evidence that legacy semantics are safe again.
            if git show-ref --verify --quiet refs/task-dag/activation-observed; then
                echo "Error: semantic activation disappeared after canonical cutover; refusing legacy fallback" >&2
                return 2
            fi
            TASKDAG_CONSUMER_MODE=legacy
        fi
        if [ -n "$requested_tip" ]; then
            if [ "$nofetch" = true ]; then taskdag_recon_prepare --no-fetch --tip "$requested_tip" || return 2
            else taskdag_recon_prepare --tip "$requested_tip" || return 2
            fi
        else
            if [ "$nofetch" = true ]; then taskdag_recon_prepare --no-fetch || return 2
            else taskdag_recon_prepare || return 2
            fi
        fi
        if [ "$nofetch" = true ]; then
            if [ -z "$before" ]; then after=""
            else after=$(_taskdag_consumer_local_activation_authority) || return 2
            fi
            graph_tip=$(git rev-parse --verify -q "${TASKDAG_GRAPH_REF}^{commit}" 2>/dev/null || true)
            master_tip=$(taskdag_resolve_facts_tip) || return 2
        else
            advertisement=$(_taskdag_consumer_remote_advertisement) || return 2
            after=$(_taskdag_consumer_advertised_oid "$advertisement" "$TASKDAG_ACTIVATION_REF")
            graph_tip=$(_taskdag_consumer_advertised_oid "$advertisement" "$TASKDAG_GRAPH_REF")
            master_tip=$(_taskdag_consumer_advertised_oid "$advertisement" refs/heads/master)
            [ "$graph_tip" = "$(git rev-parse --verify -q "${TASKDAG_GRAPH_REF}^{commit}" 2>/dev/null || true)" ] || continue
            _taskdag_consumer_task_refs_match "$advertisement" || continue
            [ -n "$requested_tip" ] || [ "$master_tip" = "$TASKDAG_RECON_FACTS_TIP" ] || continue
        fi
        [ "$before" = "$after" ] || continue
        if [ -n "$requested_tip" ]; then
            requested_tip=$(git rev-parse --verify -q "${requested_tip}^{commit}") || return 2
            [ "$TASKDAG_FACTS_TIP_OID" = "$requested_tip" ] || return 2
        fi
        TASKDAG_CONSUMER_ID=$consumer
        TASKDAG_CONSUMER_TIP=$TASKDAG_FACTS_TIP_OID
        TASKDAG_CONSUMER_ACTIVATION=$token
        TASKDAG_CONSUMER_GRAPH_TIP=$graph_tip
        TASKDAG_CONSUMER_MASTER_TIP=$master_tip
        TASKDAG_CONSUMER_READY=true
        return 0
    done
    echo "Error: semantic activation changed repeatedly during consumer preparation" >&2
    return 2
}

taskdag_consumer_require_prepared() {
    [ "$TASKDAG_CONSUMER_READY" = true ] || {
        echo "Error: semantic consumer used without an attested snapshot" >&2
        return 2
    }
}

# Canonical parent-encoded dependency verdict used by legacy-shaped task
# commits while graph migration is drained. Callers consume this JSON instead
# of reconstructing readiness. The authority tip is mandatory.
_taskdag_legacy_parent_dependency_status_json() {
    local tip="$1" task="$2" dep complete=true reasons='[]' deps='[]' done
    git rev-parse --verify -q "${tip}^{commit}" >/dev/null 2>&1 || return 2
    while IFS= read -r dep; do
        [ -n "$dep" ] || continue
        done=false
        if taskdag_task_completed_at_tip "$tip" "$dep"; then done=true; else complete=false; fi
        deps=$(jq -c --arg sha "$dep" --argjson completed "$done" '. + [{sha:$sha,completed:$completed}]' <<<"$deps") || return 2
        if [ "$done" = false ]; then
            reasons=$(jq -c --arg sha "$dep" '. + [{code:"incomplete-requirement",task:$sha}]' <<<"$reasons") || return 2
        fi
    done < <(get_dep_parents "$task")
    jq -nc --arg task "$task" --arg tip "$(git rev-parse "${tip}^{commit}")" \
        --argjson ready "$complete" --argjson reasons "$reasons" --argjson dependencies "$deps" \
        '{schema:1,task:$task,authorityTip:$tip,dependencies:$dependencies,ready:$ready,reasons:$reasons}'
}

taskdag_requirements_status_json() {
    local node=$1 task="" dep complete=true reasons='[]' deps='[]' rc normalized
    taskdag_consumer_require_prepared || return 2
    normalized=$(taskdag_normalize_node "$node") || return 2
    if [ "$TASKDAG_CONSUMER_MODE" = legacy ]; then
        case "$normalized" in
            task:${TASKDAG_RECON_CUR}@*) task=${normalized##*@} ;;
            *) jq -ncS '{requirements:[],requirementsSatisfied:true,reasons:[]}'; return 0 ;;
        esac
        _taskdag_legacy_parent_dependency_status_json "$TASKDAG_CONSUMER_TIP" "$task" \
          | jq -cS '{requirements:(.dependencies|map({node:("task:'"$TASKDAG_RECON_CUR"'@"+.sha),complete:.completed})),requirementsSatisfied:.ready,reasons}'
        return ${PIPESTATUS[0]}
    fi
    while IFS= read -r dep; do
        [ -n "$dep" ] || continue
        rc=0; taskdag_node_complete "$dep" || rc=$?
        [ "$rc" -eq 2 ] && return 2
        if [ "$rc" -eq 0 ]; then
            deps=$(jq -c --arg node "$dep" '.+[{node:$node,complete:true}]' <<<"$deps") || return 2
        else
            complete=false
            deps=$(jq -c --arg node "$dep" '.+[{node:$node,complete:false}]' <<<"$deps") || return 2
            reasons=$(jq -c --arg node "$dep" '.+[{code:"incomplete-requirement",node:$node}]' <<<"$reasons") || return 2
        fi
    done < <(jq -r --arg n "$normalized" '.[]|select(.from==$n and .relation=="requires")|.to' <<<"$TASKDAG_RECON_EDGES_JSON")
    jq -ncS --argjson requirements "$deps" --argjson requirementsSatisfied "$complete" --argjson reasons "$reasons" \
        '{requirements:$requirements,requirementsSatisfied:$requirementsSatisfied,reasons:$reasons}'
}

taskdag_task_status_json() { # <task-node> [--include-claimed]
    local node=$1 include_claimed=false normalized sha short complete=false blocked=false claimed=false ancestor="" ready=false reasons='[]' req rc
    [ "${2:-}" = --include-claimed ] && include_claimed=true
    taskdag_consumer_require_prepared || return 2
    normalized=$(taskdag_normalize_node "$node") || return 2
    if [ "$TASKDAG_CONSUMER_MODE" = legacy ]; then
        case "$normalized" in task:${TASKDAG_RECON_CUR}@*) sha=${normalized##*@} ;; *) return 2 ;; esac
        taskdag_task_completed_at_tip "$TASKDAG_CONSUMER_TIP" "$sha" && complete=true
    else
        sha=$(taskdag_recon_resolve_task_node "$normalized") || return 2
        rc=0; taskdag_node_complete "$normalized" || rc=$?; [ "$rc" -eq 2 ] && return 2; [ "$rc" -eq 0 ] && complete=true
    fi
    req=$(taskdag_requirements_status_json "$normalized") || return 2
    is_task_blocked "$sha" && blocked=true
    ancestor=$(blocked_structural_ancestor "$sha" 2>/dev/null || true)
    short=$(git rev-parse --short "$sha") || return 2
    git show-ref --verify --quiet "refs/heads/tasks/active/$short" && claimed=true
    reasons=$(jq -c '.reasons' <<<"$req") || return 2
    [ "$complete" = true ] && reasons=$(jq -c '.+[{code:"complete"}]' <<<"$reasons")
    [ "$blocked" = true ] && reasons=$(jq -c '.+[{code:"blocked"}]' <<<"$reasons")
    if [ -n "$ancestor" ] && ! is_human_comment_task "$sha"; then reasons=$(jq -c --arg task "$ancestor" '.+[{code:"ancestor-blocked",task:$task}]' <<<"$reasons"); fi
    [ "$claimed" = true ] && [ "$include_claimed" = false ] && reasons=$(jq -c '.+[{code:"claimed"}]' <<<"$reasons")
    if [ "$complete" = false ] && [ "$(jq -r .requirementsSatisfied <<<"$req")" = true ] && [ "$blocked" = false ] \
      && { [ -z "$ancestor" ] || is_human_comment_task "$sha"; } \
      && { [ "$claimed" = false ] || [ "$include_claimed" = true ]; }; then ready=true; fi
    jq -ncS --arg node "$normalized" --arg task "$sha" --arg mode "$TASKDAG_CONSUMER_MODE" --arg tip "$TASKDAG_CONSUMER_TIP" \
      --argjson activation "$TASKDAG_CONSUMER_ACTIVATION" --argjson complete "$complete" --argjson blocked "$blocked" \
      --arg blockedAncestor "$ancestor" --argjson claimed "$claimed" --argjson ready "$ready" --argjson requirements "$(jq -c .requirements <<<"$req")" \
      --argjson requirementsSatisfied "$(jq -c .requirementsSatisfied <<<"$req")" --argjson reasons "$reasons" \
      '{schema:1,node:$node,task:$task,complete:$complete,requirements:$requirements,requirementsSatisfied:$requirementsSatisfied,blocked:$blocked,blockedAncestor:(if $blockedAncestor=="" then null else $blockedAncestor end),claimed:$claimed,ready:$ready,reasons:$reasons,attestation:{mode:$mode,factsTip:$tip,activation:$activation}}'
}

taskdag_root_status_json() { # <root-node> <issue>
    local node=$1 issue=$2 normalized sha complete=false blocked=false claimed=false decomposed=false pickable=false req rc reasons='[]'
    taskdag_consumer_require_prepared || return 2
    normalized=$(taskdag_normalize_node "$node") || return 2
    if [ "$TASKDAG_CONSUMER_MODE" = legacy ]; then
        case "$normalized" in task:${TASKDAG_RECON_CUR}@*) sha=${normalized##*@} ;; *) return 2 ;; esac
        taskdag_task_completed_at_tip "$TASKDAG_CONSUMER_TIP" "$sha" && complete=true
    else
        sha=$(taskdag_recon_resolve_task_node "$normalized") || return 2
        rc=0; taskdag_node_complete "$normalized" || rc=$?; [ "$rc" -eq 2 ] && return 2; [ "$rc" -eq 0 ] && complete=true
    fi
    req=$(taskdag_requirements_status_json "$normalized") || return 2
    task_has_children "$sha" >/dev/null 2>&1 && decomposed=true
    is_task_blocked "$sha" && blocked=true
    git show-ref --verify --quiet "refs/heads/tasks/root-active/$issue" && claimed=true
    reasons=$(jq -c '.reasons' <<<"$req")
    [ "$complete" = true ] && reasons=$(jq -c '.+[{code:"complete"}]' <<<"$reasons")
    [ "$decomposed" = true ] && reasons=$(jq -c '.+[{code:"decomposed"}]' <<<"$reasons")
    [ "$claimed" = true ] && reasons=$(jq -c '.+[{code:"claimed"}]' <<<"$reasons")
    [ "$blocked" = true ] && reasons=$(jq -c '.+[{code:"blocked"}]' <<<"$reasons")
    if [ "$complete" = false ] && [ "$decomposed" = false ] && [ "$claimed" = false ] && [ "$blocked" = false ] \
      && [ "$(jq -r .requirementsSatisfied <<<"$req")" = true ]; then pickable=true; fi
    jq -ncS --arg node "$normalized" --arg task "$sha" --arg mode "$TASKDAG_CONSUMER_MODE" --arg tip "$TASKDAG_CONSUMER_TIP" \
      --argjson activation "$TASKDAG_CONSUMER_ACTIVATION" --argjson complete "$complete" --argjson decomposed "$decomposed" \
      --argjson claimed "$claimed" --argjson blocked "$blocked" --argjson requirements "$(jq -c .requirements <<<"$req")" \
      --argjson requirementsSatisfied "$(jq -c .requirementsSatisfied <<<"$req")" --argjson pickable "$pickable" --argjson reasons "$reasons" \
      '{schema:1,node:$node,task:$task,complete:$complete,decomposed:$decomposed,claimed:$claimed,blocked:$blocked,requirements:$requirements,requirementsSatisfied:$requirementsSatisfied,pickable:$pickable,reasons:$reasons,attestation:{mode:$mode,factsTip:$tip,activation:$activation}}'
}

# taskdag_recon_build_child_map: build the containment (first-parent) child
# map ONCE from ALL reachable task commits, in a SINGLE `git log` call (no
# per-commit subprocess). A commit is a containment child of its FIRST
# parent iff it is an empty-tree task commit and is not a Claim:/
# Blocked-Meta: side commit (mirrors list_dag_children's filtering, but the
# containment edge is strictly the FIRST parent — the breakdown/structural
# parent — never a dependency parent). The result is a strict forest, so the
# complete() recursion over it is inherently acyclic and terminating.
taskdag_recon_build_child_map() {
    TASKDAG_RECON_FP_CHILDREN=()
    local us=$'\x1f' commit tree subject parents first
    while IFS="$us" read -r commit tree subject parents; do
        [ -n "$commit" ] || continue
        [ "$tree" = "$EMPTY_TREE" ] || continue           # task commits only
        case "$subject" in
            Claim:*|Blocked-Meta:*|kind:\ delegated*|kind:\ completion*) continue ;;
        esac
        first="${parents%% *}"                            # first parent only
        [ -n "$first" ] || continue                       # a rootless commit
        TASKDAG_RECON_FP_CHILDREN["$first"]+="$commit"$'\n'
    done < <(git log --all --format="%H${us}%T${us}%s${us}%P" 2>/dev/null)
}

# taskdag_recon_prepare [--no-fetch]: load the per-invocation state. Online
# (default) syncs BOTH origin/master (the fact tip) and the graph index
# before deriving, so a not-complete/not-ready verdict means the fact is
# absent, never "couldn't reach origin"; --no-fetch reads BOTH from local
# refs only (offline). Fails (rc 2) if the edge/fact view or the current
# repo cannot be resolved — a predicate must never run on a silently-empty
# input. The containment map is read from LOCAL task refs (like `frontier`);
# a caller wanting an online containment view fetches task refs first.
taskdag_recon_prepare() {
    local nofetch=false tip="" arg
    while [ "$#" -gt 0 ]; do
        arg=$1; shift
        case "$arg" in
            --no-fetch) nofetch=true ;;
            --tip) tip=${1:-}; [ -n "$tip" ] || return 2; shift ;;
            --tip=*) tip=${arg#*=} ;;
            *) echo "Error: unknown reconcile option: $arg" >&2; return 2 ;;
        esac
    done
    command -v jq >/dev/null 2>&1 || { echo "Error: jq is required to reconcile the dependency graph" >&2; return 2; }

    # Reset per-invocation state UP FRONT so a failed (re-)prepare can never
    # leave a stale/partial view marked ready for a caller that ignores rc.
    TASKDAG_RECON_READY=false
    TASKDAG_RECON_EDGES_JSON=""
    TASKDAG_RECON_FACTS_TIP=""
    TASKDAG_RECON_CUR=""
    TASKDAG_RECON_FP_CHILDREN=()
    TASKDAG_RECON_NODE_STATE=()

    if [ "$nofetch" = false ]; then
        taskdag_sync_master || { echo "Error: could not sync origin/master (indeterminate); refusing to reconcile against a possibly-stale view (use --no-fetch for local refs)" >&2; return 2; }
        # Sync the task-ref namespace so containment (the child map) AND the
        # claim/block gates reflect ORIGIN, not a partial local checkout. FAIL
        # CLOSED: a decomposed epic judged against a partial local DAG (only
        # the completed child visible) would FALSE-COMPLETE — the exact hazard
        # the legacy auto-close path guards against. (An unset helper resolves
        # to 127 here, also caught by `|| { … }`, so this is fail-closed even
        # when the module is sourced standalone.)
        fetch_task_refs_strict >/dev/null 2>&1 || { echo "Error: could not sync task refs from origin (indeterminate); refusing to reconcile against a partial local DAG (use --no-fetch for the local view)" >&2; return 2; }
    fi

    local args=() facts_args=()
    [ "$nofetch" = true ] && args+=(--no-fetch)
    facts_args=("${args[@]}")
    [ -n "$tip" ] && facts_args+=(--tip "$tip")
    TASKDAG_RECON_EDGES_JSON=$(taskdag_edges_with_facts "${facts_args[@]}") || return 2
    TASKDAG_RECON_FACTS_TIP=$(taskdag_resolve_facts_tip "$tip") || return 2
    TASKDAG_FACTS_TIP_OID=$TASKDAG_RECON_FACTS_TIP

    TASKDAG_RECON_CUR=$(taskdag_current_repo) || { echo "Error: cannot resolve current repo to reconcile the graph" >&2; return 2; }
    taskdag_recon_build_child_map
    TASKDAG_RECON_READY=true
    return 0
}

# taskdag_recon_resolve_task_node <normalized-node>: TRI-STATE resolver for a
# node's LOCAL containment identity, so an unverifiable current-repo task node
# fails CLOSED instead of being silently treated as a childless leaf.
#   rc 0 + <sha> -> a current-repo task node present locally as an empty-tree
#                   task commit (has containment children / claim / block refs)
#   rc 1         -> NOT a current-repo task node (an issue node or a foreign-
#                   repo node): no local containment; the caller uses the fact
#                   layer (done()) / cross-repo siblings
#   rc 2         -> a current-repo TASK node that is MISSING locally or is not
#                   an empty-tree task commit — an indeterminate / corrupt
#                   local view; the caller must fail closed (never guess ready)
taskdag_recon_resolve_task_node() {
    local node="$1" rest or ref
    case "$node" in task:*) ;; *) return 1 ;; esac      # issue node ⇒ not a task node
    rest="${node#task:}"; or="${rest%@*}"; ref="${rest##*@}"
    [ "$or" = "$TASKDAG_RECON_CUR" ] || return 1         # foreign-repo task node
    git rev-parse -q --verify "${ref}^{commit}" >/dev/null 2>&1 || return 2
    is_task_commit "$ref" || return 2
    printf '%s\n' "$ref"
}

# taskdag_recon_has_satisfying_edge <normalized-node>: rc 0 iff ANY outgoing
# satisfies target is semantically complete (the supersede short-circuit).
taskdag_recon_has_satisfying_edge() {
    local target rc
    while IFS= read -r target; do
        [ -n "$target" ] || continue
        rc=0; taskdag_node_complete "$target" || rc=$?
        [ "$rc" -eq 0 ] && return 0
        [ "$rc" -eq 2 ] && return 2
    done < <(printf '%s' "$TASKDAG_RECON_EDGES_JSON" | jq -r --arg n "$1" \
        '.[] | select(.from == $n and .relation == "satisfies") | .to')
    return 1
}

# taskdag_recon_requires_satisfied <normalized-node>: rc 0 iff EVERY outgoing
# requires target is semantically complete. Vacuously true when the node has
# no requires-edges — requires = ALL.
taskdag_recon_requires_satisfied() {
    local target rc
    while IFS= read -r target; do
        [ -n "$target" ] || continue
        rc=0; taskdag_node_complete "$target" || rc=$?
        [ "$rc" -eq 2 ] && return 2
        [ "$rc" -eq 0 ] || return 1
    done < <(printf '%s' "$TASKDAG_RECON_EDGES_JSON" | jq -r --arg n "$1" \
        '.[] | select(.from == $n and .relation == "requires") | .to')
    return 0
}

# taskdag_recon_has_requires <normalized-node>: rc 0 iff the node has at
# least one outgoing requires-edge. Used to keep childless Type: epic roots
# from vacuously completing while still allowing a requires-only delegated
# epic to close once its edge is satisfied.
taskdag_recon_has_requires() {
    printf '%s' "$TASKDAG_RECON_EDGES_JSON" | jq -e --arg n "$1" \
        'any(.[]; .from == $n and .relation == "requires")' \
        >/dev/null 2>&1
}

# taskdag_recon_task_type <sha>: print the lowercase Type: field from a task
# commit, if present. Missing Type is a normal legacy/task case.
taskdag_recon_task_type() {
    git log -1 --format='%B' "$1" 2>/dev/null \
        | awk -F':[[:space:]]*' 'tolower($1) == "type" { print tolower($2); exit }'
}

# Internal implementation. The public wrapper below memoizes verdicts and
# rejects graph cycles, so every recursive requires/satisfies lookup shares
# one least-fixed-point evaluation.
taskdag__node_complete_impl() {
    local node
    node=$(taskdag_normalize_node "$1") || { echo "Error: invalid node: $1" >&2; return 2; }

    # (1) classify by CONTAINMENT and explicit epic type. A node with
    #     first-parent children is an EPIC; a childless Type: epic task with
    #     outgoing requires-edges is also an EPIC whose obligations are those
    #     edges. A childless Type: epic task with no requires-edges has EMPTY
    #     obligations and is not complete. Ordinary childless tasks remain
    #     LEAF nodes: their requires-edges gate readiness, not completeness.
    #
    #     This MUST come before trusting the raw done() fact: the fact layer
    #     derives done() from ANY parent-field token reachable from master,
    #     and an epic root is its children's FIRST-parent token, so a
    #     decomposed epic FALSE-POSITIVES as done() the moment any child is
    #     completed. Completeness of an epic is therefore derived from its
    #     obligations, exactly like the legacy epic_subtree_complete — never
    #     from done(). done() stays authoritative only for a leaf (which
    #     appears solely as the 2nd parent of its own completion merge) and
    #     for an issue (Closes-Epic).
    local sha children="" resolve_rc=0 task_type="" has_requires=false is_epic=false
    sha=$(taskdag_recon_resolve_task_node "$node") || resolve_rc=$?
    if [ "$resolve_rc" -eq 2 ]; then
        echo "Error: current-repo task node not resolvable locally (missing or not an empty-tree task commit): $node — fetch task refs or check the local view" >&2
        return 2
    fi
    if [ "$resolve_rc" -eq 0 ]; then
        children="${TASKDAG_RECON_FP_CHILDREN[$sha]:-}"
        task_type="$(taskdag_recon_task_type "$sha")"
        taskdag_recon_has_requires "$node" && has_requires=true || has_requires=false
        if [ -n "$children" ] || [ "$task_type" = epic ]; then
            is_epic=true
        fi
    fi

    if [ "$is_epic" = false ]; then
        # A direct leaf/issue fact seeds the fixed point. Check it before
        # following satisfies edges so a valid seed can terminate an
        # otherwise cyclic supersedence graph.
        local rc=0
        taskdag_node_done "$node" "$TASKDAG_RECON_FACTS_TIP" || rc=$?
        [ "$rc" -eq 2 ] && return 2
        [ "$rc" -eq 0 ] && return 0
    fi

    # (2) supersede — any semantically complete satisfies target fulfils this
    # node. A target's mere reachability or routing hint never does.
    local satisfies_rc=0
    taskdag_recon_has_satisfying_edge "$node" || satisfies_rc=$?
    [ "$satisfies_rc" -eq 0 ] && return 0
    [ "$satisfies_rc" -eq 2 ] && return 2

    [ "$is_epic" = true ] || return 1

    # A childless epic with no requires obligations stays incomplete unless
    # the satisfies short-circuit above completed it.
    [ -n "$children" ] || [ "$has_requires" = true ] || return 1

    # (3) EPIC — obligations = its containment children ∪ its outgoing
    # requires-edges. Complete iff obligations are non-empty, every
    # requires-edge is satisfied (mode = all), and every child subtree is
    # complete. The empty-obligations Type: epic case returned incomplete
    # above, so a root can never vacuously close.
    taskdag_recon_requires_satisfied "$node" || return 1
    local child rc
    while IFS= read -r child; do
        [ -n "$child" ] || continue
        rc=0; taskdag_node_complete "task:${TASKDAG_RECON_CUR}@${child}" || rc=$?
        [ "$rc" -eq 2 ] && return 2
        [ "$rc" -eq 0 ] || return 1
    done <<< "$children"
    return 0
}

# taskdag_node_complete <node>: canonical complete() predicate.
#   rc 0 -> complete   rc 1 -> not complete   rc 2 -> corrupt/indeterminate
taskdag_node_complete() {
    [ "$TASKDAG_RECON_READY" = true ] || { echo "Error: taskdag_node_complete called before taskdag_recon_prepare" >&2; return 2; }
    local node state rc=0
    node=$(taskdag_normalize_node "$1") || { echo "Error: invalid node: $1" >&2; return 2; }
    state="${TASKDAG_RECON_NODE_STATE[$node]:-}"
    case "$state" in
        complete) return 0 ;;
        incomplete) return 1 ;;
        visiting)
            echo "Error: dependency graph cycle encountered while resolving $node" >&2
            return 2
            ;;
    esac
    TASKDAG_RECON_NODE_STATE["$node"]=visiting
    taskdag__node_complete_impl "$node" || rc=$?
    case "$rc" in
        0) TASKDAG_RECON_NODE_STATE["$node"]=complete ;;
        1) TASKDAG_RECON_NODE_STATE["$node"]=incomplete ;;
        *) unset 'TASKDAG_RECON_NODE_STATE[$node]' ;;
    esac
    return "$rc"
}

# taskdag_leaf_ready <node>: the north-star leaf-readiness predicate —
#   NOT complete  AND  every requires-edge satisfied  AND (for a current-repo
#   task node) unclaimed AND unblocked (structural block included).
#   rc 0 -> ready   rc 1 -> not ready   rc 2 -> error
# Claim/block are read from LOCAL refs (like `frontier`); the caller fetches
# task refs first for an online-accurate view.
taskdag_leaf_ready() {
    [ "$TASKDAG_RECON_READY" = true ] || { echo "Error: taskdag_leaf_ready called before taskdag_recon_prepare" >&2; return 2; }
    local node
    node=$(taskdag_normalize_node "$1") || { echo "Error: invalid node: $1" >&2; return 2; }

    # complete ⇒ not a pickable leaf.
    local rc=0
    taskdag_node_complete "$node" || rc=$?
    [ "$rc" -eq 2 ] && return 2
    [ "$rc" -eq 0 ] && return 1

    # every requires-edge satisfied.
    taskdag_recon_requires_satisfied "$node" || return 1

    # claim/block gate for a current-repo task node (bare-sha overlay refs).
    # An unresolvable current-repo task node is indeterminate ⇒ fail closed
    # (rc 2), never guessed "ready". (complete() above already returns 2 for
    # that case, so this is belt-and-suspenders.)
    local sha short resolve_rc=0
    sha=$(taskdag_recon_resolve_task_node "$node") || resolve_rc=$?
    [ "$resolve_rc" -eq 2 ] && return 2
    if [ "$resolve_rc" -eq 0 ]; then
        [ "$(taskdag_recon_task_type "$sha")" = epic ] && return 1
        is_task_blocked "$sha" && return 1
        blocked_structural_ancestor "$sha" >/dev/null 2>&1 && return 1
        short=$(git rev-parse --short "$sha" 2>/dev/null || true)
        [ -n "$short" ] && git show-ref --verify --quiet "refs/heads/tasks/active/$short" && return 1
    fi
    return 0
}

# Command: reconcile — READ-ONLY evaluation of the complete()/leaf-readiness
# predicates over the edge graph (issue #13 north-star). Never writes a ref.
cmd_reconcile() {
    local json=false do_fetch=true node="" want_ready=false
    while [ $# -gt 0 ]; do
        case "$1" in
            --json) json=true; shift ;;
            --no-fetch) do_fetch=false; shift ;;
            --ready) want_ready=true; shift ;;
            --node) node="${2:-}"; shift 2 ;;
            --node=*) node="${1#*=}"; shift ;;
            --help|-h)
                cat <<'EOF'
Usage: task-dag reconcile [--json] [--no-fetch] [--node <node>] [--ready]

READ (only) the AGGREGATED complete()/leaf-readiness verdicts of the
dependency graph (issue #13 north-star), computed from master's completion
history and the active edge set. This is the layer above the raw `facts`:

  complete(node)  ⟺ done(node), OR an outgoing satisfies-edge is satisfied,
                    OR (node has obligations — containment children and/or
                    outgoing requires-edges) AND every child subtree is
                    complete AND every requires-edge is satisfied.
  ready(node)     ⟺ NOT complete AND every requires-edge satisfied AND (for a
                    current-repo task node) unclaimed AND unblocked.

It NEVER writes a ref and does not drive live frontier/complete/epic-close
behavior (those are later-phase sibling tasks); it only reports the verdicts.

Default (online): syncs BOTH origin/master and the graph index before
deriving; --no-fetch reads BOTH from local refs only (offline). Containment
children and claim/block are read from LOCAL task refs (like `frontier`).

  --node <node>   evaluate ONE node. Prints "<node>\tcomplete|incomplete"
                  and EXITS 0 if complete / 1 if not / 2 on error; with
                  --ready prints "<node>\tready|not-ready" and the exit code
                  reflects readiness instead.
  --ready         with --node, make the exit status reflect readiness; in the
                  table, this is informational (both columns always shown).
  --json          emit JSON ({node,complete,ready} with --node, else an array
                  of such objects over every distinct edge-source node).
  --no-fetch      local refs only (offline).

Requires jq.
EOF
                return 0
                ;;
            *) echo "Error: unknown option: $1" >&2; return 2 ;;
        esac
    done

    local prep=()
    [ "$do_fetch" = false ] && prep+=(--no-fetch)
    taskdag_recon_prepare "${prep[@]}" || return 2

    # Single-node query.
    if [ -n "$node" ]; then
        local nn crc=0 rrc=0 cbool rbool
        nn=$(taskdag_normalize_node "$node") || { echo "Error: invalid node: $node" >&2; return 2; }
        taskdag_node_complete "$nn" || crc=$?
        [ "$crc" -eq 2 ] && return 2
        taskdag_leaf_ready "$nn" || rrc=$?
        [ "$rrc" -eq 2 ] && return 2
        [ "$crc" -eq 0 ] && cbool=true || cbool=false
        [ "$rrc" -eq 0 ] && rbool=true || rbool=false

        if [ "$json" = true ]; then
            jq -nc --arg node "$nn" --argjson complete "$cbool" --argjson ready "$rbool" \
                '{node:$node, complete:$complete, ready:$ready}'
        elif [ "$want_ready" = true ]; then
            printf '%s\t%s\n' "$nn" "$([ "$rrc" -eq 0 ] && echo ready || echo not-ready)"
        else
            printf '%s\t%s\n' "$nn" "$([ "$crc" -eq 0 ] && echo complete || echo incomplete)"
        fi
        if [ "$want_ready" = true ]; then return "$rrc"; else return "$crc"; fi
    fi

    # Table / array over every distinct edge-source node.
    local nodes
    nodes=$(printf '%s' "$TASKDAG_RECON_EDGES_JSON" | jq -r '[.[].from] | unique[]')

    if [ "$json" = true ]; then
        local out='[]' n crc rrc cbool rbool
        while IFS= read -r n; do
            [ -n "$n" ] || continue
            crc=0; taskdag_node_complete "$n" || crc=$?
            [ "$crc" -eq 2 ] && return 2
            rrc=0; taskdag_leaf_ready "$n" || rrc=$?
            [ "$rrc" -eq 2 ] && return 2
            [ "$crc" -eq 0 ] && cbool=true || cbool=false
            [ "$rrc" -eq 0 ] && rbool=true || rbool=false
            out=$(printf '%s' "$out" | jq -c --arg node "$n" --argjson complete "$cbool" --argjson ready "$rbool" \
                '. + [{node:$node, complete:$complete, ready:$ready}]')
        done <<< "$nodes"
        printf '%s\n' "$out"
        return 0
    fi

    if [ -z "$nodes" ]; then
        printf "${BOLD}No edge-source nodes to reconcile${RESET} (%s)\n" "$TASKDAG_GRAPH_REF"
        return 0
    fi
    printf "${BOLD}%-9s %-9s %-42s${RESET}\n" "COMPLETE" "READY" "NODE"
    local n crc rrc
    while IFS= read -r n; do
        [ -n "$n" ] || continue
        crc=0; taskdag_node_complete "$n" || crc=$?
        [ "$crc" -eq 2 ] && return 2
        rrc=0; taskdag_leaf_ready "$n" || rrc=$?
        [ "$rrc" -eq 2 ] && return 2
        printf "%-9s %-9s %-42s\n" \
            "$([ "$crc" -eq 0 ] && echo yes || echo no)" \
            "$([ "$rrc" -eq 0 ] && echo yes || echo no)" \
            "$n"
    done <<< "$nodes"
    return 0
}
