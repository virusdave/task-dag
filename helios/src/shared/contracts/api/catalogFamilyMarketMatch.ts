import { z } from 'zod'

// ---------------------------------------------------------------------------
// Brand-categorical-family market-match audit (issue #58, task T2).
//
// A DIAGNOSTIC surface, not a pricing view: for one brand-categorical-family
// (brand + category + subcategory + size-group + pack) it shows the LitAlerts
// partner_product listings the REAL matcher associates with the family AND how
// it scored them (score + per-factor breakdown), so the operator can judge
// matcher/data quality. Fetched lazily per family on expand. Known data caveats
// (stale snapshot, duplicate rows, NULL pack/subcategory on partner rows, brand
// mapping state, derived prices) are SURFACED here, never gated out.
// ---------------------------------------------------------------------------

export const BrandFamilyMatchFactorsSchema = z.object({
  brand: z.number(),
  category: z.number(),
  subcategory: z.number(),
  size: z.number(),
  pack: z.number(),
  strain: z.number(),
  nameOverlap: z.number(),
})
export type BrandFamilyMatchFactors = z.infer<typeof BrandFamilyMatchFactorsSchema>

export const BrandFamilyDistanceBandSchema = z.enum(['near', 'mid', 'far', 'very_far', 'unknown'])
export type BrandFamilyDistanceBand = z.infer<typeof BrandFamilyDistanceBandSchema>

// ---------------------------------------------------------------------------
// Price-outlier review signal (issue #59, task T1).
//
// A REVIEW SIGNAL ONLY: outliers are never removed, down-ranked, or reordered.
// Stats are computed with Tukey IQR fences (widened by a conservative
// tight-cluster guard) over ONLY the above-threshold, same-hard-gated-family,
// finite-priced candidates, over the FULL scored set BEFORE the display cap so
// an outlier can never fall out of view. See shared/marketMatch/priceOutliers.
// ---------------------------------------------------------------------------

export const PriceOutlierKindSchema = z.enum(['low', 'high'])
export type PriceOutlierKind = z.infer<typeof PriceOutlierKindSchema>

export const BrandFamilyPriceOutlierSchema = z.object({
  kind: PriceOutlierKindSchema,
  /** Signed preTax price − basis median (USD); negative below, positive above. */
  delta: z.number(),
  /** The crossed fence value (USD): effective low fence for `low`, high for `high`. */
  fence: z.number(),
  /** Basis median preTax price (USD). */
  median: z.number(),
  /** Count of eligible (above-threshold, finite-priced) candidates in the basis. */
  basis: z.number().int(),
})
export type BrandFamilyPriceOutlier = z.infer<typeof BrandFamilyPriceOutlierSchema>

export const PriceOutlierMethodSchema = z.enum([
  'iqr',
  'tight-cluster',
  'insufficient-basis',
  'no-variation',
])
export type PriceOutlierMethod = z.infer<typeof PriceOutlierMethodSchema>

/** Family-level roll-up for the summary pill / tooltip. Numeric stats null when no basis. */
export const BrandFamilyPriceOutlierSummarySchema = z.object({
  /** Which rule produced the fences (or why none were computed). */
  method: PriceOutlierMethodSchema,
  /** Eligible candidate count (above-threshold, finite priced) the stats used. */
  basis: z.number().int(),
  /** Basis median (USD); null when basis < minimum. */
  median: z.number().nullable(),
  /** Effective low fence (USD); null when not computed. */
  lowFence: z.number().nullable(),
  /** Effective high fence (USD); null when not computed. */
  highFence: z.number().nullable(),
  lowCount: z.number().int(),
  highCount: z.number().int(),
  /** Total flagged outliers = lowCount + highCount (over the full scored set). */
  flaggedCount: z.number().int(),
})
export type BrandFamilyPriceOutlierSummary = z.infer<typeof BrandFamilyPriceOutlierSummarySchema>

export const BrandFamilyMatchCandidateSchema = z.object({
  fuzzySkuId: z.number().int(),
  sourceListingId: z.string(),
  listingName: z.string().nullable(),
  /** Raw LitAlerts brand string on the listing. */
  brandRaw: z.string().nullable(),
  /** Normalized LitAlerts brand (fuzzy_skus.brand_norm). */
  brandNorm: z.string().nullable(),
  /** Normalized LitAlerts category (fuzzy_skus.category_norm). */
  categoryNorm: z.string().nullable(),
  /** LitAlerts subcategory (NULL on all partner rows today — surfaced, not hidden). */
  subcategoryNorm: z.string().nullable(),
  /** Listing's own parsed size, e.g. "3.5 g" / "10 mg" / null when unparseable. */
  parsedSizeLabel: z.string().nullable(),
  /** The folded size group of the catalog variant this listing best matched. */
  matchedSizeGroupLabel: z.string(),
  /** Dispensary / retailer display name. */
  retailer: z.string().nullable(),
  /**
   * STABLE LitAlerts retailer identifier (raw_input_jsonb.retailerId), or null
   * when the raw listing lacks it. The display name is NOT stable — feedback
   * (#59 T3) and retailer-scoped convention hints key on this id.
   */
  retailerId: z.number().int().nullable(),
  url: z.string().nullable(),
  /** Derived preTax = salePrice ?? normalPrice (context column, not the point). */
  preTaxPrice: z.number().nullable(),
  /** Derived postTax = preTax * 1.13. */
  postTaxPrice: z.number().nullable(),
  currentStock: z.number().nullable(),
  /** ISO-8601 UTC capture instant of this listing snapshot (displayed in NY tz). */
  sourceCapturedAt: z.string().nullable(),
  distanceBand: BrandFamilyDistanceBandSchema,
  distanceMiles: z.number().nullable(),
  /** Final matcher score in [0,1]. */
  score: z.number(),
  factors: BrandFamilyMatchFactorsSchema,
  aboveThreshold: z.boolean(),
  matchedCatalogProductId: z.number().int().nullable(),
  /**
   * Price-outlier review flag, or null when this candidate's price is within
   * the family's fences / not eligible / basis too small. Review signal only —
   * it never affects score, ordering, or above/below-threshold gating.
   */
  priceOutlier: BrandFamilyPriceOutlierSchema.nullable(),
})
export type BrandFamilyMatchCandidate = z.infer<typeof BrandFamilyMatchCandidateSchema>

/**
 * A flagged price outlier surfaced in the bounded `reviewCandidates` list. Same
 * shape as a candidate but with a guaranteed non-null `priceOutlier`, so the UI
 * needn't null-check a list that by construction only holds outliers.
 */
export const BrandFamilyPriceReviewCandidateSchema = BrandFamilyMatchCandidateSchema.extend({
  priceOutlier: BrandFamilyPriceOutlierSchema,
})
export type BrandFamilyPriceReviewCandidate = z.infer<typeof BrandFamilyPriceReviewCandidateSchema>

export const BrandFamilyBrandMappingStateSchema = z.enum(['mapped', 'operator-says-none', 'unmapped'])
export type BrandFamilyBrandMappingState = z.infer<typeof BrandFamilyBrandMappingStateSchema>

export const BrandFamilyBrandSpellingSchema = z.object({
  rawBrandName: z.string(),
  state: BrandFamilyBrandMappingStateSchema,
  litalertsBrandId: z.number().int().nullable(),
  litalertsBrandName: z.string().nullable(),
})
export type BrandFamilyBrandSpelling = z.infer<typeof BrandFamilyBrandSpellingSchema>

/** Roll-up of the family's per-spelling mapping states for the summary line. */
export const BrandFamilyMappingSummarySchema = z.enum([
  'mapped',
  'operator-says-none',
  'unmapped',
  'mixed',
  'no-brand',
])
export type BrandFamilyMappingSummary = z.infer<typeof BrandFamilyMappingSummarySchema>

export const BrandFamilyMarketMatchResponseSchema = z.object({
  /** Echo of the requested family key (T1 non-brand JSON dimension tuple). */
  familyKey: z.string(),
  /** Echo of the requested per-brand key (null = the no-brand sub-family). */
  brandKey: z.string().nullable(),
  brandName: z.string().nullable(),
  categoryName: z.string().nullable(),
  subcategoryName: z.string().nullable(),
  sizeGroupLabel: z.string(),
  packCount: z.number().int().nullable(),
  memberVariantCount: z.number().int(),
  /** Override-aware effective LitAlerts brand norms used as the hard brand filter. */
  effectiveBrandNorms: z.array(z.string()),
  /** Per raw catalog brand spelling mapping states (honest brand mapping surface). */
  mappingStates: z.array(BrandFamilyBrandSpellingSchema),
  mappingSummary: BrandFamilyMappingSummarySchema,
  /** Auto-promote threshold the above/below split is computed against (0.70). */
  threshold: z.number(),
  /** Total pre-dedup partner rows matching the family (surfaces the duplicate-row caveat). */
  rawRowCount: z.number().int(),
  /** Distinct listings after dedup-to-latest per source_listing_id. */
  dedupedListingCount: z.number().int(),
  /** Max deduped partner rows fetched before scoring (bounded payload cap). */
  fetchLimit: z.number().int(),
  /**
   * True when dedupedListingCount exceeded fetchLimit, so only the most-recent
   * fetchLimit listings were scored. Surfaced so "N deduped vs M scored" isn't
   * misread as the matcher gating listings that were never actually fetched.
   */
  fetchTruncated: z.boolean(),
  /** Candidates that survived the hard gates and were scored. */
  scoredCandidateCount: z.number().int(),
  aboveThresholdCount: z.number().int(),
  belowThresholdCount: z.number().int(),
  /** True when the family is a multipack (pack>1) — partner side can't match pack (NULL). */
  packNotMatchable: z.boolean(),
  /** True when the family bears a subcategory — partner subcategory_norm is NULL. */
  subcategoryNotMatchable: z.boolean(),
  /** Range of listing capture instants in the returned candidates (ISO-8601 UTC). */
  snapshotCapturedAtMin: z.string().nullable(),
  snapshotCapturedAtMax: z.string().nullable(),
  candidates: z.array(BrandFamilyMatchCandidateSchema),
  /** Family-level price-outlier stats roll-up (over the full scored set). */
  priceOutlierSummary: BrandFamilyPriceOutlierSummarySchema,
  /**
   * Flagged price outliers over the FULL scored set (before the display cap),
   * so an outlier is never invisible for falling outside the top-N table slice.
   * Bounded to `reviewCandidatesLimit`, severity-sorted (distance past fence,
   * then |delta|, then score, then fuzzySkuId).
   */
  reviewCandidates: z.array(BrandFamilyPriceReviewCandidateSchema),
  /** Max entries returned in `reviewCandidates`. */
  reviewCandidatesLimit: z.number().int(),
  /** True when more outliers exist than `reviewCandidatesLimit` (hidden = flaggedCount − reviewCandidates.length). */
  reviewCandidatesOverflow: z.boolean(),
})
export type BrandFamilyMarketMatchResponse = z.infer<typeof BrandFamilyMarketMatchResponseSchema>
