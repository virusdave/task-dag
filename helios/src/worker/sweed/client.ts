import { z } from 'zod'

import { getWorkerEnv } from '../config/env.js'
import { RetryableWorkerError } from '../runtime/errors.js'
import {
  callSweedRpc as callSweedRpcForDealerImpl,
  callSweedRpcRaw,
  ensureDealerContext as ensureDealerContextImpl,
} from './rpc.js'
import { hasActiveSweedSession, withSweedSession } from './session.js'
import { runWithSweedSessionLock } from './sessionLock.js'

const DealerSetResultSchema = z.object({
  user: z.object({
    currentDealerId: z.coerce.number().int(),
    currentDealerName: z.string().nullable().optional(),
  }),
})

const SweedProductSummarySchema = z
  .object({
    id: z.coerce.number().int(),
    price: z.coerce.number().nullable().optional(),
    priceInfo: z
      .object({ actualPrice: z.coerce.number().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

const SweedProductDetailWrappedSchema = z.object({ product: SweedProductSummarySchema }).passthrough()

export async function editProductGroupDescription(groupId: number, description: string): Promise<unknown> {
  return callOnStateDealer('store.product.group.edit', { description, id: groupId })
}

export async function callSweedRpcForDealer<TResult>(
  dealerId: number,
  name: string,
  params: Record<string, unknown>,
): Promise<TResult> {
  return callSweedRpcForDealerImpl<TResult>(dealerId, name, params)
}

export async function readSweedDealerContext(
  dealerId: number,
): Promise<{ dealerId: number; dealerName: string | null }> {
  return runWithDealerSerialization(async () => {
    const raw = await callSweedRpcRaw<unknown>('store.auth.dealer.set', { dealerId })
    const result = DealerSetResultSchema.parse(raw)
    return {
      dealerId: result.user.currentDealerId,
      dealerName: result.user.currentDealerName ?? null,
    }
  })
}

export async function editProductPrice(productId: number, price: number): Promise<unknown> {
  return callOnStateDealer('store.product.edit', { id: productId, price })
}

export async function getProductGroupDetail(groupId: number): Promise<unknown> {
  return callOnStateDealer('store.product.group.get', { id: groupId })
}

export async function getProductDetail(productId: number): Promise<unknown> {
  return callOnStateDealer('store.product.get', { id: productId })
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

/**
 * Light-weight readiness probe. Opens a fresh per-call session if
 * credentials are configured (so we exercise the real login path),
 * otherwise reuses the legacy shared token. Either way it issues
 * `store.auth.initial.data.get` plus a state-dealer pin to confirm
 * the credentials work end-to-end.
 */
export async function verifySweedSession(): Promise<void> {
  const env = getWorkerEnv()
  const hasCredentials = env.sweedLoginEmail !== null && env.sweedLoginPassword !== null
  if (!hasCredentials && !env.sweedAuthToken) {
    throw new Error(
      'Sweed auth is not configured. Set SWEED_LOGIN_EMAIL+SWEED_LOGIN_PASSWORD (preferred) or SWEED_AUTH_TOKEN.',
    )
  }

  await withSweedSession(async () => {
    await callSweedRpcRaw<unknown>('store.auth.initial.data.get')
    await ensureDealerContextImpl(env.sweedStateDealerId)
  })
}

async function callOnStateDealer<TResult>(name: string, params: Record<string, unknown>): Promise<TResult> {
  const env = getWorkerEnv()
  return callSweedRpcForDealerImpl<TResult>(env.sweedStateDealerId, name, params)
}

function runWithDealerSerialization<T>(fn: () => Promise<T>): Promise<T> {
  if (hasActiveSweedSession()) {
    return fn()
  }
  return runWithSweedSessionLock(fn)
}

function unwrapProductDetail(detail: unknown): z.infer<typeof SweedProductSummarySchema> {
  const wrapped = SweedProductDetailWrappedSchema.safeParse(detail)
  if (wrapped.success) {
    return wrapped.data.product
  }
  return SweedProductSummarySchema.parse(detail)
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
