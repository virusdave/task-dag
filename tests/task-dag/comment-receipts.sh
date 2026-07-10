#!/usr/bin/env bash
# Durable GitHub comment receipt contract and atomic-ingestion fixtures.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
TD="$(cd "$(dirname "$TD")" && pwd)/$(basename "$TD")"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok(){ echo "PASS: $1"; PASS=$((PASS+1)); }
bad(){ echo "FAIL: $1"; FAIL=$((FAIL+1)); }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"
cd "$ROOT/wc"
echo seed >seed; git add seed; git commit -qm seed; git push -q origin HEAD:master
git config taskdag.current-repo acme/widgets
EMPTY=$(git mktree </dev/null)
EPIC=$(git commit-tree "$EMPTY" -p HEAD -m $'Task: receipt fixture\n\nIssue: #10\nType: epic')
git push -q origin "$EPIC:refs/heads/gh/issues/10"

remote_sha(){ git ls-remote origin "$1" 2>/dev/null | awk 'NR==1{print $1}'; }
field(){ git log -1 --format=%B "$1" | git interpret-trailers --parse | awk -F': ' -v k="$2" '$1==k{print substr($0,length(k)+3);exit}'; }
frontier_count(){ git ls-remote origin 'refs/heads/tasks/frontier/*' 2>/dev/null | wc -l | tr -d ' '; }
ingest_file(){
  "$TD" ingest-comment --issue 10 --comment-id "$1" --author alice \
    --comment-url "https://github.com/acme/widgets/issues/10#issuecomment-$1" \
    --created-at "${3:-2026-01-02T03:04:05Z}" --updated-at "${4:-2026-01-02T03:04:05Z}" \
    --body-file "$2"
}

# Human receipt and effect are bound, exact-byte hashed, and born together.
printf 'ship it' >"$ROOT/body"
ingest_file 100 "$ROOT/body" >/dev/null 2>&1
R100=$(remote_sha refs/heads/gh/comments/10/100)
E100=$(field "$R100" Effect-Commit); F100=$(field "$R100" Effect-Ref-At-Creation)
if [ -n "$R100" ] && [ "$(git log -1 --format=%s "$R100")" = 'Record GitHub comment receipt' ] \
  && [ "$(field "$R100" Disposition)" = human ] && [ "$(git rev-parse "$R100^")" = "$E100" ] \
  && [ "$(remote_sha "$F100")" = "$E100" ]; then
  ok "human receipt binds one effect parent and frontier"
else
  bad "human receipt/effect binding is malformed"
fi
[ "$(field "$R100" Body-SHA256)" = "$(sha256sum "$ROOT/body" | awk '{print $1}')" ] \
  && ok "receipt hashes exact body bytes" || bad "receipt body hash differs"

printf 'same' >"$ROOT/no-newline"; printf 'same\n' >"$ROOT/newline"
ingest_file 101 "$ROOT/no-newline" >/dev/null 2>&1
ingest_file 102 "$ROOT/newline" >/dev/null 2>&1
H101=$(field "$(remote_sha refs/heads/gh/comments/10/101)" Body-SHA256)
H102=$(field "$(remote_sha refs/heads/gh/comments/10/102)" Body-SHA256)
[ "$H101" != "$H102" ] && ok "trailing newline changes the observed body hash" \
  || bad "trailing newline was lost before hashing"

# A machine comment gets durable skip provenance and no task effect.
before=$(frontier_count); printf '<!-- task-dag:status -->\nprogress' >"$ROOT/skip"
ingest_file 103 "$ROOT/skip" >/dev/null 2>&1
R103=$(remote_sha refs/heads/gh/comments/10/103)
if [ "$(field "$R103" Disposition)" = machine-skip ] \
  && [ "$(git rev-list --parents -n1 "$R103" | awk '{print NF-1}')" = 0 ] \
  && [ "$(frontier_count)" = "$before" ]; then
  ok "machine marker creates a parentless skip receipt only"
else
  bad "machine marker created an effect or malformed receipt"
fi

# A failed atomic disposition push leaves neither receipt nor local/remote effect.
REAL_GIT=$(command -v git); mkdir "$ROOT/fail-bin"
cat >"$ROOT/fail-bin/git" <<'SH'
#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in *gh/comments/10/104*) exit 1;; esac
done
exec "$REAL_GIT" "$@"
SH
chmod +x "$ROOT/fail-bin/git"; export REAL_GIT
before_remote=$(frontier_count); before_local=$(git for-each-ref refs/heads/tasks/frontier/ | wc -l)
printf 'must be atomic' >"$ROOT/fail"
if PATH="$ROOT/fail-bin:$PATH" ingest_file 104 "$ROOT/fail" >/dev/null 2>&1; then
  bad "injected atomic push failure unexpectedly succeeded"
elif [ -z "$(remote_sha refs/heads/gh/comments/10/104)" ] \
  && [ "$(frontier_count)" = "$before_remote" ] \
  && [ "$(git for-each-ref refs/heads/tasks/frontier/ | wc -l)" = "$before_local" ] \
  && ! git show-ref --verify --quiet refs/heads/gh/comments/10/104; then
  ok "failed atomic push leaves no receipt or effect locally/remotely"
else
  bad "failed atomic push left half a disposition"
fi

# Local-only provenance is never terminal; the origin winner replaces it.
git update-ref refs/heads/gh/comments/10/105 HEAD
printf 'origin decides' >"$ROOT/local-only"
ingest_file 105 "$ROOT/local-only" >/dev/null 2>&1
R105=$(remote_sha refs/heads/gh/comments/10/105)
[ -n "$R105" ] && [ "$R105" != "$(git rev-parse HEAD)" ] \
  && [ "$(git rev-parse refs/heads/gh/comments/10/105)" = "$R105" ] \
  && ok "local-only receipt is ignored and replaced after origin success" \
  || bad "local-only state incorrectly terminated ingestion"

# Existing valid origin provenance short-circuits before reclassification.
before=$(frontier_count); printf '<!-- task-dag:status --> edited later' >"$ROOT/edit"
if ingest_file 100 "$ROOT/edit" 2026-99-99T00:00:00Z 2025-01-01T00:00:00Z >/dev/null 2>&1 \
  && [ "$(remote_sha refs/heads/gh/comments/10/100)" = "$R100" ] \
  && [ "$(frontier_count)" = "$before" ]; then
  ok "valid origin receipt short-circuits current edited content"
else
  bad "existing receipt did not short-circuit before classification"
fi

# Malformed provenance is fatal and immutable.
BAD=$(git commit-tree "$EMPTY" -m 'not provenance')
git push -q origin "$BAD:refs/heads/gh/comments/10/106"
printf 'do not overwrite' >"$ROOT/bad"
if ingest_file 106 "$ROOT/bad" >/dev/null 2>&1; then
  bad "malformed origin provenance was accepted"
elif [ "$(remote_sha refs/heads/gh/comments/10/106)" = "$BAD" ]; then
  ok "malformed origin provenance fails without replacement"
else
  bad "malformed origin provenance was overwritten"
fi

# Recognised immutable legacy shapes remain terminal. Completion refs may
# share one fact even when its embedded source comment ID names another ref.
LH=$(git commit-tree "$EMPTY" -p "$EPIC" -m $'kind: message\nrole: human\nintent: comment\n\nissue:\n  number: 10\n\ngithub:\n  comment_id: 107')
LC=$(git commit-tree "$EMPTY" -p "$EPIC" -m $'kind: completion\nrole: system\nintent: cross-repo-satisfied\n\nissue:\n  repo: acme/widgets\n  number: 10\n\nsource:\n  comment_id: 999')
git push -q origin "$LH:refs/heads/gh/comments/10/107" "$LC:refs/heads/gh/comments/10/108" "$LC:refs/heads/gh/comments/10/109"
printf 'edited' >"$ROOT/legacy"
if ingest_file 107 "$ROOT/legacy" >/dev/null 2>&1 \
  && ingest_file 108 "$ROOT/legacy" >/dev/null 2>&1 \
  && ingest_file 109 "$ROOT/legacy" >/dev/null 2>&1; then
  ok "legacy human and shared completion provenance remain accepted"
else
  bad "a recognised legacy provenance shape was rejected"
fi

# Immutable frontier prefixes remain valid when Git changes abbreviation
# length, and strict validation never consults GitHub.
git config core.abbrev 12
mkdir "$ROOT/offline-bin"; : >"$ROOT/gh-calls"
cat >"$ROOT/offline-bin/gh" <<'SH'
#!/usr/bin/env bash
echo "$*" >>"$GH_CALL_LOG"
exit 99
SH
chmod +x "$ROOT/offline-bin/gh"; export GH_CALL_LOG="$ROOT/gh-calls"
if GITHUB_REPOSITORY=acme/widgets PATH="$ROOT/offline-bin:$PATH" "$TD" validate --strict >/dev/null 2>&1 \
  && [ ! -s "$ROOT/gh-calls" ]; then
  ok "strict receipt validation is offline and abbreviation-stable"
else
  bad "strict receipt validation used gh or depended on core.abbrev"
fi

# No public compatibility command may independently write comment refs.
before=$(git ls-remote origin 'refs/heads/gh/comments/*' | wc -l)
if "$TD" ingest-completion --issue 10 --comment-id 111 --comment-url https://x/111 \
    --from peer/repo@aaaaaaa >/dev/null 2>&1; then
  bad "direct ingest-completion unexpectedly published"
elif [ "$(git ls-remote origin 'refs/heads/gh/comments/*' | wc -l)" = "$before" ]; then
  ok "direct ingest-completion cannot bypass the atomic receipt writer"
else
  bad "direct ingest-completion changed comment provenance"
fi

# Simulate a competing human writer winning the receipt transaction, then
# having its frontier consumed before our attempted push returns. The loser
# must accept the distinct receipt winner without recreating either frontier.
mkdir "$ROOT/race-bin"; printf 'race body' >"$ROOT/race-body"
cat >"$ROOT/race-bin/git" <<'SH'
#!/usr/bin/env bash
candidate_receipt=
for a in "$@"; do
  case "$a" in *:refs/heads/gh/comments/10/112) candidate_receipt=${a%%:*};; esac
done
if [ -n "$candidate_receipt" ]; then
  candidate_effect=$("$REAL_GIT" rev-parse "$candidate_receipt^")
  epic=$("$REAL_GIT" rev-parse "$candidate_effect^")
  winner_effect=$("$REAL_GIT" log -1 --format=%B "$candidate_effect" \
    | sed 's/^message_id:.*/message_id: msg_simulated_race_winner/' \
    | "$REAL_GIT" commit-tree "$RACE_EMPTY" -p "$epic" -F -)
  winner_short=$("$REAL_GIT" rev-parse --short "$winner_effect")
  winner_ref="refs/heads/tasks/frontier/$winner_short"
  winner_receipt=$("$REAL_GIT" log -1 --format=%B "$candidate_receipt" \
    | sed -e "s/^Effect-Commit:.*/Effect-Commit: $winner_effect/" \
          -e "s#^Effect-Ref-At-Creation:.*#Effect-Ref-At-Creation: $winner_ref#" \
    | "$REAL_GIT" commit-tree "$RACE_EMPTY" -p "$winner_effect" -F -)
  "$REAL_GIT" push -q --atomic origin \
    "--force-with-lease=refs/heads/gh/comments/10/112:" \
    "--force-with-lease=$winner_ref:" \
    "$winner_receipt:refs/heads/gh/comments/10/112" "$winner_effect:$winner_ref"
  "$REAL_GIT" push -q origin ":$winner_ref"
  exit 1
fi
exec "$REAL_GIT" "$@"
SH
chmod +x "$ROOT/race-bin/git"; export RACE_EMPTY="$EMPTY"
before=$(frontier_count)
PATH="$ROOT/race-bin:$PATH" ingest_file 112 "$ROOT/race-body" >"$ROOT/race.log" 2>&1; RACE_RC=$?
R112=$(remote_sha refs/heads/gh/comments/10/112)
git fetch -q origin refs/heads/gh/comments/10/112
F112=$(field "$R112" Effect-Ref-At-Creation)
if [ "$RACE_RC" = 0 ] && [ -n "$R112" ] \
  && [ -z "$(remote_sha "$F112")" ] && [ "$(frontier_count)" = "$before" ]; then
  ok "concurrent human loser cannot resurrect a consumed frontier"
else
  bad "concurrent human ingestion resurrected or failed to accept the winner (rc=$RACE_RC; log=$(tr '\n' ' ' <"$ROOT/race.log"))"
fi

# Versioned receipts cannot hide under malformed paths in the otherwise-known
# comments namespace.
git update-ref refs/heads/gh/comments/foo/bar "$R100"
if "$TD" validate --strict >/dev/null 2>&1; then
  bad "strict validation accepted a versioned receipt at a malformed path"
else
  ok "strict validation rejects malformed versioned receipt paths"
fi
git update-ref -d refs/heads/gh/comments/foo/bar

# Receipt-version opt-in tightens strict validation without affecting legacy.
UNSUPPORTED=$(git commit-tree "$EMPTY" -m $'Record GitHub comment receipt\n\nReceipt-Version: 2')
git update-ref refs/heads/gh/comments/10/110 "$UNSUPPORTED"
if "$TD" validate --strict >/dev/null 2>&1; then
  bad "strict validation accepted unsupported receipt version"
else
  ok "strict validation rejects unsupported receipt versions"
fi

echo "-----"; echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
