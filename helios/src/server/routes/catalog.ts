import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import {
  buildCatalogGroupModuleScope,
  CatalogBrowserQuerySchema,
  CatalogHistoryQuerySchema,
  CatalogHistoryResponseSchema,
  CatalogGroupRouteParamsSchema,
  GroupDetailResponseSchema,
  MutationAcceptedResponseSchema,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { getCatalogHistory } from '../db/queries/catalogHistoryQueries.js'
import { getGroupDetail, listCatalogGroups } from '../db/queries/catalogQueries.js'
import { getOptionalSweedSessionConcurrencyKey } from '../jobs/concurrency.js'
import { enqueueJob } from '../jobs/enqueueJob.js'
import { withTransaction } from '../db/tx.js'

const RefreshCatalogGroupRequestSchema = z.object({
  reason: z.string().trim().max(500).nullable().optional(),
})

const RefreshCatalogSummaryRequestSchema = z.object({
  reason: z.string().trim().max(500).nullable().optional(),
})

export async function registerCatalogRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/catalog/history', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const query = CatalogHistoryQuerySchema.parse(request.query)
    const response = await getCatalogHistory(getPool(), query)
    return reply.send(CatalogHistoryResponseSchema.parse(response))
  })

  server.get('/api/catalog/groups', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const query = CatalogBrowserQuerySchema.parse(request.query)
    const payload = GroupDetailResponseSchema.safeParse
    void payload
    const response = await listCatalogGroups(getPool(), query)
    return reply.send(response)
  })

  server.post('/api/catalog/refresh', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const body = RefreshCatalogSummaryRequestSchema.parse(request.body ?? {})
    const requestId = randomUUID()

    const mutationResult = await withTransaction(async (db) => {
      const jobId = await enqueueJob(db, {
        concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
        dedupeKey: 'catalog.sync.full_summary',
        jobType: 'catalog.sync.full_summary',
        module: 'catalog',
        payload: {
          requestedByUserId: user.id,
          trigger: 'manual_refresh',
        },
        requestedByUserId: user.id,
      })

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(jobId),
        entityType: 'job',
        eventType: 'catalog.full_sync.requested',
        module: 'catalog',
        payload: {
          queuedJobId: jobId,
          requestedReason: body.reason ?? null,
          trigger: 'manual_refresh',
        },
        requestId,
        undoPayload: null,
      })

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

  server.get('/api/catalog/groups/:catalogGroupId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const params = CatalogGroupRouteParamsSchema.parse(request.params)
    const detail = await getGroupDetail(getPool(), params.catalogGroupId)
    if (!detail) {
      return reply.status(404).send({ error: 'Catalog group not found.' })
    }

    return reply.send(GroupDetailResponseSchema.parse(detail))
  })

  server.post('/api/catalog-groups/:catalogGroupId/refresh', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const params = CatalogGroupRouteParamsSchema.parse(request.params)
    const body = RefreshCatalogGroupRequestSchema.parse(request.body ?? {})
    const requestId = randomUUID()

    const mutationResult = await withTransaction(async (db) => {
      const scope = buildCatalogGroupModuleScope(params.catalogGroupId)
      const jobId = await enqueueJob(db, {
        concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
        dedupeKey: `catalog.sync.group_detail:${params.catalogGroupId}`,
        jobType: 'catalog.sync.group_detail',
        module: 'catalog',
        payload: {
          catalogGroupId: params.catalogGroupId,
          forceLiveRefresh: true,
          requestedByUserId: user.id,
          trigger: 'manual_refresh',
        },
        requestedByUserId: user.id,
        scope,
      })

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(params.catalogGroupId),
        entityType: 'catalog_group',
        eventType: 'catalog.group.refresh_requested',
        module: 'catalog',
        payload: {
          catalogGroupId: params.catalogGroupId,
          queuedJobId: jobId,
          requestedReason: body.reason ?? null,
        },
        requestId,
        scope,
        undoPayload: null,
      })

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
