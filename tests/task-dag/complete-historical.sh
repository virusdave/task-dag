#!/usr/bin/env bash
# Fixture smoke test for `task-dag complete-historical` (issue #4):
# retroactively link an already-landed historical commit on master to a
# task, without rewriting master history. Builds a throwaway bare "origin"
# + working clone in a tempdir (no network, no real repo).
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ORDER_HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install-completion-order-hook.sh"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# A stub page-dave on PATH so we can assert the audit page is sent with the
# right priority/content WITHOUT touching the real notifier. Each call
# appends a record to $ROOT/page.log.
mkdir -p "$ROOT/bin"
cat > "$ROOT/bin/page-dave" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$ROOT/page.log"
exit 0
EOF
chmod +x "$ROOT/bin/page-dave"
export PATH="$ROOT/bin:$PATH"
page_count() { [ -f "$ROOT/page.log" ] && wc -l < "$ROOT/page.log" | tr -d ' ' || echo 0; }

# bare origin + working clone
git init -q --bare "$ROOT/origin.git"
bash "$ORDER_HOOK" "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"
cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master

# Epic commit + refs (mimic issue-to-task)
EPIC=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: Test epic

Issue: #4242
URL: https://github.com/test/test/issues/4242
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/gh/issues/4242 "$EPIC"
git update-ref refs/heads/tasks/pending/4242 "$EPIC"
git push -q origin refs/heads/gh/issues/4242 refs/heads/tasks/pending/4242

mk_task() {  # prints the new leaf task short sha
  local title="$1"
  printf '[{"title":"%s","type":"leaf"}]' "$title" > "$ROOT/spec.json"
  "$TD" claim-root 4242 --force >/dev/null 2>&1
  "$TD" breakdown "$EPIC" --spec-file="$ROOT/spec.json" --force --json 2>/dev/null \
    | grep -oE '"shortSha":"[0-9a-f]+"' | head -1 | cut -d'"' -f4
}

# Keepalive leaf we NEVER complete, so epic #4242 is never fully complete
# and maybe_emit_local_epic_close never appends a Closes-Epic commit on top
# of our link commits (which would break the HEAD^1/HEAD^2 assertions).
KEEP=$(mk_task "keepalive — never completed")
[ -n "$KEEP" ] || { echo "could not create keepalive leaf"; exit 1; }

# Helper: land a "real" historical implementation commit on master, then
# pile MORE commits on top (to prove we never rewrite master). Prints the
# historical commit SHA via global HSHA; leaves HEAD == origin/master.
mk_history() {
  local tag="$1"
  echo "impl-$tag" > "impl-$tag.txt"; git add "impl-$tag.txt"; git commit -qm "real work $tag"
  HSHA=$(git rev-parse HEAD)
  echo "after-$tag" > "after-$tag.txt"; git add "after-$tag.txt"; git commit -qm "later work after $tag"
  echo "after2-$tag" > "after2-$tag.txt"; git add "after2-$tag.txt"; git commit -qm "even later $tag"
  git push -q origin HEAD:master
}

# ---------------------------------------------------------------------------
# TEST 1: happy path — link a historical commit, no master rewrite
# ---------------------------------------------------------------------------
T1=$(mk_task "t1 historical link")
TASK1=$(git rev-parse "refs/heads/tasks/frontier/$T1")
mk_history t1
OLD_TIP=$(git rev-parse HEAD)
OLD_TREE=$(git rev-parse "HEAD^{tree}")
P0=$(page_count)
touch "$ROOT/origin.git/enforce-completion-order"
out=$("$TD" complete-historical "$T1" --commit="$HSHA" 2>"$ROOT/err1"); rc=$?
rm -f "$ROOT/origin.git/enforce-completion-order"
err=$(cat "$ROOT/err1")

if [ $rc -eq 0 ]; then ok "happy: complete-historical rc=0"; else bad "happy: rc=$rc out=$out err=$err"; fi
if [ "$(git rev-parse HEAD^1)" = "$OLD_TIP" ]; then ok "happy: HEAD^1 is the old master tip (no rewrite)"; else bad "happy: HEAD^1 != old tip"; fi
if [ "$(git rev-parse HEAD^2)" = "$TASK1" ]; then ok "happy: HEAD^2 is the task commit"; else bad "happy: HEAD^2 != task"; fi
if git rev-parse HEAD^3 >/dev/null 2>&1; then bad "happy: link commit unexpectedly has a 3rd parent"; else ok "happy: no 3rd parent (H is NOT a parent)"; fi
if [ "$(git rev-parse 'HEAD^{tree}')" = "$OLD_TREE" ]; then ok "happy: link commit is empty (tree unchanged)"; else bad "happy: link commit changed the tree"; fi
# Historical commit must still be reachable (master not rewritten).
if git merge-base --is-ancestor "$HSHA" HEAD; then ok "happy: historical commit still in history"; else bad "happy: historical commit lost"; fi

MSG=$(git log -1 --format='%B' HEAD)
echo "$MSG" | grep -q "Historical-Commit: $HSHA" && ok "happy: Historical-Commit trailer present (full sha)" || bad "happy: missing Historical-Commit trailer"
echo "$MSG" | grep -q "^Retroactive: true$" && ok "happy: Retroactive: true trailer present" || bad "happy: missing Retroactive trailer"
echo "$MSG" | grep -q "^Task-Commit: $TASK1$" && ok "happy: Task-Commit trailer present" || bad "happy: missing Task-Commit trailer"
echo "$MSG" | grep -q "^Status: completed$" && ok "happy: Status: completed trailer present" || bad "happy: missing Status trailer"

# frontier ref must be gone on origin
if [ "$(git ls-remote origin "refs/heads/tasks/frontier/$T1" | wc -l)" -eq 0 ]; then ok "happy: frontier ref cleaned on origin"; else bad "happy: frontier ref lingered"; fi
grep -q "^$TASK1 " "$ROOT/origin.git/completion-order.log" \
  && ok "happy: historical link reached master before ref deletion" \
  || bad "happy: completion-order hook did not observe historical cleanup"

# LOUD banner on stderr
if echo "$err" | grep -qi "ONLY" && echo "$err" | grep -qi "missed" && echo "$err" | grep -qi "normal workflow"; then
  ok "happy: loud admin-only banner present on stderr"
else
  bad "happy: banner missing/weak: $err"
fi

# page-dave called once, priority 2, with key context
if [ "$(page_count)" -eq $((P0+1)) ]; then ok "happy: operator paged exactly once"; else bad "happy: page count=$(page_count) expected $((P0+1))"; fi
PLINE=$(tail -1 "$ROOT/page.log" 2>/dev/null || echo "")
case "$PLINE" in
  "-p 2 "*) ok "happy: page sent at priority 2 (flags before message)";;
  *) bad "happy: page not at -p 2: $PLINE";;
esac
echo "$PLINE" | grep -q "https://github.com/test/test/issues/4242" && ok "happy: page includes issue URL" || bad "happy: page missing issue URL"
echo "$PLINE" | grep -q "$T1" && ok "happy: page includes task sha" || bad "happy: page missing task sha"
echo "$PLINE" | grep -qi "$(git rev-parse --short "$HSHA")" && ok "happy: page references historical commit" || bad "happy: page missing historical commit"

# Publish (as a worker would) so HEAD == origin/master again for later tests.
git push -q origin HEAD:master

# ---------------------------------------------------------------------------
# TEST 2: idempotency — re-running on an already-linked task is a no-op + no page
# ---------------------------------------------------------------------------
P0=$(page_count)
out=$("$TD" complete-historical "$T1" --commit="$HSHA" 2>"$ROOT/err2"); rc=$?
if [ $rc -eq 0 ] && grep -qi "already linked" "$ROOT/err2"; then ok "idempotent: rc=0 + 'already linked'"; else bad "idempotent: rc=$rc err=$(cat "$ROOT/err2")"; fi
if [ "$(page_count)" -eq "$P0" ]; then ok "idempotent: no extra page sent"; else bad "idempotent: extra page sent"; fi

# ---------------------------------------------------------------------------
# TEST 3: missing --commit is refused
# ---------------------------------------------------------------------------
T3=$(mk_task "t3 missing commit")
out=$("$TD" complete-historical "$T3" 2>&1); rc=$?
if [ $rc -eq 1 ] && echo "$out" | grep -qi "commit.*required"; then ok "validation: missing --commit refused (rc=1)"; else bad "validation: missing --commit rc=$rc: $out"; fi

# ---------------------------------------------------------------------------
# TEST 4: an empty-tree task/control commit as --commit is refused. The
# keepalive leaf is a real empty-tree task commit (unlike this fixture's
# epic, which carries the seed tree).
# ---------------------------------------------------------------------------
KEEP_FULL=$(git rev-parse "refs/heads/tasks/frontier/$KEEP")
out=$("$TD" complete-historical "$T3" --commit="$KEEP_FULL" 2>&1); rc=$?
if [ $rc -eq 1 ] && echo "$out" | grep -qi "task/control commit"; then ok "validation: empty/task --commit refused"; else bad "validation: empty --commit rc=$rc: $out"; fi

# ---------------------------------------------------------------------------
# TEST 5: a commit not on origin/master is refused
# ---------------------------------------------------------------------------
SEED=$(git rev-parse origin/master~0 >/dev/null 2>&1; git rev-list --max-parents=0 HEAD | tail -1)
git checkout -q -b sidebranch "$SEED"
echo side > side.txt; git add side.txt; git commit -qm "off-master work"
DANGLING=$(git rev-parse HEAD)
git checkout -q master
out=$("$TD" complete-historical "$T3" --commit="$DANGLING" 2>&1); rc=$?
if [ $rc -eq 2 ] && echo "$out" | grep -qi "not an ancestor of origin/master"; then ok "authority: off-master --commit refused (rc=2)"; else bad "authority: off-master rc=$rc: $out"; fi

# ---------------------------------------------------------------------------
# TEST 6: refuse when another worker holds the active claim; --force overrides
# ---------------------------------------------------------------------------
T6=$(mk_task "t6 foreign claim")
mk_history t6
TASK_DAG_CLAIMER=alice TASK_DAG_CLAIMER_HOST=hostA "$TD" claim "$T6" >/dev/null 2>&1
out=$(TASK_DAG_CLAIMER=bob TASK_DAG_CLAIMER_HOST=hostB "$TD" complete-historical "$T6" --commit="$HSHA" 2>&1); rc=$?
if [ $rc -eq 2 ] && echo "$out" | grep -qi "claimed by alice"; then ok "claim: foreign active claim refused (rc=2)"; else bad "claim: foreign claim rc=$rc: $out"; fi
if git ls-remote --exit-code origin "refs/heads/tasks/active/$T6" >/dev/null 2>&1; then ok "claim: alice's active claim left intact"; else bad "claim: alice's claim was deleted"; fi
out=$(TASK_DAG_CLAIMER=bob TASK_DAG_CLAIMER_HOST=hostB "$TD" complete-historical "$T6" --commit="$HSHA" --force 2>"$ROOT/err6"); rc=$?
if [ $rc -eq 0 ]; then ok "claim: --force overrides foreign claim (rc=0)"; else bad "claim: --force rc=$rc: $(cat "$ROOT/err6")"; fi
if [ "$(git ls-remote origin "refs/heads/tasks/active/$T6" | wc -l)" -eq 0 ]; then ok "claim: --force cleaned the active claim"; else bad "claim: active ref lingered after force"; fi
git push -q origin HEAD:master

# ---------------------------------------------------------------------------
# TEST 7: a no-tree-change (empty) historical commit is refused
# ---------------------------------------------------------------------------
git commit -q --allow-empty -m "empty commit on master (no tree change)"
EMPTY_C=$(git rev-parse HEAD); git push -q origin HEAD:master
T7=$(mk_task "t7 empty hist")
out=$("$TD" complete-historical "$T7" --commit="$EMPTY_C" 2>&1); rc=$?
if [ $rc -eq 1 ] && echo "$out" | grep -qi "no tree change"; then ok "validation: no-tree-change --commit refused"; else bad "validation: no-tree-change rc=$rc: $out"; fi

# ---------------------------------------------------------------------------
# TEST 8: a task with NO Issue/URL trailers does not abort (optional fields)
# ---------------------------------------------------------------------------
ET=$(git hash-object -t tree /dev/null)
NOISSUE=$(git commit-tree "$ET" -p "$EPIC" -m "Task: no-trailer task

Type: leaf")
NSHORT=$(git rev-parse --short "$NOISSUE")
git update-ref "refs/heads/tasks/frontier/$NSHORT" "$NOISSUE"
git push -q origin "$NOISSUE:refs/heads/tasks/frontier/$NSHORT"
mk_history t8
out=$("$TD" complete-historical "$NSHORT" --commit="$HSHA" 2>"$ROOT/err8"); rc=$?
if [ $rc -eq 0 ] && [ "$(git rev-parse HEAD^2)" = "$NOISSUE" ]; then ok "trailers: task without Issue/URL links cleanly (rc=0)"; else bad "trailers: rc=$rc err=$(cat "$ROOT/err8")"; fi
MSG8=$(git log -1 --format='%B' HEAD)
echo "$MSG8" | grep -q "^Issue:" && bad "trailers: phantom Issue trailer added" || ok "trailers: no phantom Issue trailer"
echo "$MSG8" | grep -q "Historical-Commit: $HSHA" && ok "trailers: Historical-Commit still recorded" || bad "trailers: missing Historical-Commit"
git push -q origin HEAD:master

# ---------------------------------------------------------------------------
# TEST 9: HEAD ahead of origin/master (unpushed local work) is refused, no page
# ---------------------------------------------------------------------------
mk_history t9
T9b=$(mk_task "t9b ahead-victim")
echo local-ahead > local-ahead.txt; git add local-ahead.txt; git commit -qm "local ahead work"
P0=$(page_count)
out=$("$TD" complete-historical "$T9b" --commit="$HSHA" 2>&1); rc=$?
if [ $rc -eq 2 ] && echo "$out" | grep -qi "AHEAD of origin/master"; then ok "authority: HEAD-ahead refused (rc=2)"; else bad "authority: HEAD-ahead rc=$rc: $out"; fi
if [ "$(page_count)" -eq "$P0" ]; then ok "authority: HEAD-ahead refusal sent no page"; else bad "authority: HEAD-ahead unexpectedly paged"; fi

# ---------------------------------------------------------------------------
# TEST 10: a final historical leaf publishes its local epic-close before cleanup
# ---------------------------------------------------------------------------
git init -q --bare "$ROOT/origin-close.git"
git clone -q "$ROOT/origin-close.git" "$ROOT/wc-close"
cd "$ROOT/wc-close"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master
EMPTY_TREE_CLOSE=$(git mktree </dev/null)
EPIC_CLOSE=$(git commit-tree "$EMPTY_TREE_CLOSE" -p HEAD -m "Task: Historical close epic

Issue: #5252
URL: https://github.com/test/test/issues/5252
Author: tester
Status: pending
Type: epic")
git update-ref refs/heads/gh/issues/5252 "$EPIC_CLOSE"
git update-ref refs/heads/tasks/pending/5252 "$EPIC_CLOSE"
git push -q origin refs/heads/gh/issues/5252 refs/heads/tasks/pending/5252
printf '[{"title":"historical final leaf","type":"leaf"}]' > "$ROOT/spec-close.json"
"$TD" claim-root 5252 --force >/dev/null 2>&1
CLOSE_LEAF=$("$TD" breakdown "$EPIC_CLOSE" --spec-file="$ROOT/spec-close.json" --force --json 2>/dev/null \
  | grep -oE '"shortSha":"[0-9a-f]+"' | head -1 | cut -d'"' -f4)
echo historical-close > historical-close.txt; git add historical-close.txt; git commit -qm "historical close work"
CLOSE_HIST=$(git rev-parse HEAD)
git push -q origin HEAD:master
out=$("$TD" complete-historical "$CLOSE_LEAF" --commit="$CLOSE_HIST" 2>&1); rc=$?
git fetch -q origin master
if [ $rc -eq 0 ] && git log origin/master --format='%B' | grep -q '^Closes-Epic: #5252$'; then
  ok "historical final leaf publishes the Closes-Epic commit before returning"
else
  bad "historical final leaf did not publish close merge (rc=$rc out=$out)"
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
