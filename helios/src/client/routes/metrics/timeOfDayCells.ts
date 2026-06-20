// Pure derivation helpers for the Time-of-day weekday × hour grid.
// Kept framework-free so the math (cell value, labor break-even, color
// domain) is unit-tested without rendering.

import type { TimeOfDayCell } from '../../../shared/contracts/index.js'

export type TimeOfDayBasis =
  | 'grossSales'
  | 'netSales'
  | 'grossReceipts'
  | 'netReceipts'
  | 'margin'
export type TimeOfDayCellMetric =
  | 'avg_per_occurrence'
  | 'total'
  | 'orders_per_hour'
  | 'avg_basket'

export interface LaborConfig {
  readonly enabled: boolean
  /** Fully-loaded cost of ONE marginal staff-hour, in dollars. */
  readonly loadedCostPerStaffHour: number
  /** How many marginal staff the operator is weighing for this hour. */
  readonly headcount: number
}

// Business-day column order: open 8am → 2am (next day), then the closed
// 3am–7am band. The store is closed 3:00–7:59 ET (operator confirmed).
export const OPEN_HOURS: readonly number[] = [
  8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2,
]
export const CLOSED_HOURS: ReadonlySet<number> = new Set([3, 4, 5, 6, 7])

// Row order: business week Monday → Sunday (Postgres dow; 0 = Sunday).
export const WEEKDAY_ROWS: readonly number[] = [1, 2, 3, 4, 5, 6, 0]
export const WEEKDAY_LABELS: Readonly<Record<number, string>> = {
  0: 'Sun',
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
}

export function basisValue(cell: TimeOfDayCell, basis: TimeOfDayBasis): number {
  switch (basis) {
    case 'grossSales':
      return cell.grossSales
    case 'netSales':
      return cell.netSales
    case 'grossReceipts':
      return cell.grossReceipts
    case 'netReceipts':
      return cell.netReceipts
    case 'margin':
      return cell.margin
  }
}

/**
 * Value shown in a cell for the chosen basis + cell-metric.
 * `occurrences` is the number of that-weekday business-days in range
 * (the averaging denominator). Returns null when undefined (no
 * occurrences, or avg-basket with no orders) so the UI can blank it.
 */
export function cellValue(
  cell: TimeOfDayCell,
  occurrences: number,
  basis: TimeOfDayBasis,
  metric: TimeOfDayCellMetric,
): number | null {
  const v = basisValue(cell, basis)
  switch (metric) {
    case 'total':
      return v
    case 'avg_per_occurrence':
      return occurrences > 0 ? v / occurrences : null
    case 'orders_per_hour':
      return occurrences > 0 ? cell.orders / occurrences : null
    case 'avg_basket':
      return cell.orders > 0 ? v / cell.orders : null
  }
}

/**
 * Labor break-even surplus for a cell: average MARGIN $ per occurrence
 * minus the modeled marginal labor cost (loaded $/staff-hour ×
 * headcount). Deliberately uses margin (not the selected basis) — only
 * margin nets product cost, so it's the honest number to compare against
 * payroll. Returns null when there are no occurrences.
 */
export function laborSurplus(
  cell: TimeOfDayCell,
  occurrences: number,
  labor: LaborConfig,
): number | null {
  if (occurrences <= 0) return null
  const avgMargin = cell.margin / occurrences
  return avgMargin - labor.loadedCostPerStaffHour * labor.headcount
}

/** Whether a metric is money-denominated (for $ vs count formatting). */
export function metricIsMoney(metric: TimeOfDayCellMetric): boolean {
  return metric !== 'orders_per_hour'
}

/**
 * Robust upper bound (percentile) of a set of values, used to cap the
 * color scale so a single outlier hour doesn't wash out the grid.
 * `p` in [0,1]. Ignores non-finite values. Returns 0 for an empty set.
 */
export function percentile(values: readonly number[], p: number): number {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (xs.length === 0) return 0
  if (xs.length === 1) return xs[0]!
  const idx = Math.min(xs.length - 1, Math.max(0, Math.round(p * (xs.length - 1))))
  return xs[idx]!
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

function mix(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * clamp01(t))
}

/**
 * Sequential color (light → saturated blue) for an absolute value scaled
 * to [0, max]. Negative/zero → near-white. Returns a CSS rgb() string.
 */
export function sequentialColor(value: number, max: number): string {
  if (!Number.isFinite(value) || max <= 0 || value <= 0) return 'rgb(247, 250, 252)'
  const t = clamp01(value / max)
  // #f7fafc (near-white) → #1f5fa8 (deep blue)
  const r = mix(247, 31, t)
  const g = mix(250, 95, t)
  const b = mix(252, 168, t)
  return `rgb(${r}, ${g}, ${b})`
}

/**
 * Diverging color centered at zero for break-even surplus/deficit.
 * `magnitude` is the symmetric half-domain (e.g. p95 of |surplus|).
 * Red (deficit) → neutral → green (surplus). CSS rgb() string.
 */
export function divergingColor(value: number, magnitude: number): string {
  if (!Number.isFinite(value) || magnitude <= 0) return 'rgb(247, 250, 252)'
  const t = clamp01(Math.abs(value) / magnitude)
  if (value >= 0) {
    // neutral → green #1f9d55
    return `rgb(${mix(247, 31, t)}, ${mix(250, 157, t)}, ${mix(247, 85, t)})`
  }
  // neutral → red #cc3333
  return `rgb(${mix(247, 204, t)}, ${mix(250, 51, t)}, ${mix(247, 51, t)})`
}

/** Text color (dark/light) that stays legible on a given scale strength. */
export function cellTextColor(strength: number): string {
  return clamp01(strength) > 0.55 ? '#ffffff' : '#1a202c'
}
