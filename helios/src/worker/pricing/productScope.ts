import { z } from 'zod'

import { HELIOS_PENDING_PURCHASE_SITE_DEALERS } from '../../shared/contracts/index.js'
import { callSweedRpcForDealer } from '../sweed/client.js'

const GROUPED_INVENTORY_PAGE_SIZE = 200
const PURCHASE_ORDER_PAGE_SIZE = 50
const MIDTOWN_RECEIVED_SCOPE_CACHE_TTL_MS = 10 * 60 * 1000
const MIDTOWN_RECEIVED_SCOPE_DEALER_ID = 210705
const RECEIVED_STATUS_MATCHER = /received/i

const GroupedInventoryResponseSchema = z.object({
  data: z.array(z.object({
    product: z.object({
      id: z.coerce.number().int().positive().optional(),
    }).passthrough().optional(),
  }).passthrough()).default([]),
}).passthrough()

const PurchaseOrderListResponseSchema = z.object({
  data: z.array(z.object({
    deliveryDate: z.string().nullable().optional(),
    id: z.coerce.number().int().positive(),
    orderStatus: z.object({
      name: z.string().nullable().optional(),
    }).nullable().optional(),
  }).passthrough()).default([]),
  totalCount: z.coerce.number().int().min(0).default(0),
}).passthrough()

const PurchaseOrderDetailSchema = z.object({
  deliveryDate: z.string().nullable().optional(),
  id: z.coerce.number().int().positive(),
  positions: z.array(z.object({
    distributorProduct: z.object({
      product: z.object({
        id: z.coerce.number().int().positive().nullable().optional(),
      }).nullable().optional(),
    }).nullable().optional(),
    id: z.coerce.number().int().positive(),
    suggestedProduct: z.object({
      id: z.coerce.number().int().positive().nullable().optional(),
    }).nullable().optional(),
  }).passthrough()).default([]),
}).passthrough()

export interface MidtownReceivedScopeProductSummary {
  lastReceivedDate: string | null
  orderCount: number
  orderIds: number[]
  positionCount: number
  productId: number
}

export interface MidtownReceivedScopeResult {
  fromDate: string
  productIds: number[]
  productsById: Map<number, MidtownReceivedScopeProductSummary>
  receivedOrderCount: number
  scannedOrderCount: number
  toDate: string
}

let sweedSessionQueue: Promise<void> = Promise.resolve()
let cachedMidtownReceivedScope: { expiresAt: number; result: MidtownReceivedScopeResult } | null = null

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

export async function loadMidtownReceivedProductIds(options?: { forceRefresh?: boolean; fromDate?: string; toDate?: string }): Promise<number[]> {
  const scope = await loadMidtownReceivedProductScope(options)
  return scope.productIds
}

export async function loadMidtownReceivedProductScope(options?: {
  forceRefresh?: boolean
  fromDate?: string
  toDate?: string
}): Promise<MidtownReceivedScopeResult> {
  const fromDate = options?.fromDate ?? '2000-01-01'
  const toDate = options?.toDate ?? new Date().toISOString().slice(0, 10)
  const shouldReuseCache = !options?.forceRefresh
    && cachedMidtownReceivedScope !== null
    && cachedMidtownReceivedScope.expiresAt > Date.now()
    && cachedMidtownReceivedScope.result.fromDate === fromDate
    && cachedMidtownReceivedScope.result.toDate === toDate
  if (shouldReuseCache) {
    return cachedMidtownReceivedScope!.result
  }

  const result = await withSweedSessionLock(async () => {
    const orderSummaries = await listPurchaseOrders(MIDTOWN_RECEIVED_SCOPE_DEALER_ID, fromDate, toDate)
    const receivedOrders = orderSummaries.filter((order) => RECEIVED_STATUS_MATCHER.test(order.statusName ?? ''))
    const productsById = new Map<number, MidtownReceivedScopeProductSummary>()

    for (const order of receivedOrders) {
      const detail = PurchaseOrderDetailSchema.parse(
        await callSweedRpcForDealer(MIDTOWN_RECEIVED_SCOPE_DEALER_ID, 'store.purchase.order.get', { id: order.id }),
      )
      const resolvedDate = normalizeDate(detail.deliveryDate) ?? order.deliveryDate ?? null

      for (const position of detail.positions) {
        const productId = position.distributorProduct?.product?.id ?? position.suggestedProduct?.id ?? null
        if (!productId) {
          continue
        }

        const existing = productsById.get(productId)
        if (existing) {
          existing.positionCount += 1
          if (!existing.orderIds.includes(order.id)) {
            existing.orderIds.push(order.id)
            existing.orderCount += 1
          }
          if (resolvedDate && (!existing.lastReceivedDate || resolvedDate > existing.lastReceivedDate)) {
            existing.lastReceivedDate = resolvedDate
          }
          continue
        }

        productsById.set(productId, {
          lastReceivedDate: resolvedDate,
          orderCount: 1,
          orderIds: [order.id],
          positionCount: 1,
          productId,
        })
      }
    }

    for (const summary of productsById.values()) {
      summary.orderIds.sort((left, right) => left - right)
    }

    return {
      fromDate,
      productIds: [...productsById.keys()].sort((left, right) => left - right),
      productsById,
      receivedOrderCount: receivedOrders.length,
      scannedOrderCount: orderSummaries.length,
      toDate,
    }
  })

  cachedMidtownReceivedScope = {
    expiresAt: Date.now() + MIDTOWN_RECEIVED_SCOPE_CACHE_TTL_MS,
    result,
  }
  return result
}

function withSweedSessionLock<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
  const run = sweedSessionQueue.then(operation, operation)
  sweedSessionQueue = run.then(() => undefined, () => undefined)
  return run
}

async function listPurchaseOrders(
  dealerId: number,
  fromDate: string,
  toDate: string,
): Promise<Array<{ deliveryDate: string | null; id: number; statusName: string | null }>> {
  const orders: Array<{ deliveryDate: string | null; id: number; statusName: string | null }> = []
  let page = 1

  while (true) {
    const response = PurchaseOrderListResponseSchema.parse(
      await callSweedRpcForDealer(dealerId, 'store.purchase.order.list', {
        fromDate,
        page,
        pageSize: PURCHASE_ORDER_PAGE_SIZE,
        toDate,
      }),
    )

    orders.push(...response.data.map((row) => ({
      deliveryDate: normalizeDate(row.deliveryDate),
      id: row.id,
      statusName: normalizeInlineText(row.orderStatus?.name),
    })))

    if (orders.length >= response.totalCount || response.data.length < PURCHASE_ORDER_PAGE_SIZE) {
      return orders
    }

    page += 1
  }
}

function normalizeInlineText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 0 ? normalized : null
}

function normalizeDate(value: string | null | undefined): string | null {
  const normalized = normalizeInlineText(value)
  if (!normalized) {
    return null
  }

  return normalized.slice(0, 10)
}
