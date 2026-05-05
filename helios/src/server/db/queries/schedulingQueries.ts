import type { QueryResultRow } from 'pg'

import {
  LLMExtractedConstraintsSchema,
  NormalizedSolverInputSchema,
  ScheduleCandidateSchema,
  SchedulingRunDetailResponseSchema,
  SchedulingRunListResponseSchema,
  SchedulingWeekWindowSchema,
  applySchedulingWeeklyHoursPolicy,
  type SchedulingRunDetailResponse,
  type SchedulingRunListQuery,
  type SchedulingRunListResponse,
  type JobListItem,
  type AuditEventRecord,
  type SchedulingRunQueueWaitingReason,
} from '../../../shared/contracts/index.js'
import type { JsonValue } from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'
import { toIsoString } from './helpers.js'

interface SchedulingRunListRow extends QueryResultRow {
  approved_at: Date | null
  approved_by_user: string | null
  candidate_count: number
  created_at: Date
  created_by_user: string | null
  current_job_id: number | null
  current_job_status: SchedulingRunListResponse['items'][number]['currentJobStatus']
  id: number
  latest_error: string | null
  page_on_extraction_result: boolean
  requested_candidate_count: number
  schedule_week_end_date: string | null
  schedule_week_start_date: string | null
  selected_candidate_id: number | null
  source_text: string
  status: SchedulingRunListResponse['items'][number]['status']
  title: string
  total_count: number
  validation_issues_json: unknown
}

interface SchedulingRunDetailRow extends QueryResultRow {
  approved_at: Date | null
  approved_by_user: string | null
  created_at: Date
  created_by_user: string | null
  current_job_id: number | null
  current_job_status: SchedulingRunDetailResponse['run']['currentJobStatus']
  extracted_constraints_json: unknown
  id: number
  latest_error: string | null
  normalized_input_json: unknown
  page_on_extraction_result: boolean
  requested_candidate_count: number
  schedule_week_end_date: string | null
  schedule_week_start_date: string | null
  selected_candidate_id: number | null
  source_text: string
  status: SchedulingRunDetailResponse['run']['status']
  title: string
  validation_issues_json: unknown
}

interface SchedulingCandidateRow extends QueryResultRow {
  id: number
  rank: number
  schedule_json: unknown
}

interface JobDebugRow extends QueryResultRow {
  attempt_count: number
  created_at: Date
  finished_at: Date | null
  id: number
  job_type: JobListItem['jobType']
  last_error: string | null
  module_code: JobListItem['module']
  requested_by_label: string | null
  requested_by_user_id: number | null
  run_at: Date
  scope_entity_id: string | null
  scope_entity_type: string | null
  started_at: Date | null
  status: JobListItem['status']
}

interface QueueCountsRow extends QueryResultRow {
  queue_ahead_count: number
  running_job_count: number
}

interface AuditEventDebugRow extends QueryResultRow {
  actor_label: string
  created_at: Date
  entity_id: string
  entity_type: AuditEventRecord['entityType']
  event_type: AuditEventRecord['eventType']
  id: number
  module_code: AuditEventRecord['module']
  payload_json: JsonValue
  scope_entity_id: string | null
  scope_entity_type: string | null
}

export async function listSchedulingRuns(
  db: Queryable,
  filters: SchedulingRunListQuery,
): Promise<SchedulingRunListResponse> {
  const offset = (filters.page - 1) * filters.pageSize
  const { values, whereSql } = buildRunWhere(filters)

  const result = await db.query<SchedulingRunListRow>(
    `
      select
        sr.id,
        sr.title,
        sr.source_text,
        sr.status,
        sr.validation_issues_json,
        sr.latest_error,
        sr.current_job_id,
        sr.selected_candidate_id,
        sr.page_on_extraction_result,
        sr.requested_candidate_count,
        sr.schedule_week_start_date::text,
        sr.schedule_week_end_date::text,
        sr.created_at,
        sr.approved_at,
        coalesce(candidate_counts.candidate_count, 0) as candidate_count,
        jq.status as current_job_status,
        creator.name as created_by_user,
        approver.name as approved_by_user,
        count(*) over() as total_count
      from scheduling_runs sr
      left join job_queue jq on jq.id = sr.current_job_id
      left join users creator on creator.id = sr.requested_by_user_id
      left join users approver on approver.id = sr.approved_by_user_id
      left join (
        select scheduling_run_id, count(*)::int as candidate_count
        from scheduling_candidates
        group by scheduling_run_id
      ) candidate_counts on candidate_counts.scheduling_run_id = sr.id
      ${whereSql}
      order by sr.created_at desc, sr.id desc
      limit $${values.length + 1}
      offset $${values.length + 2}
    `,
    [...values, filters.pageSize, offset],
  )

  return SchedulingRunListResponseSchema.parse({
    filters,
    items: result.rows.map((row) => ({
      approvedAt: toIsoString(row.approved_at),
      approvedByUser: row.approved_by_user,
      candidateCount: row.candidate_count,
      createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
      createdByUser: row.created_by_user,
      currentJobId: row.current_job_id,
      currentJobStatus: row.current_job_status,
      id: row.id,
      latestError: row.latest_error,
      pageOnExtractionResult: row.page_on_extraction_result,
      requestedCandidateCount: row.requested_candidate_count,
      scheduleWeek: parseScheduleWeek(row.schedule_week_start_date, row.schedule_week_end_date),
      selectedCandidateId: row.selected_candidate_id,
      sourceTextPreview: buildSourcePreview(row.source_text),
      status: row.status,
      title: row.title,
      validationIssues: parseValidationIssues(row.validation_issues_json),
    })),
    totalCount: result.rows[0]?.total_count ?? 0,
  })
}

export async function getSchedulingRunDetail(
  db: Queryable,
  schedulingRunId: number,
): Promise<SchedulingRunDetailResponse | null> {
  const runResult = await db.query<SchedulingRunDetailRow>(
    `
      select
        sr.id,
        sr.title,
        sr.source_text,
        sr.status,
        sr.validation_issues_json,
        sr.latest_error,
        sr.current_job_id,
        sr.selected_candidate_id,
        sr.page_on_extraction_result,
        sr.requested_candidate_count,
        sr.schedule_week_start_date::text,
        sr.schedule_week_end_date::text,
        sr.created_at,
        sr.approved_at,
        sr.extracted_constraints_json,
        sr.normalized_input_json,
        jq.status as current_job_status,
        creator.name as created_by_user,
        approver.name as approved_by_user
      from scheduling_runs sr
      left join job_queue jq on jq.id = sr.current_job_id
      left join users creator on creator.id = sr.requested_by_user_id
      left join users approver on approver.id = sr.approved_by_user_id
      where sr.id = $1
      limit 1
    `,
    [schedulingRunId],
  )

  const runRow = runResult.rows[0]
  if (!runRow) {
    return null
  }

  const candidateResult = await db.query<SchedulingCandidateRow>(
    `
      select id, rank, schedule_json
      from scheduling_candidates
      where scheduling_run_id = $1
      order by rank asc, id asc
    `,
    [schedulingRunId],
  )

  const [relatedJobsResult, recentEventsResult] = await Promise.all([
    db.query<JobDebugRow>(
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
        where jq.scope_entity_type = 'scheduling_run'
          and jq.scope_entity_id = $1
        order by jq.created_at desc, jq.id desc
        limit 10
      `,
      [String(schedulingRunId)],
    ),
    db.query<AuditEventDebugRow>(
      `
        select
          ae.id,
          ae.created_at,
          ae.module_code,
          ae.scope_entity_type,
          ae.scope_entity_id,
          ae.entity_type,
          ae.entity_id,
          ae.event_type,
          ae.payload_json,
          coalesce(u.name, ae.actor_type) as actor_label
        from audit_events ae
        left join users u on u.id = ae.actor_user_id
        where ae.module_code = 'scheduling'
          and ae.scope_entity_type = 'scheduling_run'
          and ae.scope_entity_id = $1
        order by ae.created_at desc, ae.id desc
        limit 10
      `,
      [String(schedulingRunId)],
    ),
  ])

  const relatedJobs = relatedJobsResult.rows.map(mapJobDebugRow)
  const currentJob = relatedJobs.find((job) => job.jobId === runRow.current_job_id) ?? null
  const queue = await buildQueueDebug(db, currentJob)

  return SchedulingRunDetailResponseSchema.parse({
    debug: {
      currentJob,
      queue,
      recentEvents: recentEventsResult.rows.map(mapAuditEventDebugRow),
      relatedJobs,
    },
    run: {
      approvedAt: toIsoString(runRow.approved_at),
      approvedByUser: runRow.approved_by_user,
      candidateCount: candidateResult.rows.length,
      createdAt: toIsoString(runRow.created_at) ?? new Date(0).toISOString(),
      createdByUser: runRow.created_by_user,
      currentJobId: runRow.current_job_id,
      currentJobStatus: runRow.current_job_status,
      extractedConstraints: runRow.extracted_constraints_json === null ? null : LLMExtractedConstraintsSchema.parse(runRow.extracted_constraints_json),
      id: runRow.id,
      latestError: runRow.latest_error,
      normalizedInput: runRow.normalized_input_json === null ? null : applySchedulingWeeklyHoursPolicy(NormalizedSolverInputSchema.parse(runRow.normalized_input_json)),
      pageOnExtractionResult: runRow.page_on_extraction_result,
      requestedCandidateCount: runRow.requested_candidate_count,
      scheduleWeek: parseScheduleWeek(runRow.schedule_week_start_date, runRow.schedule_week_end_date),
      selectedCandidateId: runRow.selected_candidate_id,
      sourceText: runRow.source_text,
      sourceTextPreview: buildSourcePreview(runRow.source_text),
      status: runRow.status,
      title: runRow.title,
      validationIssues: parseValidationIssues(runRow.validation_issues_json),
    },
    candidates: candidateResult.rows.map((row) => ({
      id: row.id,
      rank: row.rank,
      schedule: ScheduleCandidateSchema.parse(row.schedule_json),
    })),
  })
}

async function buildQueueDebug(db: Queryable, currentJob: JobListItem | null): Promise<SchedulingRunDetailResponse['debug']['queue']> {
  const nowResult = await db.query<{ now: Date }>('select now()')
  const currentTime = toIsoString(nowResult.rows[0]?.now) ?? new Date().toISOString()

  if (!currentJob) {
    return {
      blockingJobs: [],
      currentTime,
      eligibleToRun: false,
      queueAheadCount: 0,
      runningJobCount: 0,
      waitingReason: 'no_current_job',
    }
  }

  if (currentJob.status === 'running') {
    const runningJobsResult = await db.query<JobDebugRow>(
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
        where jq.status = 'running'
        order by jq.started_at asc nulls last, jq.id asc
        limit 5
      `,
    )

    return {
      blockingJobs: runningJobsResult.rows.map(mapJobDebugRow),
      currentTime,
      eligibleToRun: true,
      queueAheadCount: 0,
      runningJobCount: runningJobsResult.rows.length,
      waitingReason: 'running',
    }
  }

  if (currentJob.status !== 'queued') {
    return {
      blockingJobs: [],
      currentTime,
      eligibleToRun: false,
      queueAheadCount: 0,
      runningJobCount: 0,
      waitingReason: 'not_queued',
    }
  }

  const queueCountsResult = await db.query<QueueCountsRow>(
    `
      select
        (
          select count(*)::int
          from job_queue ahead
          where ahead.status = 'queued'
            and ahead.run_at <= now()
            and (ahead.run_at < $2::timestamptz or (ahead.run_at = $2::timestamptz and ahead.id < $1))
        ) as queue_ahead_count,
        (
          select count(*)::int
          from job_queue running
          where running.status = 'running'
        ) as running_job_count
    `,
    [currentJob.jobId, currentJob.runAt],
  )

  const blockingJobsResult = await db.query<JobDebugRow>(
    `
      with running_jobs as (
        select jq.id
        from job_queue jq
        where jq.status = 'running'
        order by jq.started_at asc nulls last, jq.id asc
        limit 5
      ),
      queued_ahead as (
        select jq.id
        from job_queue jq
        where jq.status = 'queued'
          and jq.run_at <= now()
          and (jq.run_at < $2::timestamptz or (jq.run_at = $2::timestamptz and jq.id < $1))
        order by jq.run_at asc, jq.id asc
        limit 5
      ),
      picked as (
        select id from running_jobs
        union
        select id from queued_ahead
      )
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
      from picked
      inner join job_queue jq on jq.id = picked.id
      left join users u on u.id = jq.requested_by_user_id
      order by case when jq.status = 'running' then 0 else 1 end, jq.run_at asc, jq.id asc
    `,
    [currentJob.jobId, currentJob.runAt],
  )

  const queueCounts = queueCountsResult.rows[0] ?? { queue_ahead_count: 0, running_job_count: 0 }
  const eligibleToRun = new Date(currentJob.runAt).getTime() <= new Date(currentTime).getTime()

  return {
    blockingJobs: blockingJobsResult.rows.map(mapJobDebugRow),
    currentTime,
    eligibleToRun,
    queueAheadCount: queueCounts.queue_ahead_count,
    runningJobCount: queueCounts.running_job_count,
    waitingReason: determineWaitingReason({
      eligibleToRun,
      queueAheadCount: queueCounts.queue_ahead_count,
      runningJobCount: queueCounts.running_job_count,
    }),
  }
}

function determineWaitingReason(input: {
  eligibleToRun: boolean
  queueAheadCount: number
  runningJobCount: number
}): SchedulingRunQueueWaitingReason {
  if (!input.eligibleToRun) {
    return 'scheduled_for_future'
  }
  if (input.queueAheadCount > 0 || input.runningJobCount > 0) {
    return 'queued_behind_other_jobs'
  }
  return 'waiting_for_worker'
}

function mapJobDebugRow(row: JobDebugRow): JobListItem {
  return {
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
  }
}

function mapAuditEventDebugRow(row: AuditEventDebugRow): AuditEventRecord {
  return {
    actorLabel: row.actor_label,
    createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
    entityId: row.entity_id,
    entityType: row.entity_type,
    eventId: row.id,
    eventType: row.event_type,
    module: row.module_code,
    payload: row.payload_json,
    scope: row.scope_entity_type && row.scope_entity_id
      ? {
          entityId: row.scope_entity_id,
          entityType: row.scope_entity_type,
        }
      : null,
    summaryText: buildAuditSummaryText(row.event_type, row.payload_json),
    undoAvailable: false,
    undo: null,
  }
}

function buildAuditSummaryText(eventType: string, payload: unknown): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const summary = 'summary' in payload && typeof payload.summary === 'string' ? payload.summary : null
    if (summary) {
      return summary
    }
  }

  return eventType
}

function buildRunWhere(filters: SchedulingRunListQuery): { values: unknown[]; whereSql: string } {
  const values: unknown[] = []
  const clauses: string[] = []

  if (filters.status) {
    values.push(filters.status)
    clauses.push(`sr.status = $${values.length}`)
  }

  if (filters.search) {
    values.push(`%${filters.search}%`)
    clauses.push(`(sr.title ilike $${values.length} or sr.source_text ilike $${values.length})`)
  }

  return {
    values,
    whereSql: clauses.length > 0 ? `where ${clauses.join(' and ')}` : '',
  }
}

function buildSourcePreview(sourceText: string): string {
  const normalized = sourceText.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 180) {
    return normalized
  }
  return `${normalized.slice(0, 177).trimEnd()}...`
}

function parseValidationIssues(value: unknown) {
  return NormalizedSolverInputSchema.shape.issues.parse(value)
}

function parseScheduleWeek(startDate: string | null, endDate: string | null) {
  if (!startDate || !endDate) {
    return null
  }

  return SchedulingWeekWindowSchema.parse({ endDate, startDate })
}
