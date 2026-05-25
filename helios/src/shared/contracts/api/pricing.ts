import { z } from 'zod'

import { JsonValueSchema } from '../common/json.js'
import { MutationAcceptedResponseSchema } from './mutations.js'
import { JobStatusSchema } from '../domain/jobs.js'
import { ProposalLineItemSchema } from '../domain/proposals.js'
import { GroupRecentSalesProductRowSchema, RecentSalesSummarySchema } from './catalog.js'

const BlankNumberSchema = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.coerce.number().int().positive().optional(),
)

const BlankStringSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
  z.string().trim().min(1).optional(),
)

const BlankPricingRunStatusSchema = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.enum(['draft', 'failed', 'ready', 'superseded']).optional(),
)

const BlankPricingReviewApprovalStatusSchema = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.enum(['approved', 'pending', 'rejected']).optional(),
)

// Explicit boolean coercion that handles GET query strings safely
// (z.coerce.boolean() treats any non-empty string — including 'false'
// — as true).
const QueryBooleanSchema = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (value === true || value === false) {
    return value
  }
  if (typeof value === 'number') {
    return value !== 0
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'on', 'yes'].includes(normalized)) {
      return true
    }
    if (['false', '0', 'off', 'no'].includes(normalized)) {
      return false
    }
  }
  return value
}, z.boolean())

// Accepts:
//   undefined / null / ''  -> []
//   'foo'                  -> ['foo']
//   ['foo', 'bar', ' ']    -> ['foo', 'bar']  (trimmed, deduped)
// GET-form callers can repeat the param key (`?brands=foo&brands=bar`)
// or send a single value.
const QueryStringArraySchema = z.preprocess((value) => {
  if (value === undefined || value === null) {
    return []
  }
  const rawValues = Array.isArray(value) ? value : [value]
  const cleaned = rawValues
    .flatMap((item) => (typeof item === 'string' ? [item.trim()] : typeof item === 'number' ? [String(item)] : []))
    .filter((item) => item.length > 0)
  return [...new Set(cleaned)]
}, z.array(z.string().min(1)))

export const PricingSiteKeySchema = z.enum(['bronx', 'midtown'])
export type PricingSiteKey = z.infer<typeof PricingSiteKeySchema>

const QuerySiteArraySchema = z.preprocess((value) => {
  if (value === undefined || value === null) {
    return undefined
  }
  const rawValues = Array.isArray(value) ? value : [value]
  const cleaned = rawValues
    .flatMap((item) => (typeof item === 'string' ? [item.trim()] : []))
    .filter((item) => item.length > 0)
  return [...new Set(cleaned)]
}, z.array(PricingSiteKeySchema).default(['bronx', 'midtown']))

export const PricingRunScopeKindSchema = z.enum([
  'family_expansion_from_stock_or_pending',
  'full_catalog',
  'filtered_catalog',
  'explicit_selection',
  'single_product',
  'saved_profile',
])
export type PricingRunScopeKind = z.infer<typeof PricingRunScopeKindSchema>

export const PricingNewRunScopeKindSchema = z.enum([
  'family_expansion_from_stock_or_pending',
  'full_catalog',
  'filtered_catalog',
])
export type PricingNewRunScopeKind = z.infer<typeof PricingNewRunScopeKindSchema>

export const PricingRunTriggerSourceSchema = z.enum(['manual', 'rerun', 'scheduled'])
export type PricingRunTriggerSource = z.infer<typeof PricingRunTriggerSourceSchema>

export const PricingSelectionFiltersSchema = z.object({
  brands: QueryStringArraySchema,
  categories: QueryStringArraySchema,
  includePending: QueryBooleanSchema.default(true),
  search: BlankStringSchema,
  sites: QuerySiteArraySchema,
  stockOnly: QueryBooleanSchema.default(true),
  strict: QueryBooleanSchema.default(false),
  subcategories: QueryStringArraySchema,
})
export type PricingSelectionFilters = z.infer<typeof PricingSelectionFiltersSchema>

export const PricingScopePreviewQuerySchema = PricingSelectionFiltersSchema.extend({
  scopeKind: PricingNewRunScopeKindSchema.default('family_expansion_from_stock_or_pending'),
})
export type PricingScopePreviewQuery = z.infer<typeof PricingScopePreviewQuerySchema>

export const PricingFacetFieldSchema = z.enum(['brand', 'category', 'subcategory'])
export type PricingFacetField = z.infer<typeof PricingFacetFieldSchema>

export const PricingFacetsQuerySchema = PricingSelectionFiltersSchema.extend({
  facet: PricingFacetFieldSchema,
  facetSearch: BlankStringSchema,
  limit: z.coerce.number().int().min(1).max(500).default(200),
  scopeKind: PricingNewRunScopeKindSchema.default('family_expansion_from_stock_or_pending'),
})
export type PricingFacetsQuery = z.infer<typeof PricingFacetsQuerySchema>

export const PricingFacetOptionSchema = z.object({
  rowCount: z.number().int().min(0),
  selected: z.boolean(),
  value: z.string().min(1),
})
export type PricingFacetOption = z.infer<typeof PricingFacetOptionSchema>

export const PricingFacetsResponseSchema = z.object({
  facet: PricingFacetFieldSchema,
  filters: PricingFacetsQuerySchema,
  options: z.array(PricingFacetOptionSchema),
})
export type PricingFacetsResponse = z.infer<typeof PricingFacetsResponseSchema>

export const PricingScopePreviewGroupSchema = z.object({
  brandName: z.string().nullable(),
  catalogGroupId: z.number().int().positive(),
  categoryName: z.string().nullable(),
  groupName: z.string(),
  matchedProductCount: z.number().int().min(0),
  subcategoryName: z.string().nullable(),
})
export type PricingScopePreviewGroup = z.infer<typeof PricingScopePreviewGroupSchema>

export const PricingScopePreviewResponseSchema = z.object({
  filters: PricingScopePreviewQuerySchema,
  matchedCatalogGroupCount: z.number().int().min(0),
  matchedProductCount: z.number().int().min(0),
  previewGroups: z.array(PricingScopePreviewGroupSchema),
})
export type PricingScopePreviewResponse = z.infer<typeof PricingScopePreviewResponseSchema>

export const QueuePricingRunRequestSchema = PricingSelectionFiltersSchema.extend({
  forceLiveRefresh: QueryBooleanSchema.default(false),
  reason: z.string().trim().max(500).nullable().optional(),
  scopeKind: PricingNewRunScopeKindSchema.default('family_expansion_from_stock_or_pending'),
  scopeLabel: z.string().trim().max(240).nullable().optional(),
})
export type QueuePricingRunRequest = z.infer<typeof QueuePricingRunRequestSchema>

export const QueuePricingRunAcceptedResponseSchema = MutationAcceptedResponseSchema.extend({
  proposalBatchId: z.number().int().positive(),
})
export type QueuePricingRunAcceptedResponse = z.infer<typeof QueuePricingRunAcceptedResponseSchema>

export const PricingRunListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: BlankStringSchema,
  status: BlankPricingRunStatusSchema,
})
export type PricingRunListQuery = z.infer<typeof PricingRunListQuerySchema>

export const PricingRunMarketListingSchema = z.object({
  category: z.string().nullable(),
  distanceBand: z.enum(['near', 'mid', 'far', 'very_far', 'unknown']),
  distanceMiles: z.number().finite().nullable(),
  dispensaryName: z.string(),
  eligibleForPricing: z.boolean(),
  exclusionReason: z.string().nullable(),
  listingName: z.string(),
  matchTier: z.enum(['exact', 'fallback', 'weak']),
  postTaxPrice: z.number().finite(),
  preTaxPrice: z.number().finite(),
  source: z.enum(['nearby', 'statewide']),
  url: z.string().nullable(),
})
export type PricingRunMarketListing = z.infer<typeof PricingRunMarketListingSchema>

export const PricingRunMarketEvidenceSchema = z.object({
  averagePostTaxPrice: z.number().finite().nullable(),
  averagePreTaxPrice: z.number().finite().nullable(),
  dispensaryCount: z.number().int().min(0),
  farAveragePostTaxPrice: z.number().finite().nullable(),
  farAveragePreTaxPrice: z.number().finite().nullable(),
  farListingCount: z.number().int().min(0),
  listingCount: z.number().int().min(0),
  medianPostTaxPrice: z.number().finite().nullable(),
  medianPreTaxPrice: z.number().finite().nullable(),
  pricingEligibleDispensaryCount: z.number().int().min(0),
  pricingEligibleListingCount: z.number().int().min(0),
  matchedListings: z.array(PricingRunMarketListingSchema),
  searchTerm: z.string(),
  source: z.enum(['nearby', 'statewide', 'mixed']).nullable(),
})
export type PricingRunMarketEvidence = z.infer<typeof PricingRunMarketEvidenceSchema>

export const PricingRunGeneratedProductSchema = z.object({
  action: z.enum(['keep-price', 'lower-price', 'raise-price', 'set-price']),
  currentGmPercent: z.number().finite().nullable(),
  currentPrice: z.number().finite().nullable(),
  marketEvidence: PricingRunMarketEvidenceSchema.nullable(),
  priceReason: z.string(),
  productId: z.number().int().positive(),
  productName: z.string(),
  proposedGmPercent: z.number().finite().nullable(),
  proposedPrice: z.number().finite(),
  tab: z.string(),
  validationIssues: z.array(z.object({
    code: z.string(),
    detail: z.string(),
    severity: z.enum(['error', 'warning']),
  })),
  wholesaleCost: z.number().finite(),
})
export type PricingRunGeneratedProduct = z.infer<typeof PricingRunGeneratedProductSchema>

export const PricingRunSkippedProductSchema = z.object({
  currentPrice: z.number().finite().nullable(),
  marketEvidence: PricingRunMarketEvidenceSchema.nullable(),
  productId: z.number().int().positive(),
  productName: z.string(),
  reason: z.string(),
  tab: z.string(),
  wholesaleCost: z.number().finite().nullable(),
})
export type PricingRunSkippedProduct = z.infer<typeof PricingRunSkippedProductSchema>

export const PricingRunListItemSchema = z.object({
  batchId: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  createdByUser: z.string().nullable(),
  forceLiveRefresh: z.boolean(),
  generatedGroupCount: z.number().int().min(0).nullable(),
  generatedLineItemCount: z.number().int().min(0).nullable(),
  jobId: z.number().int().positive().nullable(),
  jobStatus: JobStatusSchema.nullable(),
  requestedGroupCount: z.number().int().min(0).nullable(),
  resolvedProductCount: z.number().int().min(0).nullable(),
  rowCount: z.number().int().min(0),
  scopeKind: PricingRunScopeKindSchema,
  scopeLabel: z.string(),
  skippedProductCount: z.number().int().min(0).nullable(),
  source: z.enum(['debug', 'generated', 'import']),
  status: z.enum(['draft', 'failed', 'ready', 'superseded']),
  summaryText: z.string(),
  triggerMode: z.enum(['import', 'scheduled', 'ui']),
  triggerSource: PricingRunTriggerSourceSchema,
})
export type PricingRunListItem = z.infer<typeof PricingRunListItemSchema>

export const PricingRunListResponseSchema = z.object({
  filters: PricingRunListQuerySchema,
  items: z.array(PricingRunListItemSchema),
  totalCount: z.number().int().min(0),
})
export type PricingRunListResponse = z.infer<typeof PricingRunListResponseSchema>

export const PricingRunRouteParamsSchema = z.object({
  proposalBatchId: z.coerce.number().int().positive(),
})
export type PricingRunRouteParams = z.infer<typeof PricingRunRouteParamsSchema>

export const PricingRunGroupSummarySchema = z.object({
  approvalCounts: z.object({
    approved: z.number().int().min(0),
    pending: z.number().int().min(0),
    rejected: z.number().int().min(0),
  }),
  brandName: z.string().nullable(),
  catalogGroupId: z.number().int().positive(),
  categoryName: z.string().nullable(),
  generatedProducts: z.array(PricingRunGeneratedProductSchema),
  groupName: z.string(),
  lineItemCount: z.number().int().min(0),
  marketAvailability: z.string().nullable(),
  marketNote: z.string().nullable(),
  proposalRowId: z.number().int().positive(),
  reviewItems: z.array(z.lazy(() => PricingReviewItemSchema)),
  rowTitle: z.string(),
  skippedProducts: z.array(PricingRunSkippedProductSchema),
  subcategoryName: z.string().nullable(),
})
export type PricingRunGroupSummary = z.infer<typeof PricingRunGroupSummarySchema>

export const PricingRunDetailResponseSchema = z.object({
  groups: z.array(PricingRunGroupSummarySchema),
  recentSalesIssue: z.string().nullable().optional(),
  run: PricingRunListItemSchema.extend({
    rawSummary: JsonValueSchema,
    selectionFilters: PricingSelectionFiltersSchema.nullable(),
  }),
  totals: z.object({
    approvedLineItemCount: z.number().int().min(0),
    generatedProductCount: z.number().int().min(0),
    groupCount: z.number().int().min(0),
    pendingLineItemCount: z.number().int().min(0),
    rejectedLineItemCount: z.number().int().min(0),
    skippedProductCount: z.number().int().min(0),
  }),
})
export type PricingRunDetailResponse = z.infer<typeof PricingRunDetailResponseSchema>

export const PricingReviewQuerySchema = z.object({
  approvalStatus: BlankPricingReviewApprovalStatusSchema,
  batchId: BlankNumberSchema,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  search: BlankStringSchema,
  showSuperseded: z.coerce.boolean().default(false),
})
export type PricingReviewQuery = z.infer<typeof PricingReviewQuerySchema>

export const PricingReviewItemSchema = z.object({
  batchCreatedAt: z.iso.datetime(),
  batchId: z.number().int().positive(),
  batchStatus: z.enum(['draft', 'failed', 'ready', 'superseded']),
  lineItem: ProposalLineItemSchema,
  pricingContext: z.object({
    action: z.enum(['keep-price', 'lower-price', 'raise-price', 'set-price']).nullable(),
    currentGmPercent: z.number().finite().nullable(),
    marketAverageLabel: z.string().nullable(),
    marketAveragePostTaxPrice: z.number().finite().nullable(),
    marketAveragePreTaxPrice: z.number().finite().nullable(),
    marketFarAveragePostTaxPrice: z.number().finite().nullable(),
    marketFarAveragePreTaxPrice: z.number().finite().nullable(),
    marketFarListingCount: z.number().int().min(0).nullable(),
    marketDispensaryCount: z.number().int().min(0).nullable(),
    marketEligibleListingCount: z.number().int().min(0).nullable(),
    marketListings: z.array(PricingRunMarketListingSchema),
    marketListingCount: z.number().int().min(0).nullable(),
    marketMedianPostTaxPrice: z.number().finite().nullable(),
    marketMedianPreTaxPrice: z.number().finite().nullable(),
    marketSource: z.enum(['nearby', 'statewide', 'mixed']).nullable(),
    priceReason: z.string().nullable(),
    productName: z.string().nullable(),
    proposedGmPercent: z.number().finite().nullable(),
    proposedPrice: z.number().finite().nullable(),
    recentSales: z.object({
      sites: z.array(GroupRecentSalesProductRowSchema),
      summary: RecentSalesSummarySchema,
    }),
    scopeLabel: z.string(),
    tab: z.string().nullable(),
    wholesaleCost: z.number().finite().nullable(),
  }),
})
export type PricingReviewItem = z.infer<typeof PricingReviewItemSchema>

export const PricingReviewResponseSchema = z.object({
  filters: PricingReviewQuerySchema,
  items: z.array(PricingReviewItemSchema),
  recentSalesIssue: z.string().nullable().optional(),
  totalCount: z.number().int().min(0),
})
export type PricingReviewResponse = z.infer<typeof PricingReviewResponseSchema>
