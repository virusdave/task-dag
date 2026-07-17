#!/usr/bin/env bash
# Unit + fixture tests for satisfied-edge PRUNING + explicit TOMBSTONES on
# tasks/v1/graph (scripts/task-dag.d/edges-prune.sh + the tombstone-aware
# `dep drop` in edges-write.sh + the tombstone model/reader in edges.sh,
# issue #13 north-star).
#
# Covers the leaf's closure criteria:
#   • satisfied edge PRUNED (plain FF deletion, no tombstone) once a durable
#     completion witness exists on master,
#   • unsatisfied removal REQUIRES a tombstone (never a silent tree deletion),
#     so a lost edge is distinguishable from an intentionally-dropped one,
#   • the tombstone SURVIVES recompute (an unrelated FF op keeps it),
#   • plus: tombstone masks its edge (remove-wins), a tombstoned edge is
#     terminal (dep add refuses to resurrect it), dep add to an already-done
#     target still WRITES an active edge (bounding is prune's job, not add's)
#     and a PLAIN-pruned edge can be re-added (prune is GC, not terminal),
#     corrupt tombstones fail the reader closed, dropping an unknown edge fails
#     loud, and validate --strict accepts the new path.
#
# No network: builds a throwaway bare origin + working clone in a tempdir.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
LIBDIR="$(dirname "$TD")/task-dag.d"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

command -v jq >/dev/null 2>&1 || { echo "jq is required for this test"; echo "PASS=0 FAIL=1"; exit 1; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# Globals the modules reference when sourced standalone.
TASKDAG_GRAPH_REF="refs/heads/tasks/v1/graph"
EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
RED='' GREEN='' YELLOW='' BLUE='' BOLD='' RESET=''

FORTY=$(printf 'a%.0s' {1..40})
FORTYB=$(printf 'b%.0s' {1..40})
FORTYC=$(printf 'c%.0s' {1..40})
FORTYD=$(printf 'd%.0s' {1..40})

# ===========================================================================
# Part A — tombstone blob serializer (pure; source the model standalone).
# ===========================================================================
while IFS= read -r line; do
    case "$line" in
        PASS:*) ok "${line#PASS: }" ;;
        FAIL:*) bad "${line#FAIL: }" ;;
    esac
done < <(
    # shellcheck source=/dev/null
    source "$LIBDIR/edges.sh"
    blob=$(taskdag_tombstone_blob "task:owner/repo@$FORTY" "issue:owner/repo#1" requires all 4242 wit1)
    if printf '%s' "$blob" | jq -e '.schema==1 and .tombstone==true
            and .from=="task:owner/repo@'"$FORTY"'" and .to=="issue:owner/repo#1"
            and .relation=="requires" and .mode=="all"
            and .origin["repo-id"]==4242 and .origin.witness=="wit1"' >/dev/null 2>&1; then
        echo "PASS: A1 tombstone blob is a canonical schema:1 tombstone"
    else
        echo "FAIL: A1 tombstone blob shape wrong (got: $blob)"
    fi
    # The tombstone's semantic edge-id == the edge it removes (origin excluded).
    tid=$(_taskdag_tombstone_edge_id "$blob")
    eid=$(taskdag_edge_id "task:owner/repo@$FORTY" "issue:owner/repo#1" requires all)
    if [ "$tid" = "$eid" ]; then
        echo "PASS: A2 tombstone edge-id == the removed edge's semantic id"
    else
        echo "FAIL: A2 tombstone id mismatch (tid=$tid eid=$eid)"
    fi
    # A blob WITHOUT tombstone:true is not a valid tombstone (discriminant).
    ntblob=$(jq -nc '{schema:1,from:"task:owner/repo@'"$FORTY"'",to:"issue:owner/repo#1",relation:"requires",mode:"all",origin:{"repo-id":4242,witness:"w"}}')
    if _taskdag_tombstone_edge_id "$ntblob" >/dev/null 2>&1; then
        echo "FAIL: A3 a non-tombstone blob was accepted as a tombstone"
    else
        echo "PASS: A3 a blob lacking tombstone:true is not a valid tombstone"
    fi
    # A disallowed relation/mode is rejected.
    if taskdag_tombstone_blob "task:owner/repo@$FORTY" "issue:owner/repo#1" requires any 4242 w >/dev/null 2>&1; then
        echo "FAIL: A4 requires/any tombstone (disallowed) was accepted"
    else
        echo "PASS: A4 disallowed relation/mode tombstone is rejected"
    fi
)

# ===========================================================================
# Part B — build a real origin + clone and drive the CLI.
# ===========================================================================
git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"
cd "$ROOT/wc"
git config taskdag.current-repo owner/repo   # so the fact layer can scope done()
git config "taskdag.owner/repo.id" 4242
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master

# complete_issue <N>: land a Closes-Epic:#N merge on master + push (makes
# done(issue:owner/repo#N) true, exactly as the tool's authoritative fact).
complete_issue() {
    local n="$1" base side merge
    base=$(git rev-parse HEAD)
    side=$(git commit-tree "$EMPTY_TREE" -p "$base" -m "Task: issue root $n" </dev/null)
    merge=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p "$base" -p "$side" -m "close #$n

Closes-Epic: #$n" </dev/null)
    git update-ref refs/heads/master "$merge"
    git update-ref "refs/heads/gh/issues/$n" "$side"
    git push -q origin master
}

FROM="task:owner/repo@$FORTY"

# B1: add an UNSATISFIED edge (foreign target, never done here).
"$TD" dep add --from "$FROM" --to "task:peer/repo@$FORTYB" --relation requires \
    --repo-id 4242 --witness w1 >/dev/null 2>&1
eid_unsat=$("$TD" edges --json --no-fetch | jq -r '.[]|select(.to=="task:peer/repo@'"$FORTYB"'")|.edgeId')
[ -n "$eid_unsat" ] && ok "B1: added an unsatisfied edge" || bad "B1: unsatisfied edge not added"

# B2 (closure: unsatisfied removal REQUIRES a tombstone): dep drop of an
# unsatisfied edge writes a tombstone AND removes the edge blob — never a
# silent deletion. Reader shows it inactive.
"$TD" dep drop "$eid_unsat" --reason "rescope" >/dev/null 2>&1
has_tomb=no; git cat-file -e "${TASKDAG_GRAPH_REF}:tombstones/${eid_unsat}.json" 2>/dev/null && has_tomb=yes
has_edge=yes; git cat-file -e "${TASKDAG_GRAPH_REF}:edges/${eid_unsat}.json" 2>/dev/null || has_edge=no
n_active=$("$TD" edges --json --no-fetch | jq 'length')
if [ "$has_tomb" = yes ] && [ "$has_edge" = no ] && [ "$n_active" = 0 ]; then
    ok "B2: unsatisfied dep drop writes a tombstone + removes the edge (no silent delete)"
else
    bad "B2: unsatisfied drop wrong (tomb=$has_tomb edge=$has_edge active=$n_active)"
fi

# B3 (monotonicity): a tombstoned edge is TERMINAL — dep add of the same edge
# fails loud rather than silently resurrecting it.
add_out=$("$TD" dep add --from "$FROM" --to "task:peer/repo@$FORTYB" --relation requires \
    --repo-id 4242 --witness w2 2>&1); add_rc=$?
if [ "$add_rc" -ne 0 ] && echo "$add_out" | grep -qi tombstoned; then
    ok "B3: re-adding a tombstoned edge fails loud (terminal, no resurrection)"
else
    bad "B3: tombstoned edge was resurrectable (rc=$add_rc out=$add_out)"
fi

# B4: re-drop of an already-tombstoned edge is an idempotent no-op success.
tip_b=$(git rev-parse "$TASKDAG_GRAPH_REF")
if "$TD" dep drop "$eid_unsat" >/dev/null 2>&1; then
    tip_a=$(git rev-parse "$TASKDAG_GRAPH_REF")
    [ "$tip_b" = "$tip_a" ] && ok "B4: re-drop of a tombstoned edge is a no-op" \
        || bad "B4: re-drop created a commit (tip $tip_b->$tip_a)"
else
    bad "B4: re-drop of a tombstoned edge returned failure"
fi

# B5 (closure: tombstone SURVIVES recompute): an unrelated FF op keeps it.
"$TD" dep add --from "$FROM" --to "task:peer/repo@$FORTYC" --relation requires \
    --repo-id 4242 --witness w3 >/dev/null 2>&1
if git cat-file -e "${TASKDAG_GRAPH_REF}:tombstones/${eid_unsat}.json" 2>/dev/null; then
    ok "B5: tombstone survives an unrelated recompute (still present after a new add)"
else
    bad "B5: tombstone was lost across a recompute"
fi

# ===========================================================================
# Part C — satisfied-edge pruning (needs a durable completion on master).
# ===========================================================================
# C1 (closure: satisfied edge PRUNED): edge to issue#7, complete #7, dep drop
# ⇒ plain deletion (NO tombstone for that edge-id).
"$TD" dep add --from "$FROM" --to "issue:owner/repo#7" --relation requires \
    --repo-id 4242 --witness w4 >/dev/null 2>&1
eid_sat=$("$TD" edges --json --no-fetch | jq -r '.[]|select(.to=="issue:owner/repo#7")|.edgeId')
complete_issue 7
drop_out=$("$TD" dep drop "$eid_sat" --reason "satisfied cleanup" 2>&1)
edge_gone=yes; git cat-file -e "${TASKDAG_GRAPH_REF}:edges/${eid_sat}.json" 2>/dev/null && edge_gone=no
tomb_absent=yes; git cat-file -e "${TASKDAG_GRAPH_REF}:tombstones/${eid_sat}.json" 2>/dev/null && tomb_absent=no
if [ "$edge_gone" = yes ] && [ "$tomb_absent" = yes ] && echo "$drop_out" | grep -qi prune; then
    ok "C1: satisfied dep drop PRUNES the edge (plain deletion, no tombstone)"
else
    bad "C1: satisfied drop wrong (edge_gone=$edge_gone tomb_absent=$tomb_absent out=$drop_out)"
fi

# C2: dep add to an ALREADY-done target WRITES an active edge (it is NOT a
# no-op). An edge records a real dependency RELATIONSHIP that the reconcile
# layer reads (a leaf with a satisfied `requires` edge is ready-but-not-
# complete, and must appear as an edge-source node); add must never silently
# drop it. Bounding the active set is the job of `dep prune` / prunable
# `dep drop`, NOT of add.
n_before=$("$TD" edges --json --no-fetch | jq 'length')
addd_out=$("$TD" dep add --from "$FROM" --to "issue:owner/repo#7" --relation requires \
    --repo-id 4242 --witness w5 2>&1); addd_rc=$?
n_after=$("$TD" edges --json --no-fetch | jq 'length')
eid_c2=$(printf '%s\0%s\0%s\0%s' "$FROM" "issue:owner/repo#7" requires all | sha256sum | awk '{print $1}')
present_c2=no; git cat-file -e "${TASKDAG_GRAPH_REF}:edges/${eid_c2}.json" 2>/dev/null && present_c2=yes
if [ "$addd_rc" -eq 0 ] && [ "$n_after" -eq $((n_before + 1)) ] && [ "$present_c2" = yes ]; then
    ok "C2: dep add to an already-done target writes an active edge (not a no-op)"
else
    bad "C2: add-to-done did not write an active edge (rc=$addd_rc before=$n_before after=$n_after present=$present_c2 out=$addd_out)"
fi
# C3: a PLAIN prune is garbage-collection, NOT terminal (contrast B3's
# tombstone). After pruning a satisfied edge, re-adding the SAME edge-id
# succeeds and re-materialises the active edge — there is no lingering
# terminal witness. (A tombstoned edge, by contrast, can never be re-added.)
"$TD" dep prune "$eid_c2" --no-fetch >/dev/null 2>&1
pruned_c2=yes; git cat-file -e "${TASKDAG_GRAPH_REF}:edges/${eid_c2}.json" 2>/dev/null && pruned_c2=no
readd_out=$("$TD" dep add --from "$FROM" --to "issue:owner/repo#7" --relation requires \
    --repo-id 4242 --witness w5b 2>&1); readd_rc=$?
readd_present=no; git cat-file -e "${TASKDAG_GRAPH_REF}:edges/${eid_c2}.json" 2>/dev/null && readd_present=yes
if [ "$pruned_c2" = yes ] && [ "$readd_rc" -eq 0 ] && [ "$readd_present" = yes ]; then
    ok "C3: re-adding a PLAIN-pruned edge succeeds (prune is GC, not terminal)"
else
    bad "C3: re-add after prune wrong (pruned=$pruned_c2 rc=$readd_rc present=$readd_present out=$readd_out)"
fi
# Clean it back out again so later counts are stable.
"$TD" dep prune "$eid_c2" --no-fetch >/dev/null 2>&1

# ===========================================================================
# Part D — the prune primitive / `dep prune` command.
# ===========================================================================
# Forge a SATISFIED edge (to done issue#7) directly into the graph tree so we
# can exercise prune without the add-guard blocking it.
forge_edge() {  # <from> <to> <relation> <mode>
    local f="$1" t="$2" r="$3" m="$4" blob eid bs tip tr nc idx
    eid=$(printf '%s\0%s\0%s\0%s' "$f" "$t" "$r" "$m" | sha256sum | awk '{print $1}')
    blob=$(jq -nc --arg f "$f" --arg t "$t" --arg r "$r" --arg m "$m" \
        '{schema:1,from:$f,to:$t,relation:$r,mode:$m,origin:{"repo-id":4242,witness:"forge"}}')
    bs=$(printf '%s' "$blob" | git hash-object -w --stdin)
    tip=$(git rev-parse "$TASKDAG_GRAPH_REF")
    idx="$ROOT/.forge.index"; rm -f "$idx"
    GIT_INDEX_FILE="$idx" git read-tree "${tip}^{tree}"
    GIT_INDEX_FILE="$idx" git update-index --add --cacheinfo "100644,${bs},edges/${eid}.json"
    tr=$(GIT_INDEX_FILE="$idx" git write-tree); rm -f "$idx"
    nc=$(git commit-tree "$tr" -p "$tip" -m "forge $eid")
    git update-ref "$TASKDAG_GRAPH_REF" "$nc"; git push -q origin "$TASKDAG_GRAPH_REF"
    printf '%s\n' "$eid"
}

eid_forge_sat=$(forge_edge "$FROM" "issue:owner/repo#7" requires all)
before=$("$TD" edges --json --no-fetch | jq 'length')
"$TD" dep prune --no-fetch >/dev/null 2>&1
after=$("$TD" edges --json --no-fetch | jq 'length')
still=yes; git cat-file -e "${TASKDAG_GRAPH_REF}:edges/${eid_forge_sat}.json" 2>/dev/null || still=no
if [ "$before" -ge 1 ] && [ "$still" = no ] && [ "$after" -lt "$before" ]; then
    ok "D1: dep prune removes satisfied edges (bounded-set backstop)"
else
    bad "D1: dep prune wrong (before=$before after=$after still=$still)"
fi

# D2: prune REFUSES an unsatisfied edge (that path needs a tombstone via drop).
eid_forge_unsat=$(forge_edge "$FROM" "task:peer/repo@$FORTYD" requires all)
prune_out=$("$TD" dep prune "$eid_forge_unsat" --no-fetch 2>&1); prune_rc=$?
still2=no; git cat-file -e "${TASKDAG_GRAPH_REF}:edges/${eid_forge_unsat}.json" 2>/dev/null && still2=yes
if [ "$prune_rc" -ne 0 ] && [ "$still2" = yes ] && echo "$prune_out" | grep -qi 'not prunable'; then
    ok "D2: prune of a not-yet-prunable edge fails loud (no unwitnessed deletion)"
else
    bad "D2: not-yet-prunable prune not refused (rc=$prune_rc still=$still2 out=$prune_out)"
fi
# Clean the forged unsatisfied edge back out (tombstone it) so the tree is tidy.
"$TD" dep drop "$eid_forge_unsat" >/dev/null 2>&1

# ===========================================================================
# Part E — reader masking / fail-closed / unknown-drop.
# ===========================================================================
# E1: a tree with BOTH edges/<id> and tombstones/<id> ⇒ the edge is masked
#     (remove-wins). Forge both for a fresh id.
mask_from="$FROM"; mask_to="task:peer/repo@$FORTYC"
mid=$(printf '%s\0%s\0%s\0%s' "$mask_from" "$mask_to" requires all | sha256sum | awk '{print $1}')
eblob=$(jq -nc --arg f "$mask_from" --arg t "$mask_to" '{schema:1,from:$f,to:$t,relation:"requires",mode:"all",origin:{"repo-id":4242,witness:"e"}}')
tblob=$(jq -nc --arg f "$mask_from" --arg t "$mask_to" '{schema:1,tombstone:true,from:$f,to:$t,relation:"requires",mode:"all",origin:{"repo-id":4242,witness:"t"}}')
ebs=$(printf '%s' "$eblob" | git hash-object -w --stdin)
tbs=$(printf '%s' "$tblob" | git hash-object -w --stdin)
tip=$(git rev-parse "$TASKDAG_GRAPH_REF")
idx="$ROOT/.mask.index"; rm -f "$idx"
GIT_INDEX_FILE="$idx" git read-tree "${tip}^{tree}"
GIT_INDEX_FILE="$idx" git update-index --add --cacheinfo "100644,${ebs},edges/${mid}.json"
GIT_INDEX_FILE="$idx" git update-index --add --cacheinfo "100644,${tbs},tombstones/${mid}.json"
mtree=$(GIT_INDEX_FILE="$idx" git write-tree); rm -f "$idx"
mcommit=$(git commit-tree "$mtree" -p "$tip" -m "mask fixture")
git update-ref "$TASKDAG_GRAPH_REF" "$mcommit"
masked=$("$TD" edges --json --no-fetch 2>/dev/null | jq -r --arg id "$mid" 'any(.[]; .edgeId==$id)')
if [ "$masked" = false ]; then
    ok "E1: an edge with a tombstone at the same id is masked (remove-wins)"
else
    bad "E1: tombstone did not mask its edge (masked=$masked)"
fi

# E2: a corrupt tombstone makes the reader FAIL CLOSED (never a partial set).
badid=$(printf '0%.0s' {1..64})
badblob=$(printf 'not-json')
badbs=$(printf '%s' "$badblob" | git hash-object -w --stdin)
tip=$(git rev-parse "$TASKDAG_GRAPH_REF")
idx="$ROOT/.bad.index"; rm -f "$idx"
GIT_INDEX_FILE="$idx" git read-tree "${tip}^{tree}"
GIT_INDEX_FILE="$idx" git update-index --add --cacheinfo "100644,${badbs},tombstones/${badid}.json"
btree=$(GIT_INDEX_FILE="$idx" git write-tree); rm -f "$idx"
bcommit=$(git commit-tree "$btree" -p "$tip" -m "corrupt tombstone")
git update-ref "$TASKDAG_GRAPH_REF" "$bcommit"
if "$TD" edges --json --no-fetch >/dev/null 2>&1; then
    bad "E2: reader accepted a corrupt tombstone (did not fail closed)"
else
    ok "E2: a corrupt tombstone makes the reader fail closed"
fi
# Roll the graph ref back to the last well-formed commit for the remaining tests.
git update-ref "$TASKDAG_GRAPH_REF" "$mcommit"; git push -q -f origin "$TASKDAG_GRAPH_REF"

# E3: dep drop of an unknown edge-id (valid hex, absent, not tombstoned) fails
#     loud — we cannot fabricate a tombstone for an edge we never saw.
unk=$(printf 'e%.0s' {1..64})
d3=$("$TD" dep drop "$unk" 2>&1); d3rc=$?
if [ "$d3rc" -ne 0 ] && echo "$d3" | grep -qi 'not present'; then
    ok "E3: dropping an unknown edge fails loud (no fabricated tombstone)"
else
    bad "E3: unknown-edge drop not refused (rc=$d3rc out=$d3)"
fi

# ===========================================================================
# Part F — validate --strict recognises the tombstone path.
# ===========================================================================
mk_graph_ref() {  # "<blobsha> <path>" lines on stdin
    local idx tree commit
    idx="$ROOT/.vs.index"; rm -f "$idx"
    while read -r bs path; do
        [ -n "$bs" ] || continue
        GIT_INDEX_FILE="$idx" git update-index --add --cacheinfo "100644,$bs,$path"
    done
    tree=$(GIT_INDEX_FILE="$idx" git write-tree); rm -f "$idx"
    commit=$(git commit-tree "$tree" -m "graph index")
    git update-ref "$TASKDAG_GRAPH_REF" "$commit"
}

good_from="task:owner/repo@$FORTY"; good_to="issue:owner/repo#9"
good_eid=$(printf '%s\0%s\0%s\0%s' "$good_from" "$good_to" requires all | sha256sum | awk '{print $1}')
good_eblob=$(jq -nc --arg f "$good_from" --arg t "$good_to" '{schema:1,from:$f,to:$t,relation:"requires",mode:"all",origin:{"repo-id":4242,witness:"w"}}')
good_tblob=$(jq -nc --arg f "$good_from" --arg t "$good_to" '{schema:1,tombstone:true,from:$f,to:$t,relation:"requires",mode:"all",origin:{"repo-id":4242,witness:"w"}}')
good_ebs=$(printf '%s' "$good_eblob" | git hash-object -w --stdin)
good_tbs=$(printf '%s' "$good_tblob" | git hash-object -w --stdin)

# F1: a graph with a valid tombstone passes validate --strict.
{ printf '%s edges/%s.json\n' "$good_ebs" "$good_eid"; printf '%s tombstones/%s.json\n' "$good_tbs" "$good_eid"; } | mk_graph_ref
if "$TD" validate --strict >/dev/null 2>&1; then
    ok "F1: a graph index with a tombstone passes validate --strict"
else
    vout=$("$TD" validate --strict 2>&1)
    bad "F1: valid tombstone tripped validate --strict ($vout)"
fi

# F2: a malformed tombstone-id filename fails validate --strict.
printf '%s tombstones/deadbeef.json\n' "$good_tbs" | mk_graph_ref
if "$TD" validate --strict >/dev/null 2>&1; then
    bad "F2: a malformed tombstone-id filename was not rejected by validate --strict"
else
    ok "F2: a malformed tombstone-id filename fails validate --strict"
fi

git update-ref -d "$TASKDAG_GRAPH_REF" 2>/dev/null || true

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
