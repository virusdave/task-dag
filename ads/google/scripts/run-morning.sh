#!/usr/bin/env bash
# run-morning.sh — one-shot driver for the "morning CSVs" workflow.
#
# What it does, end to end:
#   1. Pick the freshest snapshot under `ads/google/snapshots/`. The
#      canonical filename is `ads-snapshot-live.jsonl`, written by
#      `ingest-drive-export.sh` whenever the operator drops a fresh
#      Google Ads Editor export into Drive and points Helios at it.
#      (We do NOT call `helios-export-snapshot.ts` here — that script
#      is currently a stub that errors out; the real data source is
#      the Drive ingest path.)
#   2. Run the L1→L2 analysis against that snapshot, writing JSON +
#      per-step CSV batches + an HTML review packet to `outputs/prod/`.
#   3. Bundle today's run (JSON + CSVs + HTML packet + a short
#      README the operator can read on their phone) into a single
#      ZIP under `outputs/prod/bundle/`.
#   4. Upload the bundle to mss-one-offs (24 h TTL) and print a
#      single line of JSON to stdout with the public URL + paths.
#
# The bundle README surfaces the snapshot's age so the operator
# immediately sees whether they're looking at fresh recommendations
# or stale ones — if it's stale, the fix is to re-ingest from Drive
# via the Helios /ads page (or call ingest-drive-export.sh directly),
# then re-run this script.
#
# Designed to be safe to run on demand at any time of day — runs
# are namespaced by run-id and never overwrite each other. Re-running
# in the same hour produces a brand new bundle URL.
#
# Triggered automatically by the daily gads timer
# (gads-run-analysis.service from
# nixos-sbc/modules/google-ads-automation.nix); also runnable by hand:
#
#   ssh vps-nixos-3 \
#     /home/amp-local/src/automation/ads/google/scripts/run-morning.sh
#
# Outputs (on success):
#   {"runId":"...", "bundleUrl":"https://...",
#    "bundlePath":"/.../outputs/prod/bundle/run-<id>.zip",
#    "csvCount": N, "snapshotAgeHours": N.N, ...}

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
GADS_DIR="${REPO_ROOT}/ads/google"
SNAPSHOTS_DIR="${GADS_DIR}/snapshots"
PROD_DIR="${GADS_DIR}/outputs/prod"
BUNDLE_DIR="${PROD_DIR}/bundle"
# Per-user lock path: a shared /tmp file would be unwritable by the
# second uid (sticky-bit /tmp), causing EACCES for whichever user
# wasn't first. See ingest-drive-export.sh for the same pattern and
# the 502 incident this guards against.
LOCK_DIR="${TMPDIR:-/tmp}/gads-run-morning-$(id -u)"
mkdir -p "${LOCK_DIR}"
chmod 700 "${LOCK_DIR}"
LOCK_PATH="${LOCK_DIR}/lock"

if [[ $# -gt 0 ]]; then
  echo "Usage: $0   (this script takes no arguments)" >&2
  exit 2
fi

mkdir -p "${SNAPSHOTS_DIR}" "${PROD_DIR}" "${BUNDLE_DIR}"

# Single-flight lock so the daily timer + an operator on-demand
# trigger can't stomp on each other.
exec 9>"${LOCK_PATH}"
if ! flock -n 9; then
  echo "Another gads morning run is in flight (lock: ${LOCK_PATH})." >&2
  exit 4
fi

log() { echo "[run-morning] $*" >&2; }

cd "${GADS_DIR}"

# --- 1. Pick freshest snapshot ---------------------------------------------
# Prefer ads-snapshot-live.jsonl (the canonical filename written by
# ingest-drive-export.sh). If for some reason it's missing or empty,
# fall back to the most recent non-empty timestamped snapshot.
SNAPSHOT=""
if [[ -s "${SNAPSHOTS_DIR}/ads-snapshot-live.jsonl" ]]; then
  SNAPSHOT="${SNAPSHOTS_DIR}/ads-snapshot-live.jsonl"
else
  for cand in $(ls -t "${SNAPSHOTS_DIR}"/ads-snapshot-*.jsonl 2>/dev/null); do
    if [[ -s "${cand}" ]]; then
      SNAPSHOT="${cand}"
      break
    fi
  done
fi
if [[ -z "${SNAPSHOT}" ]]; then
  echo "No usable snapshot found under ${SNAPSHOTS_DIR}." >&2
  echo "Drop a fresh Google Ads Editor export into Drive and ingest it via" >&2
  echo "the Helios /ads page (or ingest-drive-export.sh) before re-running." >&2
  exit 5
fi
SNAPSHOT_MTIME="$(stat -c %Y "${SNAPSHOT}")"
NOW_EPOCH="$(date +%s)"
SNAPSHOT_AGE_HOURS="$(awk -v now="${NOW_EPOCH}" -v then="${SNAPSHOT_MTIME}" \
                      'BEGIN { printf "%.1f", (now - then) / 3600.0 }')"
log "using snapshot: ${SNAPSHOT} (age ${SNAPSHOT_AGE_HOURS}h)"

# --- 2. Analysis ------------------------------------------------------------
log "running L1→L2 analysis"
npx tsx scripts/run-analysis.ts \
  --snapshot "${SNAPSHOT}" \
  --output-dir "${PROD_DIR}" >&2

# Identify the run-id produced by run-analysis.ts (it embeds it in the
# generated json/html filenames). We pick the newest run-* artifact.
RUN_JSON="$(ls -t "${PROD_DIR}/json"/run-*-l2-output.json 2>/dev/null | head -1)"
if [[ -z "${RUN_JSON}" ]]; then
  echo "Analysis completed but no L2 output JSON found in ${PROD_DIR}/json" >&2
  exit 6
fi
RUN_ID="$(basename "${RUN_JSON}" -l2-output.json)"
log "run id: ${RUN_ID}"

RUN_HTML="${PROD_DIR}/html/${RUN_ID}-review-packet.html"
if [[ ! -f "${RUN_HTML}" ]]; then
  echo "Analysis completed but no HTML review packet at ${RUN_HTML}" >&2
  exit 7
fi

# --- 3. Bundle --------------------------------------------------------------
log "assembling operator bundle"
STAGE_DIR="$(mktemp -d /tmp/gads-bundle-XXXXXX)"
trap 'rm -rf "${STAGE_DIR}"' EXIT

cp "${RUN_JSON}"  "${STAGE_DIR}/l2-output.json"
cp "${RUN_HTML}"  "${STAGE_DIR}/review-packet.html"
mkdir -p "${STAGE_DIR}/csv"

CSV_COUNT=0
shopt -s nullglob
for csv in "${PROD_DIR}"/csv/*.csv; do
  cp "${csv}" "${STAGE_DIR}/csv/"
  CSV_COUNT=$((CSV_COUNT + 1))
done
shopt -u nullglob

cat > "${STAGE_DIR}/README.md" <<MD
# Google Ads — morning run ${RUN_ID}

Generated on $(date -u +%Y-%m-%dT%H:%M:%SZ) from snapshot:

    $(basename "${SNAPSHOT}")
    (mtime $(date -u -d @${SNAPSHOT_MTIME} +%Y-%m-%dT%H:%M:%SZ) — ${SNAPSHOT_AGE_HOURS}h old)

> **Snapshot freshness matters.** If the age above is more than a few
> hours, drop a fresh Google Ads Editor export into the canonical
> Drive folder, re-ingest it from the Helios \`/ads\` page, and
> re-run \`run-morning.sh\` to regenerate this bundle.

## What's in this bundle

- \`review-packet.html\` — open this first. Per-family risk + the
  full list of recommended actions, with rationale.
- \`csv/\` — Ads Editor CSV batches. Import them into Google Ads
  Editor **in numeric order** (001-, 002-, …) — each batch assumes
  the previous one has already been applied.
- \`l2-output.json\` — machine-readable predictions, kept for audit.

## How to apply

1. Open the HTML review packet, skim the recommendations.
2. In Google Ads Editor, download latest changes from the account.
3. Import each \`csv/NNN-*.csv\` in order via
   *Account → Import → From file*.
4. Review the diff Ads Editor shows. Post any concerns back before
   clicking *Post* in Ads Editor.
MD

BUNDLE_PATH="${BUNDLE_DIR}/${RUN_ID}.zip"
rm -f "${BUNDLE_PATH}"
( cd "${STAGE_DIR}" && zip -q -r "${BUNDLE_PATH}" . )
log "bundle: ${BUNDLE_PATH}"

# --- 4. Upload --------------------------------------------------------------
log "uploading bundle to mss-one-offs"
UPLOAD_OUT="$("${REPO_ROOT}/scripts/upload-to-mss" \
  "${BUNDLE_PATH}" "gads morning ${RUN_ID}" 86400)"
echo "${UPLOAD_OUT}" >&2

PUBLIC_URL="$(printf '%s\n' "${UPLOAD_OUT}" \
              | grep -Eo 'https://[^[:space:]]+' \
              | head -1)"
if [[ -z "${PUBLIC_URL}" ]]; then
  echo "Bundle built but no public URL parsed from upload-to-mss output." >&2
  exit 8
fi

# --- 5. Machine-readable result on stdout -----------------------------------
# jq does the JSON escaping correctly without needing python.
jq -nc \
   --arg   runId            "${RUN_ID}" \
   --arg   bundleUrl        "${PUBLIC_URL}" \
   --arg   bundlePath       "${BUNDLE_PATH}" \
   --argjson csvCount       "${CSV_COUNT}" \
   --arg   htmlPath         "${RUN_HTML}" \
   --arg   jsonPath         "${RUN_JSON}" \
   --arg   snapshotPath     "${SNAPSHOT}" \
   --argjson snapshotAgeHours "${SNAPSHOT_AGE_HOURS}" \
   '{runId:$runId, bundleUrl:$bundleUrl, bundlePath:$bundlePath,
     csvCount:$csvCount, htmlPath:$htmlPath, jsonPath:$jsonPath,
     snapshotPath:$snapshotPath, snapshotAgeHours:$snapshotAgeHours}'
