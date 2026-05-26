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
  readonly /** number of fractional digits the step demands (so labels match). */
  fractionDigits: number
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

function stepFractionDigits(step: number): number {
  if (step >= 1) return 0
  // e.g. step=0.2 → 1, step=0.025 → 3
  return Math.max(0, -Math.floor(Math.log10(step)) + (looksLikeFraction(step) ? 0 : 0))
}

function looksLikeFraction(step: number): boolean {
  return step < 1 && step > 0
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

const STEP_MULTIPLIER_LADDER: ReadonlyArray<number> = [1, 2, 3, 4, 6, 8, 12, 24, 48, 96]

function walkFixedStep(
  fromMs: number,
  toMs: number,
  grainMs: number,
  targetCount: number,
  align: 'hour' | 'date' | 'week',
): number[] {
  const span = toMs - fromMs
  const desiredStepMs = span / Math.max(1, targetCount)
  // Pick smallest multiplier such that grainMs*mult >= desiredStepMs.
  let multiplier = STEP_MULTIPLIER_LADDER[STEP_MULTIPLIER_LADDER.length - 1]!
  for (const m of STEP_MULTIPLIER_LADDER) {
    if (grainMs * m >= desiredStepMs) {
      multiplier = m
      break
    }
  }
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
  const desiredStepMonths = Math.max(1, Math.round(span / (30.44 * DAY_MS) / Math.max(1, targetCount)))
  // Snap to common month steps so labels are predictable.
  const ladder = [1, 2, 3, 4, 6, 12, 24]
  let stepMonths = ladder[ladder.length - 1]!
  for (const m of ladder) {
    if (m >= desiredStepMonths) {
      stepMonths = m
      break
    }
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
