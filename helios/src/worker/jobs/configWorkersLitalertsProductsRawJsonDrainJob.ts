// F3 (virusdave/top-level#11): drain litalerts_products.raw_config_json
// / raw_product_json for observations older than `cutoffDays` days in
// bounded DB batches.
//
// Background: litalerts_products was ~3.4 GB / 3.48M rows on prod, and
// every row carried two raw JSON blobs the structured ingest captured
// "for forensics". Every field a consumer needs already exists as a
// typed column, and the per-product image now lands in the typed
// `image_url` column (migration 065). The pricing-cache reader
// (loadBrandProductsFromCache) and the steady-state ingest writer were
// both migrated off the raw blobs in this phase, so they are pure dead
// weight on historical rows. Migration 065 made the columns nullable
// and added the `litalerts_products_raw_present_idx` partial index.
//
// Image safety: as each old row is nulled, any still-present
// raw_product_json->>'imageURL' is carried into image_url FIRST (same
// UPDATE, old-row values), so no image is ever lost — including for
// discontinued products whose latest observation is already past the
// cutoff.
//
// Unlike the F5 sweed_orders drain, the litalerts ingest STOPS writing
// raw entirely, so this is a finite backlog drain: once the pre-cutover
// rows are nulled the partial index empties and the candidate scan is
// an O(0) no-op (it never seq-scans the 3.48M-row table).
//
// Safety (reviewed for live prod):
//   * Each batch is its OWN short transaction with lock_timeout=2s and
//     statement_timeout=10s, so a batch can never wedge behind / ahead
//     of the live serving path (the daily retailer-products backfill
//     upserts into the same table).
//   * Candidates are picked with FOR UPDATE SKIP LOCKED and updated by
//     primary key (observation_id), so the drain never blocks (or is
//     blocked by) a concurrent ingest insert — it just skips and
//     catches the row next tick.
//   * One job invocation does at most `maxBatches * batchSize` rows and
//     stops after MAX_RUNTIME_MS, so it never floods WAL or holds locks
//     for long. The remainder drains on the next scheduled tick.
//   * Disk is reclaimed by autovacuum after the dead heap/TOAST tuples
//     age out; the worker intentionally does NOT run VACUUM (let alone
//     VACUUM FULL).

import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import type { ConfigWorkersLitalertsProductsRawJsonDrainJobPayload } from '../../shared/contracts/index.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

// Hard ceiling on wall-clock per invocation, independent of maxBatches,
// so a slow batch run can't monopolise a worker slot.
const MAX_RUNTIME_MS = 45_000
// Postgres SQLSTATEs we treat as "stop gracefully, resume next tick".
const SQLSTATE_LOCK_NOT_AVAILABLE = '55P03'
const SQLSTATE_QUERY_CANCELED = '57014'

/**
 * Null the raw_* blobs for up to `batchSize` of the oldest still-raw
 * observations past the cutoff, in a single short transaction,
 * carrying any raw image URL into the typed image_url column first.
 * Returns the number of rows drained.
 */
async function drainOneBatch(cutoff: Date, batchSize: number): Promise<number> {
  return withTransaction(async (db) => {
    await db.query(`set local lock_timeout = '2s'`)
    await db.query(`set local statement_timeout = '10s'`)
    const result = await db.query(
      `
        with candidates as (
          select lp.observation_id
            from litalerts_products lp
           where lp.raw_product_json is not null
             and lp.observed_at < $1::timestamptz
           order by lp.observed_at asc, lp.observation_id asc
           limit $2::int
           for update of lp skip locked
        )
        update litalerts_products lp
           set image_url = coalesce(lp.image_url, nullif(lp.raw_product_json->>'imageURL', '')),
               raw_config_json = null,
               raw_product_json = null
          from candidates c
         where lp.observation_id = c.observation_id
      `,
      [cutoff, batchSize],
    )
    return result.rowCount ?? 0
  })
}

export async function runConfigWorkersLitalertsProductsRawJsonDrainJob(
  context: JobHandlerContext,
  payload: ConfigWorkersLitalertsProductsRawJsonDrainJobPayload,
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
    `[litalerts-products-raw-json-drain] job=${context.id} trigger=${payload.trigger} drained=${drained} batches=${batches} cutoffDays=${payload.cutoffDays} stopped=${stoppedReason}`,
  )

  await withTransaction(async (db) => {
    await appendAuditEvent(db, {
      actorType: payload.requestedByUserId ? 'user' : 'system',
      actorUserId: payload.requestedByUserId ?? null,
      entityId: String(context.id),
      entityType: 'job',
      eventType: 'config.workers.litalerts_products_raw_json_drain.completed',
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
