import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import type {
  PurchaseLifecycleGateSummary,
  PurchaseLifecycleItem,
  PurchaseLifecyclePath,
  PurchaseLifecycleRun,
  PurchaseLifecycleReleaseTargetsResponse,
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
  evaluateItemReleased,
  isForSaleStockLocationName,
  PRICE_EQUALITY_TOLERANCE_DOLLARS,
  type LiveLot,
} from './purchaseInventoryLifecycleGates.js'
import {
  claimReleaseAttempt,
  claimRollbackAttempt,
  createRun,
  extendReleaseLease,
  finalizeReleaseRun,
  getApprovedPricesForBatch,
  getLifecycleSchemaCaps,
  getProposalBatchStatus,
  getPurchaseExpectedScope,
  getRunByPo,
  getSucceededObservationsAfter,
  lifecycleTablesExist,
  lockRunForRelease,
  lockRunForUpdate,
  resetReleaseRun,
  updateItemPrice,
  updateItemQuarantine,
  updateItemMarket,
  updateItemRelease,
  updateRunState,
  type LifecycleSchemaCaps,
  type UpdateRunStateInput,
} from './purchaseInventoryLifecycleQueries.js'
import {
  findForSaleLocations,
  findInspectionLocation,
  isForSaleLocationName,
  listLiveLotsForProduct,
  listStockLocations,
  resolveForSaleTargetById,
  StockTransferError,
  transferLot,
  type LiveInventoryLot,
  type StockLocation,
} from '../catalog/stockTransferService.js'

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
/** 095 is applied but the L2 release migration 096 is not yet. */
export class LifecycleReleaseMigrationPendingError extends Error {}

// Sweed RPC response shapes (mirrors of the loose schemas in
// catalog/maintenance.ts and worker/sweed/client.ts — kept local so this
// module owns its own parse contract).
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

/** Narrow a transfer-grade live lot down to the pure gate view. */
function toGateLot(lot: LiveInventoryLot): LiveLot {
  return {
    inventoryItemId: lot.inventoryItemId,
    metrcTag: lot.externalTrackCode,
    qty: lot.availableQty ?? lot.currentQty ?? 0,
    stockLocationName: lot.stockLocationName,
  }
}

/**
 * Live lots per product from Sweed (the shared, fully-paginated,
 * fail-closed primitive), normalized for the pure gate functions. Missing
 * a sellable lot would let a not-yet-priced SKU stay on the floor, so the
 * underlying read pages the WHOLE list and throws on overflow rather than
 * false-passing a gate on page 1.
 */
async function readLiveLotsForProduct(dealerId: number, productId: number): Promise<LiveLot[]> {
  const lots = await listLiveLotsForProduct(dealerId, productId)
  return lots.map(toGateLot)
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

// Cached schema-capability probe so we don't pay two catalog lookups on
// every status load. Short TTL: a freshly-applied migration 096 starts
// the release flow within a few seconds. Mirrors the pendingMigrations
// cache lifetime so the panel's "release migration pending" note clears
// at the same cadence as the global banner.
const CAPS_CACHE_TTL_MS = 30_000
let capsCache: { caps: LifecycleSchemaCaps; at: number } | null = null

async function lifecycleCaps(db: Queryable): Promise<LifecycleSchemaCaps> {
  const now = Date.now()
  if (capsCache !== null && now - capsCache.at < CAPS_CACHE_TTL_MS) {
    return capsCache.caps
  }
  const caps = await getLifecycleSchemaCaps(db)
  capsCache = { caps, at: now }
  return caps
}

/** Throw unless migration 096 (the L2 release columns) is applied. */
async function requireReleaseSchema(db: Queryable): Promise<void> {
  const caps = await lifecycleCaps(db)
  if (!caps.runsTable) {
    throw new LifecycleMigrationPendingError('Lifecycle migration 095 is not applied yet.')
  }
  if (!caps.releaseColumns) {
    throw new LifecycleReleaseMigrationPendingError('Lifecycle release migration 096 is not applied yet.')
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

  // Release gate: expected lots we tried to release but have not yet
  // confirmed FOR-SALE & sellable (from the last release/continue pass).
  const releaseUnverifiedLotCount = run.items.filter(
    (item) => item.releaseTransferAttemptedAt !== null && item.releaseVerifiedAt === null,
  ).length

  // Decision-8 badge (informational): products with on-floor (FOR SALE,
  // positive-qty) stock per the latest PERSISTED lot evidence — no
  // page-load Sweed read. After a release the released lots show here;
  // for the quarantine path a sellable expected lot also shows (a breach
  // worth flagging). Reprice-in-place runs do not persist this evidence,
  // so the panel additionally treats that path as inherently on-floor.
  const onFloor = new Set<number>()
  for (const item of run.items) {
    const quarSellable =
      item.quarantineCurrentQty !== null &&
      item.quarantineCurrentQty > 0 &&
      isForSaleStockLocationName(item.quarantineStockLocation)
    const releaseSellable =
      item.releaseCurrentQty !== null &&
      item.releaseCurrentQty > 0 &&
      isForSaleStockLocationName(item.releaseStockLocation)
    if (quarSellable || releaseSellable) onFloor.add(item.sweedProductId)
  }
  const productIdsWithOnFloorStock = run.expectedProductIds.filter((id) => onFloor.has(id))

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
    releaseUnverifiedLotCount,
    productIdsWithOnFloorStock,
  }
}

export async function getLifecycleStatus(
  dealerId: number,
  poId: string,
): Promise<PurchaseLifecycleStatusResponse> {
  const db = getPool()
  const caps = await lifecycleCaps(db)
  if (!caps.runsTable) {
    return {
      migrationPending: true,
      releaseMigrationPending: true,
      expectedProductIds: [],
      run: null,
      gateSummary: null,
    }
  }
  const [scope, run] = await Promise.all([
    getPurchaseExpectedScope(db, dealerId, poId),
    getRunByPo(db, dealerId, poId, caps.releaseColumns),
  ])
  const gateSummary = run ? await buildGateSummary(db, run) : null
  return {
    migrationPending: false,
    releaseMigrationPending: !caps.releaseColumns,
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
    const existing = await getRunByPo(client, input.dealerId, input.poId, false)
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

  const run = await getRunByPo(db, input.dealerId, input.poId, false)
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

  const run = await getRunByPo(db, input.dealerId, input.poId, false)
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

// ===========================================================================
// L2 — bulk quarantine repair + gated release
// ===========================================================================

/**
 * Release execution lease (ms). Only the attempt whose id matches the run
 * may transfer/finalize; "continue release" may only take over once the
 * lease has expired. The transfer loop heartbeats (extends) the lease
 * before each lot, so a long but live release never looks abandoned.
 */
const RELEASE_LEASE_TTL_MS = 120_000

/** The per-site default release room (decision 6). */
function isDefaultReleaseRoom(name: string): boolean {
  return name.trim().toLowerCase().startsWith('for sale - sales floor')
}

function pricesMatch(approved: number | null, live: number | null): boolean {
  return (
    approved !== null &&
    live !== null &&
    Number.isFinite(approved) &&
    Number.isFinite(live) &&
    Math.abs(live - approved) < PRICE_EQUALITY_TOLERANCE_DOLLARS
  )
}

/** Live lots for an expected lot, matched by inventory item id then METRC tag. */
function matchExpectedLots(
  expected: { inventoryItemId: string; metrcTag: string | null },
  liveLots: LiveInventoryLot[],
): LiveInventoryLot[] {
  return liveLots.filter(
    (lot) =>
      lot.inventoryItemId === expected.inventoryItemId ||
      (expected.metrcTag !== null &&
        lot.externalTrackCode !== null &&
        lot.externalTrackCode === expected.metrcTag),
  )
}

// ----------------------------- Release targets -----------------------------

export async function listReleaseTargets(
  dealerId: number,
  poId: string,
): Promise<PurchaseLifecycleReleaseTargetsResponse> {
  const db = getPool()
  const caps = await lifecycleCaps(db)
  if (!caps.runsTable) {
    return { migrationPending: true, releaseMigrationPending: true, targets: [] }
  }
  if (!caps.releaseColumns) {
    return { migrationPending: false, releaseMigrationPending: true, targets: [] }
  }
  void poId
  const locations = await withSweedSession(() => listStockLocations(dealerId))
  const forSale = findForSaleLocations(locations)
  const targets = []
  for (const loc of forSale) {
    if (loc.stockTypeId === null) continue
    targets.push({
      locationId: loc.id,
      locationName: loc.name,
      stockTypeId: loc.stockTypeId,
      isDefault: isDefaultReleaseRoom(loc.name),
    })
  }
  return { migrationPending: false, releaseMigrationPending: false, targets }
}

// --------------------------- Quarantine repair -----------------------------

/**
 * Bulk move the purchase's still-sellable expected lots into the Dave
 * inspection room, then re-verify. The "repair" for path (a) when the
 * operator received a delivery into a FOR SALE room: it physically pulls
 * exactly the PO's lots off the floor (never other stock), then runs the
 * same money-safety quarantine re-verify as verify-quarantine. Uses only
 * L1 schema (no release columns), so it works once migration 095 is live.
 */
export async function repairQuarantine(input: {
  dealerId: number
  poId: string
  expectedVersion: number
  userId: number | null
}): Promise<PurchaseLifecycleStatusResponse> {
  const db = getPool()
  if (!(await lifecycleTablesExist(db))) {
    throw new LifecycleMigrationPendingError('Lifecycle migration 095 is not applied yet.')
  }
  const run = await getRunByPo(db, input.dealerId, input.poId, false)
  if (!run) throw new LifecycleBadRequestError('No lifecycle run for this PO.')
  if (run.version !== input.expectedVersion) {
    throw new LifecycleConflictError('Lifecycle changed since this view loaded; reload and retry.')
  }
  if (run.path !== 'quarantine') {
    throw new LifecycleBadRequestError('Quarantine repair only applies to the quarantine path.')
  }
  if (run.state !== 'awaiting_receive_to_quarantine') {
    throw new LifecycleBadRequestError(`Cannot repair quarantine from state "${run.state}".`)
  }
  if (run.items.length === 0) {
    throw new LifecycleBadRequestError('No expected lots to repair.')
  }

  const productIds = [...new Set(run.items.map((item) => item.sweedProductId))]
  let movedLotCount = 0
  try {
    await withSweedSession(async () => {
      const locations = await listStockLocations(input.dealerId)
      const inspection = findInspectionLocation(locations)
      if (inspection.stockTypeId === null) {
        throw new StockTransferError(`Inspection room "${inspection.name}" has no stock type.`)
      }
      const liveByProduct = new Map<number, LiveInventoryLot[]>()
      for (const productId of productIds) {
        liveByProduct.set(productId, await listLiveLotsForProduct(input.dealerId, productId))
      }
      for (const item of run.items) {
        const matching = matchExpectedLots(item, liveByProduct.get(item.sweedProductId) ?? [])
        for (const lot of matching) {
          if (!isForSaleLocationName(lot.stockLocationName)) continue
          const moved = await transferLot({
            dealerId: input.dealerId,
            lot,
            targetLocationId: inspection.id,
            targetStockTypeId: inspection.stockTypeId,
          })
          if (moved) movedLotCount += 1
        }
      }
    })
  } catch (error) {
    if (error instanceof StockTransferError) {
      throw new LifecycleBadRequestError(error.message)
    }
    throw error
  }

  await appendAuditEvent(db, {
    actorType: input.userId ? 'user' : 'system',
    actorUserId: input.userId,
    entityId: String(run.id),
    entityType: 'purchase_inventory_lifecycle_run',
    eventType: 'purchase.lifecycle.quarantine_repaired',
    module: 'catalog',
    payload: {
      dealerId: input.dealerId,
      poId: input.poId,
      movedLotCount,
      productIds,
    },
    requestId: randomUUID(),
    scope: null,
    undoPayload: null,
  })

  // Re-verify quarantine (re-reads live lots, persists evidence, advances
  // to quarantined when clean). The version is unchanged — the repair did
  // no DB state mutation — so the operator's expectedVersion still holds.
  return verifyQuarantine(input)
}

// -------------------------------- Release ----------------------------------

interface ReleaseTarget {
  id: number
  name: string
  stockTypeId: number
}

function toTarget(loc: StockLocation): ReleaseTarget {
  if (loc.stockTypeId === null) {
    throw new StockTransferError(`Release room "${loc.name}" has no stock type.`)
  }
  return { id: loc.id, name: loc.name, stockTypeId: loc.stockTypeId }
}

interface ReleaseTransfersResult {
  priceDrift: boolean
  anyTransferred: boolean
  allVerified: boolean
  postPriceOk: boolean
}

/**
 * The release write loop + verification, run OUTSIDE the per-PO DB lock
 * (the lock is only held for the short claim/finalize transactions; we
 * never hold a DB transaction across slow Sweed RPCs). Safety boundary:
 *   • Heartbeat the lease before each lot; abort if another attempt took over.
 *   • Re-read the LIVE price immediately before each lot; on drift, stop
 *     before transferring any more (no sellable-making move on stale price).
 *   • Move only the expected PO lots, only out of NON-FOR-SALE rooms.
 *   • Post-pass re-reads BOTH live prices and live lots: release_verified
 *     is set only when a lot is proven sellable in a FOR SALE room, and a
 *     price that drifted during the loop fails the post price gate.
 */
async function performReleaseTransfers(args: {
  dealerId: number
  runId: number
  attemptId: string
  remaining: PurchaseLifecycleItem[]
  allItems: PurchaseLifecycleItem[]
  expectedProductIds: number[]
  approved: Map<number, number>
  target: ReleaseTarget
}): Promise<ReleaseTransfersResult> {
  const db = getPool()
  let priceDrift = false
  // Count a lot released by a PRIOR attempt (a continue) as "transferred",
  // so a drift on a continue is classified as release_price_drift
  // (rollbackable), never release_preflight_failed (which means nothing was
  // ever moved). Without this, a continue that drifts before moving any new
  // lot would falsely report a clean preflight failure with lots already
  // on the floor.
  let anyTransferred = args.allItems.some(
    (i) => i.releaseTransferredAt !== null || i.releaseVerifiedAt !== null,
  )
  const renewLease = (): Date => new Date(Date.now() + RELEASE_LEASE_TTL_MS)
  const reown = async (): Promise<void> => {
    if (!(await extendReleaseLease(db, args.runId, args.attemptId, renewLease()))) {
      throw new LifecycleConflictError('Release lease lost to another attempt; reload and retry.')
    }
  }
  const writeItem = async (update: Parameters<typeof updateItemRelease>[1]): Promise<void> => {
    if (!(await updateItemRelease(db, update))) {
      throw new LifecycleConflictError('Release lease lost to another attempt; reload and retry.')
    }
  }
  const isoToDate = (iso: string | null): Date | null => (iso === null ? null : new Date(iso))

  await withSweedSession(async () => {
    for (const item of args.remaining) {
      // Keep the lease alive across long no-move iterations and prove we
      // still own the run before touching this item.
      await reown()
      const approvedPrice = args.approved.get(item.sweedProductId) ?? null
      const liveLots = await listLiveLotsForProduct(args.dealerId, item.sweedProductId)
      const matching = matchExpectedLots(item, liveLots)
      const positive = matching.filter((lot) => (lot.availableQty ?? lot.currentQty ?? 0) > 0)
      // Only lots NOT already in a FOR SALE room need a physical move.
      const toMove = positive.filter((lot) => !isForSaleLocationName(lot.stockLocationName))
      const attemptedAt = new Date()
      let transferredThisItem = false
      let lastError: string | null = null
      let driftHere = false
      for (const lot of toMove) {
        // Immediate-before-transfer preflight, per LOT: re-own the lease
        // AND re-read the LIVE price right before each physical move, so a
        // lot is never made sellable on a stale/drifted price.
        await reown()
        const livePrice = await readLivePriceForProduct(args.dealerId, item.sweedProductId)
        if (!pricesMatch(approvedPrice, livePrice)) {
          priceDrift = true
          driftHere = true
          lastError = `Live price ${livePrice ?? 'unreadable'} != approved ${approvedPrice ?? 'unapproved'} (1¢ tol).`
          break
        }
        try {
          const moved = await transferLot({
            dealerId: args.dealerId,
            lot,
            targetLocationId: args.target.id,
            targetStockTypeId: args.target.stockTypeId,
          })
          if (moved) {
            anyTransferred = true
            transferredThisItem = true
            if (moved.reservedHeldBack) {
              lastError = 'Some reserved units stayed put (transferReservedItems=false).'
            }
          }
        } catch (error) {
          lastError = error instanceof Error ? error.message : 'transfer failed'
        }
      }
      await writeItem({
        itemId: item.id,
        attemptId: args.attemptId,
        transferAttemptedAt: attemptedAt,
        transferredAt: transferredThisItem ? new Date() : isoToDate(item.releaseTransferredAt),
        verifiedAt: null,
        stockLocation: item.releaseStockLocation,
        stockLocationId: null,
        stockTypeId: null,
        currentQty: item.releaseCurrentQty,
        lastError,
      })
      if (driftHere) break
    }
  })

  if (priceDrift) {
    return { priceDrift: true, anyTransferred, allVerified: false, postPriceOk: false }
  }

  // Post-pass: re-read live prices + lots for ALL expected products, prove
  // each expected lot is now sellable, and re-check the price gate.
  let postPriceOk = true
  await withSweedSession(async () => {
    const livePriceByProduct = new Map<number, number | null>()
    const liveLotsByProduct = new Map<number, LiveLot[]>()
    for (const productId of args.expectedProductIds) {
      livePriceByProduct.set(productId, await readLivePriceForProduct(args.dealerId, productId))
      liveLotsByProduct.set(
        productId,
        (await listLiveLotsForProduct(args.dealerId, productId)).map(toGateLot),
      )
    }
    const postGate = computePriceGate(
      args.expectedProductIds.map((productId) => ({
        productId,
        approvedPriceDollars: args.approved.get(productId) ?? null,
        livePriceDollars: livePriceByProduct.get(productId) ?? null,
      })),
    )
    postPriceOk = postGate.verified
    const now = new Date()
    for (const item of args.allItems) {
      const verdict = evaluateItemReleased(
        { inventoryItemId: item.inventoryItemId, metrcTag: item.metrcTag },
        liveLotsByProduct.get(item.sweedProductId) ?? [],
      )
      await writeItem({
        itemId: item.id,
        attemptId: args.attemptId,
        transferAttemptedAt: isoToDate(item.releaseTransferAttemptedAt),
        transferredAt: isoToDate(item.releaseTransferredAt),
        verifiedAt: verdict.released ? now : null,
        stockLocation: verdict.stockLocation,
        stockLocationId: null,
        stockTypeId: null,
        currentQty: verdict.currentQty,
        lastError: verdict.released ? null : 'Not yet confirmed sellable in a FOR SALE room.',
      })
    }
  })

  const allVerified = await allItemsReleaseVerified(db, args.runId)
  return { priceDrift: false, anyTransferred, allVerified, postPriceOk }
}

/** True when every item in the run has a (post-read-proven) release_verified_at. */
async function allItemsReleaseVerified(db: Queryable, runId: number): Promise<boolean> {
  const result = await db.query<{ unverified: string }>(
    `select count(*)::text as unverified
       from purchase_inventory_lifecycle_items
      where run_id = $1 and release_verified_at is null`,
    [runId],
  )
  return Number(result.rows[0]?.unverified ?? '1') === 0
}

async function runReleaseAttempt(input: {
  dealerId: number
  poId: string
  expectedVersion: number
  userId: number | null
  fresh: boolean
  targetLocationId?: number
}): Promise<PurchaseLifecycleStatusResponse> {
  const db = getPool()

  const run = await getRunByPo(db, input.dealerId, input.poId, true)
  if (!run) throw new LifecycleBadRequestError('No lifecycle run for this PO.')
  if (run.version !== input.expectedVersion) {
    throw new LifecycleConflictError('Lifecycle changed since this view loaded; reload and retry.')
  }
  if (run.path !== 'quarantine') {
    throw new LifecycleBadRequestError(
      'Release only applies to the quarantine path; reprice-in-place lots are already sellable.',
    )
  }
  if (run.pricingBatchId === null) {
    throw new LifecycleBadRequestError('No pricing batch on this run; cannot verify prices for release.')
  }
  if (input.fresh) {
    if (run.state !== 'priced_verified') {
      throw new LifecycleBadRequestError(`Cannot release from state "${run.state}".`)
    }
  } else {
    const continuable =
      run.state === 'release_in_progress' ||
      (run.state === 'blocked' && run.blockedReason === 'release_partial_failure')
    if (!continuable) {
      throw new LifecycleBadRequestError(`Cannot continue release from state "${run.state}".`)
    }
  }

  // Resolve the target FOR SALE room LIVE (never trust the stored/sent id
  // blindly). Fresh release uses the chosen id; continue reuses the run's.
  let target: ReleaseTarget
  try {
    target = await withSweedSession(async () => {
      const locations = await listStockLocations(input.dealerId)
      if (input.fresh) {
        if (input.targetLocationId === undefined) {
          throw new StockTransferError('No target location chosen.')
        }
        return toTarget(resolveForSaleTargetById(locations, input.targetLocationId))
      }
      if (run.releaseTargetLocationId === null) {
        throw new StockTransferError('This run has no stored release target to continue.')
      }
      return toTarget(resolveForSaleTargetById(locations, run.releaseTargetLocationId))
    })
  } catch (error) {
    if (error instanceof StockTransferError) throw new LifecycleBadRequestError(error.message)
    throw error
  }

  // Claim the attempt (short tx): version CAS + lease + target. For
  // continue, refuse if a live lease is still held by another attempt.
  const attemptId = randomUUID()
  const leaseExpiresAt = new Date(Date.now() + RELEASE_LEASE_TTL_MS)
  const claim = await withPoLifecycleLock(input.dealerId, input.poId, async (client) => {
    const locked = await lockRunForRelease(client, input.dealerId, input.poId)
    if (!locked) throw new LifecycleBadRequestError('Lifecycle run vanished.')
    if (locked.version !== input.expectedVersion) {
      throw new LifecycleConflictError('Lifecycle changed since this view loaded; reload and retry.')
    }
    if (!input.fresh && locked.state === 'release_in_progress') {
      const leaseLive =
        locked.releaseLeaseExpiresAt !== null && locked.releaseLeaseExpiresAt.getTime() > Date.now()
      if (leaseLive) {
        throw new LifecycleConflictError(
          'A release for this PO is already running. Wait for it to finish or for its lease to expire.',
        )
      }
    }
    const ok = await claimReleaseAttempt(client, {
      runId: locked.id,
      expectedVersion: locked.version,
      attemptId,
      leaseExpiresAt,
      targetLocationId: target.id,
      targetLocationName: target.name,
      targetStockTypeId: target.stockTypeId,
    })
    if (!ok) {
      throw new LifecycleConflictError('Lifecycle changed since this view loaded; reload and retry.')
    }
    await appendAuditEvent(client, {
      actorType: input.userId ? 'user' : 'system',
      actorUserId: input.userId,
      entityId: String(locked.id),
      entityType: 'purchase_inventory_lifecycle_run',
      eventType: 'purchase.lifecycle.release_started',
      module: 'catalog',
      payload: {
        dealerId: input.dealerId,
        poId: input.poId,
        attemptId,
        fresh: input.fresh,
        targetLocationId: target.id,
        targetLocationName: target.name,
      },
      requestId: randomUUID(),
      scope: null,
      undoPayload: null,
    })
    return locked.id
  })
  if (!claim.acquired) {
    throw new LifecycleConflictError('Another lifecycle action for this PO is in progress.')
  }
  const runId = claim.value!

  // Re-read the claimed run (now release_in_progress) for the work set.
  const claimed = await getRunByPo(db, input.dealerId, input.poId, true)
  if (!claimed || claimed.state !== 'release_in_progress') {
    throw new LifecycleConflictError('Release claim lost; reload and retry.')
  }
  const approved = await getApprovedPricesForBatch(db, run.pricingBatchId)
  const remaining = claimed.items.filter((i) => i.releaseVerifiedAt === null)

  const result = await performReleaseTransfers({
    dealerId: input.dealerId,
    runId,
    attemptId,
    remaining,
    allItems: claimed.items,
    expectedProductIds: claimed.expectedProductIds,
    approved,
    target,
  })

  // Finalize (short tx): key on attemptId, not version (the claim bumped it).
  let finalState: PurchaseLifecycleRun['state']
  let blockedReason: string | null = null
  let releasedAt: Date | null = null
  let releaseLastError: string | null = null
  if (result.priceDrift) {
    if (result.anyTransferred) {
      finalState = 'blocked'
      blockedReason = 'release_price_drift'
      releaseLastError = 'Live price drifted after some lots were released; rollback is the safe recovery.'
    } else {
      finalState = 'blocked'
      blockedReason = 'release_preflight_failed'
      releaseLastError = 'Live price did not match the approved price; nothing was moved.'
    }
  } else if (!result.postPriceOk) {
    finalState = 'blocked'
    blockedReason = 'release_price_drift'
    releaseLastError = 'Live price no longer matches the approved price after the release pass; rollback is the safe recovery.'
  } else if (result.allVerified) {
    finalState = 'released'
    releasedAt = new Date()
  } else {
    finalState = 'blocked'
    blockedReason = 'release_partial_failure'
    releaseLastError = 'Some lots could not be confirmed sellable; continue remaining or roll back.'
  }

  await withPoLifecycleLock(input.dealerId, input.poId, async (client) => {
    const ok = await finalizeReleaseRun(client, {
      runId,
      attemptId,
      state: finalState,
      blockedReason,
      releasedAt,
      releaseLastError,
    })
    if (!ok) {
      // Another attempt took over this run (our lease expired). Leave its
      // state alone — it owns the run now.
      return false
    }
    await appendAuditEvent(client, {
      actorType: input.userId ? 'user' : 'system',
      actorUserId: input.userId,
      entityId: String(runId),
      entityType: 'purchase_inventory_lifecycle_run',
      eventType: 'purchase.lifecycle.release_finalized',
      module: 'catalog',
      payload: {
        dealerId: input.dealerId,
        poId: input.poId,
        attemptId,
        finalState,
        blockedReason,
        priceDrift: result.priceDrift,
        anyTransferred: result.anyTransferred,
        allVerified: result.allVerified,
        postPriceOk: result.postPriceOk,
      },
      requestId: randomUUID(),
      scope: null,
      undoPayload: null,
    })
    return true
  })

  return statusOrThrow(input.dealerId, input.poId)
}

export async function release(input: {
  dealerId: number
  poId: string
  expectedVersion: number
  targetLocationId: number
  userId: number | null
}): Promise<PurchaseLifecycleStatusResponse> {
  await requireReleaseSchema(getPool())
  return runReleaseAttempt({ ...input, fresh: true })
}

export async function continueRelease(input: {
  dealerId: number
  poId: string
  expectedVersion: number
  userId: number | null
}): Promise<PurchaseLifecycleStatusResponse> {
  await requireReleaseSchema(getPool())
  return runReleaseAttempt({ ...input, fresh: false })
}

// ---------------------------- Rollback release -----------------------------

/**
 * Move any already-released expected lots back into the Dave inspection
 * room (the safety recovery for a partial or price-drift release), then
 * re-verify quarantine. On a clean re-quarantine the run returns to
 * priced_verified — the next release attempt re-reads the live price
 * before moving anything, so priced_verified means "ready to attempt
 * release again," not a timeless price guarantee. If any expected lot is
 * still sellable after the move-back, the run blocks on
 * release_rollback_failed (retry rollback).
 */
export async function rollbackRelease(input: {
  dealerId: number
  poId: string
  expectedVersion: number
  userId: number | null
}): Promise<PurchaseLifecycleStatusResponse> {
  const db = getPool()
  await requireReleaseSchema(db)
  const run = await getRunByPo(db, input.dealerId, input.poId, true)
  if (!run) throw new LifecycleBadRequestError('No lifecycle run for this PO.')
  if (run.version !== input.expectedVersion) {
    throw new LifecycleConflictError('Lifecycle changed since this view loaded; reload and retry.')
  }
  if (run.path !== 'quarantine') {
    throw new LifecycleBadRequestError('Release rollback only applies to the quarantine path.')
  }
  const rollbackable =
    run.state === 'released' ||
    (run.state === 'blocked' &&
      (run.blockedReason === 'release_preflight_failed' ||
        run.blockedReason === 'release_partial_failure' ||
        run.blockedReason === 'release_price_drift' ||
        run.blockedReason === 'release_rollback_failed'))
  if (!rollbackable) {
    throw new LifecycleBadRequestError(`Cannot roll back release from state "${run.state}".`)
  }

  // Claim the rollback BEFORE any physical move-back: this CAS-bumps
  // version (so a concurrent "continue release" can no longer win its own
  // optimistic claim and start releasing while we are moving lots back)
  // and stamps a fresh attempt id + lease. The final resetReleaseRun keys
  // on this attempt id, so a slow move-back can never race another action
  // into an inconsistent run. The run keeps its current state during the
  // move-back; there is no dedicated rollback-in-progress state.
  const rollbackAttemptId = randomUUID()
  const claim = await withPoLifecycleLock(input.dealerId, input.poId, async (client) => {
    const locked = await lockRunForRelease(client, input.dealerId, input.poId)
    if (!locked) throw new LifecycleBadRequestError('Lifecycle run vanished.')
    if (locked.version !== input.expectedVersion) {
      throw new LifecycleConflictError('Lifecycle changed since this view loaded; reload and retry.')
    }
    const ok = await claimRollbackAttempt(client, {
      runId: locked.id,
      expectedVersion: locked.version,
      attemptId: rollbackAttemptId,
      leaseExpiresAt: new Date(Date.now() + RELEASE_LEASE_TTL_MS),
    })
    if (!ok) {
      throw new LifecycleConflictError('Lifecycle changed since this view loaded; reload and retry.')
    }
    return locked.id
  })
  if (!claim.acquired) {
    throw new LifecycleConflictError('Another lifecycle action for this PO is in progress.')
  }

  const productIds = [...new Set(run.items.map((item) => item.sweedProductId))]
  let movedBackCount = 0
  let sellableAfter = 0
  const now = new Date()
  try {
    await withSweedSession(async () => {
      const locations = await listStockLocations(input.dealerId)
      const inspection = findInspectionLocation(locations)
      if (inspection.stockTypeId === null) {
        throw new StockTransferError(`Inspection room "${inspection.name}" has no stock type.`)
      }
      const liveByProduct = new Map<number, LiveInventoryLot[]>()
      for (const productId of productIds) {
        liveByProduct.set(productId, await listLiveLotsForProduct(input.dealerId, productId))
      }
      for (const item of run.items) {
        const matching = matchExpectedLots(item, liveByProduct.get(item.sweedProductId) ?? [])
        for (const lot of matching) {
          if (!isForSaleLocationName(lot.stockLocationName)) continue
          const moved = await transferLot({
            dealerId: input.dealerId,
            lot,
            targetLocationId: inspection.id,
            targetStockTypeId: inspection.stockTypeId,
          })
          if (moved) movedBackCount += 1
        }
      }
      // Re-read and persist quarantine evidence after the move-back.
      for (const item of run.items) {
        const reread = (await listLiveLotsForProduct(input.dealerId, item.sweedProductId)).map(toGateLot)
        const verdict = evaluateItemQuarantine(
          { inventoryItemId: item.inventoryItemId, metrcTag: item.metrcTag },
          reread,
        )
        if (!verdict.quarantined) sellableAfter += 1
      }
    })
  } catch (error) {
    if (error instanceof StockTransferError) throw new LifecycleBadRequestError(error.message)
    throw error
  }

  const nextState: PurchaseLifecycleRun['state'] = sellableAfter === 0 ? 'priced_verified' : 'blocked'
  const lockResult = await withPoLifecycleLock(input.dealerId, input.poId, async (client) => {
    const ok = await resetReleaseRun(client, {
      runId: run.id,
      attemptId: rollbackAttemptId,
      state: nextState,
      blockedReason: sellableAfter === 0 ? null : 'release_rollback_failed',
    })
    if (!ok) {
      throw new LifecycleConflictError('Lifecycle changed since this view loaded; reload and retry.')
    }
    await appendAuditEvent(client, {
      actorType: input.userId ? 'user' : 'system',
      actorUserId: input.userId,
      entityId: String(run.id),
      entityType: 'purchase_inventory_lifecycle_run',
      eventType: 'purchase.lifecycle.release_rolled_back',
      module: 'catalog',
      payload: {
        dealerId: input.dealerId,
        poId: input.poId,
        movedBackCount,
        sellableAfter,
        nextState,
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
  void now
  return statusOrThrow(input.dealerId, input.poId)
}
