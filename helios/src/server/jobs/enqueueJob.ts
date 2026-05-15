import type { QueryResultRow } from 'pg'

import {
  parseCatalogGroupIdFromModuleScope,
  type HeliosModuleCode,
  type HeliosModuleScope,
  type JobPayload,
  type JobType,
} from '../../shared/contracts/index.js'
import type { Queryable } from '../db/pool.js'

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
        requested_by_user_id
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'queued', $9, $10)
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
    ],
  )

  return result.rows[0].id
}
