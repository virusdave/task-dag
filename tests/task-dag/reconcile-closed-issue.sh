#!/usr/bin/env bash
# Fixture test for `task-dag reconcile-closed-issue <issue>` — the fail-safe
# cleanup of lingering scheduling refs for a CONFIRMED-CLOSED issue's tasks
# (top-level#48).
#
# Builds a throwaway bare "origin" + working clone (no network) plus a fake
# `gh` on PATH whose reported issue state is driven by a small map file, then
# seeds frontier/blocked/blocked-meta/active/pending/provenance refs across
# several issues and repos and asserts:
#   - CONFIRMED CLOSED happy path: frontier-only, blocked(+meta), autoparked,
#     and legacy(no-meta) tasks for the closed issue are dropped;
#   - pending/<N> and gh/comments/<N>/<id> provenance are KEPT;
#   - tasks/active/* is LEFT ALONE;
#   - a DIFFERENT issue's refs and a cross-repo block (same issue #, other
#     repo) survive;
#   - not-CLOSED (OPEN) => clean no-op exit 0, nothing deleted;
#   - undetermined gh (unauth/API error) => no-op exit 3, nothing deleted;
#   - --dry-run mutates nothing;
#   - a second run is idempotent (exit 0);
#   - --json output parses under `jq -e` and carries sane counts;
#   - a re-pointed frontier short-sha ref is never clobbered (frontier-first
#     + --force-with-lease discipline).
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_GIT_NAME=t TASK_DAG_GIT_EMAIL=t@t

REPO="acme/widgets"            # THIS repo (passed via --repo)
OTHER="other/thing"            # cross-repo referencing block; must survive

# ── Fake gh: state driven by $GH_STATE_FILE lines "<issue> <state>" ────────
# state "ERR" => gh exits non-zero (simulates unauth/API failure => the
# command's "undetermined" branch).
GH_STATE_FILE="$ROOT/gh-state"
mkdir "$ROOT/bin"
cat > "$ROOT/bin/gh" <<'SH'
#!/usr/bin/env bash
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
    n="$3"
    st=$(awk -v n="$n" '$1==n{print $2; exit}' "$GH_STATE_FILE" 2>/dev/null)
    [ -n "$st" ] || { echo "gh: issue $n not found" >&2; exit 1; }
    [ "$st" = "ERR" ] && { echo "gh: API error" >&2; exit 1; }
    echo "$st"
    exit 0
fi
echo "gh: unsupported args: $*" >&2; exit 1
SH
chmod +x "$ROOT/bin/gh"
export GH_STATE_FILE
PATH="$ROOT/bin:$PATH"; export PATH

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"; cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master
EMPTY_TREE=$(git mktree </dev/null)

# mk_task <issue> <repo> <type> <suffix> -> prints new task's full sha.
mk_task() {
    local issue="$1" repo="$2" type="$3" suffix="$4"
    git commit-tree "$EMPTY_TREE" -p "$(git rev-parse HEAD)" -m "Task: T-$suffix

Issue: #${issue}
URL: https://github.com/${repo}/issues/${issue}
Author: tester
Status: pending
Type: ${type}"
}
remote_has() { git ls-remote origin "$1" | grep -q .; }
remote_sha() { git ls-remote origin "$1" | awk '{print $1; exit}'; }

# ── Seed refs for the CLOSED issue 42 (repo acme/widgets) ──────────────────
FA=$(mk_task 42 "$REPO" leaf frontierOnly)            # pickable frontier ONLY (the #48 case)
FA_SHORT=$(git rev-parse --short "$FA")
git push -q origin "$FA:refs/heads/tasks/frontier/$FA_SHORT"

E=$(mk_task 42 "$REPO" epic root)                      # epic root (blocked)
git push -q origin "$E:refs/heads/tasks/pending/42"
"$TD" block "$E" --operator --reason="agent abandoned claim" >/dev/null 2>&1

LA=$(mk_task 42 "$REPO" leaf leafA)                     # autoparked leaf: frontier + blocked
LA_SHORT=$(git rev-parse --short "$LA")
git push -q origin "$LA:refs/heads/tasks/frontier/$LA_SHORT"
"$TD" block "$LA" --operator --reason="awaiting operator" >/dev/null 2>&1

LC=$(mk_task 42 "$REPO" leaf legacy)                    # LEGACY block: overlay, NO meta
LC_SHORT=$(git rev-parse --short "$LC")
git push -q origin "$LC:refs/heads/tasks/frontier/$LC_SHORT" "$LC:refs/heads/tasks/blocked/$LC"

ACT=$(mk_task 42 "$REPO" leaf activeLeaf)              # ACTIVE (claimed) leaf — must be LEFT ALONE
ACT_SHORT=$(git rev-parse --short "$ACT")
git push -q origin "$ACT:refs/heads/tasks/active/$ACT_SHORT"

# Provenance ref for the issue — must be KEPT.
git push -q origin "$E:refs/heads/gh/comments/42/1"

# ── Seed refs that MUST survive ────────────────────────────────────────────
LB=$(mk_task 99 "$REPO" leaf otherIssue)              # different issue, same repo
LB_SHORT=$(git rev-parse --short "$LB")
git push -q origin "$LB:refs/heads/tasks/frontier/$LB_SHORT"
"$TD" block "$LB" --operator --reason="other issue" >/dev/null 2>&1

X=$(mk_task 42 "$OTHER" leaf crossRepo)               # SAME issue number, DIFFERENT repo
X_SHORT=$(git rev-parse --short "$X")
git push -q origin "$X:refs/heads/tasks/frontier/$X_SHORT"
"$TD" block "$X" --operator --reason="cross-repo" >/dev/null 2>&1

# Issue-state map.
cat > "$GH_STATE_FILE" <<EOF
42 CLOSED
99 OPEN
EOF

run_reconcile() { # <args...> ; runs from a fresh clone (== a real worker)
    ( cd "$ROOT/run" && "$TD" reconcile-closed-issue "$@" )
}
git clone -q "$ROOT/origin.git" "$ROOT/run"

# ── TEST A: not-CLOSED (issue 99 OPEN) => clean no-op exit 0 ───────────────
out=$(run_reconcile 99 --repo="$REPO" --yes 2>&1); rc=$?
[ "$rc" = 0 ] && ok "A1: OPEN issue is a no-op exit 0" || { bad "A1: got rc=$rc"; echo "$out"; }
remote_has "refs/heads/tasks/blocked/$LB" && ok "A2: OPEN issue's blocked ref untouched" \
    || bad "A2: OPEN issue's blocked ref deleted"

# ── TEST B: undetermined gh (ERR) => no-op exit 3, nothing deleted ─────────
echo "77 ERR" >> "$GH_STATE_FILE"
S77=$(mk_task 77 "$REPO" leaf undetermined)
S77_SHORT=$(git rev-parse --short "$S77")
git push -q origin "$S77:refs/heads/tasks/frontier/$S77_SHORT"
( cd "$ROOT/run" && git fetch -q origin '+refs/heads/tasks/*:refs/heads/tasks/*' )
out=$(run_reconcile 77 --repo="$REPO" --yes 2>&1); rc=$?
[ "$rc" = 3 ] && ok "B1: undetermined gh => exit 3" || { bad "B1: got rc=$rc"; echo "$out"; }
remote_has "refs/heads/tasks/frontier/$S77_SHORT" \
    && ok "B2: undetermined gh deleted nothing" || bad "B2: undetermined gh deleted a ref"
js77=$(run_reconcile 77 --repo="$REPO" --yes --json 2>/dev/null)
if printf '%s' "$js77" | jq -e '.ok==false and .state==null and .reason=="undetermined-issue-state"' >/dev/null 2>&1; then
    ok "B3: undetermined --json reports ok=false, state=null"
else
    bad "B3: undetermined --json wrong: $js77"
fi

# ── TEST C: --dry-run on the CLOSED issue mutates nothing ──────────────────
out=$(run_reconcile 42 --repo="$REPO" --dry-run 2>&1); rc=$?
[ "$rc" = 0 ] && ok "C1: --dry-run exit 0" || { bad "C1: got rc=$rc"; echo "$out"; }
if remote_has "refs/heads/tasks/blocked/$E" && remote_has "refs/heads/tasks/frontier/$FA_SHORT" \
    && remote_has "refs/heads/tasks/blocked/$LA" && remote_has "refs/heads/tasks/blocked/$LC"; then
    ok "C2: --dry-run left every origin ref in place"
else
    bad "C2: --dry-run deleted something"
fi

# ── TEST D: --json shape parses and reports the right targets (dry-run) ────
js=$(run_reconcile 42 --repo="$REPO" --dry-run --json 2>/dev/null)
if printf '%s' "$js" | jq -e . >/dev/null 2>&1; then ok "D1: --json parses under jq -e"; else bad "D1: --json invalid: $js"; fi
[ "$(printf '%s' "$js" | jq -r .state)" = CLOSED ] && ok "D2: --json state=CLOSED" || bad "D2: state wrong"
[ "$(printf '%s' "$js" | jq -r .ok)" = true ] && ok "D3: --json ok=true" || bad "D3: ok wrong"
[ "$(printf '%s' "$js" | jq -r .dryRun)" = true ] && ok "D4: --json dryRun=true" || bad "D4: dryRun wrong"
# 4 in-repo targets: FA, E, LA, LC (cross-repo X and other-issue LB excluded).
ntar=$(printf '%s' "$js" | jq -r .counts.targets)
[ "$ntar" = 4 ] && ok "D5: --json counts.targets=4 (cross-repo + other-issue excluded)" \
    || bad "D5: counts.targets=$ntar (want 4)"

# ── TEST D2: --hint-sha must still resolve to THIS closed issue ────────────
out=$(run_reconcile 42 --repo="$REPO" --yes --hint-sha="$LB" 2>&1); rc=$?
[ "$rc" = 2 ] && ok "D6: wrong-issue --hint-sha is rejected before mutation" \
    || { bad "D6: wrong-issue hint got rc=$rc"; echo "$out"; }
remote_has "refs/heads/tasks/blocked/$LB" && remote_has "refs/heads/tasks/frontier/$LB_SHORT" \
    && ok "D7: rejected wrong-issue hint left that task's refs untouched" \
    || bad "D7: rejected wrong-issue hint deleted a ref"

# ── TEST E: real run on CLOSED issue 42 (fresh clone == a real worker) ─────
out=$(run_reconcile 42 --repo="$REPO" --yes 2>&1); rc=$?
[ "$rc" = 0 ] && ok "E0: reconcile exited 0" || { bad "E0: exited $rc"; echo "$out"; }

gone() { remote_has "$1" && bad "$2 ($1 still present)" || ok "$2"; }
kept() { remote_has "$1" && ok "$2" || bad "$2 ($1 missing)"; }

gone "refs/heads/tasks/frontier/$FA_SHORT"  "E1: frontier-only task removed (#48 case)"
gone "refs/heads/tasks/blocked/$E"          "E2: epic-root blocked overlay removed"
gone "refs/heads/tasks/blocked-meta/$E"     "E3: epic-root blocked-meta removed"
gone "refs/heads/tasks/blocked/$LA"         "E4: autoparked leaf blocked overlay removed"
gone "refs/heads/tasks/blocked-meta/$LA"    "E5: autoparked leaf blocked-meta removed"
gone "refs/heads/tasks/frontier/$LA_SHORT"  "E6: autoparked leaf frontier removed (no zombie dispatch)"
gone "refs/heads/tasks/blocked/$LC"         "E7: legacy (no-meta) block overlay removed"
gone "refs/heads/tasks/frontier/$LC_SHORT"  "E8: legacy block frontier removed"

kept "refs/heads/tasks/pending/42"          "E9: epic identity pending/42 preserved"
kept "refs/heads/gh/comments/42/1"          "E10: comment provenance preserved"
kept "refs/heads/tasks/active/$ACT_SHORT"   "E11: active (claimed) leaf left alone"
kept "refs/heads/tasks/blocked/$LB"         "E12: different issue's blocked overlay preserved"
kept "refs/heads/tasks/blocked/$X"          "E13: cross-repo block (same issue #, other repo) preserved"
kept "refs/heads/tasks/frontier/$X_SHORT"   "E14: cross-repo frontier preserved"

# ── TEST F: idempotent second run is a clean no-op exit 0 ──────────────────
out=$(run_reconcile 42 --repo="$REPO" --yes 2>&1); rc=$?
[ "$rc" = 0 ] && ok "F1: idempotent second run exit 0" || { bad "F1: got rc=$rc"; echo "$out"; }

# ── TEST G: a re-pointed frontier short-sha ref is never clobbered ─────────
# Seed a blocked task G for CLOSED issue 42 whose frontier short-sha ref has
# been re-pointed (by a racing breakdown) to a DIFFERENT task Z. Reconcile
# must remove G's blocked overlay but NOT the frontier ref now pointing at Z.
G=$(mk_task 42 "$REPO" leaf raceTarget)
G_SHORT=$(git rev-parse --short "$G")
"$TD" block "$G" --operator --reason="race" >/dev/null 2>&1
Z=$(mk_task 99 "$REPO" leaf raceStealer)              # a DIFFERENT issue's task (not a target)
# Re-point G's frontier short-sha ref at Z on origin (simulated race).
git push -q origin "$Z:refs/heads/tasks/frontier/$G_SHORT" 2>/dev/null || \
    git push -q origin --force "$Z:refs/heads/tasks/frontier/$G_SHORT"
out=$(run_reconcile 42 --repo="$REPO" --yes 2>&1); rc=$?
[ "$rc" = 0 ] && ok "G1: reconcile exit 0 with a re-pointed frontier ref" || { bad "G1: rc=$rc"; echo "$out"; }
gone "refs/heads/tasks/blocked/$G"          "G2: race target's blocked overlay removed"
if [ "$(remote_sha "refs/heads/tasks/frontier/$G_SHORT")" = "$Z" ]; then
    ok "G3: re-pointed frontier short-sha ref left intact (points at the other task)"
else
    bad "G3: re-pointed frontier ref was clobbered"
fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
