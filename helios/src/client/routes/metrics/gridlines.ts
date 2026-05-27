import type { MetricAggregation } from '../../../shared/contracts/index.js'

// ---------------------------------------------------------------------------
// Gridline tick generation for the metric chart.
//
// Two independent axes:
//
//   * Y — quantitative. We want "nice" round numbers as gridline values:
//     the least-significant digit is preferably 5 or 0, occasionally 2/4/6/8
//     when that produces a smoother split of the range (e.g. dividing [0,1]
//     into fifths gives 0.0, 0.2, 0.4, 0.6, 0.8, 1.0). Implemented via the
//     classic Heckbert "loose labels" choose-step algorithm.
//
//   * X — temporal. Ticks are placed at the metric's bucket boundaries so
//     each gridline lines up with the underlying data grain. If the visible
//     span has so many buckets that one-per-bucket would over-label, we step
//     by a power-of-2 multiple of the bucket grain.
// ---------------------------------------------------------------------------

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

// =============================================================================
// Y axis
// =============================================================================

/**
 * Pick a step size that, when multiplied by 10^N, lands on one of the
 * preferred bases. Order matters: we prefer 1/2/5/10 above all so the
 * least-significant digit is 0 or 5. The intermediate bases (2.5) are
 * included so a [0, 1] range with target=5 gives 0.2 steps rather than
 * defaulting to 0.5 (which would only emit three labels).
 */
const PREFERRED_BASES: ReadonlyArray<number> = [1, 2, 2.5, 5, 10]

export interface YTickSet {
  readonly ticks: ReadonlyArray<number>
  readonly step: number
  /** number of fractional digits the step demands (so labels match). */
  readonly fractionDigits: number
}

/**
 * Compute a set of "nice" round-number Y-axis ticks covering [min, max].
 *
 * @param min            Lower bound of the data range.
 * @param max            Upper bound of the data range.
 * @param targetCount    Approximate desired number of intervals (default 5).
 *                       The actual number of ticks is usually within ±2 of this.
 */
export function niceYTicks(min: number, max: number, targetCount = 5): YTickSet {
  // Degenerate range: emit a single tick at min.
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return { ticks: [min], step: 0, fractionDigits: 0 }
  }
  if (min > max) {
    return niceYTicks(max, min, targetCount)
  }
  const range = max - min
  const targetStep = range / Math.max(1, targetCount)
  const magnitude = Math.pow(10, Math.floor(Math.log10(targetStep)))
  // Pick the smallest preferred base whose step >= targetStep (rounded up),
  // searched at three magnitudes (×0.1, ×1, ×10) so very small / very large
  // ranges still pick a base from PREFERRED_BASES.
  let bestStep = magnitude * 10
  for (const mag of [magnitude * 0.1, magnitude, magnitude * 10]) {
    for (const base of PREFERRED_BASES) {
      const step = base * mag
      if (step >= targetStep && step < bestStep) {
        bestStep = step
      }
    }
  }
  const step = bestStep
  const lo = Math.floor(min / step) * step
  const hi = Math.ceil(max / step) * step
  const ticks: number[] = []
  // Walk from lo to hi inclusive. Floating-point: round to step's precision
  // to avoid 0.30000000000000004 drift.
  const fractionDigits = stepFractionDigits(step)
  const factor = Math.pow(10, fractionDigits)
  for (let v = lo; v <= hi + step * 0.0001; v += step) {
    ticks.push(Math.round(v * factor) / factor)
  }
  return { ticks, step, fractionDigits }
}

/**
 * How many decimal places `step` needs so that representing tick values
 * as `value.toFixed(digits)` doesn't lose information.
 *
 *   step = 1      → 0
 *   step = 0.2    → 1
 *   step = 2.5    → 1  ← critical: was 0, which made [0,12] emit
 *                       [0, 3, 5, 8, 10, 13] (each tick rounded to int)
 *   step = 0.25   → 2
 *   step = 0.025  → 3
 *   step = 200000 → 0
 */
function stepFractionDigits(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0
  const abs = Math.abs(step)
  for (let digits = 0; digits <= 12; digits += 1) {
    const scaled = abs * Math.pow(10, digits)
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) {
      return digits
    }
  }
  return 12
}

/**
 * Format a Y-axis tick value for display. Uses fixed-digit formatting when
 * the step demands it (so 0.2-step ticks display as "0.0, 0.2, 0.4, ..."
 * not "0, 0.2, 0.4, 0.6, 0.8, 1") and compact-notation for large numbers.
 */
export function formatYTick(value: number, fractionDigits: number): string {
  if (Math.abs(value) >= 1000) {
    // Compact for thousands+
    return COMPACT_FMT.format(value)
  }
  if (fractionDigits > 0) {
    return value.toFixed(fractionDigits)
  }
  return String(Math.round(value))
}

const COMPACT_FMT = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 2,
})

// =============================================================================
// X axis
// =============================================================================

/**
 * Pick a tick step (in units of the metric's bucket grain) such that the
 * visible window emits ~`targetCount` labels and the resulting labels don't
 * over-pack horizontally.
 *
 * Bucket grain is implied by `agg`; for categorical aggregations
 * (`total`, `dow`, `dom`, `dofortnight`) the X axis isn't really a time
 * axis and we return an empty tick list — the chart falls back to drawing
 * its from/to corner labels only.
 */
export function bucketXTicks(args: {
  fromMs: number
  toMs: number
  agg: MetricAggregation
  /** Approximate target number of ticks across the visible width. Default 6. */
  targetCount?: number
}): number[] {
  const { fromMs, toMs, agg } = args
  const targetCount = args.targetCount ?? 6
  if (toMs <= fromMs) return []
  if (agg === 'total' || agg === 'dow' || agg === 'dom' || agg === 'dofortnight') {
    return []
  }

  switch (agg) {
    case 'hour':
      return walkFixedStep(fromMs, toMs, HOUR_MS, targetCount, 'hour')
    case 'date':
      return walkFixedStep(fromMs, toMs, DAY_MS, targetCount, 'date')
    case 'week':
      // Align to ISO-week boundary (Monday 00:00 UTC) so the first tick
      // matches the bucket walker exactly.
      return walkFixedStep(fromMs, toMs, 7 * DAY_MS, targetCount, 'week')
    case 'month':
      // Months are calendar-irregular: step is one month, not 30 days.
      return walkCalendarMonths(fromMs, toMs, targetCount)
  }
}

const STEP_MULTIPLIER_LADDER: ReadonlyArray<number> = [
  1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96,
]

/**
 * Pick the smallest multiplier from the ladder >= `desired`. If `desired`
 * is bigger than the ladder's tail, extend by doubling so very wide
 * windows (e.g. a full year at hourly aggregation) still degrade
 * gracefully instead of slamming into a hardcoded 96-tick cap.
 */
function pickBucketMultiplier(desired: number): number {
  for (const m of STEP_MULTIPLIER_LADDER) {
    if (m >= desired) return m
  }
  let m = STEP_MULTIPLIER_LADDER[STEP_MULTIPLIER_LADDER.length - 1]!
  while (m < desired) m *= 2
  return m
}

function walkFixedStep(
  fromMs: number,
  toMs: number,
  grainMs: number,
  targetCount: number,
  align: 'hour' | 'date' | 'week',
): number[] {
  const span = toMs - fromMs
  const desiredStepMs = span / Math.max(1, targetCount)
  const desiredMultiplier = desiredStepMs / grainMs
  const multiplier = pickBucketMultiplier(desiredMultiplier)
  const stepMs = grainMs * multiplier
  // Snap fromMs DOWN to the nearest bucket boundary of `align`, so the
  // first tick lines up with the metric's underlying buckets.
  const aligned = floorToAlign(fromMs, align)
  const out: number[] = []
  // First tick at the first aligned bucket >= fromMs.
  let t = aligned
  if (t < fromMs) {
    // Walk forward in stepMs increments to the first tick inside the
    // visible window.
    const delta = fromMs - t
    const stepsForward = Math.ceil(delta / stepMs)
    t = t + stepsForward * stepMs
  }
  const CAP = 256 // safety
  while (t <= toMs && out.length < CAP) {
    out.push(t)
    t += stepMs
  }
  return out
}

function floorToAlign(ms: number, align: 'hour' | 'date' | 'week'): number {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const mo = d.getUTCMonth()
  const day = d.getUTCDate()
  const hour = d.getUTCHours()
  switch (align) {
    case 'hour':
      return Date.UTC(y, mo, day, hour)
    case 'date':
      return Date.UTC(y, mo, day)
    case 'week': {
      // ISO week: Monday=0..Sunday=6 (JS getUTCDay: Sun=0..Sat=6).
      const dow = (d.getUTCDay() + 6) % 7
      return Date.UTC(y, mo, day - dow)
    }
  }
}

function walkCalendarMonths(fromMs: number, toMs: number, targetCount: number): number[] {
  const span = toMs - fromMs
  // Average month ≈ 30.44 days for the multiplier picker only.
  const desiredStepMonths = Math.max(
    1,
    Math.ceil(span / (30.44 * DAY_MS) / Math.max(1, targetCount)),
  )
  // Snap to common month steps so labels are predictable. Beyond 2 years
  // extend by whole-year multiples so multi-decade windows still pick a
  // sensible step instead of capping at 24mo.
  const ladder = [1, 2, 3, 4, 6, 12, 24]
  let stepMonths = ladder[ladder.length - 1]!
  let matched = false
  for (const m of ladder) {
    if (m >= desiredStepMonths) {
      stepMonths = m
      matched = true
      break
    }
  }
  if (!matched) {
    stepMonths = Math.ceil(desiredStepMonths / 12) * 12
  }
  const from = new Date(fromMs)
  // Snap to first-of-month UTC at or before fromMs.
  let cursorY = from.getUTCFullYear()
  let cursorM = from.getUTCMonth()
  let cursorMs = Date.UTC(cursorY, cursorM, 1)
  if (cursorMs < fromMs) {
    // Advance one month at a time until inside the window.
    while (cursorMs < fromMs) {
      cursorM += 1
      if (cursorM >= 12) {
        cursorY += 1
        cursorM = 0
      }
      cursorMs = Date.UTC(cursorY, cursorM, 1)
    }
  }
  const out: number[] = []
  const CAP = 96
  while (cursorMs <= toMs && out.length < CAP) {
    out.push(cursorMs)
    cursorM += stepMonths
    while (cursorM >= 12) {
      cursorY += 1
      cursorM -= 12
    }
    cursorMs = Date.UTC(cursorY, cursorM, 1)
  }
  return out
}

/**
 * Format an X-axis tick label according to the aggregation grain.
 *
 * Hour grain emits "MM-DD HH" so the day is visible alongside the hour.
 * Date grain emits "MMM DD" (or "YYYY MMM DD" when the visible window
 * straddles a year boundary). Week grain emits the week-start date as
 * "MMM DD". Month grain emits "MMM YYYY".
 */
// =============================================================================
// Smoothed line paths
// =============================================================================

/**
 * Build an SVG path string that draws a smoothed line through a sequence of
 * already-scaled (x, y) screen-space points. Uses Catmull-Rom-to-Bezier
 * conversion with tension=0.5, which gives gentle curves that pass through
 * every data point without spurious oscillations between widely-spaced
 * points.
 *
 *   * `points.length === 0` → returns ''.
 *   * `points.length === 1` → returns 'M x,y' (degenerate, but valid).
 *   * `points.length === 2` → returns a single 'M…L…' segment (a curve
 *     through two points is just a line).
 *
 * The returned string is suitable for both `<path d=...>` strokes and, when
 * the caller appends a closing segment + `Z`, filled areas (stacked charts).
 */
export function smoothedPath(points: ReadonlyArray<{ x: number; y: number }>): string {
  const n = points.length
  if (n === 0) return ''
  const p0 = points[0]!
  if (n === 1) return `M${p0.x.toFixed(2)},${p0.y.toFixed(2)}`
  if (n === 2) {
    const p1 = points[1]!
    return `M${p0.x.toFixed(2)},${p0.y.toFixed(2)} L${p1.x.toFixed(2)},${p1.y.toFixed(2)}`
  }
  // Tension: standard Catmull-Rom uses 0.5 (each control point is 1/6 of
  // the chord). Lower → gentler curves, higher → tighter.
  const t = 0.5
  let d = `M${p0.x.toFixed(2)},${p0.y.toFixed(2)}`
  for (let i = 0; i < n - 1; i += 1) {
    const p_prev = points[i - 1] ?? points[i]!
    const p_curr = points[i]!
    const p_next = points[i + 1]!
    const p_after = points[i + 2] ?? points[i + 1]!
    const c1x = p_curr.x + ((p_next.x - p_prev.x) / 6) * t * 2
    const c1y = p_curr.y + ((p_next.y - p_prev.y) / 6) * t * 2
    const c2x = p_next.x - ((p_after.x - p_curr.x) / 6) * t * 2
    const c2y = p_next.y - ((p_after.y - p_curr.y) / 6) * t * 2
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p_next.x.toFixed(2)},${p_next.y.toFixed(2)}`
  }
  return d
}

/**
 * Build a small ×-shaped SVG path centred on (x, y) with arm length r.
 * Cheap to render (one `<path>` per marker) and visually distinct from
 * dots without competing with annotation circles.
 */
export function crossMarkerPath(x: number, y: number, r = 3): string {
  return `M${(x - r).toFixed(2)},${(y - r).toFixed(2)} L${(x + r).toFixed(2)},${(y + r).toFixed(2)} M${(x + r).toFixed(2)},${(y - r).toFixed(2)} L${(x - r).toFixed(2)},${(y + r).toFixed(2)}`
}

export function formatXTick(ms: number, agg: MetricAggregation, opts: { straddlesYear: boolean } = { straddlesYear: false }): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  // Bucket boundaries are computed and stored in UTC (see timeBuckets.ts).
  // We render the tick label in UTC too — otherwise on a server running in
  // a non-UTC timezone (the helios prod box is America/Panama, UTC-05:00),
  // a "May 18" UTC bucket would render as "May 17" local, mis-aligning the
  // tick label from the data underneath it.
  switch (agg) {
    case 'hour':
      return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:00`
    case 'date':
    case 'week':
      return opts.straddlesYear
        ? `${d.getUTCFullYear()} ${monthNames[d.getUTCMonth()]} ${pad(d.getUTCDate())}`
        : `${monthNames[d.getUTCMonth()]} ${pad(d.getUTCDate())}`
    case 'month':
      return `${monthNames[d.getUTCMonth()]} ${d.getUTCFullYear()}`
    case 'total':
    case 'dow':
    case 'dom':
    case 'dofortnight':
      // Categorical: caller shouldn't be rendering x ticks at all, but
      // return something sensible if they do.
      return `${monthNames[d.getUTCMonth()]} ${pad(d.getUTCDate())}`
  }
}
