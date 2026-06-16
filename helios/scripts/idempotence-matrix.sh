#!/usr/bin/env bash
# Build-idempotence matrix for Helios (automation#50 H3).
#
# Proves the build is reproducible and `ensure-build-env` is idempotent
# across the artifact states that bite in practice: cold checkout, warm
# node_modules, stale dist, and a post-`git clean -xfd` checkout — running
# the verification command TWICE each time it matters so a non-idempotent
# step (one that only succeeds the first run, or only on a dirty tree)
# can't sneak back in.
#
# This is a heavy nightly/manual gate, NOT part of the default `vitest`
# suite. It works in a throwaway local clone, so it never disturbs your
# working tree (it runs `git clean -xfd`, which would nuke node_modules /
# dist in place). Run it under the shared large-action-lock:
#
#   large-action-lock -- bash scripts/idempotence-matrix.sh
#
# The verification command defaults to the full `npm run check`. Override
# it for a faster smoke of the harness itself:
#
#   IDEMPOTENCE_VERIFY='npm run typecheck' bash scripts/idempotence-matrix.sh

set -euo pipefail

VERIFY="${IDEMPOTENCE_VERIFY:-npm run check}"

helios_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(git -C "$helios_dir" rev-parse --show-toplevel)"
rev="$(git -C "$repo_root" rev-parse HEAD)"

work="$(mktemp -d "${TMPDIR:-/tmp}/helios-idempotence.XXXXXX")"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

echo "[idempotence] cloning $repo_root @ ${rev:0:12} → $work/clone"
git clone -q "$repo_root" "$work/clone"
git -C "$work/clone" checkout -q "$rev"
helios="$work/clone/helios"
cd "$helios"

run_verify() {
  local label="$1"
  echo ""
  echo "==> [idempotence] $label: $VERIFY"
  if ! ( eval "$VERIFY" ); then
    echo "[idempotence] FAIL at: $label" >&2
    exit 1
  fi
}

# Scenario 1 — COLD: no node_modules, no dist. ensure-build-env (invoked
# by check/build via prebuild/pretest, or directly) must bootstrap both.
echo ""
echo "==> [idempotence] scenario 1/4: COLD checkout"
rm -rf node_modules dist
run_verify "cold (1st run)"

# Scenario 2 — WARM: node_modules + dist now exist; rerun must be a no-op
# w.r.t. install and still pass.
echo ""
echo "==> [idempotence] scenario 2/4: WARM (node_modules + dist present)"
run_verify "warm (2nd run)"

# Scenario 3 — STALE dist: leave the previous dist in place but touch it
# so output dirs already exist; the build must not fail on present dirs.
echo ""
echo "==> [idempotence] scenario 3/4: STALE dist present"
mkdir -p dist/server dist/client
: > dist/.stale-marker
run_verify "stale-dist"

# Scenario 4 — POST git clean -xfd: nuke every untracked/ignored artifact
# and confirm two consecutive clean rebuilds both pass. NOTE: helios/
# node_modules is a *tracked* symlink, so `git clean -xfd` alone leaves it
# in place; we additionally rm -rf node_modules + dist so this genuinely
# exercises a from-scratch reinstall + double rebuild.
echo ""
echo "==> [idempotence] scenario 4/4: post git clean -xfd, run twice"
git -C "$work/clone" clean -xfd >/dev/null
rm -rf node_modules dist
run_verify "post-clean (1st run)"
run_verify "post-clean (2nd run)"

echo ""
echo "[idempotence] OK — all 4 scenarios reproducible (verify: $VERIFY)"
