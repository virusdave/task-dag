import type { FastifyInstance } from 'fastify'

import {
  AnnotationRouteParamsSchema,
  AnnotationsCreateBodySchema,
  AnnotationsCreateResponseSchema,
  AnnotationsListQuerySchema,
  AnnotationsListResponseSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { insertAnnotation, listAnnotations, retractAnnotation } from '../db/queries/annotationsQueries.js'

export async function registerAnnotationsRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/annotations', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const query = AnnotationsListQuerySchema.parse(request.query ?? {})
    const annotations = await listAnnotations(getPool(), {
      module: query.module,
      scopeKind: query.scopeKind,
      scopeId: query.scopeId,
      brandId: query.brandId ?? null,
      itemKey: query.itemKey ?? null,
      kind: query.kind ?? null,
      includeRetracted: query.includeRetracted,
    })
    return reply.send(AnnotationsListResponseSchema.parse({ annotations }))
  })

  server.post('/api/annotations', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const body = AnnotationsCreateBodySchema.parse(request.body ?? {})
    const annotation = await insertAnnotation(getPool(), {
      module: body.module,
      scopeKind: body.scopeKind,
      scopeRef: body.scopeRef,
      kind: body.kind,
      body: body.body,
      authorUserId: user.id,
    })
    return reply.send(AnnotationsCreateResponseSchema.parse({ annotation }))
  })

  server.delete('/api/annotations/:annotationId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const params = AnnotationRouteParamsSchema.parse(request.params)
    const annotation = await retractAnnotation(getPool(), params.annotationId, user.id)
    if (!annotation) {
      return reply.status(404).send({ error: 'Annotation not found or already retracted.' })
    }
    return reply.send(AnnotationsCreateResponseSchema.parse({ annotation }))
  })
}
