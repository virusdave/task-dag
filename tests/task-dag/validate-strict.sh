#!/usr/bin/env bash
# Fixture smoke test for `task-dag validate --strict` — the full-namespace
# invariant-floor audit that catches hand-crafted / surgery'd task refs.
#
# Builds a throwaway bare origin + working clone in a tempdir (no network,
# no real repo). Verifies:
#   • a well-formed DAG (empty-tree commits under known namespaces) PASSES,
#   • a ref under an UNKNOWN namespace FAILS (the hand-crafted-ref catcher),
#   • a ref pointing at a NON-empty-tree commit FAILS,
#   • the invariant floor never false-flags a legacy commit (no
#     Task-Dag-Format trailer required),
#   • --json reports the strict flag + error count,
#   • a clean DAG still passes non-strict validate.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

# `validate --json` now emits its summary via `jq -nc` (compact JSON), and the
# --json subtests (3, 9) assert on it structurally with `jq -e`. jq is a
# de-facto dependency of these paths; require it so the checks are real.
command -v jq >/dev/null 2>&1 || { echo "jq is required for this test"; echo "PASS=0 FAIL=1"; exit 1; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"
cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master

# Helper: mint an empty-tree commit and point a ref at it.
mk_ref() {  # <full-ref> <message>
    local ref="$1" msg="$2" sha
    sha=$(git commit-tree "$EMPTY_TREE" -m "$msg")
    git update-ref "$ref" "$sha"
}

# --- Build a well-formed DAG spanning every known namespace ---
mk_ref refs/heads/tasks/pending/42        "Task: Epic
Issue: #42
Type: epic"
mk_ref refs/heads/gh/issues/42            "Task: Epic
Issue: #42
Type: epic"
mk_ref refs/heads/tasks/frontier/aaaaaaa  "Task: A leaf
Type: leaf"
mk_ref refs/heads/tasks/active/bbbbbbb    "Task-Commit: deadbeef
Claimer: me"
mk_ref refs/heads/gh/comments/42/999      "kind: message
role: human
intent: comment"
mk_ref "refs/heads/tasks/completions/42/o/r/1/deadbeef" "kind: completion"
mk_ref "refs/heads/tasks/delegated/42/o/r/1"            "kind: delegated"
mk_ref "refs/heads/gh/child-epics/42/o/r"              "kind: child-epic"
# Named-slot child-epic marker (slug namespace) — a valid, tool-minted ref.
# This is the golden fixture for the child-epic-slots namespace: it would
# FAIL --strict before that namespace was added to TASKDAG_KNOWN_GH_NS and
# must PASS after (see docs/INVARIANTS.md known-namespace table).
mk_ref "refs/heads/gh/child-epic-slots/42/o/r/agent-waste"  "kind: child-epic"

# ---------------------------------------------------------------------------
# TEST 1: a well-formed DAG passes --strict (exit 0)
# ---------------------------------------------------------------------------
if "$TD" validate --strict >/dev/null 2>&1; then
    ok "1: well-formed DAG passes validate --strict"
else
    bad "1: well-formed DAG unexpectedly failed validate --strict"
fi

# ---------------------------------------------------------------------------
# TEST 2: --all-refs is an accepted alias for --strict
# ---------------------------------------------------------------------------
if "$TD" validate --all-refs >/dev/null 2>&1; then
    ok "2: --all-refs alias passes on a well-formed DAG"
else
    bad "2: --all-refs alias errored on a well-formed DAG"
fi

# ---------------------------------------------------------------------------
# TEST 3: legacy commit (NO Task-Dag-Format trailer) is not flagged
#         (the invariant floor is grandfather-safe)
# ---------------------------------------------------------------------------
out=$("$TD" validate --strict --json 2>/dev/null)
# Parse structurally with jq (the summary is now emitted by `jq -nc`, i.e.
# compact JSON with no spaces after ':'), not by grepping literal spacing.
if echo "$out" | jq -e '.errors == 0 and .strict == true' >/dev/null 2>&1; then
    ok "3: --json reports strict:true and 0 errors on legacy-format commits"
else
    bad "3: --json did not report strict:true / 0 errors (got: $out)"
fi

# ---------------------------------------------------------------------------
# TEST 4: a ref under an UNKNOWN namespace FAILS --strict (surgery catcher)
# ---------------------------------------------------------------------------
mk_ref refs/heads/tasks/bogus/xyz "hand-crafted junk"
if "$TD" validate --strict >/dev/null 2>&1; then
    bad "4: unknown-namespace ref did NOT fail validate --strict"
else
    ok "4: unknown-namespace ref correctly fails validate --strict"
fi
# and the message names the offending namespace. NOTE: capture output
# first — piping `validate` (which exits 3 here) straight into grep would,
# under `set -o pipefail`, report the pipeline as failed on validate's
# intended non-zero even when grep matches.
strict_out=$("$TD" validate --strict 2>&1 || true)
if echo "$strict_out" | grep -q "UNKNOWN tasks namespace 'bogus'"; then
    ok "4b: strict output names the unknown namespace"
else
    bad "4b: strict output did not name the unknown namespace (got: $strict_out)"
fi
git update-ref -d refs/heads/tasks/bogus/xyz

# ---------------------------------------------------------------------------
# TEST 5: a ref pointing at a NON-empty-tree commit FAILS --strict
# ---------------------------------------------------------------------------
realtree=$(git rev-parse 'HEAD^{tree}')
nonempty=$(git commit-tree "$realtree" -m "not an empty tree")
git update-ref refs/heads/tasks/frontier/ccccccc "$nonempty"
if "$TD" validate --strict >/dev/null 2>&1; then
    bad "5: non-empty-tree task ref did NOT fail validate --strict"
else
    ok "5: non-empty-tree task ref correctly fails validate --strict"
fi
git update-ref -d refs/heads/tasks/frontier/ccccccc

# ---------------------------------------------------------------------------
# TEST 6: clean DAG passes non-strict validate too (no regression)
# ---------------------------------------------------------------------------
if "$TD" validate >/dev/null 2>&1; then
    ok "6: clean DAG passes default (non-strict) validate"
else
    bad "6: clean DAG failed default validate"
fi

# ---------------------------------------------------------------------------
# TEST 7: a frontier ref that is a `kind: message` comment task (no `Type:`
#         field) is a VALID leaf and must NOT crash validate under `set -e`
#         nor be flagged as mistyped. Regression guard for the extract_field
#         non-zero-on-missing-field crash the counter-loop fix surfaced (seen
#         on the real top-level DAG). git forbids non-commit refs under
#         refs/heads/, so the blob/tag case is structurally impossible here.
# ---------------------------------------------------------------------------
mk_ref refs/heads/tasks/frontier/ddddddd "kind: message
role: human
intent: comment

body: |
  a human comment task with no Type field"
rc=0; out=$("$TD" validate 2>&1) || rc=$?
if [ "$rc" -eq 0 ] && ! echo "$out" | grep -q "ddddddd"; then
    ok "7: kind:message frontier task doesn't crash validate and isn't flagged"
else
    bad "7: message-task frontier ref crashed or was flagged (rc=$rc, out=$out)"
fi
# and --strict must also treat it as clean (valid leaf, empty tree, known ns)
if "$TD" validate --strict >/dev/null 2>&1; then
    ok "7b: kind:message frontier task passes --strict"
else
    bad "7b: kind:message frontier task failed --strict"
fi
git update-ref -d refs/heads/tasks/frontier/ddddddd

# ---------------------------------------------------------------------------
# TEST 8: a ref under an UNKNOWN gh namespace FAILS --strict
#         (regression guard: the gh snapshot must cover ALL of gh/, not just
#         the known sub-namespaces, or this check is dead code)
# ---------------------------------------------------------------------------
mk_ref refs/heads/gh/bogus/x "hand-crafted gh junk"
rc=0; out=$("$TD" validate --strict 2>&1) || rc=$?
if [ "$rc" -eq 3 ] && echo "$out" | grep -q "UNKNOWN gh namespace 'bogus'"; then
    ok "8: unknown gh namespace is reported (exit 3)"
else
    bad "8: unknown gh namespace not reported (rc=$rc, out=$out)"
fi
git update-ref -d refs/heads/gh/bogus/x

# ---------------------------------------------------------------------------
# TEST 9: --strict --json WITH violations emits JSON and exits 3
# ---------------------------------------------------------------------------
mk_ref refs/heads/tasks/bogus/xyz "junk"
rc=0; out=$("$TD" validate --strict --json 2>/dev/null) || rc=$?
# Structural jq assertion (compact `jq -nc` summary), not literal-space grep.
if [ "$rc" -eq 3 ] \
    && echo "$out" | jq -e '.valid == false and .strict == true and (.errors > 0)' >/dev/null 2>&1; then
    ok "9: --strict --json with violations emits JSON (valid:false) and exits 3"
else
    bad "9: --strict --json with violations wrong (rc=$rc, out=$out)"
fi
git update-ref -d refs/heads/tasks/bogus/xyz

# ---------------------------------------------------------------------------
# TEST 10: a `child-epic-slots` ref pointing at a NON-empty-tree commit FAILS
#          --strict. The namespace is KNOWN (so this isolates the empty-tree
#          floor, not the namespace check) and the slug path is well-formed,
#          so the only reason it fails is the invariant floor. Slug-charset
#          validation is the MINTER's job (valid_slug), NOT the strict floor —
#          this test deliberately does not assert charset rejection here.
# ---------------------------------------------------------------------------
realtree=$(git rev-parse 'HEAD^{tree}')
nonempty=$(git commit-tree "$realtree" -m "child-epic-slots marker with a non-empty tree")
git update-ref refs/heads/gh/child-epic-slots/42/o/r/bad-tree "$nonempty"
rc=0; out=$("$TD" validate --strict 2>&1) || rc=$?
if [ "$rc" -eq 3 ] && echo "$out" | grep -qi "non-empty tree"; then
    ok "10: non-empty-tree child-epic-slots ref fails validate --strict"
else
    bad "10: non-empty-tree child-epic-slots ref did not fail correctly (rc=$rc, out=$out)"
fi
git update-ref -d refs/heads/gh/child-epic-slots/42/o/r/bad-tree

# ---------------------------------------------------------------------------
# TEST 11: the dependency-graph index branch tasks/v1/graph is the ONE ref
#          exempt from the empty-tree floor. A commit whose tree is a
#          well-formed edge set (only edges/<64-hex>.json blobs) MUST PASS
#          --strict, even though its tree is non-empty. This is the golden
#          fixture for the new ref kind (docs/INVARIANTS.md §
#          "The dependency-graph index"). It must land BEFORE the writer
#          sibling starts minting the ref (INVARIANTS.md ordering rule).
# ---------------------------------------------------------------------------
# git mktree rejects slashed paths, so build the (nested) graph tree via a
# scratch index — this is how a real edge writer would stage edges/<id>.json.
mk_graph_ref() {  # <path>=<blobsha> pairs via "<blobsha> <path>" stdin lines
    local idx bsha pth tree commit
    idx="$ROOT/.graph.index"; rm -f "$idx"   # fresh path (an empty file is not a valid index)
    while read -r bsha pth; do
        [ -n "$bsha" ] || continue
        GIT_INDEX_FILE="$idx" git update-index --add --cacheinfo "100644,$bsha,$pth"
    done
    tree=$(GIT_INDEX_FILE="$idx" git write-tree)
    rm -f "$idx"
    commit=$(git commit-tree "$tree" -m "graph index")
    git update-ref refs/heads/tasks/v1/graph "$commit"
}
edge_id=$(printf 'a%.0s' {1..64})   # a syntactically valid 64-hex edge-id
edge_blob=$(git hash-object -w --stdin <<EOF
{"schema":1,"from":"task:o/r@$(printf '1%.0s' {1..40})","to":"issue:o/r#1","relation":"requires","mode":"all","origin":{"repo-id":42,"witness":"w"}}
EOF
)
printf '%s edges/%s.json\n' "$edge_blob" "$edge_id" | mk_graph_ref
if "$TD" validate --strict >/dev/null 2>&1; then
    ok "11: non-empty tasks/v1/graph edge-index passes validate --strict"
else
    bad "11: well-formed tasks/v1/graph unexpectedly failed validate --strict"
fi
# and non-strict validate (Check 1 empty-tree loop) must also exempt it
if "$TD" validate >/dev/null 2>&1; then
    ok "11b: non-empty tasks/v1/graph passes default (non-strict) validate"
else
    bad "11b: tasks/v1/graph tripped the non-strict empty-tree check"
fi

# ---------------------------------------------------------------------------
# TEST 12: a graph index tree containing a NON-edges/ path FAILS --strict
#          (the graph-index shape invariant that replaces the empty-tree rule
#          for this ref — it is NOT a blanket "skip all checks" exemption).
# ---------------------------------------------------------------------------
junk_blob=$(git hash-object -w --stdin <<<'junk')
printf '%s README.txt\n' "$junk_blob" | mk_graph_ref
rc=0; out=$("$TD" validate --strict 2>&1) || rc=$?
if [ "$rc" -eq 3 ] && echo "$out" | grep -q "unexpected path"; then
    ok "12: graph index with a non-edges/ path fails validate --strict"
else
    bad "12: malformed graph index tree not rejected (rc=$rc, out=$out)"
fi

# ---------------------------------------------------------------------------
# TEST 13: a graph index blob with a MALFORMED edge-id filename FAILS --strict
# ---------------------------------------------------------------------------
# A hex-prefixed but wrong-length name (hits the malformed-edge-id branch,
# not the unexpected-path one, which is exercised separately in TEST 12).
printf '%s edges/abcdef.json\n' "$edge_blob" | mk_graph_ref
rc=0; out=$("$TD" validate --strict 2>&1) || rc=$?
if [ "$rc" -eq 3 ] && echo "$out" | grep -q "malformed edge-id"; then
    ok "13: graph index with a malformed edge-id filename fails validate --strict"
else
    bad "13: malformed edge-id filename not rejected (rc=$rc, out=$out)"
fi

# ---------------------------------------------------------------------------
# TEST 14: the exemption is EXACT-REF, not a tasks/v1/* namespace opening —
#          a hand-crafted tasks/v1/junk still FAILS the namespace check.
# ---------------------------------------------------------------------------
git update-ref -d refs/heads/tasks/v1/graph
mk_ref refs/heads/tasks/v1/junk "hand-crafted v1 junk"
rc=0; out=$("$TD" validate --strict 2>&1) || rc=$?
if [ "$rc" -eq 3 ] && echo "$out" | grep -q "UNKNOWN tasks namespace 'v1'"; then
    ok "14: a non-graph tasks/v1/* ref still fails (exemption is exact-ref)"
else
    bad "14: tasks/v1/junk was not rejected (rc=$rc, out=$out)"
fi
git update-ref -d refs/heads/tasks/v1/junk

# ---------------------------------------------------------------------------
# TEST 15: an edges/<id>.json blob with a NON-regular mode (executable 100755
#          or symlink 120000 — both reported by git as type 'blob') FAILS
#          --strict. The invariant is "regular blobs only".
# ---------------------------------------------------------------------------
idx="$ROOT/.graph.index"; rm -f "$idx"
GIT_INDEX_FILE="$idx" git update-index --add --cacheinfo "100755,$edge_blob,edges/$edge_id.json"
exec_tree=$(GIT_INDEX_FILE="$idx" git write-tree); rm -f "$idx"
exec_commit=$(git commit-tree "$exec_tree" -m "exec-mode graph index")
git update-ref refs/heads/tasks/v1/graph "$exec_commit"
rc=0; out=$("$TD" validate --strict 2>&1) || rc=$?
if [ "$rc" -eq 3 ] && echo "$out" | grep -q "expected a regular file"; then
    ok "15: non-regular-file (100755) edge blob fails validate --strict"
else
    bad "15: non-regular-file edge blob not rejected (rc=$rc, out=$out)"
fi
git update-ref -d refs/heads/tasks/v1/graph

# ---------------------------------------------------------------------------
# TEST 16: the cross-repo mailbox shards tasks/v1/mailbox/00..0f are the
#          SECOND data-in-tree ref kind exempt from the empty-tree floor. A
#          shard commit whose tree is a well-formed message set (only
#          msg/<64-hex>.json blobs) MUST PASS --strict AND non-strict, even
#          though its tree is non-empty. Golden fixture for the ref kind
#          (docs/INVARIANTS.md § "The cross-repo mailbox shards").
# ---------------------------------------------------------------------------
mk_mailbox_ref() {  # <shard> then "<blobsha> <path>" stdin lines
    local shard="$1" idx bsha pth tree commit
    idx="$ROOT/.mailbox.index"; rm -f "$idx"
    while read -r bsha pth; do
        [ -n "$bsha" ] || continue
        GIT_INDEX_FILE="$idx" git update-index --add --cacheinfo "100644,$bsha,$pth"
    done
    tree=$(GIT_INDEX_FILE="$idx" git write-tree)
    rm -f "$idx"
    commit=$(git commit-tree "$tree" -m "mailbox shard $shard")
    git update-ref "refs/heads/tasks/v1/mailbox/$shard" "$commit"
}
msg_id=$(printf 'b%.0s' {1..64})   # a syntactically valid 64-hex message-id
msg_blob=$(git hash-object -w --stdin <<EOF
{"schema":1,"kind":"completion","node":"task:o/r@$(printf '1%.0s' {1..40})","witness":"$(printf '2%.0s' {1..40})","dest":"o/r","origin":{"repo-id":42,"repo":"o/r"}}
EOF
)
# msg_id is all 'b': its first nibble is 'b', so it MUST live in shard 0b.
printf '%s msg/%s.json\n' "$msg_blob" "$msg_id" | mk_mailbox_ref 0b
if "$TD" validate --strict >/dev/null 2>&1; then
    ok "16: non-empty tasks/v1/mailbox/0b message shard passes validate --strict"
else
    bad "16: well-formed tasks/v1/mailbox/0b unexpectedly failed validate --strict"
fi
if "$TD" validate >/dev/null 2>&1; then
    ok "16b: non-empty mailbox shard passes default (non-strict) validate"
else
    bad "16b: mailbox shard tripped the non-strict empty-tree check"
fi
# A message placed in the WRONG shard (its id derives to 0b, not 0a) is
# corruption and MUST fail --strict (the fixed-shard-mapping invariant).
printf '%s msg/%s.json\n' "$msg_blob" "$msg_id" | mk_mailbox_ref 0a
rc=0; out=$("$TD" validate --strict 2>&1) || rc=$?
if [ "$rc" -eq 3 ] && echo "$out" | grep -q "derives to shard 0b"; then
    ok "16c: a mis-sharded message (in 0a, derives to 0b) fails validate --strict"
else
    bad "16c: mis-sharded mailbox message not rejected (rc=$rc, out=$out)"
fi
git update-ref -d refs/heads/tasks/v1/mailbox/0a
git update-ref -d refs/heads/tasks/v1/mailbox/0b

# ---------------------------------------------------------------------------
# TEST 17: an EMPTY-TREE mailbox shard (zero in-flight messages, the state a
#          shard is left in after its last message is consumed) is valid.
# ---------------------------------------------------------------------------
empty_commit=$(git commit-tree "$EMPTY_TREE" -m "empty mailbox shard")
git update-ref refs/heads/tasks/v1/mailbox/00 "$empty_commit"
if "$TD" validate --strict >/dev/null 2>&1; then
    ok "17: empty-tree mailbox shard passes validate --strict"
else
    bad "17: empty-tree mailbox shard unexpectedly failed validate --strict"
fi
git update-ref -d refs/heads/tasks/v1/mailbox/00

# ---------------------------------------------------------------------------
# TEST 18: a mailbox shard tree with a NON-msg/ path FAILS --strict (the
#          shard shape invariant is not a blanket "skip all checks").
# ---------------------------------------------------------------------------
printf '%s README.txt\n' "$junk_blob" | mk_mailbox_ref 0a
rc=0; out=$("$TD" validate --strict 2>&1) || rc=$?
if [ "$rc" -eq 3 ] && echo "$out" | grep -q "unexpected path"; then
    ok "18: mailbox shard with a non-msg/ path fails validate --strict"
else
    bad "18: malformed mailbox shard tree not rejected (rc=$rc, out=$out)"
fi

# ---------------------------------------------------------------------------
# TEST 19: a mailbox blob with a MALFORMED message-id filename FAILS --strict.
# ---------------------------------------------------------------------------
printf '%s msg/abcdef.json\n' "$msg_blob" | mk_mailbox_ref 0a
rc=0; out=$("$TD" validate --strict 2>&1) || rc=$?
if [ "$rc" -eq 3 ] && echo "$out" | grep -q "malformed message-id"; then
    ok "19: mailbox shard with a malformed message-id filename fails validate --strict"
else
    bad "19: malformed message-id filename not rejected (rc=$rc, out=$out)"
fi
git update-ref -d refs/heads/tasks/v1/mailbox/0a

# ---------------------------------------------------------------------------
# TEST 20: the exemption is EXACT-REF (00..0f), not a tasks/v1/mailbox/*
#          opening — a shard OUTSIDE the fixed 16-set (e.g. `10`, `0g`) is
#          still an UNKNOWN tasks/v1/* namespace and FAILS --strict.
# ---------------------------------------------------------------------------
mk_ref refs/heads/tasks/v1/mailbox/10 "out-of-range mailbox shard"
rc=0; out=$("$TD" validate --strict 2>&1) || rc=$?
if [ "$rc" -eq 3 ] && echo "$out" | grep -q "UNKNOWN tasks namespace 'v1'"; then
    ok "20: an out-of-range mailbox shard (10) still fails (exemption is exact-ref)"
else
    bad "20: tasks/v1/mailbox/10 was not rejected (rc=$rc, out=$out)"
fi
git update-ref -d refs/heads/tasks/v1/mailbox/10

# ---------------------------------------------------------------------------
# TEST 21: a msg/<id>.json blob with a NON-regular mode (executable 100755)
#          FAILS --strict — the "regular blobs only" invariant on shards.
# ---------------------------------------------------------------------------
idx="$ROOT/.mailbox.index"; rm -f "$idx"
GIT_INDEX_FILE="$idx" git update-index --add --cacheinfo "100755,$msg_blob,msg/$msg_id.json"
exec_tree=$(GIT_INDEX_FILE="$idx" git write-tree); rm -f "$idx"
exec_commit=$(git commit-tree "$exec_tree" -m "exec-mode mailbox shard")
git update-ref refs/heads/tasks/v1/mailbox/0b "$exec_commit"
rc=0; out=$("$TD" validate --strict 2>&1) || rc=$?
if [ "$rc" -eq 3 ] && echo "$out" | grep -q "expected a regular file"; then
    ok "21: non-regular-file (100755) message blob fails validate --strict"
else
    bad "21: non-regular-file message blob not rejected (rc=$rc, out=$out)"
fi
git update-ref -d refs/heads/tasks/v1/mailbox/0b

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
