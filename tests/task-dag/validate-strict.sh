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
if echo "$out" | grep -q '"errors": 0' && echo "$out" | grep -q '"strict": true'; then
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
if [ "$rc" -eq 3 ] \
    && echo "$out" | grep -q '"valid": false' \
    && echo "$out" | grep -q '"strict": true' \
    && echo "$out" | grep -qE '"errors": [1-9]'; then
    ok "9: --strict --json with violations emits JSON (valid:false) and exits 3"
else
    bad "9: --strict --json with violations wrong (rc=$rc, out=$out)"
fi
git update-ref -d refs/heads/tasks/bogus/xyz

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
