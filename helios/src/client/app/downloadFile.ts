import { buildAppPath } from './paths.js'

/**
 * Fetch a file-download endpoint and save it via a temporary object URL.
 *
 * Unlike a plain `<a href>` (which navigates the whole tab and, on an error
 * status, replaces the SPA with the raw JSON/HTML error body), this keeps the
 * operator on the page and surfaces server errors as a thrown `Error` the
 * caller can show in its existing error area. Used by the snapshot CSV export
 * buttons on the Catalog Browser and Stock Refresh pages.
 *
 * `path` is app-relative (run through `buildAppPath`). `fallbackFilename` is
 * used when the response carries no `Content-Disposition` filename.
 */
export async function downloadFile(path: string, fallbackFilename: string): Promise<void> {
  const response = await fetch(buildAppPath(path), {
    credentials: 'same-origin',
    headers: { Accept: 'text/csv, application/octet-stream, application/json' },
  })

  if (!response.ok) {
    throw new Error(await readDownloadError(response))
  }

  const blob = await response.blob()
  const filename = filenameFromContentDisposition(response) ?? fallbackFilename
  const objectUrl = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = filename
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    // Defer so the browser has started the download before we revoke.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
  }
}

function filenameFromContentDisposition(response: Response): string | null {
  const header = response.headers.get('content-disposition')
  if (!header) return null
  const match = /filename="?([^"]+)"?/i.exec(header)
  return match ? match[1] : null
}

async function readDownloadError(response: Response): Promise<string> {
  let bodyText = ''
  try {
    bodyText = await response.text()
  } catch {
    return `${response.status} ${response.statusText}`
  }
  if (bodyText) {
    try {
      const payload = JSON.parse(bodyText) as { error?: unknown; message?: unknown }
      const message =
        typeof payload.error === 'string'
          ? payload.error
          : typeof payload.message === 'string'
            ? payload.message
            : null
      if (message) return message
    } catch {
      // Not JSON — fall through to the raw body below.
    }
    const trimmed = bodyText.trim().slice(0, 500)
    if (trimmed) return trimmed
  }
  return `${response.status} ${response.statusText}`
}
