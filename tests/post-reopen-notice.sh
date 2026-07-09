#!/usr/bin/env bash
#
# Test the idempotent single-comment upsert behavior of
# .github/scripts/post-reopen-notice.sh (issue #13, operator decision #2):
#
#   - The FIRST reopen posts exactly ONE comment.
#   - Any subsequent reopen is a no-op (still exactly one comment) — idempotent.
#   - The comment leads with `<!-- task-dag:status -->` (so `task-dag
#     ingest-comment` skips it -> no phantom task) AND carries the issue-scoped
#     `<!-- reopen-notice:<N> -->` identity marker used for the upsert.
#   - The identity marker is issue-scoped, so a foreign `task-dag:status`
#     comment already on the issue is NEITHER matched NOR clobbered (the notice
#     is still posted the first time, and never touches the foreign comment).
#   - The script touches NO git refs (it cannot create a task even in
#     principle).
#
# Self-contained: a `gh` stub backed by a JSON comment store on PATH. No
# network, no real GitHub. `$1` (CLI path) is accepted for run-all.sh
# uniformity but unused here.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/../.github/scripts/post-reopen-notice.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }
assert_eq() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1"; echo "        expected: [$2]"; echo "        actual:   [$3]"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# gh stub: a tiny JSON comment store the script reads (issue view) and writes
# (issue comment). It implements exactly the two gh invocations the script
# uses, delegating filtering to the real `jq` (as gh's own --jq does).
STORE="$WORK/comments.json"
echo '{"comments":[]}' > "$STORE"

mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<STUB
#!/usr/bin/env bash
set -euo pipefail
STORE="$STORE"
sub="\$1"; shift
op="\$1"; shift
case "\$sub:\$op" in
  issue:view)
    jqexpr=""
    while [ \$# -gt 0 ]; do
      case "\$1" in --jq) jqexpr="\$2"; shift 2 ;; *) shift ;; esac
    done
    jq -r "\$jqexpr" "\$STORE"
    ;;
  issue:comment)
    bodyfile=""
    while [ \$# -gt 0 ]; do
      case "\$1" in --body-file) bodyfile="\$2"; shift 2 ;; *) shift ;; esac
    done
    body="\$(cat "\$bodyfile")"
    tmp="\$(mktemp)"
    jq --arg b "\$body" '.comments += [{"body":\$b}]' "\$STORE" > "\$tmp"
    mv "\$tmp" "\$STORE"
    echo "posted comment"
    ;;
  *)
    echo "gh stub: unexpected call: \$sub \$op \$*" >&2
    exit 1
    ;;
esac
STUB
chmod +x "$WORK/bin/gh"
export PATH="$WORK/bin:$PATH"

# Count comments carrying the issue-scoped reopen-notice identity marker.
notice_count() { # <issue>
    jq --arg m "<!-- reopen-notice:$1 -->" \
        '[.comments[] | select(.body | contains($m))] | length' "$STORE"
}
# Count ALL comments in the store.
total_count() { jq '.comments | length' "$STORE"; }
# First body containing a substring.
body_with() { jq -r --arg m "$1" 'first(.comments[] | select(.body | contains($m)) | .body) // ""' "$STORE"; }

run_notice() { # <issue>
    GH_TOKEN="x" GH_REPO="owner/repo" ISSUE_NUMBER="$1" bash "$SCRIPT" >/dev/null
}

echo "== first reopen: posts exactly one notice comment =="
run_notice 13
assert_eq "one reopen-notice comment after first reopen" "1" "$(notice_count 13)"
assert_eq "one total comment after first reopen" "1" "$(total_count)"

echo "== notice carries required markers =="
b="$(body_with "<!-- reopen-notice:13 -->")"
first_line="$(printf '%s\n' "$b" | head -n1)"
assert_eq "status marker is physical line 1 (ingest skips -> no phantom task)" \
    "<!-- task-dag:status -->" "$first_line"
if printf '%s' "$b" | grep -Fq "<!-- reopen-notice:13 -->"; then
    ok "issue-scoped identity marker present"
else bad "issue-scoped identity marker missing"; fi
if printf '%s' "$b" | grep -Fq "NEW" && printf '%s' "$b" | grep -Fqi "in this thread"; then
    ok "body tells the reader to open a NEW task in-thread"
else bad "body missing the 'open a NEW task in-thread' instruction"; fi

echo "== second reopen: idempotent no-op (still exactly one comment) =="
run_notice 13
assert_eq "still one reopen-notice comment after second reopen" "1" "$(notice_count 13)"
assert_eq "still one total comment after second reopen" "1" "$(total_count)"

echo "== third reopen: still idempotent =="
run_notice 13
assert_eq "still one reopen-notice comment after third reopen" "1" "$(notice_count 13)"

echo "== foreign task-dag:status comment is not matched or clobbered =="
echo '{"comments":[{"body":"<!-- task-dag:status -->\nunrelated close notice"}]}' > "$STORE"
run_notice 21
assert_eq "notice posted despite a foreign status comment present" "1" "$(notice_count 21)"
assert_eq "foreign status comment preserved (2 total: foreign + notice)" "2" "$(total_count)"
run_notice 21
assert_eq "second reopen still idempotent alongside foreign comment" "1" "$(notice_count 21)"
assert_eq "no extra comment on idempotent rerun (still 2 total)" "2" "$(total_count)"

echo
echo "Passed: $PASS  Failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
