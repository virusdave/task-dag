// Pure file-parsing + row-reshaping helpers for the visitor_scans
// backfill CLI (helios/scripts/visitor-scans-backfill.ts).
//
// Kept side-effect-free so it can be unit-tested in isolation: see
// helios/src/server/visitorScans/backfill.test.ts.

export type BackfillSourceFormat = 'json-array' | 'ndjson' | 'csv'

/**
 * Parse a backfill file buffer into a list of *flat* row objects
 * (one object per VeriScan check-in). The reshape into the
 * VeriScan-`Data` PascalCase shape happens in
 * `reshapeFlatRowToData` so we can keep this parser format-agnostic.
 */
export function parseBackfillFile(
  buffer: Buffer,
  format: BackfillSourceFormat,
): Record<string, unknown>[] {
  const text = buffer.toString('utf8')
  switch (format) {
    case 'json-array': {
      const parsed = JSON.parse(text)
      if (!Array.isArray(parsed)) {
        throw new Error('json-array format expected a JSON array at top level')
      }
      return parsed.map((entry) => coerceObject(entry))
    }
    case 'ndjson': {
      const rows: Record<string, unknown>[] = []
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        if (line.length === 0) continue
        rows.push(coerceObject(JSON.parse(line)))
      }
      return rows
    }
    case 'csv': {
      return parseCsv(text)
    }
  }
}

function coerceObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`expected an object row, got ${typeof value}`)
  }
  return value as Record<string, unknown>
}

// Minimal RFC 4180 CSV parser. Supports double-quoted fields with
// escaped `""`, CRLF or LF line endings, and a header row. Returns
// an array of objects keyed by header column.
//
// We deliberately do NOT try to type-coerce cell values here — every
// cell stays as a string, and the downstream `envelopeToRowInput`
// reshaper applies its own numeric / boolean / date coercion. That
// keeps the CSV path identical to the JSON path once the row is in
// VeriScan-`Data` PascalCase shape.
export function parseCsv(text: string): Record<string, unknown>[] {
  const rows = parseCsvRaw(text)
  if (rows.length === 0) return []
  const header = rows[0].map((cell) => cell.trim())
  const out: Record<string, unknown>[] = []
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    if (row.length === 1 && row[0].length === 0) continue // trailing blank line
    const obj: Record<string, unknown> = {}
    for (let c = 0; c < header.length; c++) {
      const key = header[c]
      if (key.length === 0) continue
      obj[key] = c < row.length ? row[c] : ''
    }
    out.push(obj)
  }
  return out
}

function parseCsvRaw(text: string): string[][] {
  const rows: string[][] = []
  let current: string[] = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
      continue
    }
    if (ch === ',') {
      current.push(cell)
      cell = ''
      continue
    }
    if (ch === '\r') {
      // swallow; we treat the following \n as the line break
      continue
    }
    if (ch === '\n') {
      current.push(cell)
      rows.push(current)
      current = []
      cell = ''
      continue
    }
    cell += ch
  }
  // Trailing cell without final newline.
  if (cell.length > 0 || current.length > 0) {
    current.push(cell)
    rows.push(current)
  }
  return rows
}

// Map of accepted lowercase / snake_case / kebab-case aliases the
// operator's Drive export may use → the canonical VeriScan-`Data`
// PascalCase key. We aggressively normalise the key (strip non-alphanum,
// lowercase) so `Hash ID`, `hash_id`, and `hashId` all collapse to
// `HashId`. Unknown keys are still preserved (passed through under
// their original spelling) so `raw_envelope` doesn't lose anything.
const CANONICAL_DATA_KEYS = [
  'HashId',
  'HistoryLogId',
  'Scanned',
  'IdNum',
  'FirstName',
  'MiddleName',
  'LastName',
  'BirthDate',
  'ExpDate',
  'Gender',
  'Phone',
  'Email',
  'Address',
  'City',
  'State',
  'PostalCode',
  'Country',
  'CountryCode',
  'JurisdictionCode',
  'Latitude',
  'Longitude',
  'ScanLatitude',
  'ScanLongitude',
  'DeviceId',
  'DeviceName',
  'DeviceLogin',
  'LocationId',
  'LocationName',
  'GroupId',
  'GroupName',
  'GroupComment',
  'DocumentType',
  'DocumentIsValid',
  'AuthenticationStatus',
  'ScanStatus',
  'Comments',
  'ProfileComments',
  'Tags',
  'UserAgent',
  'ImageLink',
  'SignatureLink',
  'AttachmentLinks',
] as const

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

const CANONICAL_BY_NORMALISED: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  for (const k of CANONICAL_DATA_KEYS) {
    out[normaliseKey(k)] = k
  }
  return out
})()

/**
 * Reshape one flat row into the VeriScan-`Data` PascalCase shape.
 * Unknown keys are preserved verbatim — we want the raw envelope to
 * reflect everything the operator's export contained so a future
 * reader can recover information we didn't bake into the schema.
 *
 * `AttachmentLinks` is special-cased: if the flat row has a string
 * cell we split on `|` / `;` / `,` (whichever is present) so a
 * CSV export with newline-unsafe delimiters round-trips back to an
 * array.
 */
export function reshapeFlatRowToData(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [rawKey, value] of Object.entries(row)) {
    const canonical = CANONICAL_BY_NORMALISED[normaliseKey(rawKey)]
    if (canonical !== undefined) {
      if (canonical === 'AttachmentLinks' && typeof value === 'string') {
        const trimmed = value.trim()
        if (trimmed.length === 0) {
          out[canonical] = null
        } else {
          // Pick the first delimiter present. The operator's Drive
          // export uses `|` historically but we accept `;` and `,`
          // as fallbacks.
          const delimiter = trimmed.includes('|') ? '|' : trimmed.includes(';') ? ';' : ','
          out[canonical] = trimmed
            .split(delimiter)
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        }
      } else {
        out[canonical] = value
      }
    } else {
      // Preserve unknown keys so raw_envelope reflects everything.
      out[rawKey] = value
    }
  }
  return out
}
