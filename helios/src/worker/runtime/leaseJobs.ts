import { randomUUID } from 'node:crypto'

import type { QueryResultRow } from 'pg'

import type { JobStatusResponse } from '../../shared/contracts/api/jobs.js'
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

export async function leaseJobs(limit: number): Promise<LeasedJob[]> {
  const leaseToken = randomUUID()
  const pool = getPool()
  const client = await pool.connect()
  const removeErrorLogger = attachPoolClientErrorLogger(client, 'leaseJobs')

  try {
    await client.query('begin')
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

    const leaseResult = await client.query<LeasedJobRow>(
      `
        with runnable as (
          select
            jq.id,
            jq.run_at,
            jq.concurrency_key,
            case
              when jq.concurrency_key is null then 1
              else row_number() over (partition by jq.concurrency_key order by jq.run_at asc, jq.id asc)
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
          order by jq.run_at asc, jq.id asc
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
      [limit, leaseToken],
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
