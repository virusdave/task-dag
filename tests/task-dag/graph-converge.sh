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

edge_id() { ( cd "$1" && "$TD" dep add --from "$2" --to "$3" --relation "$4" --repo-id 101 --witness w >/dev/null && "$TD" dep add --from "$2" --to "$3" --relation "$4" --repo-id 101 --witness w >/dev/null 2>&1 || true && "$TD" edges --json --no-fetch | jq -r --arg f "$2" --arg t "$3" --arg r "$4" '.[] | select(.from==$f and .to==$t and .relation==$r) | .edgeId' ); }
edge_absent() { ! git -C "$1" cat-file -e "refs/heads/tasks/v1/graph:edges/$2.json" 2>/dev/null; }

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

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
