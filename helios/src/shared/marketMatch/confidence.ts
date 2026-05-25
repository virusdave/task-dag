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
}

export interface FuzzyProfile {
  brandNorm: string | null
  categoryNorm: string | null
  subcategoryNorm: string | null
  sizeGNorm: number | null
  sizeMgNorm: number | null
  packCountNorm: number | null
  strainNorm: string | null
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
    factors.brand * factors.category * factors.subcategory * factors.size * factors.pack * factors.strain,
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
