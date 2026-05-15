import { z } from 'zod'

import { AuditEventRecordSchema } from '../domain/audit.js'
import { HeliosModuleCodeSchema } from '../domain/modules.js'

export const HistoryEventRouteParamsSchema = z.object({
  eventId: z.coerce.number().int().positive(),
})
export type HistoryEventRouteParams = z.infer<typeof HistoryEventRouteParamsSchema>

export const RequestHistoryEventUndoSchema = z.object({
  reason: z.string().trim().max(500).nullable().optional(),
})
export type RequestHistoryEventUndo = z.infer<typeof RequestHistoryEventUndoSchema>

export const HistoryEventsQuerySchema = z.object({
  actorUserId: z.coerce.number().int().positive().optional(),
  beforeCreatedAt: z.string().optional(),
  entityId: z.string().trim().min(1).optional(),
  entityType: z.string().trim().min(1).optional(),
  eventType: z.string().trim().min(1).optional(),
  module: HeliosModuleCodeSchema.optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  scopeEntityId: z.string().trim().min(1).optional(),
  scopeEntityType: z.string().trim().min(1).optional(),
})
export type HistoryEventsQuery = z.infer<typeof HistoryEventsQuerySchema>

export const HistoryEventsResponseSchema = z.object({
  filters: HistoryEventsQuerySchema,
  items: z.array(AuditEventRecordSchema),
  nextCursor: z.string().nullable(),
})
export type HistoryEventsResponse = z.infer<typeof HistoryEventsResponseSchema>
