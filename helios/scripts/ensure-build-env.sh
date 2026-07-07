#!/usr/bin/env bash
# Idempotent build-prerequisite step for Helios (automation#50 H3).
#
# Safe to run cold (fresh checkout) or warm (node_modules / dist already
# present); it never assumes — and never fails merely because — an
# artifact already exists. `build` and `test` call it first (via the
# prebuild/pretest lifecycle hooks) and `check` calls it explicitly, so a
# build step can no longer fail on a missing dependency or output dir.
#
# Responsibilities:
#   1. Populate node_modules when it is absent or stale, using the on-box
#      ~/.npm cache (npm's default). Helios deliberately does NOT track a
#      package-lock.json, and the host deploy uses `npm install` (not
#      `npm ci`) — see .gitignore — so we mirror that here. When node_modules
#      is missing, a DANGLING symlink, or a partial install, `npm install`
#      transparently replaces it with a real directory. When it is a
#      resolvable, POPULATED symlink into the shared tree (the tracked
#      helios/node_modules symlink), we deliberately leave it intact and do
#      NOT reinstall on the package.json-mtime heuristic — otherwise every
#      fresh ephemeral checkout would materialize the symlink into a real
#      dir (automation#63); see the guard below.
#   2. mkdir -p every output dir the build / asset-copy steps assume, so
#      no later step trips on a missing-or-already-present dir. (mkdir -p
#      is itself idempotent.)

set -euo pipefail

# helios/ — parent of this scripts/ dir.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

needs_install=0
if [ ! -d node_modules ] || [ ! -x node_modules/.bin/tsc ]; then
  # Absent, or a dangling symlink, or a partial install missing binaries.
  needs_install=1
elif [ -L node_modules ]; then
  # node_modules is a resolvable, populated symlink into the shared tree
  # (the tracked helios/node_modules symlink). Do NOT reinstall on the
  # package.json-mtime heuristic below: a fresh ephemeral checkout rewrites
  # package.json's mtime to "now", which is always newer than the shared
  # tree's node_modules/.package-lock.json, so the `-nt` test would fire on
  # EVERY fresh checkout and `npm install` would replace the symlink with a
  # real directory — surfacing as `D helios/node_modules` in git status that
  # has to be manually restored before every commit/push (automation#63).
  # The shared tree is managed out-of-band (its own `npm install`); trust it
  # here and leave the symlink intact rather than materializing it.
  echo "[ensure-build-env] node_modules is a populated symlink into the shared tree; leaving it intact"
  needs_install=0
elif [ package.json -nt node_modules/.package-lock.json ]; then
  # Real node_modules directory whose install predates a package.json edit.
  needs_install=1
fi

if [ "$needs_install" = "1" ]; then
  echo "[ensure-build-env] installing dependencies (npm install)…"
  npm install --no-audit --no-fund
else
  echo "[ensure-build-env] node_modules present and current; skipping install"
fi

# Generalised output-dir creation. build:server copies a non-TS stub into
# dist/server/worker/scheduling and the tsc/vite outputs land in
# dist/server and dist/client respectively.
mkdir -p \
  dist/server \
  dist/server/worker/scheduling \
  dist/client

echo "[ensure-build-env] OK"
