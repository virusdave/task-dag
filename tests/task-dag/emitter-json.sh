#!/usr/bin/env bash
# Fixture test for the `--json` RESULT emitters of the claim / release /
# claim-root / release-root / reap commands, which were converted from
# hand-built `echo "{…}"` / `printf '{…}'` / `cat <<JSON` string
# interpolation to proper `jq -nc` serialization (issue #10).
#
# Two failure classes are guarded:
#   1. GOLDEN byte-identity — for safe representative inputs the new jq
#      emitters must produce the exact same bytes the raw emitters did
#      (the dispatcher + golden fixtures depend on the exact keys/values).
#   2. ADVERSARIAL escaping — a claim whose UNTRUSTED metadata (claimer,
#      host, claimed-at, read verbatim out of the commit body) contains
#      double-quotes / backslashes must NOT break `already-claimed --json`;
#      it must stay valid JSON and round-trip the value verbatim. A
#      malformed numeric field (Claimer-PID: abc) must degrade to a bare
#      JSON `null`, never an unquoted `abc` that makes the whole object
#      invalid (the exact "invalid JSON -> dispatcher skips the repo"
#      outage the json_* helpers exist to prevent).
set -uo pipefail

TD="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)/task-dag}"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok(){ echo "PASS: $1"; PASS=$((PASS+1)); }
bad(){ echo "FAIL: $1"; FAIL=$((FAIL+1)); }

command -v jq >/dev/null 2>&1 || { echo "jq is required for this test"; echo "PASS=0 FAIL=1"; exit 1; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export TASK_DAG_GIT_NAME=t TASK_DAG_GIT_EMAIL=t@t

git init -q --bare "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/wc"; cd "$ROOT/wc"
echo s>s; git add s; git commit -qm s; git push -q origin HEAD:master
EMPTY_TREE=$(git hash-object -t tree /dev/null)

EPIC=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m "Task: epic
Type: epic")
TASK=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p "$EPIC" -m "Task: do a thing
Type: task")
SHORT=$(git rev-parse --short "$TASK")

# ---------------------------------------------------------------------------
# TEST 1: `release --json` on a task with no active claim emits the exact
#         golden bytes (byte-identity for a safe representative input).
# ---------------------------------------------------------------------------
git update-ref "refs/heads/tasks/frontier/$SHORT" "$TASK"
git push -q origin "refs/heads/tasks/frontier/$SHORT"
out=$("$TD" release "$SHORT" --json 2>/dev/null || true)
want="{\"ok\":false,\"reason\":\"not-claimed\",\"sha\":\"$TASK\"}"
if [ "$out" = "$want" ]; then
    ok "1: release --json (not-claimed) is byte-identical golden output"
else
    bad "1: release --json golden mismatch: want=$want got=$out"
fi

# ---------------------------------------------------------------------------
# TEST 2: `claim-root --json` for an unknown issue emits the exact golden
#         bytes with `issue` as a bare NUMBER (not a quoted string).
# ---------------------------------------------------------------------------
out=$("$TD" claim-root 424242 --json 2>/dev/null || true)
want='{"ok":false,"reason":"no-pending-root","issue":424242}'
if [ "$out" = "$want" ]; then
    ok "2: claim-root --json (no-pending-root) is byte-identical golden output"
else
    bad "2: claim-root --json golden mismatch: want=$want got=$out"
fi
if echo "$out" | jq -e '.issue == 424242 and (.issue | type) == "number"' >/dev/null 2>&1; then
    ok "2b: claim-root --json issue is a bare JSON number"
else
    bad "2b: claim-root --json issue was not a bare number ($out)"
fi

# ---------------------------------------------------------------------------
# Build an active claim commit by hand whose UNTRUSTED metadata is hostile:
# the claimer/host/claimed-at contain double-quotes and backslashes, and the
# Claimer-PID is non-numeric. This is exactly what a raw `echo "{…"$claimer"…}"`
# emitter would turn into invalid JSON.
# ---------------------------------------------------------------------------
HOSTILE_CLAIMER='ev"il\name'
HOSTILE_HOST='ho"st\1'
HOSTILE_WHEN='2026-01-01T00:00:00Z"'
ACTIVE=$(git commit-tree "$EMPTY_TREE" -p "$TASK" -m "Claim: hostile

Task-Commit: $TASK
Claimer: $HOSTILE_CLAIMER
Claimer-Host: $HOSTILE_HOST
Claimer-PID: abc
Claimed-At: $HOSTILE_WHEN
TTL-Hours: 12")
# Publish as the active claim and drop the frontier ref, so a DIFFERENT
# worker hits the `already-claimed` --json branch.
git update-ref "refs/heads/tasks/active/$SHORT" "$ACTIVE"
git update-ref -d "refs/heads/tasks/frontier/$SHORT"
git push -q origin "refs/heads/tasks/active/$SHORT" ":refs/heads/tasks/frontier/$SHORT"

# ---------------------------------------------------------------------------
# TEST 3: a DIFFERENT worker's `claim --json` returns already-claimed JSON
#         that (a) still parses, (b) round-trips the hostile claimer/host/
#         claimedAt verbatim, and (c) degrades the malformed pid to null.
# ---------------------------------------------------------------------------
J=$(TASK_DAG_CLAIMER=other TASK_DAG_CLAIMER_HOST=otherhost TASK_DAG_CLAIMER_PID=999 \
      "$TD" claim "$SHORT" --json 2>/dev/null || true)
if echo "$J" | jq -e . >/dev/null 2>&1; then
    ok "3: already-claimed --json with hostile metadata is valid JSON"
else
    bad "3: already-claimed --json broke on hostile metadata: $J"
fi
if [ "$(echo "$J" | jq -r '.reason')" = "already-claimed" ]; then
    ok "3b: reason is already-claimed"
else
    bad "3b: unexpected reason ($J)"
fi
GOT_CLAIMER=$(echo "$J" | jq -r '.claimer' 2>/dev/null)
if [ "$GOT_CLAIMER" = "$HOSTILE_CLAIMER" ]; then
    ok "3c: hostile claimer round-trips verbatim"
else
    bad "3c: claimer did not round-trip (want '$HOSTILE_CLAIMER' got '$GOT_CLAIMER')"
fi
GOT_HOST=$(echo "$J" | jq -r '.claimerHost' 2>/dev/null)
if [ "$GOT_HOST" = "$HOSTILE_HOST" ]; then
    ok "3d: hostile host round-trips verbatim"
else
    bad "3d: host did not round-trip (want '$HOSTILE_HOST' got '$GOT_HOST')"
fi
GOT_WHEN=$(echo "$J" | jq -r '.claimedAt' 2>/dev/null)
if [ "$GOT_WHEN" = "$HOSTILE_WHEN" ]; then
    ok "3e: hostile claimedAt round-trips verbatim"
else
    bad "3e: claimedAt did not round-trip (want '$HOSTILE_WHEN' got '$GOT_WHEN')"
fi
if echo "$J" | jq -e '.claimerPid == null' >/dev/null 2>&1; then
    ok "3f: malformed Claimer-PID degrades to bare JSON null"
else
    bad "3f: malformed pid did not become null ($J)"
fi

# ---------------------------------------------------------------------------
# TEST 4: `reap --json` emits a valid JSON array; a reaped entry carries a
#         string deadReason and a boolean reclaimed. The active claim above
#         is dead (Claimer-PID non-numeric AND TTL long past), so it is
#         reaped. This exercises the reap add_reap_entry jq emitter.
# ---------------------------------------------------------------------------
R=$("$TD" reap --json 2>/dev/null || true)
if echo "$R" | jq -e 'type == "array"' >/dev/null 2>&1; then
    ok "4: reap --json is a valid JSON array"
else
    bad "4: reap --json is not a valid array: $R"
fi
if echo "$R" | jq -e 'all(.[]; (.deadReason | type) == "string" and (.reclaimed | type) == "boolean")' >/dev/null 2>&1; then
    ok "4b: reap entries have string deadReason and boolean reclaimed"
else
    bad "4b: reap entry field types wrong: $R"
fi

echo "-----"; echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
