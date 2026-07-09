#!/usr/bin/env bash
# Fixture + property tests for the RECONCILE predicate layer
# (scripts/task-dag.d/reconcile.sh, issue #13 north-star): the complete() and
# leaf-readiness aggregation over the containment tree + requires/satisfies
# edges, built on the raw done/satisfied facts.
#
# Covers the leaf's closure criteria (the north-star complete() pseudocode):
#   • done(node) short-circuit;
#   • supersede: ANY satisfied outgoing satisfies-edge ⇒ complete (short-
#     circuits before the epic branch, even with unsatisfied requires-edges);
#   • epic obligations = first-parent children ∪ outgoing requires-edges:
#     complete iff obligations NON-EMPTY and every child subtree complete and
#     every requires-edge satisfied (requires = ALL);
#   • the non-empty-obligations guard (a childless, requires-less, not-done
#     node is NOT vacuously complete);
#   • leaf-readiness = not complete + every requires-edge satisfied + (current-
#     repo task node) unclaimed + unblocked;
#   • PROPERTY invariants: idempotency (twice ≡ once), monotonicity (advancing
#     master / more completions can't un-complete), order-independence of node
#     evaluation, supersede-correctness (a satisfied satisfies-edge ⟹ the
#     dependent is complete), and boundedness (reconcile creates ZERO refs);
#   • CLI parity + exit codes (--node/--ready/--json/--no-fetch), malformed
#     node fails loud (rc 2).
#
# Driven end-to-end through the real CLI so the actual sourced helpers
# (is_task_commit, containment map, is_task_blocked, ...) are exercised — no
# stubs. No network: a throwaway bare origin + working clone in a tempdir.
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

# ── assertion helpers driven through the CLI ────────────────────────────────
# rc_of <expected-rc> <label> -- <cmd...>: run cmd, compare exit status.
rc_of() {
    local want="$1" label="$2"; shift 3   # drop want,label,'--'
    local got; "$@" >/dev/null 2>&1; got=$?
    if [ "$got" -eq "$want" ]; then ok "$label"; else bad "$label (rc=$got want=$want)"; fi
}
# complete_is <yes|no> <label> <node>
complete_is() {
    local exp="$1" label="$2" node="$3"
    if [ "$exp" = yes ]; then rc_of 0 "$label" -- "$TD" reconcile --no-fetch --node "$node"
    else rc_of 1 "$label" -- "$TD" reconcile --no-fetch --node "$node"; fi
}
# ready_is <yes|no> <label> <node>
ready_is() {
    local exp="$1" label="$2" node="$3"
    if [ "$exp" = yes ]; then rc_of 0 "$label" -- "$TD" reconcile --no-fetch --ready --node "$node"
    else rc_of 1 "$label" -- "$TD" reconcile --no-fetch --ready --node "$node"; fi
}

# ===========================================================================
# Build a real origin + clone with a containment tree + completion history.
# ===========================================================================
git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"
cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master
# Offline seams (no gh/network): current repo + numeric repo-id for dep add.
git config taskdag.current-repo owner/repo
git config "taskdag.owner/repo.id" 4242
REPO=owner/repo

# mk_task <message> [parent]: mint an empty-tree task commit (exactly the shape
# task-dag mints), parented on <parent> (default: current master HEAD). Also
# publishes a frontier/<short> ref so it is reachable from `git log --all`
# (the containment-map scan reads refs). Prints the full SHA.
mk_task() {
    local msg="$1" parent="${2:-$(git rev-parse HEAD)}" sha short
    sha=$(git commit-tree "$EMPTY_TREE" -p "$parent" -m "$msg")
    short=$(git rev-parse --short "$sha")
    git update-ref "refs/heads/tasks/frontier/$short" "$sha"
    printf '%s\n' "$sha"
}
# complete_task <task_sha>: land a completion merge on master (2nd parent =
# task commit) — the authoritative `done` fact — and push so origin advances.
complete_task() {
    local task_sha="$1" tip tree merge
    tip=$(git rev-parse HEAD); tree=$(git rev-parse "HEAD^{tree}")
    merge=$(git commit-tree "$tree" -p "$tip" -p "$task_sha" -m "Complete work

Task-Commit: $task_sha
Status: completed")
    git update-ref refs/heads/master "$merge"
    git symbolic-ref HEAD refs/heads/master 2>/dev/null || true
    git reset -q --soft "$merge"
    git push -q origin master:master
}
# close_issue <epic_task_sha> <N>: land a Closes-Epic:#N merge on master.
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
add_edge() {  # <from> <to> <relation>
    "$TD" dep add --from "$1" --to "$2" --relation "$3" --repo-id 4242 --witness w >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Fixture: an epic root R with two containment children C1, C2. A standalone
# leaf L. Two issues (#5, #6) as edge targets.
# ---------------------------------------------------------------------------
R=$(mk_task "Task: epic root
Type: epic")
C1=$(mk_task "Task: child one
Type: leaf" "$R")
C2=$(mk_task "Task: child two
Type: leaf" "$R")
L=$(mk_task "Task: standalone leaf
Type: leaf")

NR="task:$REPO@$R"; NC1="task:$REPO@$C1"; NC2="task:$REPO@$C2"; NL="task:$REPO@$L"

# ===========================================================================
# Part A — complete() core semantics.
# ===========================================================================
# A1: a not-done leaf with no obligations is NOT complete.
complete_is no "A1 not-done leaf is incomplete" "$NL"
# A2: an epic with no completed children is NOT complete.
complete_is no "A2 epic with no done children is incomplete" "$NR"
# A3: completing a leaf makes it complete (done short-circuit).
complete_task "$L"
complete_is yes "A3 done leaf is complete" "$NL"
# A4: epic still incomplete until EVERY child subtree is complete.
complete_task "$C1"
complete_is no "A4 epic with one done child is still incomplete" "$NR"
complete_task "$C2"
complete_is yes "A5 epic complete once all children done" "$NR"

# A6: a fresh childless, not-done node is incomplete.
X=$(mk_task "Task: lonely
Type: leaf")
NX="task:$REPO@$X"
complete_is no "A6 childless not-done node is incomplete" "$NX"

# A7: a LEAF's requires-edge does NOT make it complete — a leaf still needs
# its own completion (done fact). Its requires-edge gates readiness (Part C),
# never completeness. Even with the requires-edge SATISFIED, X stays
# incomplete until it is itself done.
close_issue "$R" 5                      # #5 is now a durable done fact
add_edge "$NX" "issue:$REPO#5" requires # satisfied requires-edge on a leaf
complete_is no "A7 satisfied requires-edge does NOT complete a leaf" "$NX"

# A8: an EPIC's requires-edge (mode=all) DOES gate completeness — obligations
# = children ∪ requires-edges. Build a fresh epic whose children are all done
# but which carries an unsatisfied requires-edge, then satisfy it.
E=$(mk_task "Task: epic with a requires-edge
Type: epic")
EC=$(mk_task "Task: epic child
Type: leaf" "$E")
NE="task:$REPO@$E"
complete_task "$EC"                       # every child done
add_edge "$NE" "issue:$REPO#7" requires  # ...but an unsatisfied obligation
complete_is no "A8 epic incomplete while a requires-edge is unsatisfied" "$NE"
close_issue "$E" 7
complete_is yes "A9 epic complete once children done AND requires satisfied" "$NE"

# ===========================================================================
# Part B — supersede (satisfies=any) short-circuit.
# ===========================================================================
Y=$(mk_task "Task: superseded
Type: leaf")
NY="task:$REPO@$Y"
# Y also carries an UNsatisfied requires-edge, to prove satisfies short-
# circuits BEFORE the epic/requires branch.
add_edge "$NY" "issue:$REPO#6" requires
complete_is no "B1 not-done node with unsatisfied requires is incomplete" "$NY"
# A satisfies-edge to an already-done target (issue #5 is closed) ⇒ complete.
add_edge "$NY" "issue:$REPO#5" satisfies
complete_is yes "B2 satisfied satisfies-edge supersedes (ignores requires)" "$NY"
# B3: a satisfies-edge to a NOT-done target does not complete.
Z=$(mk_task "Task: not superseded
Type: leaf")
NZ="task:$REPO@$Z"
add_edge "$NZ" "issue:$REPO#6" satisfies
complete_is no "B3 unsatisfied satisfies-edge does not complete" "$NZ"

# ===========================================================================
# Part C — leaf-readiness.
# ===========================================================================
# A fresh not-done, no-requires, unclaimed, unblocked leaf is READY.
Rdy=$(mk_task "Task: ready leaf
Type: leaf")
NRDY="task:$REPO@$Rdy"
ready_is yes "C1 fresh leaf is ready" "$NRDY"
# A complete node is NOT ready.
ready_is no "C2 complete node is not ready" "$NL"
# An unsatisfied requires-edge ⇒ not ready.
add_edge "$NRDY" "issue:$REPO#6" requires
ready_is no "C3 unsatisfied requires-edge ⇒ not ready" "$NRDY"
# Satisfy it (close #6) ⇒ ready again.
close_issue "$R" 6
ready_is yes "C4 satisfied requires-edge ⇒ ready" "$NRDY"
# Blocked ⇒ not ready.
git update-ref "refs/heads/tasks/blocked/$Rdy" "$Rdy"
ready_is no "C5 blocked leaf is not ready" "$NRDY"
git update-ref -d "refs/heads/tasks/blocked/$Rdy"
ready_is yes "C6 unblocked again ⇒ ready" "$NRDY"
# Claimed (tasks/active/<short>) ⇒ not ready.
RDYSHORT=$(git rev-parse --short "$Rdy")
git update-ref "refs/heads/tasks/active/$RDYSHORT" "$Rdy"
ready_is no "C7 claimed leaf is not ready" "$NRDY"
git update-ref -d "refs/heads/tasks/active/$RDYSHORT"

# ===========================================================================
# Part D — PROPERTY invariants.
# ===========================================================================
# D1 idempotency: evaluating the same node twice yields the same verdict.
v1=$("$TD" reconcile --no-fetch --json --node "$NR"); v2=$("$TD" reconcile --no-fetch --json --node "$NR")
if [ "$v1" = "$v2" ] && [ "$(printf '%s' "$v1" | jq -r .complete)" = true ]; then
    ok "D1 complete() is idempotent (twice ≡ once)"
else bad "D1 complete() not idempotent (v1=$v1 v2=$v2)"; fi

# D2 order-independence: a node's verdict is the same whether evaluated in
# isolation (--node) or as part of the whole-graph table (which iterates every
# edge-source node) — evaluation order must not change any verdict.
W=$(mk_task "Task: order test
Type: leaf")
NW="task:$REPO@$W"
add_edge "$NW" "issue:$REPO#5" requires      # #5 closed (satisfied)
add_edge "$NW" "issue:$REPO#6" requires      # #6 closed (satisfied)
solo=$("$TD" reconcile --no-fetch --json --node "$NW" | jq -c '{complete,ready}')
intable=$("$TD" reconcile --no-fetch --json | jq -c --arg n "$NW" '.[] | select(.node==$n) | {complete,ready}')
# NW is a not-done leaf whose two requires-edges are both satisfied ⇒ NOT
# complete but READY; the invariant is that both evaluation paths agree.
if [ -n "$solo" ] && [ "$solo" = "$intable" ] && [ "$(printf '%s' "$solo" | jq -r .ready)" = true ]; then
    ok "D2 verdict is order-independent (solo ≡ in-table)"
else bad "D2 verdict order-dependent (solo=$solo table=$intable)"; fi

# D3 monotonicity: a node that is complete stays complete after master
# advances with MORE completions (completion is monotonic; can't un-complete).
before=$("$TD" reconcile --no-fetch --node "$NR" >/dev/null 2>&1; echo $?)
Extra=$(mk_task "Task: extra unrelated
Type: leaf"); complete_task "$Extra"
after=$("$TD" reconcile --no-fetch --node "$NR" >/dev/null 2>&1; echo $?)
if [ "$before" = 0 ] && [ "$after" = 0 ]; then
    ok "D3 complete() is monotonic (advancing master never un-completes)"
else bad "D3 monotonicity violated (before=$before after=$after)"; fi

# D4 supersede-correctness: a satisfied satisfies-edge ⟹ the dependent is
# complete AND stays complete if its target's completion is later reinforced.
complete_is yes "D4 supersede-correctness (satisfied ⟹ complete)" "$NY"

# D5 boundedness: reconcile creates ZERO new refs (bounded-ref invariant).
before_refs=$(git for-each-ref | wc -l)
"$TD" reconcile --no-fetch >/dev/null 2>&1
"$TD" reconcile --no-fetch --json >/dev/null 2>&1
"$TD" reconcile --no-fetch --node "$NR" >/dev/null 2>&1 || true
after_refs=$(git for-each-ref | wc -l)
if [ "$before_refs" = "$after_refs" ]; then
    ok "D5 reconcile creates zero refs (bounded)"
else bad "D5 reconcile changed ref count ($before_refs → $after_refs)"; fi

# ===========================================================================
# Part E — CLI surface + parity.
# ===========================================================================
# E1 text single-node complete.
out=$("$TD" reconcile --no-fetch --node "$NL")
[ "$out" = "$(printf '%s\tcomplete' "$NL")" ] && ok "E1 --node text: complete" || bad "E1 --node text (got: $out)"
# E2 text single-node incomplete (NX is a not-done leaf throughout).
out=$("$TD" reconcile --no-fetch --node "$NX")
[ "$out" = "$(printf '%s\tincomplete' "$NX")" ] && ok "E2 --node text: incomplete" || bad "E2 --node text (got: $out)"
# E3 --ready text.
out=$("$TD" reconcile --no-fetch --ready --node "$NRDY")
[ "$out" = "$(printf '%s\tready' "$NRDY")" ] && ok "E3 --ready text: ready" || bad "E3 --ready text (got: $out)"
# E4 --json single-node shape.
js=$("$TD" reconcile --no-fetch --json --node "$NR")
if [ "$(printf '%s' "$js" | jq -r '.node')" = "$NR" ] \
   && [ "$(printf '%s' "$js" | jq -r '.complete')" = true ] \
   && [ "$(printf '%s' "$js" | jq 'has("ready")')" = true ]; then
    ok "E4 --json single-node shape {node,complete,ready}"
else bad "E4 --json single-node shape (got: $js)"; fi
# E5 --json table is a valid array of the shape.
arr=$("$TD" reconcile --no-fetch --json)
if printf '%s' "$arr" | jq -e 'type=="array" and all(.[]; has("node") and has("complete") and has("ready"))' >/dev/null; then
    ok "E5 --json table is an array of {node,complete,ready}"
else bad "E5 --json table shape (got: $arr)"; fi
# E6 human table has a header + rows and exits 0. Capture first (a `| grep -q`
# would SIGPIPE the producer under pipefail and false-fail).
tbl=$("$TD" reconcile --no-fetch 2>/dev/null)
if printf '%s\n' "$tbl" | grep -q "COMPLETE"; then
    ok "E6 human table renders a header"
else bad "E6 human table missing header"; fi
# E7 malformed node fails loud (rc 2).
rc_of 2 "E7 malformed node ⇒ rc 2" -- "$TD" reconcile --no-fetch --node "not-a-node"
# E9 fail-CLOSED: a current-repo task node that is NOT present locally as a
# task commit is indeterminate ⇒ rc 2 (never silently reported ready/complete).
BOGUS40=$(printf 'f%.0s' {1..40})
rc_of 2 "E9 unresolvable current-repo task node ⇒ rc 2 (complete)" -- "$TD" reconcile --no-fetch --node "task:$REPO@$BOGUS40"
rc_of 2 "E10 unresolvable current-repo task node ⇒ rc 2 (--ready)" -- "$TD" reconcile --no-fetch --ready --node "task:$REPO@$BOGUS40"
# E11 a FOREIGN-repo task node is not locally derivable ⇒ not complete (rc 1),
# NOT an error (its completion is carried by the cross-repo siblings).
rc_of 1 "E11 foreign-repo task node ⇒ incomplete (not an error)" -- "$TD" reconcile --no-fetch --node "task:other/repo@$BOGUS40"
# E12 an issue node closed via Closes-Epic is complete (leaf branch, done()).
rc_of 0 "E12 closed issue node ⇒ complete" -- "$TD" reconcile --no-fetch --node "issue:$REPO#5"
# E8 --no-fetch offline path works (used throughout above) — confirm it does
# NOT try origin by pointing origin at a bogus path and still succeeding.
( git remote set-url origin /nonexistent/nope.git
  "$TD" reconcile --no-fetch --node "$NL" >/dev/null 2>&1 ) \
  && ok "E8 --no-fetch is fully offline" || bad "E8 --no-fetch touched origin"
git remote set-url origin "$ROOT/origin.git"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
