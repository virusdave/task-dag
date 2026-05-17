/**
 * Periodic market-evidence alarm scanner.
 *
 * Runs from the config-workers scheduler every 15 minutes (default
 * cadence; see MARKET_EVIDENCE_ALARM_DEFAULT_SCHEDULE_WINDOWS). For
 * every product visible in `vw_pricing_evidence_freshness` whose
 * `alarm_class` is non-null and whose competitor evidence is missing,
 * already-stale, or about to expire (`expires_at` within 12h), this
 * job:
 *
 *   1. Groups candidates by `alarm_class` (in_stock / pending_purchase
 *      / brand_match).
 *   2. Expands each class with same-brand siblings whose freshness is
 *      not `fresh` (capped at 50 per brand to avoid thundering herd
 *      enqueues for very large brands).
 *   3. Re-enqueues each class through the canonical
 *      `enqueueMarketRefreshForProducts` helper at priority=0. The
 *      helper itself dedupes within a 5-minute window per (product,
 *      enqueue_reason).
 *   4. Fires exactly one `pageDave()` per fired alarm class
 *      summarizing how many products / brands were re-enqueued.
 *   5. Emits a single `config.workers.market_evidence_alarm.completed`
 *      audit event summarising the run.
 *
 * The scanner is safe to call on every tick; if every alarm-class
 * product is fresh, it emits an audit event reporting zero enqueues
 * and pages no one.
 */
import type { QueryResultRow } from 'pg'

import type { ConfigWorkersMarketEvidenceAlarmScanJobPayload } from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import { getPool } from '../../server/db/pool.js'
import type { Queryable } from '../../server/db/pool.js'
import {
  enqueueMarketRefreshForProducts,
  type MarketRefreshAlarmClass,
  type MarketRefreshTrigger,
} from '../litalerts/enqueueMarketRefresh.js'
import { pageDave } from '../runtime/pageDave.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

/** Per-brand sibling expansion cap; matches the 50 in the spec. */
export const BRAND_SIBLING_CAP = 50

/** How far ahead of expires_at we treat evidence as "about to expire". */
export const EXPIRING_SOON_WINDOW_MS = 12 * 60 * 60 * 1000

export type FreshnessLabel = 'fresh' | 'stale' | 'very_stale' | 'expired' | 'absent'

export interface FreshnessRow {
  productId: number
  brandName: string | null
  alarmClass: MarketRefreshAlarmClass | null
  freshness: FreshnessLabel
  capturedAt: Date | null
  expiresAt: Date | null
}

/**
 * Returns true when this row should make us re-enqueue (regardless of
 * whether the row itself is an alarm row or a sibling). The "alarm
 * row" guard (alarmClass != null) is enforced separately by callers
 * since the same predicate is reused on sibling rows where alarm_class
 * is typically null.
 */
export function isCandidateFreshness(row: FreshnessRow, now: Date): boolean {
  if (row.capturedAt === null) {
    return true
  }
  if (row.freshness === 'very_stale' || row.freshness === 'expired' || row.freshness === 'absent') {
    return true
  }
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime() + EXPIRING_SOON_WINDOW_MS) {
    return true
  }
  return false
}

export interface PlannedEnqueueCall {
  productIds: number[]
  trigger: MarketRefreshTrigger
}

export interface PlannedAlarmClassBatch {
  alarmClass: MarketRefreshAlarmClass
  /** Distinct product ids covered by this class (alarm rows + siblings). */
  productIds: number[]
  /** Distinct brand names contributing to this class's enqueues. */
  brandNames: string[]
  /** The actual enqueueMarketRefreshForProducts calls to make. */
  enqueueCalls: PlannedEnqueueCall[]
  /** The single page-dave message to send for this class. */
  pageMessage: string
}

export interface AlarmScanPlan {
  byClass: PlannedAlarmClassBatch[]
}

/** Maps the alarm_class enum to the matching enqueue trigger kind. */
function triggerKindForAlarmClass(alarmClass: MarketRefreshAlarmClass): MarketRefreshTrigger['kind'] {
  switch (alarmClass) {
    case 'in_stock':
      return 'in-stock-alarm'
    case 'pending_purchase':
      return 'pending-purchase'
    case 'brand_match':
      return 'brand-alarm'
  }
}

function pageMessageForClass(
  alarmClass: MarketRefreshAlarmClass,
  productCount: number,
  brandCount: number,
): string {
  switch (alarmClass) {
    case 'in_stock':
      return `in_stock market-evidence alarm: ${productCount} products (${brandCount} brands) have expired or expiring competitor data; re-enqueued at priority=0`
    case 'pending_purchase':
      return `pending_purchase market-evidence alarm: ${productCount} products on active pending-purchase rows have no/expired competitor data; re-enqueued`
    case 'brand_match':
      return `brand_match alarm: ${productCount} products sharing brands with pending purchases have stale evidence; re-enqueued`
  }
}

/**
 * Pure planner: given the candidate alarm rows and the pool of
 * non-fresh sibling rows keyed by brand, produces the per-class
 * enqueue calls + page messages. Tested in isolation.
 *
 * - `candidateRows` MUST already be filtered to alarm_class != null
 *   AND `isCandidateFreshness(...) === true`.
 * - `siblingRowsByBrand` MUST contain every non-fresh row for every
 *   brand seen on a candidate row (the caller is responsible for the
 *   second SQL load).
 *
 * Returns one PlannedAlarmClassBatch per alarm class that has any
 * product to enqueue. Empty classes are omitted (so the caller's
 * "page only if anything fired" rule trivially holds).
 */
export function planAlarmScanEnqueue(
  candidateRows: FreshnessRow[],
  siblingRowsByBrand: Map<string, FreshnessRow[]>,
): AlarmScanPlan {
  // alarm_class -> brand_name -> Set<productId>
  const productsByClassAndBrand = new Map<MarketRefreshAlarmClass, Map<string, Set<number>>>()
  // alarm_class -> Set<productId> (entire class, all brands collapsed)
  const productsByClass = new Map<MarketRefreshAlarmClass, Set<number>>()
  // alarm_class -> Set<brand_name> (only brands that contributed at
  // least one product, including via sibling expansion).
  const brandsByClass = new Map<MarketRefreshAlarmClass, Set<string>>()

  const ensureClass = (alarmClass: MarketRefreshAlarmClass): void => {
    if (!productsByClassAndBrand.has(alarmClass)) {
      productsByClassAndBrand.set(alarmClass, new Map())
    }
    if (!productsByClass.has(alarmClass)) {
      productsByClass.set(alarmClass, new Set())
    }
    if (!brandsByClass.has(alarmClass)) {
      brandsByClass.set(alarmClass, new Set())
    }
  }

  const addProduct = (
    alarmClass: MarketRefreshAlarmClass,
    brandName: string | null,
    productId: number,
  ): void => {
    ensureClass(alarmClass)
    productsByClass.get(alarmClass)!.add(productId)
    const brandKey = brandName ?? ''
    const brandMap = productsByClassAndBrand.get(alarmClass)!
    if (!brandMap.has(brandKey)) {
      brandMap.set(brandKey, new Set())
    }
    brandMap.get(brandKey)!.add(productId)
    if (brandName !== null) {
      brandsByClass.get(alarmClass)!.add(brandName)
    }
  }

  // 1) Seed each class with its own alarm rows.
  for (const row of candidateRows) {
    if (row.alarmClass === null) {
      continue
    }
    addProduct(row.alarmClass, row.brandName, row.productId)
  }

  // 2) Expand each alarm row's brand with non-fresh siblings, capped
  //    at BRAND_SIBLING_CAP per brand. The cap is applied across the
  //    whole class so a brand contributing siblings to multiple alarm
  //    rows still doesn't blow past 50.
  const siblingProductsAdmittedByClassAndBrand = new Map<
    MarketRefreshAlarmClass,
    Map<string, Set<number>>
  >()
  for (const row of candidateRows) {
    if (row.alarmClass === null || row.brandName === null) {
      continue
    }
    const siblings = siblingRowsByBrand.get(row.brandName) ?? []
    if (siblings.length === 0) {
      continue
    }
    if (!siblingProductsAdmittedByClassAndBrand.has(row.alarmClass)) {
      siblingProductsAdmittedByClassAndBrand.set(row.alarmClass, new Map())
    }
    const admittedByBrand = siblingProductsAdmittedByClassAndBrand.get(row.alarmClass)!
    if (!admittedByBrand.has(row.brandName)) {
      admittedByBrand.set(row.brandName, new Set())
    }
    const admitted = admittedByBrand.get(row.brandName)!

    for (const sibling of siblings) {
      if (sibling.productId === row.productId) {
        continue
      }
      if (sibling.freshness === 'fresh') {
        continue
      }
      if (admitted.size >= BRAND_SIBLING_CAP) {
        break
      }
      admitted.add(sibling.productId)
      addProduct(row.alarmClass, row.brandName, sibling.productId)
    }
  }

  // 3) Materialize plan in canonical alarm-class order so output is
  //    deterministic for tests / audit payloads.
  const orderedClasses: MarketRefreshAlarmClass[] = ['in_stock', 'pending_purchase', 'brand_match']
  const batches: PlannedAlarmClassBatch[] = []

  for (const alarmClass of orderedClasses) {
    const productSet = productsByClass.get(alarmClass)
    if (!productSet || productSet.size === 0) {
      continue
    }
    const brandSet = brandsByClass.get(alarmClass) ?? new Set<string>()
    const productIds = [...productSet].sort((a, b) => a - b)
    const brandNames = [...brandSet].sort()

    let enqueueCalls: PlannedEnqueueCall[]
    if (alarmClass === 'brand_match') {
      // brand-alarm triggers REQUIRE a brandName, so we must split per
      // brand. Products with no brand are batched under an "unknown
      // brand" synthetic call so they still get enqueued (defensive;
      // should not happen for the brand_match class in practice).
      const brandToProducts = productsByClassAndBrand.get(alarmClass)!
      const sortedBrandKeys = [...brandToProducts.keys()].sort()
      enqueueCalls = sortedBrandKeys
        .filter((brandKey) => brandKey !== '')
        .map((brandKey) => ({
          productIds: [...brandToProducts.get(brandKey)!].sort((a, b) => a - b),
          trigger: { kind: 'brand-alarm', brandName: brandKey } satisfies MarketRefreshTrigger,
        }))
      const orphanProducts = brandToProducts.get('')
      if (orphanProducts && orphanProducts.size > 0) {
        enqueueCalls.push({
          productIds: [...orphanProducts].sort((a, b) => a - b),
          trigger: { kind: 'brand-alarm', brandName: '(unknown)' } satisfies MarketRefreshTrigger,
        })
      }
    } else {
      const trigger: MarketRefreshTrigger =
        alarmClass === 'in_stock'
          ? { kind: 'in-stock-alarm' }
          : { kind: 'pending-purchase' }
      enqueueCalls = [{ productIds, trigger }]
    }

    batches.push({
      alarmClass,
      productIds,
      brandNames,
      enqueueCalls,
      pageMessage: pageMessageForClass(alarmClass, productIds.length, brandNames.length),
    })

    // Touch helpers so the compiler doesn't flag the lookup as unused.
    void triggerKindForAlarmClass(alarmClass)
  }

  return { byClass: batches }
}

interface FreshnessQueryRow extends QueryResultRow {
  product_id: number
  brand_name: string | null
  alarm_class: MarketRefreshAlarmClass | null
  freshness: FreshnessLabel
  captured_at: Date | null
  expires_at: Date | null
}

function rowFromQuery(row: FreshnessQueryRow): FreshnessRow {
  return {
    productId: row.product_id,
    brandName: row.brand_name,
    alarmClass: row.alarm_class,
    freshness: row.freshness,
    capturedAt: row.captured_at,
    expiresAt: row.expires_at,
  }
}

async function loadAlarmCandidateRows(db: Queryable): Promise<FreshnessRow[]> {
  const result = await db.query<FreshnessQueryRow>(
    `
      select product_id, brand_name, alarm_class, freshness, captured_at, expires_at
      from vw_pricing_evidence_freshness
      where alarm_class is not null
        and (
          captured_at is null
          or expires_at <= now() + interval '12 hours'
          or freshness in ('very_stale', 'expired')
        )
    `,
  )
  return result.rows.map(rowFromQuery)
}

async function loadBrandSiblingRows(db: Queryable, brandNames: string[]): Promise<FreshnessRow[]> {
  if (brandNames.length === 0) {
    return []
  }
  const result = await db.query<FreshnessQueryRow>(
    `
      select product_id, brand_name, alarm_class, freshness, captured_at, expires_at
      from vw_pricing_evidence_freshness
      where brand_name = any($1::text[])
        and freshness != 'fresh'
    `,
    [brandNames],
  )
  return result.rows.map(rowFromQuery)
}

/**
 * Hook seam so the test file can swap the side-effecting dependencies
 * without spinning up a real database, a real pageDave child process,
 * or the real enqueue helper. Production wires the real implementations
 * in the module-default constant.
 */
export interface AlarmScanDependencies {
  loadCandidates: (now: Date) => Promise<FreshnessRow[]>
  loadSiblingsByBrand: (brandNames: string[]) => Promise<Map<string, FreshnessRow[]>>
  enqueue: typeof enqueueMarketRefreshForProducts
  page: (message: string) => Promise<void>
  appendAudit: (input: {
    enqueuedByClass: Record<MarketRefreshAlarmClass, number>
    totalEnqueued: number
    scanRanAt: Date
    trigger: 'scheduled' | 'manual'
    requestedByUserId: number | null
  }) => Promise<void>
}

function buildDefaultDependencies(): AlarmScanDependencies {
  return {
    loadCandidates: async () => {
      const rows = await loadAlarmCandidateRows(getPool())
      return rows
    },
    loadSiblingsByBrand: async (brandNames) => {
      const rows = await loadBrandSiblingRows(getPool(), brandNames)
      const byBrand = new Map<string, FreshnessRow[]>()
      for (const row of rows) {
        if (row.brandName === null) {
          continue
        }
        const list = byBrand.get(row.brandName) ?? []
        list.push(row)
        byBrand.set(row.brandName, list)
      }
      return byBrand
    },
    enqueue: enqueueMarketRefreshForProducts,
    page: pageDave,
    appendAudit: async (input) => {
      await withTransaction(async (db) => {
        await appendAuditEvent(db, {
          actorType: input.requestedByUserId ? 'user' : 'system',
          actorUserId: input.requestedByUserId,
          entityId: 'workers.scheduling.market_evidence_alarm',
          entityType: 'job',
          eventType: 'config.workers.market_evidence_alarm.completed',
          module: 'config',
          payload: {
            enqueuedByClass: input.enqueuedByClass,
            totalEnqueued: input.totalEnqueued,
            scanRanAt: input.scanRanAt.toISOString(),
            trigger: input.trigger,
          },
          requestId: null,
          scope: null,
          undoPayload: null,
        })
      })
    },
  }
}

export interface AlarmScanRunResult {
  totalEnqueued: number
  enqueuedByClass: Record<MarketRefreshAlarmClass, number>
  pagedClasses: MarketRefreshAlarmClass[]
}

/**
 * Pure-ish orchestrator over an AlarmScanDependencies bundle. The
 * production handler injects the real dependencies; tests inject
 * fakes.
 */
export async function executeMarketEvidenceAlarmScan(
  payload: ConfigWorkersMarketEvidenceAlarmScanJobPayload,
  deps: AlarmScanDependencies,
  now: Date = new Date(),
): Promise<AlarmScanRunResult> {
  const candidateRows = (await deps.loadCandidates(now)).filter(
    (row) => row.alarmClass !== null && isCandidateFreshness(row, now),
  )

  const brandNames = new Set<string>()
  for (const row of candidateRows) {
    if (row.brandName !== null) {
      brandNames.add(row.brandName)
    }
  }
  const siblingsByBrand = await deps.loadSiblingsByBrand([...brandNames].sort())

  const plan = planAlarmScanEnqueue(candidateRows, siblingsByBrand)

  const enqueuedByClass: Record<MarketRefreshAlarmClass, number> = {
    in_stock: 0,
    pending_purchase: 0,
    brand_match: 0,
  }
  let totalEnqueued = 0
  const pagedClasses: MarketRefreshAlarmClass[] = []

  for (const batch of plan.byClass) {
    let enqueuedInBatch = 0
    for (const call of batch.enqueueCalls) {
      const result = await deps.enqueue(call.productIds, {
        trigger: call.trigger,
        priority: 0,
        alarmClass: batch.alarmClass,
      })
      enqueuedInBatch += result.enqueuedQueueRowIds.length
    }
    enqueuedByClass[batch.alarmClass] = enqueuedInBatch
    totalEnqueued += enqueuedInBatch
    if (batch.productIds.length > 0) {
      // Page the operator once per class, regardless of how many
      // brand-keyed enqueue calls we just fanned out into.
      await deps.page(batch.pageMessage)
      pagedClasses.push(batch.alarmClass)
    }
  }

  await deps.appendAudit({
    enqueuedByClass,
    totalEnqueued,
    scanRanAt: now,
    trigger: payload.trigger,
    requestedByUserId: payload.requestedByUserId,
  })

  return { totalEnqueued, enqueuedByClass, pagedClasses }
}

export async function runConfigWorkersMarketEvidenceAlarmScanJob(
  _context: JobHandlerContext,
  payload: ConfigWorkersMarketEvidenceAlarmScanJobPayload,
): Promise<void> {
  await executeMarketEvidenceAlarmScan(payload, buildDefaultDependencies())
}
