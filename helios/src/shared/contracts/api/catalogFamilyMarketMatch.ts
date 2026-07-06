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
})
export type BrandFamilyMatchCandidate = z.infer<typeof BrandFamilyMatchCandidateSchema>

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
})
export type BrandFamilyMarketMatchResponse = z.infer<typeof BrandFamilyMarketMatchResponseSchema>
