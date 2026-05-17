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
   * id asc. Default 0 ("normal background work"). Operator-initiated /
   * UI-triggered jobs should typically pass JOB_PRIORITY_HIGH so they
   * jump past system-generated backlog.
   */
  priority?: number
}

/**
 * Priority band constants. Plain numbers so we can layer more bands
 * later without a schema change.
 */
export const JOB_PRIORITY_BACKGROUND = 0
export const JOB_PRIORITY_HIGH = 100

/**
 * Default priority for an enqueue that didn't pass one explicitly.
 *
 * Heuristic: enqueues coming from HTTP routes / the operator-facing
 * UI are top-level work and get JOB_PRIORITY_HIGH so they jump past
 * background backlog. Enqueues coming from INSIDE a running worker
 * job (fan-out children, scheduled follow-ups) stay at
 * JOB_PRIORITY_BACKGROUND even if the parent's requestedByUserId is
 * propagated — otherwise a single operator click can dump 2,000+
 * "high priority" children into the queue and starve actual top-
 * level operator clicks.
 *
 * We detect "inside a worker job" via the `withJobAuthContext` ALS
 * cell, which the worker loop enters before every job handler runs.
 *
 * Call sites that want different behaviour pass `priority` explicitly.
 */
function defaultPriorityFor(_input: EnqueueJobInput): number {
  const insideWorkerJob = getCurrentJobAuthContext() !== null
  return insideWorkerJob ? JOB_PRIORITY_BACKGROUND : JOB_PRIORITY_HIGH
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
