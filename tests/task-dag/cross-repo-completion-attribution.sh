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
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_GIT_NAME=t TASK_DAG_GIT_EMAIL=t@t

# Stub `gh` on PATH:
#   - `gh repo view --json nameWithOwner ...` -> the top-level repo, so
#     _xrepo_current_repo resolves without touching the network;
#   - everything else (esp. `gh api repos/.../commits/<sha>`) FAILS, which
#     simulates a private cross-org peer whose commit top-level cannot read
#     (forcing the code onto the comment-supplied peer-issue path).
BIN="$ROOT/bin"; mkdir -p "$BIN"
cat > "$BIN/gh" <<'GH'
#!/usr/bin/env bash
if [ "${1:-}" = "repo" ] && [ "${2:-}" = "view" ]; then
  echo "virusdave/top-level"; exit 0
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

delegated:
  repo: $2/$3
  number: $4")
  git push -q origin "$sha:refs/heads/tasks/delegated/$1/$2/$3/$4"
}

remote_completion(){ # $1=epic $2=owner $3=repo $4=peer_issue -> nonempty if any completion ref exists
  git ls-remote origin "refs/heads/tasks/completions/$1/$2/$3/$4/*" 2>/dev/null | awk 'NR==1{print $1}'
}

ingest(){ # $1=issue $2=comment_id $3=body
  printf '%s' "$3" > "$ROOT/body.txt"
  "$TD" ingest-comment --issue "$1" --comment-id "$2" --author virusdave \
    --comment-url "https://x/$2" --body-file "$ROOT/body.txt" >"$ROOT/out.txt" 2>&1
}

O=Nicponskis; R=github-worker

# ── Case A: two same-repo delegations; peer-issue hint attributes right ──
make_delegation 34 "$O" "$R" 101
make_delegation 34 "$O" "$R" 102

ingest 34 5001 "<!-- task-dag:completion --> Satisfies virusdave/top-level#34 via $O/$R@aaaaaaa peer-issue 102"
[ -n "$(remote_completion 34 "$O" "$R" 102)" ] \
  && ok "A1: peer-issue 102 recorded a completion against delegated child #102" \
  || bad "A1: no completion ref for #102 ($(cat "$ROOT/out.txt"))"
[ -z "$(remote_completion 34 "$O" "$R" 101)" ] \
  && ok "A2: sibling child #101 got NO completion (correct attribution)" \
  || bad "A2: completion wrongly attributed to #101"

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

echo "-----"; echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
