#!/usr/bin/env bash
# Fixture test for the operator-blocked #29 dashboard renderer
# (scripts/operator-blocked-dashboard.sh; epic operator-blocked-aggregator
# task @5, virusdave/top-level#29).
#
# Builds two throwaway bare "origin" repos (no network), parks tasks in
# them with operator / downstream / legacy blocks, then drives the renderer
# against file:// fetch URLs. A fake `gh` on PATH, backed by a JSON comment
# store, lets us prove the find/create/patch/no-op comment behaviour without
# touching GitHub.
#
# Coverage:
#   * --dry-run renders both markers as the first two lines;
#   * operator blockers appear in the main table; downstream are omitted;
#   * legacy (no-metadata) blocks render in the legacy section;
#   * cross-repo collection (two scanned repos in one dashboard);
#   * first publish CREATES the comment; identical rerun is a NO-OP;
#   * unblocking a task PATCHES the comment and drops the row.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
RENDER="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/operator-blocked-dashboard.sh"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

command -v jq >/dev/null 2>&1 || { echo "jq is required"; echo "PASS=0 FAIL=1"; exit 1; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_CLAIMER=alice TASK_DAG_CLAIMER_HOST=host7

# ---------------------------------------------------------------------------
# Build a fixture repo with an epic at issue $2 (repo display name $3 used in
# trailers' URL). Echoes the path to origin.git and the working clone.
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
      echo "$epic" > "$ROOT/$name/epic.sha"
    )
    echo "$org"
}

# Create a leaf task in repo working clone $1 under epic; echo short sha.
mk_task() {  # $1=wc $2=title
    local wc="$1" title="$2"
    local epic; epic=$(cat "$(dirname "$wc")/epic.sha")
    printf '[{"title":"%s","type":"leaf"}]' "$title" > "$ROOT/spec.json"
    ( cd "$wc" && "$TD" breakdown "$epic" --spec-file="$ROOT/spec.json" --force --json 2>/dev/null ) \
        | grep -oE '"shortSha":"[0-9a-f]+"' | head -1 | cut -d'"' -f4
}

A=$(make_repo a 101 acme/alpha)
B=$(make_repo b 202 acme/beta)
WCA="$ROOT/a/wc"; WCB="$ROOT/b/wc"

# Repo A: one operator block (with reason + request url), one downstream.
TA_OP=$(mk_task "$WCA" "alpha operator blocker")
( cd "$WCA" && "$TD" block "$TA_OP" --operator --reason="approve canary deploy" \
    --request-url="https://github.com/acme/alpha/issues/101#issuecomment-9" >/dev/null 2>&1 )
TA_DN=$(mk_task "$WCA" "alpha downstream blocker")
( cd "$WCA" && "$TD" block "$TA_DN" --downstream --reason="waiting on child epic" >/dev/null 2>&1 )

# Repo B: one operator block, plus one LEGACY block (overlay ref, no meta).
TB_OP=$(mk_task "$WCB" "beta operator blocker")
( cd "$WCB" && "$TD" block "$TB_OP" --operator --reason="pick a vendor" >/dev/null 2>&1 )
TB_LEG=$(mk_task "$WCB" "beta legacy blocker")
TB_LEG_FULL=$( cd "$WCB" && git rev-parse "refs/heads/tasks/frontier/$TB_LEG" )
( cd "$WCB"
  git update-ref "refs/heads/tasks/blocked/$TB_LEG_FULL" "$TB_LEG_FULL"
  git push -q origin "refs/heads/tasks/blocked/$TB_LEG_FULL:refs/heads/tasks/blocked/$TB_LEG_FULL" 2>/dev/null )

REPOS="acme/alpha=file://$A acme/beta=file://$B"

# ---------------------------------------------------------------------------
# TEST 1: --dry-run rendering.
DRY="$ROOT/dry.md"
"$RENDER" --target-repo=acme/alpha --target-issue=101 --repos="$REPOS" \
    --task-dag="$TD" --dry-run > "$DRY" 2>/dev/null

[ "$(sed -n 1p "$DRY")" = '<!-- task-dag:status -->' ] \
    && ok "1: line 1 is the status marker" \
    || bad "1: line 1 not status marker (got '$(sed -n 1p "$DRY")')"
[ "$(sed -n 2p "$DRY")" = '<!-- operator-blocked-dashboard:v1 -->' ] \
    && ok "1: line 2 is the dashboard marker" \
    || bad "1: line 2 not dashboard marker (got '$(sed -n 2p "$DRY")')"

grep -q "alpha operator blocker" "$DRY" && ok "1: alpha operator blocker present" \
    || bad "1: alpha operator blocker missing"
grep -q "beta operator blocker" "$DRY" && ok "1: beta operator blocker present (cross-repo)" \
    || bad "1: beta operator blocker missing"
grep -q "approve canary deploy" "$DRY" && ok "1: operator reason rendered" \
    || bad "1: operator reason missing"
grep -q "issuecomment-9" "$DRY" && ok "1: request-url link rendered" \
    || bad "1: request-url link missing"

grep -q "alpha downstream blocker" "$DRY" \
    && bad "1: downstream blocker should be OMITTED but was rendered" \
    || ok "1: downstream blocker correctly omitted"

grep -q "Legacy blocked refs" "$DRY" && ok "1: legacy section present" \
    || bad "1: legacy section missing"
grep -q "beta legacy blocker" "$DRY" && ok "1: legacy task rendered" \
    || bad "1: legacy task missing"

# ---------------------------------------------------------------------------
# Fake `gh` backed by a JSON comment store, on PATH.
BIN="$ROOT/bin"; mkdir -p "$BIN"
STORE="$ROOT/comments.json"; echo "[]" > "$STORE"
cat > "$BIN/gh" <<EOF
#!/usr/bin/env bash
# Minimal fake of the gh api calls the renderer makes, backed by $STORE.
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
body=""
if [ "$input" = "-" ]; then body="$(cat)"; fi
out=""
case "$method" in
  GET)  out="$(cat "$STORE")" ;;
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

run_publish() { PATH="$BIN:$PATH" "$RENDER" --target-repo=acme/alpha --target-issue=101 \
    --repos="$REPOS" --task-dag="$TD" "$@"; }

# ---------------------------------------------------------------------------
# TEST 2: first publish CREATES exactly one marked comment.
run_publish >/dev/null 2>&1
N=$(jq 'length' "$STORE")
[ "$N" = "1" ] && ok "2: created exactly one comment" || bad "2: comment count is $N (want 1)"
MARK=$(jq -r '.[0].body' "$STORE" | sed -n 1p)
[ "$MARK" = '<!-- task-dag:status -->' ] && ok "2: stored comment starts with status marker" \
    || bad "2: stored comment marker wrong (got '$MARK')"
jq -r '.[0].body' "$STORE" | grep -q '<!-- operator-blocked-dashboard:v1 -->' \
    && ok "2: stored comment has dashboard marker" || bad "2: dashboard marker missing"

# ---------------------------------------------------------------------------
# TEST 3: identical rerun is a NO-OP (still one comment, body unchanged).
BEFORE=$(jq -c '.[0].body' "$STORE")
OUT3=$(run_publish 2>&1)
N=$(jq 'length' "$STORE")
AFTER=$(jq -c '.[0].body' "$STORE")
[ "$N" = "1" ] && ok "3: still exactly one comment after rerun" || bad "3: comment count is $N (want 1)"
[ "$BEFORE" = "$AFTER" ] && ok "3: comment body unchanged (no churn)" || bad "3: body changed on no-op rerun"
echo "$OUT3" | grep -q "no-op" && ok "3: renderer reported no-op" || bad "3: did not report no-op"

# ---------------------------------------------------------------------------
# TEST 4: unblock a task -> PATCH same comment, row disappears.
( cd "$WCA" && "$TD" unblock "$TA_OP" >/dev/null 2>&1 )
run_publish >/dev/null 2>&1
N=$(jq 'length' "$STORE")
[ "$N" = "1" ] && ok "4: still exactly one comment after unblock (patched, not new)" \
    || bad "4: comment count is $N (want 1)"
jq -r '.[0].body' "$STORE" | grep -q "alpha operator blocker" \
    && bad "4: unblocked task still present" || ok "4: unblocked task removed from dashboard"
jq -r '.[0].body' "$STORE" | grep -q "beta operator blocker" \
    && ok "4: other operator blocker retained" || bad "4: other blocker wrongly dropped"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
