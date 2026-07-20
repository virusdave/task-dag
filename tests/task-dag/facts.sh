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
# shellcheck source=/dev/null
source "$LIB_DIR/graph-converge.sh"
# shellcheck source=/dev/null
source "$LIB_DIR/cross-repo.sh"

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
    git update-ref "refs/heads/gh/issues/$n" "$epic"
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

# A completed child makes its structural and dependency parents reachable
# from master ancestry. Only the child is a canonical non-primary parent on
# master's first-parent spine; the other two must never become done facts.
STRUCT_PARENT=$(mk_task "Task: structural parent")
DEP_PARENT=$(mk_task "Task: dependency parent")
CHILD=$(git commit-tree "$EMPTY_TREE" -p "$STRUCT_PARENT" -p "$DEP_PARENT" -m "Task: child")
complete_task "$CHILD"

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

taskdag_node_done "task:owner/repo@$STRUCT_PARENT"; rp=$?
taskdag_node_done "task:owner/repo@$DEP_PARENT"; rd=$?
if [ "$rp" -eq 1 ] && [ "$rd" -eq 1 ] && taskdag_node_done "task:owner/repo@$CHILD"; then
    ok "A3: completed child does not mark structural/dependency parents done"
else
    bad "A3: ancestry leaked a false completion (structural=$rp dependency=$rd)"
fi

# empty-tree guard: the completion merge's FIRST parent is the impl/seed
# commit (non-empty tree). It IS in the parent-token done-set, but must NOT
# be reported done as a task node.
taskdag_node_done "task:owner/repo@$SEED_SHA"; rc=$?
if [ "$rc" -eq 1 ]; then
    ok "A4: an impl (non-empty-tree) SHA is not a done task (empty-tree guard)"
else
    bad "A4: impl SHA wrongly reported done (rc $rc)"
fi

if taskdag_node_done "issue:owner/repo#5"; then
    ok "A5: an issue closed via Closes-Epic trailer is done"
else
    bad "A5: closed issue not reported done"
fi

taskdag_node_done "issue:owner/repo#6"; rc=$?
if [ "$rc" -eq 1 ]; then
    ok "A6: an unclosed issue is not done"
else
    bad "A6: unclosed issue wrong rc ($rc)"
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

# Exact issue identity and merge arity are load-bearing. A matching trailer
# with the wrong root, or a close with an extra parent, is not a close fact.
WRONG_ROOT=$(mk_task "Task: wrong root")
EXTRA=$(mk_task "Task: extra parent")
forged=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -p "$WRONG_ROOT" -m $'Forged close\n\nCloses-Epic: #88')
git update-ref refs/heads/gh/issues/88 "$EXTRA"
git update-ref refs/heads/master "$forged"; git reset -q --soft "$forged"
taskdag_node_done "issue:owner/repo#88"; rc=$?
[ "$rc" -eq 1 ] && ok "C2: matching trailer with the wrong epic root is rejected" || bad "C2: wrong-root close accepted"
too_many=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -p "$EXTRA" -p "$WRONG_ROOT" -m $'Extra-parent close\n\nCloses-Epic: #89')
git update-ref refs/heads/gh/issues/89 "$EXTRA"
git update-ref refs/heads/master "$too_many"; git reset -q --soft "$too_many"
taskdag_node_done "issue:owner/repo#89"; rc=$?
[ "$rc" -eq 1 ] && ok "C3: extra-parent close merge is rejected" || bad "C3: extra-parent close accepted"

EXTRA_TASK=$(mk_task "Task: extra-parent completion target")
extra_completion=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -p "$EXTRA_TASK" -p "$WRONG_ROOT" -m "Not a strict completion")
git update-ref refs/heads/master "$extra_completion"; git reset -q --soft "$extra_completion"
taskdag_node_done "task:owner/repo@$EXTRA_TASK"; rc=$?
[ "$rc" -eq 1 ] && ok "C4: extra-parent task completion merge is rejected" || bad "C4: extra-parent completion accepted"

# Generated adversarial histories exercise the shape predicate across a mix
# of exact witnesses, extra-parent merges, and tree-changing merges. Keep the
# seed fixed so failures reproduce while still checking a family of objects
# rather than one hand-picked example.
RANDOM=67
property_ok=true
for i in {1..16}; do
    candidate=$(mk_task "Task: generated completion $i")
    tip=$(git rev-parse HEAD)
    tree=$(git rev-parse "${tip}^{tree}")
    case $((RANDOM % 3)) in
        0)
            generated=$(git commit-tree "$tree" -p "$tip" -p "$candidate" -m "Exact generated completion")
            expected=0
            ;;
        1)
            generated=$(git commit-tree "$tree" -p "$tip" -p "$candidate" -p "$EXTRA" -m "Generated extra-parent merge")
            expected=1
            ;;
        2)
            changed_blob=$(printf 'generated-%s\n' "$i" | git hash-object -w --stdin)
            changed_tree=$(printf '100644 blob %s\tgenerated\n' "$changed_blob" | git mktree)
            generated=$(git commit-tree "$changed_tree" -p "$tip" -p "$candidate" -m "Generated tree-changing merge")
            expected=1
            ;;
    esac
    git update-ref refs/heads/master "$generated"
    git reset -q --soft "$generated"
    taskdag_task_completed_at_tip HEAD "$candidate"; rc=$?
    [ "$rc" -eq "$expected" ] || property_ok=false
done
git push -q origin master:master
[ "$property_ok" = true ] \
    && ok "C5: generated completion histories accept only exact two-parent tree-equal witnesses" \
    || bad "C5: generated completion shape property failed"

# A delegated issue is a separate node kind: legacy completion refs and
# Satisfies routing hints are not closure authority. Only a create-only v1
# record, parented by the exact delegation and proving the exact peer close,
# may satisfy it.
mkdir -p "$ROOT/peers/nicponskis"
git clone -q "$ROOT/origin.git" "$ROOT/peers/nicponskis/github-worker"
PEER="$ROOT/peers/nicponskis/github-worker"
(
    cd "$PEER"
    git checkout -q -B master origin/master
    peer_root=$(git commit-tree "$EMPTY_TREE" -p HEAD -m $'Task: delegated peer epic\n\nIssue: #901\nType: epic')
    git update-ref refs/heads/gh/issues/901 "$peer_root"
    peer_tip=$(git rev-parse HEAD)
    peer_close=$(git commit-tree "$(git rev-parse "${peer_tip}^{tree}")" -p "$peer_tip" -p "$peer_root" -m $'Close delegated peer epic\n\nCloses-Epic: #901')
    git update-ref refs/heads/master "$peer_close"
    printf '%s\n%s\n%s\n' "$peer_root" "$peer_close" "$peer_close" > "$ROOT/peer-facts"
)
readarray -t peer_facts < "$ROOT/peer-facts"
PEER_ROOT=${peer_facts[0]}; PEER_CLOSE=${peer_facts[1]}; PEER_TIP=${peer_facts[2]}
export TASKDAG_PEER_PATH_PREFIX="$ROOT/peers"
_xrepo_current_repo() { printf 'owner/repo\n'; }

DELEGATION=$(git commit-tree "$EMPTY_TREE" -m $'kind: delegated\nrole: system\nintent: delegated-child\n\nissue:\n  repo: owner/repo\n  number: 90\n\ndelegated:\n  repo: Nicponskis/github-worker\n  number: 901\n\nParent-Repo-Node-Id: PR_1\nParent-Issue-Node-Id: PI_90\nPeer-Repo-Node-Id: RR_1\nPeer-Issue-Node-Id: RI_901\nMaterialisation-Operation-Id: OP_1\nDeclaration-Digest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
git update-ref refs/heads/tasks/delegated/90/Nicponskis/github-worker/901 "$DELEGATION"
LEGACY=$(git commit-tree "$EMPTY_TREE" -p "$DELEGATION" -m 'kind: completion')
git update-ref refs/heads/tasks/completions/90/Nicponskis/github-worker/901/deadbeef "$LEGACY"
if _xrepo_child_satisfied 90 Nicponskis/github-worker/901; then
    bad "C6: legacy completion fact satisfied delegated closure"
else
    ok "C6: legacy completion facts and routing hints do not satisfy delegated closure"
fi

close_record_message() {
    cat <<EOF
Record delegated close

Task-Dag-Delegated-Close: v1
Parent-Repo: owner/repo
Parent-Issue: #90
Peer-Repo: Nicponskis/github-worker
Peer-Issue: #901
Parent-Repo-Node-Id: PR_1
Parent-Issue-Node-Id: PI_90
Peer-Repo-Node-Id: RR_1
Peer-Issue-Node-Id: RI_901
Materialisation-Operation-Id: OP_1
Declaration-Digest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Peer-Tip: $PEER_TIP
Peer-Close: $PEER_CLOSE
Peer-Epic: $PEER_ROOT
EOF
}
CLOSE_RECORD=$(git commit-tree "$EMPTY_TREE" -p "$DELEGATION" -m "$(close_record_message)")
git update-ref refs/heads/tasks/delegated-close/v1/90/Nicponskis/github-worker/901 "$CLOSE_RECORD"
if _xrepo_child_satisfied 90 Nicponskis/github-worker/901; then
    ok "C7: exact parent-authoritative delegated-close record is accepted"
else
    bad "C7: exact delegated-close record was rejected"
fi

MALFORMED_CLOSE=$(git commit-tree "$EMPTY_TREE" -p "$DELEGATION" -p "$EXTRA" -m "$(close_record_message)")
git update-ref refs/heads/tasks/delegated-close/v1/90/Nicponskis/github-worker/901 "$MALFORMED_CLOSE"
if _xrepo_child_satisfied 90 Nicponskis/github-worker/901; then
    bad "C8: extra-parent delegated-close record was accepted"
else
    ok "C8: malformed delegated-close record fails closed"
fi
git update-ref refs/heads/tasks/delegated-close/v1/90/Nicponskis/github-worker/901 "$CLOSE_RECORD"

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
# (unsatisfied); requires → closed issue #5 (satisfied); requires → reachable
# but unfinished structural parent (unsatisfied).
{
    add_edge "$FROM_TASK" "task:owner/repo@$TASK_A" requires all 100 w1
    add_edge "$FROM_TASK" "task:owner/repo@$TASK_B" satisfies any 100 w2
    add_edge "$FROM_TASK" "issue:owner/repo#5"      requires all 100 w3
    add_edge "$FROM_TASK" "task:owner/repo@$STRUCT_PARENT" requires all 100 w4
} | build_graph_ref

facts_out=$(taskdag_edges_with_facts --no-fetch) || bad "D0: edges_with_facts failed"
if printf '%s' "$facts_out" | jq -e '
      length == 4
      and (any(.[]; .relation=="requires" and .to=="task:owner/repo@'"$TASK_A"'" and .satisfied==true))
      and (any(.[]; .relation=="satisfies" and .to=="task:owner/repo@'"$TASK_B"'" and .satisfied==false))
      and (any(.[]; .relation=="requires" and .to=="issue:owner/repo#5" and .satisfied==true))
      and (any(.[]; .relation=="requires" and .to=="task:owner/repo@'"$STRUCT_PARENT"'" and .satisfied==false))
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

# A failed rebuild invalidates both cache keys before touching arrays. Retrying
# after the transient object-read failure must perform a complete derivation,
# never accept partial arrays under the previous generation's memoization key.
FAIL_TASK=$(mk_task "Task: failed rebuild target")
FAIL_BASE=$(command git rev-parse HEAD)
FAIL_MERGE=$(command git commit-tree "$(command git rev-parse "$FAIL_BASE^{tree}")" \
    -p "$FAIL_BASE" -p "$FAIL_TASK" -m 'Completion with transient read failure')
command git update-ref refs/heads/master "$FAIL_MERGE"
git() {
    if [ "$*" = "rev-parse $FAIL_MERGE^{tree}" ]; then return 124; fi
    command git "$@"
}
taskdag_load_facts "$FAIL_MERGE" >/dev/null 2>&1; fail_rebuild_rc=$?
if [ "$fail_rebuild_rc" -eq 2 ] && [ -z "$TASKDAG_FACTS_TIP_OID" ] \
    && [ -z "$TASKDAG_FACTS_ROOTS_DIGEST" ]; then
    ok "E3: failed object read leaves no valid facts-cache generation"
else
    bad "E3: failed rebuild retained a cache key (rc=$fail_rebuild_rc tip=$TASKDAG_FACTS_TIP_OID roots=$TASKDAG_FACTS_ROOTS_DIGEST)"
fi
unset -f git
if taskdag_load_facts "$FAIL_MERGE" && [ "$TASKDAG_FACTS_TIP_OID" = "$FAIL_MERGE" ] \
    && [ -n "${TASKDAG_DONE_TASKS[$FAIL_TASK]:-}" ]; then
    ok "E4: retry after failed rebuild repopulates complete fact arrays"
else
    bad "E4: retry accepted or retained incomplete fact arrays"
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
