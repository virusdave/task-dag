import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import { HELIOS_PENDING_PURCHASE_SITE_DEALERS } from '../../shared/contracts/index.js'
import { getServerEnv } from '../config/env.js'

const GROUPED_INVENTORY_PAGE_SIZE = 200

const RpcEnvelopeSchema = z.object({
  error: z.object({ message: z.string().nullable().optional() }).optional(),
  result: z.unknown().optional(),
})

const DealerSetResultSchema = z.object({
  user: z.object({
    currentDealerId: z.coerce.number().int(),
    currentDealerName: z.string().nullable().optional(),
  }),
})

const GroupedInventoryResponseSchema = z.object({
  data: z.array(z.object({
    product: z.object({
      id: z.coerce.number().int().positive().optional(),
    }).passthrough().optional(),
  }).passthrough()).default([]),
  totalCount: z.coerce.number().int().min(0).optional(),
}).passthrough()

let sweedSessionQueue: Promise<void> = Promise.resolve()

export async function loadLiveInStockProductIds(siteDealerIds: number[]): Promise<number[]> {
  const selectedDealerIds = [...new Set(siteDealerIds)].filter((dealerId) => HELIOS_PENDING_PURCHASE_SITE_DEALERS.some((site) => site.dealerId === dealerId))
  if (selectedDealerIds.length === 0) {
    return []
  }

  return withSweedSessionLock(async () => {
    const productIds = new Set<number>()

    for (const site of HELIOS_PENDING_PURCHASE_SITE_DEALERS.filter((candidate) => selectedDealerIds.includes(candidate.dealerId))) {
      let page = 1
      while (true) {
        const result = GroupedInventoryResponseSchema.parse(await callSweedRpcForDealer(site.dealerId, 'store.inventory.item.list.grouped', {
          isOnStock: true,
          page,
          pageSize: GROUPED_INVENTORY_PAGE_SIZE,
        }))

        for (const row of result.data) {
          const productId = row.product?.id
          if (productId) {
            productIds.add(productId)
          }
        }

        if (result.data.length < GROUPED_INVENTORY_PAGE_SIZE) {
          break
        }

        page += 1
      }
    }

    return [...productIds].sort((left, right) => left - right)
  })
}

function withSweedSessionLock<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
  const run = sweedSessionQueue.then(operation, operation)
  sweedSessionQueue = run.then(() => undefined, () => undefined)
  return run
}

async function callSweedRpcForDealer<TResult>(
  dealerId: number,
  name: string,
  params: Record<string, unknown>,
): Promise<TResult> {
  await ensureDealerContext(dealerId)
  return callSweedRpcRaw(name, params)
}

async function ensureDealerContext(dealerId: number): Promise<void> {
  const result = DealerSetResultSchema.parse(await callSweedRpcRaw('store.auth.dealer.set', { dealerId }))
  if (result.user.currentDealerId !== dealerId) {
    throw new Error(
      `Sweed dealer context mismatch. Expected ${dealerId}, got ${result.user.currentDealerId} ${result.user.currentDealerName ?? ''}`.trim(),
    )
  }
}

async function callSweedRpcRaw<TResult>(name: string, params?: Record<string, unknown>): Promise<TResult> {
  const env = getServerEnv()
  if (!env.sweedAuthToken) {
    throw new Error('SWEED_AUTH_TOKEN is required for live in-stock pricing scope.')
  }

  const response = await fetch(env.sweedApiUrl, {
    body: JSON.stringify({
      auth: env.sweedAuthToken,
      id: randomUUID(),
      name,
      ...(params === undefined ? {} : { params }),
    }),
    headers: {
      'content-type': 'application/json',
      'user-agent': 'helios-server/1.0',
    },
    method: 'POST',
    signal: AbortSignal.timeout(30000),
  })

  const responseText = await response.text()
  if (!response.ok) {
    throw new Error(`${name} returned HTTP ${response.status}: ${truncate(responseText)}`)
  }

  const envelope = RpcEnvelopeSchema.parse(JSON.parse(responseText))
  if (envelope.error) {
    throw new Error(`${name} failed: ${envelope.error.message ?? 'Unknown Sweed RPC error.'}`)
  }
  if (envelope.result === undefined) {
    throw new Error(`${name} returned no result payload.`)
  }

  return envelope.result as TResult
}

function truncate(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 240) {
    return normalized
  }

  return `${normalized.slice(0, 239)}…`
}
