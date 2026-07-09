# shellcheck shell=bash
# ═══════════════════════════════════════════════════════════════════════
# task-dag CROSS-REPO MAILBOX (issue #13 north-star, Phase 3)
#
# The mailbox is the cross-repo NOTIFICATION transport for the uniform
# dependency graph. When a node completes in repo A, the repos that hold
# edges pointing AT that node (in repo B) need a HINT to fold in the effect
# on their dependents. The mailbox carries those hints. It is a PERF PATH —
# a trigger, NOT a source of truth: a lost message is re-derived by the
# periodic reconciler backstop from the other repo's `master`. This module
# owns ONLY the transport + the delivery ORDERING contract; the reconciler
# that decides WHAT a completion means and how to fold it (push-reaction
# handler + periodic backstop, local-CAS fold, cascade) is a SEPARATE
# sibling task and is NOT implemented here.
#
# ─────────────────────────────────────────────────────────────────────
# BOUNDED REFS (the key invariant)
#   Exactly 16 FIXED shard branches refs/heads/tasks/v1/mailbox/00 .. /0f.
#   The live mirrored ref count is O(1)=16 regardless of in-flight message
#   count — messages live as blobs IN each shard's tree (msg/<message-id>
#   .json), mirroring the graph index, so per-message cost is a tree blob,
#   NOT a ref. Shard(message-id) = the first hex nibble of the 64-hex id,
#   formatted %02x → 00..0f. Shards are created LAZILY (on first put) and,
#   when their last message is consumed, left as an EMPTY-TREE commit (never
#   a branch deletion — that is not FF-only). An absent shard and an
#   empty-tree shard both read as empty.
#
# MESSAGE (schema:1), CONTENT-ADDRESSED:
#   message-id = sha256 of the NUL-delimited canonical tuple
#     (kind, node, witness, dest) — witness AND dest are part of identity, so
#     a NEW witnessed completion cannot be absorbed by an older in-flight
#     same-node message (and then wrongly deleted), and mis-addressed
#     delivery is caught. origin{} (repo-id + repo) is provenance and is
#     EXCLUDED from the id; unlike an edge, a same-id message with DIFFERENT
#     content is a FAIL-LOUD conflict (short-lived trigger state — conflict
#     means something is wrong), NOT first-writer-wins.
#   Blob at msg/<message-id>.json:
#     { "schema":1, "kind":"completion",
#       "node":"task:owner/repo@sha" | "issue:owner/repo#N",
#       "witness":"<40|64-hex source-completion sha / message-id>",
#       "dest":"owner/repo",
#       "origin":{ "repo-id":<stable numeric id>, "repo":"owner/repo" } }
#
# WRITES = direct FF-only CAS, mirroring the graph writer's loop
#   (_taskdag_graph_cas): fetch shard tip → recompute the shard tree
#   (add/remove one message blob via a scratch index) → FF push
#   --force-with-lease + origin readback → on rejection refetch/recompute/
#   re-push with the SAME bounded quadratic backoff (taskdag_cas_* from
#   edges-write.sh) → FAIL LOUD on retry-budget exhaustion. A shard tree is
#   a commutative idempotent union of message blobs, so contention converges.
#
# ORDERED FOLD-THEN-DELETE (operator-locked decision 4 on issue #13)
#   `mailbox consume` iterates in-flight messages and, PER MESSAGE, runs an
#   INJECTED fold command and deletes that exact message ONLY AFTER the fold
#   returns durable success (exit 0). This is per-message fold-before-delete
#   ordering — NOT FIFO, NOT a total order. There is NO consumed_at / ack /
#   dedup ledger; correctness rides on the fold being IDEMPOTENT (the
#   reconciler's contract) + the backstop re-deriving a lost hint:
#     • crash before fold           → message stays → backstop/retry
#     • fold fails (not ready)      → message stays → retry next cycle
#     • crash after durable fold,
#         before delete             → message redelivered → fold no-ops
#     • delete fails after fold     → message may stay → replay is safe
#   This is AT-LEAST-ONCE delivery, deliberately.
#
# WITNESS TRAILER
#   The fold's effect commit must carry the TRIGGERING witness in a git
#   trailer so durable `master` history carries provenance for debugging.
#   consume exports the message metadata (incl. the witness + message-id) to
#   the fold command via TASKDAG_MAILBOX_* env; the fold stamps the trailer
#   with taskdag_mailbox_witness_trailer.
#
# Relies on the data-model helpers in edges.sh (taskdag_normalize_node,
# taskdag_norm_owner_repo, taskdag_sha256_hex, taskdag_repo_numeric_id), the
# bounded backoff in edges-write.sh (taskdag_cas_* / TASKDAG_CAS_*), the
# current-repo seam in facts.sh (taskdag_current_repo), and EMPTY_TREE /
# colors from the main script.
# ═══════════════════════════════════════════════════════════════════════

: "${EMPTY_TREE:=4b825dc642cb6eb9a060e54bf8d69288fbee4904}"

# taskdag_mailbox_kind_ok <kind>: 0 iff <kind> is a recognised message kind.
# Schema v1 has exactly one kind (a completion hint); an unknown kind fails
# closed so a malformed/forward-dated message can never be minted or read.
taskdag_mailbox_kind_ok() {
    case "$1" in
        completion) return 0 ;;
        *) return 1 ;;
    esac
}

# taskdag_mailbox_witness_ok <witness>: 0 iff <witness> is a lowercase 40- or
# 64-hex string (a git sha1 completion SHA or a sha256 message-id). Tight by
# design: the witness is stamped verbatim into a commit trailer, so rejecting
# anything non-hex forecloses trailer/newline injection and keeps provenance
# machine-parseable.
taskdag_mailbox_witness_ok() {
    [[ "$1" =~ ^[0-9a-f]{40}$|^[0-9a-f]{64}$ ]]
}

# taskdag_mailbox_message_id <kind> <node> <witness> <dest>: print the
# content-addressed message-id (full sha256 hex) of the canonical
# NUL-delimited tuple (kind, node, witness, dest). Inputs are validated +
# canonicalized first, so the id is stable regardless of owner/repo casing.
# Returns non-zero (no output) on any malformed input.
taskdag_mailbox_message_id() {
    local kind="$1" node="$2" witness="$3" dest="$4" cnode cdest
    taskdag_mailbox_kind_ok "$kind" || { echo "Error: invalid mailbox kind: $kind" >&2; return 1; }
    cnode=$(taskdag_normalize_node "$node") || { echo "Error: invalid mailbox node: $node" >&2; return 1; }
    taskdag_mailbox_witness_ok "$witness" || { echo "Error: invalid mailbox witness (need 40|64 lowercase hex): $witness" >&2; return 1; }
    cdest=$(taskdag_norm_owner_repo "$dest") || { echo "Error: invalid mailbox dest owner/repo: $dest" >&2; return 1; }
    printf '%s\0%s\0%s\0%s' "$kind" "$cnode" "$witness" "$cdest" | taskdag_sha256_hex
}

# taskdag_mailbox_shard_for <message-id>: print the shard name (00..0f) for a
# 64-hex message-id — the first hex nibble, formatted %02x. 16 shards total.
taskdag_mailbox_shard_for() {
    local mid="$1"
    [[ "$mid" =~ ^[0-9a-f]{64}$ ]] || { echo "Error: bad message-id for shard derivation: $mid" >&2; return 1; }
    printf '%02x\n' "$((16#${mid:0:1}))"
}

# taskdag_mailbox_shard_ref <shard>: print the fully-qualified shard ref for a
# shard name (00..0f). Rejects anything outside the fixed 16-shard set.
taskdag_mailbox_shard_ref() {
    local shard="$1"
    [[ "$shard" =~ ^0[0-9a-f]$ ]] || { echo "Error: invalid mailbox shard (expected 00..0f): $shard" >&2; return 1; }
    printf 'refs/heads/tasks/v1/mailbox/%s\n' "$shard"
}

# taskdag_mailbox_blob <kind> <node> <witness> <dest> <origin-repo> <repo-id>:
# emit the canonical schema:1 message blob JSON (compact, via jq). All fields
# are validated/canonicalized; for a `completion` message the completed node
# MUST live in the origin repo (the completion happened there). A malformed
# input fails loud so a corrupt message can never be serialized.
taskdag_mailbox_blob() {
    local kind="$1" node="$2" witness="$3" dest="$4" origin_repo="$5" repo_id="$6"
    local cnode cdest corepo nrepo
    taskdag_mailbox_kind_ok "$kind" || { echo "Error: invalid mailbox kind: $kind" >&2; return 1; }
    cnode=$(taskdag_normalize_node "$node") || { echo "Error: invalid mailbox node: $node" >&2; return 1; }
    taskdag_mailbox_witness_ok "$witness" || { echo "Error: invalid mailbox witness (need 40|64 lowercase hex): $witness" >&2; return 1; }
    cdest=$(taskdag_norm_owner_repo "$dest") || { echo "Error: invalid mailbox dest owner/repo: $dest" >&2; return 1; }
    corepo=$(taskdag_norm_owner_repo "$origin_repo") || { echo "Error: invalid mailbox origin owner/repo: $origin_repo" >&2; return 1; }
    [[ "$repo_id" =~ ^[1-9][0-9]*$ ]] || { echo "Error: origin.repo-id must be a positive integer: $repo_id" >&2; return 1; }
    nrepo="${cnode#*:}"; nrepo="${nrepo%%@*}"; nrepo="${nrepo%%#*}"
    if [ "$kind" = completion ] && [ "$nrepo" != "$corepo" ]; then
        echo "Error: completion node repo (${nrepo}) must equal origin repo (${corepo})" >&2; return 1
    fi
    command -v jq >/dev/null 2>&1 || { echo "Error: jq is required to emit a mailbox message" >&2; return 1; }
    jq -nc \
        --arg kind "$kind" --arg node "$cnode" --arg witness "$witness" \
        --arg dest "$cdest" --arg orepo "$corepo" --argjson repoid "$repo_id" \
        '{schema:1, kind:$kind, node:$node, witness:$witness, dest:$dest,
          origin:{"repo-id":$repoid, repo:$orepo}}'
}

# _taskdag_mailbox_blob_check <blob>: validate a STORED message blob exactly as
# the reader does (typed schema:1 structure, known kind, hex witness, canonical
# node/dest/origin at rest, and — for completion — node-repo == origin-repo) and
# print its recomputed message-id. Returns non-zero (no output) on any
# malformation. Used by the reader AND by an "already present" no-op put so it
# can never silently succeed over a CORRUPT existing message blob.
_taskdag_mailbox_blob_check() {
    local blob="$1" jkind jnode jwitness jdest jorepo cnode cdest corepo nrepo
    printf '%s' "$blob" | jq -e '
          (type == "object")
          and (.schema == 1) and ((.schema | type) == "number")
          and ((.kind | type) == "string")
          and ((.node | type) == "string")
          and ((.witness | type) == "string")
          and ((.dest | type) == "string")
          and ((.origin | type) == "object")
          and ((.origin["repo-id"] | type) == "number")
          and (.origin["repo-id"] > 0)
          and (.origin["repo-id"] == (.origin["repo-id"] | floor))
          and ((.origin.repo | type) == "string") and ((.origin.repo | length) > 0)
        ' >/dev/null 2>&1 || return 1
    jkind=$(printf '%s' "$blob" | jq -r '.kind')
    jnode=$(printf '%s' "$blob" | jq -r '.node')
    jwitness=$(printf '%s' "$blob" | jq -r '.witness')
    jdest=$(printf '%s' "$blob" | jq -r '.dest')
    jorepo=$(printf '%s' "$blob" | jq -r '.origin.repo')
    taskdag_mailbox_kind_ok "$jkind" || return 1
    taskdag_mailbox_witness_ok "$jwitness" || return 1
    cnode=$(taskdag_normalize_node "$jnode") || return 1
    cdest=$(taskdag_norm_owner_repo "$jdest") || return 1
    corepo=$(taskdag_norm_owner_repo "$jorepo") || return 1
    [ "$jnode" = "$cnode" ] && [ "$jdest" = "$cdest" ] && [ "$jorepo" = "$corepo" ] || return 1
    if [ "$jkind" = completion ]; then
        nrepo="${cnode#*:}"; nrepo="${nrepo%%@*}"; nrepo="${nrepo%%#*}"
        [ "$nrepo" = "$corepo" ] || return 1
    fi
    taskdag_mailbox_message_id "$jkind" "$cnode" "$jwitness" "$cdest"
}

# taskdag_mailbox_witness_trailer <witness> <message-id>: print the two git
# trailer lines the fold's effect commit must carry so durable `master`
# history records WHAT triggered the effect (decision 4). Pure plumbing —
# it does not imply the mailbox owns effect commits; the reconciler's fold
# appends these to the commit it builds.
taskdag_mailbox_witness_trailer() {
    local witness="$1" mid="$2"
    taskdag_mailbox_witness_ok "$witness" || { echo "Error: invalid witness for trailer (need 40|64 lowercase hex): $witness" >&2; return 1; }
    [[ "$mid" =~ ^[0-9a-f]{64}$ ]] || { echo "Error: invalid message-id for trailer: $mid" >&2; return 1; }
    printf 'Mailbox-Witness: %s\nMailbox-Message-Id: %s\n' "$witness" "$mid"
}

# taskdag_remote_owner_repo <remote>: resolve the canonical (lowercased)
# owner/repo a git remote points at, so `mailbox put --dest X` can verify it
# is actually writing to X (never silently to whatever `origin` happens to
# be). Resolution order (offline seams first, so tests never need a network
# or a real GitHub URL):
#   1. git-config override taskdag.remote-repo.<remote>  (explicit / test seam)
#   2. remote == origin  → the current repo (taskdag_current_repo seam)
#   3. parse an ssh/https GitHub URL (git@host:owner/repo / https://host/owner/repo)
# A filesystem-path remote with no override is NOT resolvable (returns 1) —
# a mis-addressed cross-repo delivery must fail loud, not guess.
taskdag_remote_owner_repo() {
    local remote="$1" override raw
    override=$(git config --get "taskdag.remote-repo.${remote}" 2>/dev/null || true)
    if [ -n "$override" ]; then
        taskdag_norm_owner_repo "$override"; return
    fi
    if [ "$remote" = origin ]; then
        taskdag_current_repo && return 0
    fi
    raw=$(git config --get "remote.${remote}.url" 2>/dev/null || true)
    [ -n "$raw" ] || raw="$remote"
    raw="${raw%.git}"
    case "$raw" in
        *@*:*) raw="${raw#*:}" ;;
        *://*) raw="${raw#*://}"; raw="${raw#*/}" ;;
        *) return 1 ;;
    esac
    taskdag_norm_owner_repo "$raw"
}

# taskdag_mailbox_sync_shard <remote> <shard>: TRI-STATE sync of ONE shard
# ref from <remote>, mirroring taskdag_sync_graph_ref so a writer never
# CASes against a false-empty shard:
#   0 -> local shard ref is current (fetched, or the remote confirms it is
#        ABSENT — the stale local copy, if any, is dropped)
#   2 -> INDETERMINATE: remote unreachable / transport error (fail closed)
taskdag_mailbox_sync_shard() {
    local remote="$1" shard="$2" ref rc
    ref=$(taskdag_mailbox_shard_ref "$shard") || return 2
    git ls-remote --exit-code "$remote" "$ref" >/dev/null 2>&1; rc=$?
    case "$rc" in
        0)
            git fetch --quiet --no-tags "$remote" "+${ref}:${ref}" 2>/dev/null || return 2
            return 0
            ;;
        2)
            git update-ref -d "$ref" 2>/dev/null || true
            return 0
            ;;
        *)
            return 2
            ;;
    esac
}

# taskdag_mailbox_sync_all <remote>: sync ALL shard refs from <remote> in one
# fetch, pruning local shards the remote no longer has (consumed-to-gone),
# so a reader/consumer sees the authoritative in-flight set. Returns 0 on a
# successful sync (including "remote has zero shards"), 2 on a transport
# error (fail closed).
taskdag_mailbox_sync_all() {
    local remote="${1:-origin}"
    git fetch --quiet --no-tags --prune "$remote" \
        '+refs/heads/tasks/v1/mailbox/*:refs/heads/tasks/v1/mailbox/*' 2>/dev/null || return 2
    return 0
}

# taskdag_mailbox_read [--no-fetch] [--remote <r>] [--shard <00..0f>]:
# parse the latest tree of each mailbox shard into the in-flight message set
# and emit a compact JSON array, deterministically SORTED by (shard,
# messageId). Each element:
#   { messageId, shard, schema, kind, node, witness, dest, origin:{repo-id, repo} }
# Fail-closed for machine use: default syncs the shards (INDETERMINATE → non-zero,
# never a false-empty set); --no-fetch reads local refs only; a malformed message
# (bad schema, node grammar, witness, or a filename whose message-id does NOT
# match the recomputed id of its content) returns non-zero — never a partial set.
taskdag_mailbox_read() {
    local do_fetch=true remote=origin only_shard=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --no-fetch) do_fetch=false; shift ;;
            --remote) [ $# -ge 2 ] || { echo "Error: --remote requires a value" >&2; return 2; }; remote="$2"; shift 2 ;;
            --shard) [ $# -ge 2 ] || { echo "Error: --shard requires a value" >&2; return 2; }; only_shard="$2"; shift 2 ;;
            *) echo "Error: unknown option to taskdag_mailbox_read: $1" >&2; return 2 ;;
        esac
    done
    command -v jq >/dev/null 2>&1 || { echo "Error: jq is required to read the mailbox" >&2; return 2; }
    if [ -n "$only_shard" ] && ! [[ "$only_shard" =~ ^0[0-9a-f]$ ]]; then
        echo "Error: --shard must be one of 00..0f (got: $only_shard)" >&2; return 2
    fi

    if [ "$do_fetch" = true ]; then
        taskdag_mailbox_sync_all "$remote" || { echo "Error: could not sync mailbox shards from ${remote} (indeterminate); refusing to report a possibly-false-empty set (use --no-fetch for the local view)" >&2; return 2; }
    fi

    local -a objs=()
    local ref shard mode type obj path base blob recomputed
    while read -r ref; do
        [ -n "$ref" ] || continue
        shard="${ref##*/}"
        [[ "$shard" =~ ^0[0-9a-f]$ ]] || continue          # ignore any non-canonical local shard
        [ -n "$only_shard" ] && [ "$shard" != "$only_shard" ] && continue
        while read -r mode type obj path; do
            [ -n "$type" ] || continue
            [ "$type" = blob ] || { echo "Error: mailbox shard ${shard} entry '${path}' is a ${type}, expected a blob" >&2; return 1; }
            [ "$mode" = 100644 ] || { echo "Error: mailbox shard ${shard} entry '${path}' has mode ${mode}, expected a regular file (100644)" >&2; return 1; }
            case "$path" in
                msg/[0-9a-f]*.json) : ;;
                *) echo "Error: mailbox shard ${shard} has unexpected path '${path}' (only msg/<message-id>.json allowed)" >&2; return 1 ;;
            esac
            base="${path#msg/}"; base="${base%.json}"
            [[ "$base" =~ ^[0-9a-f]{64}$ ]] || { echo "Error: mailbox shard ${shard} message '${path}' has a malformed message-id" >&2; return 1; }
            # Correct-shard invariant: a message must live in the shard its id
            # derives to (a mis-sharded blob is corruption).
            local want_shard
            want_shard=$(taskdag_mailbox_shard_for "$base") || return 1
            [ "$want_shard" = "$shard" ] || { echo "Error: message ${base} is in shard ${shard} but derives to ${want_shard}" >&2; return 1; }

            blob=$(git cat-file blob "$obj" 2>/dev/null) || { echo "Error: could not read mailbox message ${path}" >&2; return 1; }
            recomputed=$(_taskdag_mailbox_blob_check "$blob") || { echo "Error: mailbox message ${path} is not a well-formed schema:1 message" >&2; return 1; }
            [ "$recomputed" = "$base" ] || { echo "Error: mailbox message ${path} content hashes to ${recomputed} — path/content id mismatch (corrupt message)" >&2; return 1; }

            local jkind jnode jwitness jdest jrepoid jorepo
            jkind=$(printf '%s' "$blob" | jq -r '.kind')
            jnode=$(printf '%s' "$blob" | jq -r '.node')
            jwitness=$(printf '%s' "$blob" | jq -r '.witness')
            jdest=$(printf '%s' "$blob" | jq -r '.dest')
            jrepoid=$(printf '%s' "$blob" | jq -r '.origin["repo-id"]')
            jorepo=$(printf '%s' "$blob" | jq -r '.origin.repo')
            objs+=("$(jq -nc \
                --arg messageId "$base" --arg shard "$shard" \
                --arg kind "$jkind" --arg node "$jnode" --arg witness "$jwitness" \
                --arg dest "$jdest" --argjson repoid "$jrepoid" --arg orepo "$jorepo" \
                '{messageId:$messageId, shard:$shard, schema:1, kind:$kind, node:$node,
                  witness:$witness, dest:$dest, origin:{"repo-id":$repoid, repo:$orepo}}')")
        done < <(git ls-tree -r "$ref" 2>/dev/null)
    done < <(git for-each-ref --format='%(refname)' 'refs/heads/tasks/v1/mailbox/*' 2>/dev/null)

    if [ "${#objs[@]}" -eq 0 ]; then
        printf '[]\n'
    else
        printf '%s\n' "${objs[@]}" | jq -sc 'sort_by([.shard, .messageId])'
    fi
}

# _taskdag_mailbox_recompute_tree <old-commit-or-empty> <op> <path> [<blobsha>]:
# recompute a shard tree by applying ONE idempotent op (add|remove) to the
# tree of <old> (empty ⇒ start from an empty tree). Prints the new tree oid.
# Uses a scoped SCRATCH index so GIT_INDEX_FILE never leaks. add is idempotent
# on the semantic path; unlike an edge, an "already present" add over a
# message with DIFFERENT canonical content is a FAIL-LOUD conflict (a message
# is short-lived trigger state — a same-id/different-content collision means
# something is wrong).
#
# remove is CONDITIONAL on the EXACT blob that was folded: <blobsha> is the oid
# of the message consume actually read + folded. If the path is present but its
# stored blob oid differs from <blobsha>, the message at that path is NOT the
# one we folded (a same-id message was re-enqueued with different content
# between our read and our delete — possible because origin{} is excluded from
# the id). We then FAIL LOUD and leave it, rather than silently delete a
# message that was never folded. An empty <blobsha> (no expectation) is only
# used where a plain path deletion is intended — consume always passes it.
_taskdag_mailbox_recompute_tree() {
    local old="$1" op="$2" path="$3" blobsha="${4:-}"
    local gitdir idx tree
    gitdir=$(git rev-parse --git-dir) || return 1
    idx="${gitdir}/.taskdag-mailbox-cas.$$.index"
    rm -f "$idx"
    tree=$(
        export GIT_INDEX_FILE="$idx"
        if [ -n "$old" ]; then
            git read-tree "${old}^{tree}" || exit 1
        fi
        case "$op" in
            add)
                if git ls-files --cached --error-unmatch "$path" >/dev/null 2>&1; then
                    existing=$(git cat-file blob ":${path}") || { echo "Error: could not read existing mailbox message ${path}" >&2; exit 1; }
                    mbase="${path#msg/}"; mbase="${mbase%.json}"
                    recomputed=$(_taskdag_mailbox_blob_check "$existing") || {
                        echo "Error: existing mailbox message ${path} is corrupt / non-canonical; refusing to report a no-op put" >&2; exit 1
                    }
                    [ "$recomputed" = "$mbase" ] || {
                        echo "Error: existing mailbox message ${path} content hashes to ${recomputed} (path/content mismatch); refusing to report a no-op put" >&2; exit 1
                    }
                    newcanon=$(git cat-file blob "$blobsha" | jq -Sc .) || exit 1
                    oldcanon=$(printf '%s' "$existing" | jq -Sc .) || exit 1
                    [ "$newcanon" = "$oldcanon" ] || {
                        echo "Error: mailbox message ${path} already present with DIFFERENT content (conflicting origin?) — refusing to overwrite a same-id message" >&2; exit 1
                    }
                    : # valid + identical → idempotent no-op
                else
                    git update-index --add --cacheinfo "100644,${blobsha},${path}" || exit 1
                fi
                ;;
            remove)
                # Conditional delete: if the message is still present, it MUST
                # be byte-identical to the blob we folded (blobsha). Otherwise a
                # same-id message was re-enqueued with different content between
                # our read+fold and this delete — refuse to delete the message
                # we never folded (fail loud; the next cycle re-reads + re-folds
                # the new content). An absent path is a plain idempotent no-op.
                if git ls-files --cached --error-unmatch "$path" >/dev/null 2>&1; then
                    if [ -n "$blobsha" ]; then
                        cur=$(git rev-parse ":${path}") || { echo "Error: could not read mailbox message ${path} for conditional delete" >&2; exit 1; }
                        [ "$cur" = "$blobsha" ] || {
                            echo "Error: mailbox message ${path} changed since it was folded (folded ${blobsha:0:12}, now ${cur:0:12}); refusing to delete a message that was not the one folded" >&2; exit 1
                        }
                    fi
                    git update-index --force-remove "$path" || exit 1
                fi
                ;;
            *) echo "Error: unknown mailbox op: $op" >&2; exit 1 ;;
        esac
        git write-tree
    )
    local rc=$?
    rm -f "$idx"
    [ "$rc" -eq 0 ] || return 1
    printf '%s\n' "$tree"
}

# _taskdag_mailbox_cas <op> <remote> <shard> <path> <blobsha-or-empty> <msg>:
# the FF-only direct-CAS core for a single shard, mirroring _taskdag_graph_cas
# but parametrized by <remote> + <shard> (put targets the DEST repo's remote;
# consume-delete targets the current repo's origin). Returns:
#   0  applied (pushed + readback-confirmed)
#   2  already in the desired state (idempotent no-op — nothing to push)
#   1  failed loud (retry budget exhausted, transport error, or corruption)
_taskdag_mailbox_cas() {
    local op="$1" remote="$2" shard="$3" path="$4" blobsha="$5" msg="$6"
    local ref attempt=0 old oldtree newtree newcommit push_output lease readback
    ref=$(taskdag_mailbox_shard_ref "$shard") || return 1

    while :; do
        if ! taskdag_mailbox_sync_shard "$remote" "$shard"; then
            attempt=$(( attempt + 1 ))
            if [ "$attempt" -gt "$TASKDAG_CAS_MAX_ATTEMPTS" ]; then
                echo "Error: could not sync ${ref} from ${remote} after ${TASKDAG_CAS_MAX_ATTEMPTS} attempts (indeterminate transport) — failing loud rather than spin" >&2
                return 1
            fi
            taskdag_cas_sleep "$attempt" || return 1
            continue
        fi

        old=$(git rev-parse --verify -q "${ref}^{commit}" 2>/dev/null || true)
        if [ -n "$old" ]; then
            oldtree=$(git rev-parse --verify -q "${old}^{tree}") || return 1
        else
            oldtree="$EMPTY_TREE"
        fi
        newtree=$(_taskdag_mailbox_recompute_tree "$old" "$op" "$path" "$blobsha") || {
            echo "Error: failed to recompute ${ref} tree" >&2; return 1
        }

        if [ "$newtree" = "$oldtree" ]; then
            return 2
        fi

        if [ -n "$old" ]; then
            newcommit=$(printf '%s' "$msg" | git commit-tree "$newtree" -p "$old") || {
                echo "Error: failed to build ${ref} commit" >&2; return 1
            }
        else
            newcommit=$(printf '%s' "$msg" | git commit-tree "$newtree") || {
                echo "Error: failed to build ${ref} commit" >&2; return 1
            }
        fi

        lease="--force-with-lease=${ref}:${old}"
        if push_output=$(git push --atomic "$remote" "$lease" "${newcommit}:${ref}" 2>&1); then
            readback=$(git ls-remote "$remote" "$ref" 2>/dev/null | awk '{print $1}')
            if [ -z "$readback" ]; then
                echo "Error: ${ref} push reported success but ${remote} readback was unreachable; could not confirm" >&2
                return 1
            fi
            if [ "$readback" != "$newcommit" ]; then
                attempt=$(( attempt + 1 ))
                if [ "$attempt" -gt "$TASKDAG_CAS_MAX_ATTEMPTS" ]; then
                    echo "Error: ${ref} CAS lost to concurrent writers and exhausted ${TASKDAG_CAS_MAX_ATTEMPTS} attempts — failing loud rather than spin" >&2
                    return 1
                fi
                taskdag_cas_sleep "$attempt" || return 1
                continue
            fi
            git update-ref "$ref" "$newcommit" 2>/dev/null \
                || echo "Warning: ${remote} updated but local mirror of ${ref} failed" >&2
            return 0
        fi

        if echo "$push_output" | grep -qiE 'rejected|stale info|non-fast-forward|fetch first|force-with-lease'; then
            attempt=$(( attempt + 1 ))
            if [ "$attempt" -gt "$TASKDAG_CAS_MAX_ATTEMPTS" ]; then
                echo "Error: ${ref} FF-CAS exhausted ${TASKDAG_CAS_MAX_ATTEMPTS} retry attempts under contention — failing loud rather than spin" >&2
                echo "$push_output" >&2
                return 1
            fi
            taskdag_cas_sleep "$attempt" || return 1
            continue
        fi

        echo "Error: ${ref} push failed (transport / non-race):" >&2
        echo "$push_output" >&2
        return 1
    done
}

# taskdag_mailbox_put <kind> <node> <witness> <dest> <origin-repo> <repo-id>
#                     [<remote>] [<reason>]:
# enqueue (idempotently) a message into the DEST repo's mailbox shard via the
# FF-only direct CAS. Returns 0 on success (enqueued or already present), 1 on
# a loud failure.
taskdag_mailbox_put() {
    local kind="$1" node="$2" witness="$3" dest="$4" origin_repo="$5" repo_id="$6"
    local remote="${7:-origin}" reason="${8:-}"
    local mid shard blob blobsha path msg rc cnode
    mid=$(taskdag_mailbox_message_id "$kind" "$node" "$witness" "$dest") || return 1
    shard=$(taskdag_mailbox_shard_for "$mid") || return 1
    blob=$(taskdag_mailbox_blob "$kind" "$node" "$witness" "$dest" "$origin_repo" "$repo_id") || return 1
    blobsha=$(printf '%s' "$blob" | git hash-object -w --stdin) || { echo "Error: could not hash mailbox message blob" >&2; return 1; }
    cnode=$(taskdag_normalize_node "$node") || return 1
    path="msg/${mid}.json"
    msg="Enqueue mailbox message ${mid:0:12}: ${kind} ${cnode} → ${dest}

Message-Id: ${mid}
Kind: ${kind}
Node: ${cnode}
Witness: ${witness}
Dest: ${dest}
Origin-Repo: ${origin_repo}
Origin-Repo-Id: ${repo_id}"
    [ -n "$reason" ] && msg="${msg}
Reason: ${reason}"

    rc=0; _taskdag_mailbox_cas add "$remote" "$shard" "$path" "$blobsha" "$msg" || rc=$?
    case "$rc" in
        0) printf "${GREEN}✓ Enqueued message %s${RESET} (%s %s → %s, shard %s)\n" "${mid:0:12}" "$kind" "$cnode" "$dest" "$shard" ;;
        2) printf "${BLUE}• Message %s already enqueued${RESET} (idempotent no-op)\n" "${mid:0:12}"; return 0 ;;
        *) return 1 ;;
    esac
}

# Command: mailbox — cross-repo notification transport (issue #13 Phase 3).
cmd_mailbox() {
    local sub="${1:-}"
    [ $# -gt 0 ] && shift
    case "$sub" in
        put) _cmd_mailbox_put "$@" ;;
        list) _cmd_mailbox_list "$@" ;;
        consume) _cmd_mailbox_consume "$@" ;;
        ""|--help|-h)
            cat <<'EOF'
Usage:
  task-dag mailbox put --node <node> --witness <40|64-hex> --dest <owner/repo>
                       [--kind completion] [--remote <name|url>]
                       [--origin-repo <owner/repo>] [--repo-id <n>] [--reason "..."]
  task-dag mailbox list [--json] [--shard <00..0f>] [--remote <name>] [--no-fetch]
  task-dag mailbox consume --fold-cmd <cmd> [--dest <owner/repo>]
                           [--remote <name>] [--no-fetch] [--dry-run]

Cross-repo NOTIFICATION transport for the north-star dependency graph
(issue #13 Phase 3). A message is a TRIGGER (a hint that a node completed),
NOT a fact — a lost message is re-derived by the periodic reconciler backstop
from the other repo's master.

Bounded refs: exactly 16 fixed shard branches refs/heads/tasks/v1/mailbox/00
..0f carry messages as in-tree blobs (msg/<message-id>.json), so the live
mirrored ref count stays O(1) regardless of in-flight message count.

put     enqueue a message into the DEST repo's mailbox via a direct FF-only
        CAS (same push CAS a completion merge uses). message-id is the sha256
        of (kind,node,witness,dest), so a re-enqueue is idempotent; a same-id
        message with DIFFERENT content fails loud. --dest MUST match the repo
        the target remote points at (default remote: origin). --origin-repo /
        --repo-id default from the node's repo. Witness is a 40|64-hex source
        completion SHA / message-id.
list    read the in-flight message set (all shards, or one --shard), sorted.
consume ORDERED fold-then-delete: for each in-flight message addressed to
        this repo (--dest, default: current repo), run --fold-cmd with the
        message metadata in TASKDAG_MAILBOX_* env and delete the message ONLY
        AFTER the fold exits 0 (durably folded). Fold failure leaves the
        message for retry. --dry-run lists what would be consumed without
        folding/deleting. The fold MUST be idempotent (delivery is
        at-least-once); its effect commit should stamp the witness trailer
        (see taskdag_mailbox_witness_trailer).

Nodes:  task:<owner>/<repo>@<40|64-hex>   issue:<owner>/<repo>#<N>
Requires jq + git.
EOF
            return 0
            ;;
        *) echo "Error: unknown 'mailbox' subcommand: $sub (expected put|list|consume)" >&2; return 2 ;;
    esac
}

_cmd_mailbox_put() {
    local kind="completion" node="" witness="" dest="" remote="origin"
    local origin_repo="" repo_id="" reason=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --kind|--node|--witness|--dest|--remote|--origin-repo|--repo-id|--reason)
                [ $# -ge 2 ] || { echo "Error: $1 requires a value" >&2; return 2; } ;;
        esac
        case "$1" in
            --kind) kind="$2"; shift 2 ;;
            --node) node="$2"; shift 2 ;;
            --witness) witness="$2"; shift 2 ;;
            --dest) dest="$2"; shift 2 ;;
            --remote) remote="$2"; shift 2 ;;
            --origin-repo) origin_repo="$2"; shift 2 ;;
            --repo-id) repo_id="$2"; shift 2 ;;
            --reason) reason="$2"; shift 2 ;;
            --help|-h) cmd_mailbox --help; return 0 ;;
            *) echo "Error: unknown option to 'mailbox put': $1" >&2; return 2 ;;
        esac
    done
    [ -n "$node" ]    || { echo "Error: mailbox put requires --node" >&2; return 2; }
    [ -n "$witness" ] || { echo "Error: mailbox put requires --witness" >&2; return 2; }
    [ -n "$dest" ]    || { echo "Error: mailbox put requires --dest" >&2; return 2; }

    local cnode node_repo cdest
    cnode=$(taskdag_normalize_node "$node") || { echo "Error: invalid --node: $node" >&2; return 2; }
    cdest=$(taskdag_norm_owner_repo "$dest") || { echo "Error: invalid --dest owner/repo: $dest" >&2; return 2; }
    node_repo="${cnode#*:}"; node_repo="${node_repo%%@*}"; node_repo="${node_repo%%#*}"

    # For a completion message the completed node lives in the origin repo, so
    # origin-repo defaults from the node's repo.
    if [ -z "$origin_repo" ]; then origin_repo="$node_repo"; fi
    local corepo
    corepo=$(taskdag_norm_owner_repo "$origin_repo") || { echo "Error: invalid --origin-repo: $origin_repo" >&2; return 2; }

    # Target-repo guard: never silently write to whatever the remote happens
    # to be. --dest MUST equal the repo the target remote points at.
    local target
    target=$(taskdag_remote_owner_repo "$remote") || {
        echo "Error: cannot resolve which repo remote '${remote}' points at; set taskdag.remote-repo.${remote} or use a GitHub URL remote so --dest can be verified" >&2; return 1
    }
    if [ "$cdest" != "$target" ]; then
        echo "Error: --dest ${cdest} does not match remote '${remote}' (${target}); refusing to mis-deliver" >&2; return 1
    fi

    if [ -z "$repo_id" ]; then
        repo_id=$(taskdag_repo_numeric_id "$corepo") || {
            echo "Error: could not resolve origin.repo-id for ${corepo}; pass --repo-id explicitly" >&2; return 1
        }
    fi

    taskdag_mailbox_put "$kind" "$cnode" "$witness" "$cdest" "$corepo" "$repo_id" "$remote" "$reason"
}

_cmd_mailbox_list() {
    local json=false do_fetch=true remote=origin shard=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --json) json=true; shift ;;
            --no-fetch) do_fetch=false; shift ;;
            --remote) [ $# -ge 2 ] || { echo "Error: --remote requires a value" >&2; return 2; }; remote="$2"; shift 2 ;;
            --shard) [ $# -ge 2 ] || { echo "Error: --shard requires a value" >&2; return 2; }; shard="$2"; shift 2 ;;
            --help|-h) cmd_mailbox --help; return 0 ;;
            *) echo "Error: unknown option to 'mailbox list': $1" >&2; return 2 ;;
        esac
    done
    local args=(--remote "$remote")
    [ "$do_fetch" = false ] && args+=(--no-fetch)
    [ -n "$shard" ] && args+=(--shard "$shard")
    local out
    out=$(taskdag_mailbox_read "${args[@]}") || return 1

    if [ "$json" = true ]; then
        printf '%s\n' "$out"
        return 0
    fi
    local count
    count=$(printf '%s' "$out" | jq 'length')
    if [ "$count" -eq 0 ]; then
        printf "${BOLD}No in-flight mailbox messages${RESET}\n"
        return 0
    fi
    printf "${BOLD}%-14s %-6s %-11s %-26s %-20s${RESET}\n" "MESSAGE-ID" "SHARD" "KIND" "NODE" "DEST"
    printf '%s' "$out" | jq -r \
        '.[] | [(.messageId[0:12]), .shard, .kind, .node, .dest] | @tsv' \
    | while IFS=$'\t' read -r mid shard kind node dest; do
        printf "%-14s %-6s %-11s %-26s %-20s\n" "$mid" "$shard" "$kind" "$node" "$dest"
    done
}

_cmd_mailbox_consume() {
    local do_fetch=true remote=origin dest="" dry_run=false fold_cmd=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --no-fetch) do_fetch=false; shift ;;
            --dry-run) dry_run=true; shift ;;
            --remote) [ $# -ge 2 ] || { echo "Error: --remote requires a value" >&2; return 2; }; remote="$2"; shift 2 ;;
            --dest) [ $# -ge 2 ] || { echo "Error: --dest requires a value" >&2; return 2; }; dest="$2"; shift 2 ;;
            --fold-cmd) [ $# -ge 2 ] || { echo "Error: --fold-cmd requires a value" >&2; return 2; }; fold_cmd="$2"; shift 2 ;;
            --help|-h) cmd_mailbox --help; return 0 ;;
            *) echo "Error: unknown option to 'mailbox consume': $1" >&2; return 2 ;;
        esac
    done
    if [ "$dry_run" = false ] && [ -z "$fold_cmd" ]; then
        echo "Error: mailbox consume requires --fold-cmd (or --dry-run)" >&2; return 2
    fi
    if [ -n "$fold_cmd" ] && ! command -v "$fold_cmd" >/dev/null 2>&1 && [ ! -x "$fold_cmd" ]; then
        echo "Error: --fold-cmd '${fold_cmd}' is not an executable command" >&2; return 2
    fi

    if [ -z "$dest" ]; then
        dest=$(taskdag_current_repo) || { echo "Error: cannot resolve current repo for consume --dest (set TASKDAG_CURRENT_REPO or taskdag.current-repo, or pass --dest)" >&2; return 2; }
    else
        dest=$(taskdag_norm_owner_repo "$dest") || { echo "Error: invalid --dest owner/repo: $dest" >&2; return 2; }
    fi

    local args=(--remote "$remote")
    [ "$do_fetch" = false ] && args+=(--no-fetch)
    local msgs
    msgs=$(taskdag_mailbox_read "${args[@]}") || return 1

    local rc_overall=0
    local mid shard kind node witness mdest orepo repoid
    while IFS=$'\t' read -r mid shard kind node witness mdest orepo repoid; do
        [ -n "$mid" ] || continue
        if [ "$mdest" != "$dest" ]; then
            echo "Error: mailbox message ${mid} is addressed to ${mdest}, not this repo (${dest}) — leaving it (mis-delivery)" >&2
            rc_overall=1
            continue
        fi
        if [ "$dry_run" = true ]; then
            printf "%s would consume message %s (%s %s witness %s)\n" "would-consume" "${mid:0:12}" "$kind" "$node" "${witness:0:12}"
            continue
        fi
        # Ordered fold-THEN-delete: fold first; delete ONLY on durable success.
        if TASKDAG_MAILBOX_MESSAGE_ID="$mid" TASKDAG_MAILBOX_SHARD="$shard" \
           TASKDAG_MAILBOX_KIND="$kind" TASKDAG_MAILBOX_NODE="$node" \
           TASKDAG_MAILBOX_WITNESS="$witness" TASKDAG_MAILBOX_DEST="$mdest" \
           TASKDAG_MAILBOX_ORIGIN_REPO="$orepo" TASKDAG_MAILBOX_ORIGIN_REPO_ID="$repoid" \
           "$fold_cmd"; then
            local path drop_msg rc=0 exp_blob exp_blobsha
            path="msg/${mid}.json"
            # Reconstruct the EXACT canonical blob we folded so the delete is
            # conditional on it (a re-enqueued same-id/different-content message
            # must not be deleted without being folded). The bytes are identical
            # to what `put` stored (same deterministic serializer), so the oid
            # matches the stored blob unless the content genuinely changed.
            exp_blob=$(taskdag_mailbox_blob "$kind" "$node" "$witness" "$mdest" "$orepo" "$repoid") || {
                echo "Error: could not reconstruct folded blob for ${mid}; leaving it (will retry)" >&2; rc_overall=1; continue
            }
            exp_blobsha=$(printf '%s' "$exp_blob" | git hash-object --stdin) || {
                echo "Error: could not hash folded blob for ${mid}; leaving it (will retry)" >&2; rc_overall=1; continue
            }
            drop_msg="Consume mailbox message ${mid:0:12}

Message-Id: ${mid}
Kind: ${kind}
Node: ${node}
Witness: ${witness}"
            _taskdag_mailbox_cas remove "$remote" "$shard" "$path" "$exp_blobsha" "$drop_msg" || rc=$?
            case "$rc" in
                0) printf "${GREEN}✓ Consumed message %s${RESET} (folded + deleted)\n" "${mid:0:12}" ;;
                2) printf "${BLUE}• Message %s already gone${RESET} (folded; delete was a no-op)\n" "${mid:0:12}" ;;
                *) echo "Error: folded message ${mid} but FAILED to delete it (will redeliver; fold must be idempotent)" >&2; rc_overall=1 ;;
            esac
        else
            echo "Warning: fold for message ${mid} did not succeed; leaving it enqueued for retry" >&2
            rc_overall=1
        fi
    done < <(printf '%s' "$msgs" | jq -r '.[] | [.messageId, .shard, .kind, .node, .witness, .dest, .origin.repo, (.origin["repo-id"]|tostring)] | @tsv')

    return "$rc_overall"
}
