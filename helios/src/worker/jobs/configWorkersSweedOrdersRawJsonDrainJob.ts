// F5 (virusdave/top-level#11): drain sweed_orders.raw_json for orders
// older than `cutoffDays` days in bounded DB batches.
//
// Background: every request-time / historical reader of
// sweed_orders.raw_json has been migrated off it — order line items to
// the materialised sweed_order_items_flat table (phase D1), and the
// cashier creatorId fallback to the backfilled cashier_user_id column
// (migration 061). The only remaining reference is the orders-ingest
// tail-fill, which reads raw_json solely for freshly-inserted invoices
// (never within the >30d drain window). raw_json is therefore pure dead
// weight on historical rows and was the single largest TOAST
// contributor on sweed_orders. Migration 062 made the column nullable.
//
// Safety (reviewed for live prod):
//   * Each batch is its OWN short transaction with lock_timeout=2s and
//     statement_timeout=10s, so a batch can never wedge behind / ahead
//     of the live serving path.
//   * Candidates are picked with FOR UPDATE SKIP LOCKED and updated by
//     primary key, so the drain never blocks (or is blocked by) a
//     concurrent ingest upsert of the same row — it just skips it and
//     catches it next tick.
//   * One job invocation does at most `maxBatches * batchSize` rows and
//     stops after MAX_RUNTIME_MS, so it never floods WAL or holds locks
//     for long. The remainder drains on the next scheduled tick.
//   * Disk is reclaimed by autovacuum after the dead heap/TOAST tuples
//     age out; the worker intentionally does NOT run VACUUM (let alone
//     VACUUM FULL).

import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import type { ConfigWorkersSweedOrdersRawJsonDrainJobPayload } from '../../shared/contracts/index.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

// Hard ceiling on wall-clock per invocation, independent of maxBatches,
// so a slow batch run can't monopolise a worker slot.
const MAX_RUNTIME_MS = 45_000
// Postgres SQLSTATEs we treat as "stop gracefully, resume next tick".
const SQLSTATE_LOCK_NOT_AVAILABLE = '55P03'
const SQLSTATE_QUERY_CANCELED = '57014'

/**
 * Null raw_json for up to `batchSize` of the oldest still-populated
 * orders past the cutoff, in a single short transaction. Returns the
 * number of rows drained.
 */
async function drainOneBatch(cutoff: Date, batchSize: number): Promise<number> {
  return withTransaction(async (db) => {
    await db.query(`set local lock_timeout = '2s'`)
    await db.query(`set local statement_timeout = '10s'`)
    const result = await db.query(
      `
        with candidates as (
          select so.dealer_id, so.invoice_id
            from sweed_orders so
           where so.raw_json is not null
             and so.pay_time < $1::timestamptz
           order by so.pay_time asc, so.dealer_id asc, so.invoice_id asc
           limit $2::int
           for update of so skip locked
        )
        update sweed_orders so
           set raw_json = null
          from candidates c
         where so.dealer_id = c.dealer_id
           and so.invoice_id = c.invoice_id
      `,
      [cutoff, batchSize],
    )
    return result.rowCount ?? 0
  })
}

export async function runConfigWorkersSweedOrdersRawJsonDrainJob(
  context: JobHandlerContext,
  payload: ConfigWorkersSweedOrdersRawJsonDrainJobPayload,
): Promise<void> {
  const cutoff = new Date(Date.now() - payload.cutoffDays * 24 * 60 * 60 * 1000)
  const deadline = Date.now() + MAX_RUNTIME_MS

  let batches = 0
  let drained = 0
  let stoppedReason: 'no_more_rows' | 'max_batches' | 'deadline' | 'lock_or_timeout' = 'no_more_rows'

  while (batches < payload.maxBatches) {
    if (Date.now() >= deadline) {
      stoppedReason = 'deadline'
      break
    }

    let count: number
    try {
      count = await drainOneBatch(cutoff, payload.batchSize)
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === SQLSTATE_LOCK_NOT_AVAILABLE || code === SQLSTATE_QUERY_CANCELED) {
        // A batch hit lock_timeout / statement_timeout — stop cleanly;
        // the next scheduled tick resumes from where we left off.
        stoppedReason = 'lock_or_timeout'
        break
      }
      throw error
    }

    if (count === 0) {
      stoppedReason = 'no_more_rows'
      break
    }

    batches += 1
    drained += count

    if (batches >= payload.maxBatches) {
      stoppedReason = 'max_batches'
      break
    }

    // Small breather between batches to smooth IO / WAL and yield to
    // the live serving path.
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  // eslint-disable-next-line no-console
  console.log(
    `[sweed-orders-raw-json-drain] job=${context.id} trigger=${payload.trigger} drained=${drained} batches=${batches} cutoffDays=${payload.cutoffDays} stopped=${stoppedReason}`,
  )

  await withTransaction(async (db) => {
    await appendAuditEvent(db, {
      actorType: payload.requestedByUserId ? 'user' : 'system',
      actorUserId: payload.requestedByUserId ?? null,
      entityId: String(context.id),
      entityType: 'job',
      eventType: 'config.workers.sweed_orders_raw_json_drain.completed',
      module: 'config',
      payload: {
        trigger: payload.trigger,
        drained,
        batches,
        cutoffDays: payload.cutoffDays,
        batchSize: payload.batchSize,
        maxBatches: payload.maxBatches,
        stoppedReason,
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}
