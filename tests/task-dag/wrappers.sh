#!/usr/bin/env bash
# Fixture tests for the thin edge WRAPPERS over the issue #13 north-star edge
# primitive: `supersede`, `block --downstream --on`, and `delegate` (dual-
# write). Each wrapper is reimplemented over the direct-CAS edge writer
# (edges-write.sh, @2) and verified against the reconcile predicate layer
# (reconcile.sh, @5).
#
# Covers the leaf's closure criteria:
#   • supersede <node> --by <node> mints ONE satisfies edge (from=node,
#     to=by); --dry-run writes nothing; self-supersede + foreign-FROM are
#     rejected; the write is idempotent by edge-id.
#   • the automation#57 scenario end-to-end: supersede a leaf by an issue,
#     the issue completes (durable done fact on master), and the reconcile
#     predicate then reports the superseded leaf COMPLETE (and not ready) —
#     exactly the zombie that had no machine-readable edge before.
#   • block --downstream --on <node> DUAL-WRITEs: legacy blocked overlay PLUS
#     a requires edge (from=this task, to=node); --on implies --downstream,
#     conflicts with --operator, rejects a malformed node, is repeatable and
#     idempotent, and the edge survives `unblock` (edge != overlay).
#   • delegate mints a requires edge (from=epic task-root, to=child issue) in
#     addition to the legacy delegated ref, and BACKFILLS the edge on a re-run
#     over an already-existing legacy delegation.
#
# Driven end-to-end through the real CLI (no stubs beyond a `gh` shim for the
# inherently-GitHub delegate path). No network: a throwaway bare origin +
# working clone in a tempdir.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

command -v jq >/dev/null 2>&1 || { echo "jq is required for this test"; echo "PASS=0 FAIL=1"; exit 1; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
GRAPH_REF="refs/heads/tasks/v1/graph"

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"
cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master
# Offline seams (no gh/network): current repo + numeric repo-id for dep add.
git config taskdag.current-repo owner/repo
git config "taskdag.owner/repo.id" 4242
REPO=owner/repo

# ── helpers (mirror reconcile.sh's real-shape fixtures) ─────────────────────
# mk_task <message> [parent]: mint an empty-tree task commit + a frontier ref
# so it is reachable from `git log --all`. Prints the full SHA.
mk_task() {
    local msg="$1" parent="${2:-$(git rev-parse HEAD)}" sha short
    sha=$(git commit-tree "$EMPTY_TREE" -p "$parent" -m "$msg")
    short=$(git rev-parse --short "$sha")
    git update-ref "refs/heads/tasks/frontier/$short" "$sha"
    printf '%s\n' "$sha"
}
# close_issue <2nd-parent-sha> <N>: land a Closes-Epic:#N merge on master (the
# durable done() fact for issue:<repo>#N) and push so origin advances.
close_issue() {
    local epic="$1" n="$2" tip tree merge
    tip=$(git rev-parse HEAD); tree=$(git rev-parse "HEAD^{tree}")
    merge=$(git commit-tree "$tree" -p "$tip" -p "$epic" -m "Close epic

Closes-Epic: #$n")
    git update-ref refs/heads/master "$merge"
    git symbolic-ref HEAD refs/heads/master 2>/dev/null || true
    git reset -q --soft "$merge"
    git push -q origin master:master
}
graph_tip() { git rev-parse -q --verify "$GRAPH_REF" 2>/dev/null || echo none; }
n_edges()   { "$TD" edges --json --no-fetch 2>/dev/null | jq 'length'; }
has_edge()  { # <from> <to> <relation>
    "$TD" edges --json --no-fetch 2>/dev/null | jq -e --arg f "$1" --arg t "$2" --arg r "$3" \
        'any(.[]; .from==$f and .to==$t and .relation==$r)' >/dev/null 2>&1
}

FORTYc=$(printf 'c%.0s' {1..40})

# ===========================================================================
# Part A — supersede (edge-only satisfies edge).
# ===========================================================================
SUP=$(mk_task "Task: superseded leaf
Type: leaf")
NSUP="task:$REPO@$SUP"

# A1: --dry-run mints nothing (graph ref stays absent) and exits 0.
before=$(graph_tip)
if "$TD" supersede "$NSUP" --by "issue:$REPO#60" --reason "the #57 miss" --dry-run >/dev/null 2>&1 \
        && [ "$(graph_tip)" = "$before" ] && [ "$before" = none ]; then
    ok "A1 supersede --dry-run writes no ref"
else
    bad "A1 supersede --dry-run wrote a ref or failed (tip=$(graph_tip))"
fi

# A2: real supersede mints exactly one satisfies edge (from=node, to=by).
if "$TD" supersede "$NSUP" --by "issue:$REPO#60" --reason "the #57 miss" >/dev/null 2>&1 \
        && has_edge "$NSUP" "issue:$REPO#60" satisfies && [ "$(n_edges)" = 1 ]; then
    ok "A2 supersede mints one satisfies edge (from=node, to=--by)"
else
    bad "A2 supersede did not mint the expected satisfies edge (n=$(n_edges))"
fi

# A3: idempotent — re-running does not create a new graph commit.
tipb=$(graph_tip)
"$TD" supersede "$NSUP" --by "issue:$REPO#60" >/dev/null 2>&1
if [ "$(graph_tip)" = "$tipb" ] && [ "$(n_edges)" = 1 ]; then
    ok "A3 supersede is idempotent (no new commit, still one edge)"
else
    bad "A3 supersede re-run changed state (tip $tipb -> $(graph_tip), n=$(n_edges))"
fi

# A4: a node cannot supersede itself.
if "$TD" supersede "$NSUP" --by "$NSUP" >/dev/null 2>&1; then
    bad "A4 self-supersede was accepted"
else
    ok "A4 self-supersede (<node> == --by) is rejected"
fi

# A5: a foreign-FROM supersede is refused (the graph index is per-repo).
if "$TD" supersede "task:other/repo@$FORTYc" --by "issue:$REPO#60" >/dev/null 2>&1; then
    bad "A5 foreign-FROM supersede was accepted"
else
    ok "A5 foreign-FROM supersede is rejected"
fi

# A6: a malformed node fails loud (never a bogus edge).
if "$TD" supersede "not-a-node" --by "issue:$REPO#60" >/dev/null 2>&1; then
    bad "A6 malformed <node> was accepted"
else
    ok "A6 malformed <node> to supersede fails loud"
fi

# ===========================================================================
# Part B — the automation#57 scenario, end-to-end through the reconcile
# predicate. supersede a leaf by issue #57work; complete #57work; the leaf is
# then COMPLETE (and NOT ready) with no manual complete-historical.
# ===========================================================================
Z57=$(mk_task "Task: automation#57 leaf (real work shipped elsewhere)
Type: leaf")
NZ57="task:$REPO@$Z57"
WORK=$(mk_task "Task: sibling that actually did the work
Type: leaf")
"$TD" supersede "$NZ57" --by "issue:$REPO#57" --reason "re-scoped: shipped in sibling epic #57" >/dev/null 2>&1

# Before #57 is done, the superseded leaf is NOT complete (satisfies edge
# points at a not-yet-done target).
if "$TD" reconcile --no-fetch --node "$NZ57" >/dev/null 2>&1; then
    bad "B1 superseded leaf is complete BEFORE its --by target is done"
else
    ok "B1 superseded leaf is not complete until its --by target is done"
fi

# #57 completes (durable done fact on master).
close_issue "$WORK" 57

# The reconciler now sees the satisfies edge satisfied ⇒ the leaf is COMPLETE.
if "$TD" reconcile --no-fetch --node "$NZ57" >/dev/null 2>&1; then
    ok "B2 #57 scenario: superseded leaf is COMPLETE once --by completes"
else
    bad "B2 #57 scenario: superseded leaf did NOT become complete"
fi
# A complete node is never a pickable leaf.
if "$TD" reconcile --no-fetch --ready --node "$NZ57" >/dev/null 2>&1; then
    bad "B3 #57 scenario: a superseded (complete) leaf is still 'ready'"
else
    ok "B3 #57 scenario: a superseded (complete) leaf is NOT ready"
fi

# ===========================================================================
# Part C — block --downstream --on (dual-write requires edge).
# ===========================================================================
BT=$(mk_task "Task: blocked-on-downstream leaf
Type: leaf")
git push -q origin "refs/heads/tasks/frontier/$(git rev-parse --short "$BT")"
NBT="task:$REPO@$BT"

# C1: --on writes BOTH the requires edge(s) AND the legacy blocked overlay.
nbefore=$(n_edges)
if "$TD" block "$BT" --downstream --on "issue:$REPO#60" --on "task:$REPO@$FORTYc" --reason="awaits #60 + task" >/dev/null 2>&1 \
        && has_edge "$NBT" "issue:$REPO#60" requires \
        && has_edge "$NBT" "task:$REPO@$FORTYc" requires; then
    ok "C1 block --on mints a requires edge per --on node (dual-write)"
else
    bad "C1 block --on did not mint the expected requires edges"
fi
# The legacy blocked overlay is still authoritative (task shows up as blocked).
if "$TD" blocked --no-fetch --json 2>/dev/null | jq -e --arg s "$BT" 'any(.[]; .sha==$s and .kind=="downstream")' >/dev/null 2>&1; then
    ok "C2 block --on keeps the legacy blocked overlay (downstream kind)"
else
    bad "C2 block --on did not record the legacy blocked overlay"
fi

# C3: --on conflicts with --operator.
if "$TD" block "$BT" --operator --on "issue:$REPO#60" >/dev/null 2>&1; then
    bad "C3 --operator --on was accepted"
else
    ok "C3 --operator --on is rejected (a downstream dependency)"
fi

# C4: a malformed --on node fails loud.
BT2=$(mk_task "Task: another leaf
Type: leaf")
if "$TD" block "$BT2" --on "garbage" >/dev/null 2>&1; then
    bad "C4 malformed --on node was accepted"
else
    ok "C4 malformed --on node fails loud"
fi

# C5: idempotent — re-running block --on does not create a new graph commit.
tipc=$(graph_tip)
"$TD" block "$BT" --downstream --on "issue:$REPO#60" --on "task:$REPO@$FORTYc" >/dev/null 2>&1
if [ "$(graph_tip)" = "$tipc" ]; then
    ok "C5 block --on is idempotent (no new graph commit on re-run)"
else
    bad "C5 block --on re-run created a new graph commit ($tipc -> $(graph_tip))"
fi

# C6: unblock clears the overlay but the dual-written edge survives (edge is
# machine-readable dependency state, not the manual park overlay).
edges_before_unblock=$(n_edges)
"$TD" unblock "$BT" >/dev/null 2>&1
if [ "$(n_edges)" = "$edges_before_unblock" ] \
        && ! "$TD" blocked --no-fetch --json 2>/dev/null | jq -e --arg s "$BT" 'any(.[]; .sha==$s)' >/dev/null 2>&1; then
    ok "C6 unblock clears the overlay; the requires edge(s) survive"
else
    bad "C6 unblock unexpectedly changed the edge set or left the overlay"
fi

# ===========================================================================
# Part D — delegate dual-write (requires edge from epic task-root to child
# issue). Needs a `gh` shim for the inherently-GitHub read/edit of the epic
# body; the epic ref is pre-seeded so ensure-issue-epic needs no network.
# ===========================================================================
mkdir -p "$ROOT/bin"
cat > "$ROOT/bin/gh" <<'GH'
#!/usr/bin/env bash
# Minimal gh shim for the delegate path.
case "$1 $2" in
    "repo view") echo "owner/repo" ;;                # --json nameWithOwner -q .nameWithOwner
    "issue view") echo "" ;;                          # --json body -q .body (empty body)
    "issue edit") exit 0 ;;                            # --body-file <f>
    *) exit 0 ;;
esac
GH
chmod +x "$ROOT/bin/gh"
export PATH="$ROOT/bin:$PATH"

EPIC=$(mk_task "Task: parent epic
Issue: #100
Type: epic")
git update-ref "refs/heads/gh/issues/100" "$EPIC"   # ensure-issue-epic finds it, no gh
NEPIC="task:$REPO@$EPIC"

# D1: delegate mints a requires edge (epic requires the child issue).
if "$TD" delegate --issue 100 --to "peer/repo#7" >/dev/null 2>&1 \
        && has_edge "$NEPIC" "issue:peer/repo#7" requires; then
    ok "D1 delegate mints a requires edge (epic -> child issue)"
else
    bad "D1 delegate did not mint the expected requires edge"
fi

# D2: BACKFILL — a legacy delegation that already exists must still get its
# edge on a re-run (the early-return that skipped edge creation is removed).
# Drop the edge, keep the legacy delegated ref, and re-run delegate.
eid=$("$TD" edges --json --no-fetch 2>/dev/null | jq -r --arg f "$NEPIC" '.[] | select(.from==$f and .to=="issue:peer/repo#7") | .edgeId')
"$TD" dep drop "$eid" >/dev/null 2>&1
if has_edge "$NEPIC" "issue:peer/repo#7" requires; then
    bad "D2 setup: edge was not dropped"
else
    "$TD" delegate --issue 100 --to "peer/repo#7" >/dev/null 2>&1
    if has_edge "$NEPIC" "issue:peer/repo#7" requires; then
        ok "D2 delegate BACKFILLS the edge over an existing legacy delegation"
    else
        bad "D2 delegate did not backfill the edge on re-run"
    fi
fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
