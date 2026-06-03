/**
 * Market-data-sweep enqueue helper.
 *
 * This is the single canonical entry point for adding products to the
 * Lit Alerts refresh queue (`pending_litalerts_refresh_queue`) and
 * immediately scheduling the per-row variant refresh job.
 *
 * It handles:
 *   - default priority by trigger kind (alarms first, proposals next,
 *     manual / rolling later)
 *   - a 5-minute idempotency window so callers that fire the same
 *     product into the queue twice (e.g. a sibling job and the rolling
 *     scheduler racing) do not produce duplicate work
 *   - one audit event per batch (NOT per product) so high-fan-out
 *     callers do not flood the audit log
 *
 * Callers (current and future):
 *   - rolling 24h re-enqueue scheduler in
 *     helios/src/worker/runtime/configWorkersScheduler.ts
 *   - pending-purchase packet generator in
 *     helios/src/worker/jobs/generatePendingPurchasePacketJob.ts
 *   - `helios/scripts/enqueue-market-refresh.mjs` CLI bridge, which is
 *     how non-JS callers (the Python repricing scripts under
 *     catalog/repricing/, and similarly the bulk_additions / category
 *     seed scripts) shell into this helper
 *   - the alarm scanner (sibling leaf, not in this file)
 *   - manual run-now UI affordances
 *
 * If you are wiring a new Python or shell caller, prefer shelling into
 * `helios/scripts/enqueue-market-refresh.mjs` rather than reaching into
 * the queue directly.
 */
import type { Queryable } from '../../server/db/pool.js'
import { withTransaction } from '../../server/db/tx.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { enqueueJobs, JOB_PRIORITY_BEST_EFFORT } from '../../server/jobs/enqueueJob.js'
import type { JsonValue } from '../../shared/contracts/index.js'

/**
 * Deterministic per-product jitter in seconds in the band [-7200, +7200]
 * (i.e. ± 2 hours). The same product always picks the same offset so the
 * rolling scheduler does not herd thousands of variants into the same
 * scheduling minute every day.
 *
 * Used by:
 *   - the rolling re-enqueue scheduler tick
 *     (worker/runtime/configWorkersScheduler.ts) when computing the
 *     next next_refresh_at on rows it just pushed onto the queue
 *   - the per-variant refresh handler
 *     (worker/jobs/configWorkersLitalertsRefreshJob.ts) when stamping
 *     next_refresh_at on a successful observation
 *
 * Implemented as FNV-1a over the 4 bytes of `productId` so we don't pull
 * in a cryptographic hash for what is essentially a uniform jitter knob.
 */
export function rollingRefreshJitterSecondsForProduct(productId: number): number {
  let hash = 0x811c9dc5
  let value = productId >>> 0
  for (let byteIndex = 0; byteIndex < 4; byteIndex += 1) {
    const byte = value & 0xff
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
    value = value >>> 8
  }
  return (hash % 14400) - 7200
}

export type MarketRefreshTrigger =
  | { kind: 'rolling' }
  | { kind: 'proposal-source'; proposalLabel?: string }
  | { kind: 'pending-purchase'; pendingPurchaseRowId?: number }
  | { kind: 'brand-alarm'; brandName: string }
  | { kind: 'in-stock-alarm'; siteDealerId?: number }
  | { kind: 'manual'; reason?: string }

export type MarketRefreshAlarmClass = 'in_stock' | 'pending_purchase' | 'brand_match'

export interface EnqueueOptions {
  trigger: MarketRefreshTrigger
  /** Defaults derive from trigger.kind. Lower number = higher priority. */
  priority?: number
  /** When the resulting queue row should become eligible to run. Defaults to now. */
  runAt?: Date
  requestedByUserId?: number | null
  alarmClass?: MarketRefreshAlarmClass | null
}

export interface EnqueueMarketRefreshResult {
  enqueuedQueueRowIds: number[]
  enqueuedJobIds: number[]
  skippedCount: number
}

const DEFAULT_PRIORITY_BY_KIND: Record<MarketRefreshTrigger['kind'], number> = {
  'brand-alarm': 0,
  'pending-purchase': 0,
  'in-stock-alarm': 0,
  'proposal-source': 10,
  manual: 50,
  rolling: 100,
}

/**
 * The queue's check constraint on `enqueue_reason` accepts exactly these
 * literal values — they line up 1:1 with `MarketRefreshTrigger['kind']`.
 */
function triggerKindToEnqueueReason(kind: MarketRefreshTrigger['kind']): string {
  return kind
}

function pickPriority(options: EnqueueOptions): number {
  if (typeof options.priority === 'number') {
    return options.priority
  }
  return DEFAULT_PRIORITY_BY_KIND[options.trigger.kind]
}

function buildNotesForTrigger(trigger: MarketRefreshTrigger): string | null {
  switch (trigger.kind) {
    case 'rolling':
      return 'Enqueued by rolling market-data refresh scheduler.'
    case 'proposal-source':
      return trigger.proposalLabel
        ? `Enqueued for proposal scope ${trigger.proposalLabel}.`
        : 'Enqueued for proposal scope.'
    case 'pending-purchase':
      return trigger.pendingPurchaseRowId
        ? `Enqueued from pending-purchase packet ${trigger.pendingPurchaseRowId}.`
        : 'Enqueued from pending-purchase packet.'
    case 'brand-alarm':
      return `Enqueued by brand-alarm for ${trigger.brandName}.`
    case 'in-stock-alarm':
      return trigger.siteDealerId
        ? `Enqueued by in-stock alarm at site ${trigger.siteDealerId}.`
        : 'Enqueued by in-stock alarm.'
    case 'manual':
      return trigger.reason ? `Manual: ${trigger.reason}` : 'Manual enqueue.'
  }
}

/**
 * Bulk dedupe-window insert.
 *
 * Inserts a queue row for each product in `productIds` that does
 * NOT already have a pending / in-progress row for the same
 * `enqueue_reason` inside the last 5 minutes; returns the
 * (productId, queueRowId) pairs for the rows that were actually
 * inserted.
 *
 * The `where not exists (...)` inside the `insert … select` keeps
 * the dedupe atomic under concurrent callers (two scheduler ticks,
 * a sibling job racing with a manual action, etc.), exactly as the
 * old per-row implementation. The plural variant collapses N
 * round-trips per call into one bulk INSERT plus one RETURNING.
 */
async function insertQueueRowsWithDedupe(
  db: Queryable,
  productIds: number[],
  shared: {
    enqueueReason: string
    priority: number
    runAt: Date
    alarmClass: MarketRefreshAlarmClass | null
    notes: string | null
  },
): Promise<Array<{ productId: number; queueRowId: number }>> {
  if (productIds.length === 0) {
    return []
  }
  const payload = productIds.map((productId) => ({ product_id: productId }))
  const result = await db.query<{ id: number; product_id: number }>(
    `
      insert into pending_litalerts_refresh_queue (
        product_id,
        site_dealer_id,
        reason,
        source_snapshot_id,
        status,
        notes,
        priority,
        next_run_at,
        enqueue_reason,
        alarm_class
      )
      select
        x.product_id,
        null,
        'manual',
        null,
        'pending',
        $6,
        $3,
        $4,
        $2,
        $5
      from jsonb_to_recordset($1::jsonb) as x(product_id bigint)
      where not exists (
        select 1
        from pending_litalerts_refresh_queue existing
        where existing.product_id = x.product_id
          and existing.enqueue_reason = $2
          and existing.status in ('pending', 'in_progress')
          and existing.enqueued_at > now() - interval '5 minutes'
      )
      returning id, product_id
    `,
    [
      JSON.stringify(payload),
      shared.enqueueReason,
      shared.priority,
      shared.runAt,
      shared.alarmClass,
      shared.notes,
    ],
  )
  return result.rows.map((row) => ({
    queueRowId: row.id,
    productId: row.product_id,
  }))
}

/**
 * Serialize the MarketRefreshTrigger union for the audit payload (and
 * for the future-job-handler view of why this run was queued).
 */
function triggerToJson(trigger: MarketRefreshTrigger): JsonValue {
  // Round-trip through JSON to guarantee a plain JsonValue (drops
  // `undefined` keys, etc.).
  return JSON.parse(JSON.stringify(trigger)) as JsonValue
}

export async function enqueueMarketRefreshForProducts(
  productIds: number[],
  options: EnqueueOptions,
): Promise<EnqueueMarketRefreshResult> {
  if (productIds.length === 0) {
    return { enqueuedQueueRowIds: [], enqueuedJobIds: [], skippedCount: 0 }
  }

  const enqueueReason = triggerKindToEnqueueReason(options.trigger.kind)
  const priority = pickPriority(options)
  const runAt = options.runAt ?? new Date()
  const alarmClass = options.alarmClass ?? null
  const notes = buildNotesForTrigger(options.trigger)
  const triggerKindLabel = options.trigger.kind

  // De-dupe within the call itself: a caller that passes the same id
  // twice should not produce two queue rows. We preserve first-seen
  // order so the priority comparator stays stable.
  const uniqueProductIds: number[] = []
  const seen = new Set<number>()
  for (const productId of productIds) {
    if (seen.has(productId)) {
      continue
    }
    seen.add(productId)
    uniqueProductIds.push(productId)
  }

  // ============================================================================
  // Phase A4 (virusdave/top-level#11): one transaction per call
  // with one bulk dedupe-window INSERT and one bulk enqueueJobs(),
  // replacing the old per-product `for (...) { await
  // withTransaction(...) { insertQueueRowWithDedupe; enqueueJob } }`
  // loop. For a 500-product rolling-refresh tick the prior path
  // issued 3 round-trips × 500 products = 1500 round-trips plus a
  // final audit-tx; the new path is 3-4 round-trips per call
  // (dedupe-window INSERT, existing-dedupe SELECT on job_queue,
  // bulk INSERT into job_queue, audit-event INSERT).
  //
  // Behaviour preserved:
  //   - 5-minute dedupe window on (product_id, enqueue_reason)
  //     via WHERE NOT EXISTS in the queue-row INSERT.
  //   - Per-product `(productId -> queueRowId)` mapping flows
  //     through the RETURNING clause so the matching enqueueJobs
  //     call can build the per-row dedupe keys
  //     (`config.workers.litalerts_refresh.variant:<queueRowId>`).
  //   - Output order: `enqueuedQueueRowIds` follows the dedupe
  //     INSERT's RETURNING order. `enqueuedJobIds` is parallel to
  //     it. `skippedCount` is the difference between input and
  //     inserted counts (deduped or already-pending products).
  //   - One audit event per non-empty batch (unchanged).
  // ============================================================================
  const { enqueuedQueueRowIds, enqueuedJobIds, skippedCount } = await withTransaction(
    async (db) => {
      const insertedQueueRows = await insertQueueRowsWithDedupe(db, uniqueProductIds, {
        enqueueReason,
        priority,
        runAt,
        alarmClass,
        notes,
      })
      const localSkipped = uniqueProductIds.length - insertedQueueRows.length
      if (insertedQueueRows.length === 0) {
        return {
          enqueuedQueueRowIds: [] as number[],
          enqueuedJobIds: [] as number[],
          skippedCount: localSkipped,
        }
      }
      const jobInputs = insertedQueueRows.map(({ productId, queueRowId }) => ({
        // Lit Alerts variant refreshes are background batch work — they
        // run by the thousand whenever a rolling tick or alarm scan
        // fires, and would starve live-interactive operator clicks if
        // they defaulted to JOB_PRIORITY_INTERACTIVE.
        priority: JOB_PRIORITY_BEST_EFFORT,
        // Lit Alerts refresh does not touch Sweed; no shared session lane.
        concurrencyKey: null,
        // One job per pending queue row keeps the dedupe surface obvious.
        dedupeKey: `config.workers.litalerts_refresh.variant:${queueRowId}`,
        jobType: 'config.workers.litalerts_refresh.variant' as const,
        module: 'config' as const,
        payload: {
          productId,
          queueRowId,
          siteDealerId: null,
          sourceSnapshotId: null,
          requestedByUserId: options.requestedByUserId ?? null,
          trigger: triggerKindLabel,
        },
        requestedByUserId: options.requestedByUserId ?? null,
        runAt,
        scope: null,
      }))
      const jobIds = await enqueueJobs(db, jobInputs)
      const queueRowIds = insertedQueueRows.map((row) => row.queueRowId)
      await appendAuditEvent(db, {
        actorType: options.requestedByUserId ? 'user' : 'system',
        actorUserId: options.requestedByUserId ?? null,
        entityId: 'workers.scheduling.litalerts',
        entityType: 'job',
        eventType: 'config.workers.litalerts_refresh.requested',
        module: 'config',
        payload: {
          trigger: triggerToJson(options.trigger),
          productIds: uniqueProductIds,
          enqueuedQueueRowIds: queueRowIds,
          enqueuedJobIds: jobIds,
          alarmClass,
          priority,
          skippedCount: localSkipped,
        },
        requestId: null,
        scope: null,
        undoPayload: null,
      })
      return {
        enqueuedQueueRowIds: queueRowIds,
        enqueuedJobIds: jobIds,
        skippedCount: localSkipped,
      }
    },
  )

  return { enqueuedQueueRowIds, enqueuedJobIds, skippedCount }
}
