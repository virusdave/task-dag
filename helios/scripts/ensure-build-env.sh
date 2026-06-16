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
#      `npm ci`) — see .gitignore — so we mirror that here. `npm install`
#      also transparently replaces the tracked (possibly dangling)
#      node_modules symlink with a real directory.
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
elif [ package.json -nt node_modules/.package-lock.json ]; then
  # package.json changed since the last resolved install.
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
