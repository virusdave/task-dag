import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { type AdsIngestResponse } from '../../shared/contracts/index.js'
import { automationRepoPath } from './automationRepoRoot.js'
import { buildSnapshotFromCsv } from './buildSnapshotFromCsv.js'
import { downloadDriveFile } from './googleDriveClient.js'
import { uploadToMssOneOffs } from './mssOneOffsUpload.js'
import { parseDriveInput } from './parseDriveInput.js'

const execFileP = promisify(execFile)

// Pipeline runs Drive download + JSONL build + viz render + upload.
// Cap at 5min so a stuck render can't hold a request forever.
const VIZ_TIMEOUT_MS = 5 * 60 * 1000

const CSV_PATH = '/tmp/google-ads-export-utf8.csv'

export interface AdsIngestError extends Error {
  detail: string
  stderr: string
}

// Module-level mutex so the background poller and the manual button
// can't race against each other when they both call this helper.
let inFlight: Promise<AdsIngestResponse> | null = null

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
  const snapshotPath = automationRepoPath('ads/google/snapshots/ads-snapshot-live.jsonl')
  const htmlPath = automationRepoPath('ads/google/outputs/experiments-viz.html')

  // 1. Drive download (in-process fetch; rejects HTML interstitials).
  try {
    await downloadDriveFile({
      fileId: parsed.fileId,
      resourceKey: parsed.resourceKey,
      destPath: CSV_PATH,
    })
  } catch (err) {
    throw makeError('drive download failed', err)
  }

  // 2. CSV -> snapshot (in-process port of convert-csv-to-snapshot.py).
  try {
    await buildSnapshotFromCsv({
      csvPath: CSV_PATH,
      outputPath: snapshotPath,
      snapshotDate: todayYMD(),
    })
  } catch (err) {
    throw makeError('snapshot build failed', err)
  }

  // 3. Snapshot -> HTML viz. This step is still a Python subprocess
  // (build-experiments-viz.py is ~1400 lines of viz rendering with a
  // big embedded CSV bundle); helios invokes it directly, not via a
  // bash orchestrator. Porting to TS is a follow-up.
  const vizScript = automationRepoPath('ads/google/scripts/build-experiments-viz.py')
  try {
    await execFileP('python3', [vizScript, '--output', htmlPath], {
      timeout: VIZ_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    })
  } catch (err) {
    throw makeError('build-experiments-viz failed', err)
  }

  // 4. Public deploy via mss-one-offs (in-process unix-socket POST).
  let upload
  try {
    upload = await uploadToMssOneOffs({
      sourcePath: htmlPath,
      note: 'helios ads ingest',
      ttlSeconds: 86_400,
    })
  } catch (err) {
    throw makeError('mss-one-offs upload failed', err)
  }

  return {
    publicUrl: upload.publicUrl,
    sourceFileId: parsed.fileId,
    snapshotPath,
    outputPath: htmlPath,
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
