import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  ADS_DRIVE_FOLDER_ID,
  type AdsDriveFile,
  type AdsStatusResponse,
} from '../../shared/contracts/index.js'
import { findLatestCsv } from './googleDriveClient.js'
import { loadGoogleDriveApiKey } from './googleDriveSecrets.js'
import { runAdsIngest } from './runAdsIngest.js'

const POLL_INTERVAL_MS = 30_000
const STATE_PATH = path.join(os.homedir(), '.local/state/helios/ads-ingest.json')

interface PersistedState {
  lastIngestedFileId: string | null
  lastIngestedModifiedTime: string | null
  lastPublicUrl: string | null
  lastSuccessAt: string | null
}

const EMPTY_STATE: PersistedState = {
  lastIngestedFileId: null,
  lastIngestedModifiedTime: null,
  lastPublicUrl: null,
  lastSuccessAt: null,
}

/** Volatile poller state -- regenerated on every tick. */
interface RuntimeState {
  configured: boolean
  reason: string | null
  lastCheckedAt: string | null
  latestDiscoveredFile: AdsDriveFile | null
  running: boolean
  lastError: string | null
}

let runtime: RuntimeState = {
  configured: false,
  reason: 'not started',
  lastCheckedAt: null,
  latestDiscoveredFile: null,
  running: false,
  lastError: null,
}
let persisted: PersistedState = { ...EMPTY_STATE }
let persistedLoaded = false
let timer: NodeJS.Timeout | null = null
let inFlight = false

/** Read disk state into memory once on startup. */
async function ensurePersistedLoaded(): Promise<void> {
  if (persistedLoaded) {
    return
  }
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf-8')
    persisted = { ...EMPTY_STATE, ...(JSON.parse(raw) as Partial<PersistedState>) }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Don't crash boot on a corrupt state file; just start fresh.
      runtime.lastError = `state file unreadable: ${(err as Error).message}`
    }
    persisted = { ...EMPTY_STATE }
  }
  persistedLoaded = true
}

async function writePersisted(): Promise<void> {
  const dir = path.dirname(STATE_PATH)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${STATE_PATH}.tmp`
  await fs.writeFile(tmp, JSON.stringify(persisted, null, 2))
  await fs.rename(tmp, STATE_PATH)
}

async function pollOnce(): Promise<void> {
  if (inFlight) {
    return
  }
  inFlight = true
  try {
    await ensurePersistedLoaded()
    runtime.lastCheckedAt = new Date().toISOString()

    const apiKey = loadGoogleDriveApiKey()
    if (!apiKey) {
      runtime.configured = false
      runtime.reason =
        'Google Drive API key not configured. Add it to ~/.secret/google-drive/api-key (see ads/google/docs/HELIOS_EXPORT_SOURCE.md).'
      runtime.latestDiscoveredFile = null
      return
    }
    runtime.configured = true
    runtime.reason = null

    let latest: AdsDriveFile | null
    try {
      latest = await findLatestCsv(ADS_DRIVE_FOLDER_ID, apiKey)
    } catch (err) {
      runtime.lastError = `Drive list failed: ${(err as Error).message}`
      return
    }
    runtime.latestDiscoveredFile = latest
    if (!latest) {
      runtime.lastError = 'No CSV files found in the Drive folder.'
      return
    }

    // Idempotency: skip if we've already ingested this exact version.
    if (
      latest.id === persisted.lastIngestedFileId &&
      latest.modifiedTime === persisted.lastIngestedModifiedTime
    ) {
      return
    }

    runtime.running = true
    try {
      const result = await runAdsIngest(latest.id)
      persisted = {
        lastIngestedFileId: latest.id,
        lastIngestedModifiedTime: latest.modifiedTime,
        lastPublicUrl: result.publicUrl,
        lastSuccessAt: new Date().toISOString(),
      }
      await writePersisted()
      runtime.lastError = null
    } catch (err) {
      const e = err as { detail?: string; message?: string }
      runtime.lastError = (e.detail || e.message || String(err)).slice(-2000)
    } finally {
      runtime.running = false
    }
  } finally {
    inFlight = false
  }
}

export function startAdsDrivePoller(): void {
  if (timer) {
    return
  }
  if (process.env.NODE_ENV === 'test') {
    return
  }
  // First tick on a small delay so server boot logs are clean.
  setTimeout(() => {
    void pollOnce()
  }, 1500)
  timer = setInterval(() => {
    void pollOnce()
  }, POLL_INTERVAL_MS)
  // unref so the timer doesn't keep the process alive on shutdown.
  if (timer.unref) {
    timer.unref()
  }
}

export function stopAdsDrivePoller(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export async function triggerAdsDrivePoll(): Promise<void> {
  await pollOnce()
}

export async function getAdsStatus(): Promise<AdsStatusResponse> {
  await ensurePersistedLoaded()
  // Surface "missing credentials" instantly even if the poller hasn't
  // run yet (status endpoint is cheap, called on UI mount).
  if (runtime.lastCheckedAt === null) {
    const apiKey = loadGoogleDriveApiKey()
    if (!apiKey) {
      runtime.configured = false
      runtime.reason =
        'Google Drive API key not configured. Add it to ~/.secret/google-drive/api-key (see ads/google/docs/HELIOS_EXPORT_SOURCE.md).'
    } else {
      runtime.configured = true
      runtime.reason = null
    }
  }
  return {
    configured: runtime.configured,
    reason: runtime.reason,
    lastCheckedAt: runtime.lastCheckedAt,
    latestDiscoveredFile: runtime.latestDiscoveredFile,
    running: runtime.running,
    lastError: runtime.lastError,
    lastSuccessAt: persisted.lastSuccessAt,
    lastIngestedFileId: persisted.lastIngestedFileId,
    lastIngestedModifiedTime: persisted.lastIngestedModifiedTime,
    lastPublicUrl: persisted.lastPublicUrl,
  }
}
