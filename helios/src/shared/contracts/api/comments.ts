import { z } from 'zod'

import { CommentRecordSchema } from '../domain/comments.js'
import { HeliosModuleCodeSchema } from '../domain/modules.js'
import { ScopeKindSchema, ScopeRefSchema } from '../domain/scopeRef.js'

export const CommentsListQuerySchema = z.object({
  module: HeliosModuleCodeSchema,
  scopeKind: ScopeKindSchema,
  scopeId: z.string().trim().min(1),
  brandId: z.string().trim().min(1).optional(),
  itemKey: z.string().trim().min(1).optional(),
  includeDeleted: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value) => value === true || value === 'true'),
})
export type CommentsListQuery = z.infer<typeof CommentsListQuerySchema>

export const CommentsListResponseSchema = z.object({
  comments: z.array(CommentRecordSchema),
})
export type CommentsListResponse = z.infer<typeof CommentsListResponseSchema>

export const CommentsCreateBodySchema = z.object({
  module: HeliosModuleCodeSchema,
  scopeKind: ScopeKindSchema,
  scopeRef: ScopeRefSchema,
  body: z.string().trim().min(1).max(10_000),
})
export type CommentsCreateBody = z.infer<typeof CommentsCreateBodySchema>

export const CommentsCreateResponseSchema = z.object({
  comment: CommentRecordSchema,
})
export type CommentsCreateResponse = z.infer<typeof CommentsCreateResponseSchema>

export const CommentRouteParamsSchema = z.object({
  commentId: z.coerce.number().int().positive(),
})
export type CommentRouteParams = z.infer<typeof CommentRouteParamsSchema>
