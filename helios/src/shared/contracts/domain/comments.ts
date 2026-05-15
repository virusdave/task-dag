import { z } from 'zod'

import { HeliosModuleCodeSchema } from './modules.js'
import { ScopeKindSchema, ScopeRefSchema } from './scopeRef.js'

export const CommentRecordSchema = z.object({
  id: z.number().int().positive(),
  module: HeliosModuleCodeSchema,
  scopeKind: ScopeKindSchema,
  scopeRef: ScopeRefSchema,
  body: z.string().trim().min(1),
  authorUserId: z.number().int().positive().nullable(),
  authorLabel: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
})
export type CommentRecord = z.infer<typeof CommentRecordSchema>
