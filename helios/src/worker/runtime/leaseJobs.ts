import { randomUUID } from 'node:crypto'

import type { Pool, QueryResultRow } from 'pg'

import type { JobStatusResponse } from '../../shared/contracts/api/jobs.js'
import type { JobType } from '../../shared/contracts/domain/jobs.js'
import { JOB_PRIORITY_LIVE_REQUESTED, JOB_PRIORITY_URGENT, SCHEDULING_CANCELLATION_MARKER } from '../../shared/contracts/index.js'
import { attachPoolClientErrorLogger, getPool } from '../../server/db/pool.js'
import { lockWorkerCapacityConfig } from '../../server/db/queries/workerCapacityQueries.js'

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
}

export interface LeaseJobsDependencies {
  pool?: Pick<Pool, 'connect'>
}

export const EXPIRED_LEASE_SWEEP_SQL = `
  with changed as (
  update job_queue
  set status = case when last_error like '${SCHEDULING_CANCELLATION_MARKER}%' or job_type in ('catalog.inventory.stage_trade_samples','catalog.inventory.zero_trade_samples') then 'failed' else 'queued' end,
      lease_token = null,
      leased_until = null,
      started_at = case when last_error like '${SCHEDULING_CANCELLATION_MARKER}%' or job_type in ('catalog.inventory.stage_trade_samples','catalog.inventory.zero_trade_samples') then started_at else null end,
      finished_at = case when last_error like '${SCHEDULING_CANCELLATION_MARKER}%' or job_type in ('catalog.inventory.stage_trade_samples','catalog.inventory.zero_trade_samples') then coalesce(finished_at, now()) else null end,
      run_at = now(),
      last_error = case when last_error like '${SCHEDULING_CANCELLATION_MARKER}%' then last_error
        when job_type in ('catalog.inventory.stage_trade_samples','catalog.inventory.zero_trade_samples')
        then 'Destructive trade-sample job lease expired; inspect Sweed. It will not retry automatically.'
        else 'Worker lease expired before job completion; retrying.' end,
      updated_at = now()
  where status = 'running'
    and leased_until is not null
    and leased_until < now()
  returning 1
  )
  select pg_notify('helios_job_queue', '')
  where exists (select 1 from changed)
`

export async function leaseJobs(
  options: LeaseJobsOptions = {},
  injected: LeaseJobsDependencies = {},
): Promise<LeasedJob[]> {
  const leaseToken = randomUUID()
  const pool = injected.pool ?? getPool()
  const client = await pool.connect()
  const removeErrorLogger = attachPoolClientErrorLogger(client, 'leaseJobs')

  const jobTypeFilter = options.jobTypes && options.jobTypes.length > 0 ? options.jobTypes : null
  try {
    await client.query('begin')
    const capacity = (await lockWorkerCapacityConfig(client)).config
    // Gated expired-lease sweep — see the EXPIRED_LEASE_SWEEP_*
    // block at module top for the why. We do the time check
    // inside the transaction so two concurrent worker processes
    // each see their own cadence; the UPDATE itself is idempotent
    // (predicate is `leased_until < now()`) so racing sweeps are
    // safe.
    const nowMs = Date.now()
    if (nowMs - lastExpiredLeaseSweepMs >= EXPIRED_LEASE_SWEEP_INTERVAL_MS) {
      lastExpiredLeaseSweepMs = nowMs
      await client.query(EXPIRED_LEASE_SWEEP_SQL)
    }

    const leaseResult = await client.query<LeasedJobRow>(
      `
        with running_counts as (
          select count(*)::integer as total,
                 count(*) filter (where priority < $4)::integer as below_urgent,
                 count(*) filter (where priority < $3)::integer as general
          from job_queue where status = 'running'
        ), runnable as materialized (
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
        ranked as (
          select jq.id, jq.priority,
                 count(*) filter (where jq.priority < $3) over (order by jq.priority desc, jq.run_at, jq.id)::integer as general_rank,
                 count(*) filter (where jq.priority < $4) over (order by jq.priority desc, jq.run_at, jq.id)::integer as below_urgent_rank,
                 row_number() over (order by jq.priority desc, jq.run_at, jq.id)::integer as total_rank
          from job_queue jq
          inner join runnable on runnable.id = jq.id
          where jq.status = 'queued'
            and runnable.concurrency_rank = 1
            and ($2::text[] is null or jq.job_type = any($2::text[]))
          order by jq.priority desc, jq.run_at asc, jq.id asc
        ), candidates as (
          select jq.id
          from ranked
          inner join job_queue jq on jq.id = ranked.id
          cross join running_counts
          where running_counts.total + ranked.total_rank <= $7
            and (ranked.priority >= $4 or running_counts.below_urgent + ranked.below_urgent_rank <= $6)
            and (ranked.priority >= $3 or running_counts.general + ranked.general_rank <= $5)
          order by ranked.priority desc, ranked.id
          for update of jq skip locked
        )
        update job_queue jq
        set status = 'running',
            lease_token = $1,
            leased_until = now() + interval '5 minutes',
            started_at = now(),
            attempt_count = jq.attempt_count + 1,
            last_error = null,
            updated_at = now()
        from candidates
        where jq.id = candidates.id
        returning jq.id, jq.job_type, jq.module_code, jq.scope_entity_type, jq.scope_entity_id, jq.payload_json, jq.attempt_count
      `,
      [leaseToken, jobTypeFilter, JOB_PRIORITY_LIVE_REQUESTED, JOB_PRIORITY_URGENT,
        capacity.generalSlots,
        capacity.generalSlots + capacity.liveRequestedReservedSlots,
        capacity.generalSlots + capacity.liveRequestedReservedSlots + capacity.urgentReservedSlots],
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
