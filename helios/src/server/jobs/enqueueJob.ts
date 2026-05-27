import type { QueryResultRow } from 'pg'

import {
  parseCatalogGroupIdFromModuleScope,
  type HeliosModuleCode,
  type HeliosModuleScope,
  type JobPayload,
  type JobType,
} from '../../shared/contracts/index.js'
import type { Queryable } from '../db/pool.js'
import { getCurrentJobAuthContext } from '../../worker/sweed/authLog.js'

interface JobRow extends QueryResultRow {
  id: number
}

export interface EnqueueJobInput {
  concurrencyKey?: string | null
  dedupeKey?: string | null
  jobType: JobType
  module: HeliosModuleCode
  payload: JobPayload
  requestedByUserId?: number | null
  runAt?: Date
  scope?: HeliosModuleScope | null
  /**
   * Lease ordering: leaseJobs picks rows by priority desc, run_at asc,
   * id asc. See the three explicit priority bands below
   * (`JOB_PRIORITY_BEST_EFFORT` / `JOB_PRIORITY_INTERACTIVE` /
   * `JOB_PRIORITY_URGENT`). When omitted, the default is decided
   * by `defaultPriorityFor` from the calling context.
   */
  priority?: number
}

/**
 * Priority bands. Plain numbers so we can layer more bands later
 * without a schema change.
 *
 * Five explicit bands with wide gaps so an operator can manually
 * nudge a single row up or down a few notches without colliding
 * with the next band:
 *
 * - `JOB_PRIORITY_BEST_EFFORT` (0) — background batch work
 *   (scheduler-driven litalerts refresh, sweed orders ingest,
 *   package snapshots, etc). The default for enqueues that
 *   originate inside the worker process. These run only when no
 *   higher-priority work is waiting.
 * - `JOB_PRIORITY_BACKFILL` (10) — slightly above best-effort, used
 *   for short, system-scheduled "walk historical rows and enrich"
 *   jobs (the address-enrichment jobs, the litalerts retailer
 *   backfill, etc). The narrow lift over best-effort lets backfills
 *   slip ahead of routine refresh / ingest batch jobs in the same
 *   execution pool, so a multi-hour ingest backlog doesn't starve
 *   the per-tick backfill enqueues that the scheduler is depositing.
 *   The 100-point gap to interactive means operator clicks still
 *   always preempt a backfill.
 * - `JOB_PRIORITY_INTERACTIVE` (100) — live operator-driven work
 *   originating from an HTTP request / the Helios UI. The default
 *   for any enqueue happening outside the worker process. These
 *   always beat best-effort backlog.
 * - `JOB_PRIORITY_LIVE_REQUESTED` (500) — operator clicked a
 *   button and is actively waiting on the result (e.g. the
 *   `catalog.pending_purchases.*` flows that block the
 *   pending-purchases UI). Sits above ambient `INTERACTIVE`
 *   backlog so a manual click jumps ahead of, say, a routine
 *   maintenance click queued a few minutes ago. Stays below
 *   `URGENT` so the fast-lane is reserved for true incidents.
 * - `JOB_PRIORITY_URGENT` (1000) — operator-flagged "must start
 *   immediately" work. The worker process runs a dedicated
 *   fast-lane loop (see `runWorkerLoop`) that polls every
 *   `WORKER_FASTLANE_POLL_INTERVAL_MS` (default 10 seconds) and
 *   leases only jobs at or above this priority, so urgent work
 *   never gets stuck behind a fully-occupied main loop.
 */
export const JOB_PRIORITY_BEST_EFFORT = 0
export const JOB_PRIORITY_BACKFILL = 10
export const JOB_PRIORITY_INTERACTIVE = 100
export const JOB_PRIORITY_LIVE_REQUESTED = 500
export const JOB_PRIORITY_URGENT = 1000

/**
 * Back-compat aliases. Existing call sites passed
 * `JOB_PRIORITY_BACKGROUND` / `JOB_PRIORITY_HIGH`; preserve those
 * names so a single rename doesn't churn unrelated files.
 */
export const JOB_PRIORITY_BACKGROUND = JOB_PRIORITY_BEST_EFFORT
export const JOB_PRIORITY_HIGH = JOB_PRIORITY_INTERACTIVE

/**
 * Default priority for an enqueue that didn't pass one explicitly.
 *
 * Heuristic: enqueues coming from HTTP routes / the operator-facing
 * UI are top-level work and get `JOB_PRIORITY_INTERACTIVE` so they
 * jump past best-effort backlog. Enqueues coming from INSIDE a
 * running worker job (fan-out children, scheduled follow-ups) stay
 * at `JOB_PRIORITY_BEST_EFFORT` even if the parent's
 * `requestedByUserId` is propagated — otherwise a single operator
 * click can dump 2,000+ "interactive priority" children into the
 * queue and starve actual top-level operator clicks.
 *
 * We detect "inside a worker job" via the `withJobAuthContext` ALS
 * cell, which the worker loop enters before every job handler runs.
 *
 * Scheduler-tick enqueues that run OUTSIDE a job context but are
 * still batch work (e.g. `tickConfigWorkersScheduler`) MUST pass
 * `priority: JOB_PRIORITY_BEST_EFFORT` explicitly rather than rely
 * on this heuristic.
 *
 * Operator-flagged "start immediately" enqueues should pass
 * `priority: JOB_PRIORITY_URGENT` explicitly.
 */
function defaultPriorityFor(_input: EnqueueJobInput): number {
  const insideWorkerJob = getCurrentJobAuthContext() !== null
  return insideWorkerJob ? JOB_PRIORITY_BEST_EFFORT : JOB_PRIORITY_INTERACTIVE
}

export async function enqueueJob(db: Queryable, input: EnqueueJobInput): Promise<number> {
  const catalogGroupId = parseCatalogGroupIdFromModuleScope(input.module, input.scope)

  if (input.dedupeKey) {
    const existingResult = await db.query<JobRow>(
      `
        select id
        from job_queue
        where dedupe_key = $1
          and status in ('queued', 'running')
        limit 1
      `,
      [input.dedupeKey],
    )

    if (existingResult.rows[0]) {
      return existingResult.rows[0].id
    }
  }

  const result = await db.query<JobRow>(
    `
      insert into job_queue (
        job_type,
        dedupe_key,
        concurrency_key,
        module_code,
        scope_entity_type,
        scope_entity_id,
        catalog_group_id,
        payload_json,
        status,
        run_at,
        requested_by_user_id,
        priority
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'queued', $9, $10, $11)
      returning id
    `,
    [
      input.jobType,
      input.dedupeKey ?? null,
      input.concurrencyKey ?? null,
      input.module,
      input.scope?.entityType ?? null,
      input.scope?.entityId ?? null,
      catalogGroupId,
      JSON.stringify(input.payload),
      input.runAt ?? new Date(),
      input.requestedByUserId ?? null,
      input.priority ?? defaultPriorityFor(input),
    ],
  )

  return result.rows[0].id
}
