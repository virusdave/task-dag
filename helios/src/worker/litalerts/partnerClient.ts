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
  stateCodeOrOptions: string | { stateCode: string; includeOutOfStock?: boolean },
): Promise<LitAlertsProduct[]> {
  const opts =
    typeof stateCodeOrOptions === 'string'
      ? { stateCode: stateCodeOrOptions, includeOutOfStock: false }
      : { includeOutOfStock: false, ...stateCodeOrOptions }
  const params = new URLSearchParams({ state: opts.stateCode })
  if (opts.includeOutOfStock) params.set('includeOOS', 'true')
  const payload = await fetchPartnerJson(
    `/v1/brands/${encodeURIComponent(String(brandId))}/products?${params.toString()}`,
  )
  return ProductListResponseSchema.parse(payload).data
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
  stateCode: string,
): Promise<LitAlertsProduct[]> {
  const payload = await fetchPartnerJson(
    `/v1/retailers/${encodeURIComponent(String(retailerId))}/products?state=${encodeURIComponent(stateCode)}`,
  )
  return ProductListResponseSchema.parse(payload).data
}

async function fetchPartnerJson(path: string): Promise<unknown> {
  const token = loadPartnerApiTokenOrThrow()
  const url = `${PARTNER_API_BASE_URL}${path}`
  const requestLabel = `Lit Alerts partner ${path}`

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
