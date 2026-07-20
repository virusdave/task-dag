#!/usr/bin/env bash
# Fixture tests for graph convergence wiring (issue #13): same-repo folding,
# cross-repo mailbox hints, cascade through supersede completion, and lost-hint
# backstop re-derivation from authoritative master history.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
if [ "$($TD migration-status --json | jq -r .mode)" = draining-legacy-writers ]; then
  "$TD" graph-converge --no-fetch >/dev/null 2>&1; rc=$?
  [ "$rc" -eq 75 ] && { echo "PASS: legacy graph convergence integration is drained"; exit 0; }
  echo "FAIL: expected migration status 75, got $rc"; exit 1
fi

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"

init_repo() { # <name> <owner/repo>
    local name="$1" repo="$2"
    git init -q --bare "$ROOT/${name}.git"
    git clone -q "$ROOT/${name}.git" "$ROOT/${name}"
    ( cd "$ROOT/${name}" && echo seed > seed.txt && git add seed.txt && git commit -qm seed && git push -q origin HEAD:master && git config taskdag.current-repo "$repo" && git config "taskdag.${repo}.id" "$(( ${#name} + 100 ))" )
}

mk_task() { # <repo-dir> <message> [parent]
    local dir="$1" msg="$2" parent="${3:-}" sha short
    [ -n "$parent" ] || parent=$(git -C "$dir" rev-parse HEAD)
    sha=$(git -C "$dir" commit-tree "$EMPTY_TREE" -p "$parent" -m "$msg")
    short=$(git -C "$dir" rev-parse --short "$sha")
    git -C "$dir" update-ref "refs/heads/tasks/frontier/$short" "$sha"
    git -C "$dir" push -q origin "refs/heads/tasks/frontier/$short" >/dev/null
    printf '%s\n' "$sha"
}

complete_task() { # <repo-dir> <task-sha>
    local dir="$1" task="$2" tip tree merge
    tip=$(git -C "$dir" rev-parse refs/heads/master)
    tree=$(git -C "$dir" rev-parse "$tip^{tree}")
    merge=$(git -C "$dir" commit-tree "$tree" -p "$tip" -p "$task" -m "Complete task

Task-Commit: $task
Status: completed")
    git -C "$dir" update-ref refs/heads/master "$merge"
    git -C "$dir" push -q origin master:master
    git -C "$dir" fetch -q origin '+refs/heads/master:refs/remotes/origin/master'
    printf '%s\n' "$merge"
}

publish_pending_epic() { # <repo-dir> <issue> <epic-sha>
    local dir="$1" issue="$2" epic="$3"
    git -C "$dir" update-ref "refs/heads/tasks/pending/$issue" "$epic"
    git -C "$dir" push -q origin "refs/heads/tasks/pending/$issue" >/dev/null
}

has_close_merge() { # <repo-dir> <issue> <epic-sha>
    local dir="$1" issue="$2" epic="$3" tip mc parents
    tip=$(git -C "$dir" rev-parse --verify -q refs/remotes/origin/master^{commit} 2>/dev/null \
        || git -C "$dir" rev-parse --verify -q refs/heads/master^{commit}) || return 1
    while read -r mc parents; do
        [ -n "$mc" ] || continue
        case " $parents " in *" $epic "*) ;; *) continue ;; esac
        git -C "$dir" log -1 --format='%B' "$mc" \
            | git interpret-trailers --parse 2>/dev/null \
            | grep -qE "^Closes-Epic:[[:space:]]*#?${issue}([^0-9]|\$)" && return 0
    done < <(git -C "$dir" log "$tip" --merges --format='%H %P' 2>/dev/null)
    return 1
}

edge_id() { ( cd "$1" && "$TD" dep add --from "$2" --to "$3" --relation "$4" --repo-id 101 --witness w >/dev/null && "$TD" dep add --from "$2" --to "$3" --relation "$4" --repo-id 101 --witness w >/dev/null 2>&1 || true && "$TD" edges --json --no-fetch | jq -r --arg f "$2" --arg t "$3" --arg r "$4" '.[] | select(.from==$f and .to==$t and .relation==$r) | .edgeId' ); }
edge_absent() { ! git -C "$1" cat-file -e "refs/heads/tasks/v1/graph:edges/$2.json" 2>/dev/null; }
edge_present() { git -C "$1" cat-file -e "refs/heads/tasks/v1/graph:edges/$2.json" 2>/dev/null; }

# ── A. same-repo requires fold ─────────────────────────────────────────────
init_repo same owner/repo
cd "$ROOT/same" || exit 1
A=$(mk_task "$ROOT/same" "Task: A")
B=$(mk_task "$ROOT/same" "Task: B")
NA="task:owner/repo@$A"; NB="task:owner/repo@$B"
EAB=$(edge_id "$ROOT/same" "$NB" "$NA" requires)
WA=$(complete_task "$ROOT/same" "$A")
if "$TD" graph-converge --range "$WA" >/dev/null 2>&1 && edge_absent "$ROOT/same" "$EAB"; then
    ok "A1 push-reaction graph-converge folds same-repo requires edge"
else
    bad "A1 push-reaction same-repo requires edge did not fold"
fi
if "$TD" propagate-completion --node "$NA" --witness "$WA" >/dev/null 2>&1; then
    ok "A2 same-repo fold is idempotent"
else
    bad "A2 same-repo fold was not idempotent"
fi

# A completed child makes structural/dependency parents reachable, but they
# are not canonical completion witnesses and must not fold targeting edges.
P=$(mk_task "$ROOT/same" "Task: structural parent")
DP=$(mk_task "$ROOT/same" "Task: dependency parent")
CH=$(git commit-tree "$EMPTY_TREE" -p "$P" -p "$DP" -m "Task: child")
CHS=$(git rev-parse --short "$CH")
git update-ref "refs/heads/tasks/frontier/$CHS" "$CH"
git push -q origin "refs/heads/tasks/frontier/$CHS"
NP="task:owner/repo@$P"; NDP="task:owner/repo@$DP"
EP=$(edge_id "$ROOT/same" "$NB" "$NP" requires)
EDP=$(edge_id "$ROOT/same" "$NB" "$NDP" requires)
WCH=$(complete_task "$ROOT/same" "$CH")
if "$TD" graph-converge --range "$WCH" >/dev/null 2>&1 \
   && edge_present "$ROOT/same" "$EP" && edge_present "$ROOT/same" "$EDP"; then
    ok "A3 push scan leaves structural/dependency parent edges active"
else
    bad "A3 push scan falsely folded a reachable task parent's edge"
fi
if "$TD" graph-converge --range does-not-exist >/dev/null 2>&1; then
    bad "A4 invalid push range returned success"
else
    ok "A4 invalid push range fails loudly"
fi

# ── B. cascade through satisfies synth-completion ──────────────────────────
C=$(mk_task "$ROOT/same" "Task: C")
D=$(mk_task "$ROOT/same" "Task: D")
NC="task:owner/repo@$C"; ND="task:owner/repo@$D"
ECD=$(edge_id "$ROOT/same" "$NC" "$NA" satisfies)
EDC=$(edge_id "$ROOT/same" "$ND" "$NC" requires)
if "$TD" propagate-completion --node "$NA" --witness "$WA" >/dev/null 2>&1 \
    && "$TD" facts --node "$NC" --no-fetch >/dev/null 2>&1 \
    && edge_absent "$ROOT/same" "$ECD" && edge_absent "$ROOT/same" "$EDC"; then
    ok "B1 satisfies synth-completion cascades to downstream requires edge"
else
    bad "B1 cascade through synth-completion failed"
fi

# ── C. cross-repo hint and lost-hint backstop ──────────────────────────────
init_repo src owner/src
init_repo dst owner/dst
AS=$(mk_task "$ROOT/src" "Task: source")
BD=$(mk_task "$ROOT/dst" "Task: dependent")
NAS="task:owner/src@$AS"; NBD="task:owner/dst@$BD"
WAS=$(complete_task "$ROOT/src" "$AS")
( cd "$ROOT/src" && git remote add dst "$ROOT/dst.git" && git config taskdag.remote-repo.dst owner/dst && git config taskdag.owner/src.id 4242 )
if ( cd "$ROOT/src" && "$TD" propagate-completion --node "$NAS" --witness "$WAS" --notify-peer dst:owner/dst >/dev/null 2>&1 ) \
    && ( cd "$ROOT/dst" && "$TD" mailbox list --json | jq -e 'length == 1 and .[0].dest == "owner/dst" and .[0].node == "'"$NAS"'"' >/dev/null ); then
    ok "C1 source-side propagation enqueues cross-repo mailbox hint"
else
    bad "C1 cross-repo mailbox hint was not delivered"
fi

( cd "$ROOT/dst" && git config "taskdag.peer-path.owner/src.path" "$ROOT/src" )
if ( cd "$ROOT/dst" && "$TD" mailbox consume --no-fetch --fold-cmd /bin/false >/dev/null 2>&1 ); then
    bad "C2 malformed fold command unexpectedly consumed mailbox"
else
    ok "C2 mailbox leaves hint queued when fold command fails"
fi

ED=$(edge_id "$ROOT/dst" "$NBD" "$NAS" requires)
if ( cd "$ROOT/dst" && "$TD" reconcile-backstop --no-fetch --no-mailbox >/dev/null 2>&1 ) \
    && edge_absent "$ROOT/dst" "$ED"; then
    ok "C3 lost-hint backstop re-derives foreign completion and folds edge"
else
    bad "C3 lost-hint backstop failed to fold foreign satisfied edge"
fi

# ── D. epic auto-close over local child obligations ───────────────────────
EP=$(mk_task "$ROOT/same" "Task: local child epic

Issue: #88
Type: epic")
publish_pending_epic "$ROOT/same" 88 "$EP"
CH=$(mk_task "$ROOT/same" "Task: child
Type: leaf" "$EP")
WCH=$(complete_task "$ROOT/same" "$CH")
if ( cd "$ROOT/same" && "$TD" graph-converge --range "$WCH^..$WCH" --no-fetch >/dev/null 2>&1 ) \
    && has_close_merge "$ROOT/same" 88 "$EP"; then
    ok "D1 graph-converge auto-closes an epic whose child obligations are complete"
else
    bad "D1 graph-converge did not close child-complete epic"
fi

# The close candidate is valid only for the exact origin-backed semantic
# generation that produced it. A task-ref change during the nested publication
# preparation must force a fresh evaluation rather than publishing stale work.
EP_DRIFT=$(mk_task "$ROOT/same" "Task: authority drift epic

Issue: #93
Type: epic")
publish_pending_epic "$ROOT/same" 93 "$EP_DRIFT"
CH_DRIFT=$(mk_task "$ROOT/same" "Task: authority drift child
Type: leaf" "$EP_DRIFT")
complete_task "$ROOT/same" "$CH_DRIFT" >/dev/null
if ( cd "$ROOT/same" && source "$TD" --help >/dev/null && prepare_count=0 && \
    taskdag_consumer_test_after_prepare_hook() {
        prepare_count=$((prepare_count+1))
        if [ "$prepare_count" -eq 2 ]; then
            local drift drift_short
            drift=$(git commit-tree "$EMPTY_TREE" -m 'Task: concurrent authority change') || return 1
            drift_short=$(git rev-parse --short "$drift") || return 1
            git push -q origin "$drift:refs/heads/tasks/frontier/$drift_short" || return 1
        fi
    } && \
    ! taskdag_emit_origin_epic_close 93 "$EP_DRIFT" false >/dev/null 2>&1 ) \
    && ! has_close_merge "$ROOT/same" 93 "$EP_DRIFT"; then
    ok "D2 auto-close fails closed when semantic authority changes before publication"
else
    bad "D2 auto-close published across an authority-generation change"
fi

# ── E. epic auto-close over cross-repo requires obligations ───────────────
EPX=$(mk_task "$ROOT/dst" "Task: cross-repo requires epic

Issue: #89
Type: epic")
publish_pending_epic "$ROOT/dst" 89 "$EPX"
XS=$(mk_task "$ROOT/src" "Task: cross source")
NXS="task:owner/src@$XS"; NEX="task:owner/dst@$EPX"
WX=$(complete_task "$ROOT/src" "$XS")
EX=$(edge_id "$ROOT/dst" "$NEX" "$NXS" requires)
( cd "$ROOT/dst" && git config "taskdag.peer-path.owner/src.path" "$ROOT/src" )
if ( cd "$ROOT/dst" && "$TD" reconcile-backstop --no-fetch --no-mailbox >/dev/null 2>&1 ) \
    && has_close_merge "$ROOT/dst" 89 "$EPX" \
    && edge_absent "$ROOT/dst" "$EX"; then
    ok "E1 reconcile-backstop auto-closes a requires-only cross-repo epic before folding the edge"
else
    bad "E1 reconcile-backstop did not close the cross-repo requires-only epic"
fi

# ── F. materialisation intent blocks the independent graph closer ─────────
# The graph-converge workflow races the materialise workflow on the same push.
# Even if it sees the final child completion first, the declaration itself is
# an obligation and must prevent a close until marker+delegation+edge exist.
EP_MCE=$(mk_task "$ROOT/dst" "Task: materialising epic

Issue: #91
Type: epic")
publish_pending_epic "$ROOT/dst" 91 "$EP_MCE"
CH_MCE=$(mk_task "$ROOT/dst" "Task: materialising child
Type: leaf" "$EP_MCE")
MCE_BASE=$(git -C "$ROOT/dst" rev-parse HEAD)
(
    cd "$ROOT/dst" || exit 1
    printf '# child plan\n' > child-plan.md
    git add child-plan.md
    git commit -q -F - <<'EOF'
Materialise the child implementation

Materialise-Child-Epic: peer/repo
Child-Epic-Title: Child implementation
Child-Epic-Body-File: child-plan.md
Parent-Issue: #91
EOF
)
MCE_FEATURE=$(git -C "$ROOT/dst" rev-parse HEAD)
MCE_TREE=$(git -C "$ROOT/dst" rev-parse "$MCE_FEATURE^{tree}")
# Put the declaration only on a NON-first-parent commit. The materialisation
# workflow scans every reachable commit in the push range, so the close barrier
# must do the same rather than inspecting only the mainline merge message.
MCE_IMPL=$(git -C "$ROOT/dst" commit-tree "$MCE_TREE" -p "$MCE_BASE" -p "$MCE_FEATURE" -m "Merge child plan declaration")
MCE_DONE=$(git -C "$ROOT/dst" commit-tree "$MCE_TREE" -p "$MCE_IMPL" -p "$CH_MCE" -m "Complete materialising child")
git -C "$ROOT/dst" update-ref refs/heads/master "$MCE_DONE"
git -C "$ROOT/dst" push -q origin master:master
git -C "$ROOT/dst" fetch -q origin '+refs/heads/master:refs/remotes/origin/master'
if ( cd "$ROOT/dst" && "$TD" graph-converge --range "$MCE_IMPL^..$MCE_DONE" --no-fetch >/dev/null 2>&1 ) \
    && ! has_close_merge "$ROOT/dst" 91 "$EP_MCE"; then
    ok "F1 graph convergence defers close until materialisation intent is durable"
else
    bad "F1 graph convergence closed before asynchronous materialisation"
fi

# ── G. a valid satisfied fold remains durable for a later close ────────────
EP_FOLD=$(mk_task "$ROOT/dst" "Task: mixed materialised epic

Issue: #92
Type: epic")
publish_pending_epic "$ROOT/dst" 92 "$EP_FOLD"
CH_FOLD=$(mk_task "$ROOT/dst" "Task: remaining local child
Type: leaf" "$EP_FOLD")
(
    cd "$ROOT/dst" || exit 1
    printf '# folded child plan\n' > folded-plan.md
    git add folded-plan.md
    git commit -q -F - <<'EOF'
Declare a materialised child alongside local work

Materialise-Child-Epic: owner/src
Child-Epic-Title: Folded child
Child-Epic-Body-File: folded-plan.md
Parent-Issue: #92
EOF
    git push -q origin HEAD:master
    git fetch -q origin '+refs/heads/master:refs/remotes/origin/master'
)
MARKER=$(git -C "$ROOT/dst" commit-tree "$EMPTY_TREE" -m "kind: gh-child-epic-marker
role: system

parent_issue: 92
peer:
  repo: owner/src
  issue: 99
materialised_by_commit: fixture
materialised_at: 2026-07-10T00:00:00Z")
DELEGATED=$(git -C "$ROOT/dst" commit-tree "$EMPTY_TREE" -p "$EP_FOLD" -m "kind: delegated
role: system
intent: delegated-child

issue:
  repo: owner/dst
  number: 92

delegated:
  repo: owner/src
  number: 99")
git -C "$ROOT/dst" push -q origin \
    "$MARKER:refs/heads/gh/child-epics/92/owner/src" \
    "$DELEGATED:refs/heads/tasks/delegated/92/owner/src/99"
NFOLD="task:owner/dst@$EP_FOLD"; NPEER="issue:owner/src#99"
EFOLD=$(edge_id "$ROOT/dst" "$NFOLD" "$NPEER" requires)
# Make owner/src#99 durably done so reconciliation folds its requires edge.
SRC_TIP=$(git -C "$ROOT/src" rev-parse master)
SRC_TREE=$(git -C "$ROOT/src" rev-parse "$SRC_TIP^{tree}")
SRC_ROOT=$(mk_task "$ROOT/src" "Task: peer issue 99
Issue: #99
Type: epic")
SRC_CLOSE=$(git -C "$ROOT/src" commit-tree "$SRC_TREE" -p "$SRC_TIP" -p "$SRC_ROOT" -m "Close peer issue

Closes-Epic: #99")
git -C "$ROOT/src" update-ref refs/heads/master "$SRC_CLOSE"
git -C "$ROOT/src" push -q origin master:master
git -C "$ROOT/src" fetch -q origin '+refs/heads/master:refs/remotes/origin/master'
if ( cd "$ROOT/dst" && "$TD" reconcile-backstop --no-fetch --no-mailbox >/dev/null 2>&1 ) \
    && edge_absent "$ROOT/dst" "$EFOLD" \
    && ! has_close_merge "$ROOT/dst" 92 "$EP_FOLD"; then
    ok "G1 satisfied materialised edge folds while another obligation remains"
else
    bad "G1 mixed-obligation setup did not fold safely"
fi
W_FOLD=$(complete_task "$ROOT/dst" "$CH_FOLD")
if ( cd "$ROOT/dst" && "$TD" graph-converge --range "$W_FOLD^..$W_FOLD" --no-fetch >/dev/null 2>&1 ) \
    && has_close_merge "$ROOT/dst" 92 "$EP_FOLD"; then
    ok "G2 validated fold history permits close after the remaining obligation completes"
else
    bad "G2 folded materialisation state permanently wedged epic closure"
fi

# ── H. empty-obligations epic never auto-closes ────────────────────────────
EPE=$(mk_task "$ROOT/dst" "Task: empty epic

Issue: #90
Type: epic")
publish_pending_epic "$ROOT/dst" 90 "$EPE"
if ( cd "$ROOT/dst" && "$TD" reconcile-backstop --no-fetch --no-mailbox >/dev/null 2>&1 ) \
    && ! has_close_merge "$ROOT/dst" 90 "$EPE"; then
    ok "H1 empty-obligations epic does not auto-close"
else
    bad "H1 empty-obligations epic was incorrectly closed"
fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
