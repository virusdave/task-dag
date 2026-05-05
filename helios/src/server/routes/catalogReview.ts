import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import {
  ScopeKindSchema,
  ScopeRefSchema,
  type CatalogReviewRerunRowJobPayload,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { withTransaction } from '../db/tx.js'
import { enqueueJob } from '../jobs/enqueueJob.js'

const RowActionBodySchema = z.object({
  scopeKind: ScopeKindSchema,
  scopeRef: ScopeRefSchema,
  reason: z.string().trim().min(1).max(1000).optional(),
})

function entityTypeForScope(scopeKind: z.infer<typeof ScopeKindSchema>):
  | 'catalog_group'
  | 'pending_purchase_row'
  | 'pending_purchase_packet'
  | 'proposal_line_item'
  | 'proposal_batch'
  | 'catalog_brand'
  | 'catalog_item'
  | 'write_operation'
  | 'job' {
  switch (scopeKind) {
    case 'catalog_group':
      return 'catalog_group'
    case 'pending_purchase_row':
      return 'pending_purchase_row'
    case 'pending_purchase_packet':
      return 'pending_purchase_packet'
    case 'proposal_line_item':
      return 'proposal_line_item'
    case 'proposal_batch':
      return 'proposal_batch'
    case 'catalog_brand':
      return 'catalog_brand'
    case 'catalog_item':
      return 'catalog_item'
    case 'write_operation':
      return 'write_operation'
    case 'job':
      return 'job'
    case 'audit_event':
      return 'catalog_group'
  }
}

export async function registerCatalogReviewRoutes(server: FastifyInstance): Promise<void> {
  server.post('/api/catalog/review/rerun-row', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const body = RowActionBodySchema.parse(request.body ?? {})
    const requestId = randomUUID()
    const payload: CatalogReviewRerunRowJobPayload = {
      scopeKind: body.scopeKind,
      scopeRef: body.scopeRef,
      reason: body.reason,
      requestedByUserId: user.id,
    }
    const jobId = await withTransaction(async (db) => {
      const enqueued = await enqueueJob(db, {
        jobType: 'catalog.review.rerun_row',
        module: 'catalog',
        payload,
        requestedByUserId: user.id,
        scope: null,
      })
      await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(body.scopeRef.id),
        entityType: entityTypeForScope(body.scopeKind),
        eventType: 'catalog.review.row.rerun_requested',
        module: 'catalog',
        payload: {
          scopeKind: body.scopeKind,
          scopeRef: body.scopeRef,
          reason: body.reason ?? null,
          queuedJobId: enqueued,
        },
        requestId,
        undoPayload: null,
      })
      return enqueued
    })
    return reply.send({ jobId, requestId })
  })

  server.post('/api/catalog/review/fail-row', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'approver')
    if (!user) {
      return
    }
    const body = RowActionBodySchema.parse(request.body ?? {})
    const requestId = randomUUID()
    const auditEventId = await withTransaction(async (db) => {
      return await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(body.scopeRef.id),
        entityType: entityTypeForScope(body.scopeKind),
        eventType: 'catalog.review.row.failed',
        module: 'catalog',
        payload: {
          scopeKind: body.scopeKind,
          scopeRef: body.scopeRef,
          decision: 'rejected',
          reason: body.reason ?? null,
        },
        requestId,
        undoPayload: null,
      })
    })
    return reply.send({ auditEventId, requestId })
  })
}
