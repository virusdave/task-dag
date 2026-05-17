import { execFile } from 'node:child_process'
import * as path from 'node:path'
import { promisify } from 'node:util'

import {
  AdsIngestResponseSchema,
  type AdsIngestResponse,
} from '../../shared/contracts/index.js'

const execFileP = promisify(execFile)

// helios/src/server/ads/ -> repo root is 4 levels up. Same offset
// whether we're running from src/ (tsx) or dist/ (built).
const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '../../../..')
const INGEST_SCRIPT = path.join(REPO_ROOT, 'ads/google/scripts/ingest-drive-export.sh')

// The full pipeline (Drive download + 2 Python steps + upload) is
// well under a minute in practice; cap at 5min so a stuck process
// can't hold a request forever.
const TIMEOUT_MS = 5 * 60 * 1000

export interface AdsIngestError extends Error {
  detail: string
  stderr: string
}

/**
 * Runs ads/google/scripts/ingest-drive-export.sh and parses the JSON
 * line on stdout. Both the manual /api/ads/ingest route and the
 * background poller go through this single helper so we stay
 * single-flight (the script's own flock takes care of cross-process
 * collisions; we just need shared error handling here).
 */
export async function runAdsIngest(driveFileUrlOrId: string): Promise<AdsIngestResponse> {
  let stdout = ''
  let stderr = ''
  try {
    const result = await execFileP(INGEST_SCRIPT, [driveFileUrlOrId], {
      timeout: TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    })
    stdout = result.stdout
    stderr = result.stderr
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string }
    const detail = (e.stderr || e.message || '').trim().slice(-4000)
    const error = new Error(`ads ingest script failed: ${detail.split('\n').pop() ?? ''}`) as AdsIngestError
    error.detail = detail
    error.stderr = e.stderr ?? ''
    throw error
  }

  const lastLine = stdout.trim().split(/\r?\n/).pop() ?? ''
  let parsed: unknown
  try {
    parsed = JSON.parse(lastLine)
  } catch {
    const detail = stderr.trim().slice(-4000)
    const error = new Error('ingest finished but produced no parseable result') as AdsIngestError
    error.detail = detail
    error.stderr = stderr
    throw error
  }
  return AdsIngestResponseSchema.parse(parsed)
}
