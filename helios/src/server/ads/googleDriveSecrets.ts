import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Resolves the Google Drive API key fresh from disk on every call (no
 * caching) so rotation is a single `echo > ~/.secret/google-drive/api-key`
 * away -- no helios restart required.
 *
 * Lookup order:
 *   1. GOOGLE_DRIVE_API_KEY env var
 *   2. GOOGLE_DRIVE_API_KEY_FILE env var (path to a file with the key)
 *   3. ~/.secret/google-drive/api-key
 *
 * Returns null when nothing is configured. Callers should surface that
 * state in the UI rather than crashing.
 */
export function loadGoogleDriveApiKey(): string | null {
  const fromEnv = process.env.GOOGLE_DRIVE_API_KEY?.trim()
  if (fromEnv) {
    return fromEnv
  }
  const envFile = process.env.GOOGLE_DRIVE_API_KEY_FILE?.trim()
  if (envFile) {
    return readTrimmedFileIfExists(envFile)
  }
  // Lookup order matches the eventual agenix wiring:
  //   1. canonical agenix-decrypted secret for the helios user
  //   2. helios user's ~/.secret (matches the personal convention)
  //   3. /tmp/google-drive-api-key -- explicit stopgap while we don't
  //      yet have an agenix entry for the Drive API key; mode 644 so
  //      the helios systemd unit can read it without further plumbing
  const candidates = [
    '/run/agenix/helios-google-drive-api-key',
    path.join(os.homedir(), '.secret/google-drive/api-key'),
    '/tmp/google-drive-api-key',
  ]
  for (const p of candidates) {
    const value = readTrimmedFileIfExists(p)
    if (value) {
      return value
    }
  }
  return null
}

function readTrimmedFileIfExists(p: string): string | null {
  try {
    const raw = fs.readFileSync(p, 'utf-8').trim()
    return raw.length > 0 ? raw : null
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw err
  }
}
