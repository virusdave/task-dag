// F4 (virusdave/top-level#11): enforce the documented fuzzy_skus
// 30-day retention by deleting rows older than `retentionDays` days in
// bounded DB batches.
//
// Background: fuzzy_skus is the parser-output staging table for the
// catalog → market-data review. It is rebuilt from the litalerts
// snapshots periodically; rows whose normalized parse no longer matches
// (price/stock drift produces a new raw_input_hash, hence a new row)
// accumulate indefinitely, so the table had grown to ~1.67 GB / 913k
// rows on prod with no retention. The documented design is a 30-day
// window; this worker enforces it.
//
// Safety (reviewed for live prod):
//   * The catalog_market_matches.fuzzy_sku_id FK is ON DELETE NO ACTION,
//     so a referenced row CANNOT be deleted (it would raise an FK
//     violation and abort the batch). Candidates are therefore filtered
//     with `NOT EXISTS (select 1 from catalog_market_matches …)` —
//     rows still wired to a (live OR superseded) match are retained
//     past the window until the match itself is gone. The anti-join is
//     against a tiny table (~hundreds of rows).
//   * Each batch is its OWN short transaction with lock_timeout=2s and
//     statement_timeout=10s, so a batch can never wedge behind / ahead
//     of the live serving path.
//   * Candidates are picked with FOR UPDATE SKIP LOCKED (using the
//     fuzzy_skus_created_at_idx range) and deleted by primary key, so
//     the drain never blocks (or is blocked by) a concurrent writer.
//   * One job invocation does at most `maxBatches * batchSize` rows and
//     stops after MAX_RUNTIME_MS, so it never floods WAL or holds locks
//     for long. The remainder drains on the next scheduled tick.
//   * Disk is reclaimed by autovacuum after the dead tuples age out; the
//     worker intentionally does NOT run VACUUM (let alone VACUUM FULL).

import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import type { ConfigWorkersFuzzySkusRetentionJobPayload } from '../../shared/contracts/index.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

// Hard ceiling on wall-clock per invocation, independent of maxBatches,
// so a slow batch run can't monopolise a worker slot.
const MAX_RUNTIME_MS = 45_000
// Postgres SQLSTATEs we treat as "stop gracefully, resume next tick".
const SQLSTATE_LOCK_NOT_AVAILABLE = '55P03'
const SQLSTATE_QUERY_CANCELED = '57014'

/**
 * Delete up to `batchSize` of the oldest fuzzy_skus rows past the
 * cutoff that are NOT referenced by catalog_market_matches, in a single
 * short transaction. Returns the number of rows deleted.
 */
async function deleteOneBatch(cutoff: Date, batchSize: number): Promise<number> {
  return withTransaction(async (db) => {
    await db.query(`set local lock_timeout = '2s'`)
    await db.query(`set local statement_timeout = '10s'`)
    const result = await db.query(
      `
        with candidates as (
          select f.id
            from fuzzy_skus f
           where f.created_at < $1::timestamptz
             and not exists (
               select 1 from catalog_market_matches m
                where m.fuzzy_sku_id = f.id
             )
           order by f.created_at asc, f.id asc
           limit $2::int
           for update of f skip locked
        )
        delete from fuzzy_skus f
         using candidates c
         where f.id = c.id
      `,
      [cutoff, batchSize],
    )
    return result.rowCount ?? 0
  })
}

export async function runConfigWorkersFuzzySkusRetentionJob(
  context: JobHandlerContext,
  payload: ConfigWorkersFuzzySkusRetentionJobPayload,
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
    `[fuzzy-skus-retention] job=${context.id} trigger=${payload.trigger} deleted=${deleted} batches=${batches} retentionDays=${payload.retentionDays} stopped=${stoppedReason}`,
  )

  await withTransaction(async (db) => {
    await appendAuditEvent(db, {
      actorType: payload.requestedByUserId ? 'user' : 'system',
      actorUserId: payload.requestedByUserId ?? null,
      entityId: String(context.id),
      entityType: 'job',
      eventType: 'config.workers.fuzzy_skus_retention.completed',
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
