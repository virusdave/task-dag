/**
 * Purchase inventory pricing-safety lifecycle automation + monitoring
 * sweep (automation#54, L3; parent epic virusdave/top-level#33).
 *
 * Runs from the config-workers scheduler every 5 minutes by default. Each
 * tick does three things over the active lifecycle runs (those not
 * `released` and touched in the last 14 days):
 *
 *   1. ADVANCE async gates. For runs sitting on a gate that resolves
 *      asynchronously — market data arriving, the pricing batch
 *      generating, the Sweed price reconcile applying — it calls the
 *      existing idempotent one-step advancer `reprice()` so the operator
 *      does not have to keep clicking "reprice" to poll. It NEVER drives
 *      operator/physical transitions (start, receive-to-quarantine,
 *      price approval, release): `awaiting_price_approval` is advanced
 *      only after a DB-only check proves every expected product now has an
 *      approved finite price.
 *
 *   2. QUARANTINE-BREACH monitor. For active quarantine-path runs in a
 *      pre-release state it re-reads live Sweed lots (batched per
 *      dealer/product) and detects any expected lot that is positive-qty
 *      back in a FOR SALE room — a money-safety breach (not-yet-priced
 *      stock on the floor). It persists the live evidence (under the
 *      per-PO lock, re-checking the run is still monitored) and pages;
 *      it does NOT auto-move stock or auto-block (alert-only — a DB block
 *      would not stop Sweed sales).
 *
 *   3. ALERTS. Pages on market-data timeout (no fresh competitor evidence
 *      6h after the request cutoff), price-apply timeout (live price still
 *      != approved 45m after approval — the reconcile likely failed), and
 *      newly-blocked runs (pricing/price-apply/release failures). Pages are
 *      deduped via the audit log so a stuck run pages once per occurrence,
 *      not every tick.
 *
 * The pure decision logic (which runs to advance, breach detection, alert
 * signatures + dedup) is isolated and unit-tested; the side-effecting I/O
 * is injected via `AdvanceDependencies` so the tests need no DB / Sweed /
 * pager.
 */
import type {
  InventoryLifecycleAdvanceJobPayload,
  PurchaseLifecycleRun,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { getPool } from '../../server/db/pool.js'
import { withTransaction } from '../../server/db/tx.js'
import {
  evaluateItemQuarantine,
  type LiveLot,
} from '../../server/catalogPurchaseSellThrough/purchaseInventoryLifecycleGates.js'
import {
  getApprovedPricesForBatch,
  getRecentLifecycleAlerts,
  lifecycleTablesExist,
  listActiveLifecycleRuns,
  type RecentLifecycleAlert,
} from '../../server/catalogPurchaseSellThrough/purchaseInventoryLifecycleQueries.js'
import {
  LifecycleConflictError,
  QUARANTINE_BREACH_MONITORED_STATES,
  persistQuarantineBreachEvidence,
  reprice as repriceLifecycle,
  type BreachItemEvidence,
} from '../../server/catalogPurchaseSellThrough/purchaseInventoryLifecycleService.js'
import { listLiveLotsForProduct } from '../../server/catalog/stockTransferService.js'
import { withSweedSession } from '../sweed/session.js'
import { DependencyUnavailableWorkerError } from '../runtime/errors.js'
import { pageDave, type PageDavePriority } from '../runtime/pageDave.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

// --------------------------- Tunable thresholds ----------------------------

/** No fresh succeeded competitor observation this long after the market
 * request cutoff → page (market data is stuck). */
export const MARKET_TIMEOUT_MS = 6 * 60 * 60 * 1000
/** Live Sweed price still != approved this long after entering
 * price_apply_pending (the stable onset, since reprice freezes updated_at
 * while waiting) → page (the price reconcile likely failed). */
export const PRICE_APPLY_TIMEOUT_MS = 45 * 60 * 1000
/** Re-page an unchanged quarantine breach at most this often. A changed
 * breached-product set re-pages immediately (the signature changes). */
export const BREACH_REPAGE_MS = 24 * 60 * 60 * 1000

/** States advanced unconditionally via `reprice` (async gates the operator
 * has already initiated; advancing them is just polling). */
export const ADVANCE_STATES: ReadonlySet<PurchaseLifecycleRun['state']> = new Set([
  'market_refresh_pending',
  'market_ready',
  'pricing_pending',
  'price_apply_pending',
])

// ----------------------------- Pure helpers --------------------------------

/** Live-lot map key. */
export function lotKey(dealerId: number, productId: number): string {
  return `${dealerId}:${productId}`
}

/** Every expected product of the run has an approved finite price. */
export function isApprovalComplete(
  run: PurchaseLifecycleRun,
  approvedProductIds: ReadonlySet<number>,
): boolean {
  return (
    run.expectedProductIds.length > 0 &&
    run.expectedProductIds.every((id) => approvedProductIds.has(id))
  )
}

/**
 * The runs to advance this tick: all runs in an ADVANCE_STATES gate, plus
 * `awaiting_price_approval` runs whose every expected product is now
 * approved (so we never do a live price read while still waiting on the
 * operator's approval). Preserves input order.
 */
export function selectAdvanceTargets(
  runs: PurchaseLifecycleRun[],
  approvalCompleteRunIds: ReadonlySet<number>,
): PurchaseLifecycleRun[] {
  return runs.filter(
    (run) =>
      ADVANCE_STATES.has(run.state) ||
      (run.state === 'awaiting_price_approval' && approvalCompleteRunIds.has(run.id)),
  )
}

export interface DetectedBreachLot {
  itemId: number
  inventoryItemId: string
  sweedProductId: number
  stockLocation: string | null
  currentQty: number | null
}

/**
 * Detect quarantine breaches for one quarantine-path run: expected lots
 * that are positive-qty in a FOR SALE room (sellable) given the live lots.
 * Reuses the same matching/sellability rule as the verify-quarantine gate
 * — a lot is a breach exactly when it is NOT quarantined.
 */
export function detectBreach(
  run: PurchaseLifecycleRun,
  liveLotsByKey: ReadonlyMap<string, LiveLot[]>,
): DetectedBreachLot[] {
  const breaches: DetectedBreachLot[] = []
  for (const item of run.items) {
    const liveLots = liveLotsByKey.get(lotKey(run.dealerId, item.sweedProductId)) ?? []
    const verdict = evaluateItemQuarantine(
      { inventoryItemId: item.inventoryItemId, metrcTag: item.metrcTag },
      liveLots,
    )
    if (!verdict.quarantined) {
      breaches.push({
        itemId: item.id,
        inventoryItemId: item.inventoryItemId,
        sweedProductId: item.sweedProductId,
        stockLocation: verdict.stockLocation,
        currentQty: verdict.currentQty,
      })
    }
  }
  return breaches
}

export type AlertKind = 'market_timeout' | 'price_apply_timeout' | 'blocked' | 'quarantine_breach'

export interface AlertCondition {
  runId: number
  dealerId: number
  poId: string
  kind: AlertKind
  signature: string
  message: string
  priority: PageDavePriority
  /**
   * Onset of the underlying condition. For onset-based kinds (market /
   * price-apply / blocked) a prior alert with the same signature created
   * at/after this instant means we already paged for this occurrence.
   * Null for quarantine breaches, which dedup on a fixed re-page window.
   */
  onset: Date | null
}

const RELEASE_BLOCKED_REASONS: ReadonlySet<string> = new Set([
  'release_preflight_failed',
  'release_partial_failure',
  'release_price_drift',
  'release_rollback_failed',
])

function hoursBetween(later: number, earlier: number): number {
  return Math.floor((later - earlier) / (60 * 60 * 1000))
}

/**
 * Compute the alert conditions for this tick from the (post-advance) run
 * set plus the persisted breaches. Pure: callers apply dedup + paging.
 */
export function computeAlertConditions(
  runs: PurchaseLifecycleRun[],
  breachByRunId: ReadonlyMap<number, DetectedBreachLot[]>,
  now: Date,
): AlertCondition[] {
  const conditions: AlertCondition[] = []
  const nowMs = now.getTime()

  for (const run of runs) {
    if (run.state === 'market_refresh_pending' && run.marketRequestedAt !== null) {
      const requestedMs = Date.parse(run.marketRequestedAt)
      if (Number.isFinite(requestedMs) && nowMs - requestedMs >= MARKET_TIMEOUT_MS) {
        conditions.push({
          runId: run.id,
          dealerId: run.dealerId,
          poId: run.poId,
          kind: 'market_timeout',
          signature: 'market_timeout',
          message: `Lifecycle market-data timeout: PO ${run.poId} (dealer ${run.dealerId}) still has no fresh competitor pricing ${hoursBetween(nowMs, requestedMs)}h after the request. Check Lit Alerts / re-pull market data.`,
          priority: 4,
          onset: new Date(requestedMs + MARKET_TIMEOUT_MS),
        })
      }
    }

    if (run.state === 'price_apply_pending') {
      const onsetMs = Date.parse(run.updatedAt)
      if (Number.isFinite(onsetMs) && nowMs - onsetMs >= PRICE_APPLY_TIMEOUT_MS) {
        conditions.push({
          runId: run.id,
          dealerId: run.dealerId,
          poId: run.poId,
          kind: 'price_apply_timeout',
          signature: 'price_apply_timeout',
          message: `Lifecycle price-apply timeout: PO ${run.poId} (dealer ${run.dealerId}) live Sweed price still does not match the approved price ${Math.floor((nowMs - onsetMs) / 60000)}m after approval. The price reconcile may have failed.`,
          priority: 5,
          onset: new Date(onsetMs),
        })
      }
    }

    if (run.state === 'blocked' && run.blockedReason !== null) {
      const onsetMs = Date.parse(run.updatedAt)
      conditions.push({
        runId: run.id,
        dealerId: run.dealerId,
        poId: run.poId,
        kind: 'blocked',
        signature: `blocked:${run.blockedReason}`,
        message: `Lifecycle blocked: PO ${run.poId} (dealer ${run.dealerId}) is blocked(${run.blockedReason}). Operator action needed.`,
        priority: RELEASE_BLOCKED_REASONS.has(run.blockedReason) ? 5 : 4,
        onset: Number.isFinite(onsetMs) ? new Date(onsetMs) : null,
      })
    }
  }

  for (const [runId, breaches] of breachByRunId) {
    if (breaches.length === 0) continue
    const run = runs.find((candidate) => candidate.id === runId)
    if (!run) continue
    const productIds = [...new Set(breaches.map((breach) => breach.sweedProductId))].sort(
      (a, b) => a - b,
    )
    const locations = [
      ...new Set(breaches.map((breach) => breach.stockLocation ?? '(unknown)')),
    ].sort()
    conditions.push({
      runId: run.id,
      dealerId: run.dealerId,
      poId: run.poId,
      kind: 'quarantine_breach',
      signature: `quarantine_breach:${productIds.join(',')}`,
      message: `Lifecycle QUARANTINE BREACH: PO ${run.poId} (dealer ${run.dealerId}) has ${breaches.length} not-yet-released lot(s) back in a FOR SALE room (products ${productIds.join(', ')}; rooms ${locations.join(', ')}). Move them back to inspection (repair quarantine) or finish pricing + release.`,
      priority: 5,
      onset: null,
    })
  }

  return conditions
}

/** True when a page for this condition has already been sent recently. */
export function alreadyAlerted(
  cond: AlertCondition,
  recentAlerts: RecentLifecycleAlert[],
  now: Date,
): boolean {
  const matching = recentAlerts.filter(
    (alert) => alert.runId === cond.runId && alert.signature === cond.signature,
  )
  if (cond.kind === 'quarantine_breach') {
    return matching.some((alert) => now.getTime() - alert.createdAt.getTime() < BREACH_REPAGE_MS)
  }
  return (
    cond.onset !== null &&
    matching.some((alert) => alert.createdAt.getTime() >= cond.onset!.getTime())
  )
}

// --------------------------- Injected I/O ----------------------------------

export interface AdvanceSummary {
  trigger: 'scheduled' | 'manual'
  requestedByUserId: number | null
  ranAt: Date
  activeRunCount: number
  advancedCount: number
  advanceConflictCount: number
  advanceErrorCount: number
  breachRunCount: number
  pagedCount: number
}

export interface AdvanceDependencies {
  tablesExist: () => Promise<boolean>
  loadActiveRuns: () => Promise<PurchaseLifecycleRun[]>
  loadApprovedPrices: (pricingBatchId: number) => Promise<Map<number, number>>
  reprice: (dealerId: number, poId: string, expectedVersion: number) => Promise<void>
  readLiveLots: (
    pairs: Array<{ dealerId: number; productId: number }>,
  ) => Promise<Map<string, LiveLot[]>>
  persistBreach: (
    dealerId: number,
    poId: string,
    breaches: BreachItemEvidence[],
  ) => Promise<boolean>
  loadRecentAlerts: (runIds: number[]) => Promise<RecentLifecycleAlert[]>
  page: (message: string, priority: PageDavePriority) => Promise<void>
  recordAlert: (cond: AlertCondition) => Promise<void>
  appendSummary: (summary: AdvanceSummary) => Promise<void>
}

function toGateLot(lot: {
  inventoryItemId: string
  externalTrackCode: string | null
  availableQty: number | null
  currentQty: number | null
  stockLocationName: string | null
}): LiveLot {
  return {
    inventoryItemId: lot.inventoryItemId,
    metrcTag: lot.externalTrackCode,
    qty: lot.availableQty ?? lot.currentQty ?? 0,
    stockLocationName: lot.stockLocationName,
  }
}

function buildDefaultDependencies(): AdvanceDependencies {
  return {
    tablesExist: () => lifecycleTablesExist(getPool()),
    loadActiveRuns: () => listActiveLifecycleRuns(getPool()),
    loadApprovedPrices: (pricingBatchId) => getApprovedPricesForBatch(getPool(), pricingBatchId),
    reprice: async (dealerId, poId, expectedVersion) => {
      await repriceLifecycle({ dealerId, poId, expectedVersion, userId: null })
    },
    readLiveLots: async (pairs) => {
      const out = new Map<string, LiveLot[]>()
      if (pairs.length === 0) return out
      // ONE Sweed session for the whole breach scan; the underlying read is
      // fully-paginated + fail-closed. Pool exhaustion throws
      // DependencyUnavailableWorkerError, which we let propagate so the
      // worker defers/retries rather than silently reporting zero breaches.
      await withSweedSession(async () => {
        for (const { dealerId, productId } of pairs) {
          const lots = (await listLiveLotsForProduct(dealerId, productId)).map(toGateLot)
          out.set(lotKey(dealerId, productId), lots)
        }
      })
      return out
    },
    persistBreach: (dealerId, poId, breaches) =>
      persistQuarantineBreachEvidence({ dealerId, poId, breaches }),
    loadRecentAlerts: (runIds) => getRecentLifecycleAlerts(getPool(), runIds),
    page: (message, priority) => pageDave(message, { priority, title: 'Inventory lifecycle' }),
    recordAlert: async (cond) => {
      await withTransaction(async (db) => {
        await appendAuditEvent(db, {
          actorType: 'system',
          actorUserId: null,
          entityId: String(cond.runId),
          entityType: 'purchase_inventory_lifecycle_run',
          eventType: 'purchase.lifecycle.alerted',
          module: 'catalog',
          payload: {
            signature: cond.signature,
            kind: cond.kind,
            dealerId: cond.dealerId,
            poId: cond.poId,
          },
          requestId: null,
          scope: null,
          undoPayload: null,
        })
      })
    },
    appendSummary: async (summary) => {
      await withTransaction(async (db) => {
        await appendAuditEvent(db, {
          actorType: summary.requestedByUserId ? 'user' : 'system',
          actorUserId: summary.requestedByUserId,
          entityId: 'workers.scheduling.inventory_lifecycle_advance',
          entityType: 'job',
          eventType: 'purchase.lifecycle.advance_completed',
          module: 'catalog',
          payload: {
            trigger: summary.trigger,
            ranAt: summary.ranAt.toISOString(),
            activeRunCount: summary.activeRunCount,
            advancedCount: summary.advancedCount,
            advanceConflictCount: summary.advanceConflictCount,
            advanceErrorCount: summary.advanceErrorCount,
            breachRunCount: summary.breachRunCount,
            pagedCount: summary.pagedCount,
          },
          requestId: null,
          scope: null,
          undoPayload: null,
        })
      })
    },
  }
}

export interface AdvanceRunResult {
  migrationPending: boolean
  activeRunCount: number
  advancedCount: number
  advanceConflictCount: number
  advanceErrorCount: number
  breachRunCount: number
  pagedCount: number
}

/**
 * Dependency-injected orchestrator. Production wires the real I/O; tests
 * inject fakes.
 */
export async function executeInventoryLifecycleAdvance(
  payload: InventoryLifecycleAdvanceJobPayload,
  deps: AdvanceDependencies,
  now: Date = new Date(),
): Promise<AdvanceRunResult> {
  if (!(await deps.tablesExist())) {
    return {
      migrationPending: true,
      activeRunCount: 0,
      advancedCount: 0,
      advanceConflictCount: 0,
      advanceErrorCount: 0,
      breachRunCount: 0,
      pagedCount: 0,
    }
  }

  // ---- Phase 1: advance async gates ----
  const runs = await deps.loadActiveRuns()

  const approvalCompleteRunIds = new Set<number>()
  for (const run of runs) {
    if (run.state !== 'awaiting_price_approval' || run.pricingBatchId === null) continue
    const approved = await deps.loadApprovedPrices(run.pricingBatchId)
    if (isApprovalComplete(run, new Set(approved.keys()))) {
      approvalCompleteRunIds.add(run.id)
    }
  }

  let advancedCount = 0
  let advanceConflictCount = 0
  let advanceErrorCount = 0
  for (const run of selectAdvanceTargets(runs, approvalCompleteRunIds)) {
    try {
      await deps.reprice(run.dealerId, run.poId, run.version)
      advancedCount += 1
    } catch (error) {
      if (error instanceof LifecycleConflictError) {
        // Operator raced us / version moved; retry next tick.
        advanceConflictCount += 1
        continue
      }
      if (error instanceof DependencyUnavailableWorkerError) {
        // Sweed pool exhausted — backpressure. Let the worker defer/retry
        // the whole job rather than hammering the remaining runs.
        throw error
      }
      advanceErrorCount += 1
      // eslint-disable-next-line no-console
      console.error(
        `[inventory-lifecycle-advance] reprice failed for dealer ${run.dealerId} PO ${run.poId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      )
    }
  }

  // ---- Phase 2: breach monitor (reload — advance changed states) ----
  const runs2 = await deps.loadActiveRuns()
  const breachCandidates = runs2.filter(
    (run) => run.path === 'quarantine' && QUARANTINE_BREACH_MONITORED_STATES.has(run.state),
  )

  const pairKeys = new Set<string>()
  const pairs: Array<{ dealerId: number; productId: number }> = []
  for (const run of breachCandidates) {
    for (const item of run.items) {
      const key = lotKey(run.dealerId, item.sweedProductId)
      if (pairKeys.has(key)) continue
      pairKeys.add(key)
      pairs.push({ dealerId: run.dealerId, productId: item.sweedProductId })
    }
  }
  const liveLotsByKey = await deps.readLiveLots(pairs)

  const breachByRunId = new Map<number, DetectedBreachLot[]>()
  for (const run of breachCandidates) {
    const detected = detectBreach(run, liveLotsByKey)
    if (detected.length === 0) continue
    const persisted = await deps.persistBreach(
      run.dealerId,
      run.poId,
      detected.map((breach) => ({
        itemId: breach.itemId,
        stockLocation: breach.stockLocation,
        currentQty: breach.currentQty,
      })),
    )
    // persisted === false means the run raced out of a monitored state
    // (release/released/blocked) after the live read — do not page.
    if (persisted) breachByRunId.set(run.id, detected)
  }

  // ---- Phase 3: alerts (deduped via the audit log) ----
  const conditions = computeAlertConditions(runs2, breachByRunId, now)
  const alertRunIds = [...new Set(conditions.map((cond) => cond.runId))]
  const recentAlerts = await deps.loadRecentAlerts(alertRunIds)

  let pagedCount = 0
  for (const cond of conditions) {
    if (alreadyAlerted(cond, recentAlerts, now)) continue
    // Page FIRST, then record the dedup marker — a duplicate page is far
    // less bad than recording "alerted" and then suppressing retries after
    // a page that never actually sent.
    await deps.page(cond.message, cond.priority)
    await deps.recordAlert(cond)
    pagedCount += 1
  }

  await deps.appendSummary({
    trigger: payload.trigger,
    requestedByUserId: payload.requestedByUserId,
    ranAt: now,
    activeRunCount: runs2.length,
    advancedCount,
    advanceConflictCount,
    advanceErrorCount,
    breachRunCount: breachByRunId.size,
    pagedCount,
  })

  return {
    migrationPending: false,
    activeRunCount: runs2.length,
    advancedCount,
    advanceConflictCount,
    advanceErrorCount,
    breachRunCount: breachByRunId.size,
    pagedCount,
  }
}

export async function runInventoryLifecycleAdvanceJob(
  _context: JobHandlerContext,
  payload: InventoryLifecycleAdvanceJobPayload,
): Promise<void> {
  await executeInventoryLifecycleAdvance(payload, buildDefaultDependencies())
}
