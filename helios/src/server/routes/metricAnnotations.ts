import type { FastifyInstance } from 'fastify'

import {
  MetricAnnotationRouteParamsSchema,
  MetricAnnotationsCreateBodySchema,
  MetricAnnotationsCreateResponseSchema,
  MetricAnnotationsListQuerySchema,
  MetricAnnotationsListResponseSchema,
  MetricAnnotationsPatchBodySchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import {
  getMetricAnnotationById,
  insertMetricAnnotation,
  listMetricAnnotations,
  patchMetricAnnotation,
  softDeleteMetricAnnotation,
} from '../db/queries/metricAnnotationsQueries.js'

const MIGRATION_MISSING_RE = /relation .*metric_annotations.* does not exist/i

function isMigrationMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return MIGRATION_MISSING_RE.test(message)
}

function sendMigrationMissing(reply: import('fastify').FastifyReply): void {
  reply
    .status(503)
    .send({ error: 'metric_annotations table is missing. Apply migration 030_metric_annotations.sql.' })
}

export async function registerMetricAnnotationsRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/metric-annotations', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) {
      return
    }
    const query = MetricAnnotationsListQuerySchema.parse(request.query ?? {})
    try {
      const annotations = await listMetricAnnotations(getPool(), {
        from: query.from ? new Date(query.from) : null,
        to: query.to ? new Date(query.to) : null,
        scope: query.scope ?? null,
        includeDeleted: query.includeDeleted,
      })
      return reply.send(MetricAnnotationsListResponseSchema.parse({ annotations }))
    } catch (error) {
      if (isMigrationMissing(error)) {
        return sendMigrationMissing(reply)
      }
      throw error
    }
  })

  server.post('/api/metric-annotations', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) {
      return
    }
    const body = MetricAnnotationsCreateBodySchema.parse(request.body)
    try {
      const annotation = await insertMetricAnnotation(getPool(), {
        author: user.email,
        tStart: new Date(body.tStart),
        tEnd: body.tEnd ? new Date(body.tEnd) : null,
        title: body.title,
        body: body.body ?? '',
        tag: body.tag ?? null,
        scope: body.scope,
      })
      return reply
        .status(201)
        .send(MetricAnnotationsCreateResponseSchema.parse({ annotation }))
    } catch (error) {
      if (isMigrationMissing(error)) {
        return sendMigrationMissing(reply)
      }
      throw error
    }
  })

  server.patch('/api/metric-annotations/:annotationId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) {
      return
    }
    const params = MetricAnnotationRouteParamsSchema.parse(request.params)
    const body = MetricAnnotationsPatchBodySchema.parse(request.body)
    try {
      const annotation = await patchMetricAnnotation(getPool(), params.annotationId, {
        tStart: body.tStart ? new Date(body.tStart) : undefined,
        tEnd: body.tEnd === undefined ? undefined : body.tEnd === null ? null : new Date(body.tEnd),
        title: body.title,
        body: body.body,
        tag: body.tag === undefined ? undefined : body.tag,
        scope: body.scope,
      })
      if (!annotation) {
        return reply.status(404).send({ error: 'Annotation not found or already deleted.' })
      }
      return reply.send(MetricAnnotationsCreateResponseSchema.parse({ annotation }))
    } catch (error) {
      if (isMigrationMissing(error)) {
        return sendMigrationMissing(reply)
      }
      throw error
    }
  })

  server.delete('/api/metric-annotations/:annotationId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) {
      return
    }
    const params = MetricAnnotationRouteParamsSchema.parse(request.params)
    try {
      const existing = await getMetricAnnotationById(getPool(), params.annotationId)
      if (!existing) {
        return reply.status(404).send({ error: 'Annotation not found.' })
      }
      if (existing.deletedAt !== null) {
        // Already soft-deleted — idempotent success.
        return reply.status(204).send()
      }
      const ok = await softDeleteMetricAnnotation(getPool(), params.annotationId)
      if (!ok) {
        return reply.status(404).send({ error: 'Annotation not found.' })
      }
      return reply.status(204).send()
    } catch (error) {
      if (isMigrationMissing(error)) {
        return sendMigrationMissing(reply)
      }
      throw error
    }
  })
}
