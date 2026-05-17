import type { AdsDriveFile } from '../../shared/contracts/index.js'

/**
 * Thin Drive v3 client using fetch directly -- no library dependency.
 * Only handles the read paths we need: list a folder and identify the
 * newest CSV. Authentication is via API key (works fine for a folder
 * shared "Anyone with the link can view").
 */

interface DriveFileRaw {
  id?: string
  name?: string
  modifiedTime?: string
  mimeType?: string
  webViewLink?: string
  resourceKey?: string
}

interface DriveListResponse {
  files?: DriveFileRaw[]
  error?: { code?: number; message?: string }
}

/** List CSV-ish files in a folder, newest first. */
export async function listFolderCsvs(
  folderId: string,
  apiKey: string,
  opts?: { folderResourceKey?: string; pageSize?: number },
): Promise<AdsDriveFile[]> {
  const q = [
    `'${folderId}' in parents`,
    'trashed = false',
    `mimeType != 'application/vnd.google-apps.folder'`,
  ].join(' and ')
  const params = new URLSearchParams({
    q,
    orderBy: 'modifiedTime desc,name_natural',
    pageSize: String(opts?.pageSize ?? 50),
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink,resourceKey)',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    key: apiKey,
  })
  const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`
  const headers: Record<string, string> = { Accept: 'application/json' }
  // Mint-time HTTP-referrer restriction on the API key requires every
  // request to advertise itself as coming from the allowlisted origin.
  // Default to our canonical helios proxy domain; overridable via env.
  headers['Referer'] = process.env.GOOGLE_DRIVE_REFERER ?? 'https://vpn-helios.freshlybaked.us/ads'
  if (opts?.folderResourceKey) {
    headers['X-Goog-Drive-Resource-Keys'] = `${folderId}/${opts.folderResourceKey}`
  }
  const response = await fetch(url, { headers })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Drive list failed: ${response.status} ${response.statusText} ${body.slice(0, 400)}`)
  }
  const data = (await response.json()) as DriveListResponse
  if (data.error) {
    throw new Error(`Drive list error: ${data.error.code ?? '?'} ${data.error.message ?? ''}`)
  }
  const out: AdsDriveFile[] = []
  for (const raw of data.files ?? []) {
    if (!raw.id || !raw.name || !raw.modifiedTime) {
      continue
    }
    if (!isCsvLike(raw)) {
      continue
    }
    out.push({
      id: raw.id,
      name: raw.name,
      modifiedTime: raw.modifiedTime,
      webViewLink: raw.webViewLink ?? null,
      resourceKey: raw.resourceKey ?? null,
    })
  }
  return out
}

/** Pick the newest CSV in the folder, or null if the folder has none. */
export async function findLatestCsv(
  folderId: string,
  apiKey: string,
  opts?: { folderResourceKey?: string },
): Promise<AdsDriveFile | null> {
  const files = await listFolderCsvs(folderId, apiKey, opts)
  return files[0] ?? null
}

/**
 * Download a Drive file's bytes to a local path. Uses the public
 * `drive.usercontent.google.com/download` endpoint which works for
 * files shared "Anyone with the link can view" without an OAuth token
 * or API key. Returns the number of bytes written.
 *
 * Throws if the response is non-2xx OR if the first bytes look like an
 * HTML interstitial (Drive permission-denied / virus-scan page / native
 * Google Sheet rendered as HTML), since that's silent data corruption
 * downstream.
 */
export async function downloadDriveFile(args: {
  fileId: string
  resourceKey?: string | null
  destPath: string
}): Promise<number> {
  const params = new URLSearchParams({
    id: args.fileId,
    export: 'download',
    confirm: 't',
  })
  if (args.resourceKey) {
    params.set('resourcekey', args.resourceKey)
  }
  const url = `https://drive.usercontent.google.com/download?${params.toString()}`
  const referer = process.env.GOOGLE_DRIVE_REFERER ?? 'https://vpn-helios.freshlybaked.us/ads'
  const response = await fetch(url, {
    headers: {
      Referer: referer,
      'User-Agent': 'helios-ads-ingest/1.0',
    },
    redirect: 'follow',
  })
  if (!response.ok) {
    throw new DriveDownloadError(
      `Drive download failed for id=${args.fileId}: ${response.status} ${response.statusText}. ` +
        `Make sure the file is shared 'Anyone with the link can view'.`,
    )
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  const head = buffer.slice(0, 200).toString('utf-8').toLowerCase()
  if (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.includes('<title>google drive')
  ) {
    throw new DriveDownloadError(
      `Drive returned HTML, not a CSV (id=${args.fileId}). The file may be private ` +
        `or it may be a native Google Sheet rather than an uploaded CSV.`,
    )
  }
  await (await import('node:fs/promises')).writeFile(args.destPath, buffer)
  return buffer.length
}

export class DriveDownloadError extends Error {}

function isCsvLike(raw: DriveFileRaw): boolean {
  const name = (raw.name ?? '').toLowerCase()
  const mime = (raw.mimeType ?? '').toLowerCase()
  if (name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.csv.gz')) {
    return true
  }
  // Editor exports are sometimes uploaded as text/plain or
  // application/octet-stream; treat anything with a .csv/.tsv name as
  // CSV-ish but otherwise require an explicit mime.
  return mime === 'text/csv' || mime === 'text/tab-separated-values'
}
