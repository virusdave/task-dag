#!/usr/bin/env bash
# Fixture tests for legacy dependency encoding migration into tasks/v1/graph.
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
EMPTY_TREE="4b825dc642cb6eb9a060e54bf8d69288fbee4904"

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"
cd "$ROOT/wc" || exit 1
echo seed > seed.txt; git add seed.txt; git commit -qm seed; git push -q origin HEAD:master
git config taskdag.current-repo owner/repo
git config taskdag.owner/repo.id 4242

mk_task() { # <subject> [parents...]
    local subject="$1"; shift
    local args=() p sha
    for p in "$@"; do args+=( -p "$p" ); done
    if [ "${#args[@]}" -eq 0 ]; then args=( -p "$(git rev-parse HEAD)" ); fi
    sha=$(git commit-tree "$EMPTY_TREE" "${args[@]}" -m "$subject")
    printf '%s\n' "$sha"
}

P=$(mk_task "Task: parent")
D=$(mk_task "Task: dependency")
C=$(mk_task "Task: child" "$P" "$D")
short=$(git rev-parse --short "$C")
git update-ref "refs/heads/tasks/frontier/$short" "$C"

DELEG=$(git commit-tree "$EMPTY_TREE" -p "$P" -m "kind: delegated")
git update-ref refs/heads/tasks/delegated/9/Other/Peer/12 "$DELEG"

B=$(mk_task "Task: downstream blocked")
BM=$(git commit-tree "$EMPTY_TREE" -p "$B" -m "Blocked-Meta: $B

Blocker-Kind: downstream
Downstream-On: issue:owner/repo#77")
git update-ref "refs/heads/tasks/blocked/$B" "$B"
git update-ref "refs/heads/tasks/blocked-meta/$B" "$BM"

S=$(git commit-tree "$EMPTY_TREE" -p "$P" -m "Task: old scope

Superseded-By: issue:owner/repo#88")
git update-ref "refs/heads/tasks/frontier/$(git rev-parse --short "$S")" "$S"

dry=$("$TD" migrate-legacy-edges --dry-run --json --no-fetch 2>/dev/null)
if printf '%s' "$dry" | jq -e --arg c "task:owner/repo@$C" --arg d "task:owner/repo@$D" \
    'any(.[]; .from==$c and .to==$d and .relation=="requires" and (.legacySource | startswith("legacy-extra-parent:")))' >/dev/null; then
    ok "A1 dry-run reports legacy extra-parent requires edge"
else
    bad "A1 dry-run missed extra-parent edge: $dry"
fi
if printf '%s' "$dry" | jq -e --arg p "task:owner/repo@$P" \
    'any(.[]; .from==$p and .to=="issue:other/peer#12" and .relation=="requires" and (.legacySource | startswith("legacy-delegated:")))' >/dev/null; then
    ok "A2 dry-run reports delegated requires edge"
else
    bad "A2 dry-run missed delegated edge: $dry"
fi
if printf '%s' "$dry" | jq -e --arg b "task:owner/repo@$B" \
    'any(.[]; .from==$b and .to=="issue:owner/repo#77" and .relation=="requires" and .legacySource=="legacy-downstream-block")' >/dev/null; then
    ok "A3 dry-run reports explicit downstream block edge"
else
    bad "A3 dry-run missed downstream edge: $dry"
fi
if printf '%s' "$dry" | jq -e --arg s "task:owner/repo@$S" \
    'any(.[]; .from==$s and .to=="issue:owner/repo#88" and .relation=="satisfies" and .legacySource=="legacy-supersede-prose")' >/dev/null; then
    ok "A4 dry-run reports explicit supersede satisfies edge"
else
    bad "A4 dry-run missed supersede edge: $dry"
fi

if "$TD" migrate-legacy-edges --no-fetch >/dev/null 2>&1; then
    edges=$("$TD" edges --json --no-fetch)
    n=$(printf '%s' "$edges" | jq 'length')
    [ "$n" -ge 4 ] && ok "B1 migration writes legacy edges through graph writer" || bad "B1 wrote too few edges: $edges"
else
    bad "B1 migration command failed"
fi

tip_before=$(git rev-parse refs/heads/tasks/v1/graph)
"$TD" migrate-legacy-edges --no-fetch >/dev/null 2>&1
tip_after=$(git rev-parse refs/heads/tasks/v1/graph)
[ "$tip_before" = "$tip_after" ] && ok "B2 migration is idempotent by edge-id" || bad "B2 rerun changed graph tip"

if "$TD" validate --strict >/dev/null 2>&1; then
    ok "B3 validate --strict stays green after migration"
else
    bad "B3 validate --strict failed after migration"
fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
