#!/usr/bin/env bash
# Tests for materialise-child-epics.sh.
#
# 1. Pure helper unit tests. Sourced-library mode (MATERIALISE_LIB_ONLY=1)
#    defines the helper functions without requiring the workflow env vars or
#    running the main scan, so we can assert on marker_ref_for + valid_slug
#    directly — including the slug path and a non-top-level source scenario.
# 2. An integration section that runs the whole script (non-lib mode) against
#    a throwaway git repo with a NON-top-level source repo (GH_REPO), proving
#    the generalised SOURCE_TOKEN env (and its legacy TOP_LEVEL_TOKEN alias)
#    is honoured and required. No network: the empty commit range makes the
#    scan a no-op, so no App token is ever minted.
#
# Run: bash .github/scripts/materialise-child-epics.test.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
MATERIALISE_LIB_ONLY=1 source "$HERE/materialise-child-epics.sh"

fail=0
check() {
    local desc="$1" got="$2" want="$3"
    if [ "$got" = "$want" ]; then
        echo "ok  - $desc"
    else
        echo "NOT OK - $desc"
        echo "        got:  $got"
        echo "        want: $want"
        fail=1
    fi
}
check_valid() {
    local slug="$1" want="$2" # want = ok|bad
    local got=ok
    valid_slug "$slug" || got=bad
    check "valid_slug('$slug') = $want" "$got" "$want"
}

# --- marker_ref_for -------------------------------------------------------

# No slug: legacy default-slot namespace, byte-for-byte the historical ref.
check "no-slug uses legacy child-epics namespace" \
    "$(marker_ref_for 34 Nicponskis github-worker '')" \
    "refs/heads/gh/child-epics/34/Nicponskis/github-worker"

# With slug: separate child-epic-slots namespace (avoids git D/F conflict).
check "slug uses child-epic-slots namespace" \
    "$(marker_ref_for 34 Nicponskis github-worker p2)" \
    "refs/heads/gh/child-epic-slots/34/Nicponskis/github-worker/p2"

check "different slugs -> different refs (p3)" \
    "$(marker_ref_for 34 Nicponskis github-worker p3)" \
    "refs/heads/gh/child-epic-slots/34/Nicponskis/github-worker/p3"

# The legacy ref and any slot ref never share a path prefix that would
# trigger a git directory/file ref conflict.
legacy="$(marker_ref_for 34 Nicponskis github-worker '')"
slot="$(marker_ref_for 34 Nicponskis github-worker p2)"
if [ "${slot#"$legacy"/}" != "$slot" ]; then
    echo "NOT OK - slot ref must NOT be nested under the legacy ref (D/F conflict)"
    fail=1
else
    echo "ok  - slot ref is not nested under the legacy ref"
fi

# --- valid_slug -----------------------------------------------------------

check_valid ""          ok    # empty = default slot
check_valid "p2"        ok
check_valid "base-prompt-capsule" ok
check_valid "a"         ok
check_valid "0"         ok
check_valid "-p2"       bad   # must start alnum
check_valid "P2"        bad   # no uppercase
check_valid "p2/x"      bad   # no slash
check_valid "p2.x"      bad   # no dot (blocks .lock / .. hazards)
check_valid "p2 x"      bad   # no space
check_valid "$(printf 'a%.0s' {1..65})" bad # >64 chars
check_valid "$(printf 'a%.0s' {1..64})" ok  # exactly 64 chars

# --- non-top-level source repo (marker refs are source-independent) -------

# The engine is fleet-wide: a peer-originated epic (e.g. the automation#57
# scenario) mints marker refs keyed by (parent issue, PEER repo) and are
# INDEPENDENT of which source repo carried the trailer. Exercise a slug
# group targeting a FreshlyBakedNYC peer to prove the ref shape holds for a
# non-top-level source.
check "non-top-level source: slugged automation peer ref" \
    "$(marker_ref_for 57 FreshlyBakedNYC automation waste-backlog)" \
    "refs/heads/gh/child-epic-slots/57/FreshlyBakedNYC/automation/waste-backlog"

# --- integration: SOURCE_TOKEN generalisation + non-top-level GH_REPO -----

# Run the whole script (non-lib mode) with a NON-top-level source repo. The
# empty commit range (BEFORE == AFTER) makes the scan a no-op, so it never
# needs the network or the App key beyond the required-env checks — we are
# asserting the generalised token env resolution, not materialisation.
INT_REPO="$(mktemp -d)"
(
    cd "$INT_REPO"
    git init -q
    git config user.email t@t; git config user.name t
    git commit -q --allow-empty -m seed
) >/dev/null 2>&1
INT_SHA="$(git -C "$INT_REPO" rev-parse HEAD)"

run_script() {
    # Runs the script in the temp repo with the given token env; TASK_DAG is
    # stubbed to /bin/true so no clone happens (unreachable on the no-op path
    # anyway). Returns the script's exit code.
    (
        cd "$INT_REPO"
        env -i PATH="$PATH" HOME="$HOME" \
            BEFORE_SHA="$INT_SHA" AFTER_SHA="$INT_SHA" \
            GH_REPO="FreshlyBakedNYC/automation" \
            APP_ID=1 APP_PRIVATE_KEY=stub TASK_DAG=/bin/true \
            "$@" \
            bash "$HERE/materialise-child-epics.sh"
    ) >/dev/null 2>&1
}

if run_script SOURCE_TOKEN=stub-token; then
    echo "ok  - non-top-level source: SOURCE_TOKEN accepted (no-op scan)"
else
    echo "NOT OK - SOURCE_TOKEN should be accepted for a non-top-level source"
    fail=1
fi

if run_script TOP_LEVEL_TOKEN=stub-token; then
    echo "ok  - legacy TOP_LEVEL_TOKEN alias still honoured"
else
    echo "NOT OK - legacy TOP_LEVEL_TOKEN alias must still be honoured"
    fail=1
fi

if run_script; then
    echo "NOT OK - script must fail when neither SOURCE_TOKEN nor TOP_LEVEL_TOKEN is set"
    fail=1
else
    echo "ok  - missing SOURCE_TOKEN/TOP_LEVEL_TOKEN fails closed"
fi

rm -rf "$INT_REPO"

if [ "$fail" -ne 0 ]; then
    echo "FAILED"
    exit 1
fi
echo "ALL PASS"
