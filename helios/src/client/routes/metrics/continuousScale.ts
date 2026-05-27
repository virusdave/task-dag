// ---------------------------------------------------------------------------
// Distribution-aware continuous scales for scatter colour / size / opacity.
//
// Operator complaint that drove this:
//   "Bucketing GM% in 5pp bands is way too fine at the fringes and WAY
//    too coarse in the 47.5–62.5 bulk. Put the colour resolution where
//    the data actually lives."
//
// The fix: when the underlying distribution is *not* approximately
// uniform, we map each value through its empirical CDF (i.e. its
// percentile rank in the current data) before driving the visual
// channel. That is mathematically the same as applying a custom
// inverse-CDF stretch, but it works for any shape (Gaussian,
// log-normal, exponential, bi-modal) without us having to detect
// which. The resolution naturally concentrates wherever the data
// concentrates.
//
// When the data IS approximately uniform we keep a plain linear scale
// — applying the rank transform there would only be lossy ceremony.
//
// The colour ramp itself is a perceptual red → green diverging ramp:
//   * `bad` end (per the metric's `betterDirection`): bright red
//   * mid: dull / desaturated (low-information zone)
//   * `good` end: bright green
//
// Saturation peaks at the extremes so the operator's eye is drawn to
// the outliers in the "good" or "bad" direction; the mid band stays
// quiet so the cloud doesn't shout for attention.
// ---------------------------------------------------------------------------

/**
 * Direction of "good" for a numeric metric:
 *
 *   - `higher` — bigger value is better (GM%, margin $, units sold,
 *                sales-day coverage, …)
 *   - `lower`  — smaller value is better (days out-of-stock,
 *                discount depth %, weeks of over-supply, …)
 *
 * Drives which end of the red → green ramp this metric's max value
 * maps to. Same convention used by the size / opacity stretch for
 * neutral "draw the eye to the extremes" emphasis.
 */
export type BetterDirection = 'higher' | 'lower'

/**
 * Output of `buildContinuousScale` — pure-functional projection from
 * a raw numeric value (or null) to a [0,1] fraction in the metric's
 * "good direction". 0 = worst, 1 = best.
 *
 * `null` raw values produce `null` (the caller should render the dot
 * with a neutral / dim / fallback colour).
 *
 * Exposes `mode` so the legend renderer can show "rank-stretched"
 * vs "linear" provenance to the operator.
 */
export interface ContinuousScale {
  readonly mode: 'linear' | 'rank'
  readonly betterDirection: BetterDirection
  readonly sampleSize: number
  readonly min: number | null
  readonly max: number | null
  /**
   * Apply the scale. Returns null for null / non-finite inputs, or
   * when there is no usable distribution (sampleSize < 2, or all
   * values identical).
   */
  readonly toFraction: (v: number | null | undefined) => number | null
}

/**
 * Build a continuous scale tailored to the given sample.
 *
 *   1. Filter out null / non-finite entries.
 *   2. If <2 distinct values: degenerate — `toFraction` always
 *      returns null (legend should render "uniform"-ish neutral).
 *   3. Run a chi-square uniformity test on a 10-bin histogram. If
 *      we cannot reject uniformity at α=0.05, use a plain
 *      min-max linear scale.
 *   4. Otherwise, use an empirical-CDF (mid-rank percentile) scale
 *      so resolution concentrates where the data lives.
 *   5. Flip the result if `betterDirection === 'lower'` so 0 is
 *      always the "bad" end and 1 is always the "good" end.
 *
 * `values` may contain duplicates / nulls / NaN; the function is
 * responsible for cleaning them.
 */
export function buildContinuousScale(
  values: ReadonlyArray<number | null | undefined>,
  betterDirection: BetterDirection,
): ContinuousScale {
  const clean: number[] = []
  for (const v of values) {
    if (v == null) continue
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    clean.push(v)
  }
  const n = clean.length
  if (n < 2) {
    return {
      mode: 'linear',
      betterDirection,
      sampleSize: n,
      min: n === 1 ? clean[0]! : null,
      max: n === 1 ? clean[0]! : null,
      toFraction: () => null,
    }
  }
  const sorted = clean.slice().sort((a, b) => a - b)
  const min = sorted[0]!
  const max = sorted[sorted.length - 1]!
  if (min === max) {
    return {
      mode: 'linear',
      betterDirection,
      sampleSize: n,
      min,
      max,
      toFraction: () => null,
    }
  }

  const uniform = isApproximatelyUniform(sorted, min, max)

  // Snap `lower`-is-better metrics by inverting the [0,1] mapping at
  // the end. Internally we always work in min→0 / max→1 space.
  const flipIfNeeded = (p: number): number =>
    betterDirection === 'lower' ? 1 - p : p

  if (uniform) {
    const span = max - min
    const toFraction = (v: number | null | undefined): number | null => {
      if (v == null || typeof v !== 'number' || !Number.isFinite(v)) return null
      const p = clamp01((v - min) / span)
      return flipIfNeeded(p)
    }
    return {
      mode: 'linear',
      betterDirection,
      sampleSize: n,
      min,
      max,
      toFraction,
    }
  }

  // Build an empirical-CDF lookup using mid-ranks. Mid-rank is the
  // average position (in 0-indexed sorted order) of a value's run of
  // duplicates, which is the standard handling of ties. Map each
  // distinct value to its mid-rank percentile, (midRank + 0.5) / n.
  //
  // Lookup at query time is a binary search on the sorted-unique list.
  const distinctValues: number[] = []
  const distinctPercentiles: number[] = []
  let i = 0
  while (i < n) {
    const v = sorted[i]!
    let j = i
    while (j < n && sorted[j] === v) j++
    const midRank = (i + j - 1) / 2
    distinctValues.push(v)
    distinctPercentiles.push((midRank + 0.5) / n)
    i = j
  }
  const toFraction = (v: number | null | undefined): number | null => {
    if (v == null || typeof v !== 'number' || !Number.isFinite(v)) return null
    // Below-min or above-max queries clamp to the end percentiles so
    // late-arriving (or filtered-out) points still get a sensible colour.
    if (v <= distinctValues[0]!) return flipIfNeeded(distinctPercentiles[0]!)
    if (v >= distinctValues[distinctValues.length - 1]!) {
      return flipIfNeeded(distinctPercentiles[distinctPercentiles.length - 1]!)
    }
    // Binary search for `v` in distinctValues. On exact match, return
    // that value's percentile. On a between-match, linearly interpolate
    // between neighbours so close-but-not-identical values get
    // smoothly-different colours rather than the next-bucket cliff.
    let lo = 0
    let hi = distinctValues.length - 1
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1
      if (distinctValues[mid]! <= v) lo = mid
      else hi = mid
    }
    const va = distinctValues[lo]!
    const vb = distinctValues[hi]!
    if (va === v) return flipIfNeeded(distinctPercentiles[lo]!)
    if (vb === v) return flipIfNeeded(distinctPercentiles[hi]!)
    const t = (v - va) / (vb - va)
    const p = distinctPercentiles[lo]! + t * (distinctPercentiles[hi]! - distinctPercentiles[lo]!)
    return flipIfNeeded(clamp01(p))
  }
  return {
    mode: 'rank',
    betterDirection,
    sampleSize: n,
    min,
    max,
    toFraction,
  }
}

/**
 * Chi-square goodness-of-fit test against uniform on a 10-bin
 * histogram. Returns `true` (cannot reject uniformity) when the
 * test statistic is below the 95% critical value for 9 dof
 * (≈ 16.919). Sample sizes below 30 are deliberately treated as
 * non-uniform so the rank-stretch always kicks in for small data
 * sets — operators looking at 12 brands want each brand to get a
 * visibly distinct colour, not a near-uniform pastel ramp.
 */
function isApproximatelyUniform(
  sorted: ReadonlyArray<number>,
  min: number,
  max: number,
): boolean {
  const n = sorted.length
  if (n < 30) return false
  const bins = 10
  const counts = new Array<number>(bins).fill(0)
  const span = max - min
  for (const v of sorted) {
    let idx = Math.floor(((v - min) / span) * bins)
    if (idx >= bins) idx = bins - 1
    if (idx < 0) idx = 0
    counts[idx]! += 1
  }
  const expected = n / bins
  let chiSq = 0
  for (const c of counts) chiSq += ((c - expected) * (c - expected)) / expected
  // 95% critical value for chi-square with 9 dof.
  return chiSq < 16.919
}

function clamp01(p: number): number {
  if (p <= 0) return 0
  if (p >= 1) return 1
  return p
}

/**
 * Continuous colour ramp from p ∈ [0,1] → CSS HSL string, with
 *   0 = "bad"  (bright red, hue 0°,   high saturation)
 *   0.5 = "neutral" (dull orange-yellow, low saturation)
 *   1 = "good" (bright green, hue 120°, high saturation)
 *
 * Saturation rises quadratically toward the extremes (peak ~80% at
 * the ends, trough ~22% in the middle) so the operator's eye is
 * drawn to "interesting" outliers and the boring middle stays calm.
 *
 * Lightness sits at 45-50% across the ramp to maintain WCAG-decent
 * contrast against the white plot background.
 */
export function continuumColour(p: number | null): string {
  if (p == null || !Number.isFinite(p)) {
    // Neutral grey for "no data" values — clearly distinct from any
    // colour the ramp itself produces.
    return '#bdbdbd'
  }
  const q = clamp01(p)
  const hue = q * 120 // 0 (red) → 120 (green)
  const dist = Math.abs(q - 0.5) * 2 // 0 at midpoint, 1 at extremes
  const saturation = 22 + dist * dist * 60 // 22% mid → 82% extreme
  // Green at 120° reads brighter than red at 0° at equal HSL lightness;
  // bias the green half slightly darker so the visual weight matches.
  const lightness = q < 0.5 ? 50 - dist * 3 : 47 - dist * 4
  return `hsl(${hue.toFixed(1)}, ${saturation.toFixed(1)}%, ${lightness.toFixed(1)}%)`
}
