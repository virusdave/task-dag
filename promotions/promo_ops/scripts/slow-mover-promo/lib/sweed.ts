/**
 * Minimal Sweed RPC + Cube BI client for the slow-mover promo packet generator.
 *
 * This intentionally mirrors the shape used by the Helios worker
 * (`helios/src/server/catalog/liveRecentSales.ts`) so the entire module can
 * later be lifted into Helios with only an env-config rewrite.
 *
 * Design rules followed here (so future Helios reuse stays trivial):
 *   - Every Sweed RPC goes through `callSweedRpc`; no inline fetches.
 *   - All site-scoped operations run inside `runInDealerSession`, which serializes
 *     dealer-context switches behind a single async lock so two concurrent reads
 *     can never see the wrong dealer.
 *   - Cube load + totals queries share one BI JWT lifecycle helper.
 *   - No prices, brands, categories, or HTML are produced here. This module
 *     exposes only transport + dealer-scope primitives.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const DEFAULT_SWEED_API_URL = 'https://prime.sweedpos.com/api/'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_AUTH_TOKEN_PATHS = [
  '/Users/amp-local/.secret/sweed/auth-token',
  `${process.env.HOME ?? ''}/.secret/sweed/auth-token`,
]

export interface SweedClientConfig {
  apiUrl: string
  authToken: string
  requestTimeoutMs: number
  userAgent: string
}

export function loadSweedClientConfig(): SweedClientConfig {
  const authToken =
    process.env.SWEED_AUTH_TOKEN?.trim() || readFirstReadableFile(DEFAULT_AUTH_TOKEN_PATHS)
  if (!authToken) {
    throw new Error(
      `SWEED_AUTH_TOKEN missing. Set it or write the token to one of: ${DEFAULT_AUTH_TOKEN_PATHS.join(', ')}`,
    )
  }

  return {
    apiUrl: process.env.SWEED_API_URL?.trim() || DEFAULT_SWEED_API_URL,
    authToken,
    requestTimeoutMs: Number.parseInt(
      process.env.SWEED_REQUEST_TIMEOUT_MS ?? `${DEFAULT_REQUEST_TIMEOUT_MS}`,
      10,
    ),
    userAgent: process.env.SWEED_USER_AGENT?.trim() || 'slow-mover-promo/1.0',
  }
}

interface RpcEnvelope<TResult> {
  error?: { message?: string | null } | null
  result?: TResult
}

export async function callSweedRpc<TResult>(
  config: SweedClientConfig,
  name: string,
  params?: Record<string, unknown>,
): Promise<TResult> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const body = JSON.stringify(
        params === undefined
          ? { auth: config.authToken, id: randomUUID(), name }
          : { auth: config.authToken, id: randomUUID(), name, params },
      )
      const response = await fetch(config.apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': config.userAgent },
        body,
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      })
      const text = await response.text()
      if (!response.ok) {
        if (attempt < 2 && isRetryableStatus(response.status)) {
          await delay(300 * (attempt + 1))
          continue
        }
        throw new Error(`${name} HTTP ${response.status}: ${truncate(text)}`)
      }

      const envelope = JSON.parse(text) as RpcEnvelope<TResult>
      if (envelope.error) {
        throw new Error(`${name} failed: ${envelope.error.message ?? 'unknown Sweed RPC error'}`)
      }
      if (envelope.result === undefined) {
        throw new Error(`${name} returned no result payload`)
      }
      return envelope.result
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt < 2 && isRetryableMessage(lastError.message)) {
        await delay(300 * (attempt + 1))
        continue
      }
      break
    }
  }
  throw lastError ?? new Error(`${name} failed`)
}

let sweedSessionLock: Promise<void> = Promise.resolve()

/**
 * Serialize all dealer-scoped operations behind a session-wide lock and
 * verify the dealer context with `store.auth.dealer.set` before running the
 * caller's block. Sweed's session is single-dealer, so concurrent callers
 * MUST take this lock to avoid silently reading the wrong site's data.
 */
export async function runInDealerSession<TResult>(
  config: SweedClientConfig,
  dealerId: number,
  block: () => Promise<TResult>,
): Promise<TResult> {
  const next = sweedSessionLock.catch(() => undefined).then(async () => {
    const dealerSet = await callSweedRpc<{ user?: { currentDealerId?: number | string; currentDealerName?: string | null } }>(
      config,
      'store.auth.dealer.set',
      { dealerId },
    )
    const observed = Number(dealerSet.user?.currentDealerId)
    if (!Number.isFinite(observed) || observed !== dealerId) {
      throw new Error(
        `Sweed dealer context mismatch: expected ${dealerId}, got ${dealerSet.user?.currentDealerId ?? 'unknown'} (${dealerSet.user?.currentDealerName ?? ''})`.trim(),
      )
    }
    return block()
  })
  sweedSessionLock = next.then(() => undefined, () => undefined)
  return next
}

let cubeJwt: { value: string; fetchedAt: number } | null = null
const CUBE_JWT_TTL_MS = 5 * 60_000

export async function getCubeJwt(config: SweedClientConfig): Promise<string> {
  if (cubeJwt && Date.now() - cubeJwt.fetchedAt < CUBE_JWT_TTL_MS) {
    return cubeJwt.value
  }
  const result = await callSweedRpc<string>(config, 'store.bi.auth.jwt')
  cubeJwt = { value: result, fetchedAt: Date.now() }
  return result
}

export interface CubeQueryFilter {
  member: string
  operator: string
  values: string[]
}

export interface CubeTimeDimension {
  dateRange: [string, string]
  dimension: string
  granularity?: string
}

export interface CubeQuery {
  dimensions?: string[]
  filters?: CubeQueryFilter[]
  limit?: number
  measures: string[]
  offset?: number
  order?: Record<string, 'asc' | 'desc'>
  renewQuery?: boolean
  timeDimensions?: CubeTimeDimension[]
  timezone?: string
  total?: boolean
}

export interface CubeRow {
  [key: string]: string | number | null | undefined
}

export interface CubeLoadResult {
  data: CubeRow[]
  query: CubeQuery
}

export async function callCubeLoad(
  config: SweedClientConfig,
  jwt: string,
  query: CubeQuery,
): Promise<CubeLoadResult> {
  const url = new URL('/cube/v1/load', config.apiUrl)
  url.searchParams.set('baseRequestId', randomUUID())
  url.searchParams.set('cache', 'no-cache')
  url.searchParams.set('query', JSON.stringify(query))
  url.searchParams.set('queryType', 'multi')

  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          authorization: jwt,
          'user-agent': config.userAgent,
        },
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      })
      const text = await response.text()
      if (!response.ok) {
        if (attempt < 2 && isRetryableStatus(response.status)) {
          await delay(300 * (attempt + 1))
          continue
        }
        throw new Error(`cube/v1/load HTTP ${response.status}: ${truncate(text)}`)
      }
      const payload = JSON.parse(text) as { results?: Array<{ data?: CubeRow[]; query?: CubeQuery }> }
      const result = payload.results?.[0]
      if (!result) {
        throw new Error('cube/v1/load returned no result rows')
      }
      return { data: result.data ?? [], query: result.query ?? query }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt < 2 && isRetryableMessage(lastError.message)) {
        await delay(300 * (attempt + 1))
        continue
      }
      break
    }
  }
  throw lastError ?? new Error('cube/v1/load failed')
}

function isRetryableStatus(status: number): boolean {
  return status === 403 || status === 429 || (status >= 500 && status <= 504)
}

function isRetryableMessage(message: string): boolean {
  return /timeout|fetch failed|network|403|429|5\d\d|Cloudflare|invalid json|ECONNRESET/i.test(message)
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
