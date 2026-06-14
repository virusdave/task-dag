// ---------------------------------------------------------------------------
// Catalog cohort key — the single source of truth for "which set of items do
// we compare a variant against in the cohort scatter plots".
//
// A cohort is the cartesian grouping of:
//   category × subcategory × unit-size × pack-count
//
// `null` on any dimension is itself a MEANINGFUL, distinct bucket (e.g. a
// product with no subcategory only ever compares against other no-subcategory
// peers, never against subcategorised ones). That's why each dimension folds
// `null` to an explicit sentinel rather than dropping it.
//
// This lives in `shared/` so the client cohort overlays (CatalogAnalyticsTab)
// and the server CSV snapshot exports build byte-identical keys — if they ever
// drifted, the CSV's `cohort_key` column would no longer describe the same
// peer set the scatter plots draw. The format below is the historical key the
// scatter cohorts already use; do not change it without re-keying both sides.
// ---------------------------------------------------------------------------

export interface CatalogUnitSize {
  /** Raw unit-size label, e.g. "1g", "3.5g", "10mg", "1ct". */
  readonly sizeLabel: string | null
  /** Numeric unit size parsed to grams (e.g. "3.5g" → 3.5), else null. */
  readonly unitSizeGrams: number | null
  /** Numeric unit size parsed to milligrams (e.g. "10mg" → 10), else null. */
  readonly unitSizeMg: number | null
}

export interface CatalogCohortInput extends CatalogUnitSize {
  readonly categoryName: string | null
  readonly subcategoryName: string | null
  /** Units per package (`packOfSize`); 1 for singles, >1 for multipacks. */
  readonly packCount: number | null
}

/**
 * The unit-size dimension of the cohort key. Prefers the parsed numeric size
 * (so "1g" and "1 g" collapse) and falls back to the raw label.
 */
export function cohortUnitSizeKey(input: CatalogUnitSize): string {
  if (input.unitSizeGrams != null) return `g:${input.unitSizeGrams}`
  if (input.unitSizeMg != null) return `mg:${input.unitSizeMg}`
  return `label:${input.sizeLabel ?? '(no size)'}`
}

/**
 * Build the synthetic cohort key for a variant. Stable and identical across
 * client charts and server CSV exports.
 */
export function buildCatalogCohortKey(input: CatalogCohortInput): string {
  return [
    input.categoryName ?? '(no cat)',
    input.subcategoryName ?? '(no sub)',
    cohortUnitSizeKey(input),
    input.packCount == null ? '(no pack)' : `pack:${input.packCount}`,
  ].join('|')
}

/**
 * Parse a Sweed `sizeName` string into its numeric unit size in grams +
 * milligrams (whichever the input expresses, never both).
 *
 *   "1g"     → { grams: 1,    mg: null }
 *   "3.5g"   → { grams: 3.5,  mg: null }
 *   "10mg"   → { grams: null, mg: 10 }
 *   "100 MG" → { grams: null, mg: 100 }
 *   "1oz"    → { grams: 28.3495, mg: null }
 *   "1ct" / "Each" / unparseable → { grams: null, mg: null }
 *
 * `mg` parsing takes precedence — "10mg" must not be misread as 10g.
 */
export function parseUnitSize(sizeLabel: string | null): {
  grams: number | null
  mg: number | null
} {
  if (!sizeLabel) return { grams: null, mg: null }
  const s = sizeLabel.trim().toLowerCase()
  if (s.length === 0) return { grams: null, mg: null }
  // Try mg first (otherwise "10mg" matches the `g` branch as 10g).
  const mgMatch = s.match(/(\d+(?:\.\d+)?)\s*mg\b/)
  if (mgMatch?.[1]) {
    const n = Number.parseFloat(mgMatch[1])
    if (Number.isFinite(n) && n > 0) return { grams: null, mg: n }
  }
  // Grams — require a word boundary to avoid "mg".
  const gMatch = s.match(/(\d+(?:\.\d+)?)\s*g\b/)
  if (gMatch?.[1]) {
    const n = Number.parseFloat(gMatch[1])
    if (Number.isFinite(n) && n > 0) return { grams: n, mg: null }
  }
  // Ounces — convert to grams (1 oz ≈ 28.3495 g).
  const ozMatch = s.match(/(\d+(?:\.\d+)?)\s*oz\b/)
  if (ozMatch?.[1]) {
    const n = Number.parseFloat(ozMatch[1])
    if (Number.isFinite(n) && n > 0) return { grams: n * 28.3495, mg: null }
  }
  return { grams: null, mg: null }
}
