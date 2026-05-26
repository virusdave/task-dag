import type { ConfigWorkersLitalertsRetailerBackfillJobPayload } from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { getPool } from '../../server/db/pool.js'
import { withTransaction } from '../../server/db/tx.js'
import { runRetailerProductsBackfill } from '../litalerts/retailerProductsBackfill.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

/**
 * Daily slow refresh of Lit Alerts /v1/retailers/{id}/products for
 * every NY competitor in our pricing distance bands. Delegates to the
 * shared `runRetailerProductsBackfill` helper so the manual one-shot
 * script (`scripts/litalerts-retailer-products-backfill.mts`) and the
 * scheduled job share the same retry / resume / deferred-retry
 * semantics.
 */
export async function runConfigWorkersLitalertsRetailerBackfillJob(
  context: JobHandlerContext,
  payload: ConfigWorkersLitalertsRetailerBackfillJobPayload,
): Promise<void> {
  const lines: string[] = []
  const log = (line: string): void => {
    lines.push(line)
    console.log(line)
  }

  let totals
  try {
    totals = await runRetailerProductsBackfill(getPool(), {
      stateCode: payload.stateCode,
      concurrency: payload.concurrency,
      maxDistanceMiles: payload.maxDistanceMiles,
      skipIfIngestedWithinHours: payload.skipIfIngestedWithinHours,
      log,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown retailer-backfill error.'
    await withTransaction(async (db) => {
      await appendAuditEvent(db, {
        actorType: payload.requestedByUserId ? 'user' : 'system',
        actorUserId: payload.requestedByUserId ?? null,
        entityId: String(context.id),
        entityType: 'job',
        eventType: 'config.workers.litalerts_retailer_backfill.completed',
        module: 'config',
        payload: {
          error: message,
          status: 'failed',
          trigger: payload.trigger,
        },
        requestId: null,
        scope: null,
        undoPayload: null,
      })
    })
    throw error
  }

  await withTransaction(async (db) => {
    await appendAuditEvent(db, {
      actorType: payload.requestedByUserId ? 'user' : 'system',
      actorUserId: payload.requestedByUserId ?? null,
      entityId: String(context.id),
      entityType: 'job',
      eventType: 'config.workers.litalerts_retailer_backfill.completed',
      module: 'config',
      payload: {
        configsWritten: totals.configsWritten,
        elapsedMs: totals.elapsedMs,
        productsSeen: totals.productsSeen,
        retailersAttempted: totals.retailersAttempted,
        retailersConsidered: totals.retailersConsidered,
        retries: totals.retries,
        status: 'succeeded',
        terminalFailures: totals.terminalFailures.length,
        trigger: payload.trigger,
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}
