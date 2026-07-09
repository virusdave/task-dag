import { z } from 'zod'

import {
  PendingPurchaseApprovalStatusSchema,
  PendingPurchaseApplyRequestStatusSchema,
  PendingPurchaseApplyRequestSummarySchema,
  PendingPurchaseEtlDetailRowSchema,
  PendingPurchasePacketRevisionSummarySchema,
  PendingPurchasePacketRootSummarySchema,
  PendingPurchasePacketListItemSchema,
  PendingPurchasePacketSourceSchema,
  PendingPurchasePacketStatusSchema,
  PendingPurchasePacketSummarySchema,
  PendingPurchaseMappingStatusSchema,
  PendingPurchaseRefinementTurnSummarySchema,
  PendingPurchaseRevisionRowDiffSchema,
  PendingPurchaseRowSnapshotRefSchema,
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

// Purchase ETL Details page (C8b, child epic FreshlyBakedNYC/automation#54):
// GET /api/catalog/pending-purchases/:packetId/etl-details.
export const PendingPurchaseEtlDetailsRouteParamsSchema = z.object({
  packetId: z.coerce.number().int().positive(),
})
export type PendingPurchaseEtlDetailsRouteParams = z.infer<
  typeof PendingPurchaseEtlDetailsRouteParamsSchema
>

export const PendingPurchaseEtlDetailsResponseSchema = z.object({
  packet: PendingPurchasePacketSummarySchema,
  rows: z.array(PendingPurchaseEtlDetailRowSchema),
})
export type PendingPurchaseEtlDetailsResponse = z.infer<
  typeof PendingPurchaseEtlDetailsResponseSchema
>

export const PendingPurchasePacketRouteParamsSchema = z.object({
  packetId: z.coerce.number().int().positive(),
})
export type PendingPurchasePacketRouteParams = z.infer<typeof PendingPurchasePacketRouteParamsSchema>

export const PendingPurchaseRefinementTurnRouteParamsSchema = z.object({
  turnId: z.coerce.number().int().positive(),
})
export type PendingPurchaseRefinementTurnRouteParams = z.infer<
  typeof PendingPurchaseRefinementTurnRouteParamsSchema
>

export const SubmitPendingPurchaseRefinementRequestSchema = z.object({
  baseRows: z.array(PendingPurchaseRowSnapshotRefSchema).min(1).max(500),
  expectedRootVersion: z.number().int().positive(),
  feedbackText: z.string().trim().min(1).max(20000),
})
export type SubmitPendingPurchaseRefinementRequest = z.infer<
  typeof SubmitPendingPurchaseRefinementRequestSchema
>

export const SubmitPendingPurchaseRefinementResponseSchema = z.object({
  turn: PendingPurchaseRefinementTurnSummarySchema,
})
export type SubmitPendingPurchaseRefinementResponse = z.infer<
  typeof SubmitPendingPurchaseRefinementResponseSchema
>

export const PendingPurchaseRefinementHistoryResponseSchema = z.object({
  currentRevision: PendingPurchasePacketRevisionSummarySchema.nullable(),
  rowDiffs: z.array(PendingPurchaseRevisionRowDiffSchema),
  root: PendingPurchasePacketRootSummarySchema.nullable(),
  revisions: z.array(PendingPurchasePacketRevisionSummarySchema),
  turns: z.array(PendingPurchaseRefinementTurnSummarySchema),
})
export type PendingPurchaseRefinementHistoryResponse = z.infer<
  typeof PendingPurchaseRefinementHistoryResponseSchema
>

export const SwitchPendingPurchaseRevisionRequestSchema = z.object({
  expectedRootVersion: z.number().int().positive(),
  reason: z.string().trim().max(500).nullable().optional(),
})
export type SwitchPendingPurchaseRevisionRequest = z.infer<
  typeof SwitchPendingPurchaseRevisionRequestSchema
>

export const SwitchPendingPurchaseRevisionResponseSchema = z.object({
  previousCurrentRevision: PendingPurchasePacketRevisionSummarySchema.nullable(),
  root: PendingPurchasePacketRootSummarySchema,
  selectedRevision: PendingPurchasePacketRevisionSummarySchema,
})
export type SwitchPendingPurchaseRevisionResponse = z.infer<
  typeof SwitchPendingPurchaseRevisionResponseSchema
>

// Explicit aliases for the two revision-switching actions. Both carry the same
// optimistic root-version guard, but routes/audit copy should keep the operator
// intent distinct: accepting a candidate makes a newly generated revision
// current; rollback switches back to an earlier safe revision.
export const AcceptPendingPurchaseCandidateRequestSchema = SwitchPendingPurchaseRevisionRequestSchema
export type AcceptPendingPurchaseCandidateRequest = SwitchPendingPurchaseRevisionRequest

export const AcceptPendingPurchaseCandidateResponseSchema = SwitchPendingPurchaseRevisionResponseSchema
export type AcceptPendingPurchaseCandidateResponse = SwitchPendingPurchaseRevisionResponse

export const RollbackPendingPurchaseRevisionRequestSchema = SwitchPendingPurchaseRevisionRequestSchema
export type RollbackPendingPurchaseRevisionRequest = SwitchPendingPurchaseRevisionRequest

export const RollbackPendingPurchaseRevisionResponseSchema = SwitchPendingPurchaseRevisionResponseSchema
export type RollbackPendingPurchaseRevisionResponse = SwitchPendingPurchaseRevisionResponse

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

// Distinct catalog values used to back the reviewer-facing structured-
// override dropdowns (brand / category / subcategory). Source: the
// existing `catalog_groups` table — same facets the /catalog/browser
// rail uses, just re-shaped for the override surface.
//
// Only populated when `mode === 'rows'` (the reviewer is on a packet
// detail view and can actually edit overrides). On the packet archive
// view we leave it null to avoid a wasted scan per page-load.
export const PendingPurchaseStructuredOverrideOptionsSchema = z.object({
  brands: z.array(z.string()),
  categories: z.array(z.string()),
  subcategories: z.array(z.string()),
})
export type PendingPurchaseStructuredOverrideOptions = z.infer<
  typeof PendingPurchaseStructuredOverrideOptionsSchema
>

export const PendingPurchaseListResponseSchema = z.object({
  activePacket: PendingPurchasePacketSummarySchema.nullable(),
  activeGenerationJob: JobStatusResponseSchema.nullable(),
  filters: PendingPurchaseListQuerySchema,
  hasNextPage: z.boolean(),
  items: z.array(PendingPurchaseRowSchema),
  latestApplyRequest: PendingPurchaseApplyRequestSummarySchema.nullable(),
  mode: PendingPurchaseListModeSchema,
  overrideOptions: PendingPurchaseStructuredOverrideOptionsSchema.nullable(),
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
    // When set, only the single outstanding purchase order whose Sweed
    // name/number (or numeric id) matches is run through the pending-purchase
    // flow; every other outstanding order in the date range is skipped.
    purchaseOrderNumber: z.string().trim().min(1).max(100).nullable().optional(),
    reason: z.string().trim().max(500).nullable().optional(),
    siteDealerIds: z.array(z.coerce.number().int().positive()).default([]),
    toDate: z.iso.date(),
    // Optional prospective-classifier hint bundle (child epic #54, C2). When
    // set, the generate run is scoped to this operator-curated bundle of
    // untrusted hint material; the route validates it exists + is active and
    // threads it into the job payload + dedupe key. v1 = pasted text only.
    hintBundleId: z
      .string()
      .trim()
      .regex(/^pphint_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}_[0-9a-f]{6}$/, 'invalid hint bundle id')
      .nullable()
      .optional(),
  })
  .refine((value) => value.fromDate <= value.toDate, 'fromDate must be on or before toDate.')
export type QueuePendingPurchasePacketGenerationRequest = z.infer<typeof QueuePendingPurchasePacketGenerationRequestSchema>

export const QueuePendingPurchaseApplyRequestSchema = z.object({
  packetId: z.number().int().positive(),
  reason: z.string().trim().max(500).nullable().optional(),
  rowIds: z.array(z.coerce.number().int().positive()).min(1).max(500),
  // C7: opt in to enqueue a Lit Alerts market-data refresh for the products the
  // apply CREATES this run (best-effort). Default false → unchanged behavior.
  enqueueMarketRefreshForCreatedProducts: z.boolean().default(false),
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
    /**
     * Reviewer-forced link to an existing Sweed product (variant) id.
     * Three states (key-presence semantics, NOT `??`):
     *   - key absent: fall back to the parser-derived
     *     `raw_row_json.reuseProductId` (the legacy behavior).
     *   - positive integer: override the parser; apply MUST link the
     *     pending row to this exact Sweed product and MUST NOT rewrite
     *     the product's identity fields (name / shortName / tab /
     *     packOfSize / sizeId / strainId / group name) from the
     *     parser's text. This is the "operator already found the
     *     right existing variant; just link to it" path.
     *   - null: clear / disable any generator-proposed reuse for this
     *     row (apply will fall through to the catalog-create branch).
     */
    targetReuseProductId: z.number().int().positive().nullable().optional(),
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

/**
 * Family-level (bulk) structured override (issue: reviewer needs to
 * mass-fix a mis-parsed structured field — e.g. Brand — across every
 * row of a family in one save instead of editing/saving each row
 * sequentially).
 *
 * Unlike the per-row PATCH (which FULL-replaces the override map), the
 * batch endpoint MERGES `structuredOverride` into each row's existing
 * `edited_structured_fields`: a key present (including explicit `null`
 * to clear-at-apply) sets that field; an absent key leaves the row's
 * existing override for that field untouched. This keeps unrelated
 * per-row overrides (size, variant, …) intact when the reviewer only
 * means to fix one field for the whole family.
 */
export const BatchPendingPurchaseFamilyOverrideRequestSchema = z.object({
  packetId: z.number().int().positive(),
  reason: z.string().trim().max(500).nullable().optional(),
  rowIds: z.array(z.coerce.number().int().positive()).min(1).max(500),
  structuredOverride: EditedStructuredFieldsSchema.refine(
    (value) => Object.keys(value).length > 0,
    'At least one structured override field is required.',
  ),
})
export type BatchPendingPurchaseFamilyOverrideRequest = z.infer<typeof BatchPendingPurchaseFamilyOverrideRequestSchema>

export const BatchPendingPurchaseFamilyOverrideResponseSchema = z.object({
  requestId: z.string(),
  skippedRows: z.array(
    z.object({
      reason: z.enum(['approved', 'apply_locked', 'no_change']),
      rowId: z.number().int().positive(),
    }),
  ),
  updatedRowIds: z.array(z.number().int().positive()),
})
export type BatchPendingPurchaseFamilyOverrideResponse = z.infer<typeof BatchPendingPurchaseFamilyOverrideResponseSchema>

/**
 * Reviewer-facing live Sweed variant picker (powering the
 * `targetReuseProductId` link-override on a pending-purchase row).
 *
 * Caller passes the row's site dealer id + a free-text query (or a
 * numeric Sweed product id pasted directly). The server proxies a
 * single `store.product.list.short` and enriches the top hits with
 * `store.product.get` + `store.product.group.get` so the reviewer
 * can verify their pick before committing.
 */
export const SweedVariantSearchQuerySchema = z.object({
  /** Sweed state-dealer id (one of HELIOS_PENDING_PURCHASE_SITE_DEALERS). */
  siteDealerId: z.coerce.number().int().positive(),
  /** Free-text query OR an exact numeric Sweed product id. */
  q: z.string().trim().min(1).max(200),
})
export type SweedVariantSearchQuery = z.infer<typeof SweedVariantSearchQuerySchema>

export const SweedVariantSearchHitSchema = z.object({
  productId: z.number().int().positive(),
  productName: z.string(),
  shortName: z.string().nullable(),
  tab: z.string().nullable(),
  packOfSize: z.number().int().min(0).nullable(),
  sizeName: z.string().nullable(),
  price: z.number().nullable(),
  imageUrl: z.string().nullable(),
  groupId: z.number().int().positive().nullable(),
  groupName: z.string().nullable(),
  brandName: z.string().nullable(),
  categoryName: z.string().nullable(),
  subcategoryName: z.string().nullable(),
  strainName: z.string().nullable(),
  /**
   * True when the candidate is `enabled: false` in Sweed, or its
   * name starts with one of the DEAD-marker prefixes per
   * `helios/AGENTS.md`. UI should grey these out / require explicit
   * confirmation before letting the reviewer pick them.
   */
  isDisabled: z.boolean(),
})
export type SweedVariantSearchHit = z.infer<typeof SweedVariantSearchHitSchema>

export const SweedVariantSearchResponseSchema = z.object({
  hits: z.array(SweedVariantSearchHitSchema),
  totalCount: z.number().int().min(0),
  /** Echoed back so the client can correlate stale async responses. */
  query: SweedVariantSearchQuerySchema,
})
export type SweedVariantSearchResponse = z.infer<typeof SweedVariantSearchResponseSchema>
