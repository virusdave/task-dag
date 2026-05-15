import { z } from 'zod'

import { JsonValueSchema } from '../common/json.js'
import { FieldPathSchema } from '../../domain/fieldPaths.js'
import { ApprovalStatusSchema, TargetEntityTypeSchema } from './proposals.js'

export const UndoableAuditEventTypeSchema = z.enum([
  'proposal.line_item.edited',
  'proposal.line_item.note_updated',
  'proposal.line_item.approved',
  'proposal.line_item.rejected',
])
export type UndoableAuditEventType = z.infer<typeof UndoableAuditEventTypeSchema>

export const ProposalLineItemEditedAuditPayloadSchema = z.object({
  approvalStatusAtEdit: ApprovalStatusSchema,
  catalogGroupId: z.number().int().positive(),
  fieldPath: FieldPathSchema,
  nextEditedValue: JsonValueSchema.nullable(),
  nextEffectiveValue: JsonValueSchema,
  nextVersion: z.number().int().positive(),
  previousEditedValue: JsonValueSchema.nullable(),
  previousEffectiveValue: JsonValueSchema,
  previousVersion: z.number().int().positive(),
  proposalLineItemId: z.number().int().positive(),
  targetEntityId: z.number().int().positive(),
  targetEntityType: TargetEntityTypeSchema,
})
export type ProposalLineItemEditedAuditPayload = z.infer<typeof ProposalLineItemEditedAuditPayloadSchema>

export const ProposalLineItemEditedUndoPayloadSchema = z.object({
  previousEditedValue: JsonValueSchema.nullable(),
  previousEffectiveValue: JsonValueSchema,
  previousVersion: z.number().int().positive(),
})
export type ProposalLineItemEditedUndoPayload = z.infer<typeof ProposalLineItemEditedUndoPayloadSchema>

export const ProposalLineItemNoteUpdatedAuditPayloadSchema = z.object({
  nextNote: z.string().nullable(),
  previousNote: z.string().nullable(),
  proposalLineItemId: z.number().int().positive(),
})
export type ProposalLineItemNoteUpdatedAuditPayload = z.infer<typeof ProposalLineItemNoteUpdatedAuditPayloadSchema>

export const ProposalLineItemNoteUpdatedUndoPayloadSchema = z.object({
  previousNote: z.string().nullable(),
})
export type ProposalLineItemNoteUpdatedUndoPayload = z.infer<typeof ProposalLineItemNoteUpdatedUndoPayloadSchema>

export const ProposalLineItemApprovalUndoPayloadSchema = z.object({
  previousApprovalStatus: ApprovalStatusSchema,
  previousApprovedByUserId: z.number().int().positive().nullable(),
  previousApprovalUpdatedAt: z.iso.datetime().nullable(),
  previousRejectedByUserId: z.number().int().positive().nullable(),
})
export type ProposalLineItemApprovalUndoPayload = z.infer<typeof ProposalLineItemApprovalUndoPayloadSchema>

export const ProposalLineItemApprovedAuditPayloadSchema = z.object({
  activatedDesiredStateRevisionId: z.number().int().positive(),
  catalogGroupId: z.number().int().positive(),
  fieldPath: FieldPathSchema,
  nextApprovalStatus: z.literal('approved'),
  nextApprovedByUserId: z.number().int().positive(),
  previousApprovalStatus: ApprovalStatusSchema,
  proposalLineItemId: z.number().int().positive(),
  supersededDesiredStateRevisionIds: z.array(z.number().int().positive()),
  targetEntityId: z.number().int().positive(),
  targetEntityType: TargetEntityTypeSchema,
})
export type ProposalLineItemApprovedAuditPayload = z.infer<typeof ProposalLineItemApprovedAuditPayloadSchema>

export const ProposalLineItemRejectedAuditPayloadSchema = z.object({
  catalogGroupId: z.number().int().positive(),
  deactivatedDesiredStateRevisionIds: z.array(z.number().int().positive()),
  fieldPath: FieldPathSchema,
  nextApprovalStatus: z.literal('rejected'),
  nextRejectedByUserId: z.number().int().positive(),
  previousApprovalStatus: ApprovalStatusSchema,
  proposalLineItemId: z.number().int().positive(),
  targetEntityId: z.number().int().positive(),
  targetEntityType: TargetEntityTypeSchema,
})
export type ProposalLineItemRejectedAuditPayload = z.infer<typeof ProposalLineItemRejectedAuditPayloadSchema>

const ProposalLineItemEditedUndoableAuditEventSchema = z.object({
  eventType: z.literal('proposal.line_item.edited'),
  payload: ProposalLineItemEditedAuditPayloadSchema,
  undoPayload: ProposalLineItemEditedUndoPayloadSchema,
})

const ProposalLineItemNoteUpdatedUndoableAuditEventSchema = z.object({
  eventType: z.literal('proposal.line_item.note_updated'),
  payload: ProposalLineItemNoteUpdatedAuditPayloadSchema,
  undoPayload: ProposalLineItemNoteUpdatedUndoPayloadSchema,
})

const ProposalLineItemApprovedUndoableAuditEventSchema = z.object({
  eventType: z.literal('proposal.line_item.approved'),
  payload: ProposalLineItemApprovedAuditPayloadSchema,
  undoPayload: ProposalLineItemApprovalUndoPayloadSchema,
})

const ProposalLineItemRejectedUndoableAuditEventSchema = z.object({
  eventType: z.literal('proposal.line_item.rejected'),
  payload: ProposalLineItemRejectedAuditPayloadSchema,
  undoPayload: ProposalLineItemApprovalUndoPayloadSchema,
})

export const UndoableAuditEventSchema = z.discriminatedUnion('eventType', [
  ProposalLineItemEditedUndoableAuditEventSchema,
  ProposalLineItemNoteUpdatedUndoableAuditEventSchema,
  ProposalLineItemApprovedUndoableAuditEventSchema,
  ProposalLineItemRejectedUndoableAuditEventSchema,
])
export type UndoableAuditEvent = z.infer<typeof UndoableAuditEventSchema>

export function isUndoableAuditEventType(eventType: string): eventType is UndoableAuditEventType {
  return UndoableAuditEventTypeSchema.safeParse(eventType).success
}

export function parseUndoableAuditEvent(input: {
  eventType: string
  payload: unknown
  undoPayload: unknown
}): UndoableAuditEvent {
  return UndoableAuditEventSchema.parse({
    eventType: UndoableAuditEventTypeSchema.parse(input.eventType),
    payload: input.payload,
    undoPayload: input.undoPayload,
  })
}
