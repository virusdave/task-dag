// ===========================================================================
// Balanced ratio axis ("reciprocal fold" around 1.0)
// ===========================================================================
//
// Several catalog-analytics scatter axes are cohort-relative *ratios*
// where 1.0 = the cohort baseline (velocity index, effective-price
// index, list ÷ market ratio). On a plain linear axis high performers
// (r = 1 → 5) get plenty of vertical room but low performers get
// crushed into [0, 1): 0.5×, 0.33×, 0.25× all pile up near the bottom.
//
// This transform gives the operator equal visual precision above AND
// below the 1.0 baseline simultaneously. It keeps r ≥ 1 linear (so high
// performers stay precise) and mirrors r < 1 via its reciprocal into the
// negative direction, "glued" at 1.0:
//
//     t(r) = r − 1        for r ≥ 1     (linear above baseline)
//     t(r) = 1 − 1/r      for 0 < r < 1 (negative; 0.5→−1, 0.33→−2)
//
// It is odd-symmetric about the baseline — t(r) = −t(1/r), so 0.5× sits
// exactly as far below 1× as 2× sits above — and is C¹-continuous at
// r = 1 (left derivative 1/r² = 1, right derivative 1; the slopes match,
// there is no kink). This is deliberately NOT a log axis: log would
// compress the high end, which is the opposite of what we want here.
//
// Design + rationale: oracle review 2026-07-01 (catalog balanced ratio
// scale). Pure module so the transform / inverse / floor / tick math is
// unit-tested independently of the React renderer.

/**
 * Never place the zero / no-movement floor tick ABOVE the mirror of 5×
 * (i.e. 0.2×, transformed −4). The actual floor is pushed further down
 * when real low performers plot below that, so a never-sold (r = 0) dot
 * always sits beneath every positive-ratio dot (correct ordering).
 */
export const RATIO_ZERO_FLOOR_CAP = -4

/**
 * Forward transform for a strictly-positive ratio (must be finite and
 * > 0 — callers handle r ≤ 0 / null via {@link ratioZeroFloor}).
 */
export function ratioForward(r: number): number {
  if (r >= 1) return r - 1
  return 1 - 1 / r
}

/** Inverse of {@link ratioForward}: transformed coordinate → raw ratio. */
export function ratioInverse(t: number): number {
  if (t >= 0) return 1 + t
  return 1 / (1 - t)
}

/**
 * Transformed coordinate for a zero / non-positive / missing ratio
 * (e.g. a never-sold variant with velocity index 0). We cannot use
 * −Infinity (the dot would be dropped by the renderer's finite check),
 * so pick a finite floor that sits BELOW every real positive point:
 * one whole transformed unit under the smallest positive value, and
 * never higher than {@link RATIO_ZERO_FLOOR_CAP}.
 */
export function ratioZeroFloor(minFiniteTransformed: number | null): number {
  if (minFiniteTransformed == null || !Number.isFinite(minFiniteTransformed)) {
    return RATIO_ZERO_FLOOR_CAP
  }
  return Math.min(RATIO_ZERO_FLOOR_CAP, Math.floor(minFiniteTransformed) - 1)
}

export interface RatioTick {
  /** Position in transformed axis coordinates. */
  readonly pos: number
  /** Human label in *raw ratio* units, e.g. "0.50×", "1.00×", "0×". */
  readonly label: string
}

// Reciprocal-paired "above baseline" anchor ladders, fine → coarse. For
// each anchor `a` we also emit its reciprocal `1/a`, so the axis always
// shows matched pairs (1.5× has 0.67×, 2× has 0.50×, …). We pick the
// FINEST tier whose in-range tick count fits `maxTicks`.
const TICK_TIERS: ReadonlyArray<ReadonlyArray<number>> = [
  [1.25, 1.5, 2, 3, 4, 5, 7, 10, 15, 20, 30, 50, 100],
  [1.5, 2, 3, 5, 10, 20, 50, 100],
  [2, 3, 5, 10, 50, 100],
  [2, 5, 20, 100],
]

/**
 * Ticks for a balanced ratio axis over the transformed window
 * [tMin, tMax]. Positions are transformed coordinates; labels are the
 * corresponding raw ratios. Always includes 1.0× when the baseline is
 * in view, always emits reciprocal pairs, and (when `zeroFloor` is
 * supplied and in range) a "0×" sentinel tick for the no-movement floor.
 */
export function ratioTicks(
  tMin: number,
  tMax: number,
  opts: {
    readonly format: (r: number) => string
    /** Transformed position of the zero floor, or null when no zeros. */
    readonly zeroFloor?: number | null
    readonly maxTicks?: number
  },
): RatioTick[] {
  const maxTicks = opts.maxTicks ?? 9
  const lo = Math.min(tMin, tMax)
  const hi = Math.max(tMin, tMax)
  const inRange = (t: number) => t >= lo && t <= hi

  let chosen: number[] = inRange(0) ? [1] : []
  for (const tier of TICK_TIERS) {
    const raws: number[] = inRange(0) ? [1] : []
    for (const a of tier) {
      if (inRange(ratioForward(a))) raws.push(a)
      const recip = 1 / a
      if (inRange(ratioForward(recip))) raws.push(recip)
    }
    const uniq = Array.from(new Set(raws)).sort(
      (x, y) => ratioForward(x) - ratioForward(y),
    )
    chosen = uniq
    if (uniq.length <= maxTicks) break
  }

  const ticks: RatioTick[] = chosen.map((r) => ({
    pos: ratioForward(r),
    label: opts.format(r),
  }))

  if (opts.zeroFloor != null && inRange(opts.zeroFloor)) {
    ticks.unshift({ pos: opts.zeroFloor, label: '0×' })
  }
  return ticks
}
