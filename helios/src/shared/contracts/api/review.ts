import { z } from 'zod'

import { JsonValueSchema } from '../common/json.js'
import { PendingPurchaseMarketListingSchema } from '../domain/pendingPurchases.js'
import {
  ApprovalStatusSchema,
  ProposalLineItemSchema,
  ProposalTypeSchema,
  TargetEntityTypeSchema,
  ValidationIssueSchema,
} from '../domain/proposals.js'
import { FieldPathSchema } from '../../domain/fieldPaths.js'

const BlankStringSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
  z.string().trim().min(1).optional(),
)

const BlankApprovalStatusSchema = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.enum(['pending', 'approved', 'rejected']).optional(),
)

const BlankProposalTypeSchema = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  ProposalTypeSchema.optional(),
)

export const ReviewLineItemListQuerySchema = z.object({
  approvalStatus: BlankApprovalStatusSchema,
  batchStatus: BlankStringSchema,
  driftOnly: z.coerce.boolean().optional(),
  hasValidationIssues: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  proposalType: BlankProposalTypeSchema,
  search: BlankStringSchema,
})
export type ReviewLineItemListQuery = z.infer<typeof ReviewLineItemListQuerySchema>

export const ReviewLineItemListResponseSchema = z.object({
  batchSummary: z.object({
    batchId: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    status: z.string(),
    type: z.string(),
  }).nullable(),
  filters: ReviewLineItemListQuerySchema,
  items: z.array(ProposalLineItemSchema),
  totalCount: z.number().int().min(0),
})
export type ReviewLineItemListResponse = z.infer<typeof ReviewLineItemListResponseSchema>

export const EditProposalLineItemRequestSchema = z.object({
  editedValue: JsonValueSchema.nullable(),
  expectedVersion: z.number().int().positive(),
})
export type EditProposalLineItemRequest = z.infer<typeof EditProposalLineItemRequestSchema>

export const UpdateProposalLineItemNoteRequestSchema = z.object({
  note: z.string().trim().max(5000).nullable(),
})
export type UpdateProposalLineItemNoteRequest = z.infer<typeof UpdateProposalLineItemNoteRequestSchema>

export const ApproveProposalLineItemRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
})
export type ApproveProposalLineItemRequest = z.infer<typeof ApproveProposalLineItemRequestSchema>

export const RejectProposalLineItemRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
})
export type RejectProposalLineItemRequest = z.infer<typeof RejectProposalLineItemRequestSchema>

/* ------------------------------------------------------------------ */
/* Family-grouped review queue (issue #15 — canonical product-review row) */
/* ------------------------------------------------------------------ */

/**
 * Phase A (top-level#16) pagination defaults/caps. The page is keyset
 * (cursor) based, NOT offset based, so the whole queue is never scanned
 * or JSON-cracked per request. `familyKeyVersion` is carried in the
 * cursor so Phase B can change family-key semantics (add `sizeName`)
 * without breaking in-flight cursors.
 */
export const REVIEW_FAMILY_KEY_VERSION = 1
export const REVIEW_DEFAULT_FAMILY_LIMIT = 12
export const REVIEW_MAX_FAMILY_LIMIT = 25
export const REVIEW_MAX_LINE_ITEMS_PER_PAGE = 250

export const ReviewFamilyQueueQuerySchema = z.object({
  approvalStatus: BlankApprovalStatusSchema,
  driftOnly: z.coerce.boolean().optional(),
  proposalType: BlankProposalTypeSchema,
  search: BlankStringSchema,
  limit: z.coerce.number().int().min(1).max(REVIEW_MAX_FAMILY_LIMIT).default(REVIEW_DEFAULT_FAMILY_LIMIT),
  cursor: BlankStringSchema,
})
export type ReviewFamilyQueueQuery = z.infer<typeof ReviewFamilyQueueQuerySchema>

export const ReviewFamilyKeySchema = z.object({
  brand: z.string().nullable(),
  category: z.string().nullable(),
  subcategory: z.string().nullable(),
  sizeName: z.string().nullable(),
})
export type ReviewFamilyKey = z.infer<typeof ReviewFamilyKeySchema>

export const ReviewFieldComparisonSchema = z.object({
  lineItemId: z.number().int().positive(),
  fieldPath: FieldPathSchema,
  label: z.string(),
  liveValueText: z.string(),
  proposedValueText: z.string(),
  effectiveValueText: z.string(),
  changeKind: z.enum(['pricing', 'description', 'taxonomy', 'attribute', 'other']),
  approvalStatus: ApprovalStatusSchema,
})
export type ReviewFieldComparison = z.infer<typeof ReviewFieldComparisonSchema>

export const ReviewRowLineItemHandleSchema = z.object({
  lineItemId: z.number().int().positive(),
  fieldPath: FieldPathSchema,
  version: z.number().int().positive(),
  approvalStatus: ApprovalStatusSchema,
  editedValue: JsonValueSchema.nullable(),
  suggestedValue: JsonValueSchema,
  baselineValue: JsonValueSchema,
})
export type ReviewRowLineItemHandle = z.infer<typeof ReviewRowLineItemHandleSchema>

export const ReviewRowPricingLadderSchema = z.object({
  productId: z.number().int().positive(),
  livePrice: z.number().nullable(),
  proposedPrice: z.number().nullable(),
  marketAveragePostTax: z.number().nullable(),
  marketMedianPostTax: z.number().nullable(),
  competitorListings: z.array(PendingPurchaseMarketListingSchema),
  evidenceFreshness: z.enum(['fresh', 'stale', 'very_stale', 'expired', 'absent']),
  evidenceCapturedAt: z.iso.datetime().nullable(),
  /** Largest absolute deviation between any eligible listing and the live price. */
  priceSpread: z.number().nullable(),
})
export type ReviewRowPricingLadder = z.infer<typeof ReviewRowPricingLadderSchema>

export const ReviewRowSchema = z.object({
  catalogGroupId: z.number().int().positive(),
  proposalRowId: z.number().int().positive(),
  rowTitle: z.string(),
  reconcileStatus: z.string(),
  approvalRollup: z.enum(['pending', 'approved', 'rejected', 'mixed']),
  targetEntityId: z.number().int().positive(),
  targetEntityType: TargetEntityTypeSchema,
  comparisons: z.array(ReviewFieldComparisonSchema),
  pricingLadder: ReviewRowPricingLadderSchema.nullable(),
  validationIssues: z.array(ValidationIssueSchema),
  operatorNote: z.string().nullable(),
  lineItems: z.array(ReviewRowLineItemHandleSchema),
})
export type ReviewRow = z.infer<typeof ReviewRowSchema>

export const ReviewFamilyOrderingSchema = z.object({
  driftedRowCount: z.number().int().min(0),
  maxPriceSpread: z.number().nullable(),
})
export type ReviewFamilyOrdering = z.infer<typeof ReviewFamilyOrderingSchema>

export const ReviewFamilySchema = z.object({
  familyKey: ReviewFamilyKeySchema,
  ordering: ReviewFamilyOrderingSchema,
  rows: z.array(ReviewRowSchema),
})
export type ReviewFamily = z.infer<typeof ReviewFamilySchema>

export const ReviewFamilyQueueOversizedFamilySchema = z.object({
  familyKey: z.object({
    brand: z.string().nullable(),
    category: z.string().nullable(),
    subcategory: z.string().nullable(),
  }),
  lineItemCount: z.number().int().positive(),
})
export type ReviewFamilyQueueOversizedFamily = z.infer<typeof ReviewFamilyQueueOversizedFamilySchema>

export const ReviewFamilyQueuePageInfoSchema = z.object({
  familyKeyVersion: z.literal(REVIEW_FAMILY_KEY_VERSION),
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
  familyLimit: z.number().int().positive(),
  maxLineItemsPerPage: z.number().int().positive(),
  returnedFamilyCount: z.number().int().min(0),
  returnedLineItemCount: z.number().int().min(0),
  /** True when an item-cap or oversized-family guard cut the page short. */
  truncatedByItemCap: z.boolean(),
  /** Set when a single family exceeded the item cap and was returned alone. */
  oversizedFamily: ReviewFamilyQueueOversizedFamilySchema.nullable(),
})
export type ReviewFamilyQueuePageInfo = z.infer<typeof ReviewFamilyQueuePageInfoSchema>

export const ReviewFamilyQueueResponseSchema = z.object({
  filters: ReviewFamilyQueueQuerySchema,
  families: z.array(ReviewFamilySchema),
  /** Count of pending ReviewRows across the WHOLE filtered queue (not just this page). */
  totalRowCount: z.number().int().min(0),
  /** Count of families across the WHOLE filtered queue (not just this page). */
  totalFamilyCount: z.number().int().min(0),
  pageInfo: ReviewFamilyQueuePageInfoSchema,
})
export type ReviewFamilyQueueResponse = z.infer<typeof ReviewFamilyQueueResponseSchema>
