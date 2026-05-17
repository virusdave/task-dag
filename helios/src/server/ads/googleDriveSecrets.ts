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
 *   2. GOOGLE_DRIVE_API_KEY_FILE env var (path to a file with the key;
 *      this is what nixos-sbc wires on production via agenix)
 *   3. /run/agenix/helios-google-drive-api-key
 *   4. ~/.secret/google-drive/api-key
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
  // Lookup order:
  //   1. canonical agenix-decrypted secret for the helios user on
  //      production (wired by nixos-sbc; also exposed via
  //      GOOGLE_DRIVE_API_KEY_FILE on the helios systemd units).
  //   2. helios user's ~/.secret (matches the personal convention,
  //      handy for local dev).
  const candidates = [
    '/run/agenix/helios-google-drive-api-key',
    path.join(os.homedir(), '.secret/google-drive/api-key'),
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
