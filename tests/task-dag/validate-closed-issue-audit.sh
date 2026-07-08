#!/usr/bin/env bash
# Fixture test for `task-dag validate --closed-issue-audit` — the OPT-IN,
# OFFLINE-PRESERVING audit that SURFACES (never deletes) the lingering
# scheduling refs of CONFIRMED-CLOSED issues (top-level#48, child of #12).
#
# Builds a throwaway bare "origin" + working clone (no network) plus a fake
# `gh` on PATH that (a) logs every invocation to a call-log and (b) reports
# issue state from a small map file. Asserts:
#   - OFFLINE PRESERVATION: plain `validate` and `validate --strict` NEVER
#     invoke gh (the whole point — the default must not depend on the API);
#   - CONFIRMED-CLOSED issue with lingering frontier+blocked+blocked-meta refs
#     is reported as an ERROR (exit 3), and the ACTUAL ref names are listed;
#   - an OPEN issue is NOT flagged; a cross-repo block (same issue #, other
#     repo) is excluded; pending/active/provenance refs are never reported;
#   - undetermined gh (unauth/API error) => WARNING (not error), complete=false,
#     and does NOT by itself make the audit exit non-zero;
#   - GROUPING: gh is queried at most ONCE per unique issue (rate-limit safe);
#   - a clean repo (only OPEN issues) => exit 0, closedWithLingeringRefs=0;
#   - --json shape parses under `jq -e` and carries a sane closedIssueAudit
#     object; the NON-audit --json shape is UNCHANGED (no closedIssueAudit key);
#   - --repo without --closed-issue-audit is rejected (exit 2).
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

command -v jq >/dev/null 2>&1 || { echo "jq is required for this test"; echo "PASS=0 FAIL=1"; exit 1; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_GIT_NAME=t TASK_DAG_GIT_EMAIL=t@t

REPO="acme/widgets"            # THIS repo (passed via --repo)
OTHER="other/thing"            # cross-repo block; must be excluded

# ── Fake gh: logs every call, state driven by $GH_STATE_FILE lines ─────────
GH_STATE_FILE="$ROOT/gh-state"
GH_CALL_LOG="$ROOT/gh-calls"
: > "$GH_CALL_LOG"
mkdir "$ROOT/bin"
cat > "$ROOT/bin/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_CALL_LOG"
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
export GH_STATE_FILE GH_CALL_LOG
PATH="$ROOT/bin:$PATH"; export PATH

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"; cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master
EMPTY_TREE=$(git mktree </dev/null)

mk_task() { # <issue> <repo> <type> <suffix> -> new task full sha
    local issue="$1" repo="$2" type="$3" suffix="$4"
    git commit-tree "$EMPTY_TREE" -p "$(git rev-parse HEAD)" -m "Task: T-$suffix

Issue: #${issue}
URL: https://github.com/${repo}/issues/${issue}
Author: tester
Status: pending
Type: ${type}"
}

# ── Seed the CLOSED issue 42 (repo acme/widgets) ───────────────────────────
FA=$(mk_task 42 "$REPO" leaf frontierOnly)             # pickable frontier ONLY
FA_SHORT=$(git rev-parse --short "$FA")
git push -q origin "$FA:refs/heads/tasks/frontier/$FA_SHORT"

LA=$(mk_task 42 "$REPO" leaf leafA)                     # autoparked: frontier + blocked(+meta)
LA_SHORT=$(git rev-parse --short "$LA")
git push -q origin "$LA:refs/heads/tasks/frontier/$LA_SHORT"
"$TD" block "$LA" --operator --reason="awaiting operator" >/dev/null 2>&1

# Refs that must NEVER be reported by the audit.
E=$(mk_task 42 "$REPO" epic root)
git push -q origin "$E:refs/heads/tasks/pending/42"    # epic identity
git push -q origin "$E:refs/heads/gh/comments/42/1"    # provenance
ACT=$(mk_task 42 "$REPO" leaf activeLeaf)
ACT_SHORT=$(git rev-parse --short "$ACT")
git push -q origin "$ACT:refs/heads/tasks/active/$ACT_SHORT"

# ── OPEN issue 99 (must NOT be flagged) ────────────────────────────────────
LB=$(mk_task 99 "$REPO" leaf otherIssue)
LB_SHORT=$(git rev-parse --short "$LB")
git push -q origin "$LB:refs/heads/tasks/frontier/$LB_SHORT"
"$TD" block "$LB" --operator --reason="other issue" >/dev/null 2>&1

# ── Undetermined issue 77 (gh ERR) ─────────────────────────────────────────
S77=$(mk_task 77 "$REPO" leaf undetermined)
S77_SHORT=$(git rev-parse --short "$S77")
git push -q origin "$S77:refs/heads/tasks/frontier/$S77_SHORT"

# ── Cross-repo block: SAME issue number 42, DIFFERENT repo (excluded) ──────
X=$(mk_task 42 "$OTHER" leaf crossRepo)
git push -q origin "$X:refs/heads/tasks/frontier/$(git rev-parse --short "$X")"
"$TD" block "$X" --operator --reason="cross-repo" >/dev/null 2>&1

cat > "$GH_STATE_FILE" <<EOF
42 CLOSED
99 OPEN
77 ERR
EOF

# A fresh clone == a real worker view.
git clone -q "$ROOT/origin.git" "$ROOT/run"
run_audit() { ( cd "$ROOT/run" && "$TD" validate "$@" ); }

# ── TEST A: OFFLINE preservation — default & --strict NEVER call gh ────────
: > "$GH_CALL_LOG"
run_audit >/dev/null 2>&1; rc=$?
[ ! -s "$GH_CALL_LOG" ] && ok "A1: plain validate made no gh call (offline)" \
    || { bad "A1: plain validate called gh"; cat "$GH_CALL_LOG"; }
: > "$GH_CALL_LOG"
run_audit --strict >/dev/null 2>&1
[ ! -s "$GH_CALL_LOG" ] && ok "A2: validate --strict made no gh call (offline)" \
    || { bad "A2: validate --strict called gh"; cat "$GH_CALL_LOG"; }

# ── TEST B: --repo without --closed-issue-audit is rejected (exit 2) ───────
run_audit --repo="$REPO" >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "B1: --repo without --closed-issue-audit rejected (exit 2)" \
    || bad "B1: got rc=$rc (want 2)"

# ── TEST C: non-audit --json shape is UNCHANGED (no closedIssueAudit key) ──
js=$(run_audit --json 2>/dev/null)
if printf '%s' "$js" | jq -e 'has("closedIssueAudit")|not' >/dev/null 2>&1; then
    ok "C1: non-audit --json has no closedIssueAudit key (shape unchanged)"
else
    bad "C1: non-audit --json unexpectedly carries closedIssueAudit: $js"
fi

# ── TEST D: audit real run — CLOSED 42 flagged as ERROR (exit 3) ───────────
: > "$GH_CALL_LOG"
out=$(run_audit --closed-issue-audit --repo="$REPO" 2>&1); rc=$?
[ "$rc" = 3 ] && ok "D1: CLOSED issue with lingering refs => exit 3" \
    || { bad "D1: got rc=$rc (want 3)"; echo "$out"; }
printf '%s' "$out" | grep -q "42 is CLOSED" \
    && ok "D2: human output names the CLOSED issue" || { bad "D2: no CLOSED mention"; echo "$out"; }
# Actual ref names are listed (not inferred): frontier + blocked + blocked-meta.
printf '%s' "$out" | grep -q "refs/heads/tasks/frontier/$FA_SHORT" \
    && ok "D3: frontier-only lingering ref listed" || { bad "D3: FA frontier missing"; echo "$out"; }
printf '%s' "$out" | grep -q "refs/heads/tasks/blocked/$LA" \
    && ok "D4: blocked overlay lingering ref listed" || { bad "D4: LA blocked missing"; echo "$out"; }
printf '%s' "$out" | grep -q "refs/heads/tasks/blocked-meta/$LA" \
    && ok "D5: blocked-meta lingering ref listed" || { bad "D5: LA blocked-meta missing"; echo "$out"; }

# ── TEST E: undetermined 77 => WARNING, and OPEN 99 not flagged ────────────
printf '%s' "$out" | grep -q "77 state undetermined" \
    && ok "E1: undetermined issue reported as a warning" || { bad "E1: no undetermined report"; echo "$out"; }
printf '%s' "$out" | grep -q "99 is CLOSED" \
    && { bad "E2: OPEN issue 99 wrongly flagged"; echo "$out"; } || ok "E2: OPEN issue 99 not flagged"

# ── TEST F: audit does NOT report pending/active/provenance refs ───────────
if printf '%s' "$out" | grep -Eq "tasks/pending/|tasks/active/|gh/comments/"; then
    bad "F1: audit reported a protected ref"; echo "$out"
else
    ok "F1: pending/active/provenance refs never reported"
fi
# Cross-repo block (other/thing #42) must be excluded.
printf '%s' "$out" | grep -q "$OTHER" \
    && { bad "F2: cross-repo block leaked into audit"; echo "$out"; } || ok "F2: cross-repo block excluded"

# ── TEST G: GROUPING — gh queried at most ONCE per unique issue ────────────
n42=$(grep -c "issue view 42 " "$GH_CALL_LOG" || true)
n99=$(grep -c "issue view 99 " "$GH_CALL_LOG" || true)
n77=$(grep -c "issue view 77 " "$GH_CALL_LOG" || true)
[ "$n42" = 1 ] && ok "G1: issue 42 (4 refs) queried exactly once" || bad "G1: 42 queried $n42 times"
[ "$n99" = 1 ] && ok "G2: issue 99 queried exactly once" || bad "G2: 99 queried $n99 times"
[ "$n77" = 1 ] && ok "G3: issue 77 queried exactly once" || bad "G3: 77 queried $n77 times"

# ── TEST H: --json audit shape parses and carries sane counts ──────────────
js=$(run_audit --closed-issue-audit --repo="$REPO" --json 2>/dev/null); rc=$?
printf '%s' "$js" | jq -e . >/dev/null 2>&1 && ok "H1: audit --json parses under jq -e" || { bad "H1: invalid: $js"; }
[ "$rc" = 3 ] && ok "H2: audit --json still exits 3 on lingering" || bad "H2: rc=$rc"
if printf '%s' "$js" | jq -e '.closedIssueAudit.repo=="acme/widgets"
    and .closedIssueAudit.complete==false
    and .closedIssueAudit.counts.closedWithLingeringRefs==1
    and .closedIssueAudit.counts.undetermined==1
    and (.closedIssueAudit.counts.issuesChecked==3)
    and (.closedIssueAudit.lingering[0].issue==42)
    and (.closedIssueAudit.lingering[0].state=="CLOSED")
    and (.closedIssueAudit.lingering[0].refs|length==4)
    and (.closedIssueAudit.undetermined[0].issue==77)' >/dev/null 2>&1; then
    ok "H3: audit --json closedIssueAudit object is correct"
else
    bad "H3: closedIssueAudit wrong: $(printf '%s' "$js" | jq -c .closedIssueAudit)"
fi
# top-level errors/valid reflect the closed-issue finding.
if printf '%s' "$js" | jq -e '.valid==false and .errors>=1' >/dev/null 2>&1; then
    ok "H4: top-level errors/valid reflect the finding"
else
    bad "H4: top-level wrong: $js"
fi

# ── TEST I: CLEAN repo (only OPEN issues) => exit 0, nothing lingering ──────
# Reopen 42 & mark 77 OPEN, delete the undetermined path; the only candidates
# left resolve to OPEN issues -> no confirmed debris.
cat > "$GH_STATE_FILE" <<EOF
42 OPEN
99 OPEN
77 OPEN
EOF
js=$(run_audit --closed-issue-audit --repo="$REPO" --json 2>/dev/null); rc=$?
[ "$rc" = 0 ] && ok "I1: all-OPEN candidates => exit 0" || { bad "I1: rc=$rc"; echo "$js"; }
if printf '%s' "$js" | jq -e '.closedIssueAudit.complete==true
    and .closedIssueAudit.counts.closedWithLingeringRefs==0
    and .closedIssueAudit.counts.undetermined==0
    and (.closedIssueAudit.lingering|length==0)' >/dev/null 2>&1; then
    ok "I2: clean audit reports complete=true, 0 lingering"
else
    bad "I2: clean audit wrong: $(printf '%s' "$js" | jq -c .closedIssueAudit)"
fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
