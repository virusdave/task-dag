import { z } from 'zod'

import { HeliosModuleCodeSchema } from './modules.js'
import { ScopeKindSchema, ScopeRefSchema } from './scopeRef.js'

/**
 * Annotation kinds. `mso` is the brand-level MSO annotation that the
 * catalog operator surface needs to render; the same shape supports
 * arbitrary item/row/group level annotations (e.g. a curator note).
 */
export const ANNOTATION_KINDS = ['mso', 'note', 'flag', 'curator'] as const
export const AnnotationKindSchema = z.enum(ANNOTATION_KINDS)
export type AnnotationKind = z.infer<typeof AnnotationKindSchema>

export const AnnotationRecordSchema = z.object({
  id: z.number().int().positive(),
  module: HeliosModuleCodeSchema,
  scopeKind: ScopeKindSchema,
  scopeRef: ScopeRefSchema,
  kind: AnnotationKindSchema,
  body: z.string().trim().min(1),
  authorUserId: z.number().int().positive().nullable(),
  authorLabel: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  retractedAt: z.iso.datetime().nullable(),
})
export type AnnotationRecord = z.infer<typeof AnnotationRecordSchema>
