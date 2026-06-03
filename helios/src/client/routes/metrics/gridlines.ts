import type { MetricAggregation } from '../../../shared/contracts/index.js'
import {
  nyAddMonthsFromFirst,
  nyFloorToDay,
  nyFloorToHour,
  nyFloorToMonth,
  nyFloorToWeek,
  nyHourTick,
  nyMonthDayTick,
  nyMonthYearTick,
} from '../../app/nyTime.js'

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
// Y axis (and numeric X axis — see niceXTicks at the bottom of this section)
// =============================================================================

/**
 * Pick a step size that, when multiplied by 10^N, lands on one of the
 * preferred bases. Order matters: we prefer 1/2/5/10 above all so the
 * least-significant digit is 0 or 5. The intermediate bases (2.5) are
 * included so a [0, 1] range with target=5 gives 0.2 steps rather than
 * defaulting to 0.5 (which would only emit three labels).
 */
const PREFERRED_BASES: ReadonlyArray<number> = [1, 2, 2.5, 5, 10]

export interface NumericTickSet {
  readonly ticks: ReadonlyArray<number>
  readonly step: number
  /** number of fractional digits the step demands (so labels match). */
  readonly fractionDigits: number
}

/**
 * Back-compat alias retained for callers that imported the old name; new
 * code (especially numeric X-axis callers — see `niceXTicks`) should use
 * `NumericTickSet`.
 */
export type YTickSet = NumericTickSet

/**
 * Shared "loose labels" tick generator used by both the Y axis
 * (`niceYTicks`) and the numeric X axis (`niceXTicks`). Both axes use
 * the identical `{1, 2, 2.5, 5, 10} × 10^k` step ladder and the same
 * `stepFractionDigits` discipline so labels never drift to 3/7/9 in
 * the least-significant digit.
 *
 * Kept as a private helper rather than a third export so the operator-
 * facing API stays small (one helper per axis) while the math lives in
 * one place — see the v1.2 R5 oracle-flagged regression case in
 * `gridlines.test.ts` ("clean 2.5-step ticks", "clean 0.25-step ticks",
 * "clean 0.025-step ticks") for the discipline this enforces.
 */
function niceNumericTicks(min: number, max: number, targetCount: number): NumericTickSet {
  // Degenerate range: emit a single tick at min.
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return { ticks: [min], step: 0, fractionDigits: 0 }
  }
  if (min > max) {
    return niceNumericTicks(max, min, targetCount)
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
 * Compute a set of "nice" round-number Y-axis ticks covering [min, max].
 *
 * @param min            Lower bound of the data range.
 * @param max            Upper bound of the data range.
 * @param targetCount    Approximate desired number of intervals (default 5).
 *                       The actual number of ticks is usually within ±2 of this.
 */
export function niceYTicks(min: number, max: number, targetCount = 5): NumericTickSet {
  return niceNumericTicks(min, max, targetCount)
}

/**
 * Compute a set of "nice" round-number X-axis ticks covering [min, max]
 * for **numeric** (non-time-bucketed) X axes — e.g. the cashier
 * scatter's `discount %`, `same-customer lift %`, the catalog scatter's
 * `cost $`, `unit price $`, etc.
 *
 * Uses the same `{1, 2, 2.5, 5, 10} × 10^k` ladder and the same
 * `stepFractionDigits` discipline as `niceYTicks` so a scatter's X and
 * Y axes render visually consistent ticks (and so the v1.2 R5 oracle-
 * flagged regression — `niceYTicks(0, 12)` emitting `[0, 3, 5, 8, 10,
 * 13]` because `step=2.5` was being rounded to integer precision — is
 * impossible on the X axis too).
 *
 * Note: this is the helper for **numeric** X axes. **Time-bucketed**
 * X axes (the time-series `MetricChart`) use `bucketXTicks` below,
 * which snaps to bucket boundaries rather than nice numbers.
 *
 * @param min            Lower bound of the data range.
 * @param max            Upper bound of the data range.
 * @param targetCount    Approximate desired number of intervals (default 5).
 */
export function niceXTicks(min: number, max: number, targetCount = 5): NumericTickSet {
  return niceNumericTicks(min, max, targetCount)
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
// formatAxisValue — kind-aware single-value formatter
// =============================================================================

/**
 * Declared "kind" of an axis. Drives how `formatAxisValue` renders a
 * tick label so visual conventions (currency symbol, `%`, `1.0×`, etc.)
 * stay consistent across every scatter, sparkline, and histogram in
 * the dashboard.
 *
 *   - `$`        — currency. Compact-notation for $1k+ (`$1.5k`,
 *                  `$1.25M`); two-decimal cents for sub-dollar
 *                  (`$0.42`); whole-dollar for [1, 1000) (`$42`).
 *   - `int`      — whole-number count. Compact for thousands+.
 *   - `pct`      — fraction in [0, 1] rendered as a percentage:
 *                  `0.05 → 5.0%`, `0.42 → 42.0%`, `1 → 100%`.
 *                  Use this when the value is a true fraction; use
 *                  `pct-points` (TODO if needed) for pre-multiplied
 *                  percentage-point deltas.
 *   - `ratio`    — multiplicative ratio (`1.0` = neutral). Renders
 *                  as `1.5×`, `0.75×`.
 *   - `minutes`  — duration in minutes. Renders as `12m`, `1h 23m`,
 *                  `1d 02h 15m`.
 *
 * Each kind has a unit test in `gridlines.test.ts` (v1.4 V4'1
 * exit-criterion).
 */
export type AxisValueKind = '$' | 'int' | 'pct' | 'ratio' | 'minutes'

const MONEY_COMPACT_FMT = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 2,
  style: 'currency',
  currency: 'USD',
})

const PCT_DIGITS = 1

/**
 * Render a numeric tick / axis value according to its declared kind.
 *
 * Returns a small string suitable for an SVG `<text>` tick label.
 * Falls back to `String(value)` for non-finite inputs so a NaN doesn't
 * leak through as "NaN%".
 *
 * This helper exists so V4'1's scatter renderers (Budtender Advanced,
 * Catalog Analytics) — and any V4'4 click-to-drill detail-tab table
 * columns — render axis labels with the same visual conventions as
 * the rest of the dashboard. The existing per-axis `AxisDef.format`
 * functions in `BudtenderPerformanceTab.tsx` / `CatalogAnalyticsTab.tsx`
 * are unchanged; this helper is the canonical implementation new
 * callers should reach for.
 */
export function formatAxisValue(value: number, kind: AxisValueKind): string {
  if (!Number.isFinite(value)) return String(value)
  switch (kind) {
    case '$':
      if (Math.abs(value) >= 1000) {
        return MONEY_COMPACT_FMT.format(value)
      }
      if (Math.abs(value) > 0 && Math.abs(value) < 1) {
        return `$${value.toFixed(2)}`
      }
      // Whole-dollar range. Drop the cents when the value is already
      // an integer so we don't render "$42.00" where "$42" suffices.
      if (Number.isInteger(value)) return `$${value}`
      return `$${value.toFixed(2)}`
    case 'int':
      if (Math.abs(value) >= 1000) return COMPACT_FMT.format(value)
      return String(Math.round(value))
    case 'pct':
      // Operator convention: 1.0 = 100%. We render to 1 decimal place
      // so 0.05 reads as "5.0%" (matches the rest of the dashboard's
      // discount %, retention %, etc. labels) but round-trips cleanly
      // for whole-percent values too.
      return `${(value * 100).toFixed(PCT_DIGITS)}%`
    case 'ratio':
      // Ratio is a small floating-point multiplier; we render to 2
      // significant digits past the decimal so 1.0 = "1.0×" and
      // 1.25 = "1.25×".
      if (Math.abs(value) >= 100) return `${value.toFixed(0)}×`
      if (Math.abs(value) >= 10) return `${value.toFixed(1)}×`
      return `${value.toFixed(2)}×`
    case 'minutes': {
      const m = Math.round(value)
      if (m < 60) return `${m}m`
      if (m < 24 * 60) {
        const h = Math.floor(m / 60)
        const rem = m - h * 60
        return rem === 0 ? `${h}h` : `${h}h ${String(rem).padStart(2, '0')}m`
      }
      const d = Math.floor(m / (24 * 60))
      const remH = Math.floor((m - d * 24 * 60) / 60)
      const remM = m - d * 24 * 60 - remH * 60
      const parts = [`${d}d`]
      if (remH > 0 || remM > 0) parts.push(`${String(remH).padStart(2, '0')}h`)
      if (remM > 0) parts.push(`${String(remM).padStart(2, '0')}m`)
      return parts.join(' ')
    }
  }
}

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
  // NY-local snapping (canon: "Always use NY timezones for aggregate
  // and display"). Day / week tick boundaries snap to NY midnight so
  // they align with the server's NY-bucketed data; hour boundaries
  // snap to top-of-hour, which for NY's whole-hour DST offset is the
  // same UTC instant either way but we route through nyFloorToHour
  // for consistency.
  switch (align) {
    case 'hour':
      return nyFloorToHour(ms)
    case 'date':
      return nyFloorToDay(ms)
    case 'week':
      return nyFloorToWeek(ms)
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
  // Snap to first-of-month NY-local at or before fromMs (canon: NY
  // wall-clock for every metrics boundary). nyFloorToMonth returns
  // the UTC instant of NY midnight on the 1st of the containing
  // month; nyAddMonthsFromFirst advances one or more months while
  // staying anchored to NY first-of-month midnight (DST-safe).
  let cursorMs = nyFloorToMonth(fromMs)
  while (cursorMs < fromMs) {
    cursorMs = nyAddMonthsFromFirst(cursorMs, 1)
  }
  const out: number[] = []
  const CAP = 96
  while (cursorMs <= toMs && out.length < CAP) {
    out.push(cursorMs)
    cursorMs = nyAddMonthsFromFirst(cursorMs, stepMonths)
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
  // Render the tick label in **NY wall-clock** — every helios metric
  // is bucketed in America/New_York (see server-side
  // bucketSelectSql.ts + timeBuckets.ts), so the label must match.
  // Using getUTC* here previously caused hour-grain labels to read
  // 4–5 hours ahead of the underlying data and could shift day-grain
  // labels by one day for clients running outside NY.
  switch (agg) {
    case 'hour':
      return nyHourTick(ms)
    case 'date':
    case 'week':
      return nyMonthDayTick(ms, opts.straddlesYear)
    case 'month':
      return nyMonthYearTick(ms)
    case 'total':
    case 'dow':
    case 'dom':
    case 'dofortnight':
      // Categorical: caller shouldn't be rendering x ticks at all, but
      // return something sensible if they do.
      return nyMonthDayTick(ms, false)
  }
}
