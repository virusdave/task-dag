import { z } from 'zod'

import { JobStatusSchema } from '../domain/jobs.js'
import {
  PendingPurchaseApplyRequestStatusSchema,
  PendingPurchasePacketSourceSchema,
  PendingPurchasePacketStatusSchema,
} from '../domain/pendingPurchases.js'

export const CatalogHistoryQuerySchema = z.object({
  sectionLimit: z.coerce.number().int().min(1).max(25).default(8),
})
export type CatalogHistoryQuery = z.infer<typeof CatalogHistoryQuerySchema>

export const CatalogProposalBatchTypeSchema = z.enum(['description', 'pricing'])
export const CatalogProposalBatchSourceSchema = z.enum(['debug', 'generated', 'import'])
export const CatalogProposalBatchStatusSchema = z.enum(['draft', 'failed', 'ready', 'superseded'])
export const CatalogProposalBatchTriggerModeSchema = z.enum(['import', 'scheduled', 'ui'])

export const CatalogHistoryProposalBatchItemSchema = z.object({
  batchId: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  createdByUser: z.string().nullable(),
  generatedGroupCount: z.number().int().min(0).nullable(),
  generatedLineItemCount: z.number().int().min(0).nullable(),
  importFileName: z.string().nullable(),
  jobId: z.number().int().positive().nullable(),
  jobStatus: JobStatusSchema.nullable(),
  lineItemCount: z.number().int().min(0),
  requestedGroupCount: z.number().int().min(0).nullable(),
  rowCount: z.number().int().min(0),
  source: CatalogProposalBatchSourceSchema,
  sourcePath: z.string().nullable(),
  status: CatalogProposalBatchStatusSchema,
  summaryText: z.string().min(1),
  triggerMode: CatalogProposalBatchTriggerModeSchema,
  type: CatalogProposalBatchTypeSchema,
})
export type CatalogHistoryProposalBatchItem = z.infer<typeof CatalogHistoryProposalBatchItemSchema>

export const CatalogHistoryApprovalKindSchema = z.enum(['pending_purchase_row', 'proposal_line_item'])
export const CatalogHistoryApprovalDecisionSchema = z.enum(['approved', 'pending', 'rejected'])

export const CatalogHistoryApprovalItemSchema = z.object({
  actorLabel: z.string(),
  catalogGroupId: z.number().int().positive().nullable(),
  catalogGroupName: z.string().nullable(),
  createdAt: z.iso.datetime(),
  decision: CatalogHistoryApprovalDecisionSchema,
  eventId: z.number().int().positive(),
  fieldPath: z.string().nullable(),
  itemLabel: z.string().min(1),
  kind: CatalogHistoryApprovalKindSchema,
  packetId: z.number().int().positive().nullable(),
  packetTitle: z.string().nullable(),
  rowId: z.number().int().positive().nullable(),
  siteLabel: z.string().nullable(),
  summaryText: z.string().min(1),
})
export type CatalogHistoryApprovalItem = z.infer<typeof CatalogHistoryApprovalItemSchema>

export const CatalogWriteOperationTypeSchema = z.enum(['apply', 'undo'])
export const CatalogWriteOperationStatusSchema = z.enum(['failed', 'queued', 'running', 'succeeded', 'verified_mismatch'])

export const CatalogHistoryWriteOperationItemSchema = z.object({
  attemptCount: z.number().int().min(0),
  catalogGroupId: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  error: z.string().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  groupName: z.string().min(1),
  jobId: z.number().int().positive().nullable(),
  operationType: CatalogWriteOperationTypeSchema,
  startedAt: z.iso.datetime().nullable(),
  status: CatalogWriteOperationStatusSchema,
  summaryText: z.string().min(1),
  triggerActorLabel: z.string().nullable(),
  triggerEventId: z.number().int().positive().nullable(),
  triggerEventType: z.string().nullable(),
  writeOperationId: z.number().int().positive(),
})
export type CatalogHistoryWriteOperationItem = z.infer<typeof CatalogHistoryWriteOperationItemSchema>

export const CatalogHistoryPendingPurchasePacketItemSchema = z.object({
  createdAt: z.iso.datetime(),
  createdByUser: z.string().nullable(),
  generatedAt: z.iso.datetime(),
  importFileName: z.string().nullable(),
  jobId: z.number().int().positive().nullable(),
  jobStatus: JobStatusSchema.nullable(),
  packetId: z.number().int().positive(),
  packetTitle: z.string().min(1),
  rowCount: z.number().int().min(0),
  siteLabels: z.array(z.string()),
  source: PendingPurchasePacketSourceSchema,
  sourcePath: z.string().nullable(),
  status: PendingPurchasePacketStatusSchema,
  summaryText: z.string().min(1),
})
export type CatalogHistoryPendingPurchasePacketItem = z.infer<typeof CatalogHistoryPendingPurchasePacketItemSchema>

export const CatalogHistoryPendingPurchaseApplyItemSchema = z.object({
  appliedRowCount: z.number().int().min(0),
  blockedRowCount: z.number().int().min(0),
  failedRowCount: z.number().int().min(0),
  finishedAt: z.iso.datetime().nullable(),
  jobId: z.number().int().positive().nullable(),
  jobStatus: JobStatusSchema.nullable(),
  packetId: z.number().int().positive(),
  packetTitle: z.string().min(1),
  requestId: z.number().int().positive(),
  requestedAt: z.iso.datetime(),
  requestedByUser: z.string().nullable(),
  selectedRowCount: z.number().int().min(0),
  startedAt: z.iso.datetime().nullable(),
  status: PendingPurchaseApplyRequestStatusSchema,
  summaryText: z.string().min(1),
})
export type CatalogHistoryPendingPurchaseApplyItem = z.infer<typeof CatalogHistoryPendingPurchaseApplyItemSchema>

export const CatalogHistoryResponseSchema = z.object({
  approvalItems: z.array(CatalogHistoryApprovalItemSchema),
  filters: CatalogHistoryQuerySchema,
  pendingPurchaseApplyItems: z.array(CatalogHistoryPendingPurchaseApplyItemSchema),
  pendingPurchasePacketItems: z.array(CatalogHistoryPendingPurchasePacketItemSchema),
  proposalBatchItems: z.array(CatalogHistoryProposalBatchItemSchema),
  writeOperationItems: z.array(CatalogHistoryWriteOperationItemSchema),
})
export type CatalogHistoryResponse = z.infer<typeof CatalogHistoryResponseSchema>
