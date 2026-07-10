import type { ConfigWorkersGadsLpRollupRefreshJobPayload } from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { getPool } from '../../server/db/pool.js'
import {
  markGadsLpRollupRefreshError,
  markGadsLpRollupRefreshOk,
  markGadsLpRollupRefreshRunning,
  refreshGadsLpRollup,
  GADS_LP_ROLLUP_HORIZON_DAYS,
} from '../../server/db/queries/gadsLpRollupQueries.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

// ============================================================================
// GAds → Landing-pages rollup refresh worker (P2; parent epic
// virusdave/top-level#18, child FreshlyBakedNYC/automation#47).
//
// One scheduler tick = one job (60-min cadence, P0 §6). The handler
// recomputes the bounded NY-local horizon of `gads_lp_rollup` from the
// append-only `lp_events` sink and updates the singleton
// `gads_lp_rollup_refresh_state` freshness row (running -> ok/error)
// around the recompute so a failure is still observable on the
// serving endpoint and in the audit log.
//
// All the real work (the idempotent delete+insert recompute, the locked
// paid-traffic predicate, the NY-day bucketing, the 7/30/90d conversion
// windows) lives in the query helper so it has one home and one set of
// correctness invariants. See
// helios/src/server/db/queries/gadsLpRollupQueries.ts.
// ============================================================================

export async function runRefreshGadsLpRollupJob(
  context: JobHandlerContext,
  payload: ConfigWorkersGadsLpRollupRefreshJobPayload,
): Promise<void> {
  const pool = getPool()
  const horizonDays = payload.horizonDays ?? GADS_LP_ROLLUP_HORIZON_DAYS
  const startedAt = Date.now()

  // eslint-disable-next-line no-console
  console.log(
    `[gads-lp-rollup-refresh] job=${context.id} trigger=${payload.trigger} ` +
      `status=running horizonDays=${horizonDays}`,
  )

  await markGadsLpRollupRefreshRunning(pool)

  try {
    const result = await refreshGadsLpRollup(horizonDays)
    await markGadsLpRollupRefreshOk(result, pool)
    const durationMs = Date.now() - startedAt

    // eslint-disable-next-line no-console
    console.log(
      `[gads-lp-rollup-refresh] job=${context.id} trigger=${payload.trigger} status=ok ` +
        `durationMs=${durationMs} horizonDays=${horizonDays} floor=${result.horizonFloor} ` +
        `rows=${result.rowsWritten} assignmentsMissingId=${result.assignmentsMissingId} ` +
        `unattributedStageEvents=${result.unattributedStageEvents}`,
    )

    await appendAuditEvent(pool, {
      actorType: 'system',
      actorUserId: null,
      entityId: 'singleton',
      entityType: 'job',
      eventType: 'config.workers.gads_lp_rollup_refresh.completed',
      module: 'config',
      payload: {
        trigger: payload.trigger,
        horizonDays,
        horizonFloor: result.horizonFloor,
        rowsWritten: result.rowsWritten,
        sourceMinAt: result.sourceMinAt,
        sourceMaxAt: result.sourceMaxAt,
        durationMs,
        assignmentsMissingId: result.assignmentsMissingId,
        unattributedStageEvents: result.unattributedStageEvents,
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markGadsLpRollupRefreshError(message, pool)
    const durationMs = Date.now() - startedAt
    // eslint-disable-next-line no-console
    console.error(
      `[gads-lp-rollup-refresh] job=${context.id} trigger=${payload.trigger} status=error ` +
        `durationMs=${durationMs} horizonDays=${horizonDays}: ${message}`,
    )
    await appendAuditEvent(pool, {
      actorType: 'system',
      actorUserId: null,
      entityId: 'singleton',
      entityType: 'job',
      eventType: 'config.workers.gads_lp_rollup_refresh.completed',
      module: 'config',
      payload: {
        trigger: payload.trigger,
        horizonDays,
        durationMs,
        status: 'error',
        errorMessage: message.slice(0, 2000),
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
    throw error
  }
}
