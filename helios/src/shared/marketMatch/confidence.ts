/**
 * Deterministic catalog ↔ FuzzySku confidence scorer.
 *
 * Lives in `shared/` so the same function powers:
 *   - the Catalog → Market Data triage page (rank un-verdicted
 *     candidates),
 *   - downstream pricing reads (Phase 5 in
 *     docs/helios/catalog-market-data/EPIC_PLAN.md), and
 *   - the background auto-promotion cron (Phase 6).
 *
 * The output is in `[0, 1]`. The formula is the product of per-field
 * factors, then floored at 0 and post-filtered by any live human
 * verdict (`no_match` → 0; `exact` → ≥ 0.99; `brand_family` → clamp
 * into [0.50, 0.85]). All per-field factors are exported as named
 * helpers so they're individually unit-testable.
 *
 * Pure function — no DB / clock / network reads. The caller passes
 * in the already-resolved alias-equivalent flag for the brand
 * factor.
 */

export type MarketMatchVerdict = 'exact' | 'brand_family' | 'no_match'

export interface CatalogProfile {
  brandNorm: string | null
  categoryNorm: string | null
  subcategoryNorm: string | null
  sizeGNorm: number | null
  sizeMgNorm: number | null
  packCountNorm: number | null
  strainNorm: string | null
  /**
   * "Significant" name tokens (i.e. the residual after stripping
   * brand, category, size, and grammatical fillers — exactly the
   * `extractSignificantNameTokens()` output). Powers the
   * `nameOverlap` scoring factor so that e.g. "Ayrloom Lemonade"
   * and "Ayrloom Honeycrisp" don't both score the same against a
   * "Lemonade" catalog variant; they differ in their distinguishing
   * tokens, which is precisely what we want to reward / punish.
   * Pass null (not []) to mean "I didn't bother extracting tokens"
   * so the scorer can treat it as a no-op instead of a hard miss.
   */
  nameTokens: string[] | null
}

export interface FuzzyProfile {
  brandNorm: string | null
  categoryNorm: string | null
  subcategoryNorm: string | null
  sizeGNorm: number | null
  sizeMgNorm: number | null
  packCountNorm: number | null
  strainNorm: string | null
  /** Same semantics as CatalogProfile.nameTokens. */
  nameTokens: string[] | null
}

export interface ScoreOptions {
  /**
   * If true, treat catalog.brand and fuzzy.brand as alias-equivalent
   * (resolved against the brand_aliases reference table by the
   * caller). Used in the brand factor to grant 0.85 instead of 0.
   */
  brandAliasMatch?: boolean
  /**
   * If true, treat catalog.category and fuzzy.category as
   * alias-equivalent (e.g. "edible" ↔ "gummy"). Caller supplies the
   * decision; the scorer doesn't ship an alias table.
   */
  categoryAliasMatch?: boolean
}

export interface ScoreFactors {
  brand: number
  category: number
  subcategory: number
  size: number
  pack: number
  strain: number
  /**
   * Jaccard overlap between the catalog and fuzzy `nameTokens` sets.
   * 1.0 when sets are identical and both non-empty, near-1 when one
   * side missing, and drops toward `NAME_OVERLAP_FLOOR` when there
   * are tokens on both sides that don't intersect at all — the
   * "Lemonade vs Honeycrisp" differentiator the existing strain /
   * shared-token gate was supposed to provide but couldn't because
   * neither side had `strainNorm` populated.
   */
  nameOverlap: number
}

/**
 * Score a (catalog, fuzzy) pair against the v1 deterministic formula.
 *
 * `knownVerdict` is the verdict of the *current live* (non-
 * superseded) catalog_market_matches row for the pair, if any.
 * Pass undefined to skip the verdict post-filter (e.g. when you're
 * scoring a hypothetical pair the reviewer hasn't touched yet).
 */
export function scoreCatalogFuzzy(
  catalog: CatalogProfile,
  fuzzy: FuzzyProfile,
  knownVerdict?: MarketMatchVerdict | null,
  options: ScoreOptions = {},
): number {
  const factors = scoreCatalogFuzzyFactors(catalog, fuzzy, options)
  const raw = Math.max(
    0,
    factors.brand
      * factors.category
      * factors.subcategory
      * factors.size
      * factors.pack
      * factors.strain
      * factors.nameOverlap,
  )
  return applyVerdictPostFilter(raw, knownVerdict)
}

/**
 * Same inputs as `scoreCatalogFuzzy`, but returns the per-field
 * factors before the post-filter. Useful for the "why this was
 * proposed" debug column in the reviewer UI.
 */
export function scoreCatalogFuzzyFactors(
  catalog: CatalogProfile,
  fuzzy: FuzzyProfile,
  options: ScoreOptions = {},
): ScoreFactors {
  return {
    brand: brandFactor(catalog.brandNorm, fuzzy.brandNorm, options.brandAliasMatch === true),
    category: categoryFactor(catalog.categoryNorm, fuzzy.categoryNorm, options.categoryAliasMatch === true),
    subcategory: subcategoryFactor(catalog.subcategoryNorm, fuzzy.subcategoryNorm),
    size: sizeFactor(catalog, fuzzy),
    pack: packFactor(catalog.packCountNorm, fuzzy.packCountNorm),
    strain: strainFactor(catalog.strainNorm, fuzzy.strainNorm),
    nameOverlap: nameOverlapFactor(catalog.nameTokens, fuzzy.nameTokens),
  }
}

export function brandFactor(catalogBrand: string | null, fuzzyBrand: string | null, aliasMatch: boolean): number {
  if (catalogBrand && fuzzyBrand && normalize(catalogBrand) === normalize(fuzzyBrand)) return 1.0
  if (aliasMatch) return 0.85
  return 0
}

export function categoryFactor(catalogCategory: string | null, fuzzyCategory: string | null, aliasMatch: boolean): number {
  if (catalogCategory && fuzzyCategory && normalize(catalogCategory) === normalize(fuzzyCategory)) return 1.0
  if (aliasMatch) return 0.70
  return 0
}

export function subcategoryFactor(catalogSub: string | null, fuzzySub: string | null): number {
  if (!catalogSub || !fuzzySub) return 0.90
  if (normalize(catalogSub) === normalize(fuzzySub)) return 1.0
  return 0.70
}

export function sizeFactor(catalog: CatalogProfile, fuzzy: FuzzyProfile): number {
  // Prefer grams when both sides have it; fall back to mg when both
  // sides are mg-only; everything else is "one side missing" (0.50).
  const catG = catalog.sizeGNorm
  const fuzG = fuzzy.sizeGNorm
  if (typeof catG === 'number' && typeof fuzG === 'number') {
    return gaussianSizeAgreement(catG, fuzG)
  }
  const catMg = catalog.sizeMgNorm
  const fuzMg = fuzzy.sizeMgNorm
  if (typeof catMg === 'number' && typeof fuzMg === 'number') {
    return gaussianSizeAgreement(catMg, fuzMg)
  }
  const hasOneSide =
    typeof catG === 'number'
    || typeof fuzG === 'number'
    || typeof catMg === 'number'
    || typeof fuzMg === 'number'
  if (hasOneSide) return 0.50
  // Neither side has a size — treat as no penalty / no boost.
  return 1.0
}

export function packFactor(catalogPack: number | null, fuzzyPack: number | null): number {
  if (typeof catalogPack === 'number' && typeof fuzzyPack === 'number') {
    return catalogPack === fuzzyPack ? 1.0 : 0.30
  }
  if (typeof catalogPack !== 'number') return 0.85
  // Catalog has a pack count, fuzzy doesn't — same uncertainty as the
  // null-catalog case, treat symmetrically.
  return 0.85
}

export function strainFactor(catalogStrain: string | null, fuzzyStrain: string | null): number {
  if (!catalogStrain || !fuzzyStrain) return 0.95
  if (normalize(catalogStrain) === normalize(fuzzyStrain)) return 1.0
  return 0.70
}

/**
 * Floor for the nameOverlap factor when both sides have non-empty
 * tokens but the sets are disjoint. We don't multiply by 0 because
 * brand + category + size could legitimately identify a match even
 * when the residual tokens disagree (e.g. catalog "Lemonade" vs a
 * dispensary listing that only says "Ayrloom Up Drink 10mg" — same
 * SKU, the dispensary just stripped the flavor word). 0.45 is low
 * enough to push such candidates out of the auto-promote band but
 * not so low that they vanish from the reviewer's queue.
 */
export const NAME_OVERLAP_FLOOR = 0.45

/**
 * Jaccard-style overlap of significant name tokens.
 *
 * Semantics:
 *   - Either side `null` (caller didn't extract tokens) → 1.0 (no
 *     effect on score), preserving back-compat with callers that
 *     don't supply nameTokens.
 *   - Both sides empty arrays (caller extracted, found nothing
 *     significant beyond brand/category/size) → 1.0 too — there's
 *     just nothing to distinguish on, treat as a wash.
 *   - One side empty, other non-empty → 0.85 — mild penalty for
 *     "I know something distinguishing on one side but not the
 *     other"; the listing might be under-named.
 *   - Both non-empty → `NAME_OVERLAP_FLOOR + (1 - FLOOR) *
 *     |A ∩ B| / |A ∪ B|`. Identical sets → 1.0, disjoint sets
 *     → FLOOR.
 */
export function nameOverlapFactor(
  catalogTokens: string[] | null | undefined,
  fuzzyTokens: string[] | null | undefined,
): number {
  if (catalogTokens == null || fuzzyTokens == null) return 1.0
  const a = new Set(catalogTokens.map(normalize).filter((t) => t.length > 0))
  const b = new Set(fuzzyTokens.map(normalize).filter((t) => t.length > 0))
  if (a.size === 0 && b.size === 0) return 1.0
  if (a.size === 0 || b.size === 0) return 0.85
  let intersection = 0
  for (const tok of a) {
    if (b.has(tok)) intersection += 1
  }
  const union = a.size + b.size - intersection
  if (union === 0) return 1.0
  const jaccard = intersection / union
  return NAME_OVERLAP_FLOOR + (1 - NAME_OVERLAP_FLOOR) * jaccard
}

export function applyVerdictPostFilter(rawScore: number, verdict: MarketMatchVerdict | null | undefined): number {
  if (verdict === 'no_match') return 0
  if (verdict === 'exact') return Math.max(rawScore, 0.99)
  if (verdict === 'brand_family') return Math.max(Math.min(rawScore, 0.85), 0.50)
  return rawScore
}

function gaussianSizeAgreement(a: number, b: number): number {
  const maxSize = Math.max(a, b)
  if (maxSize === 0) return 1.0
  const delta = Math.abs(a - b)
  const ratio = delta / maxSize
  return Math.exp(-(ratio ** 2) * 4)
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}
