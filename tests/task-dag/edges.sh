#!/usr/bin/env bash
# Unit + fixture tests for the dependency-edge data model + READER
# (scripts/task-dag.d/edges.sh, issue #13 north-star Phase 2 foundation).
#
# Covers the leaf's closure criteria:
#   • edge-id STABILITY + semantics (idempotent re-add; owner/repo case-fold;
#     SHA case-fold; from/to order matters; relation/mode changes the id;
#     origin{} does NOT change the id),
#   • edge blob SCHEMA round-trip through the reader,
#   • repo-identity RESOLUTION (offline git-config override; fail-loud paths),
#   • the READER over a real tasks/v1/graph index tree (empty set, JSON
#     round-trip, tri-state fetch, and corruption detection).
#
# No network: builds a throwaway bare origin + working clone in a tempdir.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
EDGES_LIB="$(dirname "$TD")/task-dag.d/edges.sh"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

command -v jq >/dev/null 2>&1 || { echo "jq is required for this test"; echo "PASS=0 FAIL=1"; exit 1; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# The reader/edge helpers reference these globals from the main script; when
# we source edges.sh standalone for unit tests, provide them ourselves.
TASKDAG_GRAPH_REF="refs/heads/tasks/v1/graph"
RED='' GREEN='' YELLOW='' BLUE='' BOLD='' RESET=''
# shellcheck source=/dev/null
source "$EDGES_LIB"

# ===========================================================================
# Part A — edge-id stability + semantics (pure helper, no git needed)
# ===========================================================================
FROM="task:owner/repo@$(printf 'a%.0s' {1..40})"
TO="issue:owner/repo#123"

id1=$(taskdag_edge_id "$FROM" "$TO" requires all)
id2=$(taskdag_edge_id "$FROM" "$TO" requires all)
if [ -n "$id1" ] && [ "$id1" = "$id2" ] && [[ "$id1" =~ ^[0-9a-f]{64}$ ]]; then
    ok "A1: edge-id is a stable 64-hex sha256 (idempotent re-add)"
else
    bad "A1: edge-id not stable/64-hex (id1=$id1 id2=$id2)"
fi

# owner/repo case-insensitive: OWNER/Repo folds to owner/repo → same id
idU=$(taskdag_edge_id "task:OWNER/Repo@$(printf 'a%.0s' {1..40})" "issue:Owner/REPO#123" requires all)
if [ "$idU" = "$id1" ]; then
    ok "A2: owner/repo case-folding yields the same edge-id"
else
    bad "A2: case-folding changed the edge-id ($idU != $id1)"
fi

# mixed-case task SHA folds to lowercase → same id
idS=$(taskdag_edge_id "task:owner/repo@$(printf 'A%.0s' {1..40})" "$TO" requires all)
if [ "$idS" = "$id1" ]; then
    ok "A3: task-SHA case-folding yields the same edge-id"
else
    bad "A3: SHA case-folding changed the edge-id ($idS != $id1)"
fi

# from/to order is significant
idSwap=$(taskdag_edge_id "task:owner/repo@$(printf 'b%.0s' {1..40})" "$TO" requires all)
if [ "$idSwap" != "$id1" ]; then
    ok "A4: a different 'from' node yields a different edge-id"
else
    bad "A4: different 'from' collided with original edge-id"
fi

# relation/mode participates in the id (satisfies/any differs from requires/all)
idSat=$(taskdag_edge_id "$FROM" "$TO" satisfies any)
if [ "$idSat" != "$id1" ]; then
    ok "A5: relation/mode participates in the edge-id"
else
    bad "A5: satisfies/any collided with requires/all"
fi

# origin{} (repo-id + witness) does NOT participate: the id is derived only
# from (from,to,relation,mode), so a metadata-only edit is idempotent. Prove
# it by building two blobs with different origins and equal edge-ids.
blobA=$(taskdag_edge_blob "$FROM" "$TO" requires all 111 witnessA)
blobB=$(taskdag_edge_blob "$FROM" "$TO" requires all 222 witnessB)
if [ "$blobA" != "$blobB" ] \
    && [ "$(taskdag_edge_id "$FROM" "$TO" requires all)" = "$id1" ]; then
    ok "A6: origin{} differs between blobs but the semantic edge-id is unchanged"
else
    bad "A6: origin{} unexpectedly affected identity"
fi

# invalid relation/mode pair (OR-deps out of scope) is rejected
if taskdag_edge_id "$FROM" "$TO" requires any >/dev/null 2>&1; then
    bad "A7: requires/any (disallowed) was accepted"
else
    ok "A7: requires/any (disallowed OR-dep) is rejected"
fi

# malformed nodes are rejected (no bogus id)
if taskdag_edge_id "task:owner/repo@short" "$TO" requires all >/dev/null 2>&1; then
    bad "A8: a too-short task SHA was accepted"
else
    ok "A8: malformed 'from' node is rejected"
fi
if taskdag_edge_id "task:owner/repo@$(printf 'a%.0s' {1..40})" "note:owner/repo#1" requires all >/dev/null 2>&1; then
    bad "A9: an unknown node kind was accepted"
else
    ok "A9: unknown node-kind 'to' is rejected"
fi

# 64-hex task object id (future-proof) is accepted
if taskdag_edge_id "task:owner/repo@$(printf 'a%.0s' {1..64})" "$TO" requires all >/dev/null 2>&1; then
    ok "A10: a 64-hex task object id is accepted"
else
    bad "A10: 64-hex task object id rejected"
fi

# ===========================================================================
# Part B — edge blob schema (serializer output shape)
# ===========================================================================
blob=$(taskdag_edge_blob "$FROM" "$TO" satisfies any 424242 "deadbeef")
if printf '%s' "$blob" | jq -e '
      .schema == 1 and .from == "task:owner/repo@'"$(printf 'a%.0s' {1..40})"'"
      and .to == "issue:owner/repo#123" and .relation == "satisfies"
      and .mode == "any" and .origin["repo-id"] == 424242
      and .origin.witness == "deadbeef"' >/dev/null 2>&1; then
    ok "B1: edge blob has the schema:1 shape with numeric origin.repo-id"
else
    bad "B1: edge blob shape wrong (got: $blob)"
fi

# non-numeric repo-id is rejected
if taskdag_edge_blob "$FROM" "$TO" requires all "not-a-number" w >/dev/null 2>&1; then
    bad "B2: non-numeric repo-id accepted"
else
    ok "B2: non-numeric origin.repo-id is rejected"
fi
# empty witness is rejected
if taskdag_edge_blob "$FROM" "$TO" requires all 1 "" >/dev/null 2>&1; then
    bad "B3: empty witness accepted"
else
    ok "B3: empty origin.witness is rejected"
fi

# ===========================================================================
# Part C — repo-identity resolution (offline git-config seam)
# ===========================================================================
git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"
cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master

# preseed the override; resolution must be offline + deterministic
git config "taskdag.owner/repo.id" 987654
resolved=$(taskdag_repo_numeric_id "owner/repo")
if [ "$resolved" = "987654" ]; then
    ok "C1: repo-id resolves from the git-config override (offline)"
else
    bad "C1: repo-id override not honored (got: $resolved)"
fi
# case-insensitive lookup uses the same canonical key
resolvedU=$(taskdag_repo_numeric_id "Owner/REPO")
if [ "$resolvedU" = "987654" ]; then
    ok "C2: repo-id lookup is case-insensitive (canonical key)"
else
    bad "C2: case-insensitive repo-id lookup failed (got: $resolvedU)"
fi
# a name with a dot survives the git-config subsection encoding
git config "taskdag.foo.github.io/site.id" 555
if [ "$(taskdag_repo_numeric_id 'foo.github.io/site')" = "555" ]; then
    ok "C3: dotted owner/repo survives the config-key encoding"
else
    bad "C3: dotted owner/repo repo-id lookup failed"
fi
# malformed cached value fails loud (does not silently paper over)
git config "taskdag.bad/cache.id" "not-an-int"
if taskdag_repo_numeric_id "bad/cache" >/dev/null 2>&1; then
    bad "C4: malformed cached repo-id was accepted"
else
    ok "C4: malformed cached repo-id fails loud"
fi
# unresolvable (no override, no gh in this env) fails loud, not empty-success
if PATH=/nonexistent-only taskdag_repo_numeric_id "never/seen" >/dev/null 2>&1; then
    bad "C5: unresolvable repo-id unexpectedly succeeded"
else
    ok "C5: unresolvable repo-id fails loud"
fi

# ===========================================================================
# Part D — the READER over a real tasks/v1/graph tree
# ===========================================================================
# Helper: write an edge blob and emit a "<blobsha> <path>" line for the index.
add_edge() {  # <from> <to> <relation> <mode> <repo-id> <witness>
    local eid b blobsha
    eid=$(taskdag_edge_id "$1" "$2" "$3" "$4") || return 1
    b=$(taskdag_edge_blob "$1" "$2" "$3" "$4" "$5" "$6") || return 1
    blobsha=$(printf '%s' "$b" | git hash-object -w --stdin)
    printf '%s edges/%s.json\n' "$blobsha" "$eid"
}

# Build a graph index commit whose tree = the given "<blobsha> <path>" lines.
# git mktree rejects slashed paths, so build the (nested) tree via a scratch
# index instead — this is exactly how a real writer would stage the tree.
build_graph_ref() {  # entries via stdin (<blobsha> <path> lines)
    local idx="$ROOT/wc/.graph.index" blobsha path tree commit
    rm -f "$idx"
    while read -r blobsha path; do
        [ -n "$blobsha" ] || continue
        GIT_INDEX_FILE="$idx" git update-index --add --cacheinfo "100644,$blobsha,$path"
    done
    tree=$(GIT_INDEX_FILE="$idx" git write-tree)
    rm -f "$idx"
    commit=$(git commit-tree "$tree" -m "graph index")
    git update-ref "$TASKDAG_GRAPH_REF" "$commit"
}

# D1: no ref yet ⇒ empty active set (offline)
git update-ref -d "$TASKDAG_GRAPH_REF" 2>/dev/null || true
out=$(taskdag_read_edges --no-fetch)
if [ "$out" = "[]" ]; then
    ok "D1: absent graph ref reads as an empty edge set"
else
    bad "D1: absent graph ref did not read empty (got: $out)"
fi

# D2: two edges round-trip through the reader, sorted, with recomputed edgeId
{
    add_edge "task:owner/repo@$(printf 'a%.0s' {1..40})" "issue:owner/repo#1" requires all 100 w1
    add_edge "task:owner/repo@$(printf 'c%.0s' {1..40})" "task:peer/repo@$(printf 'd%.0s' {1..40})" satisfies any 200 w2
} | build_graph_ref
out=$(taskdag_read_edges --no-fetch)
if printf '%s' "$out" | jq -e 'length == 2
      and (map(.edgeId) | . == (sort))
      and all(.[]; (.edgeId | test("^[0-9a-f]{64}$")) and .schema == 1)
      and any(.[]; .relation == "requires" and .mode == "all")
      and any(.[]; .relation == "satisfies" and .to == "task:peer/repo@'"$(printf 'd%.0s' {1..40})"'")' >/dev/null 2>&1; then
    ok "D2: reader round-trips edge blobs into a sorted active set"
else
    bad "D2: reader round-trip wrong (got: $out)"
fi

# D3: same content read through the CLI `edges --json --no-fetch`
cli_out=$("$TD" edges --json --no-fetch 2>/dev/null)
if [ "$cli_out" = "$out" ]; then
    ok "D3: 'task-dag edges --json --no-fetch' matches the reader helper"
else
    bad "D3: CLI edges output diverged (cli=$cli_out helper=$out)"
fi

# D4: path/content edge-id mismatch is detected (corruption / same-path
#     non-identical write). Rename a good blob under a wrong (but well-formed)
#     edge-id filename and confirm the reader FAILS loud.
good_entry=$(add_edge "task:owner/repo@$(printf 'e%.0s' {1..40})" "issue:owner/repo#9" requires all 300 w3)
good_blobsha=$(printf '%s' "$good_entry" | awk '{print $1}')
wrong_id=$(printf 'f%.0s' {1..64})
printf '%s edges/%s.json\n' "$good_blobsha" "$wrong_id" | build_graph_ref
if taskdag_read_edges --no-fetch >/dev/null 2>&1; then
    bad "D4: path/content edge-id mismatch was NOT detected"
else
    ok "D4: path/content edge-id mismatch fails loud"
fi

# D5: an unexpected (non edges/) path in the graph tree is rejected
junk=$(git hash-object -w --stdin <<<'junk')
printf '%s README.txt\n' "$junk" | build_graph_ref
if taskdag_read_edges --no-fetch >/dev/null 2>&1; then
    bad "D5: unexpected path in graph tree was accepted"
else
    ok "D5: unexpected path in graph tree is rejected"
fi

# D6: a bad-schema blob under a correct-looking name is rejected
badblob=$(jq -nc '{schema:2, from:"task:owner/repo@'"$(printf 'a%.0s' {1..40})"'", to:"issue:owner/repo#1", relation:"requires", mode:"all", origin:{"repo-id":1, witness:"w"}}')
badsha=$(printf '%s' "$badblob" | git hash-object -w --stdin)
printf '%s edges/%s.json\n' "$badsha" "$(printf '0%.0s' {1..64})" | build_graph_ref
if taskdag_read_edges --no-fetch >/dev/null 2>&1; then
    bad "D6: unsupported schema version was accepted"
else
    ok "D6: unsupported schema version is rejected"
fi

# D7: tri-state fetch — push a real graph ref to origin, then read WITHOUT
#     --no-fetch (default sync path) and confirm it is pulled + parsed.
git update-ref -d "$TASKDAG_GRAPH_REF" 2>/dev/null || true
{
    add_edge "task:owner/repo@$(printf '1%.0s' {1..40})" "issue:owner/repo#7" requires all 400 w7
} | build_graph_ref
git push -q origin "+${TASKDAG_GRAPH_REF}:${TASKDAG_GRAPH_REF}"
git update-ref -d "$TASKDAG_GRAPH_REF"     # drop local; force a fetch
out=$(taskdag_read_edges)                  # default: tri-state sync from origin
if printf '%s' "$out" | jq -e 'length == 1 and .[0].to == "issue:owner/repo#7"' >/dev/null 2>&1; then
    ok "D7: default read tri-state-syncs the graph ref from origin"
else
    bad "D7: default read did not sync from origin (got: $out)"
fi

# D8: a wrongly-TYPED schema ("1" as a string) is rejected — the reader must
#     not let jq -r coerce it into a plausible value (fail-closed types).
strblob=$(jq -nc '{schema:"1", from:"task:owner/repo@'"$(printf 'a%.0s' {1..40})"'", to:"issue:owner/repo#1", relation:"requires", mode:"all", origin:{"repo-id":1, witness:"w"}}')
strsha=$(printf '%s' "$strblob" | git hash-object -w --stdin)
printf '%s edges/%s.json\n' "$strsha" "$(printf '1%.0s' {1..64})" | build_graph_ref
if taskdag_read_edges --no-fetch >/dev/null 2>&1; then
    bad "D8: string-typed schema was accepted"
else
    ok "D8: string-typed schema is rejected (typed structural check)"
fi

# D9: a string-typed origin.repo-id ("42") is rejected
ridblob=$(jq -nc '{schema:1, from:"task:owner/repo@'"$(printf 'a%.0s' {1..40})"'", to:"issue:owner/repo#1", relation:"requires", mode:"all", origin:{"repo-id":"42", witness:"w"}}')
ridsha=$(printf '%s' "$ridblob" | git hash-object -w --stdin)
printf '%s edges/%s.json\n' "$ridsha" "$(printf '2%.0s' {1..64})" | build_graph_ref
if taskdag_read_edges --no-fetch >/dev/null 2>&1; then
    bad "D9: string-typed origin.repo-id was accepted"
else
    ok "D9: string-typed origin.repo-id is rejected"
fi

# D10: a NON-CANONICAL node address at rest (mixed-case owner/repo) is
#      rejected — the writer must store canonical nodes.
ncblob=$(jq -nc '{schema:1, from:"task:Owner/Repo@'"$(printf 'a%.0s' {1..40})"'", to:"issue:owner/repo#1", relation:"requires", mode:"all", origin:{"repo-id":1, witness:"w"}}')
ncsha=$(printf '%s' "$ncblob" | git hash-object -w --stdin)
printf '%s edges/%s.json\n' "$ncsha" "$(printf '3%.0s' {1..64})" | build_graph_ref
# Capture first: under `set -o pipefail`, `reader | grep` would report the
# reader's (intended) non-zero exit even when grep matches the message.
d10_out=$(taskdag_read_edges --no-fetch 2>&1 || true)
if echo "$d10_out" | grep -q 'non-canonical'; then
    ok "D10: a non-canonical stored node address is rejected"
else
    bad "D10: non-canonical stored node not rejected (got: $d10_out)"
fi

# D11: a non-regular file mode (executable 100755 / symlink 120000, both
#      reported by git as type 'blob') under edges/ is rejected.
okblob=$(taskdag_edge_blob "task:owner/repo@$(printf 'a%.0s' {1..40})" "issue:owner/repo#1" requires all 1 w)
okid=$(taskdag_edge_id "task:owner/repo@$(printf 'a%.0s' {1..40})" "issue:owner/repo#1" requires all)
okblobsha=$(printf '%s' "$okblob" | git hash-object -w --stdin)
idx="$ROOT/wc/.mode.index"; rm -f "$idx"
GIT_INDEX_FILE="$idx" git update-index --add --cacheinfo "100755,$okblobsha,edges/$okid.json"
mtree=$(GIT_INDEX_FILE="$idx" git write-tree); rm -f "$idx"
mcommit=$(git commit-tree "$mtree" -m "exec-mode edge")
git update-ref "$TASKDAG_GRAPH_REF" "$mcommit"
d11_out=$(taskdag_read_edges --no-fetch 2>&1 || true)
if echo "$d11_out" | grep -q 'expected a regular file'; then
    ok "D11: a non-regular-file (100755) edge blob is rejected"
else
    bad "D11: non-regular-file edge blob not rejected (got: $d11_out)"
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
