import type { QueryResultRow } from 'pg'

import type { JobsQuery, JobsResponse, JobStatusResponse } from '../../../shared/contracts/api/jobs.js'
import type { Queryable } from '../pool.js'
import { toIsoString } from './helpers.js'
import { listSweedAuthEventsForJob } from './sweedAuthEventsQueries.js'

interface JobRow extends QueryResultRow {
  attempt_count: number
  catalog_group_id: number | null
  created_at: Date
  finished_at: Date | null
  id: number
  job_type: JobStatusResponse['job']['jobType']
  last_error: string | null
  module_code: JobStatusResponse['job']['module']
  payload_json: {
    llmRunId?: number
    pendingPurchaseApplyRequestId?: number
    pendingPurchasePacketId?: number
    progressLog?: Array<{
      createdAt?: string
      message?: string
    }> | null
    progress?: {
      completed?: number | null
      message?: string
      phase?: string
      phaseCount?: number
      phaseIndex?: number
      total?: number | null
    } | null
    proposalBatchId?: number
    undoEventId?: number
    writeOperationId?: number
  } | null
  requested_by_label: string | null
  requested_by_user_id: number | null
  run_at: Date
  scope_entity_id: string | null
  scope_entity_type: string | null
  started_at: Date | null
  status: JobStatusResponse['job']['status']
}

interface JobListRow extends QueryResultRow {
  attempt_count: number
  created_at: Date
  finished_at: Date | null
  id: number
  job_type: JobsResponse['items'][number]['jobType']
  last_error: string | null
  module_code: JobsResponse['items'][number]['module']
  requested_by_label: string | null
  requested_by_user_id: number | null
  run_at: Date
  scope_entity_id: string | null
  scope_entity_type: string | null
  started_at: Date | null
  status: JobsResponse['items'][number]['status']
}

export async function listJobs(db: Queryable, filters: JobsQuery): Promise<JobsResponse> {
  const { values, whereSql } = buildJobsWhere(filters)

  const result = await db.query<JobListRow>(
    `
      select
        jq.id,
        jq.created_at,
        jq.job_type,
        jq.status,
        jq.run_at,
        jq.attempt_count,
        jq.started_at,
        jq.finished_at,
        jq.last_error,
        jq.module_code,
        jq.requested_by_user_id,
        u.name as requested_by_label,
        jq.scope_entity_type,
        jq.scope_entity_id
      from job_queue jq
      left join users u on u.id = jq.requested_by_user_id
      ${whereSql}
      order by jq.run_at desc, jq.id desc
      limit $${values.length + 1}
    `,
    [...values, filters.pageSize],
  )

  const nextCursor = result.rows.length === filters.pageSize
    ? toIsoString(result.rows[result.rows.length - 1].run_at)
    : null

  return {
    filters,
    items: result.rows.map((row) => ({
      attemptCount: row.attempt_count,
      createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
      finishedAt: toIsoString(row.finished_at),
      jobId: row.id,
      jobType: row.job_type,
      lastError: row.last_error,
      module: row.module_code,
      requestedByLabel: row.requested_by_label,
      requestedByUserId: row.requested_by_user_id,
      runAt: toIsoString(row.run_at) ?? new Date(0).toISOString(),
      scope: row.scope_entity_type && row.scope_entity_id
        ? {
            entityId: row.scope_entity_id,
            entityType: row.scope_entity_type,
          }
        : null,
      startedAt: toIsoString(row.started_at),
      status: row.status,
    })),
    nextCursor,
  }
}

export async function getJobStatus(db: Queryable, jobId: number): Promise<JobStatusResponse | null> {
  const result = await db.query<JobRow>(
    `
      select
        jq.id,
        jq.created_at,
        jq.job_type,
        jq.status,
        jq.run_at,
        jq.attempt_count,
        jq.started_at,
        jq.finished_at,
        jq.last_error,
        jq.module_code,
        jq.catalog_group_id,
        jq.requested_by_user_id,
        u.name as requested_by_label,
        jq.payload_json,
        jq.scope_entity_type,
        jq.scope_entity_id
      from job_queue jq
      left join users u on u.id = jq.requested_by_user_id
      where jq.id = $1
    `,
    [jobId],
  )

  const row = result.rows[0]
  if (!row) {
    return null
  }

  const sweedAuthEvents = await listSweedAuthEventsForJob(db, row.id)

  return {
    job: {
      attemptCount: row.attempt_count,
      createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
      finishedAt: toIsoString(row.finished_at),
      jobId: row.id,
      jobType: row.job_type,
      lastError: row.last_error,
      module: row.module_code,
      requestedByLabel: row.requested_by_label,
      requestedByUserId: row.requested_by_user_id,
      runAt: toIsoString(row.run_at) ?? new Date(0).toISOString(),
      scope: row.scope_entity_type && row.scope_entity_id
        ? {
            entityId: row.scope_entity_id,
            entityType: row.scope_entity_type,
          }
        : null,
      startedAt: toIsoString(row.started_at),
      status: row.status,
    },
    linkedRecords: readLinkedRecords(row.payload_json),
    progressLog: readProgressLog(row.payload_json),
    progress: readProgress(row.payload_json),
    sweedAuthEvents,
  }
}

function buildJobsWhere(filters: JobsQuery): { values: unknown[]; whereSql: string } {
  const clauses: string[] = []
  const values: unknown[] = []

  if (filters.jobType) {
    values.push(filters.jobType)
    clauses.push(`jq.job_type = $${values.length}`)
  }
  if (filters.module) {
    values.push(filters.module)
    clauses.push(`jq.module_code = $${values.length}`)
  }
  if (filters.scopeEntityType) {
    values.push(filters.scopeEntityType)
    clauses.push(`jq.scope_entity_type = $${values.length}`)
  }
  if (filters.scopeEntityId) {
    values.push(filters.scopeEntityId)
    clauses.push(`jq.scope_entity_id = $${values.length}`)
  }
  if (filters.status) {
    values.push(filters.status)
    clauses.push(`jq.status = $${values.length}`)
  }
  if (filters.beforeRunAt) {
    values.push(filters.beforeRunAt)
    clauses.push(`jq.run_at < $${values.length}::timestamptz`)
  }

  return {
    values,
    whereSql: clauses.length > 0 ? `where ${clauses.join(' and ')}` : '',
  }
}

function readLinkedRecords(payloadJson: JobRow['payload_json']): JobStatusResponse['linkedRecords'] {
  return {
    llmRunId: typeof payloadJson?.llmRunId === 'number' ? payloadJson.llmRunId : null,
    pendingPurchaseApplyRequestId: typeof payloadJson?.pendingPurchaseApplyRequestId === 'number'
      ? payloadJson.pendingPurchaseApplyRequestId
      : null,
    pendingPurchasePacketId: typeof payloadJson?.pendingPurchasePacketId === 'number' ? payloadJson.pendingPurchasePacketId : null,
    proposalBatchId: typeof payloadJson?.proposalBatchId === 'number' ? payloadJson.proposalBatchId : null,
    undoEventId: typeof payloadJson?.undoEventId === 'number' ? payloadJson.undoEventId : null,
    writeOperationId: typeof payloadJson?.writeOperationId === 'number' ? payloadJson.writeOperationId : null,
  }
}

function readProgress(payloadJson: JobRow['payload_json']): JobStatusResponse['progress'] {
  const progress = payloadJson?.progress
  if (!progress) {
    return null
  }

  const phase = typeof progress.phase === 'string' && progress.phase.trim().length > 0 ? progress.phase : null
  const message = typeof progress.message === 'string' && progress.message.trim().length > 0 ? progress.message : null
  const phaseIndex = Number.isInteger(progress.phaseIndex) && (progress.phaseIndex ?? 0) > 0 ? progress.phaseIndex ?? null : null
  const phaseCount = Number.isInteger(progress.phaseCount) && (progress.phaseCount ?? 0) > 0 ? progress.phaseCount ?? null : null
  if (!phase || !message || !phaseIndex || !phaseCount || phaseIndex > phaseCount) {
    return null
  }

  const completed = Number.isInteger(progress.completed) && (progress.completed ?? 0) >= 0 ? progress.completed ?? null : null
  const total = Number.isInteger(progress.total) && (progress.total ?? 0) > 0 ? progress.total ?? null : null

  return {
    completed,
    message,
    phase,
    phaseCount,
    phaseIndex,
    total,
  }
}

function readProgressLog(payloadJson: JobRow['payload_json']): JobStatusResponse['progressLog'] {
  if (!Array.isArray(payloadJson?.progressLog)) {
    return []
  }

  return payloadJson.progressLog.flatMap((entry) => {
    const createdAt = typeof entry?.createdAt === 'string' && entry.createdAt.trim().length > 0 ? entry.createdAt : null
    const message = typeof entry?.message === 'string' && entry.message.trim().length > 0 ? entry.message : null
    if (!createdAt || !message) {
      return []
    }

    return [{ createdAt, message }]
  })
}
