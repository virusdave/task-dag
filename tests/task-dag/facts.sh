#!/usr/bin/env bash
# Unit + fixture tests for the DERIVED-FACT layer
# (scripts/task-dag.d/facts.sh, issue #13 north-star): done(node) +
# satisfied(edge)=done(.to), computed purely from master's completion
# history, in memory, with ZERO per-fact refs.
#
# Covers the leaf's closure criteria:
#   • done(task)  from a completion merge's non-first parent, with the
#     empty-tree guard (an impl SHA that appears as a first parent is NOT
#     done);
#   • done(issue) from a `Closes-Epic: #N` TRAILER (body prose does not
#     count), scoped to the current repo;
#   • foreign-repo scoping (same SHA / same issue number in another repo is
#     NOT done from local history);
#   • satisfied(edge)=done(.to) for BOTH requires and satisfies edges, with
#     no readiness/supersede aggregation;
#   • in-memory memoization keyed on the tip OID (cache invalidates when
#     master advances) — property: monotonic + idempotent;
#   • ZERO new refs are created by deriving facts (bounded-ref invariant);
#   • offline (--no-fetch) path + CLI parity;
#   • malformed node fails loud (rc 2).
#
# No network: builds a throwaway bare origin + working clone in a tempdir.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
LIB_DIR="$(dirname "$TD")/task-dag.d"
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
# The fact layer scopes done() to the current repo; use the offline seam so
# no network / gh is needed.
export TASKDAG_CURRENT_REPO="owner/repo"
# shellcheck source=/dev/null
source "$LIB_DIR/edges.sh"
# shellcheck source=/dev/null
source "$LIB_DIR/facts.sh"

# ===========================================================================
# Build a real repo with completion + close history on master.
# ===========================================================================
git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"
cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed
git push -q origin HEAD:master

SEED_SHA=$(git rev-parse HEAD)

# mk_task <message>: mint an empty-tree "task commit" parented on master HEAD
# (exactly the shape task-dag mints). Prints its full SHA.
mk_task() {  # <message>
    git commit-tree "$EMPTY_TREE" -p "$(git rev-parse HEAD)" -m "$1"
}

# complete_task <task_sha>: land a completion merge on master whose FIRST
# parent is the (impl) master tip and whose non-first parent is the task
# commit, carrying the Status/Task-Commit trailer — the authoritative done
# fact — then push so origin/master (the fact tip) advances.
complete_task() {  # <task_sha>
    local task_sha="$1" tip tree merge
    tip=$(git rev-parse HEAD)
    tree=$(git rev-parse "HEAD^{tree}")
    merge=$(git commit-tree "$tree" -p "$tip" -p "$task_sha" -m "Complete work

Task-Commit: $task_sha
Status: completed")
    git update-ref refs/heads/master "$merge"
    git checkout -q master 2>/dev/null || git symbolic-ref HEAD refs/heads/master
    git reset -q --soft "$merge"
    git push -q origin master:master
}

# close_issue <epic_task_sha> <N>: land a Closes-Epic:#N merge on master.
close_issue() {  # <epic_task_sha> <N>
    local epic="$1" n="$2" tip tree merge
    tip=$(git rev-parse HEAD)
    tree=$(git rev-parse "HEAD^{tree}")
    merge=$(git commit-tree "$tree" -p "$tip" -p "$epic" -m "Close epic

Closes-Epic: #$n")
    git update-ref refs/heads/master "$merge"
    git reset -q --soft "$merge"
    git push -q origin master:master
}

# Make sure we are on the master branch for the whole fixture.
git checkout -q -B master

TASK_A=$(mk_task "Task: A")           # will be completed
TASK_B=$(mk_task "Task: B")           # left NOT completed
EPIC5=$(mk_task "Task: epic5")        # will be closed as issue #5

complete_task "$TASK_A"
close_issue "$EPIC5" 5

FROM_TASK="task:owner/repo@$(printf 'a%.0s' {1..40})"

# ===========================================================================
# Part A — done(node)
# ===========================================================================
if taskdag_node_done "task:owner/repo@$TASK_A"; then
    ok "A1: a completed task (completion-merge parent) is done"
else
    bad "A1: completed task not reported done"
fi

taskdag_node_done "task:owner/repo@$TASK_B"; rc=$?
if [ "$rc" -eq 1 ]; then
    ok "A2: an uncompleted task is not done (rc 1)"
else
    bad "A2: uncompleted task wrong rc ($rc)"
fi

# empty-tree guard: the completion merge's FIRST parent is the impl/seed
# commit (non-empty tree). It IS in the parent-token done-set, but must NOT
# be reported done as a task node.
taskdag_node_done "task:owner/repo@$SEED_SHA"; rc=$?
if [ "$rc" -eq 1 ]; then
    ok "A3: an impl (non-empty-tree) SHA is not a done task (empty-tree guard)"
else
    bad "A3: impl SHA wrongly reported done (rc $rc)"
fi

if taskdag_node_done "issue:owner/repo#5"; then
    ok "A4: an issue closed via Closes-Epic trailer is done"
else
    bad "A4: closed issue not reported done"
fi

taskdag_node_done "issue:owner/repo#6"; rc=$?
if [ "$rc" -eq 1 ]; then
    ok "A5: an unclosed issue is not done"
else
    bad "A5: unclosed issue wrong rc ($rc)"
fi

# ===========================================================================
# Part B — current-repo scoping (local history authoritative only here)
# ===========================================================================
taskdag_node_done "issue:foreign/repo#5"; rc=$?
if [ "$rc" -eq 1 ]; then
    ok "B1: a foreign issue with the SAME number is not done (repo-scoped)"
else
    bad "B1: foreign issue#5 wrongly matched local Closes-Epic:#5 (rc $rc)"
fi

taskdag_node_done "task:foreign/repo@$TASK_A"; rc=$?
if [ "$rc" -eq 1 ]; then
    ok "B2: a foreign task with a locally-done SHA is not done (repo-scoped)"
else
    bad "B2: foreign task SHA wrongly reported done (rc $rc)"
fi

# malformed node fails loud
taskdag_node_done "note:owner/repo#1" >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 2 ]; then
    ok "B3: a malformed node fails loud (rc 2)"
else
    bad "B3: malformed node wrong rc ($rc)"
fi

# ===========================================================================
# Part C — Closes-Epic must be a TRAILER, not body prose
# ===========================================================================
tip=$(git rev-parse HEAD); tree=$(git rev-parse "HEAD^{tree}")
prose_merge=$(git commit-tree "$tree" -p "$tip" -p "$(mk_task 'Task: epic77')" -m "Close-ish

Closes-Epic: #77

but this trailing paragraph makes the above a body line, not a trailer.")
git update-ref refs/heads/master "$prose_merge"
git reset -q --soft "$prose_merge"; git push -q origin master:master
taskdag_node_done "issue:owner/repo#77"; rc=$?
if [ "$rc" -eq 1 ]; then
    ok "C1: Closes-Epic in body prose (not the trailer block) does not close"
else
    bad "C1: body-prose Closes-Epic wrongly marked issue done (rc $rc)"
fi

# ===========================================================================
# Part D — satisfied(edge) = done(.to), both relations, no aggregation
# ===========================================================================
add_edge() {  # <from> <to> <relation> <mode> <repo-id> <witness>
    local eid b blobsha
    eid=$(taskdag_edge_id "$1" "$2" "$3" "$4") || return 1
    b=$(taskdag_edge_blob "$1" "$2" "$3" "$4" "$5" "$6") || return 1
    blobsha=$(printf '%s' "$b" | git hash-object -w --stdin)
    printf '%s edges/%s.json\n' "$blobsha" "$eid"
}
build_graph_ref() {  # <blobsha> <path> lines via stdin
    local idx="$ROOT/wc/.graph.index" blobsha path tree commit
    rm -f "$idx"
    while read -r blobsha path; do
        [ -n "$blobsha" ] || continue
        GIT_INDEX_FILE="$idx" git update-index --add --cacheinfo "100644,$blobsha,$path"
    done
    tree=$(GIT_INDEX_FILE="$idx" git write-tree); rm -f "$idx"
    commit=$(git commit-tree "$tree" -m "graph index")
    git update-ref "$TASKDAG_GRAPH_REF" "$commit"
}

# requires → done task A (satisfied); satisfies → not-done task B
# (unsatisfied); requires → closed issue #5 (satisfied).
{
    add_edge "$FROM_TASK" "task:owner/repo@$TASK_A" requires all 100 w1
    add_edge "$FROM_TASK" "task:owner/repo@$TASK_B" satisfies any 100 w2
    add_edge "$FROM_TASK" "issue:owner/repo#5"      requires all 100 w3
} | build_graph_ref

facts_out=$(taskdag_edges_with_facts --no-fetch) || bad "D0: edges_with_facts failed"
if printf '%s' "$facts_out" | jq -e '
      length == 3
      and (any(.[]; .relation=="requires" and .to=="task:owner/repo@'"$TASK_A"'" and .satisfied==true))
      and (any(.[]; .relation=="satisfies" and .to=="task:owner/repo@'"$TASK_B"'" and .satisfied==false))
      and (any(.[]; .relation=="requires" and .to=="issue:owner/repo#5" and .satisfied==true))
    ' >/dev/null 2>&1; then
    ok "D1: satisfied(edge)=done(.to) for requires+satisfies (no aggregation)"
else
    bad "D1: edge facts wrong (got: $facts_out)"
fi

# CLI parity: `task-dag facts --json --no-fetch` == the helper.
cli_out=$("$TD" facts --json --no-fetch 2>/dev/null)
if [ "$cli_out" = "$facts_out" ]; then
    ok "D2: 'task-dag facts --json --no-fetch' matches the helper"
else
    bad "D2: CLI facts diverged (cli=$cli_out helper=$facts_out)"
fi

# single-node CLI query exit code reflects done-ness
"$TD" facts --no-fetch --node "task:owner/repo@$TASK_A" >/dev/null 2>&1; rc=$?
"$TD" facts --no-fetch --node "task:owner/repo@$TASK_B" >/dev/null 2>&1; rc2=$?
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 1 ]; then
    ok "D3: 'facts --node' exits 0 when done, 1 when not done"
else
    bad "D3: facts --node exit codes wrong (done=$rc notdone=$rc2)"
fi

# ===========================================================================
# Part E — in-memory memoization / cache invalidation on tip move
# ===========================================================================
# idempotency: querying twice against the same tip is stable.
taskdag_node_done "task:owner/repo@$TASK_B"; r1=$?
taskdag_node_done "task:owner/repo@$TASK_B"; r2=$?
if [ "$r1" -eq 1 ] && [ "$r2" -eq 1 ] && [ -n "$TASKDAG_FACTS_TIP_OID" ]; then
    ok "E1: repeated done() is idempotent and memoized (tip OID cached)"
else
    bad "E1: memoization/idempotency wrong (r1=$r1 r2=$r2 oid=$TASKDAG_FACTS_TIP_OID)"
fi

# monotonic: completing B and advancing master re-derives (B becomes done),
# and A stays done.
complete_task "$TASK_B"
if taskdag_node_done "task:owner/repo@$TASK_B" && taskdag_node_done "task:owner/repo@$TASK_A"; then
    ok "E2: cache invalidates when master advances (B now done; A still done)"
else
    bad "E2: fact cache did not re-derive after master advanced"
fi

# ===========================================================================
# Part F — ZERO per-fact refs (bounded-ref invariant)
# ===========================================================================
refs_before=$(git for-each-ref --format='%(refname)' | sort)
taskdag_edges_with_facts --no-fetch >/dev/null 2>&1 || true
"$TD" facts --no-fetch >/dev/null 2>&1 || true
"$TD" facts --json --no-fetch --node "issue:owner/repo#5" >/dev/null 2>&1 || true
refs_after=$(git for-each-ref --format='%(refname)' | sort)
if [ "$refs_before" = "$refs_after" ]; then
    ok "F1: deriving facts creates ZERO new refs (no per-fact refs)"
else
    bad "F1: fact derivation changed the ref set:
$(diff <(echo "$refs_before") <(echo "$refs_after"))"
fi

# ===========================================================================
# Part G — offline path with no edges reads an empty set
# ===========================================================================
git update-ref -d "$TASKDAG_GRAPH_REF" 2>/dev/null || true
empty_out=$(taskdag_edges_with_facts --no-fetch)
if [ "$empty_out" = "[]" ]; then
    ok "G1: no active edges ⇒ empty fact set (offline)"
else
    bad "G1: expected [] with no edges (got: $empty_out)"
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
