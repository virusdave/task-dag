import type { ConfigWorkersLitalertsRetailerBackfillJobPayload } from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { getPool } from '../../server/db/pool.js'
import { withTransaction } from '../../server/db/tx.js'
import { runRetailerProductsBackfill } from '../litalerts/retailerProductsBackfill.js'
import { pageDave } from '../runtime/pageDave.js'
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
    if (payload.trigger === 'manual_run') {
      // Operator-requested backfill failed; page so the human can
      // decide whether to re-run, look at logs, or accept the loss.
      // Best-effort: don't let a paging failure swallow the real error.
      await pageDave(
        `Manual Lit Alerts retailer backfill (job ${context.id}, state=${payload.stateCode}, maxDistanceMiles=${payload.maxDistanceMiles}) failed: ${message}`,
        { priority: 4, title: 'Lit Alerts retailer backfill FAILED' },
      ).catch((pageError) => {
        console.warn('[configWorkersLitalertsRetailerBackfillJob] failed to page Dave on failure', pageError)
      })
    }
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

  if (payload.trigger === 'manual_run') {
    // Operator-requested backfills are typically long-running (the
    // statewide all-retailers sweep can be 1+ hour), so page when the
    // batch completes so the operator can come back and look at the
    // results without having to keep an eye on the Jobs page.
    const elapsedMin = (totals.elapsedMs / 60_000).toFixed(1)
    const summary =
      `Manual Lit Alerts retailer backfill (job ${context.id}, state=${payload.stateCode}, maxDistanceMiles=${payload.maxDistanceMiles}) DONE in ${elapsedMin}min: ` +
      `retailersAttempted=${totals.retailersAttempted}/${totals.retailersConsidered}, ` +
      `productsSeen=${totals.productsSeen}, configsWritten=${totals.configsWritten}, ` +
      `retries=${totals.retries}, terminalFailures=${totals.terminalFailures.length}.`
    await pageDave(summary, {
      priority: 4,
      title: 'Lit Alerts retailer backfill done',
    }).catch((pageError) => {
      console.warn('[configWorkersLitalertsRetailerBackfillJob] failed to page Dave on success', pageError)
    })
  }
}
