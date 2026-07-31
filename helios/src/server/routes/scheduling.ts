import { randomUUID } from 'node:crypto'

import type { QueryResultRow } from 'pg'
import type { FastifyInstance } from 'fastify'

import {
  schedulingCancellationError,
  MutationAcceptedResponseSchema,
  QueueSchedulingCandidateGenerationAcceptedResponseSchema,
  QueueSchedulingCandidateGenerationRequestSchema,
  QueueSchedulingRunAcceptedResponseSchema,
  QueueSchedulingRunRequestSchema,
  SaveSchedulingNormalizedInputRequestSchema,
  SchedulingRunDetailResponseSchema,
  SchedulingRunListQuerySchema,
  SchedulingRunListResponseSchema,
  SchedulingRunRouteParamsSchema,
  SelectSchedulingCandidateRequestSchema,
  applySchedulingWeeklyHoursPolicy,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { withTransaction } from '../db/tx.js'
import { notifyJobQueueEnqueued } from '../db/notify.js'
import { listSchedulingRuns, getSchedulingRunDetail } from '../db/queries/schedulingQueries.js'
import { enqueueJob } from '../jobs/enqueueJob.js'

interface InsertIdRow extends QueryResultRow {
  id: number
}

interface CandidateOwnershipRow extends QueryResultRow {
  id: number
}

interface SchedulingRunStateRow extends QueryResultRow {
  current_job_id: number | null
  normalized_input_json: unknown
  requested_candidate_count: number
  status: string
}

interface QueueRunNowJobRow extends QueryResultRow {
  id: number
  run_at: Date
}

interface CancelledJobRow extends QueryResultRow {
  id: number
}

export async function registerSchedulingRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/scheduling/runs', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const query = SchedulingRunListQuerySchema.parse(request.query)
    const response = await listSchedulingRuns(getPool(), query)
    return reply.send(SchedulingRunListResponseSchema.parse(response))
  })

  server.post('/api/scheduling/runs', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const body = QueueSchedulingRunRequestSchema.parse(request.body ?? {})
    const requestId = randomUUID()

    const mutationResult = await withTransaction(async (db) => {
      const insertResult = await db.query<InsertIdRow>(
        `
          insert into scheduling_runs (
            requested_by_user_id,
            requested_candidate_count,
            page_on_extraction_result,
            schedule_week_start_date,
            schedule_week_end_date,
            title,
            source_text,
            status
          )
          values ($1, $2, $3, $4, $5, $6, $7, 'queued')
          returning id
        `,
        [
          user.id,
          body.candidateCount,
          body.pageOnExtractionResult,
          body.scheduleWeek.startDate,
          body.scheduleWeek.endDate,
          body.title?.trim() || 'Scheduling run',
          body.sourceText,
        ],
      )

      const schedulingRunId = insertResult.rows[0].id
      const jobId = await enqueueJob(db, {
        dedupeKey: `scheduling.extract_constraints:${schedulingRunId}`,
        jobType: 'scheduling.extract_constraints',
        module: 'scheduling',
        payload: {
          requestedByUserId: user.id,
          schedulingRunId,
        },
        requestedByUserId: user.id,
        scope: {
          entityId: String(schedulingRunId),
          entityType: 'scheduling_run',
        },
      })

      await db.query(
        `
          update scheduling_runs
          set current_job_id = $2,
              updated_at = now()
          where id = $1
        `,
        [schedulingRunId, jobId],
      )

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(schedulingRunId),
        entityType: 'scheduling_run',
        eventType: 'scheduling.run.requested',
        module: 'scheduling',
        payload: {
          pageOnExtractionResult: body.pageOnExtractionResult,
          requestedCandidateCount: body.candidateCount,
          queuedJobId: jobId,
          scheduleWeek: body.scheduleWeek,
          schedulingRunId,
          title: body.title?.trim() || 'Scheduling run',
        },
        requestId,
        scope: {
          entityId: String(schedulingRunId),
          entityType: 'scheduling_run',
        },
        undoPayload: null,
      })

      return { auditEventId, jobId, schedulingRunId }
    })

    return reply.send(QueueSchedulingRunAcceptedResponseSchema.parse({
      auditEventId: mutationResult.auditEventId,
      jobId: mutationResult.jobId,
      requestId,
      schedulingRunId: mutationResult.schedulingRunId,
    }))
  })

  server.get('/api/scheduling/runs/:schedulingRunId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const params = SchedulingRunRouteParamsSchema.parse(request.params)
    const detail = await getSchedulingRunDetail(getPool(), params.schedulingRunId)
    if (!detail) {
      return reply.status(404).send({ error: 'Scheduling run not found.' })
    }
    return reply.send(SchedulingRunDetailResponseSchema.parse(detail))
  })

  server.put('/api/scheduling/runs/:schedulingRunId/normalized-input', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const params = SchedulingRunRouteParamsSchema.parse(request.params)
    const body = SaveSchedulingNormalizedInputRequestSchema.parse(request.body ?? {})
    const normalizedInput = applySchedulingWeeklyHoursPolicy(body.normalizedInput)
    const requestId = randomUUID()

    const result = await withTransaction(async (db) => {
      const updateResult = await db.query<InsertIdRow>(
        `
          update scheduling_runs
          set normalized_input_json = $2::jsonb,
              schedule_week_start_date = $3,
              schedule_week_end_date = $4,
              validation_issues_json = $5::jsonb,
              status = 'needs_review',
              latest_error = null,
              updated_at = now()
          where id = $1
          returning id
        `,
        [
          params.schedulingRunId,
          JSON.stringify(normalizedInput),
          normalizedInput.scheduleWeek.startDate,
          normalizedInput.scheduleWeek.endDate,
          JSON.stringify(normalizedInput.issues),
        ],
      )

      if (!updateResult.rows[0]) {
        throw new Error('Scheduling run not found.')
      }

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(params.schedulingRunId),
        entityType: 'scheduling_run',
        eventType: 'scheduling.run.normalized_input_saved',
        module: 'scheduling',
        payload: {
          issueCount: normalizedInput.issues.length,
          scheduleWeek: normalizedInput.scheduleWeek,
          schedulingRunId: params.schedulingRunId,
        },
        requestId,
        scope: {
          entityId: String(params.schedulingRunId),
          entityType: 'scheduling_run',
        },
        undoPayload: null,
      })

      return { auditEventId }
    })

    return reply.send(MutationAcceptedResponseSchema.parse({ auditEventId: result.auditEventId, jobId: null, requestId }))
  })

  server.post('/api/scheduling/runs/:schedulingRunId/generate-candidates', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const params = SchedulingRunRouteParamsSchema.parse(request.params)
    const body = QueueSchedulingCandidateGenerationRequestSchema.parse(request.body ?? {})
    const requestId = randomUUID()

    const mutationResult = await withTransaction(async (db) => {
      const runResult = await db.query<SchedulingRunStateRow>(
        `
          select normalized_input_json, requested_candidate_count
          from scheduling_runs
          where id = $1
        `,
        [params.schedulingRunId],
      )

      const run = runResult.rows[0]
      if (!run) {
        throw new Error('Scheduling run not found.')
      }
      if (!run.normalized_input_json) {
        throw new Error('Save a normalized scheduling input before generating candidates.')
      }

      const jobId = await enqueueJob(db, {
        dedupeKey: `scheduling.generate_candidates:${params.schedulingRunId}`,
        jobType: 'scheduling.generate_candidates',
        module: 'scheduling',
        payload: {
          requestedByUserId: user.id,
          schedulingRunId: params.schedulingRunId,
        },
        requestedByUserId: user.id,
        scope: {
          entityId: String(params.schedulingRunId),
          entityType: 'scheduling_run',
        },
      })

      await db.query(
        `
          update scheduling_runs
          set current_job_id = $2,
              status = 'generating',
              latest_error = null,
              updated_at = now()
          where id = $1
        `,
        [params.schedulingRunId, jobId],
      )

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(params.schedulingRunId),
        entityType: 'scheduling_run',
        eventType: 'scheduling.run.candidate_generation_requested',
        module: 'scheduling',
        payload: {
          requestedCandidateCount: run.requested_candidate_count,
          queuedJobId: jobId,
          reason: body.reason ?? null,
          schedulingRunId: params.schedulingRunId,
        },
        requestId,
        scope: {
          entityId: String(params.schedulingRunId),
          entityType: 'scheduling_run',
        },
        undoPayload: null,
      })

      return { auditEventId, jobId }
    })

    return reply.send(QueueSchedulingCandidateGenerationAcceptedResponseSchema.parse({
      auditEventId: mutationResult.auditEventId,
      jobId: mutationResult.jobId,
      requestId,
      schedulingRunId: params.schedulingRunId,
    }))
  })

  server.post('/api/scheduling/runs/:schedulingRunId/cancel', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const params = SchedulingRunRouteParamsSchema.parse(request.params)
    const requestId = randomUUID()

    const result = await withTransaction(async (db) => {
      const runResult = await db.query<SchedulingRunStateRow>(
        `
          select current_job_id, normalized_input_json, requested_candidate_count, status
          from scheduling_runs
          where id = $1
          for update
        `,
        [params.schedulingRunId],
      )

      const run = runResult.rows[0]
      if (!run) {
        throw new Error('Scheduling run not found.')
      }

      if (!['queued', 'extracting', 'generating'].includes(run.status)) {
        throw new Error('Only queued, extracting, or generating scheduling runs can be cancelled.')
      }

      const cancellationMessage = schedulingCancellationError(`Cancelled by ${user.name ?? 'operator'} from the scheduling run detail page.`)

      const cancelledJobsResult = await db.query<CancelledJobRow>(
        `
          update job_queue
          set status = case when status = 'queued' then 'failed' else status end,
              lease_token = case when status = 'queued' then null else lease_token end,
              leased_until = case when status = 'queued' then null else leased_until end,
              finished_at = case when status = 'queued' then now() else finished_at end,
              last_error = $2,
              updated_at = now()
          where scope_entity_type = 'scheduling_run'
            and scope_entity_id = $1
            and job_type in ('scheduling.extract_constraints', 'scheduling.generate_candidates')
            and status in ('queued', 'running')
          returning id
        `,
        [String(params.schedulingRunId), cancellationMessage],
      )

      await db.query(
        `
          update scheduling_runs
          set status = 'failed',
              current_job_id = null,
              latest_error = $2,
              updated_at = now()
          where id = $1
        `,
        [params.schedulingRunId, cancellationMessage],
      )

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(params.schedulingRunId),
        entityType: 'scheduling_run',
        eventType: 'scheduling.run.cancelled',
        module: 'scheduling',
        payload: {
          cancelledJobIds: cancelledJobsResult.rows.map((row) => row.id),
          schedulingRunId: params.schedulingRunId,
          previousCurrentJobId: run.current_job_id,
          previousStatus: run.status,
        },
        requestId,
        scope: {
          entityId: String(params.schedulingRunId),
          entityType: 'scheduling_run',
        },
        undoPayload: null,
      })
      await notifyJobQueueEnqueued(db)

      return { auditEventId }
    })

    return reply.send(MutationAcceptedResponseSchema.parse({ auditEventId: result.auditEventId, jobId: null, requestId }))
  })

  server.post('/api/scheduling/runs/:schedulingRunId/run-now', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const params = SchedulingRunRouteParamsSchema.parse(request.params)
    const requestId = randomUUID()

    const result = await withTransaction(async (db) => {
      const runResult = await db.query<SchedulingRunStateRow>(
        `
          select current_job_id, normalized_input_json, requested_candidate_count, status
          from scheduling_runs
          where id = $1
          for update
        `,
        [params.schedulingRunId],
      )

      const run = runResult.rows[0]
      if (!run) {
        throw new Error('Scheduling run not found.')
      }
      if (!run.current_job_id) {
        throw new Error('This scheduling run does not have an active queued job.')
      }

      const jobResult = await db.query<QueueRunNowJobRow>(
        `
          update job_queue
          set run_at = now(),
              last_error = null,
              updated_at = now()
          where id = $1
            and scope_entity_type = 'scheduling_run'
            and scope_entity_id = $2
            and status = 'queued'
          returning id, run_at
        `,
        [run.current_job_id, String(params.schedulingRunId)],
      )

      const queuedJob = jobResult.rows[0]
      if (!queuedJob) {
        throw new Error('Only queued scheduling jobs can be forced to run now.')
      }

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(params.schedulingRunId),
        entityType: 'scheduling_run',
        eventType: 'scheduling.run.run_now_requested',
        module: 'scheduling',
        payload: {
          schedulingRunId: params.schedulingRunId,
          queuedJobId: queuedJob.id,
          requestedByUserId: user.id,
        },
        requestId,
        scope: {
          entityId: String(params.schedulingRunId),
          entityType: 'scheduling_run',
        },
        undoPayload: null,
      })

      return { auditEventId, jobId: queuedJob.id }
    })

    return reply.send(MutationAcceptedResponseSchema.parse({ auditEventId: result.auditEventId, jobId: result.jobId, requestId }))
  })

  server.post('/api/scheduling/runs/:schedulingRunId/select-candidate', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const params = SchedulingRunRouteParamsSchema.parse(request.params)
    const body = SelectSchedulingCandidateRequestSchema.parse(request.body ?? {})
    const requestId = randomUUID()

    const result = await withTransaction(async (db) => {
      const ownershipResult = await db.query<CandidateOwnershipRow>(
        `
          select id
          from scheduling_candidates
          where id = $1
            and scheduling_run_id = $2
          limit 1
        `,
        [body.candidateId, params.schedulingRunId],
      )

      if (!ownershipResult.rows[0]) {
        throw new Error('Scheduling candidate not found for this run.')
      }

      await db.query(
        `
          update scheduling_runs
          set selected_candidate_id = $2,
              approved_at = now(),
              approved_by_user_id = $3,
              updated_at = now()
          where id = $1
        `,
        [params.schedulingRunId, body.candidateId, user.id],
      )

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(body.candidateId),
        entityType: 'scheduling_candidate',
        eventType: 'scheduling.candidate.selected',
        module: 'scheduling',
        payload: {
          candidateId: body.candidateId,
          schedulingRunId: params.schedulingRunId,
        },
        requestId,
        scope: {
          entityId: String(params.schedulingRunId),
          entityType: 'scheduling_run',
        },
        undoPayload: null,
      })

      return { auditEventId }
    })

    return reply.send(MutationAcceptedResponseSchema.parse({ auditEventId: result.auditEventId, jobId: null, requestId }))
  })
}
