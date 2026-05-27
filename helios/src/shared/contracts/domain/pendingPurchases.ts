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

export const PendingPurchasePacketSummarySchema = z.object({
  createdAt: z.iso.datetime(),
  generatedAt: z.iso.datetime(),
  importFileName: z.string().nullable(),
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

export const PendingPurchaseSuggestionCandidateSchema = z.object({
  productId: z.number().int().positive().nullable(),
  productName: z.string().nullable(),
  score: z.number().nullable(),
})
export type PendingPurchaseSuggestionCandidate = z.infer<typeof PendingPurchaseSuggestionCandidateSchema>

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
