import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import type {
  PurchaseLifecycleGateSummary,
  PurchaseLifecyclePath,
  PurchaseLifecycleRun,
  PurchaseLifecycleStatusResponse,
} from '../../shared/contracts/index.js'
import type { PoolClient } from 'pg'

import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { getPool } from '../db/pool.js'
import type { Queryable } from '../db/pool.js'
import { withTransaction } from '../db/tx.js'
import { resolvePricingRunScope } from '../db/queries/pricingQueries.js'
import { getOptionalSweedSessionConcurrencyKey } from '../jobs/concurrency.js'
import { enqueueJob } from '../jobs/enqueueJob.js'
import { callSweedRpc } from '../../worker/sweed/rpc.js'
import { withSweedSession } from '../../worker/sweed/session.js'
import { enqueueMarketRefreshForProductsInTransaction } from '../../worker/litalerts/enqueueMarketRefresh.js'
import {
  computeMarketGate,
  computePriceGate,
  evaluateItemQuarantine,
  isForSaleStockLocationName,
  type LiveLot,
} from './purchaseInventoryLifecycleGates.js'
import {
  createRun,
  getApprovedPricesForBatch,
  getProposalBatchStatus,
  getPurchaseExpectedScope,
  getRunByPo,
  getSucceededObservationsAfter,
  lifecycleTablesExist,
  lockRunForUpdate,
  updateItemPrice,
  updateItemQuarantine,
  updateItemMarket,
  updateRunState,
  type UpdateRunStateInput,
} from './purchaseInventoryLifecycleQueries.js'

// ---------------------------------------------------------------------------
// Orchestration for the purchase inventory pricing-safety lifecycle (L1).
//
// Path semantics (operator decision 5):
//   'quarantine'        — full lifecycle. Enters at
//                         awaiting_receive_to_quarantine; the quarantine
//                         gate must pass before market/pricing.
//   'reprice_in_place'  — the lots are already sellable; skip the
//                         quarantine gate and enter at
//                         market_refresh_pending. We still require a
//                         fresh market pull before repricing (a
//                         deliberate strengthening of the design's
//                         "start at pricing_pending": pulling fresh
//                         market data first is the whole money-safety
//                         point and is cheap/idempotent).
//
// L1 stops at priced_verified — there is NO release/reverse-move route.
// ---------------------------------------------------------------------------

export class LifecycleConflictError extends Error {}
export class LifecycleBadRequestError extends Error {}
export class LifecycleMigrationPendingError extends Error {}

// Sweed RPC response shapes (mirrors of the loose schemas in
// catalog/maintenance.ts and worker/sweed/client.ts — kept local so this
// module owns its own parse contract).
const InventoryProductItemSchema = z
  .object({
    id: z.union([z.coerce.number().int(), z.string().trim().min(1)]),
    externalTrackCode: z.string().nullable().optional(),
    availableQty: z.coerce.number().nullable().optional(),
    currentQty: z.coerce.number().nullable().optional(),
    stockLocation: z
      .object({ id: z.coerce.number().int().optional(), name: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

const InventoryProductItemListResponseSchema = z
  .object({
    result: z
      .object({ data: z.array(InventoryProductItemSchema).default([]) })
      .passthrough()
      .nullable()
      .optional(),
    data: z.array(InventoryProductItemSchema).optional(),
  })
  .passthrough()
  .transform((value) => value.result?.data ?? value.data ?? [])

const SweedProductSummarySchema = z
  .object({
    id: z.coerce.number().int().optional(),
    price: z.coerce.number().nullable().optional(),
    priceInfo: z
      .object({ actualPrice: z.coerce.number().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

const SweedProductDetailWrappedSchema = z
  .object({ product: SweedProductSummarySchema })
  .passthrough()

function readLivePrice(detail: unknown): number | null {
  const wrapped = SweedProductDetailWrappedSchema.safeParse(detail)
  const summary = wrapped.success ? wrapped.data.product : SweedProductSummarySchema.parse(detail)
  return summary.priceInfo?.actualPrice ?? summary.price ?? null
}

// Quarantine is a money-safety gate: missing a sellable lot would let a
// not-yet-priced SKU stay on the floor. So we must read EVERY live lot for
// the product, not just page 1 — a sellable lot on page 2+ would otherwise
// look "gone" and false-pass. Page until Sweed returns a short page, and
// fail CLOSED (throw) if it never does within a generous bound.
const LIVE_LOT_PAGE_SIZE = 100
const LIVE_LOT_MAX_PAGES = 50

/** Live lots per product from Sweed, normalized for the quarantine gate. */
async function readLiveLotsForProduct(dealerId: number, productId: number): Promise<LiveLot[]> {
  const out: LiveLot[] = []
  for (let page = 1; page <= LIVE_LOT_MAX_PAGES; page += 1) {
    const raw = await callSweedRpc<unknown>(dealerId, 'store.inventory.product.item.list', {
      productId: String(productId),
      page,
      pageSize: LIVE_LOT_PAGE_SIZE,
      isOnStock: true,
    })
    const items = InventoryProductItemListResponseSchema.parse(raw)
    for (const item of items) {
      out.push({
        inventoryItemId: String(item.id),
        metrcTag: item.externalTrackCode ?? null,
        qty:
          typeof item.availableQty === 'number'
            ? item.availableQty
            : typeof item.currentQty === 'number'
              ? item.currentQty
              : 0,
        stockLocationName: item.stockLocation?.name ?? null,
      })
    }
    if (items.length < LIVE_LOT_PAGE_SIZE) {
      return out
    }
  }
  throw new LifecycleBadRequestError(
    `Could not verify quarantine for product ${productId}: Sweed returned more than `
      + `${LIVE_LOT_MAX_PAGES * LIVE_LOT_PAGE_SIZE} live lots. Refusing to pass the quarantine `
      + 'gate without a complete lot list.',
  )
}

async function readLivePriceForProduct(dealerId: number, productId: number): Promise<number | null> {
  const raw = await callSweedRpc<unknown>(dealerId, 'store.product.get', { id: String(productId) })
  return readLivePrice(raw)
}

// ----------------------------- Per-PO lock ---------------------------------

interface LockedClientResult<T> {
  acquired: boolean
  value?: T
}

/**
 * Serialize lifecycle mutations for one PO AND make every mutation in the
 * callback atomic. The callback runs inside a single transaction (so the
 * item updates + run-state bump + audit event + any enqueue/batch insert
 * either all land or all roll back — money-safety state must never half-
 * persist), and a transaction-scoped advisory lock serializes concurrent
 * transitions (a stale tab / double-click cannot interleave). The xact
 * lock auto-releases on commit/rollback, so there is no manual-unlock
 * leak path. The optimistic `version` CAS inside `lockRunForUpdate` /
 * `updateRunState` is the second guard against a stale-version writer.
 */
async function withPoLifecycleLock<T>(
  dealerId: number,
  poId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<LockedClientResult<T>> {
  return withTransaction(async (client) => {
    const lockRes = await client.query<{ locked: boolean }>(
      `select pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) as locked`,
      ['purchase_inventory_lifecycle', `${dealerId}:${poId}`],
    )
    if (!lockRes.rows[0]?.locked) {
      return { acquired: false }
    }
    const value = await fn(client)
    return { acquired: true, value }
  })
}

/** Bump run state and throw a conflict if the version CAS lost the race. */
async function updateRunStateOrThrow(client: Queryable, input: UpdateRunStateInput): Promise<void> {
  const ok = await updateRunState(client, input)
  if (!ok) {
    throw new LifecycleConflictError('Lifecycle changed since this view loaded; reload and retry.')
  }
}

// --------------------------- Status (read) ---------------------------------

async function buildGateSummary(
  db: Queryable,
  run: PurchaseLifecycleRun,
): Promise<PurchaseLifecycleGateSummary> {
  const quarantineSellableLotCount = run.items.filter(
    (item) =>
      item.quarantineCurrentQty !== null &&
      item.quarantineCurrentQty > 0 &&
      isForSaleStockLocationName(item.quarantineStockLocation),
  ).length

  let marketPendingProductIds: number[] = []
  if (run.marketRequestedAt !== null && run.expectedProductIds.length > 0) {
    const ready = await getSucceededObservationsAfter(
      db,
      run.expectedProductIds,
      new Date(run.marketRequestedAt),
    )
    marketPendingProductIds = computeMarketGate(
      run.expectedProductIds,
      new Set(ready.keys()),
    ).pendingProductIds
  }

  let priceUnapprovedProductIds: number[] = []
  let priceUnverifiedProductIds: number[] = []
  if (run.pricingBatchId !== null && run.expectedProductIds.length > 0) {
    const approved = await getApprovedPricesForBatch(db, run.pricingBatchId)
    // Best-effort live-price evidence from the last reprice/verify run,
    // stored per representative lot (no Sweed re-read on page load).
    const liveByProduct = new Map<number, number | null>()
    for (const item of run.items) {
      if (!liveByProduct.has(item.sweedProductId)) {
        liveByProduct.set(item.sweedProductId, item.livePriceDollars)
      }
    }
    const gate = computePriceGate(
      run.expectedProductIds.map((productId) => ({
        productId,
        approvedPriceDollars: approved.get(productId) ?? null,
        livePriceDollars: liveByProduct.get(productId) ?? null,
      })),
    )
    priceUnapprovedProductIds = gate.unapprovedProductIds
    priceUnverifiedProductIds = gate.unverifiedProductIds
  }

  return {
    quarantineSellableLotCount,
    marketPendingProductIds,
    priceUnapprovedProductIds,
    priceUnverifiedProductIds,
  }
}

export async function getLifecycleStatus(
  dealerId: number,
  poId: string,
): Promise<PurchaseLifecycleStatusResponse> {
  const db = getPool()
  if (!(await lifecycleTablesExist(db))) {
    return { migrationPending: true, expectedProductIds: [], run: null, gateSummary: null }
  }
  const [scope, run] = await Promise.all([
    getPurchaseExpectedScope(db, dealerId, poId),
    getRunByPo(db, dealerId, poId),
  ])
  const gateSummary = run ? await buildGateSummary(db, run) : null
  return {
    migrationPending: false,
    expectedProductIds: scope.productIds,
    run,
    gateSummary,
  }
}

async function statusOrThrow(dealerId: number, poId: string): Promise<PurchaseLifecycleStatusResponse> {
  const status = await getLifecycleStatus(dealerId, poId)
  if (status.run === null) {
    throw new LifecycleBadRequestError('Lifecycle run vanished after the operation.')
  }
  return status
}

// ----------------------------- Start ---------------------------------------

export async function startLifecycle(input: {
  dealerId: number
  poId: string
  path: PurchaseLifecyclePath
  notes: string | null
  userId: number | null
}): Promise<PurchaseLifecycleStatusResponse> {
  const db = getPool()
  if (!(await lifecycleTablesExist(db))) {
    throw new LifecycleMigrationPendingError('Lifecycle migration 095 is not applied yet.')
  }

  const header = await db.query<{ site_key: string }>(
    `select site_key from sweed_purchases where dealer_id = $1 and po_id = $2`,
    [input.dealerId, input.poId],
  )
  if (header.rows.length === 0) {
    throw new LifecycleBadRequestError('Purchase not found.')
  }
  const siteKey = header.rows[0]!.site_key

  const scope = await getPurchaseExpectedScope(db, input.dealerId, input.poId)
  if (scope.productIds.length === 0) {
    throw new LifecycleBadRequestError(
      'This PO has no positive-qty, product-mapped lines, so there is nothing to price.',
    )
  }
  if (input.path === 'quarantine' && scope.lots.length === 0) {
    throw new LifecycleBadRequestError(
      'No matched inventory lots to quarantine for this PO. Use "reprice in place" instead, '
        + 'or wait for package matching to catch up.',
    )
  }

  const initialState = input.path === 'quarantine'
    ? 'awaiting_receive_to_quarantine'
    : 'market_refresh_pending'

  const lockResult = await withPoLifecycleLock(input.dealerId, input.poId, async (client) => {
    const existing = await getRunByPo(client, input.dealerId, input.poId)
    if (existing) {
      throw new LifecycleConflictError('A lifecycle run already exists for this PO.')
    }
    const runId = await createRun(client, {
      dealerId: input.dealerId,
      poId: input.poId,
      siteKey,
      path: input.path,
      state: initialState,
      expectedProductIds: scope.productIds,
      lots: scope.lots,
      createdByUserId: input.userId,
      notes: input.notes,
    })
    await appendAuditEvent(client, {
      actorType: input.userId ? 'user' : 'system',
      actorUserId: input.userId,
      entityId: String(runId),
      entityType: 'purchase_inventory_lifecycle_run',
      eventType: 'purchase.lifecycle.started',
      module: 'catalog',
      payload: {
        dealerId: input.dealerId,
        poId: input.poId,
        path: input.path,
        initialState,
        expectedProductIds: scope.productIds,
        lotCount: scope.lots.length,
      },
      requestId: randomUUID(),
      scope: null,
      undoPayload: null,
    })
    return runId
  })

  if (!lockResult.acquired) {
    throw new LifecycleConflictError('Another lifecycle action for this PO is in progress.')
  }
  return statusOrThrow(input.dealerId, input.poId)
}

// ------------------------- Verify quarantine -------------------------------

export async function verifyQuarantine(input: {
  dealerId: number
  poId: string
  expectedVersion: number
  userId: number | null
}): Promise<PurchaseLifecycleStatusResponse> {
  const db = getPool()
  if (!(await lifecycleTablesExist(db))) {
    throw new LifecycleMigrationPendingError('Lifecycle migration 095 is not applied yet.')
  }

  const run = await getRunByPo(db, input.dealerId, input.poId)
  if (!run) throw new LifecycleBadRequestError('No lifecycle run for this PO.')
  if (run.version !== input.expectedVersion) {
    throw new LifecycleConflictError('Lifecycle changed since this view loaded; reload and retry.')
  }
  if (run.path !== 'quarantine') {
    throw new LifecycleBadRequestError('Quarantine verification only applies to the quarantine path.')
  }
  if (run.items.length === 0) {
    throw new LifecycleBadRequestError('No expected lots to verify.')
  }

  // Read live lots per product OUTSIDE the lock (slow Sweed calls).
  const productIds = [...new Set(run.items.map((item) => item.sweedProductId))]
  const liveLotsByProduct = new Map<number, LiveLot[]>()
  await withSweedSession(async () => {
    for (const productId of productIds) {
      liveLotsByProduct.set(productId, await readLiveLotsForProduct(input.dealerId, productId))
    }
  })

  const now = new Date()
  let sellableCount = 0
  const lockResult = await withPoLifecycleLock(input.dealerId, input.poId, async (client) => {
    const locked = await lockRunForUpdate(client, input.dealerId, input.poId, input.expectedVersion)
    if (!locked) {
      throw new LifecycleConflictError('Lifecycle changed since this view loaded; reload and retry.')
    }
    if (locked.state !== 'awaiting_receive_to_quarantine') {
      throw new LifecycleBadRequestError(
        `Cannot verify quarantine from state "${locked.state}".`,
      )
    }
    for (const item of run.items) {
      const verdict = evaluateItemQuarantine(
        { inventoryItemId: item.inventoryItemId, metrcTag: item.metrcTag },
        liveLotsByProduct.get(item.sweedProductId) ?? [],
      )
      if (!verdict.quarantined) sellableCount += 1
      await updateItemQuarantine(client, {
        itemId: item.id,
        verifiedAt: verdict.quarantined ? now : null,
        stockLocation: verdict.stockLocation,
        currentQty: verdict.currentQty,
      })
    }
    if (sellableCount === 0) {
      await updateRunStateOrThrow(client, {
        runId: locked.id,
        expectedVersion: input.expectedVersion,
        state: 'quarantined',
      })
    }
    await appendAuditEvent(client, {
      actorType: input.userId ? 'user' : 'system',
      actorUserId: input.userId,
      entityId: String(locked.id),
      entityType: 'purchase_inventory_lifecycle_run',
      eventType: 'purchase.lifecycle.quarantine_verified',
      module: 'catalog',
      payload: {
        dealerId: input.dealerId,
        poId: input.poId,
        sellableLotCount: sellableCount,
        passed: sellableCount === 0,
      },
      requestId: randomUUID(),
      scope: null,
      undoPayload: null,
    })
    return true
  })

  if (!lockResult.acquired) {
    throw new LifecycleConflictError('Another lifecycle action for this PO is in progress.')
  }
  return statusOrThrow(input.dealerId, input.poId)
}

// --------------------------- Market refresh --------------------------------

const MARKET_REFRESH_FROM_STATES = new Set([
  'quarantined',
  'market_refresh_pending',
  'market_ready',
])

export async function marketRefresh(input: {
  dealerId: number
  poId: string
  expectedVersion: number
  userId: number | null
}): Promise<PurchaseLifecycleStatusResponse> {
  const db = getPool()
  if (!(await lifecycleTablesExist(db))) {
    throw new LifecycleMigrationPendingError('Lifecycle migration 095 is not applied yet.')
  }

  const lockResult = await withPoLifecycleLock(input.dealerId, input.poId, async (client) => {
    const locked = await lockRunForUpdate(client, input.dealerId, input.poId, input.expectedVersion)
    if (!locked) {
      throw new LifecycleConflictError('Lifecycle changed since this view loaded; reload and retry.')
    }
    if (!MARKET_REFRESH_FROM_STATES.has(locked.state)) {
      throw new LifecycleBadRequestError(`Cannot pull market data from state "${locked.state}".`)
    }
    if (locked.expectedProductIds.length === 0) {
      throw new LifecycleBadRequestError('No products to refresh market data for.')
    }
    // Stamp the cutoff BEFORE enqueue so a fast worker cannot capture an
    // observation before the cutoff and produce a false "ready".
    const cutoff = new Date()
    await updateRunStateOrThrow(client, {
      runId: locked.id,
      expectedVersion: input.expectedVersion,
      state: 'market_refresh_pending',
      marketRequestedAt: cutoff,
    })
    // Same transaction as the cutoff stamp: the cutoff and the queue rows
    // must commit together. bypassDedupe so the freshly-stamped cutoff is
    // never stranded behind an older in-flight 'purchase-lifecycle' row.
    await enqueueMarketRefreshForProductsInTransaction(client, locked.expectedProductIds, {
      trigger: { kind: 'purchase-lifecycle', poId: input.poId },
      requestedByUserId: input.userId,
      bypassDedupe: true,
    })
    await appendAuditEvent(client, {
      actorType: input.userId ? 'user' : 'system',
      actorUserId: input.userId,
      entityId: String(locked.id),
      entityType: 'purchase_inventory_lifecycle_run',
      eventType: 'purchase.lifecycle.market_refresh_requested',
      module: 'catalog',
      payload: {
        dealerId: input.dealerId,
        poId: input.poId,
        productIds: locked.expectedProductIds,
        marketRequestedAt: cutoff.toISOString(),
      },
      requestId: randomUUID(),
      scope: null,
      undoPayload: null,
    })
    return true
  })

  if (!lockResult.acquired) {
    throw new LifecycleConflictError('Another lifecycle action for this PO is in progress.')
  }
  return statusOrThrow(input.dealerId, input.poId)
}

// --------------------- Reprice (advance + verify) --------------------------

const REPRICE_PRE_BATCH_STATES = new Set(['market_refresh_pending', 'market_ready'])
const REPRICE_POST_BATCH_STATES = new Set([
  'pricing_pending',
  'awaiting_price_approval',
  'price_apply_pending',
  'priced_verified',
])

/**
 * Idempotent advance/verify for the pricing leg. The single "Reprice"
 * affordance walks the schema state machine one discrete step per call,
 * exactly as migration 095's header defines it:
 *
 *   market_refresh_pending --(market gate passes)--> market_ready
 *   market_ready           --(create pricing batch)--> pricing_pending
 *   pricing_pending        --(batch generated)--> awaiting_price_approval
 *   awaiting_price_approval/price_apply_pending
 *                          --(live price == approved within 1¢)--> priced_verified
 *
 * A failed/superseded pricing batch sends the run to blocked(pricing_failed).
 * No state is skipped, and the expensive live-Sweed price read only fires
 * once the batch has actually generated (status = ready).
 */
export async function reprice(input: {
  dealerId: number
  poId: string
  expectedVersion: number
  userId: number | null
}): Promise<PurchaseLifecycleStatusResponse> {
  const db = getPool()
  if (!(await lifecycleTablesExist(db))) {
    throw new LifecycleMigrationPendingError('Lifecycle migration 095 is not applied yet.')
  }

  const run = await getRunByPo(db, input.dealerId, input.poId)
  if (!run) throw new LifecycleBadRequestError('No lifecycle run for this PO.')
  if (run.version !== input.expectedVersion) {
    throw new LifecycleConflictError('Lifecycle changed since this view loaded; reload and retry.')
  }

  if (run.pricingBatchId === null) {
    return repricePreBatch(input, run)
  }
  return repriceWithBatch(input, run, run.pricingBatchId)
}

/**
 * Pre-batch leg: check the (cheap, DB-only) market gate, persist market
 * evidence, and advance market_refresh_pending → market_ready → (create
 * batch) pricing_pending in two discrete steps.
 */
async function repricePreBatch(
  input: { dealerId: number; poId: string; expectedVersion: number; userId: number | null },
  run: PurchaseLifecycleRun,
): Promise<PurchaseLifecycleStatusResponse> {
  const db = getPool()
  if (!REPRICE_PRE_BATCH_STATES.has(run.state)) {
    throw new LifecycleBadRequestError(`Cannot reprice from state "${run.state}".`)
  }
  if (run.marketRequestedAt === null) {
    throw new LifecycleBadRequestError('Pull market data first (market refresh).')
  }
  const ready = await getSucceededObservationsAfter(
    db,
    run.expectedProductIds,
    new Date(run.marketRequestedAt),
  )
  const marketGate = computeMarketGate(run.expectedProductIds, new Set(ready.keys()))

  const lockResult = await withPoLifecycleLock(input.dealerId, input.poId, async (client) => {
    const locked = await lockRunForUpdate(client, input.dealerId, input.poId, input.expectedVersion)
    if (!locked) {
      throw new LifecycleConflictError('Lifecycle changed since this view loaded; reload and retry.')
    }
    // Persist market evidence on each lot whose product is ready.
    const now = new Date()
    for (const item of run.items) {
      const obs = ready.get(item.sweedProductId)
      if (obs) {
        await updateItemMarket(client, {
          itemId: item.id,
          observationId: obs.observationId,
          capturedAt: obs.capturedAt,
          readyAt: now,
        })
      }
    }
    if (!marketGate.ready) {
      // Not ready yet — stay in market_refresh_pending; the summary lists
      // which products are still pending. (No state change to record.)
      return true
    }
    if (locked.state !== 'market_ready') {
      // Step 1: record that the market gate passed.
      await updateRunStateOrThrow(client, {
        runId: locked.id,
        expectedVersion: input.expectedVersion,
        state: 'market_ready',
      })
      await appendAuditEvent(client, {
        actorType: input.userId ? 'user' : 'system',
        actorUserId: input.userId,
        entityId: String(locked.id),
        entityType: 'purchase_inventory_lifecycle_run',
        eventType: 'purchase.lifecycle.reprice_advanced',
        module: 'catalog',
        payload: {
          dealerId: input.dealerId,
          poId: input.poId,
          phase: 'market_ready',
          productIds: run.expectedProductIds,
        },
        requestId: randomUUID(),
        scope: null,
        undoPayload: null,
      })
      return true
    }
    // Step 2 (state already market_ready): create the pricing batch and
    // move to pricing_pending (the batch generates asynchronously).
    const pricingBatchId = await queuePurchaseRepriceBatch(client, {
      dealerId: input.dealerId,
      poId: input.poId,
      productIds: run.expectedProductIds,
      userId: input.userId,
    })
    await updateRunStateOrThrow(client, {
      runId: locked.id,
      expectedVersion: input.expectedVersion,
      state: 'pricing_pending',
      pricingBatchId,
    })
    await appendAuditEvent(client, {
      actorType: input.userId ? 'user' : 'system',
      actorUserId: input.userId,
      entityId: String(locked.id),
      entityType: 'purchase_inventory_lifecycle_run',
      eventType: 'purchase.lifecycle.reprice_advanced',
      module: 'catalog',
      payload: {
        dealerId: input.dealerId,
        poId: input.poId,
        phase: 'pricing_batch_created',
        pricingBatchId,
        productIds: run.expectedProductIds,
      },
      requestId: randomUUID(),
      scope: null,
      undoPayload: null,
    })
    return true
  })
  if (!lockResult.acquired) {
    throw new LifecycleConflictError('Another lifecycle action for this PO is in progress.')
  }
  return statusOrThrow(input.dealerId, input.poId)
}

/**
 * Post-batch leg: inspect the linked pricing batch's status, then either
 * wait (still generating), block (generation failed), advance to
 * awaiting_price_approval, or — once approved + applied — verify the live
 * Sweed price equals the approved desired price (within 1¢).
 */
async function repriceWithBatch(
  input: { dealerId: number; poId: string; expectedVersion: number; userId: number | null },
  run: PurchaseLifecycleRun,
  pricingBatchId: number,
): Promise<PurchaseLifecycleStatusResponse> {
  const db = getPool()
  if (!REPRICE_POST_BATCH_STATES.has(run.state)) {
    throw new LifecycleBadRequestError(`Cannot verify pricing from state "${run.state}".`)
  }

  const batchStatus = await getProposalBatchStatus(db, pricingBatchId)

  // Still generating: keep the run in pricing_pending; nothing to verify.
  if (batchStatus === 'draft') {
    const lockResult = await withPoLifecycleLock(input.dealerId, input.poId, async (client) => {
      const locked = await lockRunForUpdate(client, input.dealerId, input.poId, input.expectedVersion)
      if (!locked) {
        throw new LifecycleConflictError('Lifecycle changed since this view loaded; reload and retry.')
      }
      if (locked.state !== 'pricing_pending') {
        await updateRunStateOrThrow(client, {
          runId: locked.id,
          expectedVersion: input.expectedVersion,
          state: 'pricing_pending',
        })
      }
      return true
    })
    if (!lockResult.acquired) {
      throw new LifecycleConflictError('Another lifecycle action for this PO is in progress.')
    }
    return statusOrThrow(input.dealerId, input.poId)
  }

  // Generation failed (or the batch was superseded): block for an operator.
  if (batchStatus === 'failed' || batchStatus === 'superseded' || batchStatus === null) {
    const lockResult = await withPoLifecycleLock(input.dealerId, input.poId, async (client) => {
      const locked = await lockRunForUpdate(client, input.dealerId, input.poId, input.expectedVersion)
      if (!locked) {
        throw new LifecycleConflictError('Lifecycle changed since this view loaded; reload and retry.')
      }
      await updateRunStateOrThrow(client, {
        runId: locked.id,
        expectedVersion: input.expectedVersion,
        state: 'blocked',
        blockedReason: 'pricing_failed',
      })
      await appendAuditEvent(client, {
        actorType: input.userId ? 'user' : 'system',
        actorUserId: input.userId,
        entityId: String(locked.id),
        entityType: 'purchase_inventory_lifecycle_run',
        eventType: 'purchase.lifecycle.reprice_advanced',
        module: 'catalog',
        payload: {
          dealerId: input.dealerId,
          poId: input.poId,
          phase: 'pricing_failed',
          pricingBatchId,
          batchStatus,
        },
        requestId: randomUUID(),
        scope: null,
        undoPayload: null,
      })
      return true
    })
    if (!lockResult.acquired) {
      throw new LifecycleConflictError('Another lifecycle action for this PO is in progress.')
    }
    return statusOrThrow(input.dealerId, input.poId)
  }

  // batchStatus === 'ready': proposals exist. Read live Sweed prices and
  // compare against the approved desired prices (the price-applied gate).
  const approved = await getApprovedPricesForBatch(db, pricingBatchId)
  const liveByProduct = new Map<number, number | null>()
  await withSweedSession(async () => {
    for (const productId of run.expectedProductIds) {
      liveByProduct.set(productId, await readLivePriceForProduct(input.dealerId, productId))
    }
  })
  const priceGate = computePriceGate(
    run.expectedProductIds.map((productId) => ({
      productId,
      approvedPriceDollars: approved.get(productId) ?? null,
      livePriceDollars: liveByProduct.get(productId) ?? null,
    })),
  )

  const lockResult = await withPoLifecycleLock(input.dealerId, input.poId, async (client) => {
    const locked = await lockRunForUpdate(client, input.dealerId, input.poId, input.expectedVersion)
    if (!locked) {
      throw new LifecycleConflictError('Lifecycle changed since this view loaded; reload and retry.')
    }
    const now = new Date()
    const unverified = new Set(priceGate.unverifiedProductIds)
    for (const item of run.items) {
      const approvedPrice = approved.get(item.sweedProductId) ?? null
      const livePrice = liveByProduct.get(item.sweedProductId) ?? null
      const isVerified =
        approvedPrice !== null && livePrice !== null && !unverified.has(item.sweedProductId)
      await updateItemPrice(client, {
        itemId: item.id,
        verifiedAt: isVerified ? now : null,
        approvedPriceDollars: approvedPrice,
        livePriceDollars: livePrice,
      })
    }
    const nextState = priceGate.verified
      ? 'priced_verified'
      : priceGate.unapprovedProductIds.length === 0
        ? 'price_apply_pending'
        : 'awaiting_price_approval'
    await updateRunStateOrThrow(client, {
      runId: locked.id,
      expectedVersion: input.expectedVersion,
      state: nextState,
    })
    await appendAuditEvent(client, {
      actorType: input.userId ? 'user' : 'system',
      actorUserId: input.userId,
      entityId: String(locked.id),
      entityType: 'purchase_inventory_lifecycle_run',
      eventType: 'purchase.lifecycle.reprice_advanced',
      module: 'catalog',
      payload: {
        dealerId: input.dealerId,
        poId: input.poId,
        phase: 'price_verified_check',
        nextState,
        verified: priceGate.verified,
        unapprovedProductIds: priceGate.unapprovedProductIds,
        unverifiedProductIds: priceGate.unverifiedProductIds,
      },
      requestId: randomUUID(),
      scope: null,
      undoPayload: null,
    })
    return true
  })
  if (!lockResult.acquired) {
    throw new LifecycleConflictError('Another lifecycle action for this PO is in progress.')
  }
  return statusOrThrow(input.dealerId, input.poId)
}

// ------------------- Pricing batch creation (reused seam) ------------------

/**
 * Create an explicit-product-id pricing batch for the PO's product ids
 * and enqueue the generator, mirroring POST /api/pricing/runs'
 * explicit_selection path. Returns the new proposal_batches.id so the
 * lifecycle can deep-link the operator to the existing pricing review UI.
 */
async function queuePurchaseRepriceBatch(
  db: Queryable,
  input: { dealerId: number; poId: string; productIds: number[]; userId: number | null },
): Promise<number> {
  const seedProductIds = [...new Set(input.productIds)].sort((a, b) => a - b)
  const resolverFilters = {
    brands: [],
    categories: [],
    distributorNames: [],
    includePending: true,
    packSizes: [],
    search: undefined,
    sites: [],
    stockOnly: true,
    strict: false,
    subcategories: [],
    unitSizes: [],
    explicitProductIds: seedProductIds,
    forceLiveRefresh: false,
    scopeKind: 'explicit_selection' as const,
  }
  const resolvedScope = await resolvePricingRunScope(db, resolverFilters, { seedProductIds })
  if (resolvedScope.catalogGroupIds.length === 0) {
    throw new LifecycleBadRequestError(
      'None of this PO\'s products map to mirrored catalog groups yet; '
        + 'the catalog mirror may not have caught up.',
    )
  }
  const scopedProductIds = resolvedScope.scopedProductIds === undefined
    ? undefined
    : resolvedScope.scopedProductIds.length === 0
      ? null
      : resolvedScope.scopedProductIds
  if (scopedProductIds === null) {
    throw new LifecycleBadRequestError('The PO products resolved to zero mirrored products.')
  }

  const scopeLabel = `PO ${input.poId} inventory lifecycle reprice`
  const insertResult = await db.query<{ id: number }>(
    `
      insert into proposal_batches (
        type, source, trigger_mode, status, prompt_version, model,
        summary_json, config_json, created_by_user_id
      )
      values ('pricing', 'generated', 'ui', 'draft', $1, $2, $3::jsonb, $4::jsonb, $5)
      returning id
    `,
    [
      'pricing-deterministic-v2-market-evidence',
      'deterministic-margin-band',
      JSON.stringify({
        generatedGroupCount: 0,
        generatedLineItemCount: 0,
        requestedGroupCount: resolvedScope.catalogGroupIds.length,
        skippedProductCount: 0,
      }),
      JSON.stringify({
        catalogGroupIds: resolvedScope.catalogGroupIds,
        explicitProductIds: seedProductIds,
        forceLiveRefresh: false,
        resolvedCatalogGroupCount: resolvedScope.catalogGroupIds.length,
        resolvedProductCount: resolvedScope.matchedProductCount,
        scopedProductIds: scopedProductIds ?? null,
        scopeKind: 'explicit_selection',
        scopeLabel,
        triggerSource: 'purchase-inventory-lifecycle',
      }),
      input.userId,
    ],
  )
  const proposalBatchId = insertResult.rows[0]!.id
  const jobId = await enqueueJob(db, {
    concurrencyKey: getOptionalSweedSessionConcurrencyKey(false),
    dedupeKey: `proposal.generate.pricing_batch:${proposalBatchId}`,
    jobType: 'proposal.generate.pricing_batch',
    module: 'pricing',
    payload: {
      forceLiveRefresh: false,
      proposalBatchId,
      requestedByUserId: input.userId,
      // The pricing-batch generator's payload only accepts the existing
      // trigger enum ('debug_promote' | 'ui_generate'); this batch is
      // created from the lifecycle UI, so 'ui_generate' is accurate. The
      // lifecycle provenance is recorded in config_json.triggerSource =
      // 'purchase-inventory-lifecycle' and the batch-generation audit event.
      trigger: 'ui_generate',
    },
    requestedByUserId: input.userId,
  })
  await db.query('update proposal_batches set job_id = $2 where id = $1', [proposalBatchId, jobId])
  await appendAuditEvent(db, {
    actorType: input.userId ? 'user' : 'system',
    actorUserId: input.userId,
    entityId: String(proposalBatchId),
    entityType: 'proposal_batch',
    eventType: 'proposal.batch.generation_requested',
    module: 'pricing',
    payload: {
      proposalBatchId,
      queuedJobId: jobId,
      scopeKind: 'explicit_selection',
      scopeLabel,
      explicitProductIdCount: seedProductIds.length,
      resolvedCatalogGroupCount: resolvedScope.catalogGroupIds.length,
      resolvedProductCount: resolvedScope.matchedProductCount,
      triggerSource: 'purchase-inventory-lifecycle',
    },
    requestId: randomUUID(),
    scope: null,
    undoPayload: null,
  })
  return proposalBatchId
}
