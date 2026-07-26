import { z } from 'zod'

import { JsonValueSchema } from '../common/json.js'

export const PendingPurchasePacketSourceSchema = z.enum(['import', 'generated'])
export type PendingPurchasePacketSource = z.infer<typeof PendingPurchasePacketSourceSchema>

export const PendingPurchasePacketStatusSchema = z.enum(['ready', 'superseded'])
export type PendingPurchasePacketStatus = z.infer<typeof PendingPurchasePacketStatusSchema>

export const PendingPurchaseMappingStatusSchema = z.enum([
  'mapped_variant_ready_for_link',
  'needs_catalog_create',
  'needs_review',
])
export type PendingPurchaseMappingStatus = z.infer<typeof PendingPurchaseMappingStatusSchema>

export const PendingPurchaseApprovalStatusSchema = z.enum(['pending', 'approved', 'rejected'])
export type PendingPurchaseApprovalStatus = z.infer<typeof PendingPurchaseApprovalStatusSchema>

export const PendingPurchaseRowApplyStatusSchema = z.enum([
  'not_requested',
  'queued',
  'running',
  'applied',
  'failed',
  'blocked',
])
export type PendingPurchaseRowApplyStatus = z.infer<typeof PendingPurchaseRowApplyStatusSchema>

export const PendingPurchaseApplyRequestStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'partially_succeeded',
  'failed',
  'blocked',
])
export type PendingPurchaseApplyRequestStatus = z.infer<typeof PendingPurchaseApplyRequestStatusSchema>

export const PendingPurchasePacketRootStatusSchema = z.enum(['active', 'superseded', 'archived'])
export type PendingPurchasePacketRootStatus = z.infer<typeof PendingPurchasePacketRootStatusSchema>

export const PendingPurchasePacketRevisionStatusSchema = z.enum([
  'current',
  'candidate',
  'superseded',
  'failed',
])
export type PendingPurchasePacketRevisionStatus = z.infer<
  typeof PendingPurchasePacketRevisionStatusSchema
>

export const PendingPurchaseRefinementTurnStatusSchema = z.enum([
  'queued',
  'running',
  'candidate_created',
  'failed',
  'cancelled',
])
export type PendingPurchaseRefinementTurnStatus = z.infer<
  typeof PendingPurchaseRefinementTurnStatusSchema
>

export const PendingPurchaseRefinementFailureCodeSchema = z.enum([
  'configuration_unavailable',
  'smaller_scope',
  'stale_scope',
  'temporarily_unavailable',
  'unsafe_candidate',
])
export type PendingPurchaseRefinementFailureCode = z.infer<
  typeof PendingPurchaseRefinementFailureCodeSchema
>

export const PendingPurchasePacketRootSummarySchema = z.object({
  currentPacketId: z.number().int().positive().nullable(),
  currentRevisionNumber: z.number().int().positive().nullable(),
  packetRootId: z.number().int().positive(),
  rootKey: z.string().min(1),
  rootStatus: PendingPurchasePacketRootStatusSchema,
  updatedAt: z.iso.datetime(),
  version: z.number().int().positive(),
})
export type PendingPurchasePacketRootSummary = z.infer<
  typeof PendingPurchasePacketRootSummarySchema
>

export const PendingPurchasePacketRevisionSummarySchema = z.object({
  acceptedAt: z.iso.datetime().nullable(),
  acceptedByUser: z.string().nullable(),
  createdAt: z.iso.datetime(),
  isApplyable: z.boolean(),
  packetId: z.number().int().positive(),
  packetRootId: z.number().int().positive().nullable(),
  packetTitle: z.string().min(1),
  parentPacketId: z.number().int().positive().nullable(),
  revisionCreatedReason: z.string().nullable(),
  revisionNumber: z.number().int().positive().nullable(),
  revisionStatus: PendingPurchasePacketRevisionStatusSchema,
  sourceRefinementTurnId: z.number().int().positive().nullable(),
  updatedAt: z.iso.datetime(),
})
export type PendingPurchasePacketRevisionSummary = z.infer<
  typeof PendingPurchasePacketRevisionSummarySchema
>

export const PendingPurchaseRowSnapshotRefSchema = z.object({
  lineageRevisionNumber: z.number().int().positive().nullable(),
  rowId: z.number().int().positive(),
  rowLineageId: z.string().min(1).nullable(),
  rowSnapshotSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  version: z.number().int().positive(),
})
export type PendingPurchaseRowSnapshotRef = z.infer<typeof PendingPurchaseRowSnapshotRefSchema>

export const PendingPurchaseRefinementTurnSummarySchema = z.object({
  candidatePacketId: z.number().int().positive().nullable(),
  createdAt: z.iso.datetime(),
  errorMessage: z.string().nullable(),
  feedbackSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  feedbackText: z.string().max(20000).optional(),
  finishedAt: z.iso.datetime().nullable(),
  jobId: z.number().int().positive().nullable(),
  model: z.string().nullable(),
  packetRootId: z.number().int().positive(),
  promptContext: JsonValueSchema.optional(),
  promptVersion: z.string().nullable(),
  requestedByUser: z.string().nullable(),
  rowSnapshotSha256: z.string().regex(/^[0-9a-f]{64}$/),
  startedAt: z.iso.datetime().nullable(),
  status: PendingPurchaseRefinementTurnStatusSchema,
  targetPacketId: z.number().int().positive(),
  targetRevisionNumber: z.number().int().positive(),
  targetRootVersion: z.number().int().positive(),
  turnId: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
})
export type PendingPurchaseRefinementTurnSummary = z.infer<
  typeof PendingPurchaseRefinementTurnSummarySchema
>

export const PendingPurchaseRevisionRowDiffSchema = z.object({
  after: JsonValueSchema,
  before: JsonValueSchema,
  candidateRowId: z.number().int().positive(),
  field: z.string().min(1),
  parentRowId: z.number().int().positive(),
  rowLineageId: z.string().min(1),
})
export type PendingPurchaseRevisionRowDiff = z.infer<typeof PendingPurchaseRevisionRowDiffSchema>

export const PendingPurchaseOperatorNoteDocumentSchema = z.object({
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  hintDocumentId: z.string().min(1),
  sourceLabel: z.string().nullable(),
})
export type PendingPurchaseOperatorNoteDocument = z.infer<
  typeof PendingPurchaseOperatorNoteDocumentSchema
>

export const PendingPurchasePacketSummarySchema = z.object({
  createdAt: z.iso.datetime(),
  generatedAt: z.iso.datetime(),
  // True when this packet came from the prospective LLM classifier pipeline
  // (C8a) and therefore carries per-row 3-way (LLM vs parsekit vs legacy)
  // comparison records the "Purchase ETL Details" page (C8b, child epic
  // FreshlyBakedNYC/automation#54) can render. Derived cheaply from the
  // packet's `summary_json.classifier` provenance (written iff every row got
  // a `threeWayComparison`); false on legacy / imported packets so the ETL
  // details link only appears where there is data behind it.
  hasEtlDetails: z.boolean(),
  // The operator-note bundle attached when this packet was generated. The
  // packet detail uses this stable reference to make the original guidance
  // available again without copying its potentially-large text into every
  // packet response. Imported and generated-without-notes packets use null.
  hintBundleId: z.string().min(1).nullable(),
  importFileName: z.string().nullable(),
  // Immutable generation-time snapshot of the exact operator-note documents
  // consumed by the classifier. Refinements copy packet summary provenance,
  // so every revision keeps pointing at the same notes.
  // null identifies packets created before generation-time snapshots existed;
  // [] means a newer packet definitively consumed no operator notes.
  operatorNoteDocuments: z.array(PendingPurchaseOperatorNoteDocumentSchema).nullable(),
  packetId: z.number().int().positive(),
  packetTitle: z.string().min(1),
  rowCount: z.number().int().min(0),
  siteKeys: z.array(z.string()),
  siteLabels: z.array(z.string()),
  sourcePath: z.string().nullable(),
  source: PendingPurchasePacketSourceSchema,
  stateContext: JsonValueSchema,
  status: PendingPurchasePacketStatusSchema,
  summary: JsonValueSchema,
  updatedAt: z.iso.datetime(),
})
export type PendingPurchasePacketSummary = z.infer<typeof PendingPurchasePacketSummarySchema>

export const HeliosPendingPurchaseSiteDealerSchema = z.object({
  dealerId: z.number().int().positive(),
  dealerName: z.string().min(1),
  siteKey: z.string().min(1),
  siteLabel: z.string().min(1),
})
export type HeliosPendingPurchaseSiteDealer = z.infer<typeof HeliosPendingPurchaseSiteDealerSchema>

export const HELIOS_PENDING_PURCHASE_SITE_DEALERS = [
  {
    dealerId: 210249,
    dealerName: 'Freshly Baked NYC - The Bronx',
    siteKey: 'bronx',
    siteLabel: 'Bronx',
  },
  {
    dealerId: 210705,
    dealerName: 'Freshly Baked NYC - Midtown',
    siteKey: 'midtown',
    siteLabel: 'Midtown',
  },
] as const satisfies readonly HeliosPendingPurchaseSiteDealer[]

export function getHeliosPendingPurchaseSiteDealer(dealerId: number): HeliosPendingPurchaseSiteDealer | null {
  return HELIOS_PENDING_PURCHASE_SITE_DEALERS.find((dealer) => dealer.dealerId === dealerId) ?? null
}

export function normalizeHeliosPendingPurchaseSiteDealerIds(dealerIds: number[]): number[] {
  return [...new Set(dealerIds)]
    .filter((dealerId) => getHeliosPendingPurchaseSiteDealer(dealerId) !== null)
}

export const PendingPurchaseApprovalCountsSchema = z.object({
  approved: z.number().int().min(0),
  pending: z.number().int().min(0),
  rejected: z.number().int().min(0),
})
export type PendingPurchaseApprovalCounts = z.infer<typeof PendingPurchaseApprovalCountsSchema>

export const PendingPurchaseApplyCountsSchema = z.object({
  applied: z.number().int().min(0),
  blocked: z.number().int().min(0),
  failed: z.number().int().min(0),
  notRequested: z.number().int().min(0),
  queued: z.number().int().min(0),
  running: z.number().int().min(0),
})
export type PendingPurchaseApplyCounts = z.infer<typeof PendingPurchaseApplyCountsSchema>

export const PendingPurchaseApplyRequestSummarySchema = z.object({
  appliedRowCount: z.number().int().min(0),
  blockedRowCount: z.number().int().min(0),
  failedRowCount: z.number().int().min(0),
  finishedAt: z.iso.datetime().nullable(),
  jobId: z.number().int().positive().nullable(),
  packetId: z.number().int().positive(),
  requestId: z.number().int().positive(),
  requestedAt: z.iso.datetime(),
  requestedByUser: z.string().nullable(),
  selectedRowCount: z.number().int().min(0),
  startedAt: z.iso.datetime().nullable(),
  status: PendingPurchaseApplyRequestStatusSchema,
  summary: JsonValueSchema,
  summaryText: z.string().nullable(),
  updatedAt: z.iso.datetime(),
})
export type PendingPurchaseApplyRequestSummary = z.infer<typeof PendingPurchaseApplyRequestSummarySchema>

export const PendingPurchasePacketListItemSchema = PendingPurchasePacketSummarySchema.extend({
  applyCounts: PendingPurchaseApplyCountsSchema,
  approvalCounts: PendingPurchaseApprovalCountsSchema,
  latestApplyRequest: PendingPurchaseApplyRequestSummarySchema.nullable(),
})
export type PendingPurchasePacketListItem = z.infer<typeof PendingPurchasePacketListItemSchema>

export const PendingPurchaseSuggestionCandidateSchema = z.object({
  productId: z.number().int().positive().nullable(),
  productName: z.string().nullable(),
  score: z.number().nullable(),
})
export type PendingPurchaseSuggestionCandidate = z.infer<typeof PendingPurchaseSuggestionCandidateSchema>

// Per-row provenance from the prospective LLM classifier (C4) + deterministic
// reconciler (C5), persisted into `raw_row_json` by the generate job (C8) under
// the `llmClassification` key and surfaced read-only in the review UI (C6,
// child FreshlyBakedNYC/automation#54, parent virusdave/top-level#33).
//
// The model is a PROPOSER, never an authorizer: every field here is audit /
// review context only and is NEVER trusted for safety. The authoritative reuse
// link, normalized taxonomy, and deterministic review flags are the top-level
// row fields the apply job actually trusts (set by C5); this block only explains
// to a human reviewer *why* the pipeline landed where it did. It is absent on
// rows that never went through the LLM pipeline (legacy / imported packets),
// hence `PendingPurchaseRow.llmClassification` is nullable.
export const PendingPurchaseLlmClassificationSchema = z.object({
  // Audit provenance: which classifier/reconciler version + model produced this
  // row, for replay/debugging. Mirrors the result-level fields on
  // ReconcilePendingPurchaseDraftsResult.
  schemaVersion: z.number().int().nonnegative(),
  model: z.string(),
  promptVersion: z.string(),
  reconcilerVersion: z.string(),
  // The model's self-reported confidence in [0, 1].
  confidence: z.number().min(0).max(1),
  // Free-text model rationale for the classification, including why a reuse link
  // was proposed. Untrusted prose — display only.
  rationale: z.string(),
  // The C3 hint facts the model cited ("<hintDocumentId>#<factId>").
  citedHintIds: z.array(z.string()),
  // Model-emitted warning flags (e.g. new-brand / new-group / no-comps) the
  // reviewer should weigh. Distinct from the deterministic top-level
  // `reviewFlags` set by C5.
  warningFlags: z.array(z.string()),
})
export type PendingPurchaseLlmClassification = z.infer<
  typeof PendingPurchaseLlmClassificationSchema
>

export const PendingPurchaseMarketListingSchema = z.object({
  category: z.string().nullable(),
  distanceBand: z.enum(['near', 'mid', 'far', 'very_far', 'unknown']),
  distanceMiles: z.number().finite().nullable(),
  dispensaryName: z.string(),
  eligibleForPricing: z.boolean(),
  exclusionReason: z.string().nullable(),
  // Per-listing product image URL the LitAlerts partner API returns
  // on /v1/brands/:id/products (May 2026). Optional so evidence_json
  // rows captured before this field was wired through still parse.
  imageUrl: z.string().nullable().optional().default(null),
  listingName: z.string(),
  matchTier: z.enum(['exact', 'fallback', 'weak']),
  postTaxPrice: z.number().finite(),
  preTaxPrice: z.number().finite(),
  source: z.enum(['nearby', 'statewide']),
  url: z.string().nullable(),
})
export type PendingPurchaseMarketListing = z.infer<typeof PendingPurchaseMarketListingSchema>

// Mirrors `EditedStructuredFieldsSchema` from
// ./api/pendingPurchases.ts. Kept here as a separate (permissive)
// schema so the domain row schema doesn't need to reach back into
// the api/ layer. The api-side schema remains the strict server-side
// validator; this one only has to round-trip what the server stored
// without trusting / re-validating, since the loader already saw it.
const RowEditedStructuredFieldsSchema = z
  .object({
    expectedCategory: z.string().nullable().optional(),
    expectedSubcategory: z.string().nullable().optional(),
    targetBrand: z.string().nullable().optional(),
    targetGroupName: z.string().nullable().optional(),
    targetPackCount: z.number().int().nullable().optional(),
    // Reviewer-forced link to an existing Sweed product id; see
    // EditedStructuredFieldsSchema in ./api/pendingPurchases.ts for the
    // key-presence semantics (absent / positive int / null).
    targetReuseProductId: z.number().int().positive().nullable().optional(),
    targetSize: z.string().nullable().optional(),
    targetStrainName: z.string().nullable().optional(),
    targetVariantName: z.string().nullable().optional(),
    targetVariantTab: z.string().nullable().optional(),
  })
  .strict()

export const PendingPurchaseRowSchema = z.object({
  actionType: z.string().min(1),
  approvalStatus: PendingPurchaseApprovalStatusSchema,
  approvalUpdatedAt: z.iso.datetime().nullable(),
  averageCompetitorPostTaxPrice: z.number().nullable(),
  averageCompetitorPrice: z.number().nullable(),
  appliedAt: z.iso.datetime().nullable(),
  approvedByUser: z.string().nullable(),
  catalogAction: z.string().min(1),
  createdAt: z.iso.datetime(),
  currentDescription: z.string().nullable(),
  currentGmPercent: z.number().nullable(),
  currentPrice: z.number().nullable(),
  currentPriceBasis: z.string().nullable(),
  distributorProductId: z.string().min(1),
  distributorProductName: z.string().min(1),
  editedPrimaryImageUrl: z.string().nullable(),
  editedProposedDescription: z.string().nullable(),
  editedProposedPrice: z.number().nullable(),
  // Reviewer-authored sparse override of the structured taxonomy
  // (brand / group / category / subcategory / size / pack count /
  // variant name / variant tab / strain). `null` = no overrides at
  // all. See `EditedStructuredFieldsSchema` in
  // ./api/pendingPurchases.ts and migration 041. Issue #35.
  editedStructuredFields: RowEditedStructuredFieldsSchema.nullable().default(null),
  effectivePrimaryImageUrl: z.string().nullable(),
  effectiveProposedDescription: z.string().nullable(),
  effectiveProposedPrice: z.number().nullable(),
  effectiveUnitCost: z.number().nullable(),
  effectiveUnitCostSource: z.string().nullable(),
  expectedCategory: z.string().nullable(),
  expectedSubcategory: z.string().nullable(),
  existingDistributorLinks: z.string().nullable(),
  gmPercent: z.number().nullable(),
  lastApplyError: z.string().nullable(),
  lastApplyRequestId: z.number().int().positive().nullable(),
  lastApplyStatus: PendingPurchaseRowApplyStatusSchema,
  lastApplySummary: JsonValueSchema,
  // Read-only provenance from the prospective LLM classifier (C4) + reconciler
  // (C5); null on legacy / imported rows. Audit/review context only — never a
  // safety input. See PendingPurchaseLlmClassificationSchema.
  llmClassification: PendingPurchaseLlmClassificationSchema.nullable().default(null),
  marketDispensaryCount: z.number().int().min(0).nullable(),
  marketEligibleListingCount: z.number().int().min(0).nullable(),
  marketListingCount: z.number().int().min(0).nullable(),
  marketListings: z.array(PendingPurchaseMarketListingSchema),
  marketMedianPostTaxPrice: z.number().finite().nullable(),
  marketMedianPreTaxPrice: z.number().finite().nullable(),
  marketNote: z.string().nullable(),
  marketSearchTerm: z.string().nullable(),
  marketSource: z.enum(['nearby', 'statewide', 'mixed']).nullable(),
  mappingStatus: PendingPurchaseMappingStatusSchema,
  // Per-attribute "would be newly created in Sweed on apply" flags.
  // The reviewer needs these surfaced LOUDLY so a misparsed brand
  // (e.g., a strain-word like "Cherry" mistaken for a brand) doesn't
  // silently land in Sweed as a brand-new brand record.
  needsNewBrand: z.boolean().default(false),
  needsNewGroup: z.boolean().default(false),
  needsNewVariant: z.boolean().default(false),
  marketAdviceConfidence: z.string().nullable(),
  marketAdvicePosture: z.string().nullable(),
  marketAdviceSummary: z.string().nullable(),
  notes: z.string().nullable(),
  orderIds: z.array(z.number().int()),
  packetId: z.number().int().positive(),
  positionIds: z.array(z.number().int()),
  pricingAction: z.string().nullable(),
  pricingReason: z.string().nullable(),
  primaryImageNote: z.string().nullable(),
  primaryImageSource: z.string().nullable(),
  primaryImageUrl: z.string().nullable(),
  publicSources: z.array(z.string().min(1)),
  proposedDescription: z.string().nullable(),
  proposedPrice: z.number().nullable(),
  reuseGroupId: z.number().int().positive().nullable(),
  reuseProductId: z.number().int().positive().nullable(),
  reuseProductName: z.string().nullable(),
  reviewFlags: z.array(z.string()),
  reviewerNotes: z.string().nullable(),
  rowId: z.number().int().positive(),
  rowInputSignature: z.string().nullable(),
  rowLineageId: z.string().min(1).nullable().default(null),
  lineageRevisionNumber: z.number().int().positive().nullable().default(null),
  rowSnapshotSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  sampleLike: z.boolean(),
  siteDealerId: z.number().int().positive().nullable(),
  siteDealerName: z.string().nullable(),
  siteKey: z.string().min(1),
  siteLabel: z.string().min(1),
  suggestionCandidates: z.array(PendingPurchaseSuggestionCandidateSchema),
  targetBrand: z.string().nullable(),
  targetGroupName: z.string().nullable(),
  targetPackCount: z.number().int().positive().nullable(),
  targetPrevalence: z.string().nullable(),
  targetSize: z.string().nullable(),
  targetStrain: z.string().nullable(),
  targetVariantName: z.string().nullable(),
  targetVariantTab: z.string().nullable(),
  updatedAt: z.iso.datetime(),
  version: z.number().int().positive(),
})
export type PendingPurchaseRow = z.infer<typeof PendingPurchaseRowSchema>

// ── Purchase ETL Details (C8b, child epic FreshlyBakedNYC/automation#54) ─────
//
// Per-row 3-way comparison: the prospective LLM classifier's result (C4/C5)
// next to what the parsekit parser and the legacy hardcoded heuristics would
// have produced for the same distributor product name. Persisted by the
// generate job (C8a) under `raw_row_json.threeWayComparison` and surfaced,
// read-only, on the "Purchase ETL Details" page so operators can build
// confidence in the LLM path while parsekit + legacy keep running alongside.
//
// Every leg here is display / audit context only and is NEVER a safety input.
// The schemas are deliberately loose (no `.strict()`, string fields not forced
// non-empty) so they mirror exactly what the worker writes today and do not
// spuriously reject rows when C8a adds a field later. `parseThreeWayComparison`
// (server side) coerces a present-but-malformed blob into an explicit invalid
// marker rather than throwing, so one bad record can never brick the page.

// The normalized parsed-name shape both the parsekit and legacy legs emit on a
// successful parse. Mirrors the worker's `ParsedProductName`
// (helios/src/lib/parsekit/contracts/pendingPurchases.ts); `strainName` and
// `subcategory` may legitimately be empty strings, so they are NOT `.min(1)`.
export const PendingPurchaseParsedNameSchema = z.object({
  brand: z.string(),
  category: z.string(),
  groupName: z.string(),
  packCount: z.number(),
  prevalence: z.string().nullable(),
  searchTerm: z.string(),
  size: z.string(),
  strainName: z.string(),
  subcategory: z.string(),
  variantName: z.string(),
  variantTab: z.string(),
})
export type PendingPurchaseParsedName = z.infer<typeof PendingPurchaseParsedNameSchema>

// The LLM/reconciler leg. Fields mirror the reconciled classification the model
// proposed for this row, snapshotted BEFORE any operator pin override — so the
// row's top-level resolved `actionType` can legitimately differ from
// `llm.actionType` here (that divergence is itself an audit signal).
export const PendingPurchaseThreeWayComparisonLlmLegSchema = z.object({
  actionType: z.string(),
  targetBrand: z.string().nullable(),
  targetCategory: z.string().nullable(),
  targetSubcategory: z.string().nullable(),
  targetGroupName: z.string().nullable(),
  targetVariantName: z.string().nullable(),
  targetVariantTab: z.string().nullable(),
  targetStrainName: z.string().nullable(),
  targetSize: z.string().nullable(),
  targetPackCount: z.number().nullable(),
  reuseProductId: z.number().nullable(),
  reuseProductName: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  reviewFlags: z.array(z.string()),
  warningFlags: z.array(z.string()),
  citedHintIds: z.array(z.string()),
})
export type PendingPurchaseThreeWayComparisonLlmLeg = z.infer<
  typeof PendingPurchaseThreeWayComparisonLlmLegSchema
>

// The parsekit leg: the live parser being tuned. `ok` carries the parsed
// output; the other statuses record why parsekit produced nothing so the
// scorecard / audit reader can tell "wrong" from "not attempted".
export const PendingPurchaseThreeWayComparisonParsekitLegSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    output: PendingPurchaseParsedNameSchema,
    parserId: z.string(),
    ruleId: z.string(),
    snapshotSha: z.string(),
  }),
  z.object({
    status: z.literal('fail'),
    reason: z.string(),
    parserId: z.string(),
    snapshotSha: z.string(),
  }),
  z.object({
    status: z.literal('no_detect_match'),
    snapshotSha: z.string(),
  }),
  z.object({
    status: z.literal('no_registry'),
  }),
])
export type PendingPurchaseThreeWayComparisonParsekitLeg = z.infer<
  typeof PendingPurchaseThreeWayComparisonParsekitLegSchema
>

// The legacy hardcoded-waterfall leg: `ok` with output, or `error` with the
// thrown message when the legacy parser could not handle the name.
export const PendingPurchaseThreeWayComparisonLegacyLegSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    output: PendingPurchaseParsedNameSchema,
  }),
  z.object({
    status: z.literal('error'),
    error: z.string(),
  }),
])
export type PendingPurchaseThreeWayComparisonLegacyLeg = z.infer<
  typeof PendingPurchaseThreeWayComparisonLegacyLegSchema
>

export const PendingPurchaseThreeWayComparisonSchema = z.object({
  schemaVersion: z.literal(1),
  llm: PendingPurchaseThreeWayComparisonLlmLegSchema,
  parsekit: PendingPurchaseThreeWayComparisonParsekitLegSchema,
  legacy: PendingPurchaseThreeWayComparisonLegacyLegSchema,
})
export type PendingPurchaseThreeWayComparison = z.infer<
  typeof PendingPurchaseThreeWayComparisonSchema
>

// A present-but-unparseable comparison blob. Surfaced (not silently dropped)
// so a C8a writer bug is visible on the page as well as in the server logs;
// an ABSENT blob is instead handled by simply excluding the row server-side.
export const PendingPurchaseThreeWayComparisonInvalidSchema = z.object({
  status: z.literal('invalid'),
  schemaVersion: z.number().nullable(),
  error: z.string(),
})
export type PendingPurchaseThreeWayComparisonInvalid = z.infer<
  typeof PendingPurchaseThreeWayComparisonInvalidSchema
>

// One row on the ETL Details page: enough identity to orient the reviewer plus
// the row's resolved top-level action (which the operator pin may have moved
// away from `comparison.llm.actionType`) and the comparison itself.
export const PendingPurchaseEtlDetailRowSchema = z.object({
  rowId: z.number().int().positive(),
  distributorProductName: z.string().min(1),
  siteLabel: z.string().min(1),
  approvalStatus: PendingPurchaseApprovalStatusSchema,
  // The authoritative, post-reconcile (+ post-operator-pin) action stored on
  // the row. Shown next to `comparison.llm.actionType` to flag pin overrides.
  actionType: z.string().min(1),
  comparison: z.union([
    PendingPurchaseThreeWayComparisonSchema,
    PendingPurchaseThreeWayComparisonInvalidSchema,
  ]),
})
export type PendingPurchaseEtlDetailRow = z.infer<typeof PendingPurchaseEtlDetailRowSchema>
