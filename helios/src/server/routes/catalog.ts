import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'

import {
  buildCatalogGroupModuleScope,
  CatalogBrowserQuerySchema,
  CatalogBrowserResponseSchema,
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
import {
  listCatalogBrowserCsvRows,
  listStockSnapshotCsvRows,
  renderCatalogSnapshotCsv,
  type CatalogSnapshotCsvRow,
} from '../db/queries/catalogSnapshotCsvQueries.js'
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
    const response = await listCatalogGroups(getPool(), query)
    // Validate the response shape server-side so any future drift
    // (schema rename, missing column, null where the client expects
    // [], etc.) fails here with a precise Zod error in the server
    // logs — rather than reaching the SPA loader and rendering as an
    // opaque ErrorBoundary on /catalog/browser. The loader on the
    // client also re-parses the body; this just makes the server the
    // first line of defense (regression: issue #17).
    return reply.send(CatalogBrowserResponseSchema.parse(response))
  })

  // Snapshot CSV exports. Per-(site × variant) rows with structured
  // attributes + pricing + on-hand state + synthetic cohort_key / has_image,
  // and NO sales info. Capped so a runaway export can't tie up the server.
  const CSV_ROW_LIMIT = 50_000

  function sendCsv(reply: FastifyReply, rows: CatalogSnapshotCsvRow[], filenameStem: string): FastifyReply {
    const csv = renderCatalogSnapshotCsv(rows)
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filenameStem}-${stamp}.csv"`)
      .send(csv)
  }

  // GET /api/catalog/groups.csv — catalog snapshot for the current browser
  // filter view (one row per site × catalog variant).
  server.get('/api/catalog/groups.csv', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return

    // Same filters as the browser, but page/pageSize are irrelevant to a
    // full export — Zod fills their defaults and we ignore them.
    const filters = CatalogBrowserQuerySchema.parse(request.query)
    const rows = await listCatalogBrowserCsvRows(getPool(), filters, CSV_ROW_LIMIT + 1)
    if (rows.length > CSV_ROW_LIMIT) {
      return reply.status(413).send({
        error: `Export exceeds ${CSV_ROW_LIMIT.toLocaleString()} rows. Narrow the filters first.`,
      })
    }
    return sendCsv(reply, rows, 'catalog-snapshot')
  })

  // GET /api/catalog/inventory/stock-snapshot.csv — current inventory snapshot
  // (one row per site × in-current-inventory variant; all sites).
  server.get('/api/catalog/inventory/stock-snapshot.csv', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return

    const rows = await listStockSnapshotCsvRows(getPool(), CSV_ROW_LIMIT + 1)
    if (rows.length > CSV_ROW_LIMIT) {
      return reply.status(413).send({
        error: `Export exceeds ${CSV_ROW_LIMIT.toLocaleString()} rows.`,
      })
    }
    return sendCsv(reply, rows, 'stock-snapshot')
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
