import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import type { QueryResultRow } from 'pg'

import {
  HistoryEventRouteParamsSchema,
  HistoryEventsQuerySchema,
  HistoryEventsResponseSchema,
  MutationAcceptedResponseSchema,
  RequestHistoryEventUndoSchema,
  parseUndoableAuditEvent,
} from '../../shared/contracts/index.js'
import type { JsonValue } from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { listHistoryEvents } from '../db/queries/historyQueries.js'
import { withTransaction } from '../db/tx.js'
import { getOptionalSweedSessionConcurrencyKey } from '../jobs/concurrency.js'
import { enqueueJob } from '../jobs/enqueueJob.js'

interface OriginalAuditEventRow extends QueryResultRow {
  event_type: string
  module_code: string
  payload_json: JsonValue
  scope_entity_id: string | null
  scope_entity_type: string | null
  undo_payload_json: JsonValue | null
}

interface UndoEventInsertRow extends QueryResultRow {
  id: number
}

interface ExistingUndoEventRow extends QueryResultRow {
  id: number
  status: 'completed' | 'failed' | 'queued' | 'running'
}

export async function registerHistoryRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/history/events', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const query = HistoryEventsQuerySchema.parse(request.query)
    const response = await listHistoryEvents(getPool(), query)
    return reply.send(HistoryEventsResponseSchema.parse(response))
  })

  server.post('/api/history/events/:eventId/undo', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) {
      return
    }

    const params = HistoryEventRouteParamsSchema.parse(request.params)
    const body = RequestHistoryEventUndoSchema.parse(request.body ?? {})
    const requestId = randomUUID()

    const mutationResult = await withTransaction(async (db) => {
      const originalEventResult = await db.query<OriginalAuditEventRow>(
        `
          select
            event_type,
            module_code,
            payload_json,
            scope_entity_type,
            scope_entity_id,
            undo_payload_json
          from audit_events
          where id = $1
          for update
        `,
        [params.eventId],
      )

      const originalEvent = originalEventResult.rows[0]
      if (!originalEvent) {
        throw new Error('History event not found.')
      }
      if (originalEvent.undo_payload_json === null) {
        throw new Error('This history event cannot be undone.')
      }

      parseUndoableAuditEvent({
        eventType: originalEvent.event_type,
        payload: originalEvent.payload_json,
        undoPayload: originalEvent.undo_payload_json,
      })
      if (originalEvent.module_code !== 'catalog') {
        throw new Error('Undo is only supported for catalog history events.')
      }

      const existingUndoResult = await db.query<ExistingUndoEventRow>(
        `
          select id, status
          from undo_events
          where original_event_id = $1
          limit 1
        `,
        [params.eventId],
      )

      const existingUndo = existingUndoResult.rows[0]
      if (existingUndo) {
        throw new Error(`Undo has already been requested for this event (${existingUndo.status}).`)
      }

      const undoEventResult = await db.query<UndoEventInsertRow>(
        `
          insert into undo_events (
            original_event_id,
            requested_by_user_id,
            status
          )
          values ($1, $2, 'queued')
          returning id
        `,
        [params.eventId, user.id],
      )
      const undoEventId = undoEventResult.rows[0].id
      const scope = originalEvent.scope_entity_type && originalEvent.scope_entity_id
        ? {
            entityId: originalEvent.scope_entity_id,
            entityType: originalEvent.scope_entity_type,
          }
        : null

      const jobId = await enqueueJob(db, {
        concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
        dedupeKey: `undo.execute:${undoEventId}`,
        jobType: 'undo.execute',
        module: 'catalog',
        payload: { undoEventId },
        requestedByUserId: user.id,
        scope,
      })

      await db.query(
        `
          update undo_events
          set job_id = $2,
              updated_at = now()
          where id = $1
        `,
        [undoEventId, jobId],
      )

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(undoEventId),
        entityType: 'undo_event',
        eventType: 'undo.requested',
        module: 'catalog',
        payload: {
          originalEventId: params.eventId,
          originalEventType: originalEvent.event_type,
          queuedJobId: jobId,
          requestedReason: body.reason ?? null,
          undoEventId,
        },
        requestId,
        scope,
        undoPayload: null,
      })

      await db.query(
        `
          update undo_events
          set undo_audit_event_id = $2,
              updated_at = now()
          where id = $1
        `,
        [undoEventId, auditEventId],
      )

      return { auditEventId, jobId }
    })

    return reply.send(
      MutationAcceptedResponseSchema.parse({
        auditEventId: mutationResult.auditEventId,
        jobId: mutationResult.jobId,
        requestId,
      }),
    )
  })
}
