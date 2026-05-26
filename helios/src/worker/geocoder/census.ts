/**
 * US Census Geocoder client for the shared `addresses` table
 * (issue #25, sweed-address-enrichment epic, task A3).
 *
 * The pattern (URL, benchmark, JSON envelope shape, network
 * timeout) is borrowed from
 * `helios/scripts/backfill-litalerts-retailer-geo.mts`, which has
 * been running against the real Census service for months.
 *
 * Two differences from the litalerts backfill script:
 *
 *   1. We hit the `geographies/onelineaddress` endpoint, not the
 *      `locations/...` endpoint that script uses. The task spec
 *      names the latter — but the spec also requires us to emit
 *      `county` in the geocode result, which only the geographies
 *      endpoint returns. Trading one extra response field for
 *      identical network volume is a clear win, so we deviate
 *      from the URL choice in the task description by design.
 *
 *   2. A process-wide token bucket caps outbound calls to 1 RPS,
 *      the Census docs ceiling. Litalerts had `await sleep(200)`
 *      sprinkled inside its caller; centralising it here means
 *      both producers (A4 delivery, A5 customer enrichment) and
 *      the eventual geocoder-drain tick share one budget without
 *      having to coordinate.
 */

export type CensusGeocodeStatus = 'ok' | 'failed' | 'not_us'

export interface CensusGeocodeResult {
  latitude: number | null
  longitude: number | null
  zip5: string | null
  city: string | null
  county: string | null
  stateCode: string | null
  status: CensusGeocodeStatus
}

const CENSUS_GEOCODER_URL =
  'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress'
const CENSUS_BENCHMARK = 'Public_AR_Current'
const CENSUS_VINTAGE = 'Current_Current'
const CENSUS_TIMEOUT_MS = 15_000
/** Hard cap per the Census API docs. */
const MIN_GAP_BETWEEN_CALLS_MS = 1_000

/** US Postal Service two-letter codes (50 states + DC + territories
 *  the Census geocoder can resolve). */
const US_STATE_CODES = new Set([
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga',
  'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md',
  'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj',
  'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc',
  'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy',
  'dc', 'as', 'gu', 'mp', 'pr', 'vi',
])

/** Tokens that, when present in the normalized one-liner, mark the
 *  input as definitively non-US so we don't burn a Census call on
 *  it. List is intentionally small + conservative — false positives
 *  (US addresses misclassified non-US) are MUCH more costly than
 *  false negatives. */
const NON_US_COUNTRY_TOKENS = [
  'canada', 'mexico', 'united kingdom', ' uk', 'england', 'scotland',
  'ireland', 'australia', 'germany', 'france', 'italy', 'spain',
  'china', 'japan', 'india',
]

// ---------------------------------------------------------------------------
// Process-wide 1-RPS rate limiter.
// ---------------------------------------------------------------------------

let lastCallAtMs = 0
let pendingChain: Promise<void> = Promise.resolve()

/** FIFO-fair: every call queues behind the previous one and is
 *  released at most once per `MIN_GAP_BETWEEN_CALLS_MS`. */
function acquireRateSlot(): Promise<void> {
  const next = pendingChain.then(async () => {
    const now = Date.now()
    const wait = lastCallAtMs + MIN_GAP_BETWEEN_CALLS_MS - now
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait))
    }
    lastCallAtMs = Date.now()
  })
  // Don't propagate failures along the chain — every caller pays
  // its own retry cost, but the rate gate keeps releasing.
  pendingChain = next.catch(() => undefined)
  return next
}

/** Test-only escape hatch: reset the rate limiter between cases. */
export function resetCensusRateLimiterForTest(): void {
  lastCallAtMs = 0
  pendingChain = Promise.resolve()
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface GeocodeViaCensusOptions {
  /** Override the global fetch (tests). */
  fetchImpl?: typeof fetch
  /** Override the timeout (tests; production uses 15s). */
  timeoutMs?: number
  /** Skip the 1-RPS gate (tests only). */
  skipRateLimit?: boolean
}

export async function geocodeViaCensus(
  normalized: string,
  options: GeocodeViaCensusOptions = {},
): Promise<CensusGeocodeResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? CENSUS_TIMEOUT_MS

  if (!normalized || normalized.trim().length === 0) {
    return emptyResult('failed')
  }

  // Cheap non-US heuristic — skip the HTTP call entirely.
  if (looksDefinitelyNonUS(normalized)) {
    return emptyResult('not_us')
  }

  if (!options.skipRateLimit) {
    await acquireRateSlot()
  }

  const url = new URL(CENSUS_GEOCODER_URL)
  url.searchParams.set('address', normalized)
  url.searchParams.set('benchmark', CENSUS_BENCHMARK)
  url.searchParams.set('vintage', CENSUS_VINTAGE)
  url.searchParams.set('format', 'json')

  let response: Response
  try {
    response = await fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    // Network / timeout — treat as a soft failure so the row goes
    // back through the queue on the next tick rather than being
    // wedged.
    return emptyResult('failed')
  }
  if (!response.ok) {
    return emptyResult('failed')
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return emptyResult('failed')
  }

  return parseCensusResponse(payload)
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Visible for tests. */
export function looksDefinitelyNonUS(normalized: string): boolean {
  const lower = ` ${normalized.toLowerCase()} `
  for (const token of NON_US_COUNTRY_TOKENS) {
    if (lower.includes(token)) return true
  }
  // No 5-digit ZIP AND no recognisable US state code anywhere ->
  // probably international (or so garbled the geocoder won't help).
  const hasZip = /\b\d{5}\b/.test(lower)
  if (hasZip) return false
  const tokens = lower.split(/\s+/).filter((t) => t.length === 2)
  for (const t of tokens) {
    if (US_STATE_CODES.has(t)) return false
  }
  return true
}

function emptyResult(status: CensusGeocodeStatus): CensusGeocodeResult {
  return {
    latitude: null,
    longitude: null,
    zip5: null,
    city: null,
    county: null,
    stateCode: null,
    status,
  }
}

interface CensusAddressMatch {
  coordinates?: { x?: unknown; y?: unknown }
  addressComponents?: {
    city?: unknown
    state?: unknown
    zip?: unknown
  }
  geographies?: {
    Counties?: Array<{ NAME?: unknown; BASENAME?: unknown }>
  }
}

/** Visible for tests. */
export function parseCensusResponse(payload: unknown): CensusGeocodeResult {
  const matches = extractMatches(payload)
  if (matches.length === 0) {
    return emptyResult('failed')
  }
  const match = matches[0]
  const lat = numericOrNull(match.coordinates?.y)
  const lng = numericOrNull(match.coordinates?.x)
  const city = stringOrNull(match.addressComponents?.city)
  const stateCode = stringOrNull(match.addressComponents?.state)
  const zip5 = zip5OrNull(match.addressComponents?.zip)

  const counties = match.geographies?.Counties ?? []
  const firstCounty = counties[0]
  const countyName =
    stringOrNull(firstCounty?.NAME) ?? stringOrNull(firstCounty?.BASENAME)

  // We require lat AND lng to call it 'ok' — anything less and the
  // row is not useful for a map view.
  const status: CensusGeocodeStatus = lat !== null && lng !== null ? 'ok' : 'failed'

  return {
    latitude: lat,
    longitude: lng,
    zip5,
    city,
    county: countyName,
    stateCode,
    status,
  }
}

function extractMatches(payload: unknown): CensusAddressMatch[] {
  if (typeof payload !== 'object' || payload === null) return []
  const result = (payload as { result?: unknown }).result
  if (typeof result !== 'object' || result === null) return []
  const matches = (result as { addressMatches?: unknown }).addressMatches
  if (!Array.isArray(matches)) return []
  return matches as CensusAddressMatch[]
}

function numericOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number.parseFloat(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function zip5OrNull(value: unknown): string | null {
  const raw = stringOrNull(value)
  if (raw === null) return null
  const digits = raw.replace(/\D/g, '').slice(0, 5)
  return digits.length === 5 ? digits : null
}
