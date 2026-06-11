import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { z } from 'zod'

import { RetryableWorkerError } from '../runtime/errors.js'

const PARTNER_API_BASE_URL = 'https://partnerapi.litalerts.com'
const PARTNER_API_TOKEN_ENV_NAME = 'LITALERTS_PARTNER_API_TOKEN'
const PARTNER_API_TOKEN_FILE_PATH = join(homedir(), '.secret', 'litalerts', 'partner-api-token')
const PARTNER_API_REQUEST_TIMEOUT_MS = 30000
const PARTNER_API_CACHE_TTL_MS = 10 * 60 * 1000
/**
 * Transient transport failures (timeouts, 5xx, 429, abort, socket
 * hang-up) get an inline retry-with-backoff loop here so a single
 * blip from the partner API doesn't fail the whole packet-generation
 * job. After `PARTNER_API_MAX_TRANSPORT_ATTEMPTS` retries we still
 * surface a `RetryableWorkerError` so the queue's own per-job retry
 * (with much longer backoff) can pick it up. "timed out, gave up"
 * is never an acceptable end state for live operator-driven work.
 */
const PARTNER_API_MAX_TRANSPORT_ATTEMPTS = 4
const PARTNER_API_RETRY_BASE_DELAY_MS = 750

const BrandSchema = z.object({
  id: z.coerce.number().int().positive(),
  name: z.string().trim().min(1),
  states: z
    .string()
    .nullable()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    ),
}).passthrough()

const BrandsResponseSchema = z.object({
  data: z.array(BrandSchema),
})

export type LitAlertsBrand = z.infer<typeof BrandSchema>

const ProductConfigSchema = z.object({
  amount: z.union([z.number(), z.string()]).nullable().optional(),
  units: z.string().nullable().optional(),
  recreational: z.boolean().nullable().optional(),
  medical: z.boolean().nullable().optional(),
  normalPrice: z.union([z.number(), z.string()]).nullable().optional(),
  salePrice: z.union([z.number(), z.string()]).nullable().optional(),
  currentStock: z.union([z.number(), z.string()]).nullable().optional(),
}).passthrough()

const ProductSchema = z.object({
  id: z.coerce.number().int().positive(),
  name: z.string().trim().min(1),
  brand: z.string().nullable().optional(),
  brandId: z.coerce.number().int().positive().nullable().optional(),
  retailerId: z.coerce.number().int().positive().nullable().optional(),
  medicalURL: z.string().nullable().optional(),
  recreationalURL: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  // Per-product primary image URL. Added by LitAlerts to the
  // /v1/brands/:id/products response in May 2026; previously we had
  // to scrape these out of the (Cognito-auth-gated) dashboard
  // /Products/menulistings endpoint via
  // `scripts/litalerts-backfill-product-images.mts`. The new
  // partner-API field is the source of truth going forward, and
  // we record it onto the typed `litalerts_products.image_url` column
  // (via the structured ingest — phase F3; it used to land on the
  // now-being-drained raw_product_json blob) and propagate it into
  // `fuzzy_skus.raw_input_jsonb.imageUrl` (via the
  // litalerts-products-to-fuzzy-skus backfill) so the catalog
  // market-data review can decorate candidates without a separate
  // image-images table JOIN.
  imageURL: z.string().nullable().optional(),
  configs: z.array(ProductConfigSchema).default([]),
}).passthrough()

const ProductListResponseSchema = z.object({
  data: z.array(ProductSchema),
})

export type LitAlertsProduct = z.infer<typeof ProductSchema>
export type LitAlertsProductConfig = z.infer<typeof ProductConfigSchema>

const RetailerSchema = z.object({
  id: z.coerce.number().int().positive(),
  name: z.string().trim().min(1),
  address: z.string().nullable().optional(),
  medical: z.boolean().nullable().optional(),
  recreational: z.boolean().nullable().optional(),
}).passthrough()

const RetailersResponseSchema = z.object({
  data: z.array(RetailerSchema),
})

export type LitAlertsRetailer = z.infer<typeof RetailerSchema>

interface CacheEntry<TValue> {
  expiresAt: number
  value: TValue
}

const brandsCache = new Map<string, CacheEntry<LitAlertsBrand[]>>()
const retailersCache = new Map<string, CacheEntry<LitAlertsRetailer[]>>()

export function resetLitAlertsPartnerClientCachesForTest(): void {
  brandsCache.clear()
  retailersCache.clear()
}

export function tryLoadPartnerApiToken(): string | null {
  const envValue = process.env[PARTNER_API_TOKEN_ENV_NAME]?.trim()
  if (envValue) {
    return envValue
  }
  try {
    const fileValue = readFileSync(PARTNER_API_TOKEN_FILE_PATH, 'utf8').trim()
    return fileValue || null
  } catch {
    return null
  }
}

export function hasPartnerApiToken(): boolean {
  return tryLoadPartnerApiToken() !== null
}

function loadPartnerApiTokenOrThrow(): string {
  const token = tryLoadPartnerApiToken()
  if (!token) {
    throw new RetryableWorkerError(
      `Lit Alerts partner API token is missing. Set ${PARTNER_API_TOKEN_ENV_NAME} or populate ${PARTNER_API_TOKEN_FILE_PATH}.`,
    )
  }
  return token
}

export async function listBrandsForState(stateCode: string): Promise<LitAlertsBrand[]> {
  const cacheKey = stateCode.toUpperCase()
  const now = Date.now()
  const cached = brandsCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return cached.value
  }

  const payload = await fetchPartnerJson(`/v1/brands?state=${encodeURIComponent(stateCode)}`)
  const parsed = BrandsResponseSchema.parse(payload)
  brandsCache.set(cacheKey, { expiresAt: now + PARTNER_API_CACHE_TTL_MS, value: parsed.data })
  return parsed.data
}

export async function listBrandProducts(
  brandId: number,
  stateCodeOrOptions:
    | string
    | { stateCode: string; includeOutOfStock?: boolean; categoryFilter?: string; subcategoryFilter?: string },
): Promise<LitAlertsProduct[]> {
  const opts =
    typeof stateCodeOrOptions === 'string'
      ? { stateCode: stateCodeOrOptions, includeOutOfStock: false }
      : { includeOutOfStock: false, ...stateCodeOrOptions }
  const params = new URLSearchParams({ state: opts.stateCode })
  if (opts.includeOutOfStock) params.set('includeOOS', 'true')
  if (opts.categoryFilter) params.set('categoryFilter', opts.categoryFilter)
  if (opts.subcategoryFilter) params.set('subcategoryFilter', opts.subcategoryFilter)
  const payload = await fetchPartnerJson(
    `/v1/brands/${encodeURIComponent(String(brandId))}/products?${params.toString()}`,
  )
  return ProductListResponseSchema.parse(payload).data
}

const SystemListSchema = z.array(z.string())

export async function listSystemCategories(): Promise<string[]> {
  const payload = await fetchPartnerJson('/v1/categories')
  return SystemListSchema.parse(payload)
}

export async function listSystemSubcategories(category: string): Promise<string[]> {
  const payload = await fetchPartnerJson(`/v1/subcategories?category=${encodeURIComponent(category)}`)
  return SystemListSchema.parse(payload)
}

export async function listRetailers(stateCode: string): Promise<LitAlertsRetailer[]> {
  const cacheKey = stateCode.toUpperCase()
  const now = Date.now()
  const cached = retailersCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return cached.value
  }

  const payload = await fetchPartnerJson(`/v1/retailers?state=${encodeURIComponent(stateCode)}`)
  const parsed = RetailersResponseSchema.parse(payload)
  retailersCache.set(cacheKey, { expiresAt: now + PARTNER_API_CACHE_TTL_MS, value: parsed.data })
  return parsed.data
}

export async function listRetailerProducts(
  retailerId: number,
  stateCodeOrOptions: string | { stateCode: string; brandIds?: number[]; includeOutOfStock?: boolean },
): Promise<LitAlertsProduct[]> {
  const opts =
    typeof stateCodeOrOptions === 'string' ? { stateCode: stateCodeOrOptions } : stateCodeOrOptions
  const params = new URLSearchParams({ state: opts.stateCode })
  // `brandIds` (plural, comma-separated) restricts the per-retailer menu to
  // just those brands server-side. Confirmed live June 2026: a single-brand
  // filter shrinks the payload ~30x (≈600KB full menu → ≈20KB), which is what
  // makes the nearest-retailer fan-out in litAlertsMarket cheap. The singular
  // `brandId` form is silently ignored by the partner API, so always send the
  // plural key.
  if (opts.brandIds && opts.brandIds.length > 0) {
    params.set('brandIds', opts.brandIds.join(','))
  }
  if (opts.includeOutOfStock) {
    params.set('includeOOS', 'true')
  }
  const payload = await fetchPartnerJson(
    `/v1/retailers/${encodeURIComponent(String(retailerId))}/products?${params.toString()}`,
  )
  return ProductListResponseSchema.parse(payload).data
}

async function fetchPartnerJson(path: string): Promise<unknown> {
  const token = loadPartnerApiTokenOrThrow()
  const url = `${PARTNER_API_BASE_URL}${path}`
  const requestLabel = `Lit Alerts partner ${path}`

  // Inline retry-with-sub-exponential-backoff loop. Every transient
  // condition (timeout, 5xx, 429, abort, socket hang-up, malformed
  // JSON body) used to surface as a single `RetryableWorkerError`,
  // which was correct in principle but, in practice, the caller in
  // `generatePendingPurchasePacketJob` was swallowing every error
  // into `marketAvailability='error'` for the row and shipping the
  // packet with empty market evidence. We now retry inline so a
  // single blip never escalates that far. If we exhaust every
  // attempt we still throw `RetryableWorkerError` so the worker
  // loop's outer per-job retry can pick up the slack.
  let lastTransientError: RetryableWorkerError | null = null
  for (let attempt = 1; attempt <= PARTNER_API_MAX_TRANSPORT_ATTEMPTS; attempt++) {
    try {
      return await attemptFetchPartnerJson({ token, url, requestLabel })
    } catch (error) {
      if (error instanceof RetryableWorkerError) {
        lastTransientError = error
        if (attempt < PARTNER_API_MAX_TRANSPORT_ATTEMPTS) {
          // Sub-exponential power-law backoff: base * attempt^1.5
          // (repo-wide standing rule — see workerLoop.getRetryDelayMs).
          const delayMs = Math.round(PARTNER_API_RETRY_BASE_DELAY_MS * Math.pow(attempt, 1.5))
          console.warn(
            `[litalerts.partnerClient] ${requestLabel} attempt ${attempt}/${PARTNER_API_MAX_TRANSPORT_ATTEMPTS} ` +
              `failed transiently (${error.message}); retrying in ${delayMs}ms`,
          )
          await sleep(delayMs)
          continue
        }
      }
      throw error
    }
  }
  // Unreachable in practice (the loop either returns or throws),
  // but TS needs a terminal throw for narrowing.
  throw lastTransientError ??
    new RetryableWorkerError(`${requestLabel} exhausted ${PARTNER_API_MAX_TRANSPORT_ATTEMPTS} attempts with no result.`)
}

async function attemptFetchPartnerJson(input: {
  requestLabel: string
  token: string
  url: string
}): Promise<unknown> {
  const { requestLabel, token, url } = input
  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      method: 'GET',
      signal: AbortSignal.timeout(PARTNER_API_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    if (isRetryableTransportError(error)) {
      throw new RetryableWorkerError(
        `${requestLabel} transport failed: ${error instanceof Error ? error.message : 'unknown transport error'}`,
      )
    }
    throw error
  }

  const responseText = await response.text()
  if (!response.ok) {
    const message = `${requestLabel} failed: HTTP ${response.status} ${response.statusText} ${truncate(responseText)}`
    if (isRetryableStatus(response.status)) {
      throw new RetryableWorkerError(message)
    }
    throw new Error(message)
  }

  try {
    return JSON.parse(responseText)
  } catch {
    throw new RetryableWorkerError(`${requestLabel} returned invalid JSON: ${truncate(responseText)}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

function isRetryableTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return error.name === 'AbortError'
    || error.name === 'TimeoutError'
    || /timed out|timeout|network|fetch failed|socket hang up/i.test(error.message)
}

function truncate(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 240) {
    return normalized
  }
  return `${normalized.slice(0, 239)}…`
}
