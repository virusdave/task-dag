import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import { getWorkerEnv } from '../config/env.js'
import { RetryableWorkerError } from '../runtime/errors.js'

const DealerSetResultSchema = z.object({
  user: z.object({
    currentDealerId: z.coerce.number().int(),
    currentDealerName: z.string().nullable().optional(),
  }),
})

const SweedProductSummarySchema = z.object({
  id: z.coerce.number().int(),
  price: z.coerce.number().nullable().optional(),
  priceInfo: z.object({ actualPrice: z.coerce.number().nullable().optional() }).passthrough().nullable().optional(),
}).passthrough()

const SweedProductDetailWrappedSchema = z.object({ product: SweedProductSummarySchema }).passthrough()

interface RpcErrorBody {
  message?: string
}

interface RpcEnvelope<TResult> {
  error?: RpcErrorBody
  result?: TResult
}

export async function editProductGroupDescription(groupId: number, description: string): Promise<unknown> {
  return callSweedRpc('store.product.group.edit', { description, id: groupId })
}

export async function callSweedRpcForDealer<TResult>(
  dealerId: number,
  name: string,
  params: Record<string, unknown>,
): Promise<TResult> {
  await ensureDealerContext(dealerId)
  return callSweedRpcRaw(name, params)
}

export async function readSweedDealerContext(
  dealerId: number,
): Promise<{ dealerId: number; dealerName: string | null }> {
  const result = DealerSetResultSchema.parse(await callDealerSet(dealerId))
  return {
    dealerId: result.user.currentDealerId,
    dealerName: result.user.currentDealerName ?? null,
  }
}

export async function editProductPrice(productId: number, price: number): Promise<unknown> {
  return callSweedRpc('store.product.edit', { id: productId, price })
}

export async function getProductGroupDetail(groupId: number): Promise<unknown> {
  return callSweedRpc('store.product.group.get', { id: groupId })
}

export async function getProductDetail(productId: number): Promise<unknown> {
  return callSweedRpc('store.product.get', { id: productId })
}

export async function waitForProductPrice(productId: number, targetPrice: number): Promise<unknown> {
  let lastObservedPrice: number | null = null

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const detail = await getProductDetail(productId)
    const parsed = unwrapProductDetail(detail)
    const currentPrice = parsed.priceInfo?.actualPrice ?? parsed.price ?? null
    lastObservedPrice = currentPrice

    if (currentPrice !== null && Math.abs(currentPrice - targetPrice) < 0.01) {
      return detail
    }

    if (attempt < 9) {
      await delay(500)
    }
  }

  throw new RetryableWorkerError(
    `Product ${productId} price never settled at ${targetPrice.toFixed(2)}; last observed ${formatObservedPrice(lastObservedPrice)}.`,
  )
}

export async function verifySweedSession(): Promise<void> {
  const env = getWorkerEnv()
  if (!env.sweedAuthToken) {
    throw new Error('SWEED_AUTH_TOKEN is required for Sweed-backed worker jobs.')
  }

  await callSweedRpcRaw('store.auth.initial.data.get')
  await ensureStateDealerContext()
}

async function callSweedRpc<TResult>(name: string, params: Record<string, unknown>): Promise<TResult> {
  await ensureStateDealerContext()

  return callSweedRpcRaw(name, params)
}

async function callSweedRpcRaw<TResult>(name: string, params?: Record<string, unknown>): Promise<TResult> {
  const env = getWorkerEnv()
  if (!env.sweedAuthToken) {
    throw new Error('SWEED_AUTH_TOKEN is required for Sweed-backed worker jobs.')
  }

  let response: Response
  try {
    response = await fetch(env.sweedApiUrl, {
      body: JSON.stringify({
        auth: env.sweedAuthToken,
        id: randomUUID(),
        name,
        ...(params === undefined ? {} : { params }),
      }),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'helios-worker/1.0',
      },
      method: 'POST',
      signal: AbortSignal.timeout(env.sweedRequestTimeoutMs),
    })
  } catch (error) {
    throw new RetryableWorkerError(buildTransportErrorMessage(name, error))
  }

  const responseText = await response.text()
  if (!response.ok) {
    const message = `${name} returned HTTP ${response.status}: ${truncate(responseText)}`
    if (isRetryableStatusCode(response.status)) {
      throw new RetryableWorkerError(message)
    }
    throw new Error(message)
  }

  let envelope: RpcEnvelope<TResult>
  try {
    envelope = parseRpcEnvelope<TResult>(responseText)
  } catch (error) {
    const message = buildInvalidResponseMessage(name, responseText)
    if (error instanceof SyntaxError) {
      throw new RetryableWorkerError(message)
    }
    throw new Error(message)
  }

  if (envelope.error) {
    throw new Error(`${name} failed: ${envelope.error.message ?? 'Unknown Sweed RPC error.'}`)
  }
  if (envelope.result === undefined) {
    throw new Error(`${name} returned no result payload.`)
  }

  return envelope.result
}

async function ensureStateDealerContext(): Promise<void> {
  const env = getWorkerEnv()
  await ensureDealerContext(env.sweedStateDealerId)
}

async function ensureDealerContext(dealerId: number): Promise<void> {
  const result = DealerSetResultSchema.parse(await callDealerSet(dealerId))
  if (result.user.currentDealerId !== dealerId) {
    throw new Error(
      `Sweed dealer context mismatch. Expected ${dealerId}, got ${result.user.currentDealerId} ${result.user.currentDealerName ?? ''}`.trim(),
    )
  }
}

async function callDealerSet(dealerId: number): Promise<unknown> {
  const env = getWorkerEnv()
  if (!env.sweedAuthToken) {
    throw new Error('SWEED_AUTH_TOKEN is required for Sweed-backed worker jobs.')
  }

  let response: Response
  try {
    response = await fetch(env.sweedApiUrl, {
      body: JSON.stringify({
        auth: env.sweedAuthToken,
        id: randomUUID(),
        name: 'store.auth.dealer.set',
        params: { dealerId },
      }),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'helios-worker/1.0',
      },
      method: 'POST',
      signal: AbortSignal.timeout(env.sweedRequestTimeoutMs),
    })
  } catch (error) {
    throw new RetryableWorkerError(buildTransportErrorMessage('store.auth.dealer.set', error))
  }

  const responseText = await response.text()
  if (!response.ok) {
    const message = `store.auth.dealer.set returned HTTP ${response.status}: ${truncate(responseText)}`
    if (isRetryableStatusCode(response.status)) {
      throw new RetryableWorkerError(message)
    }
    throw new Error(message)
  }

  const envelope = parseRpcEnvelope<unknown>(responseText)
  if (envelope.error) {
    throw new Error(`store.auth.dealer.set failed: ${envelope.error.message ?? 'Unknown Sweed RPC error.'}`)
  }
  if (envelope.result === undefined) {
    throw new Error('store.auth.dealer.set returned no result payload.')
  }
  return envelope.result
}

function buildInvalidResponseMessage(name: string, responseText: string): string {
  return `${name} returned an invalid JSON response: ${truncate(responseText)}`
}

function unwrapProductDetail(detail: unknown): z.infer<typeof SweedProductSummarySchema> {
  const wrapped = SweedProductDetailWrappedSchema.safeParse(detail)
  if (wrapped.success) {
    return wrapped.data.product
  }
  return SweedProductSummarySchema.parse(detail)
}

function buildTransportErrorMessage(name: string, error: unknown): string {
  if (error instanceof Error && error.message) {
    return `${name} transport failed: ${error.message}`
  }
  return `${name} transport failed.`
}

function isRetryableStatusCode(statusCode: number): boolean {
  return statusCode === 403 || statusCode === 429 || (statusCode >= 500 && statusCode <= 504)
}

function parseRpcEnvelope<TResult>(responseText: string): RpcEnvelope<TResult> {
  return JSON.parse(responseText) as RpcEnvelope<TResult>
}

function truncate(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 240) {
    return normalized
  }
  return `${normalized.slice(0, 239)}…`
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

function formatObservedPrice(value: number | null): string {
  if (value === null) {
    return 'null'
  }

  return value.toFixed(2)
}
