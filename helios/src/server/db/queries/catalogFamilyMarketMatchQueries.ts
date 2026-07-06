/**
 * Brand-categorical-family market-match audit query (issue #58, task T2).
 *
 * A DIAGNOSTIC surface: for ONE brand-categorical-family (brand + category +
 * subcategory + size-group + pack) it surfaces the LitAlerts partner_product
 * listings the REAL matcher associates with the family AND how it scored them,
 * so the operator can judge matcher/data quality. It reuses the EXACT same
 * override-aware brand expansion, structured fuzzy fetch, and per-fuzzy scorer
 * the per-catalog-group review bundle uses (extracted into shared helpers), so
 * the audit reflects production matching with no drift.
 *
 * A family may span several catalog groups. We re-derive the family's member
 * variants server-side from the whole catalog (reusing the shared T1 grouping
 * so the family boundaries can't drift from the Family Explorer page), then run
 * the shared scorer against those members. HARD GATE #2 (shared significant
 * name token) is applied per member against ITS OWNING group's tokens — never a
 * cross-group union — so the diagnostic doesn't over-report matches.
 *
 * Known data caveats are SURFACED (counts / labels), never gated out:
 *   - stale 2026-05-26 snapshot (min/max capture instant returned),
 *   - ~57% duplicate rows (deduped to latest per source_listing_id; raw vs
 *     deduped counts returned),
 *   - pack_count_norm / subcategory_norm NULL on all partner rows (surfaced as
 *     packNotMatchable / subcategoryNotMatchable),
 *   - brand mapping state (mapped / operator-says-none / unmapped) per spelling,
 *   - prices derived preTax = salePrice ?? normalPrice, postTax = preTax * 1.13.
 */

import type {
  BrandFamilyDistanceBand,
  BrandFamilyMappingSummary,
  BrandFamilyMarketMatchResponse,
  BrandFamilyMatchCandidate,
  BrandFamilyPriceOutlierSummary,
  BrandFamilyPriceReviewCandidate,
} from '../../../shared/contracts/index.js'
import { computePriceOutliers, priceOutlierSeverity } from '../../../shared/marketMatch/priceOutliers.js'
import {
  groupBrandSubdividedFamilies,
  type BrandSubdividedFamily,
  type BrandSubFamily,
} from '../../../shared/domain/familyExplorer.js'
import { canonicalCategoryNorm, extractSignificantNameTokens, parseSizeProfile } from '../../../shared/marketMatch/listingParse.js'
import {
  PRICING_FAR_DISTANCE_MAX_MILES,
  PRICING_MID_DISTANCE_MAX_MILES,
  PRICING_NEAR_DISTANCE_MAX_MILES,
  PRICING_POST_TAX_MULTIPLIER,
} from '../../../shared/domain/pricingGeneration.js'
import {
  scoreFuzzyCandidate,
  type CatalogVariant,
  type FuzzySkuRow,
  type MarketMatchCandidate,
  type VariantScoringTarget,
} from '../../marketMatch/candidateScoring.js'
import type { Queryable } from '../pool.js'
import { listAllCatalogVariants } from './catalogFamilyExplorerQueries.js'
import {
  EFFECTIVE_AUTO_PROMOTE_THRESHOLD,
  fetchPartnerFuzzyCandidates,
  makeSizeKey,
  parseLooseNumber,
  resolveEffectiveBrandMapping,
  type PartnerFuzzyFetchRow,
} from './catalogMarketMatchQueries.js'

/** Cap the number of scored candidates returned to the audit UI. */
const MAX_FAMILY_CANDIDATES = 200
/** Cap the deduped partner rows fetched before scoring (bounded payload). */
const FAMILY_FETCH_LIMIT = 500
/** Max flagged outliers surfaced in `reviewCandidates` (rest reported via overflow). */
const REVIEW_CANDIDATES_LIMIT = 25

/** Empty outlier fields for the honest short-circuit paths (no scored family). */
const EMPTY_PRICE_OUTLIER_SUMMARY: BrandFamilyPriceOutlierSummary = {
  method: 'insufficient-basis',
  basis: 0,
  median: null,
  lowFence: null,
  highFence: null,
  lowCount: 0,
  highCount: 0,
  flaggedCount: 0,
}

/**
 * Derived preTax price for a scored candidate = round(salePrice ?? normalPrice)
 * when positive, else null. Single source so the outlier basis and the
 * materialized candidate rows never disagree on a price.
 */
function preTaxPriceOf(c: MarketMatchCandidate): number | null {
  const raw = c.fuzzy.rawInputJsonb as
    | { normalPrice?: number | string | null; salePrice?: number | string | null }
    | null
  const preTaxRaw = parseLooseNumber(raw?.salePrice) ?? parseLooseNumber(raw?.normalPrice)
  return preTaxRaw !== null && preTaxRaw > 0 ? Math.round(preTaxRaw * 100) / 100 : null
}

/**
 * Parse a raw LitAlerts `retailerId` (a string in raw_input_jsonb) into a stable
 * integer id, or null when absent / blank / non-integer. Single source so the
 * distance-join id set and the candidate `retailerId` contract field agree, and
 * so an empty string never collapses to `0` (a real, wrong retailer id).
 */
function parseRetailerId(raw: { retailerId?: string | null } | null): number | null {
  const value = raw?.retailerId
  if (value == null) return null
  const trimmed = String(value).trim()
  if (trimmed.length === 0) return null
  const n = Number(trimmed)
  return Number.isInteger(n) ? n : null
}

/**
 * Short-TTL process cache of the whole-catalog brand-subdivided grouping. An
 * operator expanding many families in a session would otherwise re-read the
 * whole variant catalog (~3.6k rows) + re-group it on EVERY expand. The catalog
 * changes slowly and this is a temporary diagnostic surface, so a 60s TTL keeps
 * expands snappy without meaningful staleness (canon: no redundant recompute).
 */
const FAMILY_GROUPING_TTL_MS = 60_000
let familyGroupingCache: { at: number; families: BrandSubdividedFamily[] } | null = null

async function loadBrandSubdividedFamiliesCached(db: Queryable): Promise<BrandSubdividedFamily[]> {
  const now = Date.now()
  if (familyGroupingCache && now - familyGroupingCache.at < FAMILY_GROUPING_TTL_MS) {
    return familyGroupingCache.families
  }
  return refreshFamilyGroupingCache(db)
}

/** Force a fresh whole-catalog regroup and refill the cache. */
async function refreshFamilyGroupingCache(db: Queryable): Promise<BrandSubdividedFamily[]> {
  const variants = await listAllCatalogVariants(db)
  const families = groupBrandSubdividedFamilies(variants)
  familyGroupingCache = { at: Date.now(), families }
  return families
}

/**
 * Classify a great-circle distance (miles) into the pricing distance band.
 * Pure twin of `classifyPricingDistanceBand` in worker/pricing/litAlertsMarket
 * (kept local so this server read-path doesn't pull the worker runtime graph);
 * it reuses the SAME shared thresholds so the two never disagree on the values.
 */
function classifyDistanceBand(distanceMiles: number | null): BrandFamilyDistanceBand {
  if (distanceMiles === null || !Number.isFinite(distanceMiles)) return 'unknown'
  if (distanceMiles <= PRICING_NEAR_DISTANCE_MAX_MILES) return 'near'
  if (distanceMiles <= PRICING_MID_DISTANCE_MAX_MILES) return 'mid'
  if (distanceMiles <= PRICING_FAR_DISTANCE_MAX_MILES) return 'far'
  return 'very_far'
}

interface OwningGroupProductRow {
  catalog_group_id: number
  group_name: string | null
  brand_name: string | null
  product_id: number
  product_name: string | null
  product_short_name: string | null
  product_tab: string | null
  size_name: string | null
  product_sku: string | null
  pack_count: number | null
}

/**
 * Enrich a family's member variants with the production scoring inputs the T1
 * client contract doesn't carry (group_name, brand_name, per-product shortName
 * / tab / sizeName). Server-only; reads live_state_json for just the owning
 * groups.
 */
async function loadOwningGroupProducts(
  db: Queryable,
  catalogGroupIds: number[],
): Promise<OwningGroupProductRow[]> {
  if (catalogGroupIds.length === 0) return []
  const result = await db.query<OwningGroupProductRow>(
    `
      select
        cg.id                                as catalog_group_id,
        cg.group_name                        as group_name,
        cg.brand_name                        as brand_name,
        (prod->>'productId')::bigint         as product_id,
        nullif(prod->>'name', '')            as product_name,
        nullif(prod->>'shortName', '')       as product_short_name,
        nullif(prod->>'tab', '')             as product_tab,
        nullif(prod->>'sizeName', '')        as size_name,
        nullif(prod->>'sku', '')             as product_sku,
        nullif(prod->>'packOfSize', '')::int as pack_count
      from catalog_groups cg
      cross join lateral jsonb_array_elements(
        coalesce(cg.live_state_json->'products', '[]'::jsonb)
      ) prod
      where cg.id = any($1::bigint[])
        and (prod->>'productId') ~ '^[0-9]+$'
    `,
    [catalogGroupIds],
  )
  return result.rows
}

/** Nearest-store distance (miles) per retailerId, for the optional band label. */
async function loadRetailerDistanceMiles(
  db: Queryable,
  retailerIds: number[],
): Promise<Map<number, number>> {
  const map = new Map<number, number>()
  if (retailerIds.length === 0) return map
  const result = await db.query<{ retailer_id: string; miles: number }>(
    `
      with retailer_distances as (
        select
          r.retailer_id,
          3958.7613 * 2 * asin(
            sqrt(
              sin(radians((s.latitude - r.latitude) / 2)) ^ 2
              + cos(radians(r.latitude)) * cos(radians(s.latitude))
                * sin(radians((s.longitude - r.longitude) / 2)) ^ 2
            )
          ) as miles
        from litalerts_retailer_locations r
        cross join helios_store_locations s
        where r.retailer_id = any($1::bigint[])
          and r.latitude is not null and r.longitude is not null
          and s.latitude is not null and s.longitude is not null
      )
      select distinct on (retailer_id) retailer_id::text as retailer_id, miles
      from retailer_distances
      order by retailer_id, miles asc
    `,
    [retailerIds],
  )
  for (const row of result.rows) {
    const retailerId = Number(row.retailer_id)
    if (!Number.isFinite(retailerId)) continue
    if (typeof row.miles !== 'number' || !Number.isFinite(row.miles)) continue
    map.set(retailerId, row.miles)
  }
  return map
}

/** Human size label for a listing's own parsed size, or null when unparseable. */
function parsedSizeLabelFor(sizeGNorm: number | null, sizeMgNorm: number | null): string | null {
  const { sizeKey, sizeLabel } = makeSizeKey(sizeGNorm, sizeMgNorm, null)
  return sizeKey === 'unsized' ? null : sizeLabel
}

/** Roll the per-spelling mapping states into one summary for the header. */
export function summarizeMapping(states: ReadonlyArray<{ state: string }>): BrandFamilyMappingSummary {
  if (states.length === 0) return 'no-brand'
  const distinct = new Set(states.map((s) => s.state))
  if (distinct.size === 1) {
    const only = states[0]!.state
    if (only === 'mapped') return 'mapped'
    if (only === 'operator-says-none') return 'operator-says-none'
    return 'unmapped'
  }
  return 'mixed'
}

function findSubFamily(
  families: BrandSubdividedFamily[],
  familyKey: string,
  brandKey: string | null,
): { family: BrandSubdividedFamily; subFamily: BrandSubFamily } | null {
  const family = families.find((f) => f.familyKey === familyKey)
  if (!family) return null
  const subFamily = family.subFamilies.find((s) => s.brandKey === brandKey)
  if (!subFamily) return null
  return { family, subFamily }
}

/**
 * Load the market-match audit for one brand-categorical-family, identified by
 * the T1 non-brand family key + the per-brand key. Returns null when the family
 * no longer exists in the current catalog (client should refresh).
 */
export async function loadBrandFamilyMarketMatch(
  db: Queryable,
  familyKey: string,
  brandKey: string | null,
): Promise<BrandFamilyMarketMatchResponse | null> {
  // Re-derive the family server-side from the whole catalog, reusing the SAME
  // T1 grouping so family boundaries can't drift from the Family Explorer page.
  // Cached with a short TTL so expanding many families in a session doesn't
  // re-read + re-group the whole catalog on every request.
  const families = await loadBrandSubdividedFamiliesCached(db)
  let found = findSubFamily(families, familyKey, brandKey)
  if (!found) {
    // Miss against a possibly-stale cache: the family may have just appeared in
    // the catalog. Recompute fresh once before declaring a 404, so the client's
    // "refresh the page" actually resolves (a plain refresh would otherwise keep
    // hitting the same stale cached grouping for up to the TTL window).
    const fresh = await refreshFamilyGroupingCache(db)
    found = findSubFamily(fresh, familyKey, brandKey)
  }
  if (!found) return null
  const { family, subFamily } = found

  const packNotMatchable = family.packCount != null && family.packCount > 1
  const subcategoryNotMatchable = family.subcategoryName != null
  const baseResponse: Omit<
    BrandFamilyMarketMatchResponse,
    | 'effectiveBrandNorms'
    | 'mappingStates'
    | 'mappingSummary'
    | 'rawRowCount'
    | 'dedupedListingCount'
    | 'fetchLimit'
    | 'fetchTruncated'
    | 'scoredCandidateCount'
    | 'aboveThresholdCount'
    | 'belowThresholdCount'
    | 'snapshotCapturedAtMin'
    | 'snapshotCapturedAtMax'
    | 'candidates'
    | 'priceOutlierSummary'
    | 'reviewCandidates'
    | 'reviewCandidatesLimit'
    | 'reviewCandidatesOverflow'
  > = {
    familyKey,
    brandKey,
    brandName: subFamily.brandName,
    categoryName: family.categoryName,
    subcategoryName: family.subcategoryName,
    sizeGroupLabel: family.sizeGroupLabel,
    packCount: family.packCount,
    memberVariantCount: subFamily.memberCount,
    threshold: EFFECTIVE_AUTO_PROMOTE_THRESHOLD,
    packNotMatchable,
    subcategoryNotMatchable,
  }

  // The no-brand sub-family can't be matched — production has no brand norm to
  // filter on. Return an honest empty result rather than a misleading fetch.
  if (brandKey === null) {
    return {
      ...baseResponse,
      effectiveBrandNorms: [],
      mappingStates: [],
      mappingSummary: 'no-brand',
      rawRowCount: 0,
      dedupedListingCount: 0,
      fetchLimit: FAMILY_FETCH_LIMIT,
      fetchTruncated: false,
      scoredCandidateCount: 0,
      aboveThresholdCount: 0,
      belowThresholdCount: 0,
      snapshotCapturedAtMin: null,
      snapshotCapturedAtMax: null,
      candidates: [],
      priceOutlierSummary: EMPTY_PRICE_OUTLIER_SUMMARY,
      reviewCandidates: [],
      reviewCandidatesLimit: REVIEW_CANDIDATES_LIMIT,
      reviewCandidatesOverflow: false,
    }
  }

  // Resolve the family's brand(s) — a family folds case/whitespace spellings
  // into one key, but overrides key on the exact raw spelling, so resolve every
  // distinct raw spelling and union.
  const distinctRawBrands = Array.from(
    new Set(subFamily.members.map((m) => m.brandName).filter((b): b is string => b != null)),
  )
  const brandMapping = await resolveEffectiveBrandMapping(db, distinctRawBrands)
  const mappingSummary = summarizeMapping(brandMapping.perSpelling)

  const emptyBrandResult = (): BrandFamilyMarketMatchResponse => ({
    ...baseResponse,
    effectiveBrandNorms: brandMapping.norms,
    mappingStates: brandMapping.perSpelling,
    mappingSummary,
    rawRowCount: 0,
    dedupedListingCount: 0,
    fetchLimit: FAMILY_FETCH_LIMIT,
    fetchTruncated: false,
    scoredCandidateCount: 0,
    aboveThresholdCount: 0,
    belowThresholdCount: 0,
    snapshotCapturedAtMin: null,
    snapshotCapturedAtMax: null,
    candidates: [],
    priceOutlierSummary: EMPTY_PRICE_OUTLIER_SUMMARY,
    reviewCandidates: [],
    reviewCandidatesLimit: REVIEW_CANDIDATES_LIMIT,
    reviewCandidatesOverflow: false,
  })

  // Every spelling explicit-null / no usable brand → no structured pull (same
  // as loadGroupReview's explicit-null short-circuit).
  if (brandMapping.norms.length === 0) return emptyBrandResult()

  // Enrich member variants with production scoring inputs (group_name / brand /
  // shortName / tab / sizeName) keyed by (groupId, productId).
  const owningGroupIds = Array.from(new Set(subFamily.members.map((m) => m.catalogGroupId)))
  const owningRows = await loadOwningGroupProducts(db, owningGroupIds)
  const owningByGroup = new Map<number, OwningGroupProductRow[]>()
  for (const row of owningRows) {
    const list = owningByGroup.get(row.catalog_group_id) ?? []
    list.push(row)
    owningByGroup.set(row.catalog_group_id, list)
  }
  const productByKey = new Map<string, OwningGroupProductRow>()
  const groupMetaById = new Map<number, { groupName: string | null; brandName: string | null }>()
  for (const row of owningRows) {
    productByKey.set(`${row.catalog_group_id}:${row.product_id}`, row)
    if (!groupMetaById.has(row.catalog_group_id)) {
      groupMetaById.set(row.catalog_group_id, { groupName: row.group_name, brandName: row.brand_name })
    }
  }

  const catalogCategoryCanonical = canonicalCategoryNorm(family.categoryName)
  const representativeNorm = brandMapping.representativeNorm
  const categoryTextForTokens = catalogCategoryCanonical ?? family.categoryName

  // Per owning group: the significant name tokens for HARD GATE #2, computed
  // exactly as production does (from the group name, stripping the effective
  // brand + canonical category). For a single-brand-spelling family (the vast
  // majority) representativeNorm IS that group's effective norm, so this is
  // byte-identical to the per-group review path; a multi-spelling family strips
  // one representative norm rather than each group's own — an acceptable, minor
  // diagnostic-only divergence.
  const groupTokensById = new Map<number, Set<string>>()
  for (const [groupId, meta] of groupMetaById) {
    const tokens = extractSignificantNameTokens(meta.groupName, {
      brandText: representativeNorm ?? meta.brandName,
      categoryText: categoryTextForTokens,
    })
    groupTokensById.set(groupId, tokens)
  }

  // Build one scoring target per member variant, carrying its owning group's
  // gate-2 tokens + a production-shaped CatalogVariant + variant name tokens.
  const scoringTargets: VariantScoringTarget[] = []
  const grams = new Set<number>()
  const mgs = new Set<number>()
  for (const member of subFamily.members) {
    const prod = productByKey.get(`${member.catalogGroupId}:${member.productId}`)
    if (!prod) continue
    const meta = groupMetaById.get(member.catalogGroupId)
    const sizeSourceText = [prod.size_name, prod.product_tab, prod.product_name]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join(' ')
    const sp = parseSizeProfile(sizeSourceText)
    const { sizeKey, sizeLabel } = makeSizeKey(sp.sizeGNorm, sp.sizeMgNorm, prod.product_tab ?? prod.size_name ?? null)
    if (typeof sp.sizeGNorm === 'number') grams.add(sp.sizeGNorm)
    if (typeof sp.sizeMgNorm === 'number') mgs.add(sp.sizeMgNorm)
    const variant: CatalogVariant = {
      catalogProductId: prod.product_id,
      name: prod.product_name,
      shortName: prod.product_short_name,
      tab: prod.product_tab,
      sku: prod.product_sku,
      sizeName: prod.size_name ?? prod.product_tab,
      sizeGNorm: sp.sizeGNorm,
      sizeMgNorm: sp.sizeMgNorm,
      packCountNorm: sp.packCountNorm,
      imageUrl: null,
      price: null,
      sizeKey,
      sizeLabel,
    }
    const gate2Tokens = groupTokensById.get(member.catalogGroupId) ?? new Set<string>()
    const variantTokens = Array.from(
      extractSignificantNameTokens(
        [prod.product_name, prod.product_short_name].filter((s): s is string => !!s).join(' '),
        { brandText: representativeNorm ?? meta?.brandName ?? null, categoryText: categoryTextForTokens },
      ),
    )
    scoringTargets.push({
      variant,
      profile: {
        brandNorm: representativeNorm,
        categoryNorm: catalogCategoryCanonical ?? family.categoryName,
        subcategoryNorm: family.subcategoryName,
        sizeGNorm: sp.sizeGNorm,
        sizeMgNorm: sp.sizeMgNorm,
        packCountNorm: sp.packCountNorm,
        strainNorm: null,
        nameTokens: variantTokens,
      },
      gate2Tokens,
    })
  }
  if (scoringTargets.length === 0) return emptyBrandResult()

  // SQL name-token prefilter: union of the owning groups' token patterns, BUT
  // if ANY owning group has an empty token set (its gate #2 is skipped and it
  // would accept any candidate) we must NOT restrict by token in SQL, or we'd
  // pre-drop candidates that group would have kept. Mirrors production's
  // "skip the token filter when the group has no significant tokens" semantics.
  const tokenSets = Array.from(groupTokensById.values())
  const anyGroupHasNoTokens = tokenSets.some((s) => s.size === 0) || tokenSets.length === 0
  const unionTokens = new Set<string>()
  for (const s of tokenSets) for (const t of s) unionTokens.add(t)
  const tokenPatterns = anyGroupHasNoTokens ? [] : Array.from(unionTokens).map((t) => `%${t}%`)

  const partnerRows = await fetchPartnerFuzzyCandidates(db, {
    brandNorms: brandMapping.norms,
    categoryCanonical: catalogCategoryCanonical,
    grams: Array.from(grams),
    mgs: Array.from(mgs),
    tokenPatterns,
    dedupLatestPerListing: true,
    limit: FAMILY_FETCH_LIMIT,
  })

  const rawRowCount = partnerRows[0]?.raw_row_count ?? partnerRows.length
  const dedupedListingCount = partnerRows[0]?.deduped_count ?? partnerRows.length
  // Only the most-recent FAMILY_FETCH_LIMIT deduped listings are fetched/scored.
  // Surface truncation so "deduped vs scored" isn't misread as matcher gating.
  const fetchTruncated =
    partnerRows.length >= FAMILY_FETCH_LIMIT && dedupedListingCount > FAMILY_FETCH_LIMIT

  // Map raw fetch rows to the FuzzySkuRow shape the scorer consumes.
  const fuzzies: FuzzySkuRow[] = partnerRows.map((row: PartnerFuzzyFetchRow) => ({
    id: row.id,
    sourceKind: row.source_kind,
    sourceListingId: row.source_listing_id,
    rawInputJsonb: row.raw_input_jsonb,
    brandNorm: row.brand_norm,
    categoryNorm: row.category_norm,
    subcategoryNorm: row.subcategory_norm,
    sizeGNorm: row.size_g_norm != null ? Number.parseFloat(row.size_g_norm) : null,
    sizeMgNorm: row.size_mg_norm != null ? Number.parseFloat(row.size_mg_norm) : null,
    packCountNorm: row.pack_count_norm,
    strainNorm: row.strain_norm,
  }))
  const capturedAtByFuzzyId = new Map<number, string | null>()
  const imageByFuzzyId = new Map<number, string>()
  for (const row of partnerRows) {
    capturedAtByFuzzyId.set(row.id, row.source_captured_at)
    if (row.image_url != null) imageByFuzzyId.set(row.id, row.image_url)
  }

  const effectiveBrandSet = new Set(brandMapping.norms.map((n) => n.toLowerCase().trim()))

  // Score each candidate with the SAME pure scorer the group review uses.
  const scored: MarketMatchCandidate[] = []
  for (const fuzzy of fuzzies) {
    const candidate = scoreFuzzyCandidate(fuzzy, {
      effectiveBrandSet,
      catalogBrandNorm: representativeNorm,
      catalogCategoryCanonical,
      brandTextForTokens: representativeNorm,
      categoryTextForTokens,
      variantTargets: scoringTargets,
      imageByFuzzyId,
    })
    if (candidate) scored.push(candidate)
  }
  scored.sort((a, b) => b.finalScore - a.finalScore)

  const threshold = EFFECTIVE_AUTO_PROMOTE_THRESHOLD

  // Price-outlier review signal over the FULL scored set, restricted to
  // above-threshold, same-hard-gated-family, finite-priced candidates — computed
  // BEFORE the display cap so an outlier can never be invisible for falling
  // outside the top-N table slice. Review signal only: it never reorders or
  // gates candidates (canon: outlier stats must not pollute / be polluted).
  const outlier = computePriceOutliers(
    scored,
    (c) => c.fuzzy.id,
    (c) => preTaxPriceOf(c),
    (c) => c.finalScore >= threshold,
  )

  // Rank all flagged outliers for the bounded review list: most anomalous first
  // (distance past the crossed fence), then |delta|, then score, then a stable id.
  const flaggedScored = scored.filter((c) => outlier.flagByKey.has(c.fuzzy.id))
  flaggedScored.sort((a, b) => {
    const fa = outlier.flagByKey.get(a.fuzzy.id)!
    const fb = outlier.flagByKey.get(b.fuzzy.id)!
    const sa = priceOutlierSeverity(preTaxPriceOf(a) ?? 0, fa)
    const sb = priceOutlierSeverity(preTaxPriceOf(b) ?? 0, fb)
    if (sb !== sa) return sb - sa
    const da = Math.abs(fa.delta)
    const dbv = Math.abs(fb.delta)
    if (dbv !== da) return dbv - da
    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore
    return a.fuzzy.id - b.fuzzy.id
  })
  const reviewScored = flaggedScored.slice(0, REVIEW_CANDIDATES_LIMIT)

  const capped = scored.slice(0, MAX_FAMILY_CANDIDATES)

  // Distance band (optional context): join retailerIds to the geocoded retailer
  // directory once, over BOTH the displayed rows and the review rows (which may
  // fall outside the display cap) so review cards still show a distance band.
  const retailerIds = Array.from(
    new Set(
      [...capped, ...reviewScored]
        .map((c) => parseRetailerId(c.fuzzy.rawInputJsonb as { retailerId?: string | null } | null))
        .filter((id): id is number => id != null),
    ),
  )
  const retailerMiles = await loadRetailerDistanceMiles(db, retailerIds)

  // Above/below counts are over the WHOLE scored family (not the 200-row display
  // slice) so the header pills stay honest even when the table is capped — a
  // matcher-quality audit must never silently skew its own counts.
  const aboveThresholdCount = scored.filter((c) => c.finalScore >= threshold).length

  const buildCandidate = (c: MarketMatchCandidate): BrandFamilyMatchCandidate => {
    const raw = c.fuzzy.rawInputJsonb as
      | {
          listingName?: string | null
          brand?: string | null
          url?: string | null
          dispensaryName?: string | null
          normalPrice?: number | string | null
          salePrice?: number | string | null
          currentStock?: number | string | null
          retailerId?: string | null
        }
      | null
    const preTaxPrice = preTaxPriceOf(c)
    const postTaxPrice =
      preTaxPrice !== null ? Math.round(preTaxPrice * PRICING_POST_TAX_MULTIPLIER * 100) / 100 : null
    const currentStock = parseLooseNumber(raw?.currentStock)
    const retailerIdOrNull = parseRetailerId(raw)
    const miles = retailerIdOrNull !== null ? retailerMiles.get(retailerIdOrNull) ?? null : null
    const capturedAt = capturedAtByFuzzyId.get(c.fuzzy.id) ?? null
    return {
      fuzzySkuId: c.fuzzy.id,
      sourceListingId: c.fuzzy.sourceListingId,
      listingName: typeof raw?.listingName === 'string' ? raw.listingName : null,
      brandRaw: typeof raw?.brand === 'string' ? raw.brand : null,
      brandNorm: c.fuzzy.brandNorm,
      categoryNorm: c.fuzzy.categoryNorm,
      subcategoryNorm: c.fuzzy.subcategoryNorm,
      parsedSizeLabel: parsedSizeLabelFor(c.fuzzy.sizeGNorm, c.fuzzy.sizeMgNorm),
      matchedSizeGroupLabel: c.matchedSizeLabel,
      retailer: c.dispensaryName ?? (typeof raw?.dispensaryName === 'string' ? raw.dispensaryName : null),
      retailerId: retailerIdOrNull,
      url: c.listingUrl ?? (typeof raw?.url === 'string' ? raw.url : null),
      preTaxPrice,
      postTaxPrice,
      currentStock: currentStock !== null && Number.isFinite(currentStock) ? currentStock : null,
      sourceCapturedAt: capturedAt,
      distanceBand: classifyDistanceBand(miles),
      distanceMiles: miles,
      score: c.finalScore,
      factors: c.factors,
      aboveThreshold: c.finalScore >= threshold,
      matchedCatalogProductId: c.matchedCatalogProductId,
      priceOutlier: outlier.flagByKey.get(c.fuzzy.id) ?? null,
    }
  }

  const candidates = capped.map(buildCandidate)

  // Snapshot capture range over the displayed candidates (the returned table).
  let capturedMin: string | null = null
  let capturedMax: string | null = null
  for (const c of capped) {
    const capturedAt = capturedAtByFuzzyId.get(c.fuzzy.id) ?? null
    if (capturedAt != null) {
      if (capturedMin === null || capturedAt < capturedMin) capturedMin = capturedAt
      if (capturedMax === null || capturedAt > capturedMax) capturedMax = capturedAt
    }
  }

  const reviewCandidates: BrandFamilyPriceReviewCandidate[] = reviewScored.map((c) => ({
    ...buildCandidate(c),
    // Non-null by construction: reviewScored only holds flagged rows.
    priceOutlier: outlier.flagByKey.get(c.fuzzy.id)!,
  }))

  return {
    ...baseResponse,
    effectiveBrandNorms: brandMapping.norms,
    mappingStates: brandMapping.perSpelling,
    mappingSummary,
    rawRowCount,
    dedupedListingCount,
    fetchLimit: FAMILY_FETCH_LIMIT,
    fetchTruncated,
    scoredCandidateCount: scored.length,
    aboveThresholdCount,
    belowThresholdCount: scored.length - aboveThresholdCount,
    snapshotCapturedAtMin: capturedMin,
    snapshotCapturedAtMax: capturedMax,
    candidates,
    priceOutlierSummary: outlier.stats,
    reviewCandidates,
    reviewCandidatesLimit: REVIEW_CANDIDATES_LIMIT,
    reviewCandidatesOverflow: outlier.stats.flaggedCount > reviewScored.length,
  }
}
