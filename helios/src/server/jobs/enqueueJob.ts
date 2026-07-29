import type { QueryResultRow } from 'pg'

import {
  parseCatalogGroupIdFromModuleScope,
  type HeliosModuleCode,
  type HeliosModuleScope,
  type JobPayload,
  type JobType,
} from '../../shared/contracts/index.js'
import type { Queryable } from '../db/pool.js'
import { notifyJobQueueEnqueued } from '../db/notify.js'
import { getCurrentJobAuthContext } from '../../worker/sweed/authLog.js'

interface JobRow extends QueryResultRow {
  id: number
}

export type ExactActiveEnqueueResult =
  | { inserted: true; jobId: number }
  | { inserted: false; jobId: number; exactPayload: true }
  | { inserted: false; jobId: number; exactPayload: false }

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
 * - `JOB_PRIORITY_BEST_EFFORT` (0) — background batch work, most
 *   importantly the high-volume scheduler-driven litalerts refresh
 *   flood (hundreds of `litalerts_refresh.variant` rows per tick).
 *   The default for enqueues that originate inside the worker
 *   process. These run only when no higher-priority work is waiting.
 * - `JOB_PRIORITY_BACKFILL` (10) — slightly above best-effort, used
 *   for short, system-scheduled "walk historical rows and enrich"
 *   jobs (the address-enrichment jobs, the litalerts retailer
 *   backfill, etc). The narrow lift over best-effort lets backfills
 *   slip ahead of the litalerts flood in the same execution pool.
 *   The 100-point gap to interactive means operator clicks still
 *   always preempt a backfill.
 * - `JOB_PRIORITY_SCHEDULED_INGEST` (50) — freshness-sensitive
 *   periodic data ingest/refresh (sweed orders/shifts/purchases
 *   ingest, package snapshots, stock + catalog refresh, the raw_json
 *   drain, etc). Sits above both the best-effort litalerts flood (0)
 *   AND the bulk backfills (10) so that the data feeding the live
 *   metrics surfaces never has to wait behind a multi-minute
 *   litalerts batch on the single main worker loop — the root cause
 *   of the 2026-06-06 "Essentials lags Sweed by ~20 min" incident.
 *   Still below `INTERACTIVE` so operator clicks always preempt it.
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
export const JOB_PRIORITY_SCHEDULED_INGEST = 50
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

  // Phase B4 (virusdave/top-level#11): emit a wake-up on the
  // job-queue channel from inside the caller's transaction so the
  // worker lease loops can break out of their idle-cap sleep
  // immediately on commit. A separate listening connection in the
  // worker process picks the NOTIFY up.
  await notifyJobQueueEnqueued(db)

  return result.rows[0].id
}

/** Transaction-only enqueue for security-sensitive requests sharing a dedupe key. */
export async function enqueueJobExactActive(
  db: Queryable,
  input: EnqueueJobInput & { dedupeKey: string },
): Promise<ExactActiveEnqueueResult> {
  await db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [input.dedupeKey])
  const existing = await db.query<JobRow & { exact_payload: boolean }>(
    `select id, payload_json = $2::jsonb as exact_payload
       from job_queue
      where dedupe_key = $1 and status in ('queued', 'running')
      limit 1`,
    [input.dedupeKey, JSON.stringify(input.payload)],
  )
  if (existing.rows[0]) {
    return {
      inserted: false,
      jobId: existing.rows[0].id,
      exactPayload: existing.rows[0].exact_payload,
    }
  }
  const catalogGroupId = parseCatalogGroupIdFromModuleScope(input.module, input.scope)
  const inserted = await db.query<JobRow>(
    `insert into job_queue (
       job_type, dedupe_key, concurrency_key, module_code, scope_entity_type,
       scope_entity_id, catalog_group_id, payload_json, status, run_at,
       requested_by_user_id, priority
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'queued', $9, $10, $11)
     returning id`,
    [
      input.jobType,
      input.dedupeKey,
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
  await notifyJobQueueEnqueued(db)
  return { inserted: true, jobId: inserted.rows[0].id }
}

/** Transaction-only, immutable one-use enqueue. Terminal rows also dedupe. */
export async function enqueueJobExactOnce(
  db: Queryable,
  input: EnqueueJobInput & { dedupeKey: string },
): Promise<ExactActiveEnqueueResult> {
  await db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [input.dedupeKey])
  const existing = await db.query<JobRow & { exact_payload: boolean }>(
    `select id, payload_json = $2::jsonb as exact_payload
       from job_queue
      where dedupe_key = $1
        and status in ('queued', 'running', 'succeeded', 'failed', 'dead_letter')
      limit 1`,
    [input.dedupeKey, JSON.stringify(input.payload)],
  )
  if (existing.rows[0]) return { inserted: false, jobId: existing.rows[0].id, exactPayload: existing.rows[0].exact_payload }
  const catalogGroupId = parseCatalogGroupIdFromModuleScope(input.module, input.scope)
  const inserted = await db.query<JobRow>(
    `insert into job_queue (
       job_type, dedupe_key, concurrency_key, module_code, scope_entity_type,
       scope_entity_id, catalog_group_id, payload_json, status, run_at,
       requested_by_user_id, priority
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'queued', $9, $10, $11)
     returning id`,
    [input.jobType, input.dedupeKey, input.concurrencyKey ?? null, input.module,
      input.scope?.entityType ?? null, input.scope?.entityId ?? null, catalogGroupId,
      JSON.stringify(input.payload), input.runAt ?? new Date(), input.requestedByUserId ?? null,
      input.priority ?? defaultPriorityFor(input)],
  )
  await notifyJobQueueEnqueued(db)
  return { inserted: true, jobId: inserted.rows[0].id }
}

/**
 * Bulk plural variant of `enqueueJob`. Shipped as part of the
 * Helios DB-cost-reduction epic (virusdave/top-level#11, phase
 * A4): the per-tick scheduler batch path used to open one
 * transaction PER pending row to do "SELECT existing dedupe →
 * INSERT job_queue" — 2 round-trips × N rows per tick × every
 * tick. The plural path collapses that to two round-trips per
 * batch regardless of N.
 *
 * Returns the resolved job ids parallel to `inputs`. Each entry
 * is either an existing-dedupe match (if a queued / running row
 * for that dedupe_key already exists) or the freshly-inserted
 * row id. Order is preserved.
 *
 * Constraints:
 *   - Every input MUST have a non-null `dedupeKey`. The dedupe
 *     key is what we use to map insert RETURNINGs back to the
 *     caller's array slot; null dedupe keys would silently lose
 *     that mapping. Callers without per-row dedupe keys should
 *     keep using the singular `enqueueJob`.
 *   - Within a single call, `dedupeKey` values must be unique.
 *     The same-batch dedupe collapse semantics of the old
 *     per-row loop (which would just SELECT the first insert
 *     and skip the rest) are NOT reproduced here; the litalerts
 *     scheduler path that motivates this helper guarantees
 *     uniqueness because each dedupe key is built from a
 *     unique queue-row id.
 *   - Run inside a single transaction by the caller; this helper
 *     does NOT open its own transaction. That keeps the batch
 *     atomic with the audit + recordEnqueueAndPatchCache writes
 *     the caller wraps around it.
 */
export async function enqueueJobs(
  db: Queryable,
  inputs: EnqueueJobInput[],
): Promise<number[]> {
  if (inputs.length === 0) {
    return []
  }
  const resolved = inputs.map((input) => {
    if (input.dedupeKey == null || input.dedupeKey === '') {
      throw new Error(
        'enqueueJobs: every input must have a non-null dedupeKey; use singular enqueueJob otherwise',
      )
    }
    return {
      input,
      dedupeKey: input.dedupeKey,
      catalogGroupId: parseCatalogGroupIdFromModuleScope(input.module, input.scope),
      runAt: input.runAt ?? new Date(),
      priority: input.priority ?? defaultPriorityFor(input),
    }
  })

  const dedupeKeys = resolved.map((r) => r.dedupeKey)
  const seenDedupeKeys = new Set<string>()
  for (const key of dedupeKeys) {
    if (seenDedupeKeys.has(key)) {
      throw new Error(`enqueueJobs: duplicate dedupeKey in batch: ${key}`)
    }
    seenDedupeKeys.add(key)
  }

  // (1) Existing-dedupe lookup. Matches singular enqueueJob's
  // SELECT…WHERE status IN ('queued','running') semantics.
  const existingResult = await db.query<{ id: number; dedupe_key: string }>(
    `
      select id, dedupe_key
        from job_queue
       where dedupe_key = any($1::text[])
         and status in ('queued', 'running')
    `,
    [dedupeKeys],
  )
  const existingByDedupeKey = new Map<string, number>()
  for (const row of existingResult.rows) {
    // The same dedupe key can technically appear more than once
    // historically (race that pre-dates this code); keep the
    // first id, same as the singular helper's LIMIT 1.
    if (!existingByDedupeKey.has(row.dedupe_key)) {
      existingByDedupeKey.set(row.dedupe_key, row.id)
    }
  }

  // (2) Bulk insert for the inputs that did NOT match an
  //     existing dedupe row. RETURNING (id, dedupe_key) lets us
  //     map insertions back to caller slots.
  const toInsert = resolved.filter((r) => !existingByDedupeKey.has(r.dedupeKey))
  const insertedByDedupeKey = new Map<string, number>()
  if (toInsert.length > 0) {
    const payload = toInsert.map((r) => ({
      job_type: r.input.jobType,
      dedupe_key: r.dedupeKey,
      concurrency_key: r.input.concurrencyKey ?? null,
      module_code: r.input.module,
      scope_entity_type: r.input.scope?.entityType ?? null,
      scope_entity_id: r.input.scope?.entityId ?? null,
      catalog_group_id: r.catalogGroupId,
      payload_json: r.input.payload,
      run_at: r.runAt.toISOString(),
      requested_by_user_id: r.input.requestedByUserId ?? null,
      priority: r.priority,
    }))
    const insertResult = await db.query<{ id: number; dedupe_key: string }>(
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
        select
          x.job_type,
          x.dedupe_key,
          x.concurrency_key,
          x.module_code,
          x.scope_entity_type,
          x.scope_entity_id,
          x.catalog_group_id,
          x.payload_json,
          'queued',
          x.run_at,
          x.requested_by_user_id,
          x.priority
        from jsonb_to_recordset($1::jsonb) as x(
          job_type             text,
          dedupe_key           text,
          concurrency_key      text,
          module_code          text,
          scope_entity_type    text,
          scope_entity_id      text,
          catalog_group_id     bigint,
          payload_json         jsonb,
          run_at               timestamptz,
          requested_by_user_id bigint,
          priority             int
        )
        returning id, dedupe_key
      `,
      [JSON.stringify(payload)],
    )
    for (const row of insertResult.rows) {
      insertedByDedupeKey.set(row.dedupe_key, row.id)
    }
    // Phase B4: one NOTIFY per BATCH that actually inserted at
    // least one row. We don't need per-row notifications — the
    // worker just needs to know "something arrived".
    await notifyJobQueueEnqueued(db)
  }

  return resolved.map((r) => {
    const existing = existingByDedupeKey.get(r.dedupeKey)
    if (existing !== undefined) return existing
    const inserted = insertedByDedupeKey.get(r.dedupeKey)
    if (inserted !== undefined) return inserted
    // Defensive: a row should always appear in one of the two
    // maps. If not, something is structurally wrong.
    throw new Error(`enqueueJobs: lost dedupe-key mapping for ${r.dedupeKey}`)
  })
}
