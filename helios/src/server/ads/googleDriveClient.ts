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
