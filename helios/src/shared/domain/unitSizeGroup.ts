// ---------------------------------------------------------------------------
// Category-aware unit-size "group" equivalency normalizer.
//
// The operator groups product variants by "morally equivalent" unit sizes,
// which is NOT the same as the exact parsed size: for PRE-ROLLS, novelty /
// marketing sizes should roll into a small set of standard buckets (e.g. a
// 0.6 g "big" joint and a 0.5 g joint are the same product family to a
// shopper). Every OTHER category keeps its natural parsed size.
//
// SCOPE (issue #55, task T2): this module is the single source of truth for
// that product-side size-group equivalence, wired ONLY into the temporary
// "Family Explorer" page's grouping (T1). It deliberately does NOT touch the
// cohort keys in `catalogCohort.ts` or `sameSizeFamily` in
// `marketMatch/listingParse.ts` — those drive existing pricing / market-match
// semantics, where the operator requires an EXACT unit+qty match (a 0.25 g
// novelty must never pull down the market price of a "real" 0.35 g multipack).
// Fudging sizes into friendly buckets is a product-grouping concern only.
//
// PRE-ROLL SIZE CONVENTION (verified against the live catalog): `sizeName` is
// the PER-JOINT size, not the total pack, for both gram- and mg-labeled
// variants. So we fold the per-joint size straight from the parsed size
// (mg→g via /1000) and MUST NOT divide by pack count. Examples:
//   "0.5g"    (2x pack) → 0.5 g/joint      → 0.5  bucket
//   "583.3mg" (6x pack) → 0.5833 g/joint   → 0.5  bucket
//   "700mg"   (1x)      → 0.7 g/joint      → 0.75 bucket
// ---------------------------------------------------------------------------

import {
  cohortUnitSizeKey,
  type CatalogUnitSize,
} from './catalogCohort.js'
import { canonicalCategoryNorm } from '../marketMatch/listingParse.js'

/**
 * A standard pre-roll size bucket. Sizes are compared in integer MILLIGRAMS
 * (`minMg`/`maxMg`) so half-open `[min, max)` boundary checks are exact — float
 * grams like `0.3 * 1000 === 299.999…` would otherwise mis-bucket edge cases.
 *
 * This table is the operator-approved set (issue #55 / top-level #35 gate,
 * 2026-07-05). Keep it trivially reviewable: it is a plain data array, and the
 * ranges below are byte-for-byte the confirmed spec. Adjust here as the
 * operator iterates.
 */
export interface PrerollSizeBucket {
  /** The standard size this bucket folds to, in grams. */
  readonly standardGrams: number
  /** Inclusive lower bound of the per-joint size, in integer milligrams. */
  readonly minMg: number
  /** Exclusive upper bound of the per-joint size, in integer milligrams. */
  readonly maxMg: number
}

export const PREROLL_SIZE_BUCKETS: readonly PrerollSizeBucket[] = [
  { standardGrams: 0.35, minMg: 300, maxMg: 450 },
  { standardGrams: 0.5, minMg: 450, maxMg: 650 },
  { standardGrams: 0.75, minMg: 650, maxMg: 900 },
  { standardGrams: 1.0, minMg: 900, maxMg: 1250 },
  { standardGrams: 1.5, minMg: 1250, maxMg: 1750 },
  { standardGrams: 2.0, minMg: 1750, maxMg: 2250 },
  { standardGrams: 2.5, minMg: 2250, maxMg: 2750 },
] as const

/** The smallest standard bucket — the fold-up target for rare tiny sizes. */
const SMALLEST_PREROLL_BUCKET = PREROLL_SIZE_BUCKETS[0]

export interface UnitSizeGroupInput extends CatalogUnitSize {
  /** Raw catalog category name, e.g. "Pre-Rolls", "Flower", "Vapes". */
  readonly categoryName: string | null
}

export interface UnitSizeGroup {
  /** Canonical category family from `canonicalCategoryNorm` (e.g. 'preroll'). */
  readonly categoryNorm: string | null
  /**
   * The per-joint size in grams the normalizer reasoned about, or null when
   * the size could not be parsed. For pre-rolls this is the value that was
   * bucketed; for other categories it echoes the natural parsed grams (null
   * for mg-only / unparseable sizes).
   */
  readonly perJointGrams: number | null
  /** Stable key for the size-group dimension, e.g. "g:0.5", "mg:10". */
  readonly sizeGroupKey: string
  /** Human-readable size-group label, e.g. "0.5 g", "10 mg", "(no size)". */
  readonly sizeGroupLabel: string
  /**
   * The standard bucket grams a pre-roll size folded to, else null (non-preroll
   * or an out-of-range / unparseable pre-roll size that passed through).
   */
  readonly standardGrams: number | null
  /**
   * True only when a pre-roll size was actually COERCED into a bucket (its
   * per-joint size differed from the bucket's standard). An exact "0.5g"
   * landing in the 0.5 bucket is not "folded" — this flag tells the UI when to
   * show a "≈"/"folded to" indicator.
   */
  readonly folded: boolean
}

/** Format a gram value as a compact human label, e.g. 0.5 → "0.5 g". */
function gramsLabel(grams: number): string {
  return `${grams} g`
}

/**
 * Fold a per-joint size (in integer milligrams) into its standard pre-roll
 * bucket. Rare tiny sizes below the smallest bucket fold UP to the smallest
 * standard (product-side only — market matching never sees this). Sizes at or
 * above the largest bucket's upper bound are NOT folded (returns null) so
 * legitimate large sizes pass through as their natural size rather than being
 * forced into an unapproved bucket.
 */
function foldPrerollMgToBucket(perJointMg: number): PrerollSizeBucket | null {
  const largest = PREROLL_SIZE_BUCKETS[PREROLL_SIZE_BUCKETS.length - 1]
  if (largest && perJointMg >= largest.maxMg) return null
  // Rare tiny sizes (< 0.30 g) fold up into the smallest standard bucket.
  if (SMALLEST_PREROLL_BUCKET && perJointMg < SMALLEST_PREROLL_BUCKET.minMg) {
    return SMALLEST_PREROLL_BUCKET
  }
  for (const bucket of PREROLL_SIZE_BUCKETS) {
    if (perJointMg >= bucket.minMg && perJointMg < bucket.maxMg) return bucket
  }
  return null
}

/**
 * Compute the operator's "morally equivalent" size group for a catalog
 * variant. Pre-rolls fold into standard buckets; every other category keeps
 * its natural parsed size (reusing the historical cohort size key so the
 * pass-through key format stays consistent with the rest of the app).
 *
 * Pure and deterministic: no I/O, no clock, no globals.
 */
export function normalizeUnitSizeGroup(input: UnitSizeGroupInput): UnitSizeGroup {
  const categoryNorm = canonicalCategoryNorm(input.categoryName)

  if (categoryNorm === 'preroll') {
    // Per-joint milligrams, taken straight from the parsed size (mg preferred,
    // else grams→mg). NOT divided by pack count — sizeName is per-joint.
    const perJointMg =
      input.unitSizeMg != null
        ? Math.round(input.unitSizeMg)
        : input.unitSizeGrams != null
          ? Math.round(input.unitSizeGrams * 1000)
          : null

    if (perJointMg != null) {
      const perJointGrams = perJointMg / 1000
      const bucket = foldPrerollMgToBucket(perJointMg)
      if (bucket) {
        const folded = perJointMg !== Math.round(bucket.standardGrams * 1000)
        return {
          categoryNorm,
          perJointGrams,
          sizeGroupKey: `g:${bucket.standardGrams}`,
          sizeGroupLabel: gramsLabel(bucket.standardGrams),
          standardGrams: bucket.standardGrams,
          folded,
        }
      }
      // Out-of-range pre-roll size (>= largest bucket): pass through as its
      // natural per-joint size. Emit a `g:` key ourselves (not
      // cohortUnitSizeKey) so a preroll "3g" and "3000mg" don't split.
      return {
        categoryNorm,
        perJointGrams,
        sizeGroupKey: `g:${perJointGrams}`,
        sizeGroupLabel: gramsLabel(perJointGrams),
        standardGrams: null,
        folded: false,
      }
    }
    // Pre-roll with an unparseable size — fall through to the natural key.
  }

  // Non-preroll (or preroll with no numeric size): keep the natural size.
  return {
    categoryNorm,
    perJointGrams: input.unitSizeGrams,
    sizeGroupKey: cohortUnitSizeKey(input),
    sizeGroupLabel: naturalSizeLabel(input),
    standardGrams: null,
    folded: false,
  }
}

/** Human label for a pass-through natural size, mirroring cohortUnitSizeKey. */
function naturalSizeLabel(input: CatalogUnitSize): string {
  if (input.unitSizeGrams != null) return gramsLabel(input.unitSizeGrams)
  if (input.unitSizeMg != null) return `${input.unitSizeMg} mg`
  return input.sizeLabel ?? '(no size)'
}
