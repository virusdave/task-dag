# shellcheck shell=bash
# ═══════════════════════════════════════════════════════════════════════
# task-dag dependency-edge data model + READER (issue #13 north-star, Phase 2)
#
# This module carries ONLY the foundational data model and the READ side of
# the uniform dependency graph:
#   • edge blob schema (schema:1) + node addressing,
#   • the stable SEMANTIC edge-id,
#   • stable numeric repo-identity resolution,
#   • the reader that parses the latest tree of the per-repo FF-only index
#     branch refs/heads/tasks/v1/graph into the active edge set.
#
# The direct-CAS WRITER (dep add / drop / prune) lives in edges-write.sh; the
# satisfied-edge PRUNING + explicit TOMBSTONE *write* side lives in
# edges-prune.sh. This module carries ONLY the data model + read side, which
# now includes the tombstone blob serializer and tombstone-aware active-set
# computation (the reader must know a tombstone masks an edge). The cross-repo
# mailbox, the reconciler, supersede, and the `graph --explain` resolver are
# SEPARATE sibling tasks and are deliberately NOT implemented here. Do not
# grow this module into them without their own reviews.
#
# TOMBSTONES (schema v1, additive — issue #13 satisfied-edge-pruning sibling):
#   A tombstone is an explicit, witnessed record that an edge was DELIBERATELY
#   removed BEFORE it was satisfied, so a lost edge is distinguishable from an
#   intentionally-dropped one. It is a SEPARATE blob at its OWN path
#   `tombstones/<edge-id>.json` (never a `deleted`/`active` flag overloaded
#   onto the edge blob), content-addressed by the SAME semantic edge-id as the
#   edge it removes:
#     { "schema":1, "tombstone":true,
#       "from":<node>, "to":<node>, "relation":..., "mode":...,
#       "origin":{ "repo-id":<n>, "witness":"<removal witness>" } }
#   Active edge set = edges/<id>.json present AND tombstones/<id>.json ABSENT
#   (tombstone WINS if both are present — remove-wins under the commutative
#   union, so a racing re-add can never resurrect a tombstoned edge). A
#   SATISFIED edge is instead PRUNED (plain FF tree deletion, no tombstone)
#   because master's completion is the durable witness; only removal BEFORE
#   satisfaction needs a tombstone.
#
# ─────────────────────────────────────────────────────────────────────
# DATA MODEL (the durable contract the writer sibling must honour)
#
#   Index branch:  refs/heads/tasks/v1/graph  (TASKDAG_GRAPH_REF, in the main
#     script). Fast-forward-only. Its LATEST tree IS the active edge set — a
#     content-addressed set of blobs at edges/<edge-id>.json. History is not
#     read by the reader (latest tree only). Graph commits parent only the
#     previous graph-index commit, never task commits; there are NO per-edge
#     refs (that is the bounded-ref invariant).
#
#   Node addressing:
#     task:<owner>/<repo>@<full-lowercase-object-id>   (40 or 64 hex)
#     issue:<owner>/<repo>#<decimal>                   (no leading zero)
#     owner/repo is CASE-FOLDED to lowercase for canonical identity (GitHub
#     repo identity is case-insensitive) so Owner/Repo and owner/repo do not
#     fork distinct edges.
#
#   Edge blob (schema:1), canonical JSON emitted via jq:
#     { "schema": 1,
#       "from": "<node>", "to": "<node>",
#       "relation": "requires"|"satisfies",
#       "mode": "all"|"any",
#       "origin": { "repo-id": <stable numeric repo id>,
#                   "witness": "<commit-sha / message-id>" } }
#     Relation/mode pairs are FIXED: requires⇒all, satisfies⇒any (OR-deps are
#     out of scope per the operator-locked decisions on issue #13).
#     Direction: `from` is the node making the assertion — "from requires to"
#     / "from satisfies to".
#
#   edge-id = full sha256 hex of the NUL-delimited canonical tuple
#     (from, to, relation, mode) — the SEMANTIC identity, NOT the blob hash.
#     origin{} (repo-id + witness) is provenance and is deliberately EXCLUDED
#     from the id, so a re-add or a metadata-only edit is idempotent (same
#     edge-id ⇒ same path) while a same-path NON-identical semantic write is
#     detectable (path/content mismatch — the reader flags it).
# ═══════════════════════════════════════════════════════════════════════

# taskdag_sha256_hex: read stdin, print its lowercase sha256 hex digest.
# Prefers sha256sum (coreutils, canonical on NixOS); falls back to
# `shasum -a 256`. Fails loud if neither is present (an edge-id must never
# be silently mis-derived).
taskdag_sha256_hex() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 | awk '{print $1}'
    else
        echo "Error: need sha256sum or shasum for edge-id derivation" >&2
        return 1
    fi
}

# taskdag_norm_owner_repo <owner/repo>: validate + lowercase an owner/repo
# pair. Prints the canonical form; returns non-zero on a malformed value.
taskdag_norm_owner_repo() {
    local or="$1"
    or=$(printf '%s' "$or" | tr '[:upper:]' '[:lower:]')
    if [[ "$or" =~ ^[a-z0-9._-]+/[a-z0-9._-]+$ ]]; then
        printf '%s\n' "$or"
    else
        return 1
    fi
}

# taskdag_normalize_node <node>: validate + canonicalize a node address.
# Prints the canonical node (owner/repo case-folded) or returns non-zero.
#   task:<owner>/<repo>@<40|64 lowercase hex>
#   issue:<owner>/<repo>#<decimal, no leading zero, > 0>
taskdag_normalize_node() {
    local node="$1" kind rest or ref cor
    case "$node" in
        task:*) kind=task; rest="${node#task:}" ;;
        issue:*) kind=issue; rest="${node#issue:}" ;;
        *) return 1 ;;
    esac
    case "$kind" in
        task)
            or="${rest%@*}"; ref="${rest##*@}"
            [ "$or" != "$rest" ] || return 1       # required '@'
            ref=$(printf '%s' "$ref" | tr '[:upper:]' '[:lower:]')
            [[ "$ref" =~ ^[0-9a-f]{40}$|^[0-9a-f]{64}$ ]] || return 1
            cor=$(taskdag_norm_owner_repo "$or") || return 1
            printf 'task:%s@%s\n' "$cor" "$ref"
            ;;
        issue)
            or="${rest%#*}"; ref="${rest##*#}"
            [ "$or" != "$rest" ] || return 1       # required '#'
            [[ "$ref" =~ ^[1-9][0-9]*$ ]] || return 1
            cor=$(taskdag_norm_owner_repo "$or") || return 1
            printf 'issue:%s#%s\n' "$cor" "$ref"
            ;;
    esac
}

# taskdag_relation_mode_ok <relation> <mode>: 0 iff the pair is a permitted
# combination (requires⇒all, satisfies⇒any). OR-deps are out of scope.
taskdag_relation_mode_ok() {
    case "$1/$2" in
        requires/all|satisfies/any) return 0 ;;
        *) return 1 ;;
    esac
}

# taskdag_edge_id <from> <to> <relation> <mode>: print the SEMANTIC edge-id
# (full sha256 hex) of the canonical (from,to,relation,mode) tuple. Inputs
# are canonicalized + validated first, so callers get a stable id regardless
# of owner/repo casing or a mixed-case task SHA. Returns non-zero on any
# malformed input or disallowed relation/mode pair (never a bogus id).
#
# NOTE: the tuple is streamed NUL-delimited straight to the hasher — a bash
# variable cannot hold NUL, so the delimiter can never collide with input.
taskdag_edge_id() {
    local from to relation="$3" mode="$4"
    from=$(taskdag_normalize_node "$1") || { echo "Error: invalid 'from' node: $1" >&2; return 1; }
    to=$(taskdag_normalize_node "$2")   || { echo "Error: invalid 'to' node: $2" >&2; return 1; }
    taskdag_relation_mode_ok "$relation" "$mode" || {
        echo "Error: invalid relation/mode pair: ${relation}/${mode} (allowed: requires/all, satisfies/any)" >&2
        return 1
    }
    printf '%s\0%s\0%s\0%s' "$from" "$to" "$relation" "$mode" | taskdag_sha256_hex
}

# taskdag_edge_blob <from> <to> <relation> <mode> <repo-id> <witness>:
# emit the canonical schema:1 edge blob JSON on stdout (compact, via jq).
# All fields are validated/canonicalized; a malformed input fails loud so a
# corrupt edge can never be serialized. This is the serializer the writer
# sibling reuses — the READER round-trips against it in tests.
taskdag_edge_blob() {
    local from to relation="$3" mode="$4" repo_id="$5" witness="$6"
    from=$(taskdag_normalize_node "$1") || { echo "Error: invalid 'from' node: $1" >&2; return 1; }
    to=$(taskdag_normalize_node "$2")   || { echo "Error: invalid 'to' node: $2" >&2; return 1; }
    taskdag_relation_mode_ok "$relation" "$mode" || {
        echo "Error: invalid relation/mode pair: ${relation}/${mode}" >&2
        return 1
    }
    [[ "$repo_id" =~ ^[1-9][0-9]*$ ]] || { echo "Error: origin.repo-id must be a positive integer: $repo_id" >&2; return 1; }
    [ -n "$witness" ] || { echo "Error: origin.witness must be non-empty" >&2; return 1; }
    command -v jq >/dev/null 2>&1 || { echo "Error: jq is required to emit an edge blob" >&2; return 1; }
    jq -nc \
        --arg from "$from" --arg to "$to" \
        --arg relation "$relation" --arg mode "$mode" \
        --argjson repoid "$repo_id" --arg witness "$witness" \
        '{schema:1, from:$from, to:$to, relation:$relation, mode:$mode,
          origin:{"repo-id":$repoid, witness:$witness}}'
}

# taskdag_tombstone_blob <from> <to> <relation> <mode> <repo-id> <witness>:
# emit the canonical schema:1 TOMBSTONE blob JSON on stdout (compact, via jq).
# Identical to an edge blob plus the discriminant `"tombstone":true`, so the
# reader can tell a tombstone from an edge by content as well as by path. The
# `origin.witness` is the REMOVAL witness (why/what removed the edge), not the
# original edge's provenance. All fields are validated/canonicalized; a
# malformed input fails loud so a corrupt tombstone can never be serialized.
# The semantic edge-id of a tombstone is that of the edge it removes
# (taskdag_edge_id from,to,relation,mode) — origin is excluded from the id,
# so a re-tombstone with a different witness is idempotent on the same path.
taskdag_tombstone_blob() {
    local from to relation="$3" mode="$4" repo_id="$5" witness="$6"
    from=$(taskdag_normalize_node "$1") || { echo "Error: invalid 'from' node: $1" >&2; return 1; }
    to=$(taskdag_normalize_node "$2")   || { echo "Error: invalid 'to' node: $2" >&2; return 1; }
    taskdag_relation_mode_ok "$relation" "$mode" || {
        echo "Error: invalid relation/mode pair: ${relation}/${mode}" >&2
        return 1
    }
    [[ "$repo_id" =~ ^[1-9][0-9]*$ ]] || { echo "Error: origin.repo-id must be a positive integer: $repo_id" >&2; return 1; }
    [ -n "$witness" ] || { echo "Error: origin.witness must be non-empty" >&2; return 1; }
    command -v jq >/dev/null 2>&1 || { echo "Error: jq is required to emit a tombstone blob" >&2; return 1; }
    jq -nc \
        --arg from "$from" --arg to "$to" \
        --arg relation "$relation" --arg mode "$mode" \
        --argjson repoid "$repo_id" --arg witness "$witness" \
        '{schema:1, tombstone:true, from:$from, to:$to, relation:$relation, mode:$mode,
          origin:{"repo-id":$repoid, witness:$witness}}'
}

# _taskdag_tombstone_edge_id <blob>: validate a STORED tombstone blob (typed
# schema:1 structure with tombstone==true, fixed relation/mode, canonical
# nodes at rest) and print its recomputed SEMANTIC edge-id. Returns non-zero
# (no output) on any malformation. This is the reader's fail-closed tombstone
# validator (mirrors the edge validation), so a corrupt tombstone can never
# silently mask an edge.
_taskdag_tombstone_edge_id() {
    local blob="$1" jfrom jto jrel jmode cfrom cto
    printf '%s' "$blob" | jq -e '
          (type == "object")
          and (.schema == 1) and ((.schema | type) == "number")
          and (.tombstone == true)
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

# taskdag_repo_config_key <owner/repo>: the git-config name under which a
# repo's stable numeric id override/cache is stored. Uses the whole
# (lowercased) owner/repo as the config SUBSECTION and a fixed `id` key —
# git config keeps middle dots/slashes in the subsection and takes only the
# final `.id` as the key, so `taskdag.<owner>/<repo>.id` is well-formed even
# for names containing dots (e.g. foo.github.io).
taskdag_repo_config_key() {
    local cor
    cor=$(taskdag_norm_owner_repo "$1") || return 1
    printf 'taskdag.%s.id\n' "$cor"
}

# taskdag_repo_numeric_id <owner/repo>: resolve the STABLE numeric GitHub
# repository id (databaseId) — the identity that survives a rename/move, so
# an edge's origin.repo-id is never orphaned by an owner/name change.
#
# Resolution order (READ-ONLY — this reader never writes the cache; an
# explicit cache-writing seam is left to the writer sibling so a read
# command can't surprise-mutate git config):
#   1. git-config override/cache `taskdag.<owner>/<repo>.id` (the offline,
#      deterministic seam the unit tests preseed);
#   2. live `gh api repos/<owner>/<repo> --jq .id`.
# Prints the id; returns non-zero if it cannot be resolved (fail loud — a
# missing repo id must never be papered over).
taskdag_repo_numeric_id() {
    local cor key cached id
    cor=$(taskdag_norm_owner_repo "$1") || { echo "Error: malformed owner/repo: $1" >&2; return 1; }
    key=$(taskdag_repo_config_key "$cor") || return 1
    cached=$(git config --get "$key" 2>/dev/null || true)
    if [ -n "$cached" ]; then
        if [[ "$cached" =~ ^[1-9][0-9]*$ ]]; then
            printf '%s\n' "$cached"; return 0
        fi
        echo "Error: cached repo-id for ${cor} is not a positive integer: ${cached}" >&2
        return 1
    fi
    command -v gh >/dev/null 2>&1 || { echo "Error: cannot resolve repo-id for ${cor}: gh unavailable and no ${key} override set" >&2; return 1; }
    id=$(gh api "repos/${cor}" --jq .id 2>/dev/null || true)
    if [[ "$id" =~ ^[1-9][0-9]*$ ]]; then
        printf '%s\n' "$id"; return 0
    fi
    echo "Error: could not resolve numeric repo-id for ${cor} via gh" >&2
    return 1
}

# taskdag_sync_graph_ref: TRI-STATE sync of the graph index branch from
# origin, so the reader never confuses "no edges yet" with "couldn't reach
# origin" (a false-empty active set would silently break a future resolver).
#   0  -> local refs/heads/tasks/v1/graph is now current (fetched, or origin
#         confirms the ref is ABSENT — in which case the stale local ref, if
#         any, is removed so we don't parse a phantom edge set)
#   2  -> INDETERMINATE: origin unreachable / transport error (fail closed)
taskdag_sync_graph_ref() {
    local lsrc rc
    lsrc=$(git ls-remote --exit-code origin "$TASKDAG_GRAPH_REF" 2>/dev/null); rc=$?
    case "$rc" in
        0)
            git fetch --quiet --no-tags origin "+${TASKDAG_GRAPH_REF}:${TASKDAG_GRAPH_REF}" 2>/dev/null || return 2
            return 0
            ;;
        2)
            # ls-remote --exit-code returns 2 when NO ref matches: origin
            # confirms the graph branch does not exist. Drop any stale local
            # copy so the reader reports a truly empty set, not a phantom.
            git update-ref -d "$TASKDAG_GRAPH_REF" 2>/dev/null || true
            return 0
            ;;
        *)
            return 2
            ;;
    esac
}

# taskdag_read_edges [--no-fetch]: parse the LATEST tree of the graph index
# branch into the active edge set and emit a compact JSON array on stdout
# (deterministically SORTED by edge-id). Each element:
#   { edgeId, schema, from, to, relation, mode, origin:{repo-id, witness} }
#
# Fail-closed for machine use:
#   • default syncs the ref tri-state (see taskdag_sync_graph_ref); an
#     INDETERMINATE sync returns non-zero rather than a false-empty set,
#   • --no-fetch reads whatever local ref exists (empty [] if none — the
#     explicit offline path),
#   • a malformed graph (bad schema, node grammar, relation/mode pair, or a
#     filename whose edge-id does NOT match the recomputed semantic id of its
#     content) returns non-zero — the reader never manufactures a partial
#     "active set" out of corrupt state.
taskdag_read_edges() {
    local do_fetch=true
    while [ $# -gt 0 ]; do
        case "$1" in
            --no-fetch) do_fetch=false; shift ;;
            *) echo "Error: unknown option to taskdag_read_edges: $1" >&2; return 2 ;;
        esac
    done
    command -v jq >/dev/null 2>&1 || { echo "Error: jq is required to read the edge graph" >&2; return 2; }

    if [ "$do_fetch" = true ]; then
        taskdag_sync_graph_ref || { echo "Error: could not sync ${TASKDAG_GRAPH_REF} from origin (indeterminate); refusing to report a possibly-false-empty edge set (use --no-fetch to read the local ref)" >&2; return 2; }
    fi

    # No local graph ref ⇒ empty active set (a legitimate steady state before
    # any edge is ever written).
    if ! git rev-parse --verify -q "${TASKDAG_GRAPH_REF}^{commit}" >/dev/null 2>&1; then
        printf '[]\n'; return 0
    fi

    local mode type obj path base blob recomputed
    local -a objs=() obj_ids=()
    local -A tomb=()
    # Snapshot the tree once. Only regular-file edges/<64hex>.json and
    # tombstones/<64hex>.json blobs are recognised (reject non-blobs,
    # symlinks/executables, and stray paths). We collect edges AND tombstones
    # in one pass and filter at emit time, so a tombstone masks its edge
    # regardless of tree-order. Every edge blob is validated even when it is
    # later masked by a tombstone — a tombstone must never hide corrupt graph
    # content (fail closed).
    while read -r mode type obj path; do
        [ "$type" = blob ] || { echo "Error: ${TASKDAG_GRAPH_REF} tree entry '${path}' is a ${type}, expected a blob" >&2; return 1; }
        [ "$mode" = 100644 ] || { echo "Error: ${TASKDAG_GRAPH_REF} tree entry '${path}' has mode ${mode}, expected a regular file (100644)" >&2; return 1; }

        # ── Tombstones: validate the blob, recompute its edge-id, and record
        #    it as masking that edge. The filename edge-id MUST match.
        case "$path" in
            tombstones/[0-9a-f]*.json)
                base="${path#tombstones/}"; base="${base%.json}"
                [[ "$base" =~ ^[0-9a-f]{64}$ ]] || { echo "Error: ${TASKDAG_GRAPH_REF} tombstone '${path}' has a malformed edge-id" >&2; return 1; }
                blob=$(git cat-file blob "$obj" 2>/dev/null) || { echo "Error: could not read tombstone blob ${path}" >&2; return 1; }
                recomputed=$(_taskdag_tombstone_edge_id "$blob") || { echo "Error: ${TASKDAG_GRAPH_REF} tombstone '${path}' is not a well-formed schema:1 tombstone blob" >&2; return 1; }
                [ "$recomputed" = "$base" ] || { echo "Error: ${TASKDAG_GRAPH_REF} tombstone '${path}' content hashes to ${recomputed} — path/content edge-id mismatch (corrupt tombstone)" >&2; return 1; }
                tomb["$base"]=1
                continue
                ;;
            edges/[0-9a-f]*.json) : ;;
            *) echo "Error: ${TASKDAG_GRAPH_REF} tree has unexpected path '${path}' (only edges/<edge-id>.json and tombstones/<edge-id>.json allowed)" >&2; return 1 ;;
        esac
        base="${path#edges/}"; base="${base%.json}"
        [[ "$base" =~ ^[0-9a-f]{64}$ ]] || { echo "Error: ${TASKDAG_GRAPH_REF} edge blob '${path}' has a malformed edge-id" >&2; return 1; }

        blob=$(git cat-file blob "$obj" 2>/dev/null) || { echo "Error: could not read edge blob ${path}" >&2; return 1; }

        # Typed STRUCTURAL validation FIRST, so `jq -r` extraction below cannot
        # silently coerce a wrong-typed field into a plausible string (e.g.
        # "schema":"1", "repo-id":"42", or a numeric witness). Fail-closed.
        if ! printf '%s' "$blob" | jq -e '
              (type == "object")
              and (.schema == 1) and ((.schema | type) == "number")
              and ((.from | type) == "string") and ((.to | type) == "string")
              and ((.relation | type) == "string") and ((.mode | type) == "string")
              and ((.origin | type) == "object")
              and ((.origin["repo-id"] | type) == "number")
              and (.origin["repo-id"] > 0)
              and (.origin["repo-id"] == (.origin["repo-id"] | floor))
              and ((.origin.witness | type) == "string") and ((.origin.witness | length) > 0)
            ' >/dev/null 2>&1; then
            echo "Error: edge ${path} is not a well-formed schema:1 edge blob (bad/absent schema, field types, or origin)" >&2; return 1
        fi

        local jfrom jto jrel jmode jrepoid jwitness cfrom cto
        jfrom=$(printf '%s' "$blob" | jq -r '.from')
        jto=$(printf '%s' "$blob" | jq -r '.to')
        jrel=$(printf '%s' "$blob" | jq -r '.relation')
        jmode=$(printf '%s' "$blob" | jq -r '.mode')
        jrepoid=$(printf '%s' "$blob" | jq -r '.origin["repo-id"]')
        jwitness=$(printf '%s' "$blob" | jq -r '.origin.witness')

        taskdag_relation_mode_ok "$jrel" "$jmode" || { echo "Error: edge ${path} has invalid relation/mode pair ${jrel}/${jmode}" >&2; return 1; }

        # Nodes must be CANONICAL AT REST: parse them, and reject any blob
        # whose stored node string is not already the canonical form (there is
        # no legacy graph state to preserve — the writer must store canonical).
        cfrom=$(taskdag_normalize_node "$jfrom") || { echo "Error: edge ${path} has a non-parseable 'from' node: ${jfrom}" >&2; return 1; }
        cto=$(taskdag_normalize_node "$jto") || { echo "Error: edge ${path} has a non-parseable 'to' node: ${jto}" >&2; return 1; }
        if [ "$jfrom" != "$cfrom" ] || [ "$jto" != "$cto" ]; then
            echo "Error: edge ${path} contains a non-canonical node address (from=${jfrom} to=${jto})" >&2; return 1
        fi

        # The key corruption detector: the filename edge-id MUST equal the
        # SEMANTIC id recomputed from the blob's own (from,to,relation,mode).
        # This catches a same-path non-identical write (the design's
        # "fail loud" case) and any drift between path and content.
        recomputed=$(taskdag_edge_id "$cfrom" "$cto" "$jrel" "$jmode") || { echo "Error: edge ${path} content is not a canonical node/relation form" >&2; return 1; }
        if [ "$recomputed" != "$base" ]; then
            echo "Error: edge ${path} content hashes to ${recomputed} — path/content edge-id mismatch (corrupt or non-canonical edge)" >&2; return 1
        fi

        # Reserialize canonically (adds edgeId; normalizes field order + node
        # casing) so the emitted array is stable regardless of how the blob
        # was written. We stash the edge-id alongside so a tombstone found
        # LATER in the tree (any order) can still mask this edge at emit time.
        obj_ids+=("$base")
        objs+=("$(jq -nc \
            --arg edgeId "$base" --arg from "$cfrom" --arg to "$cto" \
            --arg relation "$jrel" --arg mode "$jmode" \
            --argjson repoid "$jrepoid" --arg witness "$jwitness" \
            '{edgeId:$edgeId, schema:1, from:$from, to:$to, relation:$relation, mode:$mode,
              origin:{"repo-id":$repoid, witness:$witness}}')")
    done < <(git ls-tree -r "${TASKDAG_GRAPH_REF}" 2>/dev/null)

    # Filter out tombstoned edges (remove-wins): the ACTIVE set is every edge
    # blob whose semantic id is NOT tombstoned. A tombstone with no surviving
    # edge blob (the normal post-drop state) simply masks nothing.
    local -a active=()
    local i
    for i in "${!objs[@]}"; do
        [ -n "${tomb[${obj_ids[$i]}]:-}" ] && continue
        active+=("${objs[$i]}")
    done

    # Emit as one JSON array, sorted by edgeId for deterministic output.
    if [ "${#active[@]}" -eq 0 ]; then
        printf '[]\n'
    else
        printf '%s\n' "${active[@]}" | jq -sc 'sort_by(.edgeId)'
    fi
}

# Command: edges — READ the active dependency-edge set (read-only plumbing).
cmd_edges() {
    local json=false do_fetch=true
    while [ $# -gt 0 ]; do
        case "$1" in
            --json) json=true; shift ;;
            --no-fetch) do_fetch=false; shift ;;
            --help|-h)
                cat <<'EOF'
Usage: task-dag edges [--json] [--no-fetch]

READ (only) the active dependency-edge set from this repo's graph index
branch refs/heads/tasks/v1/graph (issue #13 north-star). The latest tree of
that branch IS the active edge set: content-addressed blobs at
edges/<edge-id>.json, where edge-id is the stable SEMANTIC hash of
(from, to, relation, mode).

This is low-level plumbing for inspecting the raw index. It does NOT compute
readiness, closure, or "why" explanations (that is the separate
`graph --explain` resolver), and it never WRITES the graph (see the separate
dep add/drop writer).

Default: tri-state sync of the graph ref from origin first, so an empty
result means "no edges", never "couldn't reach origin". A malformed graph
(bad schema / node grammar / relation-mode pair, or a filename whose edge-id
does not match its content) is a hard error.

  --json      emit a JSON array of edges (edgeId, schema, from, to,
              relation, mode, origin{repo-id, witness}); sorted by edgeId.
  --no-fetch  read the LOCAL ref only (offline); empty if it does not exist.

Read-only and (with --no-fetch) fully offline. Requires jq.
EOF
                return 0
                ;;
            *) echo "Error: unknown option: $1" >&2; return 2 ;;
        esac
    done

    local args=()
    [ "$do_fetch" = false ] && args+=(--no-fetch)
    local edges_json
    edges_json=$(taskdag_read_edges "${args[@]}") || return 1

    if [ "$json" = true ]; then
        printf '%s\n' "$edges_json"
        return 0
    fi

    # Human table.
    local count
    count=$(printf '%s' "$edges_json" | jq 'length')
    if [ "$count" -eq 0 ]; then
        printf "${BOLD}No active dependency edges${RESET} (%s)\n" "$TASKDAG_GRAPH_REF"
        return 0
    fi
    printf "${BOLD}%-12s %-9s %-5s %-28s %-28s${RESET}\n" "EDGE-ID" "RELATION" "MODE" "FROM" "TO"
    printf '%s\n' "$edges_json" | jq -r \
        '.[] | [(.edgeId[0:12]), .relation, .mode, .from, .to] | @tsv' \
    | while IFS=$'\t' read -r eid rel mode from to; do
        printf "%-12s %-9s %-5s %-28s %-28s\n" "$eid" "$rel" "$mode" "$from" "$to"
    done
}
