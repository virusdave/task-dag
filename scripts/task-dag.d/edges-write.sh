# shellcheck shell=bash
# ═══════════════════════════════════════════════════════════════════════
# task-dag dependency-edge direct-CAS WRITER (issue #13 north-star, Phase 2)
#
# This module carries the authoritative WRITE side of the uniform dependency
# graph. Adding or removing an edge is a direct fast-forward push to this
# repo's index branch refs/heads/tasks/v1/graph (TASKDAG_GRAPH_REF) — the
# SAME ref-update CAS a completion merge to `master` uses. It succeeds or
# fails at push time; there is NO accepted-but-not-committed tier.
#
#   Loop = the one agents already run for master:
#     fetch tip -> recompute the new tree (a commutative, idempotent union of
#     content-addressed edge blobs) -> push with the old-tip expectation ->
#     on rejection refetch / recompute / re-push.
#   Because the active edge set is a commutative idempotent union, a rebased
#   recompute is a trivial FF, never a semantic conflict — same-path
#   non-identical content is impossible to mint here (the path IS the
#   semantic id) and is caught loud by the reader if it ever appears.
#
#   Retry backoff (operator-locked decision 5 on issue #13): on a rejected
#   push, wait a bounded, slowly-growing interval with a small random jitter
#   ADDED EACH ATTEMPT. The base starts small (~1s + jitter) and grows
#   NON-exponentially (a quadratic ramp) toward a ~10s cap — it does NOT
#   start at 10s. If retries exhaust the attempt budget, FAIL LOUD rather
#   than spin.
#
# Satisfied-edge PRUNING + explicit TOMBSTONES (issue #13 sibling) now live
# alongside the writer: `dep drop` is satisfaction-AWARE — it PRUNES a
# satisfied edge (plain FF deletion; master's completion is the durable
# witness) but writes an explicit TOMBSTONE (tombstones/<edge-id>.json,
# atomically with the edge removal) for a deliberate removal BEFORE
# satisfaction, so a lost edge is distinguishable from an intentionally-
# dropped one. The tombstone blob serializer + reader masking live in
# edges.sh; the satisfied-edge scan/`dep prune` primitives live in
# edges-prune.sh. The cross-repo mailbox, the reconciler, `supersede`, and
# the `graph --explain` resolver are separate sibling tasks and are NOT
# implemented here.
#
# Relies on the data-model + reader helpers in edges.sh (taskdag_edge_id,
# taskdag_edge_blob, taskdag_normalize_node, taskdag_repo_numeric_id,
# taskdag_sync_graph_ref) and on TASKDAG_GRAPH_REF / json_escape / colors
# from the main script.
# ═══════════════════════════════════════════════════════════════════════

# ── Bounded CAS-retry backoff parameters (env-overridable for tests) ──────
# base starts small (~1s), the ramp is quadratic (base*attempt^2) capped at
# ~10s, and fresh jitter is added on top of each computed delay. MAX_ATTEMPTS
# bounds the retry budget so an exhausted contention window FAILS LOUD.
: "${TASKDAG_CAS_BASE_MS:=1000}"
: "${TASKDAG_CAS_CAP_MS:=10000}"
: "${TASKDAG_CAS_JITTER_MS:=250}"
: "${TASKDAG_CAS_MAX_ATTEMPTS:=8}"

# taskdag_cas_ramp_ms <attempt>: the DETERMINISTIC (jitter-free) component of
# the backoff for a 1-based retry attempt. A quadratic ramp base*attempt^2,
# capped at the ~10s cap. Pure + side-effect-free so the ramp shape and cap
# are unit-testable. Attempt 1 => base (never the cap).
taskdag_cas_ramp_ms() {
    local attempt="$1" ramp
    [[ "$attempt" =~ ^[1-9][0-9]*$ ]] || { echo "Error: taskdag_cas_ramp_ms needs a positive attempt" >&2; return 1; }
    ramp=$(( TASKDAG_CAS_BASE_MS * attempt * attempt ))
    [ "$ramp" -gt "$TASKDAG_CAS_CAP_MS" ] && ramp="$TASKDAG_CAS_CAP_MS"
    printf '%s\n' "$ramp"
}

# taskdag_cas_jitter_ms: a fresh, uniform random jitter in [0, JITTER_MS].
# Drawn from $RANDOM each call, so successive calls (de-syncing racing
# writers) differ. Bounded above by JITTER_MS.
taskdag_cas_jitter_ms() {
    if [ "$TASKDAG_CAS_JITTER_MS" -le 0 ]; then printf '0\n'; return 0; fi
    printf '%s\n' "$(( RANDOM % (TASKDAG_CAS_JITTER_MS + 1) ))"
}

# taskdag_cas_backoff_ms <attempt>: the full per-attempt delay in ms =
# (quadratic ramp, capped) + (fresh random jitter). Never starts at the cap.
taskdag_cas_backoff_ms() {
    local ramp jitter
    ramp=$(taskdag_cas_ramp_ms "$1") || return 1
    jitter=$(taskdag_cas_jitter_ms) || return 1
    printf '%s\n' "$(( ramp + jitter ))"
}

# taskdag_cas_sleep <attempt>: sleep the computed backoff for this attempt.
# Kept separate from the pure computation so tests never actually sleep.
taskdag_cas_sleep() {
    local ms secs
    ms=$(taskdag_cas_backoff_ms "$1") || return 1
    secs=$(awk -v ms="$ms" 'BEGIN{printf "%.3f", ms/1000}')
    sleep "$secs"
}

# _taskdag_edge_blob_check <blob>: validate a STORED edge blob exactly as the
# reader (taskdag_read_edges) does — typed schema:1 structure, the fixed
# relation/mode pair, and canonical node addresses at rest — and print its
# recomputed SEMANTIC edge-id. Returns non-zero (no output) on any
# malformation. The writer uses this so an "already present" no-op `add` can
# never silently succeed over a CORRUPT existing edge blob.
_taskdag_edge_blob_check() {
    local blob="$1" jfrom jto jrel jmode cfrom cto
    printf '%s' "$blob" | jq -e '
          (type == "object")
          and (.schema == 1) and ((.schema | type) == "number")
          and ((.from | type) == "string") and ((.to | type) == "string")
          and ((.relation | type) == "string") and ((.mode | type) == "string")
          and ((.origin | type) == "object")
          and ((.origin["repo-id"] | type) == "number")
          and (.origin["repo-id"] > 0)
          and (.origin["repo-id"] == (.origin["repo-id"] | floor))
          and ((.origin.witness | type) == "string") and ((.origin.witness | length) > 0)
        ' >/dev/null 2>&1 || return 1
    jfrom=$(printf '%s' "$blob" | jq -r '.from')
    jto=$(printf '%s' "$blob" | jq -r '.to')
    jrel=$(printf '%s' "$blob" | jq -r '.relation')
    jmode=$(printf '%s' "$blob" | jq -r '.mode')
    taskdag_relation_mode_ok "$jrel" "$jmode" || return 1
    cfrom=$(taskdag_normalize_node "$jfrom") || return 1
    cto=$(taskdag_normalize_node "$jto") || return 1
    [ "$jfrom" = "$cfrom" ] && [ "$jto" = "$cto" ] || return 1
    taskdag_edge_id "$cfrom" "$cto" "$jrel" "$jmode" || return 1
}

# _taskdag_graph_recompute_tree <old-commit-or-empty> <op> <path> <blobsha>
#                               [<op> <path> <blobsha> ...]:
# recompute the graph tree by applying ONE OR MORE idempotent ops to the tree
# of the given old commit (empty ⇒ start from an empty tree), in a SINGLE
# scratch index, so a compound change (e.g. add-tombstone + remove-edge) lands
# atomically in one tree/commit — never as an observable two-step. Ops come in
# triples; a <blobsha> is required for the *-add ops and ignored (pass "") for
# remove. op ∈ add | tombstone-add | remove.
# Prints the new tree object id. Uses a SCRATCH index (git mktree rejects
# slashed paths) scoped to a subshell so GIT_INDEX_FILE never leaks. Because
# blobs are content-addressed at <dir>/<edge-id>.json, applying the same op
# twice is a no-op (idempotent) and applying ops in any order yields the same
# tree (commutative union).
_taskdag_graph_recompute_tree() {
    local old="$1"; shift
    local gitdir idx tree
    gitdir=$(git rev-parse --git-dir) || return 1
    idx="${gitdir}/.taskdag-graph-cas.$$.index"
    rm -f "$idx"
    # Ops MUST come in whole (op, path, blobsha) triples; a partial tuple is a
    # caller bug — fail loud rather than silently drop an op.
    if [ $(( $# % 3 )) -ne 0 ]; then
        echo "Error: _taskdag_graph_recompute_tree needs ops in (op,path,blobsha) triples (got $# extra args)" >&2
        rm -f "$idx"; return 1
    fi
    tree=$(
        export GIT_INDEX_FILE="$idx"
        if [ -n "$old" ]; then
            git read-tree "${old}^{tree}" || exit 1
        fi
        while [ $# -gt 0 ]; do
            local op="$1" path="$2" blobsha="$3"; shift 3
            case "$op" in
                add)
                    # Idempotent on the SEMANTIC path: if edges/<edge-id>.json
                    # is already present, leave the tree unchanged (a
                    # metadata-only re-add must NOT fork a new edge or churn the
                    # ref — the first writer's provenance is sticky; origin{} is
                    # not identity). But refuse a silent no-op over a CORRUPT
                    # existing edge: the authoritative writer must never report
                    # success on a path the reader would reject, so validate the
                    # stored blob first. Also refuse to (re-)add an edge whose
                    # id is TOMBSTONED — a deliberately-dropped edge is terminal
                    # and must never be silently resurrected.
                    local tpath="tombstones/${path#edges/}"
                    if git ls-files --cached --error-unmatch "$tpath" >/dev/null 2>&1; then
                        echo "Error: edge ${path} is TOMBSTONED (deliberately dropped); refusing to resurrect it — a new dependency must be re-established explicitly" >&2; exit 1
                    fi
                    if git ls-files --cached --error-unmatch "$path" >/dev/null 2>&1; then
                        existing=$(git cat-file blob ":${path}") || { echo "Error: could not read existing edge ${path}" >&2; exit 1; }
                        ebase="${path#edges/}"; ebase="${ebase%.json}"
                        recomputed=$(_taskdag_edge_blob_check "$existing") || {
                            echo "Error: existing edge ${path} is corrupt / non-canonical; refusing to report a no-op add (fix or 'dep drop' it)" >&2; exit 1
                        }
                        [ "$recomputed" = "$ebase" ] || {
                            echo "Error: existing edge ${path} content hashes to ${recomputed} (path/content mismatch); refusing to report a no-op add" >&2; exit 1
                        }
                        : # valid + semantically identical → idempotent no-op
                    else
                        git update-index --add --cacheinfo "100644,${blobsha},${path}" || exit 1
                    fi
                    ;;
                tombstone-add)
                    # Sticky tombstone add (mirrors `add`): if the tombstone is
                    # already present, leave it (idempotent on the semantic path
                    # — a re-tombstone with a fresh removal witness must not
                    # churn the ref), but refuse a silent no-op over a CORRUPT
                    # existing tombstone the reader would reject.
                    if git ls-files --cached --error-unmatch "$path" >/dev/null 2>&1; then
                        existing=$(git cat-file blob ":${path}") || { echo "Error: could not read existing tombstone ${path}" >&2; exit 1; }
                        tbase="${path#tombstones/}"; tbase="${tbase%.json}"
                        recomputed=$(_taskdag_tombstone_edge_id "$existing") || {
                            echo "Error: existing tombstone ${path} is corrupt / non-canonical; refusing to report a no-op" >&2; exit 1
                        }
                        [ "$recomputed" = "$tbase" ] || {
                            echo "Error: existing tombstone ${path} content hashes to ${recomputed} (path/content mismatch); refusing to report a no-op" >&2; exit 1
                        }
                        : # valid + semantically identical → idempotent no-op
                    else
                        git update-index --add --cacheinfo "100644,${blobsha},${path}" || exit 1
                    fi
                    ;;
                remove) git update-index --force-remove "$path" || exit 1 ;;
                *) echo "Error: unknown graph op: $op" >&2; exit 1 ;;
            esac
        done
        git write-tree
    )
    local rc=$?
    rm -f "$idx"
    [ "$rc" -eq 0 ] || return 1
    printf '%s\n' "$tree"
}

# _taskdag_graph_cas <commit-msg> <op> <path> <blobsha-or-empty>
#                    [<op> <path> <blobsha-or-empty> ...]:
# the FF-only direct-CAS core shared by dep add / dep drop / prune. Applies
# one OR MORE ops in a SINGLE FF commit (see _taskdag_graph_recompute_tree),
# so a compound change (tombstone + edge removal) is never observable as a
# two-step "silent deletion" window.
#   op=add           -> ensure edges/<edge-id>.json (blobsha) is present
#   op=tombstone-add -> ensure tombstones/<edge-id>.json (blobsha) is present
#   op=remove        -> ensure <path> is absent
# Returns:
#   0  applied (pushed + origin-confirmed) OR already in the desired state
#      (idempotent no-op — nothing to push)
#   1  failed loud (retry budget exhausted, transport error, or corruption)
#   2  idempotent no-op (desired state already held; nothing pushed)
_taskdag_graph_cas() {
    local msg="$1"; shift
    local -a ops=("$@")
    local attempt=0 old oldtree newtree newcommit push_output lease readback

    while :; do
        # (1) fetch tip — tri-state so we never CAS against a false-empty set.
        if ! taskdag_sync_graph_ref; then
            attempt=$(( attempt + 1 ))
            if [ "$attempt" -gt "$TASKDAG_CAS_MAX_ATTEMPTS" ]; then
                echo "Error: could not sync ${TASKDAG_GRAPH_REF} from origin after ${TASKDAG_CAS_MAX_ATTEMPTS} attempts (indeterminate transport) — failing loud rather than spin" >&2
                return 1
            fi
            taskdag_cas_sleep "$attempt" || return 1
            continue
        fi

        # (2) recompute the new tree against the freshly-fetched tip.
        old=$(git rev-parse --verify -q "${TASKDAG_GRAPH_REF}^{commit}" 2>/dev/null || true)
        if [ -n "$old" ]; then
            oldtree=$(git rev-parse --verify -q "${old}^{tree}") || return 1
        else
            oldtree="$EMPTY_TREE"
        fi
        newtree=$(_taskdag_graph_recompute_tree "$old" "${ops[@]}") || {
            echo "Error: failed to recompute ${TASKDAG_GRAPH_REF} tree" >&2; return 1
        }

        # (3) idempotent no-op: the desired state already holds. Nothing to
        #     push — the write is already durable (add of an existing edge,
        #     or remove of an absent edge).
        if [ "$newtree" = "$oldtree" ]; then
            return 2
        fi

        # (4) build the FF commit (parents only the previous graph commit).
        if [ -n "$old" ]; then
            newcommit=$(printf '%s' "$msg" | git commit-tree "$newtree" -p "$old") || {
                echo "Error: failed to build ${TASKDAG_GRAPH_REF} commit" >&2; return 1
            }
        else
            newcommit=$(printf '%s' "$msg" | git commit-tree "$newtree") || {
                echo "Error: failed to build ${TASKDAG_GRAPH_REF} commit" >&2; return 1
            }
        fi

        # (5) FF-only CAS push. After activation, the graph update also
        #     advances the shared semantic generation (activation authority),
        #     so a claim/completion prepared against the old graph cannot land
        #     concurrently. Before activation preserve the legacy direct CAS.
        lease="--force-with-lease=${TASKDAG_GRAPH_REF}:${old}"
        local updates graph_push_rc=0
        taskdag_consumer_prepare graph-cas || return 1
        [ "$TASKDAG_CONSUMER_GRAPH_TIP" = "$old" ] || { taskdag_cas_sleep 1; continue; }
        if [ "$TASKDAG_CONSUMER_MODE" = canonical ]; then
            updates=$(jq -ncS --arg ref "$TASKDAG_GRAPH_REF" --arg old "$old" --arg new "$newcommit" \
                '[{ref:$ref,old:$old,new:$new}]') || return 1
            taskdag_consumer_fenced_scheduling_push graph-cas "${TASK_DAG_CLAIMER:-graph-writer}" "$updates" \
                || graph_push_rc=$?
            push_output="canonical semantic-generation CAS failed"
        else
            push_output=$(git push --atomic origin "$lease" "${newcommit}:${TASKDAG_GRAPH_REF}" 2>&1) \
                || graph_push_rc=$?
        fi
        if [ "$graph_push_rc" -eq 0 ]; then
            # Double-checked locking: confirm origin actually holds OUR commit.
            readback=$(git ls-remote origin "$TASKDAG_GRAPH_REF" 2>/dev/null | awk '{print $1}')
            if [ -z "$readback" ]; then
                echo "Error: ${TASKDAG_GRAPH_REF} push reported success but origin readback was unreachable; could not confirm" >&2
                return 1
            fi
            if [ "$readback" != "$newcommit" ]; then
                # Someone landed between our push and the readback. Treat as a
                # lost race: refetch + recompute + retry within the budget.
                attempt=$(( attempt + 1 ))
                if [ "$attempt" -gt "$TASKDAG_CAS_MAX_ATTEMPTS" ]; then
                    echo "Error: ${TASKDAG_GRAPH_REF} CAS lost to concurrent writers and exhausted ${TASKDAG_CAS_MAX_ATTEMPTS} attempts — failing loud rather than spin" >&2
                    return 1
                fi
                taskdag_cas_sleep "$attempt" || return 1
                continue
            fi
            # Mirror into the local ref (origin is the source of truth, so a
            # local mirror failure must not fail a confirmed remote success).
            git update-ref "$TASKDAG_GRAPH_REF" "$newcommit" 2>/dev/null \
                || echo "Warning: origin updated but local mirror of ${TASKDAG_GRAPH_REF} failed" >&2
            return 0
        fi

        # (6) classify the failure. A non-FF / stale-lease rejection is a lost
        #     race ⇒ backoff + retry. Anything else is a hard transport error.
        if echo "$push_output" | grep -qiE 'rejected|stale info|non-fast-forward|fetch first|force-with-lease'; then
            attempt=$(( attempt + 1 ))
            if [ "$attempt" -gt "$TASKDAG_CAS_MAX_ATTEMPTS" ]; then
                echo "Error: ${TASKDAG_GRAPH_REF} FF-CAS exhausted ${TASKDAG_CAS_MAX_ATTEMPTS} retry attempts under contention — failing loud rather than spin" >&2
                echo "$push_output" >&2
                return 1
            fi
            taskdag_cas_sleep "$attempt" || return 1
            continue
        fi

        echo "Error: ${TASKDAG_GRAPH_REF} push failed (transport / non-race):" >&2
        echo "$push_output" >&2
        return 1
    done
}

# taskdag_dep_add <from> <to> <relation> <mode> <repo-id> <witness> [<reason>]:
# add (idempotently) a dependency edge to this repo's graph index via the
# FF-only direct CAS. All node/relation/mode inputs are validated + canonical
# via the edges.sh helpers, so a malformed edge can never be minted. Returns
# 0 on success (added or already present), 1 on a loud failure.
taskdag_dep_add() {
    local from to relation="$3" mode="$4" repo_id="$5" witness="$6" reason="${7:-}"
    local eid blob blobsha path msg rc
    from=$(taskdag_normalize_node "$1") || { echo "Error: invalid 'from' node: $1" >&2; return 1; }
    to=$(taskdag_normalize_node "$2")   || { echo "Error: invalid 'to' node: $2" >&2; return 1; }
    eid=$(taskdag_edge_id "$from" "$to" "$relation" "$mode") || return 1

    # NB: `dep add` deliberately does NOT prune or reject an edge whose
    # completion witness already exists on master (a would-be-immediately-
    # prunable edge). An edge records a real dependency RELATIONSHIP that the
    # reconcile layer reads (e.g. a leaf with a satisfied `requires` edge is
    # ready-but-not-complete, and must appear as an edge-source node); silently
    # dropping it at add time would lose that membership. Bounding the active
    # set is the sole job of the EXPLICIT pruning paths (`dep prune` /
    # prunable `dep drop`), not of add. A concurrent prune re-deleting a just-
    # added satisfied edge is harmless churn (completion is monotonic, prune is
    # idempotent), not data loss. The one terminal case add DOES refuse is a
    # TOMBSTONED edge-id (deliberate removal, remove-wins) — enforced in the CAS
    # `add` op against the current graph tree, so a racing tombstone still wins.
    blob=$(taskdag_edge_blob "$from" "$to" "$relation" "$mode" "$repo_id" "$witness") || return 1
    blobsha=$(printf '%s' "$blob" | git hash-object -w --stdin) || { echo "Error: could not hash edge blob" >&2; return 1; }
    path="edges/${eid}.json"
    msg="Add dependency edge ${eid:0:12}: ${from} ${relation} ${to}

Edge-Id: ${eid}
From: ${from}
To: ${to}
Relation: ${relation}
Mode: ${mode}
Origin-Repo-Id: ${repo_id}
Witness: ${witness}"
    [ -n "$reason" ] && msg="${msg}
Reason: ${reason}"

    # `|| rc=$?` (not `; rc=$?`) so a non-zero return under the CLI's `set -e`
    # is captured here instead of aborting the process (rc=2 is a valid no-op).
    rc=0; _taskdag_graph_cas "$msg" add "$path" "$blobsha" || rc=$?
    case "$rc" in
        0) printf "${GREEN}✓ Added edge %s${RESET} (%s %s %s)\n" "${eid:0:12}" "$from" "$relation" "$to" ;;
        2) printf "${BLUE}• Edge %s already present${RESET} (idempotent no-op)\n" "${eid:0:12}"; return 0 ;;
        *) return 1 ;;
    esac
}

# _taskdag_graph_edge_tuple <eid>: read edges/<eid>.json from the LOCAL graph
# ref tree, validate it exactly as the reader does, and print the TSV tuple
#   <from>\t<to>\t<relation>\t<mode>\t<origin-repo-id>
# needed to reconstruct a tombstone. Returns non-zero (no output) if the edge
# blob is absent or corrupt. Assumes the caller synced the graph ref first.
_taskdag_graph_edge_tuple() {
    local eid="$1" blob recomputed
    blob=$(git cat-file blob "${TASKDAG_GRAPH_REF}:edges/${eid}.json" 2>/dev/null) || return 1
    recomputed=$(_taskdag_edge_blob_check "$blob") || return 1
    [ "$recomputed" = "$eid" ] || return 1
    printf '%s\t%s\t%s\t%s\t%s\n' \
        "$(printf '%s' "$blob" | jq -r '.from')" \
        "$(printf '%s' "$blob" | jq -r '.to')" \
        "$(printf '%s' "$blob" | jq -r '.relation')" \
        "$(printf '%s' "$blob" | jq -r '.mode')" \
        "$(printf '%s' "$blob" | jq -r '.origin["repo-id"]')"
}

# _taskdag_graph_has_path <path>: 0 iff <path> exists in the LOCAL graph tree.
_taskdag_graph_has_path() {
    git cat-file -e "${TASKDAG_GRAPH_REF}:$1" 2>/dev/null
}

# taskdag_dep_drop <edge-id> [<reason>]: remove an edge from this repo's graph
# index (issue #13 satisfied-edge-pruning sibling). Removal is PRUNABILITY-
# AWARE (never a silent tree deletion of a not-yet-prunable edge). Prunability
# is relation-aware (see _taskdag_edge_prunable):
#   • edge PRUNABLE on master        → PRUNE: plain FF deletion of
#     edges/<edge-id>.json (master's completion is the durable witness, so no
#     tombstone is needed). Prunable means done(TO) for a requires edge, or
#     done(FROM) for a satisfies edge (NOT done(to) — a satisfies edge to a
#     done target is the live supersede signal, kept until the dependent is
#     done).
#   • not yet prunable               → TOMBSTONE: one atomic FF commit that
#     writes tombstones/<edge-id>.json AND removes edges/<edge-id>.json, so a
#     deliberately-dropped edge is distinguishable from a lost one and can
#     never be silently resurrected by a racing re-add (tombstone wins).
#   • already tombstoned             → idempotent no-op success.
#   • edge absent AND no tombstone   → FAIL LOUD: with only an edge-id we
#     cannot reconstruct the tuple a tombstone needs, and a silent success
#     would mask a lost edge.
# Prunability is derived from master via the fact layer when available (the
# full CLI always sources it); standalone (no fact layer) it conservatively
# TOMBSTONES rather than prune, since pruning without a durable witness would
# be an unwitnessed deletion.
taskdag_dep_drop() {
    local eid="$1" reason="${2:-}" msg rc
    [[ "$eid" =~ ^[0-9a-f]{64}$ ]] || { echo "Error: dep drop needs a 64-hex edge-id (got: $eid)" >&2; return 1; }

    local epath="edges/${eid}.json" tpath="tombstones/${eid}.json"

    # Freshen the local graph ref so state routing (present? tombstoned?) is
    # made against origin, not a stale local view. Fail closed on indeterminate
    # transport (mirrors the reader/writer contract).
    taskdag_sync_graph_ref || { echo "Error: could not sync ${TASKDAG_GRAPH_REF} from origin (indeterminate); refusing to route a drop against a possibly-stale view" >&2; return 1; }

    # Already tombstoned → nothing to do (idempotent, terminal).
    if _taskdag_graph_has_path "$tpath"; then
        printf "${BLUE}• Edge %s already tombstoned${RESET} (idempotent no-op)\n" "${eid:0:12}"
        return 0
    fi

    # Edge absent (and not tombstoned) → cannot reconstruct the tuple; fail loud.
    if ! _taskdag_graph_has_path "$epath"; then
        echo "Error: edge ${eid:0:12} is not present in ${TASKDAG_GRAPH_REF} (and is not tombstoned); nothing to drop — refusing to fabricate a tombstone for an unknown edge" >&2
        return 1
    fi

    # Read the tuple we need for either path.
    local tuple from to relation mode repoid
    tuple=$(_taskdag_graph_edge_tuple "$eid") || { echo "Error: edge ${eid:0:12} is corrupt / non-canonical; cannot drop it safely" >&2; return 1; }
    IFS=$'\t' read -r from to relation mode repoid <<<"$tuple"

    # Route: PRUNABLE → prune; ANYTHING ELSE → tombstone. Prunability is
    # relation-aware (see _taskdag_edge_prunable): a requires edge is prunable
    # iff done(TO), a satisfies edge iff done(FROM) — NOT done(to), because a
    # satisfies edge whose target is done is the LIVE supersede signal and must
    # stay active until the DEPENDENT itself completes. Prune is the only
    # unwitnessed action, so it requires a POSITIVE done fact on the witness
    # node; a not-done or indeterminate (e.g. unresolvable current repo) answer,
    # or an unavailable fact layer, conservatively TOMBSTONES — always safe (an
    # explicit witnessed removal) and never an unwitnessed deletion. done() is
    # monotonic, so even a stale positive is durable; the master sync below is a
    # best-effort freshen (so a just-completed witness prunes cleanly rather
    # than leaving a redundant tombstone), never fatal.
    local prunable=false
    if declare -F _taskdag_edge_prunable >/dev/null 2>&1; then
        if declare -F taskdag_sync_master >/dev/null 2>&1; then
            taskdag_sync_master || true
        fi
        _taskdag_edge_prunable "$relation" "$from" "$to" && prunable=true
    fi

    if [ "$prunable" = true ]; then
        # PRUNE: the completion witness lives on master; a plain deletion is
        # honest and bounded — re-deriving from master would just re-confirm it.
        local witness
        [ "$relation" = satisfies ] && witness="dependent ${from} done" || witness="target ${to} done"
        msg="Prune dependency edge ${eid:0:12} (${witness})

Edge-Id: ${eid}
Relation: ${relation}
Prune-Witness: ${witness}"
        [ -n "$reason" ] && msg="${msg}
Reason: ${reason}"
        rc=0; _taskdag_graph_cas "$msg" remove "$epath" "" || rc=$?
        case "$rc" in
            0) printf "${GREEN}✓ Pruned edge %s${RESET} (%s)\n" "${eid:0:12}" "$witness" ;;
            2) printf "${BLUE}• Edge %s not present${RESET} (idempotent no-op)\n" "${eid:0:12}"; return 0 ;;
            *) return 1 ;;
        esac
        return 0
    fi

    # TOMBSTONE: deliberate removal BEFORE the completion witness exists. Build the tombstone
    # blob from the edge's own tuple + a fresh removal witness (HEAD), and land
    # it together with the edge removal in ONE atomic FF commit.
    local witness tblob tblobsha
    witness=$(git rev-parse --verify -q HEAD 2>/dev/null || true)
    [ -n "$witness" ] || witness="dep-drop"
    tblob=$(taskdag_tombstone_blob "$from" "$to" "$relation" "$mode" "$repoid" "$witness") || return 1
    tblobsha=$(printf '%s' "$tblob" | git hash-object -w --stdin) || { echo "Error: could not hash tombstone blob" >&2; return 1; }
    msg="Tombstone dependency edge ${eid:0:12}: ${from} ${relation} ${to}

Edge-Id: ${eid}
Tombstone: true
From: ${from}
To: ${to}
Relation: ${relation}
Mode: ${mode}
Witness: ${witness}"
    [ -n "$reason" ] && msg="${msg}
Reason: ${reason}"

    rc=0; _taskdag_graph_cas "$msg" tombstone-add "$tpath" "$tblobsha" remove "$epath" "" || rc=$?
    case "$rc" in
        0) printf "${GREEN}✓ Tombstoned edge %s${RESET} (deliberate removal before satisfaction)\n" "${eid:0:12}" ;;
        2) printf "${BLUE}• Edge %s already tombstoned${RESET} (idempotent no-op)\n" "${eid:0:12}"; return 0 ;;
        *) return 1 ;;
    esac
}

# Command: dep — WRITE (add/drop) dependency edges (direct-CAS writer).
cmd_dep() {
    local sub="${1:-}"
    [ $# -gt 0 ] && shift
    case "$sub" in
        add) _cmd_dep_add "$@" ;;
        drop) _cmd_dep_drop "$@" ;;
        prune) _cmd_dep_prune "$@" ;;
        ""|--help|-h)
            cat <<'EOF'
Usage:
  task-dag dep add --from <node> --to <node> --relation requires|satisfies
                   [--mode all|any] [--repo-id <n>] [--witness <id>]
                   [--reason "..."]
  task-dag dep drop <edge-id> [--reason "..."]
  task-dag dep prune [<edge-id>] [--no-fetch]

WRITE the active dependency-edge set to this repo's graph index branch
refs/heads/tasks/v1/graph (issue #13 north-star) via a direct FF-only CAS
push — the same ref-update CAS a completion merge uses. Succeeds or fails at
push time; there is no accepted-but-not-committed tier.

Nodes:  task:<owner>/<repo>@<40|64-hex>   issue:<owner>/<repo>#<N>
Relation/mode pairs are fixed: requires⇒all, satisfies⇒any (OR-deps out of
scope). --mode is optional and defaults from --relation; if given it must
match the fixed pair.

--repo-id  stable numeric GitHub id of the FROM node's repo (origin.repo-id);
           defaults to resolving it (git-config override, else `gh`).
--witness  provenance stamped into the edge blob (origin.witness); defaults
           to the current HEAD commit sha.
--reason   free text recorded in the graph commit message (durable history
           provenance), never in the edge blob.

`dep drop` is PRUNABILITY-AWARE (relation-aware): if the edge is already
prunable on master — done(TO) for a requires edge, done(FROM) for a satisfies
edge — it PRUNES the edge (plain deletion of edges/<edge-id>.json — master's
completion is the durable witness), otherwise it writes an explicit TOMBSTONE
(tombstones/<edge-id>.json) atomically with the edge removal, so a deliberate
removal before prunability is distinguishable from a lost edge and can never
be silently resurrected. A tombstoned edge is terminal: `dep add` of the same
edge-id fails loud. `dep prune` removes prunable edges (all active ones, or a
single <edge-id>) — the bounded-set backstop. All are idempotent. On push
contention the writer refetches, recomputes the commutative edge-set union,
and re-pushes with a bounded quadratic backoff (~1s base + jitter ramping
toward a ~10s cap); an exhausted retry budget fails loud. Requires jq + git.
EOF
            return 0
            ;;
        *) echo "Error: unknown 'dep' subcommand: $sub (expected add|drop|prune)" >&2; return 2 ;;
    esac
}

_cmd_dep_add() {
    local from="" to="" relation="" mode="" repo_id="" witness="" reason=""
    while [ $# -gt 0 ]; do
        # Guard $2 before reading it so a value-less option (e.g. `dep add
        # --from`) is a clean usage error, not a `set -u` process abort.
        case "$1" in
            --from|--to|--relation|--mode|--repo-id|--witness|--reason)
                [ $# -ge 2 ] || { echo "Error: $1 requires a value" >&2; return 2; } ;;
        esac
        case "$1" in
            --from) from="$2"; shift 2 ;;
            --to) to="$2"; shift 2 ;;
            --relation) relation="$2"; shift 2 ;;
            --mode) mode="$2"; shift 2 ;;
            --repo-id) repo_id="$2"; shift 2 ;;
            --witness) witness="$2"; shift 2 ;;
            --reason) reason="$2"; shift 2 ;;
            --help|-h) cmd_dep --help; return 0 ;;
            *) echo "Error: unknown option to 'dep add': $1" >&2; return 2 ;;
        esac
    done
    [ -n "$from" ] || { echo "Error: dep add requires --from" >&2; return 2; }
    [ -n "$to" ]   || { echo "Error: dep add requires --to" >&2; return 2; }
    [ -n "$relation" ] || { echo "Error: dep add requires --relation (requires|satisfies)" >&2; return 2; }
    # Default mode from the fixed relation pairing; validate any explicit one.
    if [ -z "$mode" ]; then
        case "$relation" in
            requires) mode=all ;;
            satisfies) mode=any ;;
            *) echo "Error: --relation must be requires or satisfies (got: $relation)" >&2; return 2 ;;
        esac
    fi
    taskdag_relation_mode_ok "$relation" "$mode" || {
        echo "Error: invalid relation/mode pair: ${relation}/${mode} (allowed: requires/all, satisfies/any)" >&2; return 2
    }

    # Canonicalize 'from' up front so we can resolve its repo's numeric id.
    local cfrom cowner_repo
    cfrom=$(taskdag_normalize_node "$from") || { echo "Error: invalid 'from' node: $from" >&2; return 2; }
    # from = task:<owner>/<repo>@... | issue:<owner>/<repo>#... — strip kind
    # + ref to get the owner/repo the edge belongs to.
    cowner_repo="${cfrom#*:}"; cowner_repo="${cowner_repo%%@*}"; cowner_repo="${cowner_repo%%#*}"

    if [ -z "$repo_id" ]; then
        repo_id=$(taskdag_repo_numeric_id "$cowner_repo") || {
            echo "Error: could not resolve origin.repo-id for ${cowner_repo}; pass --repo-id explicitly" >&2; return 1
        }
    fi
    if [ -z "$witness" ]; then
        witness=$(git rev-parse --verify -q HEAD 2>/dev/null || true)
        [ -n "$witness" ] || { echo "Error: no HEAD to use as a default --witness; pass --witness explicitly" >&2; return 2; }
    fi

    taskdag_dep_add "$from" "$to" "$relation" "$mode" "$repo_id" "$witness" "$reason"
}

_cmd_dep_drop() {
    local eid="" reason=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --reason)
                [ $# -ge 2 ] || { echo "Error: --reason requires a value" >&2; return 2; }
                reason="$2"; shift 2 ;;
            --help|-h) cmd_dep --help; return 0 ;;
            -*) echo "Error: unknown option to 'dep drop': $1" >&2; return 2 ;;
            *) [ -z "$eid" ] || { echo "Error: dep drop takes a single edge-id" >&2; return 2; }; eid="$1"; shift ;;
        esac
    done
    [ -n "$eid" ] || { echo "Error: dep drop requires an <edge-id>" >&2; return 2; }
    taskdag_dep_drop "$eid" "$reason"
}

# taskdag_wrapper_owner_repo <normalized-node>: extract the canonical
# owner/repo of a node (task:<owner>/<repo>@… | issue:<owner>/<repo>#…).
# Shared by the thin edge WRAPPERS (supersede / delegate / block --downstream)
# to enforce that the edge's FROM node belongs to THIS repo — the graph index
# branch is per-repo and _cmd_dep_add stamps origin.repo-id from the FROM
# node's repo, so a foreign-FROM edge would be misfiled + never derivable.
taskdag_wrapper_owner_repo() {
    local n="${1#*:}"; n="${n%%@*}"; n="${n%%#*}"; printf '%s' "$n"
}

# Command: supersede — thin wrapper minting ONE `satisfies` edge (issue #13
# north-star). `supersede <node> --by <byNode>` records that <node> is
# fulfilled by <byNode>'s completion: complete(<node>) short-circuits true
# once done(<byNode>) is a durable fact on master (the reconcile predicate,
# @5). This is the #57 miss reduced to one command — no manual
# complete-historical, no zombie. Edge-only (Phase 4 first step): it writes
# NO legacy ref; the automatic synth-completion for a satisfied `satisfies`
# edge is the separate reconciler-backstop sibling task.
cmd_supersede() {
    local node="" by="" reason="" dry_run=false
    while [ $# -gt 0 ]; do
        case "$1" in
            --by)
                [ $# -ge 2 ] || { echo "Error: --by requires a value" >&2; return 2; }
                by="$2"; shift 2 ;;
            --by=*) by="${1#*=}"; shift ;;
            --reason)
                [ $# -ge 2 ] || { echo "Error: --reason requires a value" >&2; return 2; }
                reason="$2"; shift 2 ;;
            --reason=*) reason="${1#*=}"; shift ;;
            --dry-run) dry_run=true; shift ;;
            --help|-h)
                cat <<'EOF'
Usage:
  task-dag supersede <node> --by <node> [--reason "..."] [--dry-run]

Record that <node> is SUPERSEDED / re-scoped by <node-after-'--by'>: mint a
single `satisfies` edge (from=<node>, to=<--by node>) in this repo's graph
index branch refs/heads/tasks/v1/graph (issue #13 north-star), via the same
direct FF-only CAS `dep add` uses. Once the --by node's completion is a
durable fact on master, complete(<node>) becomes true (the supersede
short-circuit in the reconcile predicate) — the automation#57 zombie reduced
to one command.

Nodes are FULL canonical addresses (same grammar as `dep add`):
  task:<owner>/<repo>@<40|64-hex>     issue:<owner>/<repo>#<N>
The FROM <node> must belong to THIS repo (the graph index is per-repo). The
--by node may be same- or cross-repo (a cross-repo `to` is satisfied once the
reconciler backstop delivers/derives its completion — a later sibling task).

Edge-only: this writes NO legacy ref. `--dry-run` prints the edge it WOULD
mint (with its stable semantic edge-id) and writes nothing. Idempotent by
edge-id (a re-run is a no-op). --reason is recorded in the graph commit.
EOF
                return 0 ;;
            -*) echo "Error: unknown option to 'supersede': $1" >&2; return 2 ;;
            *) [ -z "$node" ] || { echo "Error: supersede takes a single <node> (got extra: $1)" >&2; return 2; }
               node="$1"; shift ;;
        esac
    done
    [ -n "$node" ] || { echo "Error: supersede requires a <node> (the superseded node)" >&2; return 2; }
    [ -n "$by" ]   || { echo "Error: supersede requires --by <node> (what fulfils it)" >&2; return 2; }

    local cnode cby
    cnode=$(taskdag_normalize_node "$node") || { echo "Error: invalid <node>: $node (use task:<owner>/<repo>@<hex> or issue:<owner>/<repo>#<N>)" >&2; return 2; }
    cby=$(taskdag_normalize_node "$by")     || { echo "Error: invalid --by node: $by (use task:<owner>/<repo>@<hex> or issue:<owner>/<repo>#<N>)" >&2; return 2; }
    if [ "$cnode" = "$cby" ]; then
        echo "Error: a node cannot supersede itself (<node> == --by): $cnode" >&2; return 2
    fi

    # The graph index is per-repo and origin.repo-id is stamped from the FROM
    # node's repo, so refuse a foreign-FROM supersede (run it in the repo that
    # owns <node>). FAIL CLOSED when the current repo cannot be resolved — a
    # supersede whose FROM ownership cannot be proven must never be written
    # (and the same precondition gates --dry-run so it validates the real
    # write's contract).
    local cur from_or
    from_or=$(taskdag_wrapper_owner_repo "$cnode")
    cur=$(taskdag_current_repo) || {
        echo "Error: supersede cannot determine the current repo to validate FROM ownership; set TASKDAG_CURRENT_REPO or 'git config taskdag.current-repo owner/repo'" >&2
        return 2
    }
    if [ "$from_or" != "$cur" ]; then
        echo "Error: supersede must run in the repo that owns <node> (${from_or}); current repo is ${cur}. The graph index is per-repo." >&2
        return 2
    fi

    if [ "$dry_run" = true ]; then
        local eid
        eid=$(taskdag_edge_id "$cnode" "$cby" satisfies any) || return 1
        printf "${BLUE}• [dry-run] would mint satisfies edge %s${RESET}\n" "${eid:0:12}"
        printf "    from:     %s\n" "$cnode"
        printf "    to:       %s\n" "$cby"
        printf "    relation: satisfies (mode any)\n"
        printf "    edge-id:  %s\n" "$eid"
        [ -n "$reason" ] && printf "    reason:   %s\n" "$reason"
        printf "  (no ref written)\n"
        return 0
    fi

    local reason_args=()
    [ -n "$reason" ] && reason_args=(--reason "$reason")
    _cmd_dep_add --from "$cnode" --to "$cby" --relation satisfies "${reason_args[@]}"
}
