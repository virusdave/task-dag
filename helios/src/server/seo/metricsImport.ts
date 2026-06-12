// Pure parsing + normalization for the SEO GA4/GSC batch metric importer
// (P5 first slice — parent epic virusdave/top-level#15, child epic
// FreshlyBakedNYC/automation#44).
//
// Everything here is PURE + deterministic (CSV parse, URL normalization,
// row-key derivation, batch-id minting, header mapping) so it is fully
// unit-tested without a database. The DB write/aggregation layer lives in
// db/queries/seoMetricsQueries.ts; the operator CLI is
// scripts/import-seo-metrics.ts.
//
// We import OPERATOR-SUPPLIED Google export CSVs (no new API credentials —
// epic §0.4). GSC/GA4 daily exports are ALREADY aggregated, so each daily
// fact carries a deterministic `row_key` over its identifying dimensions
// (NOT the batch/file) — overlapping re-imports collapse onto the same row
// and the upsert overwrites changed metrics rather than summing.

import { createHash, randomBytes } from 'node:crypto'

export type MetricSource = 'gsc' | 'ga4'

export interface GscDailyInput {
  readonly row_key: string
  readonly property: string
  readonly site: string
  readonly source_date: string // YYYY-MM-DD
  readonly source_timezone: string
  readonly bucket_date_ny: string // YYYY-MM-DD
  readonly search_type: string
  readonly device: string
  readonly country: string
  readonly query: string
  readonly page_url: string
  readonly clicks: number
  readonly impressions: number
  readonly position: number
}

export interface Ga4DailyInput {
  readonly row_key: string
  readonly property: string
  readonly site: string
  readonly source_date: string
  readonly source_timezone: string
  readonly bucket_date_ny: string
  readonly page_url: string
  readonly traffic_scope: string
  readonly sessions: number
  readonly active_users: number
  readonly screen_page_views: number
  readonly engaged_sessions: number
  readonly key_events: number
}

export interface ParseResult<T> {
  readonly rows: T[]
  readonly rowsSeen: number
  readonly rowsRejected: number
  readonly rejections: string[]
  readonly exportStartDate: string | null
  readonly exportEndDate: string | null
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Mint a fresh, sortable metric-import batch id of the form
 * `seoimp_YYYY-MM-DD_HHMMSS_<6 hex>` in UTC. The 6-hex suffix disambiguates
 * two imports in the same second.
 */
export function newImportBatchId(now: Date = new Date()): string {
  const p = (n: number, w: number): string => String(n).padStart(w, '0')
  const y = p(now.getUTCFullYear(), 4)
  const mo = p(now.getUTCMonth() + 1, 2)
  const d = p(now.getUTCDate(), 2)
  const h = p(now.getUTCHours(), 2)
  const mi = p(now.getUTCMinutes(), 2)
  const s = p(now.getUTCSeconds(), 2)
  return `seoimp_${y}-${mo}-${d}_${h}${mi}${s}_${randomBytes(3).toString('hex')}`
}

// ── CSV parsing (RFC-4180-ish: quoted fields, embedded commas/quotes, CRLF) ─

/**
 * Parse CSV text into rows of string cells. Handles double-quoted fields
 * (with escaped `""` and embedded commas/newlines) and CRLF/LF line
 * endings. A trailing empty line is ignored.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  let i = 0
  const n = text.length
  // Strip a leading UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) {
    i = 1
  }
  while (i < n) {
    const c = text[i]!
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      cell += c
      i++
      continue
    }
    if (c === '"') {
      inQuotes = true
      i++
      continue
    }
    if (c === ',') {
      row.push(cell)
      cell = ''
      i++
      continue
    }
    if (c === '\r') {
      i++
      continue
    }
    if (c === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i++
      continue
    }
    cell += c
    i++
  }
  // Flush the final cell/row if the file didn't end with a newline.
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

// ── header mapping ────────────────────────────────────────────────────

function normHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Build a header→column-index map, picking the FIRST column whose
 * normalized name matches any of the given aliases. Returns -1 when none
 * of the aliases are present.
 */
function indexOfHeader(headers: string[], aliases: readonly string[]): number {
  const normalized = headers.map(normHeader)
  for (const alias of aliases) {
    const a = normHeader(alias)
    const idx = normalized.indexOf(a)
    if (idx !== -1) {
      return idx
    }
  }
  return -1
}

// ── value parsing ─────────────────────────────────────────────────────

/** Parse a Google date cell ("YYYY-MM-DD" or "YYYYMMDD") to "YYYY-MM-DD". */
export function parseGoogleDate(raw: string): string | null {
  const s = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return isRealDate(s) ? s : null
  }
  if (/^\d{8}$/.test(s)) {
    const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
    return isRealDate(iso) ? iso : null
  }
  return null
}

function minIso(current: string | null, candidate: string): string {
  return current === null || candidate < current ? candidate : current
}

function maxIso(current: string | null, candidate: string): string {
  return current === null || candidate > current ? candidate : current
}

function isRealDate(iso: string): boolean {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/** Parse an integer metric cell ("1,234" / "12" / "" → 0). Rejects junk. */
function parseIntCell(raw: string): number | null {
  const s = raw.trim().replace(/,/g, '')
  if (s === '') {
    return 0
  }
  if (!/^-?\d+(\.0+)?$/.test(s)) {
    return null
  }
  const v = Math.trunc(Number(s))
  return Number.isFinite(v) ? v : null
}

/** Parse a float metric cell ("12.3" / "1,234.5" / "" → 0). */
function parseFloatCell(raw: string): number | null {
  const s = raw.trim().replace(/,/g, '').replace(/%$/, '')
  if (s === '') {
    return 0
  }
  const v = Number(s)
  return Number.isFinite(v) ? v : null
}

// ── URL normalization ─────────────────────────────────────────────────

export interface UrlNormalizeOptions {
  /** Base URL to resolve a path-only value (GA4 page-path exports). */
  readonly baseUrl?: string
}

/**
 * Normalize a page URL for stable row-keying + cross-source joins:
 * lowercase scheme + host, strip the fragment, drop a default port, and
 * collapse a bare-root empty path to "/". A path-only value (GA4) is
 * resolved against `baseUrl`. Returns null when the value can't be made
 * into an absolute URL.
 */
export function normalizeUrl(raw: string, opts: UrlNormalizeOptions = {}): string | null {
  const s = raw.trim()
  if (s === '') {
    return null
  }
  let u: URL
  try {
    if (/^https?:\/\//i.test(s)) {
      u = new URL(s)
    } else if (opts.baseUrl) {
      u = new URL(s, opts.baseUrl)
    } else {
      return null
    }
  } catch {
    return null
  }
  u.protocol = u.protocol.toLowerCase()
  u.hostname = u.hostname.toLowerCase()
  u.hash = ''
  if (u.pathname === '') {
    u.pathname = '/'
  }
  return u.toString()
}

// ── row-key derivation ────────────────────────────────────────────────
//
// Canonical JSON over the IDENTIFYING dimensions only (never the batch id
// or file hash), so an overlapping re-import maps to the same row.

export function gscRowKey(d: {
  source: 'gsc'
  property: string
  source_date: string
  search_type: string
  device: string
  country: string
  query: string
  page_url: string
}): string {
  return sha256Hex(
    JSON.stringify([
      d.source,
      d.property,
      d.source_date,
      d.search_type,
      d.device,
      d.country,
      d.query,
      d.page_url,
    ]),
  )
}

export function ga4RowKey(d: {
  source: 'ga4'
  property: string
  source_date: string
  traffic_scope: string
  page_url: string
}): string {
  return sha256Hex(
    JSON.stringify([d.source, d.property, d.source_date, d.traffic_scope, d.page_url]),
  )
}

// ── GSC export parsing ────────────────────────────────────────────────

const GSC_DATE = ['date', 'day'] as const
const GSC_QUERY = ['query', 'queries', 'search query', 'top queries'] as const
const GSC_PAGE = ['page', 'pages', 'top pages', 'landing page', 'url'] as const
const GSC_CLICKS = ['clicks'] as const
const GSC_IMPRESSIONS = ['impressions'] as const
const GSC_POSITION = ['position', 'average position', 'avg position'] as const

export interface GscParseOptions {
  readonly property: string
  readonly site: string
  readonly sourceTimezone?: string // default America/Los_Angeles
  readonly searchType?: string // default web
  readonly device?: string // default all
  readonly country?: string // default all
}

/**
 * Parse an operator-supplied GSC performance CSV with per-(query,page,date)
 * rows. Required columns (flexible, case-insensitive names): date, query,
 * page, clicks, impressions, position. CTR is DERIVED, never imported.
 * Malformed rows are rejected (not silently zeroed) and counted.
 */
export function parseGscCsv(text: string, opts: GscParseOptions): ParseResult<GscDailyInput> {
  const tz = opts.sourceTimezone ?? 'America/Los_Angeles'
  const searchType = opts.searchType ?? 'web'
  const device = opts.device ?? 'all'
  const country = opts.country ?? 'all'

  const grid = parseCsv(text)
  const rows: GscDailyInput[] = []
  const rejections: string[] = []
  if (grid.length === 0) {
    return emptyResult()
  }
  const headers = grid[0]!
  const di = indexOfHeader(headers, GSC_DATE)
  const qi = indexOfHeader(headers, GSC_QUERY)
  const pi = indexOfHeader(headers, GSC_PAGE)
  const ci = indexOfHeader(headers, GSC_CLICKS)
  const ii = indexOfHeader(headers, GSC_IMPRESSIONS)
  const posi = indexOfHeader(headers, GSC_POSITION)
  const missing: string[] = []
  if (di === -1) missing.push('date')
  if (qi === -1) missing.push('query')
  if (pi === -1) missing.push('page')
  if (ci === -1) missing.push('clicks')
  if (ii === -1) missing.push('impressions')
  if (posi === -1) missing.push('position')
  if (missing.length > 0) {
    throw new Error(`GSC CSV missing required column(s): ${missing.join(', ')}`)
  }

  let seen = 0
  let minDate: string | null = null
  let maxDate: string | null = null
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r]!
    if (cells.length === 1 && cells[0]!.trim() === '') {
      continue // blank line
    }
    seen++
    const date = parseGoogleDate(cells[di] ?? '')
    const query = (cells[qi] ?? '').trim()
    const pageRaw = (cells[pi] ?? '').trim()
    const page = normalizeUrl(pageRaw)
    const clicks = parseIntCell(cells[ci] ?? '')
    const impressions = parseIntCell(cells[ii] ?? '')
    const position = parseFloatCell(cells[posi] ?? '')
    if (date === null) {
      rejections.push(`row ${r + 1}: unparseable date "${cells[di] ?? ''}"`)
      continue
    }
    if (page === null) {
      rejections.push(`row ${r + 1}: unparseable page url "${pageRaw}"`)
      continue
    }
    if (clicks === null || impressions === null || position === null) {
      rejections.push(`row ${r + 1}: unparseable metric value`)
      continue
    }
    if (clicks > impressions) {
      rejections.push(`row ${r + 1}: clicks (${clicks}) > impressions (${impressions})`)
      continue
    }
    minDate = minIso(minDate, date)
    maxDate = maxIso(maxDate, date)
    rows.push({
      row_key: gscRowKey({
        source: 'gsc',
        property: opts.property,
        source_date: date,
        search_type: searchType,
        device,
        country,
        query,
        page_url: page,
      }),
      property: opts.property,
      site: opts.site,
      source_date: date,
      source_timezone: tz,
      bucket_date_ny: date,
      search_type: searchType,
      device,
      country,
      query,
      page_url: page,
      clicks,
      impressions,
      position,
    })
  }
  return {
    rows,
    rowsSeen: seen,
    rowsRejected: rejections.length,
    rejections,
    exportStartDate: minDate,
    exportEndDate: maxDate,
  }
}

// ── GA4 export parsing ────────────────────────────────────────────────

const GA4_DATE = ['date', 'day', 'nth day'] as const
const GA4_PAGE = [
  'page path and screen class',
  'page path',
  'landing page',
  'landing page path',
  'page location',
  'page',
] as const
const GA4_SESSIONS = ['sessions'] as const
const GA4_ACTIVE_USERS = ['active users', 'users', 'total users'] as const
const GA4_PAGEVIEWS = ['views', 'screen page views', 'page views', 'pageviews'] as const
const GA4_ENGAGED = ['engaged sessions'] as const
const GA4_KEY_EVENTS = ['key events', 'conversions', 'event count'] as const

export interface Ga4ParseOptions {
  readonly property: string
  readonly site: string
  readonly sourceTimezone?: string // default America/New_York
  readonly trafficScope?: string // default organic_search
  readonly baseUrl?: string // resolve page-path-only exports
}

/**
 * Parse an operator-supplied GA4 export CSV with per-(page,date) rows.
 * Required columns: date, page (path or location), sessions. Other metrics
 * (active users, views, engaged sessions, key events) default to 0 when the
 * export omits them. Path-only page values require `baseUrl`.
 */
export function parseGa4Csv(text: string, opts: Ga4ParseOptions): ParseResult<Ga4DailyInput> {
  const tz = opts.sourceTimezone ?? 'America/New_York'
  const trafficScope = opts.trafficScope ?? 'organic_search'

  const grid = parseCsv(text)
  const rows: Ga4DailyInput[] = []
  const rejections: string[] = []
  // GA4 exports often prepend comment lines starting with '#'; find the
  // first row that actually contains the required headers.
  let headerRow = -1
  for (let r = 0; r < grid.length; r++) {
    const cells = grid[r]!
    if (indexOfHeader(cells, GA4_DATE) !== -1 && indexOfHeader(cells, GA4_PAGE) !== -1) {
      headerRow = r
      break
    }
  }
  if (headerRow === -1) {
    throw new Error('GA4 CSV missing required column(s): date, page')
  }
  const headers = grid[headerRow]!
  const di = indexOfHeader(headers, GA4_DATE)
  const pi = indexOfHeader(headers, GA4_PAGE)
  const si = indexOfHeader(headers, GA4_SESSIONS)
  if (si === -1) {
    throw new Error('GA4 CSV missing required column(s): sessions')
  }
  const aui = indexOfHeader(headers, GA4_ACTIVE_USERS)
  const pvi = indexOfHeader(headers, GA4_PAGEVIEWS)
  const ei = indexOfHeader(headers, GA4_ENGAGED)
  const kei = indexOfHeader(headers, GA4_KEY_EVENTS)

  let seen = 0
  let minDate: string | null = null
  let maxDate: string | null = null
  for (let r = headerRow + 1; r < grid.length; r++) {
    const cells = grid[r]!
    if (cells.length === 1 && cells[0]!.trim() === '') {
      continue
    }
    // GA4 exports often end with a "Totals" row with no/aggregate date.
    const date = parseGoogleDate(cells[di] ?? '')
    if (date === null) {
      continue // skip non-daily / totals / preamble rows silently
    }
    seen++
    const pageRaw = (cells[pi] ?? '').trim()
    const page = normalizeUrl(pageRaw, { baseUrl: opts.baseUrl })
    const sessions = parseIntCell(cells[si] ?? '')
    const activeUsers = aui === -1 ? 0 : parseIntCell(cells[aui] ?? '')
    const pageViews = pvi === -1 ? 0 : parseIntCell(cells[pvi] ?? '')
    const engaged = ei === -1 ? 0 : parseIntCell(cells[ei] ?? '')
    const keyEvents = kei === -1 ? 0 : parseFloatCell(cells[kei] ?? '')
    if (page === null) {
      rejections.push(`row ${r + 1}: unparseable page url "${pageRaw}"`)
      continue
    }
    if (
      sessions === null ||
      activeUsers === null ||
      pageViews === null ||
      engaged === null ||
      keyEvents === null
    ) {
      rejections.push(`row ${r + 1}: unparseable metric value`)
      continue
    }
    if (engaged > sessions) {
      rejections.push(`row ${r + 1}: engaged sessions (${engaged}) > sessions (${sessions})`)
      continue
    }
    minDate = minIso(minDate, date)
    maxDate = maxIso(maxDate, date)
    rows.push({
      row_key: ga4RowKey({
        source: 'ga4',
        property: opts.property,
        source_date: date,
        traffic_scope: trafficScope,
        page_url: page,
      }),
      property: opts.property,
      site: opts.site,
      source_date: date,
      source_timezone: tz,
      bucket_date_ny: date,
      page_url: page,
      traffic_scope: trafficScope,
      sessions,
      active_users: activeUsers,
      screen_page_views: pageViews,
      engaged_sessions: engaged,
      key_events: keyEvents,
    })
  }
  return {
    rows,
    rowsSeen: seen,
    rowsRejected: rejections.length,
    rejections,
    exportStartDate: minDate,
    exportEndDate: maxDate,
  }
}

function emptyResult<T>(): ParseResult<T> {
  return {
    rows: [],
    rowsSeen: 0,
    rowsRejected: 0,
    rejections: [],
    exportStartDate: null,
    exportEndDate: null,
  }
}

// ── intra-file de-duplication ─────────────────────────────────────────
//
// `ON CONFLICT DO UPDATE` cannot touch the same row twice in one statement,
// so duplicate row_keys WITHIN a file must be collapsed before SQL. Daily
// exports shouldn't contain dup keys, but a malformed export might; we keep
// the LAST occurrence and report how many were collapsed.

export interface DedupeResult<T> {
  readonly rows: T[]
  readonly duplicatesCollapsed: number
}

export function dedupeByRowKey<T extends { readonly row_key: string }>(
  rows: readonly T[],
): DedupeResult<T> {
  const byKey = new Map<string, T>()
  let collapsed = 0
  for (const row of rows) {
    if (byKey.has(row.row_key)) {
      collapsed++
    }
    byKey.set(row.row_key, row)
  }
  return { rows: [...byKey.values()], duplicatesCollapsed: collapsed }
}
