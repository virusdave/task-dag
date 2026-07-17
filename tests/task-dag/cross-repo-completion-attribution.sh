#!/usr/bin/env bash
# Fixture test: cross-repo completion attribution when a single peer repo
# has MULTIPLE delegated children under one epic AND the top-level side
# cannot read the (private, cross-org) peer commit.
#
# The peer-side aggregator carries the peer repo's OWN issue number in the
# completion comment (` peer-issue <M>`). Top-level `ingest-comment` parses
# it and `ingest-completion` uses it authoritatively (Strategy 0) to record
# the completion against the RIGHT delegated child — the only reliable
# disambiguator when Strategies 1-2 (read the peer commit) are impossible
# and Strategy 3 (exactly one delegation) does not apply.
#
# Also verifies:
#   - collision without the peer-issue hint (>1 delegations, unreadable
#     peer commit) records NO completion (the bug this fixes);
#   - a bogus peer-issue (no matching delegation) is IGNORED and falls
#     through to the single-delegation strategy (never wedges).
set -uo pipefail
TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok(){ echo "PASS: $1"; PASS=$((PASS+1)); }
bad(){ echo "FAIL: $1"; FAIL=$((FAIL+1)); }
if [ "$($TD migration-status --json | jq -r .mode)" = draining-legacy-writers ]; then
  "$(dirname "$TD")/aggregate-cross-repo-completions.sh" >/dev/null 2>&1; rc=$?
  [ "$rc" -eq 75 ] && { echo "PASS: legacy cross-repo completion ingestion integration is drained"; exit 0; }
  echo "FAIL: expected migration status 75, got $rc"; exit 1
fi
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_GIT_NAME=t TASK_DAG_GIT_EMAIL=t@t

# Stub `gh` on PATH:
#   - `gh repo view --json nameWithOwner ...` -> the top-level repo, so
#     _xrepo_current_repo resolves without touching the network;
#   - everything else (esp. `gh api repos/.../commits/<sha>`) FAILS, which
#     simulates a private cross-org peer whose commit top-level cannot read
#     (forcing the code onto the comment-supplied peer-issue path).
BIN="$ROOT/bin"; mkdir -p "$BIN"
REAL_GIT=$(command -v git)
cat > "$BIN/gh" <<'GH'
#!/usr/bin/env bash
if [ "${1:-}" = "repo" ] && [ "${2:-}" = "view" ]; then
  echo "VirusDave/Top-Level"; exit 0
fi
exit 1
GH
chmod +x "$BIN/gh"
export PATH="$BIN:$PATH"

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"; cd "$ROOT/wc"
echo s>s; git add s; git commit -qm s; git push -q origin HEAD:master

EMPTY=$(git mktree </dev/null)

# Craft a delegation ref exactly like `delegate` produces (empty-tree
# metadata commit) and publish it on origin.
make_delegation(){ # $1=epic $2=owner $3=repo $4=peer_issue
  local sha
  sha=$(git commit-tree "$EMPTY" -m "kind: delegated
role: system
intent: delegated-child

issue:
  repo: virusdave/top-level
  number: $1

delegated:
  repo: $2/$3
  number: $4")
  git push -q origin "$sha:refs/heads/tasks/delegated/$1/$2/$3/$4"
}

make_rooted_delegation(){ # $1=epic $2=root $3=owner $4=repo $5=peer_issue
  local sha
  sha=$(git commit-tree "$EMPTY" -p "$2" -m "kind: delegated
role: system
intent: delegated-child

issue:
  repo: virusdave/top-level
  number: $1

delegated:
  repo: $3/$4
  number: $5")
  git push -q origin "$sha:refs/heads/tasks/delegated/$1/$3/$4/$5"
}

remote_completion(){ # $1=epic $2=owner $3=repo $4=peer_issue -> nonempty if any completion ref exists
  git ls-remote origin "refs/heads/tasks/completions/$1/$2/$3/$4/*" 2>/dev/null | awk 'NR==1{print $1}'
}

ingest(){ # $1=issue $2=comment_id $3=body
  printf '%s' "$3" > "$ROOT/body.txt"
  "$TD" ingest-comment --issue "$1" --comment-id "$2" --author virusdave \
    --comment-url "https://x/$2" --created-at 2026-01-02T03:04:05Z --updated-at 2026-01-02T03:04:05Z \
    --body-file "$ROOT/body.txt" >"$ROOT/out.txt" 2>&1
}

O=Nicponskis; R=github-worker

# ── Case A: two same-repo delegations; peer-issue hint attributes right ──
make_delegation 34 "$O" "$R" 101
make_delegation 34 "$O" "$R" 102

ingest 34 5001 "<!-- task-dag:completion --> Satisfies virusdave/top-level#34 via $O/$R@aaaaaaa peer-issue 102"
COMPLETION_102=$(remote_completion 34 "$O" "$R" 102)
[ -n "$COMPLETION_102" ] \
  && ok "A1: peer-issue 102 recorded a completion against delegated child #102" \
  || bad "A1: no completion ref for #102 ($(cat "$ROOT/out.txt"))"
[ -z "$(remote_completion 34 "$O" "$R" 101)" ] \
  && ok "A2: sibling child #101 got NO completion (correct attribution)" \
  || bad "A2: completion wrongly attributed to #101"

# The comment ref is now a dedicated receipt parented to the fact. A second
# comment for the same source commit validates/reuses the existing fact and
# creates only its own receipt.
RECEIPT_5001=$(git ls-remote origin refs/heads/gh/comments/34/5001 | awk 'NR==1{print $1}')
if [ "$(git log -1 --format=%B "$RECEIPT_5001" | git interpret-trailers --parse | awk -F': ' '$1=="Disposition"{print $2}')" = completion ] \
  && [ "$(git rev-parse "$RECEIPT_5001^")" = "$COMPLETION_102" ]; then
  ok "A2b: completion comment receipt is parented to the durable fact"
else
  bad "A2b: completion comment ref is not a fact-bound receipt"
fi
ingest 34 5011 "<!-- task-dag:completion --> Satisfies virusdave/top-level#34 via $O/$R@aaaaaaa peer-issue 102"
RECEIPT_5011=$(git ls-remote origin refs/heads/gh/comments/34/5011 | awk 'NR==1{print $1}')
if [ "$(remote_completion 34 "$O" "$R" 102)" = "$COMPLETION_102" ] \
  && [ "$(git rev-parse "$RECEIPT_5011^")" = "$COMPLETION_102" ]; then
  ok "A2c: an existing valid completion fact is reused by a new receipt"
else
  bad "A2c: existing completion fact was moved or not reused"
fi

# ── Case A': phase AND peer-issue suffixes together parse correctly ──
ingest 34 5002 "<!-- task-dag:completion --> Satisfies virusdave/top-level#34 via $O/$R@bbbbbbb phase P2 peer-issue 101"
[ -n "$(remote_completion 34 "$O" "$R" 101)" ] \
  && ok "A3: ' phase P2 peer-issue 101' parses; completion recorded for #101" \
  || bad "A3: phase+peer-issue suffix did not resolve #101 ($(cat "$ROOT/out.txt"))"

# ── Case B: two same-repo delegations, NO peer-issue hint, unreadable ──
#            peer commit -> ambiguous -> NO completion recorded (the bug). ─
make_delegation 41 "$O" "$R" 301
make_delegation 41 "$O" "$R" 302
ingest 41 5003 "<!-- task-dag:completion --> Satisfies virusdave/top-level#41 via $O/$R@ccccccc"
if [ -z "$(remote_completion 41 "$O" "$R" 301)" ] && [ -z "$(remote_completion 41 "$O" "$R" 302)" ]; then
  ok "B1: legacy comment (no peer-issue) with >1 delegations records nothing (fails loud, no misattribution)"
else
  bad "B1: an ambiguous legacy completion was recorded against some child"
fi

# ── Case C: bogus peer-issue (no matching delegation) falls THROUGH to ──
#            the single-delegation strategy instead of wedging. ──
make_delegation 42 "$O" "$R" 201
ingest 42 5004 "<!-- task-dag:completion --> Satisfies virusdave/top-level#42 via $O/$R@ddddddd peer-issue 999"
[ -n "$(remote_completion 42 "$O" "$R" 201)" ] \
  && ok "C1: bogus peer-issue 999 ignored; fell through to the sole delegation #201" \
  || bad "C1: bogus peer-issue wedged the completion ($(cat "$ROOT/out.txt"))"

# ── Case D: an earlier close retired pending/<N>; a delegated completion ──
#            arriving later must observe the durable close via gh/issues/N,
#            record successfully, and never recreate the retired root. ──
ROOT_43=$(git commit-tree "$EMPTY" -p HEAD -m "Task: retired delegated epic

Issue: #43
Type: epic")
git push -q origin \
  "$ROOT_43:refs/heads/gh/issues/43" \
  "$ROOT_43:refs/heads/tasks/pending/43"
make_rooted_delegation 43 "$ROOT_43" "$O" "$R" 401
MASTER_43=$(git rev-parse HEAD)
TREE_43=$(git rev-parse "${MASTER_43}^{tree}")
CLOSE_43=$(git commit-tree "$TREE_43" -p "$MASTER_43" -p "$ROOT_43" -m "Close retired delegated epic

Closes-Epic: #43")
git update-ref refs/heads/master "$CLOSE_43"
git push -q origin master:master
git fetch -q origin '+refs/heads/master:refs/remotes/origin/master'
git push -q origin --delete refs/heads/tasks/pending/43
git update-ref -d refs/heads/tasks/pending/43

if ingest 43 5005 "<!-- task-dag:completion --> Satisfies virusdave/top-level#43 via $O/$R@eeeeeee peer-issue 401" \
  && grep -Fq 'close-epic: epic 43 already closed on master' "$ROOT/out.txt"; then
  ok "D1: late completion reached the idempotent already-closed path"
else
  bad "D1: late completion did not converge through close-epic ($(cat "$ROOT/out.txt"))"
fi
[ -n "$(remote_completion 43 "$O" "$R" 401)" ] \
  && ok "D2: late completion remains durably recorded" \
  || bad "D2: late completion ref was not recorded"
[ -z "$(git ls-remote origin refs/heads/tasks/pending/43)" ] \
  && ok "D3: retired pending root was not recreated" \
  || bad "D3: late convergence recreated tasks/pending/43"
[ "$(git ls-remote origin refs/heads/gh/issues/43 | awk 'NR==1{print $1}')" = "$ROOT_43" ] \
  && ok "D4: gh/issues preserves the original epic identity" \
  || bad "D4: gh/issues/43 no longer identifies the original root"
CLOSE_COUNT=$(git log origin/master --merges --format='%H' --grep='^Closes-Epic: #43$' | wc -l | tr -d '[:space:]')
[ "$CLOSE_COUNT" = 1 ] \
  && ok "D5: late convergence did not emit a duplicate close" \
  || bad "D5: expected one close for #43, found $CLOSE_COUNT"

# ── Case E: retained identity alone is not permission to recreate or close ──
#            an epic when no matching durable close fact exists. ──
ROOT_44=$(git commit-tree "$EMPTY" -p HEAD -m "Task: retired but not closed

Issue: #44
Type: epic")
git push -q origin "$ROOT_44:refs/heads/gh/issues/44"
if "$TD" close-epic --issue 44 >"$ROOT/close-44.txt" 2>&1; then
  bad "E1: gh/issues-only identity without a close was accepted"
elif [ -z "$(git ls-remote origin refs/heads/tasks/pending/44)" ]; then
  ok "E1: gh/issues-only identity without a close fails without recreating pending"
else
  bad "E1: failed close recreated tasks/pending/44"
fi

# ── Case F: conflicting structural/live identities fail closed. ───────────
ROOT_45_GH=$(git commit-tree "$EMPTY" -p HEAD -m "Task: structural identity

Issue: #45
Type: epic")
ROOT_45_PENDING=$(git commit-tree "$EMPTY" -p HEAD -m "Task: conflicting live identity

Issue: #45
Type: epic")
git push -q origin \
  "$ROOT_45_GH:refs/heads/gh/issues/45" \
  "$ROOT_45_PENDING:refs/heads/tasks/pending/45"
MASTER_BEFORE_MISMATCH=$(git ls-remote origin refs/heads/master | awk 'NR==1{print $1}')
if "$TD" close-epic --issue 45 >"$ROOT/close-45.txt" 2>&1; then
  bad "F1: mismatched gh/issues and pending identities were accepted"
elif [ "$(git ls-remote origin refs/heads/master | awk 'NR==1{print $1}')" = "$MASTER_BEFORE_MISMATCH" ]; then
  ok "F1: mismatched gh/issues and pending identities fail without moving master"
else
  bad "F1: identity mismatch moved master"
fi

# ── Case G: pending-only legacy identity still supports idempotent close. ──
ROOT_46=$(git commit-tree "$EMPTY" -p HEAD -m "Task: legacy pending-only epic

Issue: #46
Type: epic")
git push -q origin "$ROOT_46:refs/heads/tasks/pending/46"
MASTER_46=$(git rev-parse HEAD)
TREE_46=$(git rev-parse "${MASTER_46}^{tree}")
CLOSE_46=$(git commit-tree "$TREE_46" -p "$MASTER_46" -p "$ROOT_46" -m "Close legacy epic

Closes-Epic: #46")
git update-ref refs/heads/master "$CLOSE_46"
git push -q origin master:master
if "$TD" close-epic --issue 46 >"$ROOT/close-46.txt" 2>&1 \
  && grep -Fq 'close-epic: epic 46 already closed on master' "$ROOT/close-46.txt"; then
  ok "G1: pending-only legacy identity recognizes its durable close"
else
  bad "G1: pending-only legacy close was not idempotent ($(cat "$ROOT/close-46.txt"))"
fi

# A git shim gives the close command deterministic race/failure injection
# without adding test-only hooks to production code.
cat > "$BIN/git" <<'GIT'
#!/usr/bin/env bash
set -u
master_fetch='fetch --quiet --no-tags origin +refs/heads/master:refs/remotes/origin/master'
if [ "${RACE_MODE:-}" = fail-identity ] && [ "${1:-}" = ls-remote ] \
  && [[ "$*" == *"refs/heads/gh/issues/${RACE_ISSUE}"* ]]; then
  exit 128
fi
if [ "${1:-}" = fetch ] && [ "$*" = "$master_fetch" ] && [ -n "${RACE_MODE:-}" ]; then
  count=0
  [ ! -f "$RACE_COUNT_FILE" ] || count=$(cat "$RACE_COUNT_FILE")
  count=$((count + 1))
  printf '%s\n' "$count" > "$RACE_COUNT_FILE"
  if [ "$count" -eq 2 ] && [ "$RACE_MODE" = fail-final-fetch ]; then
    exit 128
  fi
  if [ "$count" -eq 2 ] && [ "$RACE_MODE" = concurrent-close ]; then
    base=$($REAL_GIT rev-parse refs/remotes/origin/master)
    tree=$($REAL_GIT rev-parse "${base}^{tree}")
    close=$($REAL_GIT commit-tree "$tree" -p "$base" -p "$RACE_ROOT" -m "Concurrent close

Closes-Epic: #${RACE_ISSUE}")
    $REAL_GIT push -q origin "$close:refs/heads/master"
    $REAL_GIT push -q origin --delete "refs/heads/tasks/pending/${RACE_ISSUE}"
    $REAL_GIT update-ref -d "refs/heads/tasks/pending/${RACE_ISSUE}"
    printf '%s\n' "$close" > "$RACE_CLOSE_FILE"
  fi
fi
exec "$REAL_GIT" "$@"
GIT
chmod +x "$BIN/git"
export REAL_GIT

# ── Case H: a close landing between the two master snapshots is observed ──
#            instead of producing a duplicate descendant close. ──
ROOT_47=$($REAL_GIT commit-tree "$EMPTY" -p HEAD -m "Task: concurrently closed epic

Issue: #47
Type: epic")
$REAL_GIT push -q origin \
  "$ROOT_47:refs/heads/gh/issues/47" \
  "$ROOT_47:refs/heads/tasks/pending/47"
make_rooted_delegation 47 "$ROOT_47" "$O" "$R" 701
DELEG_47=$($REAL_GIT ls-remote origin "refs/heads/tasks/delegated/47/$O/$R/701" | awk 'NR==1{print $1}')
COMP_47=$($REAL_GIT commit-tree "$EMPTY" -p "$DELEG_47" -m 'kind: completion')
$REAL_GIT push -q origin "$COMP_47:refs/heads/tasks/completions/47/$O/$R/701/witness"
export RACE_MODE=concurrent-close RACE_ISSUE=47 RACE_ROOT="$ROOT_47"
export RACE_COUNT_FILE="$ROOT/race-count" RACE_CLOSE_FILE="$ROOT/race-close"
rm -f "$RACE_COUNT_FILE" "$RACE_CLOSE_FILE"
if "$TD" close-epic --issue 47 >"$ROOT/close-47.txt" 2>&1 \
  && grep -Fq 'already closed on master (concurrent close)' "$ROOT/close-47.txt"; then
  ok "H1: concurrent close is observed by the final idempotency check"
else
  bad "H1: concurrent close did not converge ($(cat "$ROOT/close-47.txt"))"
fi
unset RACE_MODE
INJECTED_CLOSE=$(cat "$RACE_CLOSE_FILE" 2>/dev/null || true)
CLOSE_COUNT=$($REAL_GIT log "$INJECTED_CLOSE" --merges --format='%H' --grep='^Closes-Epic: #47$' | wc -l | tr -d '[:space:]')
if [ -n "$INJECTED_CLOSE" ] \
  && [ "$($REAL_GIT ls-remote origin refs/heads/master | awk 'NR==1{print $1}')" = "$INJECTED_CLOSE" ] \
  && [ "$CLOSE_COUNT" = 1 ] \
  && [ -z "$($REAL_GIT ls-remote origin refs/heads/tasks/pending/47)" ]; then
  ok "H2: concurrent convergence leaves one close and no pending root"
else
  bad "H2: concurrent convergence changed master twice or recreated pending"
fi

# ── Case I: the final master refresh fails closed without mutation. ────────
ROOT_48=$($REAL_GIT commit-tree "$EMPTY" -p HEAD -m "Task: refresh failure epic

Issue: #48
Type: epic")
$REAL_GIT push -q origin \
  "$ROOT_48:refs/heads/gh/issues/48" \
  "$ROOT_48:refs/heads/tasks/pending/48"
make_rooted_delegation 48 "$ROOT_48" "$O" "$R" 801
DELEG_48=$($REAL_GIT ls-remote origin "refs/heads/tasks/delegated/48/$O/$R/801" | awk 'NR==1{print $1}')
COMP_48=$($REAL_GIT commit-tree "$EMPTY" -p "$DELEG_48" -m 'kind: completion')
$REAL_GIT push -q origin "$COMP_48:refs/heads/tasks/completions/48/$O/$R/801/witness"
MASTER_BEFORE_FAILURE=$($REAL_GIT ls-remote origin refs/heads/master | awk 'NR==1{print $1}')
export RACE_MODE=fail-final-fetch RACE_ISSUE=48 RACE_ROOT="$ROOT_48"
export RACE_COUNT_FILE="$ROOT/fail-count"
rm -f "$RACE_COUNT_FILE"
if ingest 48 5006 "<!-- task-dag:completion --> Satisfies virusdave/top-level#48 via $O/$R@fffffff peer-issue 801"; then
  bad "I1: ingest accepted a final master refresh failure"
elif [ "$($REAL_GIT ls-remote origin refs/heads/master | awk 'NR==1{print $1}')" = "$MASTER_BEFORE_FAILURE" ] \
  && [ "$($REAL_GIT ls-remote origin refs/heads/tasks/pending/48 | awk 'NR==1{print $1}')" = "$ROOT_48" ]; then
  ok "I1: ingest propagates final refresh failure without durable mutation"
else
  bad "I1: final refresh failure mutated durable state"
fi
unset RACE_MODE

# ── Case J: an indeterminate identity lookup fails closed. ────────────────
MASTER_BEFORE_ID_FAILURE=$($REAL_GIT ls-remote origin refs/heads/master | awk 'NR==1{print $1}')
export RACE_MODE=fail-identity RACE_ISSUE=46 RACE_ROOT="$ROOT_46"
export RACE_COUNT_FILE="$ROOT/identity-count"
rm -f "$RACE_COUNT_FILE"
if "$TD" close-epic --issue 46 >"$ROOT/close-identity.txt" 2>&1; then
  bad "J1: indeterminate gh/issues lookup was accepted"
elif [ "$($REAL_GIT ls-remote origin refs/heads/master | awk 'NR==1{print $1}')" = "$MASTER_BEFORE_ID_FAILURE" ]; then
  ok "J1: indeterminate identity lookup fails without moving master"
else
  bad "J1: identity lookup failure moved master"
fi
unset RACE_MODE
rm -f "$BIN/git"

echo "-----"; echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
