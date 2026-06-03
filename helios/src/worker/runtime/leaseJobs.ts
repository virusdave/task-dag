import { randomUUID } from 'node:crypto'

import type { QueryResultRow } from 'pg'

import type { JobStatusResponse } from '../../shared/contracts/api/jobs.js'
import type { JobType } from '../../shared/contracts/domain/jobs.js'
import { attachPoolClientErrorLogger, getPool } from '../../server/db/pool.js'

interface LeasedJobRow extends QueryResultRow {
  attempt_count: number
  id: number
  job_type: JobStatusResponse['job']['jobType']
  module_code: JobStatusResponse['job']['module']
  payload_json: unknown
  scope_entity_id: string | null
  scope_entity_type: string | null
}

export interface LeasedJob {
  attemptCount: number
  id: number
  jobType: JobStatusResponse['job']['jobType']
  leaseToken: string
  module: JobStatusResponse['job']['module']
  payload: unknown
  scope: JobStatusResponse['job']['scope']
}

// ============================================================================
// Expired-lease sweep gate (Helios DB-cost epic, phase B2 —
// virusdave/top-level#11). The unconditional UPDATE that resets
// `status='running' AND leased_until < now()` rows back to
// `'queued'` used to fire on EVERY `leaseJobs` call. Even when
// zero rows match the predicate, the planner still has to scan
// the relevant index range and the write path still issues a WAL
// record for the empty update. With the worker poll loop firing
// (post-B3) every 3–15 seconds across the main loop plus the
// fast-lane loop, that adds up to ~10k–30k empty UPDATEs per day
// per worker process — pure baseline waste.
//
// The gate ensures the sweep runs at most once per
// `EXPIRED_LEASE_SWEEP_INTERVAL_MS`, with `lastExpiredLeaseSweepMs
// = 0` at module load so the FIRST `leaseJobs` call after a worker
// restart still does the sweep (preserving startup recovery
// semantics — if the previous process crashed mid-job, the
// expired-lease row needs to be reclaimable on the next tick, not
// 60 s later). Default lease length is 5 minutes
// (`leased_until = now() + interval '5 minutes'`), so a 60 s gate
// adds at most 60 s of recovery latency for a crashed worker —
// acceptably small relative to the lease window.
// ============================================================================
const EXPIRED_LEASE_SWEEP_INTERVAL_MS = 60_000
let lastExpiredLeaseSweepMs = 0

/**
 * Test-only helper: reset the in-process sweep timestamp so the
 * next `leaseJobs` call fires the sweep again. Not exported via
 * the package entrypoint; only tests reach in.
 */
export function __resetExpiredLeaseSweepGateForTests(): void {
  lastExpiredLeaseSweepMs = 0
}

export interface LeaseJobsOptions {
  /**
   * If provided, restrict leasing to these job types. Concurrency-key
   * conflict checks against running jobs are still global, so a Sweed-pool
   * worker correctly waits when any other worker is running a
   * `sweed-session` job.
   */
  jobTypes?: JobType[]
  /**
   * If provided, restrict leasing to jobs with `priority >= minPriority`.
   * Used by the high-priority fast-lane loop (see
   * `runWorkerLoop`) so that the dedicated 10-second fast scan never
   * leases background backlog. Live-interactive / operator-flagged
   * work (default `JOB_PRIORITY_HIGH = 100`) always wins the
   * fast-lane slot even when the main 3-second loop is fully
   * occupied by long-running background jobs.
   */
  minPriority?: number
}

export async function leaseJobs(limit: number, options: LeaseJobsOptions = {}): Promise<LeasedJob[]> {
  const leaseToken = randomUUID()
  const pool = getPool()
  const client = await pool.connect()
  const removeErrorLogger = attachPoolClientErrorLogger(client, 'leaseJobs')

  const jobTypeFilter = options.jobTypes && options.jobTypes.length > 0 ? options.jobTypes : null
  const minPriority = typeof options.minPriority === 'number' ? options.minPriority : null

  try {
    await client.query('begin')
    // Gated expired-lease sweep — see the EXPIRED_LEASE_SWEEP_*
    // block at module top for the why. We do the time check
    // inside the transaction so two concurrent worker processes
    // each see their own cadence; the UPDATE itself is idempotent
    // (predicate is `leased_until < now()`) so racing sweeps are
    // safe.
    const nowMs = Date.now()
    if (nowMs - lastExpiredLeaseSweepMs >= EXPIRED_LEASE_SWEEP_INTERVAL_MS) {
      lastExpiredLeaseSweepMs = nowMs
      await client.query(
        `
          update job_queue
          set status = 'queued',
              lease_token = null,
              leased_until = null,
              started_at = null,
              finished_at = null,
              run_at = now(),
              last_error = 'Worker lease expired before job completion; retrying.',
              updated_at = now()
          where status = 'running'
            and leased_until is not null
            and leased_until < now()
        `,
      )
    }

    const leaseResult = await client.query<LeasedJobRow>(
      `
        with runnable as (
          select
            jq.id,
            jq.priority,
            jq.run_at,
            jq.concurrency_key,
            case
              when jq.concurrency_key is null then 1
              else row_number() over (
                partition by jq.concurrency_key
                order by jq.priority desc, jq.run_at asc, jq.id asc
              )
            end as concurrency_rank
          from job_queue jq
          where jq.status = 'queued'
            and jq.run_at <= now()
            and (
              jq.concurrency_key is null
              or not exists (
                select 1
                from job_queue running
                where running.status = 'running'
                  and running.concurrency_key = jq.concurrency_key
              )
            )
        ),
        candidates as (
          select jq.id
          from job_queue jq
          inner join runnable on runnable.id = jq.id
          where jq.status = 'queued'
            and runnable.concurrency_rank = 1
            and ($3::text[] is null or jq.job_type = any($3::text[]))
            and ($4::integer is null or jq.priority >= $4::integer)
          -- Lease ordering: high-priority jobs (operator-initiated) come
          -- out before background-priority backlog regardless of age. Ties
          -- break by run_at (oldest first) then id for determinism.
          order by jq.priority desc, jq.run_at asc, jq.id asc
          for update skip locked
          limit $1
        )
        update job_queue jq
        set status = 'running',
            lease_token = $2,
            leased_until = now() + interval '5 minutes',
            started_at = now(),
            attempt_count = jq.attempt_count + 1,
            last_error = null,
            updated_at = now()
        from candidates
        where jq.id = candidates.id
        returning jq.id, jq.job_type, jq.module_code, jq.scope_entity_type, jq.scope_entity_id, jq.payload_json, jq.attempt_count
      `,
      [limit, leaseToken, jobTypeFilter, minPriority],
    )
    await client.query('commit')

    return leaseResult.rows.map((row) => ({
      attemptCount: row.attempt_count,
      id: row.id,
      jobType: row.job_type,
      leaseToken,
      module: row.module_code,
      payload: row.payload_json,
      scope: row.scope_entity_type && row.scope_entity_id
        ? {
            entityId: row.scope_entity_id,
            entityType: row.scope_entity_type,
          }
        : null,
    }))
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    removeErrorLogger()
    client.release()
  }
}
