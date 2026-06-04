// ---------------------------------------------------------------------------
// Y-axis baseline model for non-scatter line charts.
//
// Each line chart can pin its Y axis to include zero ('zero') or float
// it to the data range with a little padding ('data'). A chart can also
// defer to the page-wide default ('page'). The page-wide default is one
// of: force-zero, force-float, or 'per-chart' (no page-wide policy —
// charts left on 'page' fall back to the neutral default, which is
// float, matching the historical behaviour).
//
// This module is pure (no React / DOM) so the resolution + range math
// can be unit-tested directly.
// ---------------------------------------------------------------------------

/** Resolved baseline actually used to compute the Y range. */
export type YAxisBaseline = 'zero' | 'data'
/** Per-chart selection; 'page' defers to the page default. */
export type YAxisBaselineChoice = 'page' | YAxisBaseline
/** Page-wide default; 'per-chart' imposes no page-wide policy. */
export type YAxisBaselinePageDefault = YAxisBaseline | 'per-chart'

export const Y_AXIS_BASELINE_CHOICES: ReadonlyArray<YAxisBaselineChoice> = [
  'page',
  'zero',
  'data',
]
export const Y_AXIS_BASELINE_PAGE_DEFAULTS: ReadonlyArray<YAxisBaselinePageDefault> =
  ['zero', 'data', 'per-chart']

export const Y_AXIS_BASELINE_CHOICE_LABEL: Record<YAxisBaselineChoice, string> = {
  page: 'page default',
  zero: 'include zero',
  data: 'data range',
}
export const Y_AXIS_BASELINE_PAGE_DEFAULT_LABEL: Record<
  YAxisBaselinePageDefault,
  string
> = {
  zero: 'include zero',
  data: 'data range',
  'per-chart': 'per-chart',
}

/**
 * Resolve a chart's effective baseline from its own choice and the
 * page default. When the chart defers ('page') and the page imposes no
 * policy ('per-chart'), fall back to 'data' (float) — the historical
 * default so nothing changes visually until the operator opts in.
 */
export function resolveYAxisBaseline(
  choice: YAxisBaselineChoice,
  pageDefault: YAxisBaselinePageDefault,
): YAxisBaseline {
  if (choice === 'zero' || choice === 'data') return choice
  // choice === 'page'
  if (pageDefault === 'zero' || pageDefault === 'data') return pageDefault
  return 'data'
}

/**
 * Compute the padded [min, max] Y range for a line chart from the
 * observed data extent `[lo, hi]` and the resolved baseline.
 *
 *  - 'data' floats: 5% padding on both ends.
 *  - 'zero' extends the range to include the zero line, then pads —
 *    but keeps the zero edge flush (no padding past zero into empty
 *    space) so an all-positive series reads as a conventional 0..max
 *    axis.
 *
 * Non-finite inputs collapse to [0, 1]; a degenerate (lo === hi) range
 * expands by ±1 so the axis isn't zero-height.
 */
export function computeLineYRange(
  lo: number,
  hi: number,
  baseline: YAxisBaseline,
): { yMin: number; yMax: number } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { yMin: 0, yMax: 1 }
  }
  if (baseline === 'zero') {
    lo = Math.min(lo, 0)
    hi = Math.max(hi, 0)
  }
  if (lo === hi) {
    return { yMin: lo - 1, yMax: hi + 1 }
  }
  const span = hi - lo
  const padLo = baseline === 'zero' && lo === 0 ? 0 : span * 0.05
  const padHi = baseline === 'zero' && hi === 0 ? 0 : span * 0.05
  return { yMin: lo - padLo, yMax: hi + padHi }
}
