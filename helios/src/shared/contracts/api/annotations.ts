import { z } from 'zod'

import { AnnotationKindSchema, AnnotationRecordSchema } from '../domain/annotations.js'
import { HeliosModuleCodeSchema } from '../domain/modules.js'
import { ScopeKindSchema, ScopeRefSchema } from '../domain/scopeRef.js'

export const AnnotationsListQuerySchema = z.object({
  module: HeliosModuleCodeSchema,
  scopeKind: ScopeKindSchema,
  scopeId: z.string().trim().min(1),
  brandId: z.string().trim().min(1).optional(),
  itemKey: z.string().trim().min(1).optional(),
  kind: AnnotationKindSchema.optional(),
  includeRetracted: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value) => value === true || value === 'true'),
})
export type AnnotationsListQuery = z.infer<typeof AnnotationsListQuerySchema>

export const AnnotationsListResponseSchema = z.object({
  annotations: z.array(AnnotationRecordSchema),
})
export type AnnotationsListResponse = z.infer<typeof AnnotationsListResponseSchema>

export const AnnotationsCreateBodySchema = z.object({
  module: HeliosModuleCodeSchema,
  scopeKind: ScopeKindSchema,
  scopeRef: ScopeRefSchema,
  kind: AnnotationKindSchema,
  body: z.string().trim().min(1).max(10_000),
})
export type AnnotationsCreateBody = z.infer<typeof AnnotationsCreateBodySchema>

export const AnnotationsCreateResponseSchema = z.object({
  annotation: AnnotationRecordSchema,
})
export type AnnotationsCreateResponse = z.infer<typeof AnnotationsCreateResponseSchema>

export const AnnotationRouteParamsSchema = z.object({
  annotationId: z.coerce.number().int().positive(),
})
export type AnnotationRouteParams = z.infer<typeof AnnotationRouteParamsSchema>
