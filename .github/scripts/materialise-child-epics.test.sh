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

# --- extract_materialise_trailers_from_message (whole-message parser) ------
#
# The parser is the fix for virusdave/task-dag#11: it must recognise a
# Materialise-Child-Epic group ANYWHERE in the commit body, delimited only by
# the next opener or EOF — never dropped by an intervening blank line +
# unrelated trailer paragraph (the #44 regression). Feed a message on stdin
# and assert the normalised synthetic trailer stream it emits.
check_extract() {
    local desc="$1" msg="$2" want="$3"
    local got
    got="$(printf '%s' "$msg" | extract_materialise_trailers_from_message)"
    check "$desc" "$got" "$want"
}

# (a) group followed by a blank line + `Related:` (the #44 regression): the
#     old git-interpret-trailers pre-filter dropped this group entirely.
check_extract "a: group then blank line + Related: keeps the group" \
"$(printf 'Subject\n\nMaterialise-Child-Epic: o/r\nChild-Epic-Title: T\nChild-Epic-Body-File: b.md\nParent-Issue: #1\n\nRelated: #2\n')" \
"$(printf 'Materialise-Child-Epic: o/r\nChild-Epic-Title: T\nChild-Epic-Body-File: b.md\nParent-Issue: #1')"

# (b) group followed by an interleaved task-dag Status: block: none of the
#     task-dag control trailers are collected or terminate the group.
check_extract "b: group then task-dag Task-Commit/Issue/URL/Status block" \
"$(printf 'Materialise-Child-Epic: o/r\nChild-Epic-Title: T\nChild-Epic-Body-File: b.md\nParent-Issue: #1\n\nTask-Commit: abc123\nIssue: #9\nURL: https://x/y\nStatus: pending\n')" \
"$(printf 'Materialise-Child-Epic: o/r\nChild-Epic-Title: T\nChild-Epic-Body-File: b.md\nParent-Issue: #1')"

# (c) multiple groups separated by blank lines / unrelated trailers.
check_extract "c: multiple groups split by blank lines + Related:" \
"$(printf 'Materialise-Child-Epic: o/r1\nChild-Epic-Title: T1\nChild-Epic-Body-File: b1.md\nParent-Issue: #1\n\nRelated: #99\n\nMaterialise-Child-Epic: o/r2\nChild-Epic-Title: T2\nChild-Epic-Body-File: b2.md\nParent-Issue: #2\n')" \
"$(printf 'Materialise-Child-Epic: o/r1\nChild-Epic-Title: T1\nChild-Epic-Body-File: b1.md\nParent-Issue: #1\nMaterialise-Child-Epic: o/r2\nChild-Epic-Title: T2\nChild-Epic-Body-File: b2.md\nParent-Issue: #2')"

# (d) plain contiguous trailer block (regression: unchanged behaviour).
check_extract "d: plain contiguous block still parses" \
"$(printf 'Materialise-Child-Epic: o/r\nChild-Epic-Title: T\nChild-Epic-Body-File: b.md\nParent-Issue: #1\n')" \
"$(printf 'Materialise-Child-Epic: o/r\nChild-Epic-Title: T\nChild-Epic-Body-File: b.md\nParent-Issue: #1')"

# (e) a blank line INSIDE a group is accepted (group stays open).
check_extract "e: blank line inside a group does not close it" \
"$(printf 'Materialise-Child-Epic: o/r\nChild-Epic-Title: T\n\nChild-Epic-Body-File: b.md\nParent-Issue: #1\n')" \
"$(printf 'Materialise-Child-Epic: o/r\nChild-Epic-Title: T\nChild-Epic-Body-File: b.md\nParent-Issue: #1')"

# (f) indented `Word: value` example lines do NOT open or feed a group.
check_extract "f: indented example lines never open a group" \
"$(printf 'See an example:\n    Materialise-Child-Epic: o/r\n    Child-Epic-Title: T\n')" \
""

# (g) a value containing a colon survives (split on the FIRST colon only).
check_extract "g: value with a later colon is preserved" \
"$(printf 'Materialise-Child-Epic: o/r\nChild-Epic-Title: RFC: parser fix\nChild-Epic-Body-File: b.md\nParent-Issue: #1\n')" \
"$(printf 'Materialise-Child-Epic: o/r\nChild-Epic-Title: RFC: parser fix\nChild-Epic-Body-File: b.md\nParent-Issue: #1')"

# extra: child-epic keys BEFORE the first opener are ignored.
check_extract "keys before the first opener are ignored" \
"$(printf 'Child-Epic-Title: orphan\nMaterialise-Child-Epic: o/r\nChild-Epic-Title: T\n')" \
"$(printf 'Materialise-Child-Epic: o/r\nChild-Epic-Title: T')"

# extra: `Word with: colon` is not a column-1 trailer key -> ignored.
check_extract "prose with an embedded colon is not a key" \
"$(printf 'Materialise-Child-Epic: o/r\nSome note with: a colon inside\nChild-Epic-Title: T\n')" \
"$(printf 'Materialise-Child-Epic: o/r\nChild-Epic-Title: T')"

# extra: a CRLF line ending has its trailing \r stripped.
check_extract "trailing CR (CRLF) is stripped" \
"$(printf 'Materialise-Child-Epic: o/r\r\nChild-Epic-Title: T\r\n')" \
"$(printf 'Materialise-Child-Epic: o/r\nChild-Epic-Title: T')"

# extra: a final line with no trailing newline is still parsed.
check_extract "final line with no trailing newline is parsed" \
"$(printf 'Materialise-Child-Epic: o/r\nChild-Epic-Title: T')" \
"$(printf 'Materialise-Child-Epic: o/r\nChild-Epic-Title: T')"

# extra: the Materialize (US spelling) opener is recognised too.
check_extract "US-spelling Materialize opener is recognised" \
"$(printf 'Materialize-Child-Epic: o/r\nChild-Epic-Title: T\n')" \
"$(printf 'Materialize-Child-Epic: o/r\nChild-Epic-Title: T')"

# extra: a message with no materialise opener at all emits nothing.
check_extract "no opener -> empty synthetic stream" \
"$(printf 'Subject\n\nRelated: #2\nStatus: pending\n')" \
""

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

# --- fail-loud integration (virusdave/task-dag#11) ------------------------
#
# An explicit Materialise-Child-Epic directive that produces zero successful
# materialisations must exit NON-ZERO, never a benign green no-op. These runs
# reach no network: validation / body-file failures happen before any App
# token is minted (TASK_DAG=/bin/true, and the temp repo has no `origin`, so
# marker_exists resolves to "not present" without a real remote).
run_script_over() {
    # $1=before $2=after. Captures combined stdout+stderr in the global
    # SCRIPT_OUT; returns the script's exit code.
    local before="$1" after="$2" rc=0
    SCRIPT_OUT="$(
        cd "$INT_REPO"
        env -i PATH="$PATH" HOME="$HOME" \
            BEFORE_SHA="$before" AFTER_SHA="$after" \
            GH_REPO="FreshlyBakedNYC/automation" \
            SOURCE_TOKEN=stub-token \
            APP_ID=1 APP_PRIVATE_KEY=stub TASK_DAG=/bin/true \
            bash "$HERE/materialise-child-epics.sh" 2>&1
    )" || rc=$?
    return "$rc"
}

# (h) A malformed explicit group (valid peer, but missing the required keys)
#     must fail loud, not report a benign no-op.
git -C "$INT_REPO" commit -q --allow-empty -F - <<'EOF'
Add a malformed materialise directive

Materialise-Child-Epic: some/peer
Delegation-Note: missing Title/Body-File/Parent on purpose
EOF
H_SHA="$(git -C "$INT_REPO" rev-parse HEAD)"
if run_script_over "$INT_SHA" "$H_SHA"; then
    echo "NOT OK - h: malformed explicit group must exit non-zero"
    fail=1
else
    echo "ok  - h: malformed explicit group exits non-zero"
fi
case "$SCRIPT_OUT" in
    *"No Materialise-Child-Epic trailers acted upon"*)
        echo "NOT OK - h: malformed group wrongly reported a benign no-op"
        fail=1 ;;
    *) echo "ok  - h: malformed group did not report a benign no-op" ;;
esac
case "$SCRIPT_OUT" in
    *"missing one of Child-Epic-Title"*)
        echo "ok  - h: reports the missing-required-keys ::error::" ;;
    *) echo "NOT OK - h: expected a missing-required-keys ::error::"; fail=1 ;;
esac

# (#44 end-to-end) A well-formed group FOLLOWED by a blank line + Related:
#     must still be acted upon — the OLD git-interpret-trailers pre-filter
#     dropped it and exited green. We stop it at the body-file read (no
#     network); reaching that error proves the group was NOT dropped and the
#     step exits non-zero instead of a benign green no-op.
git -C "$INT_REPO" commit -q --allow-empty -F - <<'EOF'
Materialise then an unrelated trailer paragraph

Materialise-Child-Epic: some/peer
Child-Epic-Title: T
Child-Epic-Body-File: does-not-exist.md
Parent-Issue: #1

Related: #2
EOF
R_SHA="$(git -C "$INT_REPO" rev-parse HEAD)"
if run_script_over "$H_SHA" "$R_SHA"; then
    echo "NOT OK - #44: group before a trailing Related: block must not exit green"
    fail=1
else
    echo "ok  - #44: group before a trailing Related: block is still acted upon (non-zero)"
fi
case "$SCRIPT_OUT" in
    *"not present in that commit's tree"*)
        echo "ok  - #44: group reached materialisation (body-file check)" ;;
    *) echo "NOT OK - #44: group was dropped (never reached the body-file check)"; fail=1 ;;
esac

# (empty opener) An opener with no <owner/repo> value is a malformed group
#     (the cur_open sentinel): it must fail loud, not be silently dropped.
git -C "$INT_REPO" commit -q --allow-empty -F - <<'EOF'
An opener with an empty value

Materialise-Child-Epic:
Child-Epic-Title: T
EOF
E_SHA="$(git -C "$INT_REPO" rev-parse HEAD)"
if run_script_over "$R_SHA" "$E_SHA"; then
    echo "NOT OK - empty opener must exit non-zero"
    fail=1
else
    echo "ok  - empty opener exits non-zero"
fi
case "$SCRIPT_OUT" in
    *"opener has no <owner/repo> value"*)
        echo "ok  - empty opener reports the missing-value ::error::" ;;
    *) echo "NOT OK - empty opener: expected a missing-value ::error::"; fail=1 ;;
esac

rm -rf "$INT_REPO"

if [ "$fail" -ne 0 ]; then
    echo "FAILED"
    exit 1
fi
echo "ALL PASS"
