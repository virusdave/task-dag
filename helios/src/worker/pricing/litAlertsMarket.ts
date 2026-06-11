import { z } from 'zod'

import {
  PRICING_EXACT_TIER_WEIGHT,
  PRICING_FALLBACK_TIER_WEIGHT,
  PRICING_FAR_DISTANCE_MAX_MILES,
  PRICING_MID_DISTANCE_MAX_MILES,
  PRICING_MID_DISTANCE_WEIGHT,
  PRICING_NEAR_DISTANCE_MAX_MILES,
  PRICING_NEAR_DISTANCE_WEIGHT,
  PRICING_POST_TAX_MULTIPLIER,
} from '../../shared/domain/pricingGeneration.js'
import { getPool } from '../../server/db/pool.js'

import type { NormalizedCatalogGroupLiveState, NormalizedCatalogProductLiveState } from '../catalog/liveState.js'
import { getWorkerEnv } from '../config/env.js'
import {
  assessParseReasonableness,
  type ParseReasonablenessCandidate,
  type ParseReasonablenessResult,
} from '../llm/parseReasonableness.js'
import {
  hasPartnerApiToken,
  listBrandsForState,
  listRetailerProducts,
  listRetailers,
  type LitAlertsProduct,
  type LitAlertsRetailer,
} from '../litalerts/partnerClient.js'
import { RetryableWorkerError } from '../runtime/errors.js'
import { pageDave } from '../runtime/pageDave.js'
import type { PricingDistanceBand, PricingMarketContext, ProductPricingMarketEvidence } from './deterministicPricing.js'

const LIT_ALERTS_PARTNER_STATE_CODE = 'NY'

const GENERIC_SEARCH_WORDS = new Set([
  'all',
  'and',
  'aio',
  'cartridge',
  'cart',
  'disposable',
  'do',
  'flower',
  'gummies',
  'gummy',
  'infused',
  'in',
  'not',
  'one',
  'pack',
  'pk',
  'pre',
  'preroll',
  'prerolls',
  'pre-roll',
  'pre-rolls',
  'roll',
  'rosin',
  'the',
  'use',
  'vape',
  'vapes',
  'vaporizers',
])

const BRAND_MANUFACTURER_ALIASES = new Map<string, string>([
  ['airo', 'airo brands'],
  ['american hash maker', 'american hash makers'],
  ['anthem', 'anthem curaleaf'],
  ['camino', 'camino kiva'],
  ['cru', 'cru cannabis'],
  ['dank', 'dank by definition'],
  ['grass roots', 'grassroots curaleaf'],
  ['jams', 'jams curaleaf'],
  ['select', 'select curaleaf'],
])

const MIN_PRICING_ELIGIBLE_COMP_COUNT = 3

/**
 * Live market evidence is gathered by fanning out across the geographically
 * nearest retailers and pulling only the target brand's listings from each
 * (`/v1/retailers/:id/products?brandIds=`), instead of one statewide
 * `/v1/brands/:id/products` call that routinely times out for high-volume
 * brands. We cap the fan-out at the ~50 closest retailers: the near (≤1mi)
 * and mid (≤3mi) buckets that actually drive price are dense within the first
 * couple dozen, and the existing distance weighting already prioritises the
 * closest dispensaries — there is no value in wading through all ~550 active
 * NY retailers. The cache (litalerts_products) remains the backstop when the
 * brand isn't carried nearby or the fan-out fails wholesale.
 */
const PRICING_NEARBY_RETAILER_FETCH_LIMIT = 50
const PRICING_NEARBY_RETAILER_FETCH_CONCURRENCY = 8
// Only accept an LLM size-interpretation pick when it is at least this
// confident; otherwise keep the deterministic convention/syntax default.
const PARSE_REASONABLENESS_CONFIDENCE_THRESHOLD = 0.85
// Cap how many same-brand retailer listing names we hand the LLM as
// nearby examples, to keep the prompt small and cheap.
const PARSE_REASONABLENESS_LISTING_SAMPLE_LIMIT = 12
const PRICING_SEARCH_ADAPTATION_MODEL = 'google.gemma-3-27b-it'
const PRICING_SEARCH_ADAPTATION_MAX_TERMS = 4
const PRICING_SEARCH_ADAPTATION_MAX_ATTEMPTS = 4
const PRICING_SEARCH_ADAPTATION_RETRY_BASE_DELAY_MS = 1500
const SEARCH_ANNOTATION_CANNABINOID_PATTERN = /\b(?:thc|cbd|cbn|cbg|cbc|thca|cbda|delta[- ]?9)\b/i
const SEARCH_ANNOTATION_POTENCY_PATTERN = /\b\d+(?:\.\d+)?\s*mg\s*(?:thc|cbd|cbn|cbg|cbc|thca|cbda)\b/i
const SEARCH_ANNOTATION_RATIO_PATTERN = /\b\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?\b/

const brandMatchCache = new Map<string, Promise<BrandMatch | null>>()

interface BrandMatch {
  brandId: number
  brandName: string
}

interface ParsedSizeProfile {
  measure: 'g' | 'mg' | null
  packCount: number
  totalValue: number | null
  unitValue: number | null
}

interface RetailerDirectoryEntry {
  address: string | null
  id: number
  name: string
  normalizedName: string
  /**
   * Great-circle distance in miles from this retailer to the nearest
   * helios_store_locations row (lat/lng joined out of
   * `litalerts_retailer_locations` ⨯ `helios_store_locations`).
   * `null` when the retailer is not yet geocoded, or none of our
   * stores have lat/lng.
   */
  minDistanceMiles: number | null
  /** site_key of the nearest store, or null when minDistanceMiles is null. */
  nearestStoreKey: string | null
}

interface RetailerDirectory {
  byId: Map<number, RetailerDirectoryEntry>
  byNormalizedName: Map<string, RetailerDirectoryEntry>
}

interface ListingPriceCandidate {
  availability: string | null
  category: string | null
  distanceBand: PricingDistanceBand
  distanceMiles: number | null
  dispensaryName: string
  /**
   * Per-product image URL the LitAlerts partner API now returns on
   * `/v1/brands/:id/products` (May 2026). Surfaced to the reviewer
   * alongside each comp listing so we don't need a separate image
   * fetch / scrape pass.
   */
  imageUrl: string | null
  listingName: string
  postTaxPrice: number
  preTaxPrice: number
  size: ParsedSizeProfile
  source: 'nearby' | 'statewide'
  url: string | null
}

interface ProductComparableProfile {
  laneKey: string | null
  size: ParsedSizeProfile
}

interface ListingMatchAssessment {
  laneTier: 0 | 1 | 2 | 3
  listing: ListingPriceCandidate
  matchTier: 'exact' | 'fallback' | 'weak'
  sizeTier: 0 | 1 | 2 | 3
}

type WeightedPriceListing = Pick<ListingPriceCandidate, 'distanceBand' | 'postTaxPrice' | 'preTaxPrice'> & {
  // Optional so existing callers (and tests) that only have distance
  // information still work — they implicitly behave as 'exact'.
  matchTier?: 'exact' | 'fallback' | 'weak'
}
type EvidenceSourceListing = Pick<ListingPriceCandidate, 'source'>

const PricingSearchAdaptationEnvelopeSchema = z.object({
  adaptation: z.object({
    rationale: z.string().trim().min(1),
    searchTerms: z.array(z.string().trim().min(1)).min(1).max(PRICING_SEARCH_ADAPTATION_MAX_TERMS),
  }),
})

export async function buildPricingMarketContext(
  liveState: NormalizedCatalogGroupLiveState,
): Promise<PricingMarketContext> {
  if (!hasPartnerApiToken()) {
    return {
      availability: 'disabled',
      note: 'Lit Alerts pricing enrichment is disabled because no Lit Alerts partner API token is configured.',
      productEvidenceById: {},
      searchTerm: null,
    }
  }

  if (!liveState.brand) {
    return {
      availability: 'no_brand',
      note: 'Lit Alerts pricing enrichment is unavailable because the live group has no brand.',
      productEvidenceById: {},
      searchTerm: null,
    }
  }

  const brandMatch = await resolveBrandMatch(liveState.brand)
  if (!brandMatch) {
    return {
      availability: 'unresolved_brand',
      note: `Could not resolve Lit Alerts manufacturer identity for ${liveState.brand}.`,
      productEvidenceById: {},
      searchTerm: null,
    }
  }

  const retailerDirectory = await loadRetailerDirectory()
  // Primary strategy: fan out across the ~50 geographically nearest retailers
  // and pull only this brand's listings from each
  // (`/v1/retailers/:id/products?brandIds=`). Each call is tiny (~20KB vs the
  // ~600KB full menu), and we avoid the statewide `/v1/brands/:id/products`
  // roster entirely — that endpoint routinely times out for high-volume brands
  // (e.g. Jeeter), which used to force every run onto the stale cache fallback
  // with no near/mid comps. Nearest-first means the near/mid distance buckets
  // that actually drive price get populated from live data.
  //
  // Resilience: individual retailer fetches that fail transiently are skipped
  // (the partner client already retries each call with backoff before giving
  // up). Only if the fan-out yields zero live listings — brand not carried
  // within range, or a wholesale upstream outage — do we fall back to the
  // locally-cached `litalerts_products` table (kept fresh by the daily
  // retailer backfill). The cache is at most ~24h stale: a worse signal than
  // live, but strictly better than shipping a packet with no comp evidence.
  // We stamp the note so the reviewer can see which path served the data.
  const nearby = await loadBrandProductsFromNearbyRetailers(brandMatch.brandId, retailerDirectory)
  let allBrandListings = flattenBrandProductsToListingCandidates(nearby.products, retailerDirectory, 'nearby')
  let brandSourceNote: string | null = null
  if (allBrandListings.length > 0) {
    if (nearby.retailersFailed > 0) {
      brandSourceNote =
        `Pulled live ${brandMatch.brandName} listings from the ${nearby.retailersQueried} nearest retailers ` +
        `(${nearby.retailersFailed} retailer queries failed transiently and were skipped).`
    }
  } else {
    const cached = await loadBrandProductsFromCache(brandMatch.brandId, LIT_ALERTS_PARTNER_STATE_CODE)
    if (cached.length === 0) {
      // No live nearby evidence AND no cached evidence — re-throw so the worker
      // retries the whole job after backoff instead of shipping an empty packet.
      throw new RetryableWorkerError(
        `Lit Alerts produced no live listings from the ${nearby.retailersQueried} nearest retailers ` +
          `(${nearby.retailersFailed} failed) and no cached listings for brand ${brandMatch.brandId}.`,
      )
    }
    allBrandListings = flattenBrandProductsToListingCandidates(cached, retailerDirectory, 'statewide')
    const failureSuffix =
      nearby.retailersFailed > 0
        ? `${nearby.retailersFailed} of the ${nearby.retailersQueried} nearest-retailer queries failed transiently`
        : `${brandMatch.brandName} is not carried at the ${nearby.retailersQueried} nearest retailers`
    brandSourceNote =
      `No live nearby listings (${failureSuffix}); served comp evidence from ` +
      `the locally-cached litalerts_products table instead (${cached.length} listings).`
    console.warn(`[litAlertsMarket] nearby-retailer fan-out empty; using local cache fallback: ${brandSourceNote}`)
  }

  const categoryId = resolveLitAlertsCategoryId(liveState)
  const deterministicSearchTerms = deriveSearchTerms(liveState)
  const searchTerm = pickFirstMatchingSearchTerm(deterministicSearchTerms, allBrandListings)
  let combinedSearchTerms = searchTerm ? [searchTerm] : []
  let mergedListings = combinedSearchTerms.length > 0
    ? filterListingCandidatesBySearchTerms(allBrandListings, combinedSearchTerms)
    : []
  // Build OUR catalog SKU profiles once for this run. This is where the
  // (rare) LLM size sanity check fires — only for SKUs whose multipack
  // size the distribution prior can't settle — so reusing the map across
  // the initial and search-adapted evidence passes avoids re-asking.
  const catalogProfiles = await buildCatalogComparableProfiles({
    liveState,
    listingSamples: allBrandListings,
  })
  let evidenceByProductId = collectProductEvidence(
    liveState,
    mergedListings,
    buildSearchTermLabel(combinedSearchTerms),
    catalogProfiles,
  )
  let adaptationSummary: string | null = null

  if (shouldAttemptSearchAdaptation(liveState, evidenceByProductId)) {
    const adaptation = await requestPricingSearchAdaptation({
      categoryId,
      currentListings: mergedListings,
      deterministicSearchTerms,
      liveState,
      primarySearchTerm: searchTerm,
      productEvidenceById: evidenceByProductId,
    })
    const adaptedSearchTerms = adaptation?.searchTerms.filter((term) => !combinedSearchTerms.includes(term)) ?? []
    if (adaptedSearchTerms.length > 0) {
      combinedSearchTerms = [...combinedSearchTerms, ...adaptedSearchTerms]
      const adaptedListings = filterListingCandidatesBySearchTerms(allBrandListings, adaptedSearchTerms)
      mergedListings = dedupeListingCandidates([...mergedListings, ...adaptedListings])
      evidenceByProductId = collectProductEvidence(
        liveState,
        mergedListings,
        buildSearchTermLabel(combinedSearchTerms),
        catalogProfiles,
      )
      adaptationSummary = `Mantle search adaptation added ${adaptedSearchTerms.map((term) => `"${term}"`).join(', ')} because the initial pass left at least one SKU below ${MIN_PRICING_ELIGIBLE_COMP_COUNT} near/mid comps. ${adaptation?.rationale ?? ''}`.trim()
    } else if (adaptation?.rationale) {
      adaptationSummary = `Mantle search adaptation reviewed the thin-comp case but did not add safer search terms. ${adaptation.rationale}`
    }
  }

  if (combinedSearchTerms.length === 0) {
    const noMatchSourcePrefix = brandSourceNote ? `${brandSourceNote} ` : ''
    return {
      availability: 'no_family_matches',
      note:
        noMatchSourcePrefix +
        (adaptationSummary
          ? `${adaptationSummary} No Lit Alerts family listing cluster was found for ${liveState.brand} / ${liveState.groupName}.`
          : `No Lit Alerts family listing cluster was found for ${liveState.brand} / ${liveState.groupName}.`),
      productEvidenceById: {},
      searchTerm: null,
    }
  }

  const evidenceEntries = Object.values(evidenceByProductId)
  const searchLabel = buildSearchTermLabel(combinedSearchTerms)
  const sourcePrefix = brandSourceNote ? `${brandSourceNote} ` : ''
  const adaptationPrefix = sourcePrefix + (adaptationSummary ? `${adaptationSummary} ` : '')
  if (evidenceEntries.some((evidence) => evidence.averagePostTaxPrice !== null)) {
    return {
      availability: 'matched',
      note:
        adaptationPrefix +
        `Matched Lit Alerts distance-banded competitor listings for ${liveState.brand} using ${searchLabel}. ` +
        `Near (${PRICING_NEAR_DISTANCE_MAX_MILES.toFixed(1)}mi) listings drive pricing much more strongly than mid (${PRICING_MID_DISTANCE_MAX_MILES.toFixed(1)}mi) listings; far and very-far listings remain display-only evidence.`,
      productEvidenceById: evidenceByProductId,
      searchTerm: searchLabel,
    }
  }

  if (evidenceEntries.some((evidence) => evidence.listingCount > 0)) {
    return {
      availability: 'display_only',
      note:
        adaptationPrefix +
        `Lit Alerts found same-brand family listings for ${searchLabel}, but none landed inside the near or mid distance buckets. ` +
        `Those farther listings are still retained in the pricing ladder for context while the draft falls back to the managed GM target.`,
      productEvidenceById: evidenceByProductId,
      searchTerm: searchLabel,
    }
  }

  return {
    availability: 'no_safe_matches',
    note: `${adaptationPrefix}Lit Alerts found a family cluster for ${searchLabel}, but no safe size-aligned competitor rows matched the current SKUs.`,
    productEvidenceById: {},
    searchTerm: searchLabel,
  }
}

export async function buildPricingMarketContextWithFailureHandling(input: {
  failureContext: string
  liveState: NormalizedCatalogGroupLiveState
  shouldPageOnFailure?: ((error: unknown) => boolean | Promise<boolean>) | undefined
}): Promise<PricingMarketContext> {
  try {
    return await buildPricingMarketContext(input.liveState)
  } catch (error) {
    const shouldPage = await input.shouldPageOnFailure?.(error)
    if (!shouldPage) {
      throw error
    }

    try {
      await pageDave(buildPricingMarketFailurePageMessage(input.failureContext, input.liveState, error))
    } catch (pagingError) {
      throw new Error(
        `${buildUnknownErrorMessage(error)} Also failed to page Dave: ${buildUnknownErrorMessage(pagingError)}`,
      )
    }

    throw error
  }
}

export function resetPricingMarketCachesForTest(): void {
  brandMatchCache.clear()
}

export const __test__ = {
  assessListingForProduct,
  buildCatalogComparableProfiles,
  classifyLaneTier,
  classifySizeTier,
  inferComparableLaneKey,
  inspectCatalogMultipackAmbiguity,
  resolveCatalogSizeProfile,
  resolveListingSizeProfile,
  resolveSizeConvention,
  disambiguateMultipackValue,
  buildSizeDistributionPrior,
}

interface BrandOverrideRow {
  litalertsBrandId: number | null
  litalertsBrandName: string | null
}

async function loadBrandOverrideForCatalogName(brandName: string): Promise<BrandOverrideRow | null> {
  try {
    const result = await getPool().query<{
      litalerts_brand_id: string | null
      litalerts_brand_name: string | null
    }>(
      `select litalerts_brand_id::text as litalerts_brand_id,
              litalerts_brand_name
         from catalog_litalerts_brand_overrides
        where catalog_brand_name = $1
        limit 1`,
      [brandName],
    )
    const row = result.rows[0]
    if (!row) return null
    return {
      litalertsBrandId: row.litalerts_brand_id != null ? Number(row.litalerts_brand_id) : null,
      litalertsBrandName: row.litalerts_brand_name,
    }
  } catch (err: unknown) {
    // Don't take pricing offline if the override table is briefly
    // unavailable — the heuristic match below still covers ~84% of
    // brands, which is the same behaviour we had before overrides
    // existed.
    console.warn(`[litAlertsMarket] override lookup failed for "${brandName}":`, err)
    return null
  }
}

async function resolveBrandMatch(brandName: string): Promise<BrandMatch | null> {
  const normalizedTarget = normalizeBrandKey(brandName)
  const normalizedTargetWithoutParenthetical = stripParentheticalSuffix(normalizedTarget)
  const cachedMatch = brandMatchCache.get(normalizedTarget)
  if (cachedMatch) {
    return cachedMatch
  }

  const pendingMatch = (async (): Promise<BrandMatch | null> => {
    // 1. Operator-confirmed override (`catalog_litalerts_brand_overrides`)
    //    wins over every heuristic. The /catalog/brand-mapping page
    //    persists exactly one row per `catalog_groups.brand_name`, so
    //    looking it up by the *raw* (un-normalized) brand string is the
    //    correct join — that's the same key the page uses on write.
    //    A row with `litalerts_brand_id IS NULL` is the explicit
    //    "no LitAlerts equivalent" verdict; respect it by returning
    //    null without falling through to the heuristics, otherwise
    //    we'd undo the operator's review.
    const override = await loadBrandOverrideForCatalogName(brandName)
    if (override) {
      if (override.litalertsBrandId === null) {
        return null
      }
      const brands = await listBrandsForState(LIT_ALERTS_PARTNER_STATE_CODE)
      const overriden = brands.find((brand) => brand.id === override.litalertsBrandId)
      if (overriden) {
        return { brandId: overriden.id, brandName: overriden.name }
      }
      // Override pins a brand_id that the partner API no longer returns
      // for NY (brand deleted / moved out of state). Fall through to
      // heuristics rather than silently disabling pricing.
      console.warn(
        `[litAlertsMarket] override for "${brandName}" -> brand_id=${override.litalertsBrandId} ` +
          `(${override.litalertsBrandName ?? '?'}) is no longer in the LitAlerts NY brand list; ` +
          `falling back to heuristic match`,
      )
    }

    const brands = await listBrandsForState(LIT_ALERTS_PARTNER_STATE_CODE)
    const aliasTarget = BRAND_MANUFACTURER_ALIASES.get(normalizedTarget)
    if (aliasTarget) {
      const aliased = brands.find((brand) => normalizeBrandKey(brand.name) === aliasTarget)
      if (aliased) {
        return { brandId: aliased.id, brandName: aliased.name }
      }
    }

    const exact = brands.find((brand) => {
      const brandKey = normalizeBrandKey(brand.name)
      return brandKey === normalizedTarget || stripParentheticalSuffix(brandKey) === normalizedTargetWithoutParenthetical
    })

    return exact ? { brandId: exact.id, brandName: exact.name } : null
  })()

  brandMatchCache.set(normalizedTarget, pendingMatch)
  // Clear the cached promise on rejection so a transient partner-API failure
  // does not poison every subsequent pricing/litalerts job in this worker
  // until restart.
  pendingMatch.catch(() => {
    if (brandMatchCache.get(normalizedTarget) === pendingMatch) {
      brandMatchCache.delete(normalizedTarget)
    }
  })
  return pendingMatch
}

function pickFirstMatchingSearchTerm(
  searchTerms: string[],
  candidateListings: ListingPriceCandidate[],
): string | null {
  for (const searchTerm of searchTerms) {
    if (filterListingCandidatesBySearchTerms(candidateListings, [searchTerm]).length > 0) {
      return searchTerm
    }
  }
  return null
}

function filterListingCandidatesBySearchTerms(
  candidateListings: ListingPriceCandidate[],
  searchTerms: string[],
): ListingPriceCandidate[] {
  if (searchTerms.length === 0) {
    return []
  }
  const normalizedTerms = searchTerms.map((term) => term.toLowerCase()).filter((term) => term.length > 0)
  if (normalizedTerms.length === 0) {
    return []
  }
  const matched = candidateListings.filter((listing) => {
    const haystack = listing.listingName.toLowerCase()
    return normalizedTerms.some((term) => haystack.includes(term))
  })
  return dedupeListingCandidates(matched)
}

/** Pure, network-free comparable profile for one of OUR catalog SKUs. */
function buildDeterministicCatalogProfile(
  liveState: NormalizedCatalogGroupLiveState,
  product: NormalizedCatalogProductLiveState,
  options: { assessedInterpretation?: SizeValueInterpretation | null; prior?: SizeDistributionPrior | null } = {},
): ProductComparableProfile {
  return {
    laneKey: inferComparableLaneKey({
      category: liveState.category,
      subcategory: liveState.subcategory,
      text: `${liveState.groupFullName} ${product.name} ${product.tab}`,
    }),
    size: resolveCatalogSizeProfile({
      name: product.name,
      tab: product.tab,
      sizeName: product.sizeName,
      packOfSize: product.packOfSize,
      brand: liveState.brand,
      category: liveState.category,
      prior: options.prior,
      assessedInterpretation: options.assessedInterpretation ?? null,
    }),
  }
}

type ParseReasonablenessAssessor = typeof assessParseReasonableness

/**
 * Build comparable profiles for every catalog SKU in the group, once per
 * pricing run. For the rare SKUs whose multipack size is genuinely
 * ambiguous (no manual override AND the distribution prior is silent) we
 * escalate to a cheap LLM sanity check, handing it the two candidate
 * parses plus the surrounding catalog/distributor/nearby-listing context.
 * Its pick is accepted only above a confidence threshold; everything else
 * falls straight back to the deterministic chain. The hot per-listing
 * comparison path never calls the LLM — only these few catalog SKUs do.
 */
async function buildCatalogComparableProfiles(input: {
  liveState: NormalizedCatalogGroupLiveState
  listingSamples: ListingPriceCandidate[]
  prior?: SizeDistributionPrior | null
  extraContext?: string | null
  assessor?: ParseReasonablenessAssessor
}): Promise<Map<number, ProductComparableProfile>> {
  const assessor = input.assessor ?? assessParseReasonableness
  const profiles = new Map<number, ProductComparableProfile>()

  for (const product of input.liveState.products) {
    let assessedInterpretation: SizeValueInterpretation | null = null
    const ambiguity = inspectCatalogMultipackAmbiguity({
      name: product.name,
      tab: product.tab,
      sizeName: product.sizeName,
      packOfSize: product.packOfSize,
      brand: input.liveState.brand,
      category: input.liveState.category,
      prior: input.prior,
    })
    if (ambiguity) {
      const candidates: ParseReasonablenessCandidate[] = [
        toReasonablenessCandidate('unit', ambiguity.candidateUnit),
        toReasonablenessCandidate('total', ambiguity.candidateTotal),
      ]
      let assessment: ParseReasonablenessResult | null = null
      try {
        assessment = await assessor({
          name: product.name || product.tab,
          candidates,
          context: buildParseReasonablenessContext({
            liveState: input.liveState,
            product,
            ambiguity,
            listingSamples: input.listingSamples,
            extraContext: input.extraContext ?? null,
          }),
        })
      } catch (error) {
        console.warn(
          `[litAlertsMarket] parse reasonableness check threw for "${product.name}"; staying deterministic: ${buildUnknownErrorMessage(error)}`,
        )
      }
      if (
        assessment &&
        (assessment.chosenLabel === 'unit' || assessment.chosenLabel === 'total') &&
        assessment.confidence >= PARSE_REASONABLENESS_CONFIDENCE_THRESHOLD
      ) {
        assessedInterpretation = assessment.chosenLabel
        console.info(
          `[litAlertsMarket] parse reasonableness accepted '${assessment.chosenLabel}' ` +
            `(confidence ${assessment.confidence.toFixed(2)}) for "${product.name}": ${assessment.note}`,
        )
      } else if (assessment) {
        console.info(
          `[litAlertsMarket] parse reasonableness inconclusive for "${product.name}" ` +
            `(chosen=${assessment.chosenLabel ?? 'none'}, confidence ${assessment.confidence.toFixed(2)}); ` +
            `keeping deterministic parse. ${assessment.note}`,
        )
      }
    }
    profiles.set(
      product.productId,
      buildDeterministicCatalogProfile(input.liveState, product, {
        assessedInterpretation,
        prior: input.prior,
      }),
    )
  }

  return profiles
}

function toReasonablenessCandidate(label: string, profile: ParsedSizeProfile): ParseReasonablenessCandidate {
  return {
    label,
    measure: profile.measure,
    packCount: profile.packCount,
    totalValue: profile.totalValue,
    unitValue: profile.unitValue,
  }
}

function buildParseReasonablenessContext(input: {
  liveState: NormalizedCatalogGroupLiveState
  product: NormalizedCatalogProductLiveState
  ambiguity: CatalogMultipackAmbiguity
  listingSamples: ListingPriceCandidate[]
  extraContext: string | null
}): string {
  const { ambiguity, liveState, product } = input
  const lines: string[] = []
  lines.push('Catalog pricing size sanity check for Freshly Baked NYC (a NY cannabis retailer).')
  lines.push(`Brand: ${liveState.brand ?? 'unknown'}`)
  lines.push(`Category: ${liveState.category ?? 'unknown'}`)
  if (liveState.subcategory) {
    lines.push(`Subcategory: ${liveState.subcategory}`)
  }
  lines.push(`Catalog group: ${liveState.groupFullName || liveState.groupName}`)
  if (liveState.strain) {
    lines.push(`Strain: ${liveState.strain}`)
  }
  lines.push(
    `Structured catalog fields: sizeName=${product.sizeName ?? 'none'}, packOfSize=${product.packOfSize ?? 'none'}, tab=${product.tab || 'none'}`,
  )
  lines.push('Deterministic signals (already applied, all currently inconclusive):')
  lines.push('- manual override: none')
  lines.push(
    `- catalog distribution prior: "unit" cohort count=${ambiguity.unitCount}, "total" cohort count=${ambiguity.totalCount} (neither decisive)`,
  )
  lines.push(`- brand convention: ${ambiguity.conventionInterpretation ?? 'no specific convention'}`)
  lines.push(`- syntax default: ${ambiguity.defaultInterpretation}`)

  const siblingNames = liveState.products
    .filter((sibling) => sibling.productId !== product.productId)
    .map((sibling) => sibling.name)
    .filter((name) => name.trim().length > 0)
    .slice(0, 6)
  if (siblingNames.length > 0) {
    lines.push('Sibling SKUs in this catalog group:')
    for (const name of siblingNames) {
      lines.push(`- ${name}`)
    }
  }

  const listingNames = Array.from(
    new Set(
      input.listingSamples
        .filter((listing) => isCategoryCompatible(liveState, listing.category))
        .map((listing) => normalizeInlineText(listing.listingName))
        .filter((name) => name.length > 0),
    ),
  ).slice(0, PARSE_REASONABLENESS_LISTING_SAMPLE_LIMIT)
  if (listingNames.length > 0) {
    lines.push('Nearby same-brand retailer listing examples (how competitors label this product):')
    for (const name of listingNames) {
      lines.push(`- ${name}`)
    }
  }

  if (input.extraContext && input.extraContext.trim().length > 0) {
    lines.push('Additional context:')
    lines.push(input.extraContext.trim())
  }

  return lines.join('\n')
}

function collectProductEvidence(
  liveState: NormalizedCatalogGroupLiveState,
  listings: ListingPriceCandidate[],
  searchTerm: string,
  catalogProfilesByProductId: Map<number, ProductComparableProfile> = new Map(),
): Record<number, ProductPricingMarketEvidence> {
  const result: Record<number, ProductPricingMarketEvidence> = {}

  for (const product of liveState.products) {
    const productProfile: ProductComparableProfile =
      catalogProfilesByProductId.get(product.productId) ?? buildDeterministicCatalogProfile(liveState, product)
    const assessedListings = dedupeListingCandidates(
      listings.filter((listing) => isCategoryCompatible(liveState, listing.category)),
    ).map((listing) => assessListingForProduct(productProfile, listing))
    if (assessedListings.length === 0) {
      continue
    }

    const bestLaneTier = assessedListings.reduce<ListingMatchAssessment['laneTier']>(
      (best, assessment) => (assessment.laneTier > best ? assessment.laneTier : best),
      0,
    )
    const strongestLaneListings = assessedListings.filter((assessment) => assessment.laneTier === bestLaneTier)
    const bestSizeTier = strongestLaneListings.reduce<ListingMatchAssessment['sizeTier']>(
      (best, assessment) => (assessment.sizeTier > best ? assessment.sizeTier : best),
      0,
    )
    const matchedListings = assessedListings.map((assessment) => {
      // Both exact-SKU matches AND brand-family ("fallback") matches
      // participate in the pricing math now, with the fallback tier
      // weighted noticeably lower in `buildWeightedAveragePrice` (see
      // PRICING_FALLBACK_TIER_WEIGHT). Weak matches are still excluded
      // from pricing math, but remain on the ladder as display-only
      // context. The old "only best-of-best lane × best-of-best size"
      // gate was too narrow and starved the proposed price of comps.
      const eligibleForPricing = (assessment.matchTier === 'exact' || assessment.matchTier === 'fallback')
        && (assessment.listing.distanceBand === 'near' || assessment.listing.distanceBand === 'mid')

      return {
        category: assessment.listing.category,
        distanceBand: assessment.listing.distanceBand,
        distanceMiles: assessment.listing.distanceMiles,
        dispensaryName: assessment.listing.dispensaryName,
        eligibleForPricing,
        exclusionReason: eligibleForPricing
          ? null
          : describeListingExclusionReason({
              assessment,
              bestLaneTier,
              bestSizeTier,
            }),
        imageUrl: assessment.listing.imageUrl,
        listingName: assessment.listing.listingName,
        matchTier: assessment.matchTier,
        postTaxPrice: assessment.listing.postTaxPrice,
        preTaxPrice: assessment.listing.preTaxPrice,
        source: assessment.listing.source,
        url: assessment.listing.url,
      }
    })
    if (matchedListings.length === 0) {
      continue
    }

    const pricingEligibleListings = matchedListings.filter((listing) => listing.eligibleForPricing)
    const farListings = matchedListings.filter((listing) => listing.distanceBand === 'far')
    const dispensaryCount = new Set(matchedListings.map((listing) => listing.dispensaryName.toLowerCase())).size
    const pricingEligibleDispensaryCount = new Set(
      pricingEligibleListings.map((listing) => listing.dispensaryName.toLowerCase()),
    ).size

    const weightedAverage = buildWeightedAveragePrice(pricingEligibleListings)
    const pricingMedian = buildMedianPrice(pricingEligibleListings)
    const farAverage = buildAveragePrice(farListings)
    result[product.productId] = {
      averagePostTaxPrice: weightedAverage?.postTaxPrice ?? null,
      averagePreTaxPrice: weightedAverage?.preTaxPrice ?? null,
      dispensaryCount,
      farAveragePostTaxPrice: farAverage?.postTaxPrice ?? null,
      farAveragePreTaxPrice: farAverage?.preTaxPrice ?? null,
      farListingCount: farListings.length,
      listingCount: matchedListings.length,
      medianPostTaxPrice: pricingMedian?.postTaxPrice ?? null,
      medianPreTaxPrice: pricingMedian?.preTaxPrice ?? null,
      pricingEligibleDispensaryCount,
      pricingEligibleListingCount: pricingEligibleListings.length,
      matchedListings,
      searchTerm,
      source: deriveEvidenceSource(matchedListings),
    }
  }

  return result
}

function flattenBrandProductsToListingCandidates(
  products: LitAlertsProduct[],
  retailerDirectory: RetailerDirectory,
  source: ListingPriceCandidate['source'],
): ListingPriceCandidate[] {
  const flattened: ListingPriceCandidate[] = []

  for (const product of products) {
    const listingName = normalizeInlineText(product.name)
    if (!listingName) {
      continue
    }

    const retailerEntry = product.retailerId !== null && product.retailerId !== undefined
      ? retailerDirectory.byId.get(product.retailerId)
      : undefined
    const dispensaryName = retailerEntry?.name ?? `Retailer #${product.retailerId ?? 'unknown'}`
    if (/freshly baked/i.test(dispensaryName)) {
      continue
    }

    const url = normalizeInlineText(product.recreationalURL) || normalizeInlineText(product.medicalURL) || null
    const category = normalizeInlineText(product.category)
    const imageUrl = normalizeInlineText(product.imageURL) || null

    for (const config of product.configs) {
      const preTaxPrice = parseLitAlertsPrice(config.salePrice) ?? parseLitAlertsPrice(config.normalPrice)
      if (preTaxPrice === null || preTaxPrice <= 0) {
        continue
      }

      // Resolve per-listing distance to our nearest store via the
      // geocoded retailer directory (litalerts_retailer_locations ⨯
      // helios_store_locations). Retailers we haven't geocoded yet
      // still come through as distanceBand='unknown' / distanceMiles=null
      // so they appear on the ladder in the statewide band rather than
      // disappearing.
      const distanceMiles = retailerEntry?.minDistanceMiles ?? null
      const distanceBand = classifyPricingDistanceBand(distanceMiles)
      flattened.push({
        availability: null,
        category,
        distanceBand,
        distanceMiles,
        dispensaryName,
        imageUrl,
        listingName,
        postTaxPrice: roundCurrency(preTaxPrice * PRICING_POST_TAX_MULTIPLIER),
        preTaxPrice: roundCurrency(preTaxPrice),
        size: resolveListingSizeProfile({
          listingName,
          amount: config.amount,
          units: config.units,
          brand: product.brand,
          category,
        }),
        source,
        url,
      })
    }
  }

  return flattened
}

/**
 * Primary live-evidence path for `buildPricingMarketContext`.
 *
 * Fans out across the geographically nearest retailers (capped at
 * `PRICING_NEARBY_RETAILER_FETCH_LIMIT`, nearest-first) and pulls only the
 * target brand's listings from each via
 * `/v1/retailers/:id/products?brandIds=`. Replaces the single statewide
 * `/v1/brands/:id/products` call, which routinely timed out for high-volume
 * brands and forced every run onto the stale cache fallback.
 *
 * Retailers are ranked by `minDistanceMiles` (geocoded ⨯ helios stores),
 * with ungeocoded retailers sorted last so they only get queried when there
 * aren't 50 geocoded ones — in NY today the cap is always filled by geocoded
 * retailers. Our own stores ("Freshly Baked") are excluded.
 *
 * Concurrency is bounded (`PRICING_NEARBY_RETAILER_FETCH_CONCURRENCY`) so we
 * never hammer the already-fragile partner ELB; the partner client retries
 * each individual call with backoff. A retailer whose fetch still fails after
 * those retries is counted and skipped — partial nearby data beats no data,
 * which is the whole point of this strategy.
 */
async function loadBrandProductsFromNearbyRetailers(
  brandId: number,
  retailerDirectory: RetailerDirectory,
): Promise<{ products: LitAlertsProduct[]; retailersQueried: number; retailersFailed: number }> {
  const nearest = [...retailerDirectory.byId.values()]
    .filter((entry) => !/freshly baked/i.test(entry.name))
    .sort(
      (left, right) =>
        (left.minDistanceMiles ?? Number.POSITIVE_INFINITY) -
        (right.minDistanceMiles ?? Number.POSITIVE_INFINITY),
    )
    .slice(0, PRICING_NEARBY_RETAILER_FETCH_LIMIT)

  const products: LitAlertsProduct[] = []
  let retailersFailed = 0
  let cursor = 0
  const runners = Math.min(PRICING_NEARBY_RETAILER_FETCH_CONCURRENCY, nearest.length)
  await Promise.all(
    Array.from({ length: runners }, async () => {
      while (true) {
        const index = cursor
        cursor += 1
        if (index >= nearest.length) {
          return
        }
        const retailer = nearest[index]!
        try {
          const rows = await listRetailerProducts(retailer.id, {
            stateCode: LIT_ALERTS_PARTNER_STATE_CODE,
            brandIds: [brandId],
          })
          for (const row of rows) {
            // The brandIds filter already scopes the payload server-side; we
            // only normalise retailerId (defensively) so the flatten step can
            // attach the right distance band.
            products.push(
              row.retailerId === null || row.retailerId === undefined
                ? { ...row, retailerId: retailer.id }
                : row,
            )
          }
        } catch (error) {
          retailersFailed += 1
          console.warn(
            `[litAlertsMarket] nearby fetch failed for retailer ${retailer.id} (${retailer.name}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
      }
    }),
  )

  return { products, retailersQueried: nearest.length, retailersFailed }
}

/**
 * Fallback path for `buildPricingMarketContext` when the nearby-retailer
 * fan-out yields zero live listings (brand not carried within range, or a
 * wholesale upstream outage).
 *
 * We rebuild the per-(retailer, product) listing roster from the locally
 * cached `litalerts_products` table, which the daily retailer backfill keeps
 * populated. The output matches `LitAlertsProduct[]` so it flattens through
 * the same path as the live data.
 *
 * Staleness: the cache is at most ~24h old in steady state. That is a
 * worse signal than a live partner-API call, but strictly better than
 * shipping a packet with no comp evidence at all.
 */
async function loadBrandProductsFromCache(
  brandId: number,
  stateCode: string,
): Promise<LitAlertsProduct[]> {
  // Every field below comes from a typed column (phase F3): the raw
  // JSON blobs the structured ingest used to persist were redundant
  // with these columns and are being drained off the table to reclaim
  // ~3.4 GB. The per-product image is read from the typed `image_url`
  // column, falling back to the legacy raw_product_json->>'imageURL'
  // ONLY for rows the drain worker hasn't converged yet (rows it has
  // touched, plus all rows written by the new ingest, carry image_url
  // directly). That transitional `raw_product_json` read is the single
  // remaining raw consumer and is removed by the follow-up
  // DROP COLUMN task once the drain has fully converged.
  const result = await getPool().query<{
    brand_id: string | null
    brand_name: string | null
    retailer_id: string
    product_id: string
    config_idx: number
    product_name: string
    category: string | null
    medical_url: string | null
    recreational_url: string | null
    image_url: string | null
    amount: string | null
    units: string | null
    normal_price: string | null
    sale_price: string | null
    current_stock: number | null
    recreational: boolean | null
    medical: boolean | null
  }>(
    `
      with latest as (
        select distinct on (retailer_id, product_id, config_idx)
          *
        from litalerts_products
        where brand_id = $1
          and state_code = $2
        order by retailer_id, product_id, config_idx, observed_at desc
      )
      select
        brand_id::text as brand_id,
        brand_name,
        retailer_id::text as retailer_id,
        product_id::text as product_id,
        config_idx,
        product_name,
        category,
        medical_url,
        recreational_url,
        coalesce(image_url, nullif(raw_product_json->>'imageURL', '')) as image_url,
        amount,
        units,
        normal_price,
        sale_price,
        current_stock,
        recreational,
        medical
      from latest
      order by retailer_id, product_id, config_idx
    `,
    [brandId, stateCode],
  )

  type LitAlertsProductConfig = LitAlertsProduct['configs'][number]
  const productById = new Map<string, LitAlertsProduct & { configs: LitAlertsProductConfig[] }>()
  for (const row of result.rows) {
    const key = `${row.retailer_id}:${row.product_id}`
    let product = productById.get(key)
    if (!product) {
      product = {
        id: Number(row.product_id),
        name: row.product_name,
        brand: row.brand_name ?? undefined,
        brandId: row.brand_id != null ? Number(row.brand_id) : undefined,
        retailerId: Number(row.retailer_id),
        medicalURL: row.medical_url ?? undefined,
        recreationalURL: row.recreational_url ?? undefined,
        category: row.category ?? undefined,
        imageURL: row.image_url ?? undefined,
        configs: [],
      }
      productById.set(key, product)
    }
    product.configs.push({
      amount: row.amount,
      units: row.units,
      recreational: row.recreational,
      medical: row.medical,
      // numeric(10,2) comes back from node-pg as a string; the config
      // schema + parseLitAlertsPrice both accept string|number, so we
      // pass it through untouched (no float round-trip).
      normalPrice: row.normal_price,
      salePrice: row.sale_price,
      currentStock: row.current_stock,
    })
  }
  return Array.from(productById.values())
}

async function loadRetailerDirectory(): Promise<RetailerDirectory> {
  const [retailers, distanceRows] = await Promise.all([
    listRetailers(LIT_ALERTS_PARTNER_STATE_CODE),
    loadRetailerNearestStoreMap(),
  ])
  return buildRetailerDirectory(retailers, distanceRows)
}

/**
 * For every geocoded retailer in `litalerts_retailer_locations`, find
 * the nearest of our stores by great-circle (haversine) miles. Returns
 * a Map keyed by retailer_id. Retailers that have not been geocoded
 * yet, or that have no helios store within reach (all stores missing
 * coords), are simply absent from the map.
 *
 * The CROSS JOIN cardinality is bounded by retailer_count × store_count
 * (≈ 555 × 2 today), so it runs in a single millisecond-scale query.
 */
async function loadRetailerNearestStoreMap(): Promise<
  Map<number, { miles: number; nearestStoreKey: string }>
> {
  const result = await getPool().query<{
    retailer_id: string
    miles: number
    nearest_store_key: string
  }>(
    `
      with retailer_distances as (
        select
          r.retailer_id,
          s.site_key,
          3958.7613 * 2 * asin(
            sqrt(
              sin(radians((s.latitude - r.latitude) / 2)) ^ 2
              + cos(radians(r.latitude)) * cos(radians(s.latitude))
                * sin(radians((s.longitude - r.longitude) / 2)) ^ 2
            )
          ) as miles
        from litalerts_retailer_locations r
        cross join helios_store_locations s
        where r.latitude is not null and r.longitude is not null
          and s.latitude is not null and s.longitude is not null
      )
      select distinct on (retailer_id)
        retailer_id::text as retailer_id,
        miles,
        site_key as nearest_store_key
      from retailer_distances
      order by retailer_id, miles asc
    `,
  )
  const map = new Map<number, { miles: number; nearestStoreKey: string }>()
  for (const row of result.rows) {
    const retailerId = Number(row.retailer_id)
    if (!Number.isFinite(retailerId)) continue
    if (typeof row.miles !== 'number' || !Number.isFinite(row.miles)) continue
    map.set(retailerId, { miles: row.miles, nearestStoreKey: row.nearest_store_key })
  }
  return map
}

function buildRetailerDirectory(
  retailers: LitAlertsRetailer[],
  distanceMap: Map<number, { miles: number; nearestStoreKey: string }>,
): RetailerDirectory {
  const byId = new Map<number, RetailerDirectoryEntry>()
  const byNormalizedName = new Map<string, RetailerDirectoryEntry>()
  for (const retailer of retailers) {
    const distance = distanceMap.get(retailer.id)
    const entry: RetailerDirectoryEntry = {
      address: normalizeInlineText(retailer.address) || null,
      id: retailer.id,
      name: retailer.name,
      normalizedName: normalizeDispensaryKey(retailer.name),
      minDistanceMiles: distance?.miles ?? null,
      nearestStoreKey: distance?.nearestStoreKey ?? null,
    }
    byId.set(entry.id, entry)
    if (entry.normalizedName) {
      byNormalizedName.set(entry.normalizedName, entry)
    }
  }
  return { byId, byNormalizedName }
}

export function classifyPricingDistanceBand(distanceMiles: number | null): PricingDistanceBand {
  if (distanceMiles === null || !Number.isFinite(distanceMiles)) {
    return 'unknown'
  }
  if (distanceMiles <= PRICING_NEAR_DISTANCE_MAX_MILES) {
    return 'near'
  }
  if (distanceMiles <= PRICING_MID_DISTANCE_MAX_MILES) {
    return 'mid'
  }
  if (distanceMiles <= PRICING_FAR_DISTANCE_MAX_MILES) {
    return 'far'
  }
  return 'very_far'
}

export function buildWeightedAveragePrice<TListing extends WeightedPriceListing>(
  listings: TListing[],
): { postTaxPrice: number; preTaxPrice: number } | null {
  if (listings.length === 0) {
    return null
  }

  let weightedPostTaxTotal = 0
  let weightedPreTaxTotal = 0
  let totalWeight = 0

  for (const listing of listings) {
    const distanceWeight = listing.distanceBand === 'near'
      ? PRICING_NEAR_DISTANCE_WEIGHT
      : listing.distanceBand === 'mid'
        ? PRICING_MID_DISTANCE_WEIGHT
        : 0
    if (distanceWeight <= 0) {
      continue
    }
    // Tier weight de-emphasises brand-family ("fallback") comps relative
    // to exact-SKU comps in the proposed-price math, even though they
    // are both rendered on the pricing ladder. Listings without an
    // explicit matchTier (legacy callers, unit tests) are treated as
    // 'exact' so their behaviour is unchanged.
    const tierWeight = listing.matchTier === 'fallback'
      ? PRICING_FALLBACK_TIER_WEIGHT
      : listing.matchTier === 'weak'
        ? 0
        : PRICING_EXACT_TIER_WEIGHT
    const weight = distanceWeight * tierWeight
    if (weight <= 0) {
      continue
    }
    weightedPostTaxTotal += listing.postTaxPrice * weight
    weightedPreTaxTotal += listing.preTaxPrice * weight
    totalWeight += weight
  }

  if (totalWeight <= 0) {
    return null
  }

  return {
    postTaxPrice: roundCurrency(weightedPostTaxTotal / totalWeight),
    preTaxPrice: roundCurrency(weightedPreTaxTotal / totalWeight),
  }
}

export function buildAveragePrice<TListing extends Pick<ListingPriceCandidate, 'postTaxPrice' | 'preTaxPrice'>>(
  listings: TListing[],
): { postTaxPrice: number; preTaxPrice: number } | null {
  if (listings.length === 0) {
    return null
  }

  const postTaxValues = listings.map((listing) => listing.postTaxPrice)
  const preTaxValues = listings.map((listing) => listing.preTaxPrice)

  return {
    postTaxPrice: roundCurrency(postTaxValues.reduce((sum, value) => sum + value, 0) / postTaxValues.length),
    preTaxPrice: roundCurrency(preTaxValues.reduce((sum, value) => sum + value, 0) / preTaxValues.length),
  }
}

export function buildMedianPrice<TListing extends Pick<ListingPriceCandidate, 'postTaxPrice' | 'preTaxPrice'>>(
  listings: TListing[],
): { postTaxPrice: number; preTaxPrice: number } | null {
  if (listings.length === 0) {
    return null
  }

  const postTaxValues = listings.map((listing) => listing.postTaxPrice).sort((left, right) => left - right)
  const preTaxValues = listings.map((listing) => listing.preTaxPrice).sort((left, right) => left - right)

  return {
    postTaxPrice: medianOfSortedValues(postTaxValues),
    preTaxPrice: medianOfSortedValues(preTaxValues),
  }
}

function deriveEvidenceSource<TListing extends EvidenceSourceListing>(
  listings: TListing[],
): ProductPricingMarketEvidence['source'] {
  const hasNearby = listings.some((listing) => listing.source === 'nearby')
  const hasStatewide = listings.some((listing) => listing.source === 'statewide')
  if (hasNearby && hasStatewide) {
    return 'mixed'
  }
  if (hasNearby) {
    return 'nearby'
  }
  if (hasStatewide) {
    return 'statewide'
  }
  return null
}

function medianOfSortedValues(values: number[]): number {
  const midpoint = Math.floor(values.length / 2)
  if (values.length % 2 === 1) {
    return roundCurrency(values[midpoint] ?? 0)
  }

  return roundCurrency(((values[midpoint - 1] ?? 0) + (values[midpoint] ?? 0)) / 2)
}

function assessListingForProduct(
  productProfile: ProductComparableProfile,
  listing: ListingPriceCandidate,
): ListingMatchAssessment {
  const listingLaneKey = inferComparableLaneKey({
    category: listing.category,
    subcategory: null,
    text: listing.listingName,
  })
  const laneTier = classifyLaneTier(productProfile.laneKey, listingLaneKey)
  const sizeTier = classifySizeTier(productProfile.size, listing.size)
  return {
    laneTier,
    listing,
    matchTier: classifyListingMatchTier(laneTier, sizeTier),
    sizeTier,
  }
}

function classifyListingMatchTier(
  laneTier: ListingMatchAssessment['laneTier'],
  sizeTier: ListingMatchAssessment['sizeTier'],
): ListingMatchAssessment['matchTier'] {
  const floorTier = Math.min(laneTier, sizeTier)
  if (floorTier >= 3) {
    return 'exact'
  }
  if (floorTier >= 2) {
    return 'fallback'
  }
  return 'weak'
}

function describeListingExclusionReason(input: {
  assessment: ListingMatchAssessment
  bestLaneTier: ListingMatchAssessment['laneTier']
  bestSizeTier: ListingMatchAssessment['sizeTier']
}): string {
  const { assessment, bestLaneTier, bestSizeTier } = input
  if (assessment.laneTier < bestLaneTier) {
    return bestLaneTier >= 3
      ? 'Excluded from pricing comps because stronger exact-format matches exist.'
      : 'Excluded from pricing comps because stronger category-format matches exist.'
  }
  if (bestSizeTier === 0 || assessment.sizeTier === 0) {
    return 'Excluded from pricing comps because the size does not align safely with this SKU.'
  }
  if (assessment.sizeTier < bestSizeTier) {
    return bestSizeTier >= 3
      ? 'Excluded from pricing comps because stronger exact-size matches exist.'
      : 'Excluded from pricing comps because stronger size-aligned matches exist.'
  }
  if (assessment.listing.distanceBand !== 'near' && assessment.listing.distanceBand !== 'mid') {
    return 'Shown for context only because it sits outside the near/mid pricing radius.'
  }
  return 'Shown for context only; stronger pricing comps were retained instead.'
}

function shouldAttemptSearchAdaptation(
  liveState: NormalizedCatalogGroupLiveState,
  evidenceByProductId: Record<number, ProductPricingMarketEvidence>,
): boolean {
  return liveState.products.some((product) => (evidenceByProductId[product.productId]?.pricingEligibleListingCount ?? 0) < MIN_PRICING_ELIGIBLE_COMP_COUNT)
}

async function requestPricingSearchAdaptation(input: {
  categoryId: string | null
  currentListings: ListingPriceCandidate[]
  deterministicSearchTerms: string[]
  liveState: NormalizedCatalogGroupLiveState
  primarySearchTerm: string | null
  productEvidenceById: Record<number, ProductPricingMarketEvidence>
}): Promise<{ rationale: string; searchTerms: string[] } | null> {
  const env = getWorkerEnv()
  if (!env.bedrockMantleBearerToken) {
    return null
  }

  const response = await fetchJsonWithRetry({
    body: JSON.stringify({
      max_tokens: 1200,
      messages: [
        {
          role: 'system',
          content: [
            'You adapt Lit Alerts product-family search terms for Freshly Baked NYC pricing research.',
            'Return only valid JSON shaped as {"adaptation": {"rationale": string, "searchTerms": string[]}}.',
            'Suggest at most 4 short search terms, usually 1-3 words each.',
            'The terms must be literal substrings likely to appear in retailer menu names.',
            'Brand and category are already locked outside this prompt, so do not repeat the brand name unless it is essential inside the family token.',
            'Avoid generic words like vape, gummies, flower, preroll, disposable, or size-only phrases unless paired with a distinctive family token.',
            'Prefer rare cultivar, flavor, family, or subline phrases that broaden discovery without crossing into unrelated products.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            currentEvidence: input.liveState.products.map((product) => ({
              currentEligibleCompCount: input.productEvidenceById[product.productId]?.pricingEligibleListingCount ?? 0,
              currentListingCount: input.productEvidenceById[product.productId]?.listingCount ?? 0,
              productName: product.name,
              tab: product.tab,
            })),
            currentSearchTerm: input.primarySearchTerm,
            deterministicSearchTerms: input.deterministicSearchTerms,
            existingListingSamples: input.currentListings.slice(0, 20).map((listing) => ({
              distanceBand: listing.distanceBand,
              listingName: listing.listingName,
            })),
            productFamily: {
              brand: input.liveState.brand,
              category: input.liveState.category,
              categoryId: input.categoryId,
              groupFullName: input.liveState.groupFullName,
              groupName: input.liveState.groupName,
              strain: input.liveState.strain,
              subcategory: input.liveState.subcategory,
            },
          }, null, 2),
        },
      ],
      model: PRICING_SEARCH_ADAPTATION_MODEL,
      response_format: { type: 'json_object' },
      temperature: 0.1,
      top_p: 0.2,
    }),
    headers: {
      Authorization: `Bearer ${env.bedrockMantleBearerToken}`,
      'Content-Type': 'application/json',
    },
    maxAttempts: PRICING_SEARCH_ADAPTATION_MAX_ATTEMPTS,
    method: 'POST',
    requestLabel: 'Pricing search adaptation',
    retryBaseDelayMs: PRICING_SEARCH_ADAPTATION_RETRY_BASE_DELAY_MS,
    timeoutMs: env.llmRequestTimeoutMs,
    url: `${env.bedrockMantleBaseUrl}/chat/completions`,
  })

  const parsedEnvelope = PricingSearchAdaptationEnvelopeSchema.parse(JSON.parse(extractChatCompletionContent(JSON.stringify(response))))
  const searchTerms = Array.from(new Set(parsedEnvelope.adaptation.searchTerms.map((term) => normalizeInlineText(term)).filter((term): term is string => term.length > 0)))
    .slice(0, PRICING_SEARCH_ADAPTATION_MAX_TERMS)
  if (searchTerms.length === 0) {
    return null
  }

  return {
    rationale: parsedEnvelope.adaptation.rationale,
    searchTerms,
  }
}

function dedupeListingCandidates(listings: ListingPriceCandidate[]): ListingPriceCandidate[] {
  const deduped = new Map<string, ListingPriceCandidate>()
  for (const listing of listings) {
    const key = [
      normalizeDispensaryKey(listing.dispensaryName),
      listing.listingName.toLowerCase(),
      listing.preTaxPrice.toFixed(2),
      listing.postTaxPrice.toFixed(2),
    ].join('::')
    const existing = deduped.get(key)
    if (!existing || compareListingSpecificity(listing, existing) < 0) {
      deduped.set(key, listing)
    }
  }
  return Array.from(deduped.values())
}

function compareListingSpecificity(left: ListingPriceCandidate, right: ListingPriceCandidate): number {
  const leftRank = distanceBandRank(left.distanceBand)
  const rightRank = distanceBandRank(right.distanceBand)
  if (leftRank !== rightRank) {
    return leftRank - rightRank
  }
  if (left.distanceMiles !== null && right.distanceMiles !== null && left.distanceMiles !== right.distanceMiles) {
    return left.distanceMiles - right.distanceMiles
  }
  if (left.source !== right.source) {
    return left.source === 'nearby' ? -1 : 1
  }
  return 0
}

function distanceBandRank(distanceBand: PricingDistanceBand): number {
  switch (distanceBand) {
    case 'near':
      return 0
    case 'mid':
      return 1
    case 'far':
      return 2
    case 'very_far':
      return 3
    default:
      return 4
  }
}

export function deriveSearchTerms(liveState: NormalizedCatalogGroupLiveState): string[] {
  const baseText = stripBrandPrefix(liveState.groupName || liveState.groupFullName, liveState.brand)
  const candidates = new Set<string>()
  for (const rawVariantText of deriveSearchTextVariants(baseText)) {
    const variantText = stripBrandPrefix(rawVariantText, liveState.brand)
    const tokenMatches = Array.from(variantText.matchAll(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g)).map((match) => match[0])
    const meaningfulTokens = tokenMatches.filter((token) => {
      const normalizedToken = token.toLowerCase()
      return !GENERIC_SEARCH_WORDS.has(normalizedToken) && !/^\d/.test(normalizedToken)
    })

    if (variantText) {
      candidates.add(variantText)
    }
    for (let windowSize = Math.min(3, meaningfulTokens.length); windowSize >= 1; windowSize -= 1) {
      for (let start = 0; start <= meaningfulTokens.length - windowSize; start += 1) {
        candidates.add(meaningfulTokens.slice(start, start + windowSize).join(' '))
      }
    }
  }

  return Array.from(candidates).filter((candidate) => candidate.length > 0)
}

function deriveSearchTextVariants(baseText: string): string[] {
  const normalizedBase = normalizeInlineText(baseText)
  const strippedAnnotationBase = stripBespokeSearchAnnotations(normalizedBase)
  return Array.from(new Set([strippedAnnotationBase, normalizedBase].filter((value) => value.length > 0)))
}

function buildSearchTermLabel(searchTerms: string[]): string {
  if (searchTerms.length === 0) {
    return 'the attempted search terms'
  }
  if (searchTerms.length === 1) {
    return `search term "${searchTerms[0]}"`
  }
  return `search terms ${searchTerms.map((term) => `"${term}"`).join(', ')}`
}

function resolveLitAlertsCategoryId(liveState: NormalizedCatalogGroupLiveState): string | null {
  const categoryKey = normalizeCategoryKey(liveState.category)
  if (categoryKey === 'pre rolls' || categoryKey === 'prerolls') {
    return '2'
  }
  if (categoryKey === 'vapes' || categoryKey === 'vaporizers') {
    return '4'
  }
  return null
}

function isCategoryCompatible(liveState: NormalizedCatalogGroupLiveState, listingCategory: string | null): boolean {
  const liveCategory = normalizeCategoryKey(liveState.category)
  const competitorCategory = normalizeCategoryKey(listingCategory)
  if (!liveCategory || !competitorCategory) {
    return true
  }
  if (liveCategory === competitorCategory) {
    return true
  }
  if ((liveCategory === 'vapes' || liveCategory === 'vaporizers') && (competitorCategory === 'vapes' || competitorCategory === 'vaporizers')) {
    return true
  }
  if ((liveCategory === 'pre rolls' || liveCategory === 'prerolls') && (competitorCategory === 'pre rolls' || competitorCategory === 'prerolls')) {
    return true
  }
  return false
}

function inferComparableLaneKey(input: {
  category: string | null
  subcategory: string | null
  text: string
}): string | null {
  const categoryKey = normalizeCategoryKey(input.category)
  const subcategoryKey = normalizeCategoryKey(input.subcategory)
  const combinedText = normalizeCategoryKey(`${input.subcategory ?? ''} ${input.text}`)

  if (categoryKey === 'vapes' || categoryKey === 'vaporizers') {
    const deviceKey = subcategoryKey?.includes('disposable') || combinedText.includes('disposable') || combinedText.includes('all in one') || combinedText.includes('aio')
      ? 'disposable'
      : subcategoryKey?.includes('pod') || combinedText.includes('pod')
        ? 'pod'
        : subcategoryKey?.includes('cartridge') || combinedText.includes('cartridge') || combinedText.includes('cart') || combinedText.includes('510')
          ? 'cartridge'
          : 'vape'
    const extractKey = combinedText.includes('live rosin') || combinedText.includes('solventless')
      ? 'live-rosin'
      : combinedText.includes('live resin')
        ? 'live-resin'
        : combinedText.includes('liquid diamonds') || combinedText.includes('diamond')
          ? 'liquid-diamonds'
          : 'standard'
    return `${deviceKey}|${extractKey}`
  }

  if (categoryKey === 'pre rolls' || categoryKey === 'prerolls') {
    // Only the infused-vs-standard split is meaningful here, and it is
    // already derived from `combinedText` (which folds in the catalog
    // subcategory on the product side and the listing name on the
    // listing side). Do NOT prefix the raw `subcategoryKey`: LitAlerts
    // listings always come in with subcategory=null, so a product key
    // like "infused|infused" could never match a listing's bare
    // "infused", forcing every nearby preroll comp to the weak lane.
    return combinedText.includes('infused') || combinedText.includes('hash hole') || combinedText.includes('hash-hole')
      ? 'infused'
      : 'standard'
  }

  if (categoryKey === 'concentrates') {
    if (combinedText.includes('jetpack') || combinedText.includes('diamond')) {
      return 'diamonds'
    }
    if (combinedText.includes('badder') || combinedText.includes('budder')) {
      return 'badder'
    }
    if (combinedText.includes('hash rosin')) {
      return 'hash-rosin'
    }
    if (combinedText.includes('live rosin') || combinedText.includes('solventless')) {
      return 'live-rosin'
    }
    if (combinedText.includes('live resin')) {
      return 'live-resin'
    }
    if (combinedText.includes('shatter')) {
      return 'shatter'
    }
    if (combinedText.includes('crumble')) {
      return 'crumble'
    }
    if (combinedText.includes('sauce')) {
      return 'sauce'
    }
    if (combinedText.includes('wax')) {
      return 'wax'
    }
    if (combinedText.includes('distillate')) {
      return 'distillate'
    }
    if (combinedText.includes('kief')) {
      return 'kief'
    }
    return subcategoryKey || null
  }

  if (categoryKey === 'edibles' || categoryKey === 'beverages') {
    if (combinedText.includes('beverage') || combinedText.includes('drink') || combinedText.includes('soda')) {
      return 'beverage'
    }
    if (combinedText.includes('gummy') || combinedText.includes('chew')) {
      return 'gummy'
    }
    if (combinedText.includes('chocolate')) {
      return 'chocolate'
    }
    if (combinedText.includes('mint') || combinedText.includes('lozenge')) {
      return 'mint'
    }
    if (combinedText.includes('capsule') || combinedText.includes('tablet')) {
      return 'capsule'
    }
    if (combinedText.includes('tincture')) {
      return 'tincture'
    }
    return subcategoryKey || null
  }

  if (categoryKey === 'flower') {
    if (combinedText.includes('smalls') || combinedText.includes('littles')) {
      return 'smalls'
    }
    if (combinedText.includes('shake')) {
      return 'shake'
    }
    if (combinedText.includes('ground')) {
      return 'ground'
    }
    return subcategoryKey || null
  }

  return subcategoryKey || null
}

/**
 * A per-brand (vendor) size-labelling convention. Some manufacturers
 * label a multipack by its package TOTAL weight, others (and the
 * competitor listings that carry the same SKU) by the per-unit weight.
 * The bare "N x M<measure>" / "N pk M<measure>" strings are genuinely
 * ambiguous, so we key the disambiguation off the brand.
 *
 * NOTE: this is deliberately a small code-resident map, NOT a parsekit
 * config. parsekit is keyed per-tenant (distributor/competitor) and is
 * not wired into the pricing comparator; this convention is a brand
 * semantic that crosses every tenant that carries the brand. If this
 * table grows past a handful of brands, or non-engineers need to edit
 * it without a deploy, promote it to a DB-backed config (see the
 * "advanced path" notes in the run-85 size-parsing investigation).
 */
interface SizeConvention {
  /**
   * For the "N x M<measure>" form, treat M as the package TOTAL weight
   * (so unit = M / N) instead of the per-unit weight. Jeeter's Baby
   * Jeeter prerolls are labelled e.g. "5x 2.5g" = 5 sticks totalling
   * 2.5g (0.5g each).
   */
  multiplierValueIsTotal: boolean
  /**
   * For the "N pk M<measure>" form, treat M as the per-unit weight (so
   * total = N * M) instead of the package total. The same Jeeter SKU
   * shows up at competitors as "5pk .5g" = 5 x 0.5g.
   */
  packValueIsUnit: boolean
  /**
   * Only apply when the parsed measure matches. Guards against mis-
   * applying gram-preroll semantics to mg edibles — e.g. a generic
   * "10x 10mg" gummy pack stays 10 units x 10mg = 100mg total.
   */
  measure: 'g' | 'mg'
}

const JEETER_PREROLL_SIZE_CONVENTION: SizeConvention = {
  multiplierValueIsTotal: true,
  packValueIsUnit: true,
  measure: 'g',
}

/**
 * Resolve the size-labelling convention for a brand, or null when the
 * brand uses the default (multiplier value is per-unit, pack value is
 * the package total).
 */
function resolveSizeConvention(brand: string | null | undefined): SizeConvention | null {
  const brandKey = normalizeBrandKey(brand)
  if (!brandKey) {
    return null
  }
  // "Jeeter" / "Baby Jeeter" gram preroll multipacks. See
  // https://helios.freshlybaked.us/pricing/runs/85 — our SKU
  // "...5x 2.5g" (total 2.5g) was scored against competitor "5pk .5g"
  // (0.5g/stick) and every comp came out size-mismatched/weak.
  if (brandKey.split(' ').includes('jeeter')) {
    return JEETER_PREROLL_SIZE_CONVENTION
  }
  return null
}

// ---------------------------------------------------------------------
// Distribution-aware size disambiguation
// ---------------------------------------------------------------------
//
// A bare multipack size token like "N x M<measure>" / "N pk M<measure>"
// is genuinely ambiguous: is M the per-unit size (total = N*M) or the
// package total (unit = M/N)? Rather than rely solely on a hardcoded
// per-brand rule, we lean on what the catalog actually carries: it is
// vastly more likely that we're seeing a (category, pack, unit) cohort
// we've seen many times before than that a huge deviation occurred
// ("5 x 2.5g" as 12.5g total would be an enormous pre-roll pack — they
// exist, e.g. a 32g jar, but are exceedingly rare and should require a
// manual override to win over an in-distribution reading).
//
// Resolution precedence (see `disambiguateMultipackValue`):
//   manual override > strong distribution signal > brand convention >
//   syntax default ('unit' for the "N x M" form, 'total' for "N pk M").

type SizeValueInterpretation = 'unit' | 'total'

/** A queryable prior over catalog (category, measure, pack, unit) cohorts. */
interface SizeDistributionPrior {
  getCohortCount(input: {
    category: string | null | undefined
    measure: 'g' | 'mg'
    packCount: number
    unitValue: number
  }): number
}

interface SizeDistributionCohort {
  category: string
  measure: 'g' | 'mg'
  packCount: number
  unitValue: number
  count: number
}

/** Bucket a size value deterministically so near-identical units collide. */
function bucketSizeValue(value: number, measure: 'g' | 'mg'): string {
  return measure === 'g'
    ? (Math.round(value * 100) / 100).toFixed(2)
    : (Math.round(value * 10) / 10).toFixed(1)
}

function sizeCohortKey(
  category: string | null | undefined,
  measure: 'g' | 'mg',
  packCount: number,
  unitValue: number,
): string {
  return `${normalizeCategoryKey(category)}|${measure}|${packCount}|${bucketSizeValue(unitValue, measure)}`
}

function buildSizeDistributionPrior(cohorts: SizeDistributionCohort[]): SizeDistributionPrior {
  const counts = new Map<string, number>()
  for (const cohort of cohorts) {
    const key = sizeCohortKey(cohort.category, cohort.measure, cohort.packCount, cohort.unitValue)
    counts.set(key, (counts.get(key) ?? 0) + cohort.count)
  }
  return {
    getCohortCount: ({ category, measure, packCount, unitValue }) =>
      counts.get(sizeCohortKey(category, measure, packCount, unitValue)) ?? 0,
  }
}

// Empirical per-unit cohorts, sourced from a `catalog_groups` query
// (`(category, packOfSize, size.name)` frequencies, n>=3) on 2026-06-11.
// IMPORTANT: these are *true per-unit* cohorts. The raw "Pre-Rolls, 5 x
// 2.5g" rows in that query are Jeeter pack-TOTAL mislabels (true unit
// 0.5g) and are intentionally folded into the 5 x 0.5g cohort below
// rather than seeded as a bogus 2.5g/stick unit — otherwise the prior
// would reinforce the very mislabel we want it to overrule.
const DEFAULT_SIZE_DISTRIBUTION_COHORTS: SizeDistributionCohort[] = [
  // Pre-Rolls (grams, per stick)
  { category: 'pre rolls', measure: 'g', packCount: 1, unitValue: 1, count: 421 },
  { category: 'pre rolls', measure: 'g', packCount: 1, unitValue: 0.5, count: 168 },
  { category: 'pre rolls', measure: 'g', packCount: 5, unitValue: 0.5, count: 147 },
  { category: 'pre rolls', measure: 'g', packCount: 2, unitValue: 0.5, count: 92 },
  { category: 'pre rolls', measure: 'g', packCount: 7, unitValue: 0.5, count: 35 },
  { category: 'pre rolls', measure: 'g', packCount: 6, unitValue: 0.5, count: 26 },
  { category: 'pre rolls', measure: 'g', packCount: 1, unitValue: 1.1, count: 15 },
  { category: 'pre rolls', measure: 'g', packCount: 5, unitValue: 0.7, count: 14 },
  { category: 'pre rolls', measure: 'g', packCount: 10, unitValue: 0.35, count: 13 },
  { category: 'pre rolls', measure: 'g', packCount: 1, unitValue: 2, count: 13 },
  { category: 'pre rolls', measure: 'g', packCount: 1, unitValue: 2.5, count: 13 },
  { category: 'pre rolls', measure: 'g', packCount: 3, unitValue: 0.5, count: 13 },
  { category: 'pre rolls', measure: 'g', packCount: 1, unitValue: 0.75, count: 12 },
  { category: 'pre rolls', measure: 'g', packCount: 1, unitValue: 1.5, count: 10 },
  { category: 'pre rolls', measure: 'g', packCount: 2, unitValue: 0.75, count: 10 },
  { category: 'pre rolls', measure: 'g', packCount: 5, unitValue: 0.4, count: 10 },
  { category: 'pre rolls', measure: 'g', packCount: 5, unitValue: 0.6, count: 8 },
  { category: 'pre rolls', measure: 'g', packCount: 1, unitValue: 0.6, count: 7 },
  { category: 'pre rolls', measure: 'g', packCount: 1, unitValue: 0.7, count: 7 },
  { category: 'pre rolls', measure: 'g', packCount: 2, unitValue: 1, count: 7 },
  { category: 'pre rolls', measure: 'g', packCount: 20, unitValue: 0.35, count: 5 },
  { category: 'pre rolls', measure: 'g', packCount: 14, unitValue: 0.5, count: 5 },
  { category: 'pre rolls', measure: 'g', packCount: 10, unitValue: 1, count: 5 },
  { category: 'pre rolls', measure: 'g', packCount: 4, unitValue: 0.75, count: 4 },
  { category: 'pre rolls', measure: 'g', packCount: 4, unitValue: 1.75, count: 4 },
  { category: 'pre rolls', measure: 'g', packCount: 5, unitValue: 0.75, count: 3 },
  { category: 'pre rolls', measure: 'g', packCount: 5, unitValue: 1.3, count: 3 },
  // Edibles (milligrams, per piece)
  { category: 'edibles', measure: 'mg', packCount: 10, unitValue: 10, count: 256 },
  { category: 'edibles', measure: 'mg', packCount: 20, unitValue: 5, count: 55 },
  { category: 'edibles', measure: 'mg', packCount: 1, unitValue: 10, count: 16 },
  { category: 'edibles', measure: 'mg', packCount: 1, unitValue: 100, count: 16 },
  { category: 'edibles', measure: 'mg', packCount: 2, unitValue: 5, count: 14 },
  { category: 'edibles', measure: 'mg', packCount: 10, unitValue: 5, count: 12 },
  { category: 'edibles', measure: 'mg', packCount: 2, unitValue: 10, count: 10 },
  { category: 'edibles', measure: 'mg', packCount: 5, unitValue: 20, count: 5 },
  { category: 'edibles', measure: 'mg', packCount: 20, unitValue: 2.5, count: 3 },
  { category: 'edibles', measure: 'mg', packCount: 2, unitValue: 50, count: 3 },
]

const DEFAULT_SIZE_DISTRIBUTION_PRIOR = buildSizeDistributionPrior(DEFAULT_SIZE_DISTRIBUTION_COHORTS)

// Distribution decision thresholds. A reading only "wins on distribution"
// when the evidence is unambiguous: either exactly one candidate clears
// MIN_COHORT_COUNT, or the stronger candidate is both >= STRONG_RATIO x
// and >= STRONG_ABSOLUTE_DIFF more than the weaker. Otherwise we defer to
// the brand convention / syntax default so we never make a confident
// wrong call on thin data.
const MIN_COHORT_COUNT = 3
const STRONG_RATIO = 3
const STRONG_ABSOLUTE_DIFF = 5

/**
 * Per-SKU manual overrides that force a size interpretation against the
 * distribution — the "manual effort" escape hatch for genuine outliers
 * (e.g. a real large-format multipack the prior would otherwise read as
 * a common smaller cohort). Keyed by `${brandKey}|${categoryKey}`.
 * Intentionally empty by default; add an entry (or, later, a DB-backed
 * field) when a human confirms an out-of-distribution SKU. Example:
 *   'someheavyhitter|pre rolls': 'unit'  // genuinely 5 x 2.5g = 12.5g
 */
const SIZE_INTERPRETATION_OVERRIDES: Record<string, SizeValueInterpretation> = {}

function resolveSizeInterpretationOverride(
  brand: string | null | undefined,
  category: string | null | undefined,
): SizeValueInterpretation | null {
  const key = `${normalizeBrandKey(brand)}|${normalizeCategoryKey(category)}`
  return SIZE_INTERPRETATION_OVERRIDES[key] ?? null
}

function profileForInterpretation(
  packCount: number,
  value: number,
  measure: 'g' | 'mg',
  interpretation: SizeValueInterpretation,
): ParsedSizeProfile {
  if (interpretation === 'total') {
    return {
      measure,
      packCount,
      totalValue: roundCurrency(value),
      unitValue: roundCurrency(value / packCount),
    }
  }
  return {
    measure,
    packCount,
    totalValue: roundCurrency(value * packCount),
    unitValue: roundCurrency(value),
  }
}

function decideByDistribution(unitCount: number, totalCount: number): SizeValueInterpretation | null {
  const unitKnown = unitCount >= MIN_COHORT_COUNT
  const totalKnown = totalCount >= MIN_COHORT_COUNT
  if (unitKnown && !totalKnown) {
    return 'unit'
  }
  if (totalKnown && !unitKnown) {
    return 'total'
  }
  if (!unitKnown && !totalKnown) {
    return null
  }
  // Both candidates are attested — only override the default when one is
  // decisively more common.
  const [higher, lower, winner] =
    unitCount >= totalCount ? [unitCount, totalCount, 'unit' as const] : [totalCount, unitCount, 'total' as const]
  if (higher >= lower * STRONG_RATIO && higher - lower >= STRONG_ABSOLUTE_DIFF) {
    return winner
  }
  return null
}

interface SizeDisambiguationContext {
  category?: string | null
  prior?: SizeDistributionPrior | null
  /** Interpretation the brand convention implies for this form, or null. */
  conventionInterpretation?: SizeValueInterpretation | null
  /** Manual per-SKU override; beats everything when set. */
  override?: SizeValueInterpretation | null
  /**
   * LLM sanity-check pick, accepted only for ambiguous ties where the
   * distribution prior was silent. Slots in below a strong distribution
   * signal but above the brand convention / syntax default.
   */
  assessedInterpretation?: SizeValueInterpretation | null
  /** Fallback when neither distribution nor convention decides. */
  defaultInterpretation: SizeValueInterpretation
}

/**
 * Resolve an ambiguous multipack size value into a full size profile,
 * preferring the in-distribution catalog cohort. Only call for
 * packCount > 1 with a single clean size value.
 */
function disambiguateMultipackValue(input: {
  packCount: number
  value: number
  measure: 'g' | 'mg'
  context: SizeDisambiguationContext
}): ParsedSizeProfile {
  const { packCount, value, measure, context } = input
  if (context.override) {
    return profileForInterpretation(packCount, value, measure, context.override)
  }
  const prior = context.prior ?? DEFAULT_SIZE_DISTRIBUTION_PRIOR
  // 'unit' interpretation => per-unit is `value`; 'total' => per-unit is `value / packCount`.
  const unitCount = prior.getCohortCount({ category: context.category, measure, packCount, unitValue: value })
  const totalCount = prior.getCohortCount({
    category: context.category,
    measure,
    packCount,
    unitValue: value / packCount,
  })
  const decided =
    decideByDistribution(unitCount, totalCount) ??
    context.assessedInterpretation ??
    context.conventionInterpretation ??
    context.defaultInterpretation
  return profileForInterpretation(packCount, value, measure, decided)
}

/** The disambiguation inputs for an ambiguous catalog multipack value. */
interface CatalogMultipackDisambiguation {
  packCount: number
  value: number
  measure: 'g' | 'mg'
  conventionInterpretation: SizeValueInterpretation | null
  defaultInterpretation: SizeValueInterpretation
}

/**
 * Re-derive the ambiguous (value, packCount, measure) + convention/default
 * for one of OUR catalog SKUs the same way `resolveCatalogSizeProfile` /
 * `parseSizeProfile` do, OR null when the SKU is not an ambiguous
 * multipack (single unit, no recognised weight, etc.).
 *
 * This is *advisory only* — it decides whether to ask the LLM and which
 * two candidate parses to show it. The deterministic resolver remains the
 * sole source of truth for the final value, so a drift here can only
 * change whether/how we escalate, never the committed parse.
 */
function extractCatalogMultipackDisambiguation(input: {
  name: string
  tab: string
  sizeName: string | null
  packOfSize: number | null
  brand?: string | null
}): CatalogMultipackDisambiguation | null {
  const convention = resolveSizeConvention(input.brand)
  const structuredSize = parseSizeToken(input.sizeName)
  const text = normalizeInlineText(`${input.name} ${input.tab}`)
  if (structuredSize) {
    const packCount =
      input.packOfSize !== null && Number.isFinite(input.packOfSize) && input.packOfSize >= 1
        ? input.packOfSize
        : parsePackCount(text)
    if (packCount <= 1) {
      return null
    }
    return {
      packCount,
      value: structuredSize.value,
      measure: structuredSize.measure,
      conventionInterpretation:
        convention?.multiplierValueIsTotal === true && convention.measure === structuredSize.measure ? 'total' : null,
      defaultInterpretation: 'unit',
    }
  }
  // No structured size token → mirror parseSizeProfile's free-text forms.
  const explicitMultipack = text.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?|\.\d+)\s*(mg|g)\b/i)
  if (explicitMultipack) {
    const packCount = Number.parseInt(explicitMultipack[1], 10)
    if (packCount <= 1) {
      return null
    }
    const measure = explicitMultipack[3].toLowerCase() as 'g' | 'mg'
    return {
      packCount,
      value: Number.parseFloat(explicitMultipack[2]),
      measure,
      conventionInterpretation:
        convention?.multiplierValueIsTotal === true && convention.measure === measure ? 'total' : null,
      defaultInterpretation: 'unit',
    }
  }
  const packCount = parsePackCount(text)
  if (packCount <= 1) {
    return null
  }
  const sizeValues = extractSizeValues(text)
  const measure = chooseDominantMeasure(sizeValues)
  if (measure === null) {
    return null
  }
  const matchingValues = sizeValues.filter((value) => value.measure === measure).map((value) => value.value)
  if (matchingValues.length === 0) {
    return null
  }
  const value = Math.max(...matchingValues)
  return {
    packCount,
    value,
    measure,
    conventionInterpretation:
      convention?.packValueIsUnit === true && convention.measure === measure ? 'unit' : null,
    defaultInterpretation: 'total',
  }
}

/** A catalog multipack whose size interpretation the prior cannot settle. */
interface CatalogMultipackAmbiguity extends CatalogMultipackDisambiguation {
  unitCount: number
  totalCount: number
  candidateUnit: ParsedSizeProfile
  candidateTotal: ParsedSizeProfile
}

/**
 * Returns the ambiguity descriptor for a catalog SKU ONLY when an LLM
 * sanity check would actually help: there is an ambiguous multipack
 * value, there is no manual override, and the distribution prior is
 * silent (neither `unit` nor `total` wins decisively). In every other
 * case it returns null and the caller stays fully deterministic.
 */
function inspectCatalogMultipackAmbiguity(input: {
  name: string
  tab: string
  sizeName: string | null
  packOfSize: number | null
  brand?: string | null
  category?: string | null
  prior?: SizeDistributionPrior | null
}): CatalogMultipackAmbiguity | null {
  if (resolveSizeInterpretationOverride(input.brand, input.category)) {
    return null
  }
  const disambig = extractCatalogMultipackDisambiguation(input)
  if (!disambig) {
    return null
  }
  const prior = input.prior ?? DEFAULT_SIZE_DISTRIBUTION_PRIOR
  const unitCount = prior.getCohortCount({
    category: input.category,
    measure: disambig.measure,
    packCount: disambig.packCount,
    unitValue: disambig.value,
  })
  const totalCount = prior.getCohortCount({
    category: input.category,
    measure: disambig.measure,
    packCount: disambig.packCount,
    unitValue: disambig.value / disambig.packCount,
  })
  if (decideByDistribution(unitCount, totalCount) !== null) {
    // Distribution decides confidently — no LLM needed.
    return null
  }
  return {
    ...disambig,
    unitCount,
    totalCount,
    candidateUnit: profileForInterpretation(disambig.packCount, disambig.value, disambig.measure, 'unit'),
    candidateTotal: profileForInterpretation(disambig.packCount, disambig.value, disambig.measure, 'total'),
  }
}

/**
 * Parse a recognised weight from a structured (value, units) pair into
 * grams/milligrams. Returns null when the units are NOT a clean weight
 * (e.g. LitAlerts emits `units: "packtransdermalpatches"` or
 * `"mg (pack of 40)"` for some edibles/accessories) so callers can fall
 * back to free-text parsing instead of trusting garbage.
 */
function parseStructuredWeight(
  amount: number | string | null | undefined,
  units: string | null | undefined,
): { measure: 'g' | 'mg'; value: number } | null {
  const rawValue =
    typeof amount === 'number'
      ? amount
      : Number.parseFloat(String(amount ?? '').replace(/[$,\s]/g, ''))
  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    return null
  }
  const unit = normalizeInlineText(units).toLowerCase()
  if (unit === 'g' || unit === 'gram' || unit === 'grams') {
    return { measure: 'g', value: rawValue }
  }
  if (unit === 'mg' || unit === 'milligram' || unit === 'milligrams') {
    return { measure: 'mg', value: rawValue }
  }
  if (unit === 'oz' || unit === 'ounce' || unit === 'ounces') {
    return { measure: 'g', value: rawValue * 28.3495 }
  }
  return null
}

/**
 * Parse a clean single size token ("2.5g", "0.5 g", "10mg", ".5g") into
 * a normalised weight. Used for Sweed's `size.name` field, which is a
 * tidy per-variant size string. Returns null when nothing parses.
 */
function parseSizeToken(text: string | null | undefined): { measure: 'g' | 'mg'; value: number } | null {
  const values = extractSizeValues(normalizeInlineText(text ?? ''))
  const measure = chooseDominantMeasure(values)
  if (measure === null) {
    return null
  }
  const matching = values.filter((value) => value.measure === measure).map((value) => value.value)
  if (matching.length === 0) {
    return null
  }
  return { measure, value: Math.max(...matching) }
}

/**
 * Build the size profile for one of OUR catalog SKUs. Prefers the
 * structured Sweed fields already normalised at catalog-sync time
 * (`packOfSize` = pack count, `size.name` = per-variant size token)
 * over re-deriving everything from the free-text product name. The
 * size *token* still carries the per-unit-vs-total ambiguity (most
 * brands label "Nx Mg" with M = per-stick, Jeeter with M = pack
 * total), so we resolve that with the per-brand convention. Falls back
 * to free-text name/tab parsing when the structured fields are absent.
 */
function resolveCatalogSizeProfile(input: {
  name: string
  tab: string
  sizeName: string | null
  packOfSize: number | null
  brand?: string | null
  category?: string | null
  prior?: SizeDistributionPrior | null
  /** Optional LLM tie-break; only consulted when distribution is silent. */
  assessedInterpretation?: SizeValueInterpretation | null
}): ParsedSizeProfile {
  const convention = resolveSizeConvention(input.brand)
  const override = resolveSizeInterpretationOverride(input.brand, input.category)
  const structuredSize = parseSizeToken(input.sizeName)
  const packCount =
    input.packOfSize !== null && Number.isFinite(input.packOfSize) && input.packOfSize >= 1
      ? input.packOfSize
      : parsePackCount(`${input.name} ${input.tab}`)
  if (structuredSize) {
    const { measure, value } = structuredSize
    if (packCount > 1) {
      // sizeName carries the same per-unit-vs-total ambiguity as the
      // "N x M" name token, so resolve it the same way.
      return disambiguateMultipackValue({
        packCount,
        value,
        measure,
        context: {
          category: input.category,
          prior: input.prior,
          override,
          assessedInterpretation: input.assessedInterpretation,
          conventionInterpretation:
            convention?.multiplierValueIsTotal === true && convention.measure === measure ? 'total' : null,
          defaultInterpretation: 'unit',
        },
      })
    }
    return {
      measure,
      packCount,
      totalValue: roundCurrency(value),
      unitValue: roundCurrency(value),
    }
  }
  return parseSizeProfile(`${input.name} ${input.tab}`, {
    category: input.category,
    convention,
    prior: input.prior,
    override,
    assessedInterpretation: input.assessedInterpretation,
  })
}

/**
 * Build the size profile for a competitor listing. LitAlerts ships a
 * structured per-config `amount`/`units` pair, but it is NOT consistent:
 * for one and the same Baby Jeeter 5-pack, retailers report `amount` as
 * 2.5g (the pack total), 0.5g (per-stick), or even "5 pk". So we can't
 * blindly treat it as the total — when there's a multipack we run the
 * clean weight through the same distribution-aware disambiguator as
 * everywhere else (which reads value=2.5 and value=0.5 both as a 2.5g
 * total / 0.5g unit for a 5-pack pre-roll). Singles use the value as-is.
 * When `amount`/`units` is missing or junk we fall back to free-text
 * parsing of the listing name.
 */
function resolveListingSizeProfile(input: {
  listingName: string
  amount: number | string | null | undefined
  units: string | null | undefined
  brand?: string | null
  category?: string | null
  prior?: SizeDistributionPrior | null
}): ParsedSizeProfile {
  const structured = parseStructuredWeight(input.amount, input.units)
  if (structured) {
    const packCount = parsePackCount(input.listingName)
    if (packCount > 1) {
      const convention = resolveSizeConvention(input.brand)
      return disambiguateMultipackValue({
        packCount,
        value: structured.value,
        measure: structured.measure,
        context: {
          category: input.category,
          prior: input.prior,
          conventionInterpretation:
            convention?.multiplierValueIsTotal === true && convention.measure === structured.measure
              ? 'total'
              : null,
          // LitAlerts `amount` is the pack total more often than not, so
          // bias the undecided case that way.
          defaultInterpretation: 'total',
        },
      })
    }
    return {
      measure: structured.measure,
      packCount,
      totalValue: roundCurrency(structured.value),
      unitValue: roundCurrency(structured.value),
    }
  }
  return parseSizeProfile(input.listingName, {
    category: input.category,
    convention: resolveSizeConvention(input.brand),
    prior: input.prior,
  })
}

interface ParseSizeOptions {
  category?: string | null
  convention?: SizeConvention | null
  prior?: SizeDistributionPrior | null
  override?: SizeValueInterpretation | null
  assessedInterpretation?: SizeValueInterpretation | null
}

function parseSizeProfile(text: string, options: ParseSizeOptions = {}): ParsedSizeProfile {
  const { category, convention, prior, override, assessedInterpretation } = options
  const normalizedText = normalizeInlineText(text)
  const explicitMultipack = normalizedText.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?|\.\d+)\s*(mg|g)\b/i)
  if (explicitMultipack) {
    const packCount = Number.parseInt(explicitMultipack[1], 10)
    const matchedValue = Number.parseFloat(explicitMultipack[2])
    const measure = explicitMultipack[3].toLowerCase() as 'g' | 'mg'
    if (packCount > 1) {
      // "N x M" form: legacy default is M = per-unit; Jeeter-style
      // convention flips it to M = total. Distribution decides first.
      return disambiguateMultipackValue({
        packCount,
        value: matchedValue,
        measure,
        context: {
          category,
          prior,
          override,
          assessedInterpretation,
          conventionInterpretation:
            convention?.multiplierValueIsTotal === true && convention.measure === measure ? 'total' : null,
          defaultInterpretation: 'unit',
        },
      })
    }
    return {
      measure,
      packCount,
      totalValue: roundCurrency(matchedValue),
      unitValue: roundCurrency(matchedValue),
    }
  }

  const packCount = parsePackCount(normalizedText)
  const sizeValues = extractSizeValues(normalizedText)
  const measure = chooseDominantMeasure(sizeValues)
  const matchingValues = sizeValues.filter((value) => value.measure === measure).map((value) => value.value)
  if (measure === null || matchingValues.length === 0) {
    return {
      measure: null,
      packCount,
      totalValue: null,
      unitValue: null,
    }
  }

  const sortedValues = [...matchingValues].sort((left, right) => left - right)
  const matchedValue = sortedValues[sortedValues.length - 1]
  if (packCount > 1) {
    // "N pk M" form: legacy default is M = package total; Jeeter-style
    // convention flips it to M = per-unit. Distribution decides first.
    return disambiguateMultipackValue({
      packCount,
      value: matchedValue,
      measure,
      context: {
        category,
        prior,
        override,
        assessedInterpretation,
        conventionInterpretation:
          convention?.packValueIsUnit === true && convention.measure === measure ? 'unit' : null,
        defaultInterpretation: 'total',
      },
    })
  }
  return {
    measure,
    packCount,
    totalValue: roundCurrency(matchedValue),
    unitValue: roundCurrency(matchedValue),
  }
}

function extractSizeValues(text: string): Array<{ measure: 'g' | 'mg'; value: number }> {
  const matches = Array.from(text.matchAll(/(\d+(?:\.\d+)?|\.\d+)\s*(mg|g|oz|ounce|ounces)\b/gi))
  return matches
    .map((match) => {
      const rawValue = Number.parseFloat(match[1])
      const rawMeasure = match[2].toLowerCase()
      if (!Number.isFinite(rawValue)) {
        return null
      }
      if (rawMeasure === 'mg' || rawMeasure === 'g') {
        return { measure: rawMeasure, value: rawValue } as const
      }
      return { measure: 'g' as const, value: rawValue * 28.3495 }
    })
    .filter((value): value is { measure: 'g' | 'mg'; value: number } => value !== null)
}

function chooseDominantMeasure(values: Array<{ measure: 'g' | 'mg'; value: number }>): 'g' | 'mg' | null {
  if (values.length === 0) {
    return null
  }
  const gramCount = values.filter((value) => value.measure === 'g').length
  const milligramCount = values.length - gramCount
  return gramCount >= milligramCount ? 'g' : 'mg'
}

function classifyLaneTier(productLaneKey: string | null, listingLaneKey: string | null): 0 | 1 | 2 | 3 {
  if (productLaneKey && listingLaneKey) {
    return productLaneKey === listingLaneKey ? 3 : 1
  }
  if (productLaneKey || listingLaneKey) {
    return 2
  }
  return 2
}

function classifySizeTier(productSize: ParsedSizeProfile, listingSize: ParsedSizeProfile): 0 | 1 | 2 | 3 {
  if ((productSize.packCount > 1 || listingSize.packCount > 1) && productSize.packCount !== listingSize.packCount) {
    return 0
  }
  if (productSize.measure && listingSize.measure && productSize.measure !== listingSize.measure) {
    return 0
  }

  const measure = productSize.measure ?? listingSize.measure
  const exactTolerance = measure === 'mg' ? 2 : 0.02
  const fallbackTolerance = measure === 'mg' ? 10 : 0.11
  const totalDelta = computeSizeDelta(productSize.totalValue, listingSize.totalValue)
  const unitDelta = computeSizeDelta(productSize.unitValue, listingSize.unitValue)

  if (totalDelta !== null && totalDelta <= exactTolerance) {
    return 3
  }
  if (unitDelta !== null && unitDelta <= exactTolerance) {
    return 3
  }
  if (totalDelta !== null && totalDelta <= fallbackTolerance) {
    return 2
  }
  if (unitDelta !== null && unitDelta <= fallbackTolerance) {
    return 2
  }
  if (productSize.measure === null || listingSize.measure === null) {
    return 1
  }
  if (productSize.measure === listingSize.measure && (productSize.totalValue === null || listingSize.totalValue === null || productSize.unitValue === null || listingSize.unitValue === null)) {
    return 1
  }
  if (productSize.packCount === 1 && listingSize.packCount === 1 && productSize.measure === listingSize.measure) {
    return 1
  }
  return 0
}

function computeSizeDelta(left: number | null, right: number | null): number | null {
  if (left === null || right === null) {
    return null
  }
  return Math.abs(left - right)
}

function parsePackCount(text: string): number {
  // Accept "5pk", "5 pack", and hyphenated "5-pack" (LitAlerts retailers
  // write the pack size every which way; missing it causes a spurious
  // pack-count mismatch in classifySizeTier).
  const exact = text.match(/(\d+)\s*-?\s*(?:pk|pack|packs)\b/i)
  if (exact) {
    return Number.parseInt(exact[1], 10)
  }
  return 1
}

function parseLitAlertsPrice(value: number | string | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.replace(/[$,]/g, '').trim()
  if (!normalized) {
    return null
  }
  const parsed = Number.parseFloat(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeBrandKey(value: string | null | undefined): string {
  return normalizeInlineText(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function normalizeCategoryKey(value: string | null | undefined): string {
  return normalizeInlineText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function stripParentheticalSuffix(value: string): string {
  return value.replace(/\s*\([^)]*\)\s*$/g, '').trim()
}

function stripBrandPrefix(text: string, brand: string | null): string {
  const normalizedText = normalizeInlineText(text)
  const normalizedBrand = normalizeInlineText(brand)
  if (!normalizedBrand) {
    return normalizedText
  }

  const loweredText = normalizedText.toLowerCase()
  const loweredBrand = normalizedBrand.toLowerCase()
  if (loweredText === loweredBrand) {
    return ''
  }
  if (loweredText.startsWith(`${loweredBrand} `)) {
    return normalizedText.slice(normalizedBrand.length).trim()
  }
  return normalizedText
}

function stripBespokeSearchAnnotations(text: string): string {
  const normalizedText = normalizeInlineText(text)
  const hasPotencyAnnotation = SEARCH_ANNOTATION_CANNABINOID_PATTERN.test(normalizedText) || SEARCH_ANNOTATION_POTENCY_PATTERN.test(normalizedText)
  let stripped = normalizedText.replace(/\(([^)]*)\)/g, (fullMatch, innerText: string) => {
    if (isBespokeSearchAnnotation(innerText)) {
      return ' '
    }
    return fullMatch
  })

  if (hasPotencyAnnotation) {
    stripped = stripped.replace(SEARCH_ANNOTATION_RATIO_PATTERN, ' ')
  }

  return normalizeInlineText(stripped)
}

function isBespokeSearchAnnotation(text: string): boolean {
  const normalizedText = normalizeInlineText(text)
  return SEARCH_ANNOTATION_CANNABINOID_PATTERN.test(normalizedText)
    || SEARCH_ANNOTATION_POTENCY_PATTERN.test(normalizedText)
    || (SEARCH_ANNOTATION_RATIO_PATTERN.test(normalizedText) && /\d+(?:\.\d+)?\s*mg/i.test(normalizedText))
}

function normalizeDispensaryKey(value: string | null | undefined): string {
  return normalizeInlineText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function normalizeInlineText(value: string | number | null | undefined): string {
  return String(value ?? '')
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(' ')
    .trim()
}

function extractChatCompletionContent(payloadText: string): string {
  const payload = JSON.parse(payloadText) as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> }
  const firstChoice = payload.choices?.[0]
  const content = firstChoice?.message?.content
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    const joined = content
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .join('')
      .trim()
    if (joined) {
      return joined
    }
  }

  throw new Error('Pricing search adaptation returned no assistant content.')
}

function truncate(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 240) {
    return normalized
  }
  return `${normalized.slice(0, 239)}…`
}

function buildPricingMarketFailurePageMessage(
  failureContext: string,
  liveState: NormalizedCatalogGroupLiveState,
  error: unknown,
): string {
  const brandLabel = liveState.brand ?? 'Unknown brand'
  const groupLabel = liveState.groupFullName || liveState.groupName || `group ${liveState.groupId}`
  return `${failureContext}: pricing market research failed for ${brandLabel} / ${groupLabel} (group ${liveState.groupId}): ${buildUnknownErrorMessage(error)}`
}

function buildUnknownErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return 'Unknown pricing market error.'
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function isRetryableMarketStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

function isRetryableMarketTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return error.name === 'AbortError' || error.name === 'TimeoutError' || /timed out|timeout|network|fetch failed|socket hang up/i.test(error.message)
}

async function fetchJsonWithRetry(input: {
  body?: string
  headers: Record<string, string>
  maxAttempts: number
  method: 'GET' | 'POST'
  requestLabel: string
  retryBaseDelayMs: number
  timeoutMs: number
  url: string
}): Promise<unknown> {
  for (let attempt = 0; attempt < input.maxAttempts; attempt += 1) {
    let response: Response
    try {
      response = await fetch(input.url, {
        body: input.body,
        headers: input.headers,
        method: input.method,
        signal: AbortSignal.timeout(input.timeoutMs),
      })
    } catch (error) {
      if (attempt + 1 < input.maxAttempts && isRetryableMarketTransportError(error)) {
        await delayPricingMarketRetry(attempt, input.retryBaseDelayMs)
        continue
      }
      if (isRetryableMarketTransportError(error)) {
        throw new RetryableWorkerError(buildTransportErrorMessage(input.requestLabel, error))
      }
      throw error
    }

    const responseText = await response.text()
    if (!response.ok) {
      const message = `${input.requestLabel} failed: HTTP ${response.status} ${response.statusText} ${truncate(responseText)}`
      if (attempt + 1 < input.maxAttempts && isRetryableMarketStatus(response.status)) {
        await delayPricingMarketRetry(attempt, input.retryBaseDelayMs)
        continue
      }
      if (isRetryableMarketStatus(response.status)) {
        throw new RetryableWorkerError(message)
      }
      throw new Error(message)
    }

    try {
      return JSON.parse(responseText)
    } catch (error) {
      const message = `${input.requestLabel} returned invalid JSON: ${truncate(responseText)}`
      if (attempt + 1 < input.maxAttempts) {
        await delayPricingMarketRetry(attempt, input.retryBaseDelayMs)
        continue
      }
      if (error instanceof SyntaxError) {
        throw new RetryableWorkerError(message)
      }
      throw new Error(message)
    }
  }

  throw new RetryableWorkerError(`${input.requestLabel} exhausted all retry attempts.`)
}

function buildTransportErrorMessage(requestLabel: string, error: unknown): string {
  if (error instanceof Error) {
    return `${requestLabel} transport failed: ${error.message}`
  }
  return `${requestLabel} transport failed unexpectedly.`
}

async function delayPricingMarketRetry(attempt: number, baseDelayMs: number): Promise<void> {
  // Sub-exponential power-law backoff: base * (attempt+1)^1.5
  // (repo-wide standing rule — see workerLoop.getRetryDelayMs).
  // `attempt` is 0-indexed at the first failure, so we use
  // (attempt+1) to keep the first retry at the base delay.
  const delayMs = Math.min(Math.round(baseDelayMs * Math.pow(attempt + 1, 1.5)), 8000)
  await new Promise((resolve) => setTimeout(resolve, delayMs))
}
