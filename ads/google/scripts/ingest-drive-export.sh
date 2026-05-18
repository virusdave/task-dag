#!/usr/bin/env bash
# Ingest the latest Google Ads Editor export from Drive and re-deploy
# the experiments-viz page.
#
# Usage:
#   ads/google/scripts/ingest-drive-export.sh <drive-file-url-or-id>
#
# On success prints a single-line JSON object to stdout:
#   {"publicUrl":"...", "sourceFileId":"...", "snapshotPath":"...",
#    "outputPath":"..."}
# On failure exits non-zero with a human-readable message on stderr.
#
# We do NOT auto-pick "latest in folder" because we have no Drive
# folder-listing credential available. The Helios /ads page takes a
# pasted file URL/ID from the operator and forwards it here.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <drive-file-url-or-id>" >&2
  exit 2
fi

INPUT="$1"

# Resolve the script location so we can call sibling tools regardless
# of cwd (Helios will exec this from its own working directory).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

# Use per-user, per-invocation temp files so concurrent runs by
# different system users (helios from the UI, amp-local from ssh,
# the gads cron job) can never collide on /tmp file ownership.
# Previously we hard-coded /tmp/google-ads-export-utf8.csv and
# /tmp/ads-google-ingest.lock; the first writer's uid claimed
# them forever (sticky-bit /tmp), so the next user got EACCES
# from curl -o and the Helios UI returned 502.
TMP_ROOT="${TMPDIR:-/tmp}/gads-ingest-$(id -u)"
mkdir -p "${TMP_ROOT}"
chmod 700 "${TMP_ROOT}"
CSV_PATH="$(mktemp "${TMP_ROOT}/google-ads-export-XXXXXX.csv")"
SNAPSHOT_PATH="${REPO_ROOT}/ads/google/snapshots/ads-snapshot-live.jsonl"
HTML_PATH="${REPO_ROOT}/ads/google/outputs/experiments-viz.html"
# Per-user lock. We accept that two different system users could
# in theory ingest concurrently; in practice 100% of operator
# traffic goes through helios, so this is a non-issue. The
# critical thing is that the lock can never be 'stolen' by an
# earlier user and cause EACCES for everyone else.
LOCK_PATH="${TMP_ROOT}/ingest.lock"

# Always clean up the per-invocation CSV on exit so we don't leak
# multi-MB files into /tmp/gads-ingest-<uid>/ on every run.
cleanup() { rm -f "${CSV_PATH}"; }
trap cleanup EXIT

# --- Parse Drive file ID + optional resource key from URL or raw ID ---------
# Accepts:
#   https://drive.google.com/file/d/<ID>/view?usp=sharing
#   https://drive.google.com/open?id=<ID>
#   https://drive.usercontent.google.com/download?id=<ID>&...
#   <ID>   (raw)
# Plus an optional resourcekey=<KEY> querystring param (some link-shared
# folders require it on every file fetch).
FILE_ID=""
RESOURCE_KEY=""
if [[ "${INPUT}" =~ /file/d/([A-Za-z0-9_-]+) ]]; then
  FILE_ID="${BASH_REMATCH[1]}"
elif [[ "${INPUT}" =~ [?\&]id=([A-Za-z0-9_-]+) ]]; then
  FILE_ID="${BASH_REMATCH[1]}"
elif [[ "${INPUT}" =~ ^[A-Za-z0-9_-]{20,}$ ]]; then
  FILE_ID="${INPUT}"
else
  echo "Could not parse a Drive file ID from: ${INPUT}" >&2
  echo "Expected a /file/d/<ID> URL, an ?id=<ID> URL, or the raw ID." >&2
  exit 3
fi
if [[ "${INPUT}" =~ [?\&]resourcekey=([A-Za-z0-9_-]+) ]]; then
  RESOURCE_KEY="${BASH_REMATCH[1]}"
fi

# Single-flight: prevent two clicks from clobbering shared paths.
exec 9>"${LOCK_PATH}"
if ! flock -n 9; then
  echo "Another ingestion is already running (lock: ${LOCK_PATH})" >&2
  exit 4
fi

# --- Download the file -------------------------------------------------------
# `usercontent.google.com/download` with `confirm=t` works for public
# files without a token. `-fsSL` aborts on HTTP error and follows
# redirects silently.
DRIVE_URL="https://drive.usercontent.google.com/download?id=${FILE_ID}&export=download&confirm=t"
if [[ -n "${RESOURCE_KEY}" ]]; then
  DRIVE_URL="${DRIVE_URL}&resourcekey=${RESOURCE_KEY}"
fi
DRIVE_REFERER="${GOOGLE_DRIVE_REFERER:-https://vpn-helios.freshlybaked.us/ads}"
if ! curl -fsSL --referer "${DRIVE_REFERER}" -o "${CSV_PATH}" "${DRIVE_URL}"; then
  echo "Failed to download Drive file id=${FILE_ID}" >&2
  echo "Make sure the file is shared 'Anyone with the link can view'." >&2
  exit 5
fi

# Guardrail: detect when Drive returned an HTML interstitial (e.g.
# permission denied or virus-scan page) instead of the CSV.
FIRST_BYTES="$(head -c 200 "${CSV_PATH}" 2>/dev/null || true)"
if [[ "${FIRST_BYTES}" == "<!DOCTYPE html"* ]] \
   || [[ "${FIRST_BYTES}" == "<html"* ]] \
   || [[ "${FIRST_BYTES}" == *"<title>Google Drive"* ]]; then
  echo "Drive returned HTML, not a CSV. The file may be private or" >&2
  echo "may be a native Google Sheet rather than an uploaded CSV." >&2
  exit 6
fi

# --- Run the pipeline --------------------------------------------------------
python3 "${REPO_ROOT}/ads/google/scripts/convert-csv-to-snapshot.py" \
  "${CSV_PATH}" "${SNAPSHOT_PATH}" >&2

python3 "${REPO_ROOT}/ads/google/scripts/build-experiments-viz.py" \
  --output "${HTML_PATH}" >&2

# upload-to-mss prints multi-line human-readable output; grep the URL.
UPLOAD_OUT="$("${REPO_ROOT}/scripts/upload-to-mss" \
  "${HTML_PATH}" "helios ads ingest" 86400)"
echo "${UPLOAD_OUT}" >&2

PUBLIC_URL="$(echo "${UPLOAD_OUT}" | grep -Eo 'https://[^ ]+' | head -1)"
if [[ -z "${PUBLIC_URL}" ]]; then
  echo "Upload completed but no public URL parsed from upload-to-mss output." >&2
  exit 7
fi

# --- Emit machine-readable result on stdout ----------------------------------
# Use python for safe JSON encoding (avoids quoting pitfalls).
python3 - "${PUBLIC_URL}" "${FILE_ID}" "${SNAPSHOT_PATH}" "${HTML_PATH}" <<'PY'
import json, sys
url, file_id, snap, html = sys.argv[1:5]
print(json.dumps({
    "publicUrl": url,
    "sourceFileId": file_id,
    "snapshotPath": snap,
    "outputPath": html,
}))
PY
