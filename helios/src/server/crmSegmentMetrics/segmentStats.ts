// Cheap, honest significance helpers for CRM segment-vs-rest comparison
// (CRM Segment Analysis tab, virusdave/top-level#12).
//
// Methodology fixed by the 2026-06 oracle review (see EPIC_PLAN.md §0):
//   - Baseline is REST (everyone − segment), never "everyone" (avoids
//     partial self-comparison).
//   - Rates / shares: two-proportion z (pooled SE for the test).
//   - Continuous (AOV, $/customer): Welch t; with our modest n a normal
//     approximation of the p-value is adequate and we gate on healthy n.
//   - Families of many tests (e.g. per-channel): Benjamini-Hochberg FDR.
//   - Suppress significance for tiny samples; never claim causality.
//
// Pure functions only — unit-tested without a DB (segmentStats.test.ts).

export type ConfidenceLabel = 'strong' | 'notable' | 'directional' | 'too_small'

// Min per-group sample size below which we refuse to badge significance.
export const MIN_GROUP_N = 30
// Min expected successes/failures for the normal approximation to a
// proportion to be trustworthy.
const MIN_EXPECTED_CELL = 5

// Abramowitz & Stegun 7.1.26 erf approximation — plenty accurate for badge
// thresholds. |error| < 1.5e-7.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax)
  return sign * y
}

/** Standard-normal CDF. */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2))
}

/** Two-sided p-value for a z statistic. */
export function twoSidedPFromZ(z: number): number {
  return 2 * (1 - normalCdf(Math.abs(z)))
}

export interface ProportionTest {
  readonly segmentRate: number | null
  readonly restRate: number | null
  /** segmentRate − restRate (percentage points as a fraction). */
  readonly deltaPp: number | null
  /** segmentRate / restRate; 1 = parity, >1 = over-index. */
  readonly index: number | null
  readonly z: number | null
  readonly pValue: number | null
}

/**
 * Two-proportion z test (segment vs rest). `xSeg`/`xRest` are successes,
 * `nSeg`/`nRest` are the group sizes. Returns nulls (rather than NaN/Infinity)
 * when a denominator is zero so the contract stays clean.
 */
export function twoProportionTest(
  xSeg: number,
  nSeg: number,
  xRest: number,
  nRest: number,
): ProportionTest {
  const segmentRate = nSeg > 0 ? xSeg / nSeg : null
  const restRate = nRest > 0 ? xRest / nRest : null
  if (segmentRate === null || restRate === null) {
    return { segmentRate, restRate, deltaPp: null, index: null, z: null, pValue: null }
  }
  const deltaPp = segmentRate - restRate
  const index = restRate > 0 ? segmentRate / restRate : null
  const pPool = (xSeg + xRest) / (nSeg + nRest)
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / nSeg + 1 / nRest))
  const z = se > 0 ? deltaPp / se : null
  const pValue = z === null ? null : twoSidedPFromZ(z)
  return { segmentRate, restRate, deltaPp, index, z, pValue }
}

/** Whether a two-proportion comparison is large enough to badge at all. */
export function proportionSampleOk(
  xSeg: number,
  nSeg: number,
  xRest: number,
  nRest: number,
): boolean {
  if (nSeg < MIN_GROUP_N || nRest < MIN_GROUP_N) return false
  // Expected successes & failures in both groups.
  const cells = [xSeg, nSeg - xSeg, xRest, nRest - xRest]
  return cells.every((c) => c >= MIN_EXPECTED_CELL)
}

export interface WelchTest {
  readonly meanSeg: number | null
  readonly meanRest: number | null
  readonly delta: number | null
  readonly index: number | null
  readonly t: number | null
  /** Normal-approximation two-sided p-value (adequate for our n). */
  readonly pValue: number | null
}

/**
 * Welch (unequal-variance) t test on group means. Variances are sample
 * variances (var_samp). With n≥30 per group the normal approximation of the
 * p-value is adequate; callers should still gate badges on healthy n.
 */
export function welchTest(
  meanSeg: number,
  varSeg: number,
  nSeg: number,
  meanRest: number,
  varRest: number,
  nRest: number,
): WelchTest {
  if (nSeg < 2 || nRest < 2) {
    return { meanSeg: null, meanRest: null, delta: null, index: null, t: null, pValue: null }
  }
  const delta = meanSeg - meanRest
  const index = meanRest !== 0 ? meanSeg / meanRest : null
  const se = Math.sqrt(varSeg / nSeg + varRest / nRest)
  const t = se > 0 ? delta / se : null
  const pValue = t === null ? null : twoSidedPFromZ(t)
  return { meanSeg, meanRest, delta, index, t, pValue }
}

/**
 * Benjamini-Hochberg FDR adjustment. Returns q-values aligned to the input
 * order. `null` p-values (untestable cells) pass through as `null` and are
 * excluded from the m used for correction.
 */
export function benjaminiHochberg(pValues: ReadonlyArray<number | null>): Array<number | null> {
  const indexed = pValues
    .map((p, i) => ({ p, i }))
    .filter((x): x is { p: number; i: number } => x.p !== null)
  const m = indexed.length
  const out: Array<number | null> = pValues.map(() => null)
  if (m === 0) return out
  indexed.sort((a, b) => a.p - b.p)
  // Walk from largest p to smallest, enforcing monotone non-increasing q.
  let prev = 1
  for (let rank = m; rank >= 1; rank--) {
    const { p, i } = indexed[rank - 1]
    const q = Math.min(prev, (p * m) / rank)
    out[i] = q
    prev = q
  }
  return out
}

/**
 * Confidence badge from a q-value (or raw p when no family correction
 * applies) plus a sample-size gate. Order: too_small → directional →
 * notable → strong.
 */
export function confidenceLabel(qOrP: number | null, sampleOk: boolean): ConfidenceLabel {
  if (!sampleOk || qOrP === null) return 'too_small'
  if (qOrP <= 0.05) return 'strong'
  if (qOrP <= 0.1) return 'notable'
  return 'directional'
}
