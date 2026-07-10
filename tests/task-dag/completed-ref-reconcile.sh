#!/usr/bin/env bash
# Master-derived scheduling-ref reconciliation. All repositories are local
# throwaways; no network or production resources are used.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
case "$TD" in /*) ;; *) TD="$(pwd)/$TD" ;; esac
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_GIT_NAME=t TASK_DAG_GIT_EMAIL=t@t

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"; cd "$ROOT/wc" || exit 1
git config taskdag.current-repo acme/widgets
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master
EMPTY_TREE=$(git mktree </dev/null)

task_commit() {
    local title="$1"; shift
    git commit-tree "$EMPTY_TREE" "$@" -m "Task: $title

Issue: #71
URL: https://github.com/acme/widgets/issues/71
Author: tester
Status: pending
Type: leaf"
}

claim_commit() {
    local task="$1" suffix="$2"
    git commit-tree "$EMPTY_TREE" -p "$task" -m "Claim: ${suffix}

Task-Commit: ${task}
Claimer: fixture
Claimer-Host: fixture-host"
}

meta_commit() {
    local task="$1"
    git commit-tree "$EMPTY_TREE" -p "$task" -m "Blocked-Meta: fixture

Task-Commit: ${task}
Blocker-Kind: downstream
Reason: fixture"
}

publish_stale_refs() {
    local task="$1" suffix="$2" claim meta
    claim=$(claim_commit "$task" "$suffix")
    meta=$(meta_commit "$task")
    git push -q origin \
        "$task:refs/heads/tasks/frontier/$suffix" \
        "$claim:refs/heads/tasks/active/$suffix" \
        "$task:refs/heads/tasks/blocked/$task" \
        "$meta:refs/heads/tasks/blocked-meta/$task"
}

remote_has() { git ls-remote origin "$1" | grep -q .; }
all_refs_absent() {
    local task="$1" suffix="$2"
    ! remote_has "refs/heads/tasks/frontier/$suffix" \
        && ! remote_has "refs/heads/tasks/active/$suffix" \
        && ! remote_has "refs/heads/tasks/blocked/$task" \
        && ! remote_has "refs/heads/tasks/blocked-meta/$task"
}
all_refs_present() {
    local task="$1" suffix="$2"
    remote_has "refs/heads/tasks/frontier/$suffix" \
        && remote_has "refs/heads/tasks/active/$suffix" \
        && remote_has "refs/heads/tasks/blocked/$task" \
        && remote_has "refs/heads/tasks/blocked-meta/$task"
}

# A durable completion lands first. All four scheduling refs (including an
# active claim) are then deliberately recreated to model a missed cleanup and
# a stale worker claiming after completion.
A=$(task_commit "push-backstop completed")
AS=${A:0:12}
base=$(git rev-parse HEAD); tree=$(git rev-parse "$base^{tree}")
AW=$(git commit-tree "$tree" -p "$base" -p "$A" -m "Complete fixture A")
git update-ref refs/heads/master "$AW"; git push -q origin master:master
publish_stale_refs "$A" "$AS"
git config core.abbrev 16

out=$("$TD" graph-converge --range "$AW" 2>&1); rc=$?
if [ "$rc" -eq 0 ] && all_refs_absent "$A" "$AS"; then
    ok "push-range backstop removes all stale refs using the observed 12-hex suffix"
else
    bad "push-range backstop failed (rc=$rc out=$out)"
fi
out=$("$TD" graph-converge --range "$AW" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "push-range reconciliation is idempotent" || bad "push-range rerun failed (rc=$rc out=$out)"

# Complete a child whose first parent is structural P and second parent is a
# dependency D. P and D become reachable through master ancestry, but neither
# is a completion parent on master's first-parent spine and must stay live.
P=$(task_commit "unfinished structural parent")
D=$(task_commit "unfinished dependency")
C=$(task_commit "scheduled completed child" -p "$P" -p "$D")
PS=${P:0:12}; DS=${D:0:12}; CS=${C:0:12}
git push -q origin "$P:refs/heads/tasks/frontier/$PS" "$D:refs/heads/tasks/frontier/$DS"
git fetch -q origin master; base=$(git rev-parse origin/master); tree=$(git rev-parse "$base^{tree}")
CW=$(git commit-tree "$tree" -p "$base" -p "$C" -m "Complete fixture C")
git update-ref refs/heads/master "$CW"; git push -q origin master:master
publish_stale_refs "$C" "$CS"

out=$("$TD" graph-converge 2>&1); rc=$?
if [ "$rc" -eq 0 ] && all_refs_absent "$C" "$CS"; then
    ok "scheduled no-range backstop repairs a completed task"
else
    bad "scheduled backstop failed (rc=$rc out=$out)"
fi
if remote_has "refs/heads/tasks/frontier/$PS" && remote_has "refs/heads/tasks/frontier/$DS"; then
    ok "reachable structural and dependency parents remain scheduled"
else
    bad "first-parent witness guard removed an unfinished structural/dependency task"
fi
out=$("$TD" graph-converge 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "scheduled reconciliation is idempotent" || bad "scheduled rerun failed (rc=$rc out=$out)"

# Replace an observed active claim between snapshot and cleanup. The local
# pre-push hook is a deterministic race seam: it advances the bare origin ref
# immediately before git sends the leased atomic deletion.
Q=$(task_commit "active replacement race")
QS=${Q:0:12}
git fetch -q origin master; base=$(git rev-parse origin/master); tree=$(git rev-parse "$base^{tree}")
QW=$(git commit-tree "$tree" -p "$base" -p "$Q" -m "Complete fixture Q")
git update-ref refs/heads/master "$QW"; git push -q origin master:master
publish_stale_refs "$Q" "$QS"
QA=$(git ls-remote origin "refs/heads/tasks/active/$QS" | awk '{print $1}')
QB=$(git commit-tree "$EMPTY_TREE" -p "$Q" -m "Claim: ${QS} replacement

Task-Commit: ${Q}
Claimer: replacement
Claimer-Host: fixture-host")
git push -q origin "$QB:refs/heads/test/replacement-claim"
mkdir -p .git/hooks
cat > .git/hooks/pre-push <<SH
#!/usr/bin/env bash
if [ -f "$ROOT/race-active-once" ]; then
    git --git-dir="$ROOT/origin.git" update-ref "refs/heads/tasks/active/$QS" "$QB" "$QA"
    rm -f "$ROOT/race-active-once"
fi
exit 0
SH
chmod +x .git/hooks/pre-push
touch "$ROOT/race-active-once"
out=$("$TD" graph-converge 2>&1); rc=$?
qactive=$(git ls-remote origin "refs/heads/tasks/active/$QS" | awk '{print $1}')
if [ "$rc" -ne 0 ] && [ "$qactive" = "$QB" ] && all_refs_present "$Q" "$QS"; then
    ok "replacement active claim wins the lease race and atomic cleanup preserves every ref"
else
    bad "active replacement race was clobbered or partially cleaned (rc=$rc active=$qactive out=$out)"
fi
rm -f .git/hooks/pre-push
out=$("$TD" graph-converge 2>&1); rc=$?
if [ "$rc" -eq 0 ] && all_refs_absent "$Q" "$QS"; then
    ok "fresh snapshot validates and removes the replacement claim"
else
    bad "replacement-claim retry failed (rc=$rc out=$out)"
fi

# A rejected atomic cleanup must preserve every ref. Removing the rejection
# and rerunning converges, proving the backstop is retry-safe.
R=$(task_commit "rejected cleanup retry")
RS=${R:0:12}
git fetch -q origin master; base=$(git rev-parse origin/master); tree=$(git rev-parse "$base^{tree}")
RW=$(git commit-tree "$tree" -p "$base" -p "$R" -m "Complete fixture R")
git update-ref refs/heads/master "$RW"; git push -q origin master:master
publish_stale_refs "$R" "$RS"
cat > "$ROOT/origin.git/hooks/pre-receive" <<'SH'
#!/usr/bin/env bash
if [ -f "$GIT_DIR/reject-completed-ref-cleanup" ]; then
    while read -r old new ref; do
        case "$ref" in refs/heads/tasks/frontier/*|refs/heads/tasks/active/*|refs/heads/tasks/blocked/*|refs/heads/tasks/blocked-meta/*)
            if [ "$new" = 0000000000000000000000000000000000000000 ]; then exit 1; fi ;;
        esac
    done
fi
exit 0
SH
chmod +x "$ROOT/origin.git/hooks/pre-receive"
touch "$ROOT/origin.git/reject-completed-ref-cleanup"
out=$("$TD" graph-converge 2>&1); rc=$?
if [ "$rc" -ne 0 ] && all_refs_present "$R" "$RS"; then
    ok "rejected atomic cleanup fails loudly and preserves all four refs"
else
    bad "rejected cleanup was partial or silent (rc=$rc out=$out)"
fi
rm "$ROOT/origin.git/reject-completed-ref-cleanup"
out=$("$TD" graph-converge 2>&1); rc=$?
if [ "$rc" -eq 0 ] && all_refs_absent "$R" "$RS"; then
    ok "a later strict snapshot retries and converges"
else
    bad "cleanup retry failed (rc=$rc out=$out)"
fi

# Failure to take the strict origin snapshot must not mutate scheduling refs.
F=$(task_commit "snapshot failure")
FS=${F:0:12}
git fetch -q origin master; base=$(git rev-parse origin/master); tree=$(git rev-parse "$base^{tree}")
FW=$(git commit-tree "$tree" -p "$base" -p "$F" -m "Complete fixture F")
git update-ref refs/heads/master "$FW"; git push -q origin master:master
publish_stale_refs "$F" "$FS"
origin_url=$(git remote get-url origin)
git remote set-url origin "$ROOT/missing-origin.git"
out=$("$TD" graph-converge 2>&1); rc=$?
git remote set-url origin "$origin_url"
if [ "$rc" -ne 0 ] \
   && git --git-dir="$ROOT/origin.git" show-ref --verify --quiet "refs/heads/tasks/frontier/$FS" \
   && git --git-dir="$ROOT/origin.git" show-ref --verify --quiet "refs/heads/tasks/active/$FS" \
   && git --git-dir="$ROOT/origin.git" show-ref --verify --quiet "refs/heads/tasks/blocked/$F" \
   && git --git-dir="$ROOT/origin.git" show-ref --verify --quiet "refs/heads/tasks/blocked-meta/$F"; then
    ok "strict snapshot failure is loud and leaves every scheduling ref intact"
else
    bad "snapshot failure was silent or mutated refs (rc=$rc out=$out)"
fi
out=$("$TD" graph-converge 2>&1); rc=$?
if [ "$rc" -eq 0 ] && all_refs_absent "$F" "$FS"; then
    ok "snapshot recovery converges on the next run"
else
    bad "snapshot recovery failed (rc=$rc out=$out)"
fi

# Corrupt aliases fail visibly and survive. The suffix intentionally does not
# prefix the completed task OID, so reconciliation must never guess its owner.
M=$(task_commit "malformed alias")
MS=${M:0:12}
git fetch -q origin master; base=$(git rev-parse origin/master); tree=$(git rev-parse "$base^{tree}")
MW=$(git commit-tree "$tree" -p "$base" -p "$M" -m "Complete fixture M")
git update-ref refs/heads/master "$MW"; git push -q origin master:master
publish_stale_refs "$M" "$MS"
git push -q origin "$M:refs/heads/tasks/frontier/deadbeef"
out=$("$TD" graph-converge 2>&1); rc=$?
if [ "$rc" -ne 0 ] && all_refs_present "$M" "$MS" \
   && remote_has refs/heads/tasks/frontier/deadbeef \
   && echo "$out" | grep -q 'malformed frontier projection'; then
    ok "malformed alias fails loud and preserves every valid sibling ref"
else
    bad "malformed alias caused silent or partial cleanup (rc=$rc out=$out)"
fi

# A contradictory full-SHA blocked ref invalidates both identities: the task
# encoded in the ref name and the different task object it points at.
Z=$(task_commit "malformed blocked identity")
ZS=${Z:0:12}
OTHER=$(task_commit "wrong blocked target")
git fetch -q origin master; base=$(git rev-parse origin/master); tree=$(git rev-parse "$base^{tree}")
ZW=$(git commit-tree "$tree" -p "$base" -p "$Z" -m "Complete fixture Z")
git update-ref refs/heads/master "$ZW"; git push -q origin master:master
publish_stale_refs "$Z" "$ZS"
git push -q origin \
    "--force-with-lease=refs/heads/tasks/blocked/$Z:$Z" \
    "$OTHER:refs/heads/tasks/blocked/$Z"
out=$("$TD" graph-converge 2>&1); rc=$?
zblocked=$(git ls-remote origin "refs/heads/tasks/blocked/$Z" | awk '{print $1}')
if [ "$rc" -ne 0 ] && [ "$zblocked" = "$OTHER" ] \
   && remote_has "refs/heads/tasks/frontier/$ZS" \
   && remote_has "refs/heads/tasks/active/$ZS" \
   && remote_has "refs/heads/tasks/blocked-meta/$Z"; then
    ok "contradictory blocked identity preserves all valid sibling refs"
else
    bad "contradictory blocked identity caused partial cleanup (rc=$rc blocked=$zblocked out=$out)"
fi

# An active ref's abbreviated suffix is also an identity. If its claim object
# names another task, both the claim task and every candidate matching the
# suffix are invalidated for this run.
Y=$(task_commit "malformed active identity")
YS=${Y:0:12}
N=$(task_commit "wrong active target")
git fetch -q origin master; base=$(git rev-parse origin/master); tree=$(git rev-parse "$base^{tree}")
YW=$(git commit-tree "$tree" -p "$base" -p "$Y" -m "Complete fixture Y")
git update-ref refs/heads/master "$YW"; git push -q origin master:master
publish_stale_refs "$Y" "$YS"
wrong_claim=$(claim_commit "$N" "${N:0:12}")
old_claim=$(git ls-remote origin "refs/heads/tasks/active/$YS" | awk '{print $1}')
git push -q origin \
    "--force-with-lease=refs/heads/tasks/active/$YS:$old_claim" \
    "$wrong_claim:refs/heads/tasks/active/$YS"
out=$("$TD" graph-converge 2>&1); rc=$?
yactive=$(git ls-remote origin "refs/heads/tasks/active/$YS" | awk '{print $1}')
if [ "$rc" -ne 0 ] && [ "$yactive" = "$wrong_claim" ] \
   && remote_has "refs/heads/tasks/frontier/$YS" \
   && remote_has "refs/heads/tasks/blocked/$Y" \
   && remote_has "refs/heads/tasks/blocked-meta/$Y"; then
    ok "contradictory active suffix preserves all valid sibling refs"
else
    bad "contradictory active suffix caused partial cleanup (rc=$rc active=$yactive out=$out)"
fi

# A very short suffix makes a deterministic collision fixture practical. Two
# individually valid aliases that resolve the same suffix to different tasks
# must invalidate the whole suffix rather than partially clean either task.
COLLIDE_A=$(task_commit "suffix collision A")
prefix=${COLLIDE_A:0:1}
COLLIDE_B=""
for i in $(seq 1 100); do
    candidate=$(task_commit "suffix collision B $i")
    if [ "${candidate:0:1}" = "$prefix" ] && [ "$candidate" != "$COLLIDE_A" ]; then
        COLLIDE_B="$candidate"; break
    fi
done
[ -n "$COLLIDE_B" ] || { bad "could not mint deterministic one-hex collision"; exit 1; }
git fetch -q origin master; base=$(git rev-parse origin/master); tree=$(git rev-parse "$base^{tree}")
CAW=$(git commit-tree "$tree" -p "$base" -p "$COLLIDE_A" -m "Complete collision A")
git update-ref refs/heads/master "$CAW"; git push -q origin master:master
cb_claim=$(claim_commit "$COLLIDE_B" "$prefix")
ca_meta=$(meta_commit "$COLLIDE_A")
git push -q origin \
    "$COLLIDE_A:refs/heads/tasks/frontier/$prefix" \
    "$cb_claim:refs/heads/tasks/active/$prefix" \
    "$COLLIDE_A:refs/heads/tasks/blocked/$COLLIDE_A" \
    "$ca_meta:refs/heads/tasks/blocked-meta/$COLLIDE_A"
out=$("$TD" graph-converge 2>&1); rc=$?
if [ "$rc" -ne 0 ] \
   && remote_has "refs/heads/tasks/frontier/$prefix" \
   && remote_has "refs/heads/tasks/active/$prefix" \
   && remote_has "refs/heads/tasks/blocked/$COLLIDE_A" \
   && remote_has "refs/heads/tasks/blocked-meta/$COLLIDE_A" \
   && echo "$out" | grep -q 'identifies multiple tasks'; then
    ok "shared abbreviated suffix preserves both task projections"
else
    bad "shared abbreviated suffix caused partial cleanup (rc=$rc out=$out)"
fi

echo "----"
echo "completed-ref-reconcile: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
