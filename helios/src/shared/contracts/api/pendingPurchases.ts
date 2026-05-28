import { z } from 'zod'

import {
  PendingPurchaseApprovalStatusSchema,
  PendingPurchaseApplyRequestStatusSchema,
  PendingPurchaseApplyRequestSummarySchema,
  PendingPurchasePacketListItemSchema,
  PendingPurchasePacketSourceSchema,
  PendingPurchasePacketStatusSchema,
  PendingPurchasePacketSummarySchema,
  PendingPurchaseMappingStatusSchema,
  PendingPurchaseRowApplyStatusSchema,
  PendingPurchaseRowSchema,
} from '../domain/pendingPurchases.js'
import { JobStatusResponseSchema } from './jobs.js'

const BlankStringSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
  z.string().trim().min(1).optional(),
)

const BlankNumberSchema = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.coerce.number().int().positive().optional(),
)

export const PendingPurchaseRowRouteParamsSchema = z.object({
  rowId: z.coerce.number().int().positive(),
})
export type PendingPurchaseRowRouteParams = z.infer<typeof PendingPurchaseRowRouteParamsSchema>

const PendingPurchaseListModeSchema = z.enum(['packets', 'rows'])
export type PendingPurchaseListMode = z.infer<typeof PendingPurchaseListModeSchema>

export const PendingPurchaseListQuerySchema = z.object({
  actionType: BlankStringSchema,
  after: BlankStringSchema,
  applyStatus: z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
    PendingPurchaseRowApplyStatusSchema.optional(),
  ),
  approvalStatus: z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
    PendingPurchaseApprovalStatusSchema.optional(),
  ),
  before: BlankStringSchema,
  mappingStatus: z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
    PendingPurchaseMappingStatusSchema.optional(),
  ),
  mode: z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
    PendingPurchaseListModeSchema.optional(),
  ),
  packetId: BlankNumberSchema,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: BlankStringSchema,
  siteKey: BlankStringSchema,
  source: z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
    PendingPurchasePacketSourceSchema.optional(),
  ),
  status: z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
    PendingPurchasePacketStatusSchema.optional(),
  ),
})
export type PendingPurchaseListQuery = z.infer<typeof PendingPurchaseListQuerySchema>

export const PendingPurchaseListResponseSchema = z.object({
  activePacket: PendingPurchasePacketSummarySchema.nullable(),
  activeGenerationJob: JobStatusResponseSchema.nullable(),
  filters: PendingPurchaseListQuerySchema,
  hasNextPage: z.boolean(),
  items: z.array(PendingPurchaseRowSchema),
  latestApplyRequest: PendingPurchaseApplyRequestSummarySchema.nullable(),
  mode: PendingPurchaseListModeSchema,
  packets: z.array(PendingPurchasePacketListItemSchema),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
  totalCount: z.number().int().min(0),
})
export type PendingPurchaseListResponse = z.infer<typeof PendingPurchaseListResponseSchema>

export const QueuePendingPurchasePacketImportRequestSchema = z.object({
  filePath: z.string().trim().min(1).max(4096),
  reason: z.string().trim().max(500).nullable().optional(),
})
export type QueuePendingPurchasePacketImportRequest = z.infer<typeof QueuePendingPurchasePacketImportRequestSchema>

export const QueuePendingPurchasePacketGenerationRequestSchema = z
  .object({
    fromDate: z.iso.date(),
    reason: z.string().trim().max(500).nullable().optional(),
    siteDealerIds: z.array(z.coerce.number().int().positive()).default([]),
    toDate: z.iso.date(),
  })
  .refine((value) => value.fromDate <= value.toDate, 'fromDate must be on or before toDate.')
export type QueuePendingPurchasePacketGenerationRequest = z.infer<typeof QueuePendingPurchasePacketGenerationRequestSchema>

export const QueuePendingPurchaseApplyRequestSchema = z.object({
  packetId: z.number().int().positive(),
  reason: z.string().trim().max(500).nullable().optional(),
  rowIds: z.array(z.coerce.number().int().positive()).min(1).max(500),
})
export type QueuePendingPurchaseApplyRequest = z.infer<typeof QueuePendingPurchaseApplyRequestSchema>

export const UpdatePendingPurchaseRowApprovalRequestSchema = z.object({
  approvalStatus: PendingPurchaseApprovalStatusSchema,
  expectedVersion: z.number().int().positive(),
})
export type UpdatePendingPurchaseRowApprovalRequest = z.infer<typeof UpdatePendingPurchaseRowApprovalRequestSchema>

/**
 * Reviewer overrides for the LLM/parser-supplied structured taxonomy
 * on a pending-purchase row (issue #35).
 *
 * Every field is optional + nullable so the override payload is
 * sparse: a key being **present** means "the reviewer set this to
 * the given value" (including explicit `null` to clear); a key being
 * **absent** means "no override — fall back to the parsed value".
 *
 * Persisted as the JSONB column `pending_purchase_rows.edited_structured_fields`.
 * Read by `applyPendingPurchaseRequestJob` via the
 * `effectiveStructuredFields` helper, which mirrors how
 * `effective_proposed_price` / `effective_proposed_description` work
 * today for price / description / image overrides.
 */
export const EditedStructuredFieldsSchema = z
  .object({
    expectedCategory: z.string().trim().max(200).nullable().optional(),
    expectedSubcategory: z.string().trim().max(200).nullable().optional(),
    targetBrand: z.string().trim().max(200).nullable().optional(),
    targetGroupName: z.string().trim().max(500).nullable().optional(),
    targetPackCount: z.number().int().positive().max(1000).nullable().optional(),
    targetSize: z.string().trim().max(100).nullable().optional(),
    targetStrainName: z.string().trim().max(200).nullable().optional(),
    targetVariantName: z.string().trim().max(200).nullable().optional(),
    targetVariantTab: z.string().trim().max(200).nullable().optional(),
  })
  .strict()
export type EditedStructuredFields = z.infer<typeof EditedStructuredFieldsSchema>

export const UpdatePendingPurchaseRowRequestSchema = z
  .object({
    editedPrimaryImageUrl: z.string().trim().url().max(4096).nullable().optional(),
    editedProposedDescription: z.string().trim().max(20000).nullable().optional(),
    editedProposedPrice: z.number().finite().min(0).max(100000).nullable().optional(),
    /**
     * Sparse reviewer overrides for the 9 structured-taxonomy fields.
     *
     * `null` clears every override; an object replaces the entire
     * sparse override map (call sites that want to merge should do so
     * client-side before sending). Issue #35.
     */
    editedStructuredFields: EditedStructuredFieldsSchema.nullable().optional(),
    expectedVersion: z.number().int().positive(),
    notes: z.string().trim().max(5000).nullable().optional(),
  })
  .refine(
    (value) => (
      value.editedPrimaryImageUrl !== undefined ||
      value.editedProposedDescription !== undefined ||
      value.editedProposedPrice !== undefined ||
      value.editedStructuredFields !== undefined ||
      value.notes !== undefined
    ),
    'At least one pending-purchase field must be updated.',
  )
export type UpdatePendingPurchaseRowRequest = z.infer<typeof UpdatePendingPurchaseRowRequestSchema>
