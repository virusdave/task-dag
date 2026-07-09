#!/usr/bin/env bash
# Unit + fixture tests for the direct-CAS edge WRITER
# (scripts/task-dag.d/edges-write.sh, issue #13 north-star Phase 2).
#
# Covers the leaf's closure criteria:
#   • add-edge / remove-edge implemented on top of the reader (@1): a FF-only
#     direct CAS push to tasks/v1/graph, round-tripped through the reader,
#     including idempotent re-add / re-drop,
#   • backoff parameters: quadratic RAMP shape, ~10s CAP, JITTER presence
#     (never starts at the cap), and FAIL-LOUD on retry-budget exhaustion,
#   • an INTEGRATION test of concurrent FF contention (two racing writers →
#     the loser refetches, recomputes the commutative union, re-pushes; both
#     edges end up present).
#
# No network: builds a throwaway bare origin + working clone(s) in a tempdir.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
LIBDIR="$(dirname "$TD")/task-dag.d"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

command -v jq >/dev/null 2>&1 || { echo "jq is required for this test"; echo "PASS=0 FAIL=1"; exit 1; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# Globals the writer/reader reference from the main script when sourced standalone.
TASKDAG_GRAPH_REF="refs/heads/tasks/v1/graph"
EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
RED='' GREEN='' YELLOW='' BLUE='' BOLD='' RESET=''

FORTY=$(printf 'a%.0s' {1..40})
FORTYB=$(printf 'b%.0s' {1..40})
FORTYC=$(printf 'c%.0s' {1..40})

# ===========================================================================
# Part A — backoff parameters (pure, no git needed). Source the writer with
# small fixed params so the ramp/cap/jitter maths are deterministic.
# ===========================================================================
# Emit PASS:/FAIL: lines from a subshell (isolated backoff params), tally
# them in THIS shell via process substitution so counts propagate.
while IFS= read -r line; do
    case "$line" in
        PASS:*) ok "${line#PASS: }" ;;
        FAIL:*) bad "${line#FAIL: }" ;;
    esac
done < <(
    TASKDAG_CAS_BASE_MS=1000 TASKDAG_CAS_CAP_MS=10000 TASKDAG_CAS_JITTER_MS=250
    # shellcheck source=/dev/null
    source "$LIBDIR/edges.sh"
    # shellcheck source=/dev/null
    source "$LIBDIR/edges-write.sh"

    r1=$(taskdag_cas_ramp_ms 1); r2=$(taskdag_cas_ramp_ms 2); r3=$(taskdag_cas_ramp_ms 3)
    r4=$(taskdag_cas_ramp_ms 4); r100=$(taskdag_cas_ramp_ms 100)
    # Quadratic ramp: base*attempt^2 → 1000, 4000, 9000; capped at 10000.
    if [ "$r1" = 1000 ] && [ "$r2" = 4000 ] && [ "$r3" = 9000 ]; then
        echo "PASS: A1 ramp is quadratic (base*attempt^2)"
    else
        echo "FAIL: A1 ramp not quadratic (r1=$r1 r2=$r2 r3=$r3)"
    fi
    # Never starts at the cap: attempt 1 == base < cap.
    if [ "$r1" -lt "$TASKDAG_CAS_CAP_MS" ] && [ "$r1" = "$TASKDAG_CAS_BASE_MS" ]; then
        echo "PASS: A2 backoff starts at ~base, not the cap"
    else
        echo "FAIL: A2 backoff did not start at base (r1=$r1)"
    fi
    # Cap holds: large attempts saturate at the cap, never exceed it.
    if [ "$r4" = 10000 ] && [ "$r100" = 10000 ]; then
        echo "PASS: A3 ramp saturates at the ~10s cap"
    else
        echo "FAIL: A3 ramp did not cap (r4=$r4 r100=$r100)"
    fi
    # Ramp is monotonic non-decreasing.
    if [ "$r1" -le "$r2" ] && [ "$r2" -le "$r3" ] && [ "$r3" -le "$r4" ]; then
        echo "PASS: A4 ramp is monotonic non-decreasing"
    else
        echo "FAIL: A4 ramp not monotonic"
    fi
    # Jitter present + bounded: many draws stay in [0,JITTER_MS] and vary.
    seen_hi=0; seen_lo=0; distinct=""
    for _ in $(seq 1 40); do
        j=$(taskdag_cas_jitter_ms)
        [ "$j" -ge 0 ] || { seen_lo=-1; break; }
        [ "$j" -le "$TASKDAG_CAS_JITTER_MS" ] || { seen_hi=-1; break; }
        case " $distinct " in *" $j "*) : ;; *) distinct="$distinct $j" ;; esac
    done
    ndistinct=$(printf '%s\n' $distinct | grep -c .)
    if [ "$seen_lo" = 0 ] && [ "$seen_hi" = 0 ] && [ "$ndistinct" -ge 2 ]; then
        echo "PASS: A5 jitter is bounded in [0,JITTER_MS] and varies across draws"
    else
        echo "FAIL: A5 jitter out of range or constant (lo=$seen_lo hi=$seen_hi distinct=$ndistinct)"
    fi
    # Full backoff = ramp + jitter, so it is >= ramp and <= ramp+JITTER_MS.
    b1=$(taskdag_cas_backoff_ms 1)
    if [ "$b1" -ge "$r1" ] && [ "$b1" -le "$((r1 + TASKDAG_CAS_JITTER_MS))" ]; then
        echo "PASS: A6 backoff = ramp + jitter (within bounds)"
    else
        echo "FAIL: A6 backoff out of [ramp, ramp+jitter] (b1=$b1 r1=$r1)"
    fi
)

# ===========================================================================
# Part B — build a real origin + clone and drive the CLI writer.
# ===========================================================================
git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"
cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master
# Offline repo-id seam (no gh in CI): preseed owner/repo numeric id.
git config "taskdag.owner/repo.id" 4242

FROM="task:owner/repo@$FORTY"
TO1="issue:owner/repo#1"
TO2="task:peer/repo@$FORTYB"

# B1: add a first edge; the graph ref is created from nothing.
if "$TD" dep add --from "$FROM" --to "$TO1" --relation requires \
        --repo-id 4242 --witness w1 --reason "first edge" >/dev/null 2>&1; then
    ok "B1: dep add creates the graph ref and lands the first edge"
else
    bad "B1: first dep add failed"
fi

# B2: the reader sees exactly that edge, canonical + schema:1.
out=$("$TD" edges --json --no-fetch 2>/dev/null)
if printf '%s' "$out" | jq -e 'length == 1 and .[0].from == "'"$FROM"'"
        and .[0].to == "'"$TO1"'" and .[0].relation == "requires"
        and .[0].mode == "all" and .[0].origin["repo-id"] == 4242' >/dev/null 2>&1; then
    ok "B2: reader round-trips the written edge (schema:1, canonical)"
else
    bad "B2: reader did not see the written edge (got: $out)"
fi

# B3: idempotent re-add (same from/to/relation) is a no-op — no new commit.
tip_before=$(git rev-parse "$TASKDAG_GRAPH_REF")
"$TD" dep add --from "$FROM" --to "$TO1" --relation requires \
    --repo-id 4242 --witness w1b >/dev/null 2>&1
tip_after=$(git rev-parse "$TASKDAG_GRAPH_REF")
n_after=$("$TD" edges --json --no-fetch 2>/dev/null | jq 'length')
if [ "$tip_before" = "$tip_after" ] && [ "$n_after" = 1 ]; then
    ok "B3: idempotent re-add is a no-op (no new commit, still one edge)"
else
    bad "B3: re-add changed state (tip $tip_before->$tip_after, n=$n_after)"
fi

# B4: add a second, different edge (satisfies/any); FF appends to the union.
if "$TD" dep add --from "$FROM" --to "$TO2" --relation satisfies \
        --repo-id 4242 --witness w2 >/dev/null 2>&1; then
    n=$("$TD" edges --json --no-fetch 2>/dev/null | jq 'length')
    [ "$n" = 2 ] && ok "B4: a second distinct edge FF-appends to the set" \
        || bad "B4: second edge count wrong (n=$n)"
else
    bad "B4: second dep add failed"
fi

# B5: FF invariant — the new graph commit's parent is the previous graph tip.
newtip=$(git rev-parse "$TASKDAG_GRAPH_REF")
parent=$(git rev-parse "${newtip}^" 2>/dev/null || true)
first_tip=$tip_after
if [ "$parent" = "$first_tip" ]; then
    ok "B5: graph writes are fast-forward (new tip parents the old tip)"
else
    bad "B5: graph write was not a FF over the prior tip (parent=$parent want=$first_tip)"
fi

# B6: drop the satisfies edge by its edge-id; reader drops back to one.
eid2=$("$TD" edges --json --no-fetch 2>/dev/null | jq -r '.[] | select(.relation=="satisfies") | .edgeId')
if "$TD" dep drop "$eid2" --reason "no longer needed" >/dev/null 2>&1; then
    n=$("$TD" edges --json --no-fetch 2>/dev/null | jq 'length')
    still=no; "$TD" edges --json --no-fetch 2>/dev/null | jq -e 'any(.[]; .relation=="satisfies")' >/dev/null 2>&1 && still=yes
    if [ "$n" = 1 ] && [ "$still" = no ]; then
        ok "B6: dep drop removes exactly the targeted edge"
    else
        bad "B6: dep drop wrong (n=$n satisfies-present=$still)"
    fi
else
    bad "B6: dep drop failed"
fi

# B7: idempotent re-drop of an absent edge is a no-op success.
tip_b=$(git rev-parse "$TASKDAG_GRAPH_REF")
if "$TD" dep drop "$eid2" >/dev/null 2>&1; then
    tip_a=$(git rev-parse "$TASKDAG_GRAPH_REF")
    [ "$tip_b" = "$tip_a" ] && ok "B7: re-drop of an absent edge is a no-op" \
        || bad "B7: re-drop created a commit (tip $tip_b->$tip_a)"
else
    bad "B7: re-drop of an absent edge returned failure"
fi

# B8: a disallowed relation/mode pair (OR-dep) is rejected up front.
if "$TD" dep add --from "$FROM" --to "$TO1" --relation requires --mode any \
        --repo-id 4242 --witness w >/dev/null 2>&1; then
    bad "B8: requires/any (disallowed) was accepted"
else
    ok "B8: requires/any (disallowed OR-dep) is rejected"
fi

# B9: a malformed edge-id to `dep drop` fails loud (never a bogus deletion).
if "$TD" dep drop "not-a-real-edge-id" >/dev/null 2>&1; then
    bad "B9: malformed edge-id was accepted by dep drop"
else
    ok "B9: malformed edge-id to dep drop fails loud"
fi

# ===========================================================================
# Part C — FAIL-LOUD on retry-budget exhaustion (deterministic). Override the
# ref-sync so local `old` stays stale while origin has advanced, so the FF
# lease is rejected every attempt → exhaustion → loud failure.
# ===========================================================================
cexhaust() {
    TASKDAG_CAS_BASE_MS=0 TASKDAG_CAS_CAP_MS=0 TASKDAG_CAS_JITTER_MS=0 TASKDAG_CAS_MAX_ATTEMPTS=2
    # shellcheck source=/dev/null
    source "$LIBDIR/edges.sh"
    # shellcheck source=/dev/null
    source "$LIBDIR/edges-write.sh"
    # Neutralize the sync so the writer never learns origin's real tip: `old`
    # (from the local ref) stays behind origin → every FF lease is rejected.
    taskdag_sync_graph_ref() { return 0; }
    # Point local ref at an unrelated commit (stale vs origin's real graph tip).
    local stale
    stale=$(git commit-tree "$EMPTY_TREE" -m stale </dev/null)
    git update-ref "$TASKDAG_GRAPH_REF" "$stale"
    taskdag_dep_add "$FROM" "$TO1" requires all 4242 wX "exhaust test"
}
# First, make origin's graph ref real + AHEAD so a stale-lease push is rejected.
"$TD" dep add --from "$FROM" --to "$TO1" --relation requires --repo-id 4242 --witness real >/dev/null 2>&1
# Run in a subshell so the function/sync override never leaks into this shell.
if ( cexhaust ) >/dev/null 2>&1; then
    bad "C1: exhausted CAS did not fail loud (returned success)"
else
    ok "C1: exhausted retry budget fails loud (non-zero exit)"
fi

# C2: the loud failure names the exhaustion (operator can see WHY).
msg=$(cexhaust 2>&1 || true)
if echo "$msg" | grep -qiE 'exhaust|failing loud'; then
    ok "C2: exhaustion failure message is loud + explanatory"
else
    bad "C2: exhaustion message not explanatory (got: $msg)"
fi

# ===========================================================================
# Part D — concurrent FF contention (integration). Two clones race the same
# origin; the loser must refetch, recompute the union, and re-push, so BOTH
# edges survive.
# ===========================================================================
git init -q --bare "$ROOT/c.git"
git clone -q "$ROOT/c.git" "$ROOT/A"
git clone -q "$ROOT/c.git" "$ROOT/B"
for d in A B; do
    ( cd "$ROOT/$d"; echo s > s.txt; git add s.txt; git commit -qm s; git push -q origin HEAD:master
      git config "taskdag.owner/repo.id" 4242 )
done

FA="task:owner/repo@$FORTY"
FB="task:owner/repo@$FORTYC"
TC="issue:owner/repo#7"

# Launch both adds concurrently with a small (nonzero) real backoff so the
# loser actually retries under contention.
( cd "$ROOT/A"; TASKDAG_CAS_BASE_MS=20 TASKDAG_CAS_CAP_MS=100 TASKDAG_CAS_JITTER_MS=20 \
    "$TD" dep add --from "$FA" --to "$TC" --relation requires --repo-id 4242 --witness a ) >/dev/null 2>&1 &
pidA=$!
( cd "$ROOT/B"; TASKDAG_CAS_BASE_MS=20 TASKDAG_CAS_CAP_MS=100 TASKDAG_CAS_JITTER_MS=20 \
    "$TD" dep add --from "$FB" --to "$TC" --relation satisfies --repo-id 4242 --witness b ) >/dev/null 2>&1 &
pidB=$!
wait "$pidA"; rcA=$?
wait "$pidB"; rcB=$?

# Read the converged set from a fresh clone (authoritative origin state).
git clone -q "$ROOT/c.git" "$ROOT/R"
cd "$ROOT/R"; git config "taskdag.owner/repo.id" 4242
conv=$("$TD" edges --json 2>/dev/null)
if [ "$rcA" = 0 ] && [ "$rcB" = 0 ] \
    && printf '%s' "$conv" | jq -e 'length == 2
        and any(.[]; .from == "'"$FA"'" and .relation == "requires")
        and any(.[]; .from == "'"$FB"'" and .relation == "satisfies")' >/dev/null 2>&1; then
    ok "D1: concurrent FF contention converges — both racing edges survive"
else
    bad "D1: concurrent contention lost an edge (rcA=$rcA rcB=$rcB got: $conv)"
fi

# D2: the converged graph passes the reader's corruption checks (well-formed,
# FF, content-addressed) — i.e. contention never minted a bad tree.
if "$TD" edges --json >/dev/null 2>&1; then
    ok "D2: converged graph is well-formed (reader accepts it)"
else
    bad "D2: converged graph failed the reader's validation"
fi

# ===========================================================================
# Part E — an "already present" add must NOT report success over a CORRUPT
# existing edge blob (the authoritative writer never claims success on a path
# the reader would reject). Plant a schema:2 blob at a valid edge path, then
# re-add that same edge and confirm the writer FAILS LOUD.
# ===========================================================================
git init -q --bare "$ROOT/e.git"
git clone -q "$ROOT/e.git" "$ROOT/E"
cd "$ROOT/E"
echo s > s.txt; git add s.txt; git commit -qm s; git push -q origin HEAD:master
git config "taskdag.owner/repo.id" 4242
EF="task:owner/repo@$FORTY"; ET="issue:owner/repo#5"
"$TD" dep add --from "$EF" --to "$ET" --relation requires --repo-id 4242 --witness ok >/dev/null 2>&1
eid=$("$TD" edges --json --no-fetch 2>/dev/null | jq -r '.[0].edgeId')
# FF-push a commit that replaces that edge's blob with a corrupt (schema:2) one.
tip=$(git rev-parse "$TASKDAG_GRAPH_REF")
badblob=$(jq -nc '{schema:2, from:"'"$EF"'", to:"'"$ET"'", relation:"requires", mode:"all", origin:{"repo-id":1, witness:"w"}}')
badsha=$(printf '%s' "$badblob" | git hash-object -w --stdin)
eidx="$ROOT/E/.corrupt.index"; rm -f "$eidx"
GIT_INDEX_FILE="$eidx" git read-tree "${tip}^{tree}"
GIT_INDEX_FILE="$eidx" git update-index --add --cacheinfo "100644,$badsha,edges/$eid.json"
etree=$(GIT_INDEX_FILE="$eidx" git write-tree); rm -f "$eidx"
ecommit=$(git commit-tree "$etree" -p "$tip" -m "corrupt edge blob")
git push -q origin "$ecommit:$TASKDAG_GRAPH_REF"
git update-ref -d "$TASKDAG_GRAPH_REF"    # force a fresh fetch on the next add
e_out=$("$TD" dep add --from "$EF" --to "$ET" --relation requires --repo-id 4242 --witness ok2 2>&1); e_rc=$?
if [ "$e_rc" -ne 0 ] && echo "$e_out" | grep -qiE 'corrupt|mismatch'; then
    ok "E1: add over a corrupt existing edge fails loud (no false no-op success)"
else
    bad "E1: add over a corrupt existing edge did not fail loud (got: $e_out)"
fi

# ===========================================================================
# Part F — value-less options are a clean usage error (exit 2), never a
# `set -u` process abort.
# ===========================================================================
f_out=$("$TD" dep add --from 2>&1); f_rc=$?
if [ "$f_rc" = 2 ] && echo "$f_out" | grep -q 'requires a value'; then
    ok "F1: 'dep add --from' (no value) is a clean usage error"
else
    bad "F1: value-less --from not handled cleanly (rc=$f_rc out=$f_out)"
fi
g_out=$("$TD" dep drop --reason 2>&1); g_rc=$?
if [ "$g_rc" = 2 ] && echo "$g_out" | grep -q 'requires a value'; then
    ok "F2: 'dep drop --reason' (no value) is a clean usage error"
else
    bad "F2: value-less --reason not handled cleanly (rc=$g_rc out=$g_out)"
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
