/**
 * Pure catalog ↔ LitAlerts-fuzzy candidate scoring (issue #58, task T2).
 *
 * Extracted verbatim from `loadGroupReview`'s per-fuzzy scoring loop so the
 * exact same production matching powers BOTH:
 *   - the per-catalog-group Market Data review bundle (`loadGroupReview`), and
 *   - the brand-categorical-family matching-quality audit surface
 *     (`loadBrandFamilyMarketMatch`).
 *
 * Keeping this in one pure, unit-tested function is the whole point of the
 * audit page: it can only claim "this is how the REAL matcher scored it" if
 * there is exactly one scorer. No DB / clock / network reads — every input is
 * passed in by the caller.
 *
 * Hard gates reproduced (identical order/semantics to the original loop):
 *   #1 category — a candidate whose canonical category disagrees with the
 *      catalog's is dropped outright.
 *   #2 shared significant name token — the candidate must share at least one
 *      significant token with the OWNING catalog group's name (skipped when the
 *      group has no significant tokens). Applied per variant target so a
 *      family spanning several groups gates each candidate against the group
 *      that actually owns the variant being scored — never a cross-group union.
 *   #3 per-variant size family — a candidate is only scored against a variant
 *      whose size family it plausibly belongs to.
 */

import {
  canonicalCategoryNorm,
  extractSignificantNameTokens,
  parseSizeProfile,
  sameSizeFamily,
} from '../../shared/marketMatch/listingParse.js'
import {
  applyVerdictPostFilter,
  scoreCatalogFuzzyFactors,
  type CatalogProfile,
  type FuzzyProfile,
  type MarketMatchVerdict,
  type ScoreFactors,
} from '../../shared/marketMatch/confidence.js'

/** One `fuzzy_skus` row as loaded from the DB and scored. */
export interface FuzzySkuRow {
  id: number
  sourceKind: string
  sourceListingId: string
  rawInputJsonb: unknown
  brandNorm: string | null
  categoryNorm: string | null
  subcategoryNorm: string | null
  sizeGNorm: number | null
  sizeMgNorm: number | null
  packCountNorm: number | null
  strainNorm: string | null
}

export interface CatalogVariant {
  catalogProductId: number
  name: string | null
  shortName: string | null
  tab: string | null
  sku: string | null
  sizeName: string | null
  sizeGNorm: number | null
  sizeMgNorm: number | null
  packCountNorm: number | null
  imageUrl: string | null
  price: number | null
  /** Stable key for grouping variants by their size family. */
  sizeKey: string
  sizeLabel: string
}

export interface MarketMatchCandidate {
  fuzzy: FuzzySkuRow
  rawScore: number
  finalScore: number
  factors: ScoreFactors
  liveVerdict: MarketMatchVerdict | null
  listingUrl: string | null
  dispensaryName: string | null
  /**
   * LitAlerts dashboard imageUrl for this listing's product, sourced from
   * `litalerts_product_images` / the partner-API imageUrl. Null if we have no
   * image captured for this productId yet.
   */
  imageUrl: string | null
  /** Which catalog variant this candidate scored best against. */
  matchedCatalogProductId: number | null
  /** Stable key for the size family the matched variant belongs to. */
  matchedSizeKey: string
  matchedSizeLabel: string
}

/**
 * One catalog variant target the scorer ranks a fuzzy against, plus the
 * per-variant context the gates need. For a single-group review every target
 * shares the same `gate2Tokens` (the group's name tokens); for a
 * brand-categorical-family each target carries ITS OWNING group's tokens.
 */
export interface VariantScoringTarget {
  /** The catalog variant, or null for the "group has no parseable variant" arm. */
  variant: CatalogVariant | null
  /** Full catalog profile scored against this target. */
  profile: CatalogProfile
  /**
   * The owning group's significant name tokens — HARD GATE #2 input. Empty set
   * means "this group has nothing to require a shared token with" → gate #2 is
   * skipped for this target.
   */
  gate2Tokens: ReadonlySet<string>
}

export interface FuzzyCandidateScoringInput {
  /**
   * The set of LitAlerts brand_norm spellings that count as the catalog's
   * (override-aware) brand — used to grant the brand-alias factor.
   */
  effectiveBrandSet: ReadonlySet<string>
  /** The catalog's effective brand norm (for the legacy listing-text alias rescue). */
  catalogBrandNorm: string | null
  /** The catalog's canonical category family (HARD GATE #1). */
  catalogCategoryCanonical: string | null
  /** Brand text used to strip brand tokens when tokenizing listing names. */
  brandTextForTokens: string | null
  /** Category text used to strip category tokens when tokenizing listing names. */
  categoryTextForTokens: string | null
  /** Catalog variant targets to rank the fuzzy against (never empty). */
  variantTargets: ReadonlyArray<VariantScoringTarget>
  /** fuzzy_sku.id → cached LitAlerts image URL. */
  imageByFuzzyId: ReadonlyMap<number, string>
}

/**
 * Score one fuzzy_sku against a catalog context's variant targets, returning
 * the best (variant, score) pick as a `MarketMatchCandidate`, or null when the
 * fuzzy is gated out entirely (category mismatch, no shared name token against
 * any owning group, or no size-compatible variant).
 *
 * This is a verbatim extraction of the original `loadGroupReview` per-fuzzy
 * loop; the only structural change is that HARD GATE #2 now runs INSIDE the
 * variant loop keyed on each target's owning-group tokens. For a single-group
 * caller (all targets share one token set) that is behaviourally identical to
 * the original "gate once before the loop" placement.
 */
export function scoreFuzzyCandidate(
  fuzzy: FuzzySkuRow,
  input: FuzzyCandidateScoringInput,
): MarketMatchCandidate | null {
  // Re-canonicalize the fuzzy's category on read so alias changes in
  // canonicalCategoryNorm() don't require a backfill rerun.
  const fuzzyCategoryCanonical = canonicalCategoryNorm(fuzzy.categoryNorm)
  const listing = fuzzy.rawInputJsonb as
    | { url?: string | null; dispensaryName?: string | null; listingName?: string | null }
    | null

  // Live-extract pack_count and significant tokens from the raw listingName
  // instead of reading the DB columns — the partner_product ingest hardcodes
  // pack_count_norm / strain_norm to NULL, so for the structured rows the
  // persisted columns carry no signal. Legacy observation-derived rows DO have
  // these columns populated, so we prefer the DB value and only fall back to
  // listingName parsing.
  const listingParsedSize = listing?.listingName ? parseSizeProfile(listing.listingName) : null
  const fuzzyNameTokens = Array.from(
    extractSignificantNameTokens(
      [listing?.listingName, fuzzy.strainNorm].filter((s): s is string => !!s).join(' '),
      { brandText: input.brandTextForTokens, categoryText: input.categoryTextForTokens },
    ),
  )

  const fuzzyProfile: FuzzyProfile = {
    brandNorm: fuzzy.brandNorm,
    categoryNorm: fuzzyCategoryCanonical ?? fuzzy.categoryNorm,
    subcategoryNorm: fuzzy.subcategoryNorm,
    sizeGNorm: fuzzy.sizeGNorm,
    sizeMgNorm: fuzzy.sizeMgNorm,
    packCountNorm: fuzzy.packCountNorm ?? listingParsedSize?.packCountNorm ?? null,
    strainNorm: fuzzy.strainNorm,
    nameTokens: fuzzyNameTokens,
  }

  // Brand-alias resolution:
  //   1. the fuzzy's brand_norm is one of the LitAlerts spellings we expanded
  //      from the operator's brand_id override (effectiveBrandSet), or
  //   2. legacy heuristic rescue: the fuzzy has no parsed brand at all but the
  //      listing text mentions the catalog brand.
  const fuzzyBrandLower = fuzzy.brandNorm?.toLowerCase().trim() ?? null
  const brandAliasMatch =
    (fuzzyBrandLower !== null && input.effectiveBrandSet.has(fuzzyBrandLower))
    || (
      input.catalogBrandNorm !== null
      && fuzzy.brandNorm === null
      && typeof listing?.listingName === 'string'
      && listing.listingName.toLowerCase().includes(input.catalogBrandNorm.toLowerCase())
    )

  // HARD GATE #1 — category. Either side null is tolerated (some legacy
  // listings don't have a parsed category).
  if (
    input.catalogCategoryCanonical
    && fuzzyCategoryCanonical
    && fuzzyCategoryCanonical !== input.catalogCategoryCanonical
  ) {
    return null
  }

  const fuzzyNameTokenSet = new Set(fuzzyNameTokens)

  let bestPick: {
    variant: CatalogVariant | null
    factors: ScoreFactors
    rawScore: number
    finalScore: number
  } | null = null
  for (const target of input.variantTargets) {
    const variant = target.variant

    // HARD GATE #3 — per-variant size family match.
    if (
      variant
      && (typeof variant.sizeGNorm === 'number' || typeof variant.sizeMgNorm === 'number')
      && (typeof fuzzy.sizeGNorm === 'number' || typeof fuzzy.sizeMgNorm === 'number')
    ) {
      if (
        !sameSizeFamily(
          { sizeGNorm: variant.sizeGNorm, sizeMgNorm: variant.sizeMgNorm },
          { sizeGNorm: fuzzy.sizeGNorm, sizeMgNorm: fuzzy.sizeMgNorm },
        )
      ) {
        continue
      }
    }

    // HARD GATE #2 — shared significant name token with the OWNING group.
    // Skipped when the owning group has zero significant tokens (nothing to
    // require a shared token with).
    if (target.gate2Tokens.size > 0) {
      let shares = false
      for (const tok of fuzzyNameTokenSet) {
        if (target.gate2Tokens.has(tok)) {
          shares = true
          break
        }
      }
      if (!shares) continue
    }

    const factors = scoreCatalogFuzzyFactors(target.profile, fuzzyProfile, { brandAliasMatch })
    const rawScore = Math.max(
      0,
      factors.brand
        * factors.category
        * factors.subcategory
        * factors.size
        * factors.pack
        * factors.strain
        * factors.nameOverlap,
    )
    const finalScore = applyVerdictPostFilter(rawScore, null)
    if (!bestPick || finalScore > bestPick.finalScore) {
      bestPick = { variant, factors, rawScore, finalScore }
    }
  }
  if (!bestPick) return null

  const { variant, factors, rawScore, finalScore } = bestPick
  const matchedKey = variant
    ? { sizeKey: variant.sizeKey, sizeLabel: variant.sizeLabel, productId: variant.catalogProductId }
    : { sizeKey: 'unsized', sizeLabel: 'No variant', productId: null }
  return {
    fuzzy,
    rawScore,
    finalScore,
    factors,
    liveVerdict: null,
    listingUrl: listing?.url ?? null,
    dispensaryName: listing?.dispensaryName ?? null,
    imageUrl: input.imageByFuzzyId.get(fuzzy.id) ?? null,
    matchedCatalogProductId: matchedKey.productId,
    matchedSizeKey: matchedKey.sizeKey,
    matchedSizeLabel: matchedKey.sizeLabel,
  }
}
