#!/usr/bin/env bash
# Fixture smoke test: `repair-ticket` — the idempotent CI broken-master repair
# TICKET reconciler (scope item #4 of virusdave/task-dag#1). Asserts the
# invariant "exactly ONE open ci-broken-master + priority:high ticket per open
# red chain": create on red, refresh (no comment) on continuation, dedup
# duplicates, close stale prior-streak tickets, close on green, and the
# loop-safety / dry-run / fail-closed contracts.
#
# GitHub is faked with a `gh` stub on PATH that records every invocation and
# maintains a tiny in-memory issue store under $GH_STATE. The chain state is
# real (the same throwaway bare origin + working clone the other CI tests use).
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# ── A fake `gh` ───────────────────────────────────────────────────────────
# Implements the subset repair-ticket uses: `issue list --json ...`,
# `issue create`, `issue edit --body-file`, `issue close --comment`. Issues
# are files $GH_STATE/<n>.{state,body,created}; calls are logged to $GH_LOG.
GH_STATE="$ROOT/gh"; GH_LOG="$ROOT/gh.log"; mkdir -p "$GH_STATE"
GH_BIN="$ROOT/bin"; mkdir -p "$GH_BIN"
cat > "$GH_BIN/gh" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
log() { printf '%s\n' "$*" >> "$GH_LOG"; }
echo "gh $*" >> "$GH_LOG"
[ "$1" = issue ] || { echo "fake-gh: unsupported: $*" >&2; exit 99; }
shift
sub="$1"; shift
# strip --repo R (we use a single fake repo namespace)
args=(); while [ $# -gt 0 ]; do
  case "$1" in
    --repo) shift 2;;
    *) args+=("$1"); shift;;
  esac
done
set -- "${args[@]}"
case "$sub" in
  list)
    # emit a JSON array of OPEN issues with number,body,createdAt
    out="["; first=1
    for f in "$GH_STATE"/*.state; do
      [ -e "$f" ] || continue
      n="$(basename "$f" .state)"
      [ "$(cat "$f")" = open ] || continue
      body="$(cat "$GH_STATE/$n.body" 2>/dev/null)"
      created="$(cat "$GH_STATE/$n.created" 2>/dev/null)"
      jb="$(printf '%s' "$body" | jq -Rs .)"
      [ "$first" = 1 ] || out+=","
      first=0
      out+="{\"number\":$n,\"body\":$jb,\"createdAt\":\"$created\"}"
    done
    out+="]"
    printf '%s\n' "$out"
    ;;
  create)
    title=""; body=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --title) title="$2"; shift 2;;
        --body) body="$2"; shift 2;;
        --body-file) body="$(cat "$2")"; shift 2;;
        --label) shift 2;;
        *) shift;;
      esac
    done
    n=$(( $(cat "$GH_STATE/.seq" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$GH_STATE/.seq"
    echo open > "$GH_STATE/$n.state"
    printf '%s' "$body" > "$GH_STATE/$n.body"
    # monotonic created stamp so sort_by(createdAt) is stable + meaningful
    printf '2026-01-01T00:00:%02dZ' "$n" > "$GH_STATE/$n.created"
    echo "https://github.com/acme/widgets/issues/$n"
    ;;
  edit)
    n="$1"; shift
    while [ $# -gt 0 ]; do
      case "$1" in
        --body-file) cp "$2" "$GH_STATE/$n.body"; shift 2;;
        --body) printf '%s' "$2" > "$GH_STATE/$n.body"; shift 2;;
        *) shift;;
      esac
    done
    ;;
  close)
    n="$1"; shift
    echo closed > "$GH_STATE/$n.state"
    ;;
  *) echo "fake-gh: unsupported issue $sub" >&2; exit 99;;
esac
exit 0
STUB
chmod +x "$GH_BIN/gh"
export GH_STATE GH_LOG
export PATH="$GH_BIN:$PATH"

# Test helpers over the fake store.
open_count() { local c=0 f; for f in "$GH_STATE"/*.state; do [ -e "$f" ] || continue; [ "$(cat "$f")" = open ] && c=$((c+1)); done; echo "$c"; }
state_of()  { cat "$GH_STATE/$1.state" 2>/dev/null; }
body_of()   { cat "$GH_STATE/$1.body" 2>/dev/null; }
reset_log() { : > "$GH_LOG"; }

# ── Real chain state: bare origin + working clone, history C1<-C2<-C3<-C4 ──
git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc" 2>/dev/null
cd "$ROOT/wc"
echo a > f; git add f; git commit -qm c1; C1=$(git rev-parse HEAD)
echo b > f; git commit -qam c2; C2=$(git rev-parse HEAD)
echo c > f; git commit -qam c3; C3=$(git rev-parse HEAD)
echo d > f; git commit -qam c4; C4=$(git rev-parse HEAD)
git push -q origin HEAD:master
REPO=acme/widgets

cf() { "$TD" chain-read "$REPO" "$1" --json 2>/dev/null | sed -E "s/.*\"$2\":\"([^\"]*)\".*/\1/;t;d"; }

# ---------------------------------------------------------------------------
# TEST 1: no chain ref -> no-op, no gh mutation.
# ---------------------------------------------------------------------------
reset_log
out=$("$TD" repair-ticket "$REPO" nochain --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -q '"action":"noop-nochain"' <<<"$out" \
   && ! grep -qE 'issue (create|edit|close)' "$GH_LOG"; then
  ok "1: no chain ref reconciles to a no-op (no gh mutation)"
else
  bad "1: nochain rc=$rc out=$out log=$(cat "$GH_LOG")"
fi

# ---------------------------------------------------------------------------
# TEST 2: red chain with no ticket -> create exactly ONE, with both labels and
# both markers, and cache its number in Repair-Issue.
# ---------------------------------------------------------------------------
"$TD" classify "$REPO" master --for-sha="$C2" --result=red --current-head="$C2" >/dev/null 2>&1
reset_log
out=$("$TD" repair-ticket "$REPO" master --json 2>/dev/null); rc=$?
created=$(grep -c 'issue create' "$GH_LOG")
num=$(echo "$out" | sed -E 's/.*"ticket":"([^"]*)".*/\1/')
if [ "$rc" -eq 0 ] && grep -q '"action":"created"' <<<"$out" \
   && [ "$created" -eq 1 ] && [ "$(open_count)" -eq 1 ] \
   && grep -q 'ci-repair-slot:v1' <(body_of "$num") \
   && grep -q "ci-repair-first-red:${C2}" <(body_of "$num") \
   && grep -q -- '--label ci-broken-master' "$GH_LOG" \
   && grep -q -- '--label priority:high' "$GH_LOG" \
   && [ "$(cf master repairIssue)" = "$num" ]; then
  ok "2: red+no-ticket creates exactly one labelled+markered ticket, caches its number"
else
  bad "2: create rc=$rc out=$out created=$created open=$(open_count) cache=$(cf master repairIssue)"
fi
TICKET="$num"

# ---------------------------------------------------------------------------
# TEST 3: IDEMPOTENT — a second red reconcile creates NOTHING new and posts NO
# comment; it refreshes the existing ticket body via `issue edit` only.
# ---------------------------------------------------------------------------
reset_log
out=$("$TD" repair-ticket "$REPO" master --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -q '"action":"updated"' <<<"$out" \
   && [ "$(grep -c 'issue create' "$GH_LOG")" -eq 0 ] \
   && [ "$(grep -c 'issue close' "$GH_LOG")" -eq 0 ] \
   && [ "$(grep -c 'issue edit' "$GH_LOG")" -eq 1 ] \
   && [ "$(open_count)" -eq 1 ]; then
  ok "3: re-running on the same red streak is idempotent (edit body, no create/comment)"
else
  bad "3: idempotent rc=$rc out=$out log=$(cat "$GH_LOG")"
fi

# ---------------------------------------------------------------------------
# TEST 4: continuation red (Current-Head advances, same First-Red) refreshes
# the SAME ticket — still exactly one open.
# ---------------------------------------------------------------------------
"$TD" classify "$REPO" master --for-sha="$C3" --result=red --current-head="$C3" >/dev/null 2>&1
reset_log
out=$("$TD" repair-ticket "$REPO" master --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -q '"action":"updated"' <<<"$out" \
   && grep -q "\"ticket\":\"$TICKET\"" <<<"$out" \
   && [ "$(open_count)" -eq 1 ] \
   && grep -q "Current head: \`${C3}\`" <(body_of "$TICKET"); then
  ok "4: continuation red refreshes the same ticket (one chain, one ticket)"
else
  bad "4: continue rc=$rc out=$out open=$(open_count)"
fi

# ---------------------------------------------------------------------------
# TEST 5: DEDUP — if a stray duplicate current-streak ticket exists, keep the
# oldest and close the extra (markered comment), leaving exactly one open.
# ---------------------------------------------------------------------------
# Forge a duplicate ticket carrying the same slot + first-red markers.
slot="<!-- ci-repair-slot:v1 repo=${REPO} branch=master -->"
dupbody="$slot
<!-- ci-repair-first-red:${C2} -->
dup"
dn=$(( $(cat "$GH_STATE/.seq") + 1 )); echo "$dn" > "$GH_STATE/.seq"
echo open > "$GH_STATE/$dn.state"; printf '%s' "$dupbody" > "$GH_STATE/$dn.body"
printf '2026-02-01T00:00:00Z' > "$GH_STATE/$dn.created"   # newer => not the kept one
reset_log
out=$("$TD" repair-ticket "$REPO" master --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && [ "$(open_count)" -eq 1 ] \
   && [ "$(state_of "$TICKET")" = open ] && [ "$(state_of "$dn")" = closed ] \
   && grep -q 'task-dag:status' "$GH_LOG"; then
  ok "5: duplicate current-streak ticket is closed (keep oldest), one remains open"
else
  bad "5: dedup rc=$rc open=$(open_count) kept=$(state_of "$TICKET") dup=$(state_of "$dn")"
fi

# ---------------------------------------------------------------------------
# TEST 6: GREEN closes the open ticket (markered comment) and clears the cache.
# ---------------------------------------------------------------------------
"$TD" classify "$REPO" master --for-sha="$C4" --result=green --current-head="$C4" >/dev/null 2>&1
reset_log
out=$("$TD" repair-ticket "$REPO" master --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -q '"action":"closed"' <<<"$out" \
   && [ "$(open_count)" -eq 0 ] \
   && grep -q 'task-dag:status' "$GH_LOG" \
   && [ -z "$(cf master repairIssue)" ]; then
  ok "6: green closes the repair ticket with a markered comment, cache cleared"
else
  bad "6: green-close rc=$rc out=$out open=$(open_count) cache=$(cf master repairIssue)"
fi

# ---------------------------------------------------------------------------
# TEST 7: a NEW red streak (fresh First-Red) opens a NEW ticket and closes any
# stale prior-streak ticket left open.
# ---------------------------------------------------------------------------
# Re-open the previously-closed C2 ticket to simulate a stale prior-streak one
# that never got closed; then open a fresh chain at C4.
echo open > "$GH_STATE/$TICKET.state"
"$TD" classify "$REPO" master --for-sha="$C4" --result=red --current-head="$C4" >/dev/null 2>&1
reset_log
out=$("$TD" repair-ticket "$REPO" master --json 2>/dev/null); rc=$?
newnum=$(echo "$out" | sed -E 's/.*"ticket":"([^"]*)".*/\1/')
if [ "$rc" -eq 0 ] && grep -q 'created' <<<"$out" \
   && [ "$(state_of "$TICKET")" = closed ] \
   && [ "$(open_count)" -eq 1 ] \
   && grep -q "ci-repair-first-red:${C4}" <(body_of "$newnum"); then
  ok "7: a fresh red streak opens a new ticket and closes the stale prior one"
else
  bad "7: new-streak rc=$rc out=$out kept-stale=$(state_of "$TICKET") open=$(open_count)"
fi

# ---------------------------------------------------------------------------
# TEST 8: --dry-run makes NO mutating gh calls and writes no chain change.
# ---------------------------------------------------------------------------
"$TD" classify "$REPO" dryb --for-sha="$C4" --result=red --current-head="$C4" >/dev/null 2>&1
before=$("$TD" chain-read "$REPO" dryb --json 2>/dev/null)
reset_log
out=$("$TD" repair-ticket "$REPO" dryb --dry-run --json 2>/dev/null); rc=$?
after=$("$TD" chain-read "$REPO" dryb --json 2>/dev/null)
if [ "$rc" -eq 0 ] \
   && [ "$(grep -cE 'issue (create|edit|close)' "$GH_LOG")" -eq 0 ] \
   && [ "$before" = "$after" ]; then
  ok "8: --dry-run performs no mutating gh calls and no chain write"
else
  bad "8: dry-run rc=$rc mutations=$(grep -cE 'issue (create|edit|close)' "$GH_LOG")"
fi

# ---------------------------------------------------------------------------
# TEST 9: create-lease stand-down — a recent creating@<ts> lease makes a
# concurrent runner stand down (no duplicate create).
# ---------------------------------------------------------------------------
"$TD" classify "$REPO" leaseb --for-sha="$C4" --result=red --current-head="$C4" >/dev/null 2>&1
now=$(date +%s)
"$TD" chain-write "$REPO" leaseb --for-sha="$C4" --set "Repair-Issue=creating@${now}" >/dev/null 2>&1
reset_log
out=$("$TD" repair-ticket "$REPO" leaseb --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -q '"action":"create-in-progress"' <<<"$out" \
   && [ "$(grep -c 'issue create' "$GH_LOG")" -eq 0 ]; then
  ok "9: a fresh create-lease makes a concurrent runner stand down (no dup create)"
else
  bad "9: lease rc=$rc out=$out log=$(cat "$GH_LOG")"
fi

# ---------------------------------------------------------------------------
# TEST 10: a STALE create-lease (older than TTL) is stolen and the ticket is
# created.
# ---------------------------------------------------------------------------
old=$(( now - 99999 ))
"$TD" chain-write "$REPO" leaseb --for-sha="$C4" --set "Repair-Issue=creating@${old}" >/dev/null 2>&1
reset_log
out=$("$TD" repair-ticket "$REPO" leaseb --lease-ttl=300 --json 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -q '"action":"created"' <<<"$out" \
   && [ "$(grep -c 'issue create' "$GH_LOG")" -eq 1 ]; then
  ok "10: a create-lease older than TTL is stolen and the ticket is created"
else
  bad "10: stale-lease rc=$rc out=$out created=$(grep -c 'issue create' "$GH_LOG")"
fi

# ---------------------------------------------------------------------------
# TEST 11: argument validation — missing branch and bad --lease-ttl exit 1.
# ---------------------------------------------------------------------------
"$TD" repair-ticket "$REPO" >/dev/null 2>&1; r1=$?
"$TD" repair-ticket "$REPO" master --lease-ttl=abc >/dev/null 2>&1; r2=$?
if [ "$r1" -eq 1 ] && [ "$r2" -eq 1 ]; then
  ok "11: bad args rejected (missing branch, non-numeric --lease-ttl)"
else
  bad "11: arg-validation r1=$r1 r2=$r2"
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
