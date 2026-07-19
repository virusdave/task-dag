#!/usr/bin/env bash
# Unit + fixture tests for the cross-repo MAILBOX
# (scripts/task-dag.d/mailbox.sh, issue #13 north-star Phase 3).
#
# Covers the leaf's closure criteria:
#   • FIXED SHARDS: exactly 16 shard refs tasks/v1/mailbox/00..0f; a message
#     lives as an in-tree blob (bounded refs — many messages, still ≤16 refs);
#     shard derivation = first nibble of the 64-hex message-id → 00..0f,
#   • content-addressed message-id (kind,node,witness,dest); idempotent
#     re-put; a same-id/different-content put FAILS LOUD (conflicting origin),
#   • put/list round-trip through the reader (schema:1, canonical),
#   • target-repo guard: --dest must match the remote (no silent mis-delivery),
#   • ORDERED FOLD-THEN-DELETE: consume deletes a message ONLY after the fold
#     exits 0; a failing fold leaves the message enqueued for retry,
#   • WITNESS TRAILER: consume passes TASKDAG_MAILBOX_* env to the fold, and
#     the witness-trailer helper emits the provenance trailer the fold stamps,
#   • cross-repo delivery (put into a peer remote → consume in that peer),
#   • FF contention convergence + FAIL-LOUD on retry-budget exhaustion,
#   • the converged mailbox passes validate --strict.
#
# No network: builds throwaway bare origins + working clones in a tempdir.
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

# Globals the module references when sourced standalone.
EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
TASKDAG_GRAPH_REF="refs/heads/tasks/v1/graph"
RED='' GREEN='' YELLOW='' BLUE='' BOLD='' RESET=''

FORTY=$(printf 'a%.0s' {1..40})
FORTYB=$(printf 'b%.0s' {1..40})
WIT=$(printf '1%.0s' {1..40})
WIT2=$(printf '2%.0s' {1..40})

# ===========================================================================
# Part A — pure functions (no git needed). message-id + shard + validation.
# ===========================================================================
while IFS= read -r line; do
    case "$line" in
        PASS:*) ok "${line#PASS: }" ;;
        FAIL:*) bad "${line#FAIL: }" ;;
    esac
done < <(
    # shellcheck source=/dev/null
    source "$LIBDIR/edges.sh"
    # shellcheck source=/dev/null
    source "$LIBDIR/facts.sh"
    # shellcheck source=/dev/null
    source "$LIBDIR/edges-write.sh"
    # shellcheck source=/dev/null
    source "$LIBDIR/mailbox.sh"

    node="task:owner/repo@$FORTY"

    # A1: message-id is deterministic + 64-hex.
    id1=$(taskdag_mailbox_message_id completion "$node" "$WIT" owner/repo)
    id2=$(taskdag_mailbox_message_id completion "$node" "$WIT" owner/repo)
    if [ "$id1" = "$id2" ] && [[ "$id1" =~ ^[0-9a-f]{64}$ ]]; then
        echo "PASS: A1 message-id is deterministic + 64-hex"
    else
        echo "FAIL: A1 message-id not stable/hex (id1=$id1 id2=$id2)"
    fi

    # A2: witness is part of identity (a NEW witness ⇒ a different id).
    id3=$(taskdag_mailbox_message_id completion "$node" "$WIT2" owner/repo)
    [ "$id1" != "$id3" ] && echo "PASS: A2 a different witness yields a different message-id" \
        || echo "FAIL: A2 witness not part of message identity"

    # A3: dest is part of identity.
    id4=$(taskdag_mailbox_message_id completion "$node" "$WIT" other/repo)
    [ "$id1" != "$id4" ] && echo "PASS: A3 a different dest yields a different message-id" \
        || echo "FAIL: A3 dest not part of message identity"

    # A4: owner/repo casing does NOT fork identity (canonical lowercasing).
    id5=$(taskdag_mailbox_message_id completion "task:Owner/Repo@$FORTY" "$WIT" Owner/Repo)
    [ "$id1" = "$id5" ] && echo "PASS: A4 owner/repo casing is canonicalized (same id)" \
        || echo "FAIL: A4 casing forked identity (id1=$id1 id5=$id5)"

    # A5: shard = first nibble → 00..0f, and matches %02x of the nibble.
    sh=$(taskdag_mailbox_shard_for "$id1")
    want=$(printf '%02x' "$((16#${id1:0:1}))")
    if [ "$sh" = "$want" ] && [[ "$sh" =~ ^0[0-9a-f]$ ]]; then
        echo "PASS: A5 shard derives from the first nibble into 00..0f"
    else
        echo "FAIL: A5 shard derivation wrong (sh=$sh want=$want)"
    fi

    # A6: witness validation — 40|64 hex ok; junk / injection rejected.
    if taskdag_mailbox_witness_ok "$WIT" \
        && taskdag_mailbox_witness_ok "$(printf 'a%.0s' {1..64})" \
        && ! taskdag_mailbox_witness_ok "not-hex" \
        && ! taskdag_mailbox_witness_ok "" \
        && ! taskdag_mailbox_witness_ok "$(printf 'a%.0s' {1..40})
Injected-Trailer: x"; then
        echo "PASS: A6 witness accepts 40|64-hex, rejects junk/empty/newline-injection"
    else
        echo "FAIL: A6 witness validation wrong"
    fi

    # A7: an unknown kind and a non-completion cross-repo node mismatch fail loud.
    if ! taskdag_mailbox_message_id bogus "$node" "$WIT" owner/repo 2>/dev/null \
        && ! taskdag_mailbox_blob completion "task:owner/repo@$FORTY" "$WIT" owner/repo other/repo 42 2>/dev/null; then
        echo "PASS: A7 unknown kind + node/origin-repo mismatch fail loud"
    else
        echo "FAIL: A7 malformed message not rejected"
    fi

    # A8: witness-trailer helper emits both provenance trailers.
    tr=$(taskdag_mailbox_witness_trailer "$WIT" "$id1")
    if printf '%s' "$tr" | grep -q "^Mailbox-Witness: ${WIT}$" \
        && printf '%s' "$tr" | grep -q "^Mailbox-Message-Id: ${id1}$"; then
        echo "PASS: A8 witness-trailer helper emits both provenance trailers"
    else
        echo "FAIL: A8 witness trailer wrong (got: $tr)"
    fi
    # ...and rejects a non-hex witness (no trailer injection).
    if ! taskdag_mailbox_witness_trailer "x" "$id1" 2>/dev/null; then
        echo "PASS: A8b witness-trailer helper rejects a non-hex witness"
    else
        echo "FAIL: A8b witness-trailer accepted a bad witness"
    fi
)

# ===========================================================================
# Part B — put/list round-trip on a real origin + clone.
# ===========================================================================
git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"
cd "$ROOT/wc"
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master
git config "taskdag.owner/repo.id" 4242
git config "taskdag.current-repo" owner/repo    # offline current-repo seam
export TASKDAG_CURRENT_REPO=owner/repo

NODE="task:owner/repo@$FORTY"

# B1: put enqueues a message; the shard ref is created from nothing.
if "$TD" mailbox put --node "$NODE" --witness "$WIT" --dest owner/repo \
        --repo-id 4242 --reason "first hint" >/dev/null 2>&1; then
    ok "B1: mailbox put creates the shard ref and enqueues the first message"
else
    bad "B1: first mailbox put failed"
fi

# B2: the reader sees exactly that message, canonical + schema:1.
out=$("$TD" mailbox list --json --no-fetch 2>/dev/null)
if printf '%s' "$out" | jq -e 'length == 1 and .[0].node == "'"$NODE"'"
        and .[0].kind == "completion" and .[0].dest == "owner/repo"
        and .[0].witness == "'"$WIT"'" and .[0].origin["repo-id"] == 4242
        and (.[0].messageId | test("^[0-9a-f]{64}$"))
        and (.[0].shard | test("^0[0-9a-f]$"))' >/dev/null 2>&1; then
    ok "B2: reader round-trips the enqueued message (schema:1, canonical)"
else
    bad "B2: reader did not see the enqueued message (got: $out)"
fi

# B3: the message is stored in the shard its id derives to.
mid=$(printf '%s' "$out" | jq -r '.[0].messageId')
shard=$(printf '%s' "$out" | jq -r '.[0].shard')
want_shard=$(printf '%02x' "$((16#${mid:0:1}))")
if [ "$shard" = "$want_shard" ] \
    && git cat-file -e "refs/heads/tasks/v1/mailbox/${shard}:msg/${mid}.json" 2>/dev/null; then
    ok "B3: message lives in the correct derived shard (msg/<id>.json blob)"
else
    bad "B3: message mis-sharded (shard=$shard want=$want_shard)"
fi

# B4: idempotent re-put (same kind/node/witness/dest) is a no-op — no new commit.
tip_before=$(git rev-parse "refs/heads/tasks/v1/mailbox/${shard}")
"$TD" mailbox put --node "$NODE" --witness "$WIT" --dest owner/repo --repo-id 4242 >/dev/null 2>&1
tip_after=$(git rev-parse "refs/heads/tasks/v1/mailbox/${shard}")
n_after=$("$TD" mailbox list --json --no-fetch 2>/dev/null | jq 'length')
if [ "$tip_before" = "$tip_after" ] && [ "$n_after" = 1 ]; then
    ok "B4: idempotent re-put is a no-op (no new commit, still one message)"
else
    bad "B4: re-put changed state (tip $tip_before->$tip_after, n=$n_after)"
fi

# B5: a same-id message with DIFFERENT content (conflicting origin repo-id)
#     FAILS LOUD (a message is short-lived trigger state; no first-wins).
if "$TD" mailbox put --node "$NODE" --witness "$WIT" --dest owner/repo --repo-id 9999 >/dev/null 2>&1; then
    bad "B5: conflicting same-id message content was silently accepted"
else
    ok "B5: same-id/different-content put fails loud (no silent overwrite)"
fi

# B6: the target-repo guard rejects a --dest that doesn't match the remote.
if "$TD" mailbox put --node "task:other/repo@$FORTY" --witness "$WIT" \
        --dest other/repo --repo-id 4242 >/dev/null 2>&1; then
    bad "B6: mis-addressed --dest (not the origin repo) was accepted"
else
    ok "B6: target-repo guard rejects a --dest that doesn't match the remote"
fi

# B7: a second distinct message (new witness) FF-appends to the set.
if "$TD" mailbox put --node "$NODE" --witness "$WIT2" --dest owner/repo --repo-id 4242 >/dev/null 2>&1; then
    n=$("$TD" mailbox list --json --no-fetch 2>/dev/null | jq 'length')
    [ "$n" = 2 ] && ok "B7: a second distinct message FF-appends to the in-flight set" \
        || bad "B7: second message count wrong (n=$n)"
else
    bad "B7: second mailbox put failed"
fi

# ===========================================================================
# Part C — bounded refs: many messages, still ≤16 shard refs.
# ===========================================================================
for i in $(seq 1 40); do
    w=$(printf '%040x' "$i")
    "$TD" mailbox put --node "$NODE" --witness "$w" --dest owner/repo --repo-id 4242 >/dev/null 2>&1
done
nrefs=$(git for-each-ref --format='%(refname)' 'refs/heads/tasks/v1/mailbox/*' | wc -l | tr -d ' ')
nmsgs=$("$TD" mailbox list --json --no-fetch 2>/dev/null | jq 'length')
if [ "$nrefs" -le 16 ] && [ "$nmsgs" -ge 40 ]; then
    ok "C1: bounded refs — ${nmsgs} messages across only ${nrefs} shard refs (≤16)"
else
    bad "C1: ref count not bounded (refs=$nrefs msgs=$nmsgs)"
fi
# All shard refs are within the fixed 00..0f set.
badshard=no
while read -r r; do
    s="${r##*/}"; [[ "$s" =~ ^0[0-9a-f]$ ]] || badshard=yes
done < <(git for-each-ref --format='%(refname)' 'refs/heads/tasks/v1/mailbox/*')
[ "$badshard" = no ] && ok "C2: every shard ref is within the fixed 00..0f set" \
    || bad "C2: a shard ref fell outside 00..0f"

# The converged mailbox passes validate --strict.
if "$TD" validate --strict >/dev/null 2>&1; then
    ok "C3: the populated mailbox passes validate --strict"
else
    bad "C3: populated mailbox failed validate --strict"
fi

# ===========================================================================
# Part D — ORDERED fold-then-delete + witness trailer + env passing.
# ===========================================================================
# A fold command: appends its env to a log, optionally makes a witness-trailer
# commit, and succeeds/fails based on a control file.
FOLDLOG="$ROOT/fold.log"
cat > "$ROOT/fold.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/dev/null
source "$LIBDIR/edges.sh"
source "$LIBDIR/mailbox.sh"
GREEN='' BLUE='' RESET=''
printf '%s\t%s\t%s\t%s\t%s\t%s\n' \\
  "\${TASKDAG_MAILBOX_MESSAGE_ID}" "\${TASKDAG_MAILBOX_KIND}" \\
  "\${TASKDAG_MAILBOX_NODE}" "\${TASKDAG_MAILBOX_WITNESS}" \\
  "\${TASKDAG_MAILBOX_DEST}" "\${TASKDAG_MAILBOX_ORIGIN_REPO}" >> "$FOLDLOG"
if [ -f "$ROOT/fold.fail" ]; then exit 1; fi
# Stamp the witness trailer into an effect commit on the local branch.
tr=\$(taskdag_mailbox_witness_trailer "\${TASKDAG_MAILBOX_WITNESS}" "\${TASKDAG_MAILBOX_MESSAGE_ID}")
git commit --allow-empty -q -m "Fold effect for \${TASKDAG_MAILBOX_MESSAGE_ID:0:12}

\${tr}"
exit 0
EOF
chmod +x "$ROOT/fold.sh"

# Fresh repo for a clean, small in-flight set.
git init -q --bare "$ROOT/d.git"
git clone -q "$ROOT/d.git" "$ROOT/D"
cd "$ROOT/D"
echo s > s.txt; git add s.txt; git commit -qm s; git push -q origin HEAD:master
git config "taskdag.owner/repo.id" 4242
git config "taskdag.current-repo" owner/repo
"$TD" mailbox put --node "$NODE" --witness "$WIT" --dest owner/repo --repo-id 4242 >/dev/null 2>&1
"$TD" mailbox put --node "$NODE" --witness "$WIT2" --dest owner/repo --repo-id 4242 >/dev/null 2>&1
n_before=$("$TD" mailbox list --json --no-fetch 2>/dev/null | jq 'length')

# D0: --dry-run consumes nothing.
"$TD" mailbox consume --dry-run --no-fetch >/dev/null 2>&1
n_dry=$("$TD" mailbox list --json --no-fetch 2>/dev/null | jq 'length')
[ "$n_dry" = "$n_before" ] && ok "D0: consume --dry-run deletes nothing" \
    || bad "D0: dry-run changed the set ($n_before -> $n_dry)"

# D1: fold FAILS ⇒ messages are LEFT (ordered: no delete without a durable fold).
: > "$FOLDLOG"; touch "$ROOT/fold.fail"
"$TD" mailbox consume --fold-cmd "$ROOT/fold.sh" --no-fetch >/dev/null 2>&1
rc_fail=$?
n_left=$("$TD" mailbox list --json --no-fetch 2>/dev/null | jq 'length')
if [ "$rc_fail" -ne 0 ] && [ "$n_left" = "$n_before" ]; then
    ok "D1: a FAILING fold leaves all messages enqueued (fold-then-delete ordering)"
else
    bad "D1: failing fold still deleted messages (rc=$rc_fail left=$n_left want=$n_before)"
fi

# D2: fold SUCCEEDS ⇒ messages are deleted (folded THEN deleted).
rm -f "$ROOT/fold.fail"; : > "$FOLDLOG"
"$TD" mailbox consume --fold-cmd "$ROOT/fold.sh" --no-fetch >/dev/null 2>&1
n_after=$("$TD" mailbox list --json --no-fetch 2>/dev/null | jq 'length')
folded=$(wc -l < "$FOLDLOG" | tr -d ' ')
if [ "$n_after" = 0 ] && [ "$folded" = "$n_before" ]; then
    ok "D2: a SUCCESSFUL fold deletes each message after folding it"
else
    bad "D2: consume did not fold-then-delete (after=$n_after folded=$folded want=$n_before)"
fi

# D3: the fold saw the message metadata via TASKDAG_MAILBOX_* env.
if grep -q "	completion	${NODE}	${WIT}	owner/repo	owner/repo" "$FOLDLOG" \
   && grep -q "	completion	${NODE}	${WIT2}	owner/repo	owner/repo" "$FOLDLOG"; then
    ok "D3: consume exports message metadata to the fold via TASKDAG_MAILBOX_* env"
else
    bad "D3: fold did not receive expected env (log: $(cat "$FOLDLOG"))"
fi

# D4: the fold's effect commit carries the witness + message-id trailers.
trailers=$(git log --format='%(trailers)')
if grep -q "^Mailbox-Witness: ${WIT}$" <<<"$trailers" \
   && grep -qE '^Mailbox-Message-Id: [0-9a-f]{64}$' <<<"$trailers"; then
    ok "D4: the fold's effect commit carries the witness-provenance trailers"
else
    bad "D4: witness trailer not stamped on the effect commit"
fi

# D5: consume is idempotent — a second run over an empty inbox is a clean no-op.
if "$TD" mailbox consume --fold-cmd "$ROOT/fold.sh" --no-fetch >/dev/null 2>&1; then
    ok "D5: consume over an empty inbox is a clean no-op success"
else
    bad "D5: consume over an empty inbox returned failure"
fi

# D6: CONDITIONAL delete — the delete CAS refuses to remove a message whose
#     stored content differs from the exact blob that was folded (guards the
#     same-id/different-content re-enqueue race: never delete an unfolded msg).
"$TD" mailbox put --node "$NODE" --witness "$WIT" --dest owner/repo --repo-id 4242 >/dev/null 2>&1
cond_before=$("$TD" mailbox list --json --no-fetch 2>/dev/null | jq 'length')
cond_out=$(
    # shellcheck source=/dev/null
    source "$LIBDIR/edges.sh"
    # shellcheck source=/dev/null
    source "$LIBDIR/facts.sh"
    # shellcheck source=/dev/null
    source "$LIBDIR/edges-write.sh"
    # shellcheck source=/dev/null
    source "$LIBDIR/mailbox.sh"
    mid=$(taskdag_mailbox_message_id completion "$NODE" "$WIT" owner/repo)
    shard=$(taskdag_mailbox_shard_for "$mid")
    wrong=$(printf 'a-different-blob' | git hash-object --stdin)  # a blob oid that is NOT the message
    # A delete with a WRONG expected blob must fail loud and leave the message.
    _taskdag_mailbox_cas remove origin "$shard" "msg/${mid}.json" "$wrong" "bad delete" 2>&1
    echo "rc=$?"
)
cond_after=$("$TD" mailbox list --json --no-fetch 2>/dev/null | jq 'length')
if echo "$cond_out" | grep -qi 'refusing to delete' && [ "$cond_after" = "$cond_before" ]; then
    ok "D6: conditional delete refuses a message whose content changed since it was folded"
else
    bad "D6: conditional delete did not guard (out=$cond_out before=$cond_before after=$cond_after)"
fi
# ...and a delete with the CORRECT expected blob (via consume) succeeds.
cat > "$ROOT/foldok.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$ROOT/foldok.sh"
"$TD" mailbox consume --fold-cmd "$ROOT/foldok.sh" --no-fetch >/dev/null 2>&1
cond_final=$("$TD" mailbox list --json --no-fetch 2>/dev/null | jq 'length')
[ "$cond_final" = 0 ] && ok "D6b: a delete with the correct folded blob succeeds" \
    || bad "D6b: correct-blob delete did not consume (final=$cond_final)"

# ===========================================================================
# Part E — cross-repo delivery: put into a PEER remote → consume in the peer.
# ===========================================================================
git init -q --bare "$ROOT/peer.git"        # repo B (dest)
git clone -q "$ROOT/peer.git" "$ROOT/B"
( cd "$ROOT/B"; echo s > s.txt; git add s.txt; git commit -qm s; git push -q origin HEAD:master
  git config "taskdag.current-repo" owner/peer )
git clone -q "$ROOT/origin.git" "$ROOT/A"  # repo A (source)
cd "$ROOT/A"
git config "taskdag.current-repo" owner/src
git config "taskdag.owner/peer.id" 7777
git remote add peer "$ROOT/peer.git"
git config "taskdag.remote-repo.peer" owner/peer    # offline remote-identity seam
PEERNODE="task:owner/peer@$FORTYB"
if "$TD" mailbox put --node "$PEERNODE" --witness "$WIT" --dest owner/peer \
        --remote peer --repo-id 7777 >/dev/null 2>&1; then
    # Now consume in repo B (its own origin inbox).
    cd "$ROOT/B"
    export TASKDAG_CURRENT_REPO=owner/peer
    got=$("$TD" mailbox list --json 2>/dev/null)
    if printf '%s' "$got" | jq -e 'length == 1 and .[0].dest == "owner/peer"
            and .[0].node == "'"$PEERNODE"'"' >/dev/null 2>&1; then
        ok "E1: cross-repo put delivers a message into the peer repo's mailbox"
    else
        bad "E1: peer did not receive the cross-repo message (got: $got)"
    fi
    unset TASKDAG_CURRENT_REPO
else
    bad "E1: cross-repo mailbox put failed"
fi

# E2: consume in repo B folds + deletes the delivered message.
cd "$ROOT/B"
export TASKDAG_CURRENT_REPO=owner/peer
cat > "$ROOT/foldB.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$ROOT/foldB.sh"
"$TD" mailbox consume --fold-cmd "$ROOT/foldB.sh" >/dev/null 2>&1
remain=$("$TD" mailbox list --json 2>/dev/null | jq 'length')
[ "$remain" = 0 ] && ok "E2: the peer consumes (folds+deletes) the delivered message" \
    || bad "E2: peer did not consume the delivered message (remain=$remain)"
unset TASKDAG_CURRENT_REPO

# ===========================================================================
# Part F — concurrent FF contention: two racing puts to the SAME shard.
# ===========================================================================
# Force a shard collision: two witnesses whose message-ids share a first
# nibble is not guaranteed, so instead race two puts of DISTINCT messages and
# assert both survive regardless of which shard(s) they land in.
git init -q --bare "$ROOT/c.git"
git clone -q "$ROOT/c.git" "$ROOT/CA"
git clone -q "$ROOT/c.git" "$ROOT/CB"
for d in CA CB; do
    ( cd "$ROOT/$d"; echo s > s.txt; git add s.txt; git commit -qm s; git push -q origin HEAD:master
      git config "taskdag.owner/repo.id" 4242; git config "taskdag.current-repo" owner/repo )
done
( cd "$ROOT/CA"; TASKDAG_CAS_BASE_MS=20 TASKDAG_CAS_CAP_MS=100 TASKDAG_CAS_JITTER_MS=20 \
    "$TD" mailbox put --node "$NODE" --witness "$WIT" --dest owner/repo --repo-id 4242 ) >/dev/null 2>&1 &
pidA=$!
( cd "$ROOT/CB"; TASKDAG_CAS_BASE_MS=20 TASKDAG_CAS_CAP_MS=100 TASKDAG_CAS_JITTER_MS=20 \
    "$TD" mailbox put --node "$NODE" --witness "$WIT2" --dest owner/repo --repo-id 4242 ) >/dev/null 2>&1 &
pidB=$!
wait "$pidA"; rcA=$?
wait "$pidB"; rcB=$?
git clone -q "$ROOT/c.git" "$ROOT/CR"
cd "$ROOT/CR"; git config "taskdag.current-repo" owner/repo
conv=$("$TD" mailbox list --json 2>/dev/null)
if [ "$rcA" = 0 ] && [ "$rcB" = 0 ] \
    && printf '%s' "$conv" | jq -e 'length == 2
        and any(.[]; .witness == "'"$WIT"'")
        and any(.[]; .witness == "'"$WIT2"'")' >/dev/null 2>&1; then
    ok "F1: concurrent FF contention converges — both racing messages survive"
else
    bad "F1: concurrent contention lost a message (rcA=$rcA rcB=$rcB got: $conv)"
fi

# ===========================================================================
# Part G — FAIL-LOUD on retry-budget exhaustion (deterministic).
# ===========================================================================
WIT3=$(printf '3%.0s' {1..40})   # a witness NOT enqueued anywhere else
gexhaust() {
    TASKDAG_CAS_BASE_MS=0 TASKDAG_CAS_CAP_MS=0 TASKDAG_CAS_JITTER_MS=0 TASKDAG_CAS_MAX_ATTEMPTS=2
    # shellcheck source=/dev/null
    source "$LIBDIR/edges.sh"
    # shellcheck source=/dev/null
    source "$LIBDIR/facts.sh"
    # shellcheck source=/dev/null
    source "$LIBDIR/edges-write.sh"
    # shellcheck source=/dev/null
    source "$LIBDIR/mailbox.sh"
    # Neutralize the shard sync so `old` stays a STALE local ref while origin's
    # real shard tip differs → every FF lease is rejected → exhaustion → loud.
    taskdag_mailbox_sync_shard() { return 0; }
    local mid shard stale
    mid=$(taskdag_mailbox_message_id completion "$NODE" "$WIT3" owner/repo)
    shard=$(taskdag_mailbox_shard_for "$mid")   # the shard the put will target
    stale=$(git commit-tree "$EMPTY_TREE" -m stale </dev/null)
    git update-ref "refs/heads/tasks/v1/mailbox/${shard}" "$stale"
    taskdag_mailbox_put completion "$NODE" "$WIT3" owner/repo owner/repo 4242
}
cd "$ROOT/wc"
if ( gexhaust ) >/dev/null 2>&1; then
    bad "G1: exhausted CAS did not fail loud (returned success)"
else
    ok "G1: exhausted retry budget fails loud (non-zero exit)"
fi
msg=$(gexhaust 2>&1 || true)
if echo "$msg" | grep -qiE 'exhaust|failing loud'; then
    ok "G2: exhaustion failure message is loud + explanatory"
else
    bad "G2: exhaustion message not explanatory (got: $msg)"
fi

echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
