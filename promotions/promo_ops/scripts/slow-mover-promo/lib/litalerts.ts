/**
 * Minimal Lit Alerts client used by the slow-mover packet to enrich each SKU
 * in a candidate group with nearby + statewide competitor pricing.
 *
 * Mirrors the algorithm in `helios/src/worker/pricing/litAlertsMarket.ts` but
 * trimmed to the surface this packet actually needs:
 *
 *   - manufacturer (brand) directory + name resolver
 *   - dispensary directory with FBNYC-Midtown-anchored distance and
 *     classification into `near` / `mid` / `far` / `very_far` bands
 *   - paginated POST to `/Products/menulistings` for a given brandId +
 *     search term, in two passes: nearby (within 10mi) and statewide
 *   - per-listing post-tax price (post-tax = pre-tax * 1.13 unless the
 *     listing is already post-tax in our state, which it generally is not)
 *
 * Returned listing shape is what `lib/ladder.ts` consumes.
 */
import { readFileSync } from 'node:fs'

const DEFAULT_API_URL = 'https://public-api.litalerts.com'
const DEFAULT_STATE_CODE = 'NY'
const DEFAULT_STATE_ID = 265
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_TOKEN_PATHS = [
  '/Users/amp-local/.secret/litalerts/bearer-token',
  `${process.env.HOME ?? ''}/.secret/litalerts/bearer-token`,
]

// FBNYC Midtown storefront; same anchor used by the Helios pricing module.
const MIDTOWN_REFERENCE_COORDINATES = { latitude: 40.762318, longitude: -73.97676 } as const
// Canonical pricing-module distance bands (see helios/src/shared/domain/pricingGeneration.ts).
const NEAR_MAX_MILES = 1
const MID_MAX_MILES = 3
const FAR_MAX_MILES = 10
const POST_TAX_MULTIPLIER = 1.13

export type DistanceBand = 'near' | 'mid' | 'far' | 'very_far' | 'unknown'

export interface LitAlertsConfig {
  apiUrl: string
  bearerToken: string
  stateCode: string
  stateId: number
  timeoutMs: number
  userAgent: string
}

export function loadLitAlertsConfig(): LitAlertsConfig | null {
  const token =
    process.env.LITALERTS_BEARER_TOKEN?.trim() || readFirstReadableFile(DEFAULT_TOKEN_PATHS)
  if (!token) return null
  return {
    apiUrl: process.env.LITALERTS_API_URL?.trim() || DEFAULT_API_URL,
    bearerToken: token,
    stateCode: process.env.LITALERTS_STATE_CODE?.trim() || DEFAULT_STATE_CODE,
    stateId: Number.parseInt(process.env.LITALERTS_STATE_ID ?? `${DEFAULT_STATE_ID}`, 10),
    timeoutMs: Number.parseInt(process.env.LITALERTS_REQUEST_TIMEOUT_MS ?? `${DEFAULT_TIMEOUT_MS}`, 10),
    userAgent: process.env.LITALERTS_USER_AGENT?.trim() || 'slow-mover-promo/1.0',
  }
}

export interface CompetitorListing {
  listingId: number
  productName: string
  category: string | null
  brand: string | null
  prePrice: number
  postPrice: number
  weightLabel: string | null
  url: string | null
  dispensaryName: string | null
  dispensaryAddress: string | null
  dispensaryCity: string | null
  distanceMiles: number | null
  distanceBand: DistanceBand
  source: 'nearby' | 'statewide'
}

export interface DispensaryEntry {
  id: number
  name: string
  normalizedName: string
  address: string | null
  city: string | null
  latitude: number | null
  longitude: number | null
  distanceMiles: number | null
  distanceBand: DistanceBand
}

export interface DispensaryDirectory {
  byNormalizedName: Map<string, DispensaryEntry>
  withinTenMiles: DispensaryEntry[]
}

export interface ManufacturerEntry {
  id: number
  name: string
  normalizedName: string
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

async function fetchJson(
  config: LitAlertsConfig,
  path: string,
  init: { method: 'GET' | 'POST'; body?: string },
): Promise<unknown> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(`${config.apiUrl}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${config.bearerToken}`,
          'content-type': 'application/json; charset=utf-8',
          origin: 'https://brands.litalerts.com',
          referer: 'https://brands.litalerts.com/',
          'user-agent': config.userAgent,
        },
        body: init.body,
        signal: AbortSignal.timeout(config.timeoutMs),
      })
      const text = await response.text()
      if (!response.ok) {
        if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
          await delay(500 * (attempt + 1))
          continue
        }
        throw new Error(`Lit Alerts ${path} HTTP ${response.status}: ${truncate(text)}`)
      }
      return JSON.parse(text)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt < 3) {
        await delay(500 * (attempt + 1))
        continue
      }
      break
    }
  }
  throw lastError ?? new Error(`Lit Alerts ${path} failed`)
}

// ---------------------------------------------------------------------------
// directories (cached for the process lifetime)
// ---------------------------------------------------------------------------

let manufacturerCache: ManufacturerEntry[] | null = null
let dispensaryCache: DispensaryDirectory | null = null

export async function loadManufacturers(config: LitAlertsConfig): Promise<ManufacturerEntry[]> {
  if (manufacturerCache) return manufacturerCache
  const raw = (await fetchJson(
    config,
    `/Manufacturers/real?page=0&pagesize=2000&state=${encodeURIComponent(config.stateCode)}`,
    { method: 'GET' },
  )) as { manufacturers?: Array<{ id?: unknown; name?: unknown }> } | null
  const out: ManufacturerEntry[] = []
  for (const row of raw?.manufacturers ?? []) {
    const id = numberOrNull(row.id)
    const name = stringOrNull(row.name)
    if (id !== null && name !== null) {
      out.push({ id, name, normalizedName: normalizeKey(name) })
    }
  }
  manufacturerCache = out
  return out
}

export async function loadDispensaryDirectory(
  config: LitAlertsConfig,
): Promise<DispensaryDirectory> {
  if (dispensaryCache) return dispensaryCache
  const raw = (await fetchJson(config, '/Dispensaries/alllocations', {
    method: 'POST',
    body: JSON.stringify({
      MedRecFilter: 2,
      StateId: config.stateId,
      ZipCodesFilter: null,
      ZipRadiusFilter: null,
    }),
  })) as Array<Record<string, unknown>>

  const byNormalizedName = new Map<string, DispensaryEntry>()
  const withinTenMiles: DispensaryEntry[] = []

  for (const item of raw) {
    const id = numberOrNull(item.id)
    const name = stringOrNull(item.name)
    if (id === null || name === null) continue

    const latitude = numberOrNull(item.latitude)
    const longitude = numberOrNull(item.longitude)
    const distanceMiles =
      latitude !== null && longitude !== null
        ? roundTo(
            haversineMiles(
              MIDTOWN_REFERENCE_COORDINATES.latitude,
              MIDTOWN_REFERENCE_COORDINATES.longitude,
              latitude,
              longitude,
            ),
            2,
          )
        : null
    const entry: DispensaryEntry = {
      id,
      name,
      normalizedName: normalizeKey(name),
      address: stringOrNull(item.address),
      city: stringOrNull(item.city),
      latitude,
      longitude,
      distanceMiles,
      distanceBand: classifyDistanceBand(distanceMiles),
    }
    if (entry.normalizedName) {
      byNormalizedName.set(entry.normalizedName, entry)
    }
    if (entry.distanceMiles !== null && entry.distanceMiles <= FAR_MAX_MILES) {
      withinTenMiles.push(entry)
    }
  }

  dispensaryCache = { byNormalizedName, withinTenMiles }
  return dispensaryCache
}

// ---------------------------------------------------------------------------
// public lookup
// ---------------------------------------------------------------------------

export async function resolveBrandId(
  config: LitAlertsConfig,
  brandName: string,
): Promise<number | null> {
  const normalized = normalizeKey(brandName)
  if (!normalized) return null
  const manufacturers = await loadManufacturers(config)
  const exact = manufacturers.find((m) => m.normalizedName === normalized)
  if (exact) return exact.id
  // Tolerant: try contains-match if no exact normalized hit.
  const contains = manufacturers.find(
    (m) =>
      m.normalizedName.includes(normalized) ||
      (normalized.length >= 4 && normalized.includes(m.normalizedName)),
  )
  return contains?.id ?? null
}

export interface ListMenuListingsInput {
  brandId: number
  searchTerm: string
  scope: 'nearby' | 'statewide'
  maxPages?: number
  pageSize?: number
}

export async function listMenuListings(
  config: LitAlertsConfig,
  input: ListMenuListingsInput,
): Promise<CompetitorListing[]> {
  const directory = await loadDispensaryDirectory(config)
  const dispensaryIds =
    input.scope === 'nearby' ? directory.withinTenMiles.map((d) => d.id) : null
  const out: CompetitorListing[] = []
  const pageSize = input.pageSize ?? 100
  const maxPages = input.maxPages ?? 2

  for (let page = 0; page < maxPages; page += 1) {
    const payload = {
      brandIDs: [input.brandId],
      dispensaryIDs: input.scope === 'statewide' ? null : dispensaryIds,
      filters: {
        Availability: 'All',
        Brand: `[${input.brandId}]`,
        ...(input.scope === 'statewide' || !dispensaryIds
          ? {}
          : { Dispensary: JSON.stringify(dispensaryIds) }),
        Image: 'All',
        MedRec: input.scope === 'statewide' ? 'All' : 'Rec',
        Name: input.searchTerm,
        ShowHiddenDisps: 'false',
        ShowStaleItems: 'False',
        StateID: String(config.stateId),
      },
      page,
      pagesize: pageSize,
      sortfields: ['Name'],
      stateID: config.stateId,
    }
    const raw = (await fetchJson(config, '/Products/menulistings', {
      method: 'POST',
      body: JSON.stringify(payload),
    })) as Array<Record<string, unknown>> | { listings?: Array<Record<string, unknown>> } | null

    const items = Array.isArray(raw) ? raw : (raw?.listings ?? [])
    for (const item of items) {
      const flattened = flattenListing(item, directory, input.scope)
      out.push(...flattened)
    }
    if (items.length < pageSize) break
  }

  return dedupe(out)
}

function flattenListing(
  item: Record<string, unknown>,
  directory: DispensaryDirectory,
  source: 'nearby' | 'statewide',
): CompetitorListing[] {
  const id = numberOrNull(item.id)
  const productName = stringOrNull(item.name) ?? '(unnamed listing)'
  const category = stringOrNull(item.category)
  const brand = stringOrNull(item.brand)
  const url = stringOrNull(item.url)
  const dispensaryName = stringOrNull(item.dispensaryName)
  const dispensaryEntry = dispensaryName ? directory.byNormalizedName.get(normalizeKey(dispensaryName)) : undefined
  const configs = Array.isArray(item.configs) ? (item.configs as Array<Record<string, unknown>>) : []
  if (id === null || configs.length === 0) return []

  const out: CompetitorListing[] = []
  for (const cfg of configs) {
    const prePrice = parsePrice(cfg.salePrice) ?? parsePrice(cfg.price)
    if (prePrice === null) continue
    const weightLabel = stringOrNull(cfg.weight)
    const postPrice = roundTo(prePrice * POST_TAX_MULTIPLIER, 2)
    out.push({
      listingId: id,
      productName,
      category,
      brand,
      prePrice,
      postPrice,
      weightLabel,
      url,
      dispensaryName,
      dispensaryAddress: dispensaryEntry?.address ?? null,
      dispensaryCity: dispensaryEntry?.city ?? null,
      distanceMiles: dispensaryEntry?.distanceMiles ?? null,
      distanceBand: dispensaryEntry?.distanceBand ?? 'unknown',
      source,
    })
  }
  return out
}

function dedupe(listings: CompetitorListing[]): CompetitorListing[] {
  const seen = new Set<string>()
  const out: CompetitorListing[] = []
  for (const listing of listings) {
    const key = `${listing.listingId}:${listing.weightLabel ?? ''}:${listing.prePrice}:${listing.dispensaryName ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(listing)
  }
  return out
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function classifyDistanceBand(distanceMiles: number | null): DistanceBand {
  if (distanceMiles === null || !Number.isFinite(distanceMiles)) return 'unknown'
  if (distanceMiles <= NEAR_MAX_MILES) return 'near'
  if (distanceMiles <= MID_MAX_MILES) return 'mid'
  if (distanceMiles <= FAR_MAX_MILES) return 'far'
  return 'very_far'
}

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadiusMiles = 3958.7613
  const toRad = (x: number) => (x * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * earthRadiusMiles * Math.asin(Math.sqrt(a))
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function parsePrice(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function truncate(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 239)}…`
}

function readFirstReadableFile(paths: string[]): string | null {
  for (const path of paths) {
    if (!path) continue
    try {
      const value = readFileSync(path, 'utf8').trim()
      if (value) return value
    } catch {
      continue
    }
  }
  return null
}
