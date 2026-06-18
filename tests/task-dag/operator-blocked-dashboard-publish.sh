#!/usr/bin/env bash
# Fixture test for the operator-blocked dashboard PUBLISHER front-end
# (scripts/operator-blocked-dashboard-publish.sh; epic
# operator-blocked-aggregator task @6, virusdave/top-level#29).
#
# The publisher's job is to turn bare "owner/repo" entries into
# App-authenticated git URLs for the renderer and to mint the comment-write
# token, while passing "owner/repo=<giturl>" overrides through untouched.
# This test exercises everything that does NOT require the network/App key:
#
#   * override entries (`owner/repo=file://...`) are forwarded verbatim, so
#     the wrapper drives the renderer end-to-end against file:// repos with
#     a preset GH_TOKEN (no minting, no network);
#   * --dry-run renders both markers and never needs a publish token;
#   * a bare entry with NO App credentials is WARNED + SKIPPED (graceful
#     degradation) while override entries still publish;
#   * if EVERY repo is unauthable the wrapper fails loud;
#   * --target-repo / --target-issue are required.
#
# The token-minting curl/openssl path itself is intentionally not unit
# tested (it needs a live GitHub App); it is a compact copy of the proven
# top-level/.github/scripts/materialise-child-epics.sh helpers and is
# covered by shellcheck + bash -n in run-all.sh.
set -uo pipefail

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)"
TD="${1:-$SCRIPTS/task-dag}"
PUB="$SCRIPTS/operator-blocked-dashboard-publish.sh"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

command -v jq >/dev/null 2>&1 || { echo "jq is required"; echo "PASS=0 FAIL=1"; exit 1; }
[ -x "$PUB" ] || { echo "publisher not executable: $PUB"; echo "PASS=0 FAIL=1"; exit 1; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_CLAIMER=alice TASK_DAG_CLAIMER_HOST=host7

# ---------------------------------------------------------------------------
# Build a fixture repo with an epic + one operator-blocked leaf task.
make_repo() {  # $1=name $2=issue $3=ownerrepo
    local name="$1" issue="$2" ownerrepo="$3"
    local org="$ROOT/$name/origin.git" wc="$ROOT/$name/wc"
    mkdir -p "$ROOT/$name"
    git init -q --bare "$org"
    git clone -q "$org" "$wc" 2>/dev/null
    ( cd "$wc"
      echo seed > seed.txt; git add seed.txt; git commit -qm seed
      git push -q origin HEAD:master 2>/dev/null
      local et; et=$(git hash-object -t tree /dev/null)
      local epic; epic=$(git commit-tree "$et" -p HEAD -m "Task: $name epic

Issue: #$issue
URL: https://github.com/$ownerrepo/issues/$issue
Author: tester
Status: pending
Type: epic")
      git update-ref "refs/heads/tasks/pending/$issue" "$epic"
      git push -q origin "refs/heads/tasks/pending/$issue" 2>/dev/null
      echo "$epic" > "$ROOT/$name/epic.sha" )
    echo "$org"
}
mk_task() {  # $1=wc $2=title -> short sha
    local wc="$1" title="$2" epic
    epic=$(cat "$(dirname "$wc")/epic.sha")
    printf '[{"title":"%s","type":"leaf"}]' "$title" > "$ROOT/spec.json"
    ( cd "$wc" && "$TD" breakdown "$epic" --spec-file="$ROOT/spec.json" --force --json 2>/dev/null ) \
        | grep -oE '"shortSha":"[0-9a-f]+"' | head -1 | cut -d'"' -f4
}

A=$(make_repo a 101 acme/alpha)
B=$(make_repo b 202 acme/beta)
WCA="$ROOT/a/wc"; WCB="$ROOT/b/wc"

TA_OP=$(mk_task "$WCA" "alpha operator blocker")
( cd "$WCA" && "$TD" block "$TA_OP" --operator --reason="approve canary deploy" >/dev/null 2>&1 )
TB_OP=$(mk_task "$WCB" "beta operator blocker")
( cd "$WCB" && "$TD" block "$TB_OP" --operator --reason="pick a vendor" >/dev/null 2>&1 )

OVR_A="acme/alpha=file://$A"
OVR_B="acme/beta=file://$B"

# Fake `gh` backed by a JSON comment store (same minimal shim as the
# renderer test) so the publish path needs no network.
BIN="$ROOT/bin"; mkdir -p "$BIN"
STORE="$ROOT/comments.json"; echo "[]" > "$STORE"
cat > "$BIN/gh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
STORE="$STORE"
EOF
cat >> "$BIN/gh" <<'EOF'
[ "${1:-}" = "api" ] || { echo "fake gh: only 'api' supported" >&2; exit 1; }
shift
method=GET; path=""; input=""; jqf=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --method) method="$2"; shift 2 ;;
    --method=*) method="${1#*=}"; shift ;;
    --paginate) shift ;;
    -H) shift 2 ;;
    --input) input="$2"; shift 2 ;;
    --jq) jqf="$2"; shift 2 ;;
    -f|-F) shift 2 ;;
    *) [ -z "$path" ] && path="$1"; shift ;;
  esac
done
body=""; [ "$input" = "-" ] && body="$(cat)"
out=""
case "$method" in
  GET) out="$(cat "$STORE")" ;;
  POST)
    b="$(printf '%s' "$body" | jq -r '.body')"
    id=$(( $(jq 'length' "$STORE") + 1000 ))
    jq --arg b "$b" --argjson id "$id" \
        '. + [{"id":$id,"body":$b,"html_url":("https://x/comments/"+($id|tostring))}]' \
        "$STORE" > "$STORE.tmp" && mv "$STORE.tmp" "$STORE"
    out="$(jq --argjson id "$id" '.[] | select(.id==$id)' "$STORE")" ;;
  PATCH)
    cid="${path##*/}"
    b="$(printf '%s' "$body" | jq -r '.body')"
    jq --arg b "$b" --argjson id "$cid" \
        'map(if .id==$id then .body=$b else . end)' \
        "$STORE" > "$STORE.tmp" && mv "$STORE.tmp" "$STORE"
    out="$(jq --argjson id "$cid" '.[] | select(.id==$id)' "$STORE")" ;;
esac
if [ -n "$jqf" ]; then printf '%s' "$out" | jq -r "$jqf"; else printf '%s' "$out"; fi
EOF
chmod +x "$BIN/gh"

# ---------------------------------------------------------------------------
# TEST 1: --dry-run with override entries forwards verbatim, renders both
# markers, needs neither GH_TOKEN nor App key.
DRY="$ROOT/dry.md"
( unset GH_TOKEN APP_ID APP_PRIVATE_KEY
  "$PUB" --target-repo=acme/alpha --target-issue=101 \
      --repos="$OVR_A $OVR_B" --task-dag="$TD" --dry-run ) > "$DRY" 2>"$ROOT/dry.err"
[ "$(sed -n 1p "$DRY")" = '<!-- task-dag:status -->' ] \
    && ok "1: dry-run line 1 is status marker" || bad "1: line 1 not status marker"
[ "$(sed -n 2p "$DRY")" = '<!-- operator-blocked-dashboard:v1 -->' ] \
    && ok "1: dry-run line 2 is dashboard marker" || bad "1: line 2 not dashboard marker"
grep -q "alpha operator blocker" "$DRY" && ok "1: alpha blocker (override forwarded)" \
    || bad "1: alpha blocker missing"
grep -q "beta operator blocker" "$DRY" && ok "1: beta blocker (cross-repo override forwarded)" \
    || bad "1: beta blocker missing"

# ---------------------------------------------------------------------------
# TEST 2: real publish with preset GH_TOKEN + fake gh creates one comment.
( unset APP_ID APP_PRIVATE_KEY
  GH_TOKEN=fake PATH="$BIN:$PATH" \
    "$PUB" --target-repo=acme/alpha --target-issue=101 \
        --repos="$OVR_A $OVR_B" --task-dag="$TD" ) >/dev/null 2>&1
N=$(jq 'length' "$STORE")
[ "$N" = "1" ] && ok "2: created exactly one dashboard comment" || bad "2: comment count $N (want 1)"
jq -r '.[0].body' "$STORE" | grep -q '<!-- operator-blocked-dashboard:v1 -->' \
    && ok "2: stored comment carries dashboard marker" || bad "2: dashboard marker missing"
jq -r '.[0].body' "$STORE" | grep -q "beta operator blocker" \
    && ok "2: cross-repo blocker present in published comment" || bad "2: cross-repo blocker missing"

# ---------------------------------------------------------------------------
# TEST 3: a bare entry with NO App creds is warned + skipped; override still
# publishes (graceful degradation).
echo "[]" > "$STORE"
ERR3="$ROOT/t3.err"
( unset APP_ID APP_PRIVATE_KEY
  GH_TOKEN=fake PATH="$BIN:$PATH" \
    "$PUB" --target-repo=acme/alpha --target-issue=101 \
        --repos="$OVR_A acme/beta" --task-dag="$TD" ) >/dev/null 2>"$ERR3"
rc=$?
[ "$rc" = "0" ] && ok "3: run succeeds despite an unauthable bare repo" || bad "3: exit $rc (want 0)"
grep -qi "skipping acme/beta" "$ERR3" && ok "3: unauthable bare repo skipped with warning" \
    || bad "3: no skip warning for bare repo"
N=$(jq 'length' "$STORE")
[ "$N" = "1" ] && ok "3: override repo still published one comment" || bad "3: comment count $N (want 1)"

# ---------------------------------------------------------------------------
# TEST 4: every repo unauthable -> fail loud.
ERR4="$ROOT/t4.err"
( unset APP_ID APP_PRIVATE_KEY
  GH_TOKEN=fake PATH="$BIN:$PATH" \
    "$PUB" --target-repo=acme/alpha --target-issue=101 \
        --repos="acme/beta" --task-dag="$TD" ) >/dev/null 2>"$ERR4"
rc=$?
[ "$rc" != "0" ] && ok "4: fails when no repo can be authenticated" || bad "4: unexpectedly succeeded"
grep -qi "no repos could be authenticated" "$ERR4" && ok "4: clear fail-loud message" \
    || bad "4: missing fail-loud message"

# ---------------------------------------------------------------------------
# TEST 5: required args enforced.
( "$PUB" --target-issue=101 --repos="$OVR_A" --dry-run ) >/dev/null 2>"$ROOT/t5a.err"
[ "$?" = "2" ] && ok "5: missing --target-repo exits 2" || bad "5: missing --target-repo wrong exit"
( "$PUB" --target-repo=acme/alpha --repos="$OVR_A" --dry-run ) >/dev/null 2>"$ROOT/t5b.err"
[ "$?" = "2" ] && ok "5: missing --target-issue exits 2" || bad "5: missing --target-issue wrong exit"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
