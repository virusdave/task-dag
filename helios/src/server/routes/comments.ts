import type { FastifyInstance } from 'fastify'

import {
  CommentRouteParamsSchema,
  CommentsCreateBodySchema,
  CommentsCreateResponseSchema,
  CommentsListQuerySchema,
  CommentsListResponseSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { insertComment, listComments, softDeleteComment } from '../db/queries/commentsQueries.js'

export async function registerCommentsRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/comments', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const query = CommentsListQuerySchema.parse(request.query ?? {})
    const comments = await listComments(getPool(), {
      module: query.module,
      scopeKind: query.scopeKind,
      scopeId: query.scopeId,
      brandId: query.brandId ?? null,
      itemKey: query.itemKey ?? null,
      includeDeleted: query.includeDeleted,
    })
    return reply.send(CommentsListResponseSchema.parse({ comments }))
  })

  server.post('/api/comments', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const body = CommentsCreateBodySchema.parse(request.body ?? {})
    const comment = await insertComment(getPool(), {
      module: body.module,
      scopeKind: body.scopeKind,
      scopeRef: body.scopeRef,
      body: body.body,
      authorUserId: user.id,
    })
    return reply.send(CommentsCreateResponseSchema.parse({ comment }))
  })

  server.delete('/api/comments/:commentId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }
    const params = CommentRouteParamsSchema.parse(request.params)
    const comment = await softDeleteComment(getPool(), params.commentId, user.id)
    if (!comment) {
      return reply.status(404).send({ error: 'Comment not found or already deleted.' })
    }
    return reply.send(CommentsCreateResponseSchema.parse({ comment }))
  })
}
