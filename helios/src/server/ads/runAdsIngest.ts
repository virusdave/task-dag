import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { type AdsIngestResponse } from '../../shared/contracts/index.js'
import { evaluateOutcomesAgainstSnapshot } from './adAttemptsTracker.js'
import { buildSnapshotFromCsv } from './buildSnapshotFromCsv.js'
import { downloadDriveFile } from './googleDriveClient.js'
import { parseDriveInput } from './parseDriveInput.js'
import { sharedSnapshotPath } from './sharedSnapshotPath.js'

/**
 * Drive ingest pipeline.
 *
 * The current contract is intentionally narrow: this code is allowed to
 * download from Drive and build the `ads-snapshot-live.jsonl` snapshot,
 * and that's it. Specifically:
 *
 *   - It MUST NOT spawn python (helios is python-free, both in
 *     dependencies and in its execution chain). The previous version
 *     shelled out to `python3 build-experiments-viz.py` to render the
 *     experiments dashboard HTML; that step has been removed. The
 *     dashboard is rebuilt out-of-band (the gads-run-analysis.service
 *     09:00 timer + on-demand `gads-run-morning` produce the
 *     operator-facing review packet now).
 *   - It MUST use a per-user, per-invocation temp file for the CSV
 *     download — `/tmp` is sticky-bit, and a previous hard-coded path
 *     (`/tmp/google-ads-export-utf8.csv`) caused EACCES every time a
 *     second uid (e.g. the manual ssh tester after helios, or vice
 *     versa) tried to overwrite a file the first uid owned.
 *
 * Operator-visible effect: the "Ingest now" button now reports
 * "snapshot refreshed" and leaves dashboard regeneration to the
 * gads-run-morning surface; AdsIngestResponse.publicUrl is no longer
 * populated by this code path.
 */

const PER_USER_TMP_DIR = path.join(os.tmpdir(), `helios-ads-ingest-${process.getuid?.() ?? 0}`)

// Module-level mutex so the background poller and the manual button
// can't race against each other when they both call this helper.
let inFlight: Promise<AdsIngestResponse> | null = null

export interface AdsIngestError extends Error {
  detail: string
  stderr: string
}

export function runAdsIngest(driveFileUrlOrId: string): Promise<AdsIngestResponse> {
  if (inFlight) {
    return inFlight
  }
  inFlight = doRunAdsIngest(driveFileUrlOrId).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function doRunAdsIngest(driveFileUrlOrId: string): Promise<AdsIngestResponse> {
  const parsed = parseDriveInput(driveFileUrlOrId)
  const snapshotPath = sharedSnapshotPath()
  // Ensure the snapshot's parent dir exists. In prod this is the
  // shared `/var/lib/gads/data/snapshots/` dir created by the gads
  // module; in local dev it's the in-repo `ads/google/snapshots/`
  // dir. Either way, `mkdir -p` is harmless and lets ad-hoc test
  // setups work without pre-creating directories.
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true })

  // Per-user temp dir, owned 700 by the helios user — never collides
  // with a parallel `amp-local` (or other uid) ssh test on the same host.
  await fs.mkdir(PER_USER_TMP_DIR, { recursive: true })
  await fs.chmod(PER_USER_TMP_DIR, 0o700)
  const csvPath = path.join(PER_USER_TMP_DIR, `drive-export-${process.pid}-${Date.now()}.csv`)

  try {
    // 1. Drive download (in-process fetch; rejects HTML interstitials).
    try {
      await downloadDriveFile({
        fileId: parsed.fileId,
        resourceKey: parsed.resourceKey,
        destPath: csvPath,
      })
    } catch (err) {
      throw makeError('drive download failed', err)
    }

    // 2. CSV -> snapshot (in-process port of convert-csv-to-snapshot.py;
    // pure TypeScript, no python).
    try {
      await buildSnapshotFromCsv({
        csvPath,
        outputPath: snapshotPath,
        snapshotDate: todayYMD(),
      })
    } catch (err) {
      throw makeError('snapshot build failed', err)
    }

    // 3. With a fresh snapshot in hand, grade every still-open
    //    gads_ad_attempts row for ads in this snapshot by comparing
    //    before/after serving_status. This is what closes the
    //    feedback loop — without it the attempts table just grows
    //    a pile of "unobserved" entries that the prompt prep can't
    //    distinguish from "succeeded" or "still broken". Best
    //    effort; a DB outage here does NOT fail the ingest (the
    //    snapshot is the operator's primary deliverable).
    void evaluateOutcomesAgainstSnapshot(snapshotPath, {
      onLog: (line) => console.log(`[adsIngest] ${line}`),
    }).catch((err) => {
      console.warn(
        `[adsIngest] outcome evaluation failed (continuing): ${(err as Error).message}`,
      )
    })

    return {
      sourceFileId: parsed.fileId,
      snapshotPath,
      // publicUrl + outputPath are explicitly null now: the operator
      // gets the public dashboard via the gads-run-morning bundle,
      // not from this code path. See the file-header docstring.
      publicUrl: null,
      outputPath: null,
    }
  } finally {
    // Clean up the multi-MB CSV every time, success or failure.
    await fs.unlink(csvPath).catch(() => {})
  }
}

function makeError(prefix: string, err: unknown): AdsIngestError {
  const e = err as { stdout?: string; stderr?: string; message?: string; code?: number }
  const stderr = (e.stderr ?? '').toString()
  const message = (e.message ?? String(err)).toString()
  // Prefer the last non-empty line of stderr (most specific) when present.
  const stderrTail = stderr.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
  const summary = stderrTail || message
  const detail = (stderr.trim() || message).slice(-4000)
  const error = new Error(`${prefix}: ${summary}`) as AdsIngestError
  error.detail = detail
  error.stderr = stderr
  return error
}

function todayYMD(): string {
  const d = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
