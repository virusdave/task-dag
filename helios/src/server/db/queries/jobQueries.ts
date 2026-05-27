import type { QueryResultRow } from 'pg'

import type {
  JobQueueMetricsResponse,
  JobsQuery,
  JobsResponse,
  JobStatusResponse,
} from '../../../shared/contracts/api/jobs.js'
import {
  classifyJobPriorityBand,
  type JobExecutionPool,
  type JobPriorityBand,
} from '../../../shared/contracts/domain/jobs.js'
import {
  JOB_EXECUTION_POOL_BY_TYPE,
  JOB_EXECUTION_POOLS,
} from '../../../worker/runtime/jobPools.js'
import type { Queryable } from '../pool.js'
import { toIsoString } from './helpers.js'
import { listSweedAuthEventsForJob } from './sweedAuthEventsQueries.js'

const JOB_POOL_TUPLES: Array<[string, JobExecutionPool]> = Object.entries(
  JOB_EXECUTION_POOL_BY_TYPE,
).map(([jobType, meta]) => [jobType, meta.pool])

/**
 * Build a `(values …) as t(job_type, execution_pool)` CTE so SQL
 * aggregates can join job rows to their execution pool without
 * hard-coding the mapping in two places.
 */
function buildPoolMapSql(paramOffset: number): { sql: string; values: unknown[] } {
  const values: unknown[] = []
  const rows: string[] = []
  for (const [jobType, pool] of JOB_POOL_TUPLES) {
    values.push(jobType, pool)
    rows.push(`($${paramOffset + values.length - 1}::text, $${paramOffset + values.length}::text)`)
  }
  return {
    sql: `(values ${rows.join(', ')}) as pool_map(job_type, execution_pool)`,
    values,
  }
}

function poolForJobType(jobType: string): JobExecutionPool {
  const meta = JOB_EXECUTION_POOL_BY_TYPE[jobType as keyof typeof JOB_EXECUTION_POOL_BY_TYPE]
  // Defensive default: any newly added job_type that hasn't been
  // classified yet is treated as 'system'. The Record<JobType, …>
  // typecheck on JOB_EXECUTION_POOL_BY_TYPE catches the omission at
  // compile time, so this only fires in dev hot-reload windows.
  return meta?.pool ?? 'system'
}

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
  priority: number
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
  priority: number
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

  // When the operator filters by `status=queued`, sort by lease
  // order (priority desc, run_at asc) so the rows match what the
  // worker will actually lease next. Other statuses keep the
  // reverse-chronological view.
  const orderBy = filters.status === 'queued'
    ? 'order by jq.priority desc, jq.run_at asc, jq.id asc'
    : 'order by jq.run_at desc, jq.id desc'

  const result = await db.query<JobListRow>(
    `
      select
        jq.id,
        jq.created_at,
        jq.job_type,
        jq.status,
        jq.priority,
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
      ${orderBy}
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
      executionPool: poolForJobType(row.job_type),
      finishedAt: toIsoString(row.finished_at),
      jobId: row.id,
      jobType: row.job_type,
      lastError: row.last_error,
      module: row.module_code,
      priority: row.priority,
      priorityBand: classifyJobPriorityBand(row.priority),
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
        jq.priority,
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
      executionPool: poolForJobType(row.job_type),
      finishedAt: toIsoString(row.finished_at),
      jobId: row.id,
      jobType: row.job_type,
      lastError: row.last_error,
      module: row.module_code,
      priority: row.priority,
      priorityBand: classifyJobPriorityBand(row.priority),
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
  if (filters.pool) {
    const jobTypesInPool = JOB_POOL_TUPLES
      .filter(([, pool]) => pool === filters.pool)
      .map(([jobType]) => jobType)
    values.push(jobTypesInPool)
    clauses.push(`jq.job_type = any($${values.length}::text[])`)
  }
  if (filters.priorityBand) {
    const range = priorityRangeForBand(filters.priorityBand)
    values.push(range.minInclusive)
    const minIdx = values.length
    if (range.maxExclusive !== null) {
      values.push(range.maxExclusive)
      clauses.push(`jq.priority >= $${minIdx} and jq.priority < $${values.length}`)
    } else {
      clauses.push(`jq.priority >= $${minIdx}`)
    }
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

function priorityRangeForBand(band: JobPriorityBand): { minInclusive: number; maxExclusive: number | null } {
  // Half-open ranges [min, nextMin). Kept in sync with
  // JOB_PRIORITY_BANDS in shared/contracts/domain/jobs.ts.
  switch (band) {
    case 'urgent':
      return { minInclusive: 1000, maxExclusive: null }
    case 'live_requested':
      return { minInclusive: 500, maxExclusive: 1000 }
    case 'interactive':
      return { minInclusive: 100, maxExclusive: 500 }
    case 'backfill':
      return { minInclusive: 10, maxExclusive: 100 }
    case 'best_effort':
      return { minInclusive: 0, maxExclusive: 10 }
    default: {
      const _exhaustive: never = band
      throw new Error(`Unhandled priority band: ${String(_exhaustive)}`)
    }
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

interface CellRow extends QueryResultRow {
  execution_pool: JobExecutionPool
  priority_band: JobPriorityBand
  ready_count: string
  scheduled_count: string
  running_count: string
  oldest_ready_wait_seconds: string | null
  p50_ready_wait_seconds: string | null
  p95_ready_wait_seconds: string | null
  oldest_ready_job_id: number | null
  oldest_ready_job_type: string | null
  oldest_ready_run_at: Date | null
  oldest_ready_priority: number | null
}

interface PoolRow extends QueryResultRow {
  execution_pool: JobExecutionPool
  running_count: string
  ready_total: string
  scheduled_total: string
  oldest_running_seconds: string | null
  running_over_one_hour_count: string
  expired_lease_count: string
  oldest_running_job_id: number | null
  oldest_running_job_type: string | null
  oldest_running_started_at: Date | null
}

interface AlertsRow extends QueryResultRow {
  dead_letter_last_24h: string
  failed_last_1h: string
  expired_lease_count: string
}

function toInt(value: string | number | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) {
    return fallback
  }
  return typeof value === 'number' ? value : Number.parseInt(value, 10)
}

function toIntOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null
  }
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Snapshot of current job-queue depth and queueing delay, grouped by
 * the (execution_pool, priority_band) matrix the Jobs dashboard
 * renders. The query takes one `now()` reading and reuses it so
 * every cell shares a consistent clock.
 *
 * The returned `cells` array is fully populated — one row per
 * (pool, band) combination, with zeroes for empty cells — so the UI
 * can render a stable grid.
 */
export async function getJobQueueMetrics(db: Queryable): Promise<JobQueueMetricsResponse> {
  const poolMap = buildPoolMapSql(1)

  // Cell + pool aggregator. Single query so both views share the
  // same `classified` snapshot (no risk of drift between calls).
  const aggregateSql = `
    with
    snapshot as (select now() as ts),
    pool_map as (select * from ${poolMap.sql}),
    pools(execution_pool, sort_order) as (
      values
        ('sweed'::text, 1),
        ('ads'::text, 2),
        ('scheduling'::text, 3),
        ('system'::text, 4)
    ),
    bands(priority_band, min_priority, max_priority_exclusive, sort_order) as (
      values
        ('urgent'::text,         1000::int, null::int,  1),
        ('live_requested'::text,  500::int, 1000::int,  2),
        ('interactive'::text,     100::int,  500::int,  3),
        ('backfill'::text,         10::int,  100::int,  4),
        ('best_effort'::text,       0::int,   10::int,  5)
    ),
    classified as (
      select
        jq.id,
        jq.job_type,
        jq.priority,
        jq.status,
        jq.run_at,
        jq.started_at,
        jq.leased_until,
        pm.execution_pool,
        case
          when jq.priority >= 1000 then 'urgent'
          when jq.priority >= 500 then 'live_requested'
          when jq.priority >= 100 then 'interactive'
          when jq.priority >= 10 then 'backfill'
          else 'best_effort'
        end as priority_band,
        snapshot.ts
      from job_queue jq
      join pool_map pm on pm.job_type = jq.job_type
      cross join snapshot
      where jq.status in ('queued', 'running')
    ),
    ready as (
      select
        execution_pool,
        priority_band,
        id,
        job_type,
        run_at,
        priority,
        greatest(0, floor(extract(epoch from (ts - run_at))))::int as wait_seconds
      from classified
      where status = 'queued'
        and run_at <= ts
    ),
    cell_agg as (
      select
        execution_pool,
        priority_band,
        count(*)::int as ready_count,
        max(wait_seconds)::int as oldest_ready_wait_seconds,
        round(percentile_cont(0.5) within group (order by wait_seconds))::int as p50_ready_wait_seconds,
        round(percentile_cont(0.95) within group (order by wait_seconds))::int as p95_ready_wait_seconds
      from ready
      group by execution_pool, priority_band
    ),
    scheduled_agg as (
      select
        execution_pool,
        priority_band,
        count(*)::int as scheduled_count
      from classified
      where status = 'queued'
        and run_at > ts
      group by execution_pool, priority_band
    ),
    running_cell_agg as (
      select
        execution_pool,
        priority_band,
        count(*)::int as running_count
      from classified
      where status = 'running'
      group by execution_pool, priority_band
    ),
    oldest_ready as (
      select distinct on (execution_pool, priority_band)
        execution_pool,
        priority_band,
        id as oldest_ready_job_id,
        job_type as oldest_ready_job_type,
        run_at as oldest_ready_run_at,
        priority as oldest_ready_priority
      from ready
      order by execution_pool, priority_band, run_at asc, id asc
    )
    select
      'cell'::text as row_kind,
      p.execution_pool,
      b.priority_band,
      coalesce(ca.ready_count, 0) as ready_count,
      coalesce(sa.scheduled_count, 0) as scheduled_count,
      coalesce(ra.running_count, 0) as running_count,
      ca.oldest_ready_wait_seconds,
      ca.p50_ready_wait_seconds,
      ca.p95_ready_wait_seconds,
      o.oldest_ready_job_id,
      o.oldest_ready_job_type,
      o.oldest_ready_run_at,
      o.oldest_ready_priority,
      null::int as ready_total,
      null::int as scheduled_total,
      null::int as oldest_running_seconds,
      null::int as running_over_one_hour_count,
      null::int as expired_lease_count,
      null::bigint as oldest_running_job_id,
      null::text as oldest_running_job_type,
      null::timestamptz as oldest_running_started_at
    from pools p
    cross join bands b
    left join cell_agg ca
      on ca.execution_pool = p.execution_pool and ca.priority_band = b.priority_band
    left join scheduled_agg sa
      on sa.execution_pool = p.execution_pool and sa.priority_band = b.priority_band
    left join running_cell_agg ra
      on ra.execution_pool = p.execution_pool and ra.priority_band = b.priority_band
    left join oldest_ready o
      on o.execution_pool = p.execution_pool and o.priority_band = b.priority_band
  `

  const poolHealthSql = `
    with
    snapshot as (select now() as ts),
    pool_map as (select * from ${poolMap.sql}),
    pools(execution_pool, sort_order) as (
      values
        ('sweed'::text, 1),
        ('ads'::text, 2),
        ('scheduling'::text, 3),
        ('system'::text, 4)
    ),
    classified as (
      select
        jq.id,
        jq.job_type,
        jq.status,
        jq.run_at,
        jq.started_at,
        jq.leased_until,
        pm.execution_pool,
        snapshot.ts
      from job_queue jq
      join pool_map pm on pm.job_type = jq.job_type
      cross join snapshot
      where jq.status in ('queued', 'running')
    ),
    pool_agg as (
      select
        p.execution_pool,
        count(c.*) filter (where c.status = 'running')::int as running_count,
        count(c.*) filter (where c.status = 'queued' and c.run_at <= c.ts)::int as ready_total,
        count(c.*) filter (where c.status = 'queued' and c.run_at > c.ts)::int as scheduled_total,
        max(
          case
            when c.status = 'running' and c.started_at is not null
              then greatest(0, floor(extract(epoch from (c.ts - c.started_at))))::int
            else null
          end
        ) as oldest_running_seconds,
        count(c.*) filter (
          where c.status = 'running'
            and c.started_at <= c.ts - interval '1 hour'
        )::int as running_over_one_hour_count,
        count(c.*) filter (
          where c.status = 'running'
            and c.leased_until is not null
            and c.leased_until < c.ts
        )::int as expired_lease_count
      from pools p
      left join classified c on c.execution_pool = p.execution_pool
      group by p.execution_pool, p.sort_order
    ),
    oldest_running as (
      select distinct on (execution_pool)
        execution_pool,
        id as oldest_running_job_id,
        job_type as oldest_running_job_type,
        started_at as oldest_running_started_at
      from classified
      where status = 'running' and started_at is not null
      order by execution_pool, started_at asc, id asc
    )
    select
      pa.execution_pool,
      pa.running_count,
      pa.ready_total,
      pa.scheduled_total,
      pa.oldest_running_seconds,
      pa.running_over_one_hour_count,
      pa.expired_lease_count,
      orun.oldest_running_job_id,
      orun.oldest_running_job_type,
      orun.oldest_running_started_at
    from pool_agg pa
    left join oldest_running orun on orun.execution_pool = pa.execution_pool
  `

  const alertsSql = `
    with snapshot as (select now() as ts)
    select
      count(*) filter (
        where status = 'dead_letter'
          and finished_at >= snapshot.ts - interval '24 hours'
      )::int as dead_letter_last_24h,
      count(*) filter (
        where status = 'failed'
          and finished_at >= snapshot.ts - interval '1 hour'
      )::int as failed_last_1h,
      count(*) filter (
        where status = 'running'
          and leased_until is not null
          and leased_until < snapshot.ts
      )::int as expired_lease_count
    from job_queue
    cross join snapshot
  `

  const [cellsResult, poolsResult, alertsResult] = await Promise.all([
    db.query<CellRow>(aggregateSql, poolMap.values),
    db.query<PoolRow>(poolHealthSql, poolMap.values),
    db.query<AlertsRow>(alertsSql),
  ])

  const cells: JobQueueMetricsResponse['cells'] = cellsResult.rows.map((row) => ({
    pool: row.execution_pool,
    priorityBand: row.priority_band,
    readyCount: toInt(row.ready_count),
    scheduledCount: toInt(row.scheduled_count),
    runningCount: toInt(row.running_count),
    oldestReadyWaitSeconds: toIntOrNull(row.oldest_ready_wait_seconds),
    p50ReadyWaitSeconds: toIntOrNull(row.p50_ready_wait_seconds),
    p95ReadyWaitSeconds: toIntOrNull(row.p95_ready_wait_seconds),
    oldestReadyJob: row.oldest_ready_job_id !== null
      && row.oldest_ready_job_type !== null
      && row.oldest_ready_run_at !== null
      && row.oldest_ready_priority !== null
      ? {
        jobId: row.oldest_ready_job_id,
        jobType: row.oldest_ready_job_type as JobsResponse['items'][number]['jobType'],
        runAt: toIsoString(row.oldest_ready_run_at) ?? new Date(0).toISOString(),
        priority: row.oldest_ready_priority,
      }
      : null,
  }))

  // Defensive ordering so the UI doesn't have to sort.
  const poolOrder: Record<JobExecutionPool, number> = { sweed: 1, ads: 2, scheduling: 3, system: 4 }
  const bandOrder: Record<JobPriorityBand, number> = {
    urgent: 1,
    live_requested: 2,
    interactive: 3,
    backfill: 4,
    best_effort: 5,
  }
  cells.sort((a, b) => {
    const poolDelta = poolOrder[a.pool] - poolOrder[b.pool]
    if (poolDelta !== 0) return poolDelta
    return bandOrder[a.priorityBand] - bandOrder[b.priorityBand]
  })

  const pools: JobQueueMetricsResponse['pools'] = JOB_EXECUTION_POOLS.map((pool) => {
    const row = poolsResult.rows.find((r) => r.execution_pool === pool)
    if (!row) {
      return {
        pool,
        runningCount: 0,
        readyTotal: 0,
        scheduledTotal: 0,
        oldestRunningSeconds: null,
        runningOverOneHourCount: 0,
        expiredLeaseCount: 0,
        oldestRunningJob: null,
      }
    }
    return {
      pool,
      runningCount: toInt(row.running_count),
      readyTotal: toInt(row.ready_total),
      scheduledTotal: toInt(row.scheduled_total),
      oldestRunningSeconds: toIntOrNull(row.oldest_running_seconds),
      runningOverOneHourCount: toInt(row.running_over_one_hour_count),
      expiredLeaseCount: toInt(row.expired_lease_count),
      oldestRunningJob: row.oldest_running_job_id !== null
        && row.oldest_running_job_type !== null
        && row.oldest_running_started_at !== null
        ? {
          jobId: row.oldest_running_job_id,
          jobType: row.oldest_running_job_type as JobsResponse['items'][number]['jobType'],
          startedAt: toIsoString(row.oldest_running_started_at) ?? new Date(0).toISOString(),
        }
        : null,
    }
  })

  const alertsRow = alertsResult.rows[0]
  const alerts: JobQueueMetricsResponse['alerts'] = {
    deadLetterLast24h: toInt(alertsRow?.dead_letter_last_24h),
    failedLast1h: toInt(alertsRow?.failed_last_1h),
    expiredLeaseCount: toInt(alertsRow?.expired_lease_count),
  }

  return {
    generatedAt: new Date().toISOString(),
    cells,
    pools,
    alerts,
  }
}
