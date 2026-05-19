#!/usr/bin/env bash
# run-turn.sh -- drive the gads analysis loop forward one turn.
#
# This is the operator-facing entry point for the workflow that issue
# #11 comment 4467152007 asks for: take a fresh Ads Editor CSV export
# of the current gads state, fold it into the live snapshot, rebuild
# the visualizer with a freshly numbered import bundle, publish the
# updated page through the oauth-proxied mss-one-offs host, and print
# a loud completion URL so the operator gets "paged" the moment the
# next bundle is ready to download and re-import.
#
# Each invocation bumps the persistent global turn counter at
# ads/google/snapshots/.turn-counter, so successive bundles are
# globally sequentially numbered (turn-001, turn-002, ...) and the
# Ads Editor import history makes it obvious which iteration of the
# crisis-mitigation loop produced which set of changes.
#
# Usage:
#   ads/google/scripts/run-turn.sh <ads-editor-csv-export>
#
# Example:
#   ads/google/scripts/run-turn.sh ~/Downloads/google-ads-export.csv
#
# What it does:
#   1. Run convert-csv-to-snapshot.py on the uploaded CSV to refresh
#      ads/google/snapshots/ads-snapshot-live.jsonl.
#   2. Run build-experiments-viz.py with --bump-turn so the turn
#      counter increments and the page + bundle reflect the new turn.
#   3. Upload the rebuilt HTML to mss-one-offs (24h TTL) via
#      scripts/upload-to-mss.
#   4. Print the public URL (this is the "page me upon completion"
#      hook -- the operator copies the URL on their phone / desktop
#      and immediately clicks "Download CSV bundle").

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <ads-editor-csv-export>" >&2
  exit 1
fi

INPUT_CSV="$1"
if [[ ! -f "${INPUT_CSV}" ]]; then
  echo "Error: input CSV not found: ${INPUT_CSV}" >&2
  exit 1
fi

# Repo paths are derived from the script's own location so this works
# both from the shared ~/src/automation checkout and from an ephemeral
# git worktree.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GADS_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${GADS_ROOT}/../.." && pwd)"
SNAPSHOT_JSONL="${GADS_ROOT}/snapshots/ads-snapshot-live.jsonl"
VIZ_HTML="${GADS_ROOT}/outputs/experiments-viz.html"

echo "▶ Step 1/3: convert CSV → snapshot.jsonl"
python3 "${SCRIPT_DIR}/convert-csv-to-snapshot.py" \
  "${INPUT_CSV}" \
  "${SNAPSHOT_JSONL}"

echo ""
echo "▶ Step 2/3: rebuild visualizer (bumping global turn counter)"
python3 "${SCRIPT_DIR}/build-experiments-viz.py" \
  --output "${VIZ_HTML}" \
  --bump-turn

TURN=$(cat "${GADS_ROOT}/snapshots/.turn-counter" 2>/dev/null || echo "?")
TURN_PADDED=$(printf '%03d' "${TURN}" 2>/dev/null || echo "${TURN}")

echo ""
echo "▶ Step 3/3: publish to mss-one-offs"
UPLOAD_OUTPUT=$("${REPO_ROOT}/scripts/upload-to-mss" \
  "${VIZ_HTML}" \
  "gads-experiments turn-${TURN_PADDED} (issue #11)" \
  86400)
echo "${UPLOAD_OUTPUT}"

URL=$(echo "${UPLOAD_OUTPUT}" | awk '/^URL: /{print $2; exit}')

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "📟 PAGE: gads turn-${TURN_PADDED} ready to download + import"
echo "════════════════════════════════════════════════════════════════"
if [[ -n "${URL}" ]]; then
  echo "   ${URL}"
else
  echo "   (upload-to-mss did not emit a URL line -- check output above)"
fi
echo "════════════════════════════════════════════════════════════════"
