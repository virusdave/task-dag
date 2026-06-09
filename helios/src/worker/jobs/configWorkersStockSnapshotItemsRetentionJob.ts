// F6 (virusdave/top-level#11): enforce 90-day retention on
// stock_snapshot_items by deleting the items of snapshots older than
// `retentionDays` days in bounded DB batches.
//
// Background: stock_snapshot_items is the per-variant detail behind each
// stock snapshot. It had grown to ~1.63 GB / 12M rows on prod (≈375k
// new rows/day) with no retention, while the /metrics windows that read
// it only look back ≤ 12 weeks. We delete ONLY the bulky item rows; the
// stock_snapshots header rows are intentionally kept — they are
// referenced by many other tables (litalerts_competitor_observations,
// landingpage_brand_site_presence, stock_variant_state,
// pending_litalerts_refresh_queue, …), and they are tiny (~6.7 MB
// total). Nothing references stock_snapshot_items, so deleting items is
// safe.
//
// This is Step 1 of F6. Step 2 (a separate follow-on commit) converts
// stock_snapshot_items to a Timescale hypertable + compression policy to
// bound the steady-state footprint; it is OUT of scope here.
//
// Throughput: in steady state ~375k rows/day cross the 90-day boundary,
// so — unlike a once-daily job — this runs on the same off-hours
// multi-tick window as the other drains (≤40k rows/tick, ~24 ticks)
// which comfortably exceeds the aging rate; it self-stops each tick once
// no eligible rows remain.
//
// Safety (reviewed for live prod):
//   * Each batch is its OWN short transaction with lock_timeout=2s and
//     statement_timeout=10s, so a batch can never wedge behind / ahead
//     of the live serving path (the stock-refresh ingest writes here).
//   * Candidates are picked with FOR UPDATE SKIP LOCKED and deleted by
//     primary key (snapshot_id, product_id), so the drain never blocks
//     (or is blocked by) a concurrent ingest insert — it just skips and
//     catches the row next tick.
//   * One job invocation does at most `maxBatches * batchSize` rows and
//     stops after MAX_RUNTIME_MS, so it never floods WAL or holds locks
//     for long. The remainder drains on the next scheduled tick.
//   * Disk is reclaimed by autovacuum after the dead tuples age out; the
//     worker intentionally does NOT run VACUUM (let alone VACUUM FULL).

import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import type { ConfigWorkersStockSnapshotItemsRetentionJobPayload } from '../../shared/contracts/index.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

// Hard ceiling on wall-clock per invocation, independent of maxBatches,
// so a slow batch run can't monopolise a worker slot.
const MAX_RUNTIME_MS = 45_000
// Postgres SQLSTATEs we treat as "stop gracefully, resume next tick".
const SQLSTATE_LOCK_NOT_AVAILABLE = '55P03'
const SQLSTATE_QUERY_CANCELED = '57014'

/**
 * Delete up to `batchSize` of the items belonging to snapshots older
 * than the cutoff, in a single short transaction. Returns the number of
 * rows deleted.
 */
async function deleteOneBatch(cutoff: Date, batchSize: number): Promise<number> {
  return withTransaction(async (db) => {
    await db.query(`set local lock_timeout = '2s'`)
    await db.query(`set local statement_timeout = '10s'`)
    const result = await db.query(
      `
        with candidates as (
          select ssi.snapshot_id, ssi.product_id
            from stock_snapshot_items ssi
           where ssi.snapshot_id in (
             select s.id from stock_snapshots s
              where s.started_at < $1::timestamptz
           )
           order by ssi.snapshot_id asc, ssi.product_id asc
           limit $2::int
           for update of ssi skip locked
        )
        delete from stock_snapshot_items ssi
         using candidates c
         where ssi.snapshot_id = c.snapshot_id
           and ssi.product_id = c.product_id
      `,
      [cutoff, batchSize],
    )
    return result.rowCount ?? 0
  })
}

export async function runConfigWorkersStockSnapshotItemsRetentionJob(
  context: JobHandlerContext,
  payload: ConfigWorkersStockSnapshotItemsRetentionJobPayload,
): Promise<void> {
  const cutoff = new Date(Date.now() - payload.retentionDays * 24 * 60 * 60 * 1000)
  const deadline = Date.now() + MAX_RUNTIME_MS

  let batches = 0
  let deleted = 0
  let stoppedReason: 'no_more_rows' | 'max_batches' | 'deadline' | 'lock_or_timeout' = 'no_more_rows'

  while (batches < payload.maxBatches) {
    if (Date.now() >= deadline) {
      stoppedReason = 'deadline'
      break
    }

    let count: number
    try {
      count = await deleteOneBatch(cutoff, payload.batchSize)
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
    deleted += count

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
    `[stock-snapshot-items-retention] job=${context.id} trigger=${payload.trigger} deleted=${deleted} batches=${batches} retentionDays=${payload.retentionDays} stopped=${stoppedReason}`,
  )

  await withTransaction(async (db) => {
    await appendAuditEvent(db, {
      actorType: payload.requestedByUserId ? 'user' : 'system',
      actorUserId: payload.requestedByUserId ?? null,
      entityId: String(context.id),
      entityType: 'job',
      eventType: 'config.workers.stock_snapshot_items_retention.completed',
      module: 'config',
      payload: {
        trigger: payload.trigger,
        deleted,
        batches,
        retentionDays: payload.retentionDays,
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
