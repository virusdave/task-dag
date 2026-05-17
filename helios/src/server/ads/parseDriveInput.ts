/**
 * Parses a Google Drive file URL or raw ID into a fileId (and optional
 * resourceKey). Accepts:
 *   https://drive.google.com/file/d/<ID>/view?usp=sharing
 *   https://drive.google.com/open?id=<ID>
 *   https://drive.usercontent.google.com/download?id=<ID>&...
 *   <ID>   (raw, base64url-style, length >= 20)
 * Plus an optional resourcekey=<KEY> querystring param for files whose
 * folder share requires it.
 */
export interface ParsedDriveInput {
  fileId: string
  resourceKey: string | null
}

const ID_CHARS = /[A-Za-z0-9_-]/
const ID_RAW = /^[A-Za-z0-9_-]{20,}$/

export function parseDriveInput(input: string): ParsedDriveInput {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new ParseDriveInputError('Drive input is empty.')
  }
  const fileId =
    matchAfter(trimmed, '/file/d/') ??
    matchQueryParam(trimmed, 'id') ??
    (ID_RAW.test(trimmed) ? trimmed : null)
  if (!fileId) {
    throw new ParseDriveInputError(
      `Could not parse a Drive file ID from: ${trimmed}. ` +
        `Expected a /file/d/<ID> URL, an ?id=<ID> URL, or the raw ID.`,
    )
  }
  const resourceKey = matchQueryParam(trimmed, 'resourcekey')
  return { fileId, resourceKey }
}

function matchAfter(input: string, marker: string): string | null {
  const idx = input.indexOf(marker)
  if (idx < 0) {
    return null
  }
  let end = idx + marker.length
  while (end < input.length && ID_CHARS.test(input[end]!)) {
    end++
  }
  const slice = input.slice(idx + marker.length, end)
  return slice.length > 0 ? slice : null
}

function matchQueryParam(input: string, name: string): string | null {
  // Find `?name=` or `&name=` (case-insensitive on the name).
  const lower = input.toLowerCase()
  const needles = [`?${name.toLowerCase()}=`, `&${name.toLowerCase()}=`]
  for (const needle of needles) {
    const idx = lower.indexOf(needle)
    if (idx < 0) {
      continue
    }
    let end = idx + needle.length
    while (end < input.length && ID_CHARS.test(input[end]!)) {
      end++
    }
    const slice = input.slice(idx + needle.length, end)
    if (slice.length > 0) {
      return slice
    }
  }
  return null
}

export class ParseDriveInputError extends Error {}
