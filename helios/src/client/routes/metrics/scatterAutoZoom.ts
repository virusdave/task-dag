/**
 * Outlier-resistant auto-zoom default view for scatter plots.
 *
 * Computes a "compact" axis-aligned visible domain that frames the
 * densest ~90% of the data on each axis independently, leaving the
 * "full" data extent reachable via wheel/pinch zoom-out or via a
 * "Show all data" chip. The algorithm is intentionally simple,
 * deterministic, and fast (two numeric sorts per axis, no density
 * estimation, no clustering).
 *
 * Design + rationale: see oracle review 2026-05-27 (auto-zoom
 * outlier resistance).
 *
 *   1. Drop points where either x or y is not finite.
 *   2. Per axis, sort the value array ascending.
 *   3. Nearest-rank trim: drop the bottom `floor(n * lowQ)` values
 *      and the top `floor(n * (1 - highQ))` values. Use defaults
 *      lowQ = 0.05, highQ = 0.95.
 *   4. If either tail would only remove `< minTrimPerTail` values
 *      (default 3) or n <= minPoints (default 10), do not trim
 *      that axis — return the full padded range. ("Don't bother
 *      hiding 1–2 dots.")
 *   5. Apply the existing 5% padding around the chosen range.
 *   6. Clamp the compact range inside the (already-padded) full
 *      domain so we never reset to a window outside the data.
 *   7. Count how many finite plotted points lie outside the
 *      compact rectangle so the UI can offer "Show all data (N)".
 *
 * The compact rectangle isn't guaranteed to hold exactly 90% of
 * the points — it holds points whose x AND y are both inside the
 * per-axis 90% bands. The union of "x outside" and "y outside"
 * tails can exceed 10%, which is fine and matches the user's
 * "compact most of the data" intent.
 */

import type { ZoomView } from './scatterZoom.js'

export interface ScatterAutoZoomPoint {
  readonly x: number
  readonly y: number
}

export interface ScatterAutoZoomOptions {
  /** Default 0.05. Bottom-quantile trim threshold. */
  readonly lowQuantile?: number
  /** Default 0.95. Top-quantile trim threshold. */
  readonly highQuantile?: number
  /** Default 0.05. Matches the existing scatter padding rule. */
  readonly paddingFraction?: number
  /** Default 10. Below this point count, compact === full. */
  readonly minPoints?: number
  /** Default 3. If a tail would remove fewer values than this, skip the trim. */
  readonly minTrimPerTail?: number
  /**
   * Optional pre-computed full padded domain (matching the
   * caller's existing rules). When omitted, this helper computes
   * the full padded domain itself from the same point set.
   */
  readonly fullDomain?: ZoomView | null
}

export interface ScatterAutoZoomResult {
  /** Compact "show the densest ~90%" reset view, or `null` if no points. */
  readonly compact: ZoomView | null
  /** Padded full-data extent (zoom-out / "Show all data" target). */
  readonly full: ZoomView | null
  /** How many finite points fall outside the compact rectangle. */
  readonly hiddenCount: number
  /** How many finite points there were in total. */
  readonly finiteCount: number
}

const DEFAULT_LOW_Q = 0.05
const DEFAULT_HIGH_Q = 0.95
const DEFAULT_PADDING = 0.05
const DEFAULT_MIN_POINTS = 10
const DEFAULT_MIN_TRIM_PER_TAIL = 3

export function computeCompactDomain<P extends ScatterAutoZoomPoint>(
  points: readonly P[],
  options: ScatterAutoZoomOptions = {},
): ScatterAutoZoomResult {
  const lowQ = options.lowQuantile ?? DEFAULT_LOW_Q
  const highQ = options.highQuantile ?? DEFAULT_HIGH_Q
  const padding = options.paddingFraction ?? DEFAULT_PADDING
  const minPoints = options.minPoints ?? DEFAULT_MIN_POINTS
  const minTrimPerTail = options.minTrimPerTail ?? DEFAULT_MIN_TRIM_PER_TAIL

  const xs: number[] = []
  const ys: number[] = []
  for (const p of points) {
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
      xs.push(p.x)
      ys.push(p.y)
    }
  }

  if (xs.length === 0) {
    return { compact: null, full: null, hiddenCount: 0, finiteCount: 0 }
  }

  const xExt = extent(xs)
  const yExt = extent(ys)
  const computedFull: ZoomView = {
    ...paddedAxisAsX(xExt.min, xExt.max, xExt.min, xExt.max, padding),
    ...paddedAxisAsY(yExt.min, yExt.max, yExt.min, yExt.max, padding),
  }
  const full = isValidDomain(options.fullDomain) ? options.fullDomain : computedFull

  const xCompact = compactAxis(xs, { lowQ, highQ, padding, minPoints, minTrimPerTail })
  const yCompact = compactAxis(ys, { lowQ, highQ, padding, minPoints, minTrimPerTail })
  let compact: ZoomView = {
    xMin: xCompact.min,
    xMax: xCompact.max,
    yMin: yCompact.min,
    yMax: yCompact.max,
  }
  compact = clampInside(compact, full)

  let hiddenCount = 0
  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i]!
    const y = ys[i]!
    if (x < compact.xMin || x > compact.xMax || y < compact.yMin || y > compact.yMax) {
      hiddenCount += 1
    }
  }

  return { compact, full, hiddenCount, finiteCount: xs.length }
}

function compactAxis(
  values: readonly number[],
  args: {
    readonly lowQ: number
    readonly highQ: number
    readonly padding: number
    readonly minPoints: number
    readonly minTrimPerTail: number
  },
): { min: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const fullMin = sorted[0]!
  const fullMax = sorted[n - 1]!
  if (n <= args.minPoints || fullMin === fullMax) {
    return paddedAxis(fullMin, fullMax, fullMin, fullMax, args.padding)
  }
  const lowTailCount = Math.floor(n * args.lowQ)
  const highTailCount = Math.floor(n * (1 - args.highQ))
  if (lowTailCount < args.minTrimPerTail || highTailCount < args.minTrimPerTail) {
    return paddedAxis(fullMin, fullMax, fullMin, fullMax, args.padding)
  }
  const loIdx = Math.min(n - 1, lowTailCount)
  const hiIdx = Math.max(0, n - 1 - highTailCount)
  const compactMin = sorted[loIdx]!
  const compactMax = sorted[hiIdx]!
  return paddedAxis(compactMin, compactMax, fullMin, fullMax, args.padding)
}

function extent(values: readonly number[]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  return { min, max }
}

function paddedAxis(
  min: number,
  max: number,
  fullMin: number,
  fullMax: number,
  paddingFraction: number,
): { min: number; max: number } {
  if (min < max) {
    const span = max - min
    const pad = span * paddingFraction
    return { min: min - pad, max: max + pad }
  }
  // Degenerate selected range (all-same axis or empty range).
  // Reuse the spirit of the existing ±1 fallback, but if the full
  // column has spread, use 5% of that full spread.
  const fullSpan = fullMax - fullMin
  const halfSpan =
    fullSpan > 0 ? fullSpan * paddingFraction : Math.max(Math.abs(min) * paddingFraction, 1)
  return { min: min - halfSpan, max: max + halfSpan }
}

function paddedAxisAsX(
  min: number,
  max: number,
  fullMin: number,
  fullMax: number,
  paddingFraction: number,
): { xMin: number; xMax: number } {
  const { min: m0, max: m1 } = paddedAxis(min, max, fullMin, fullMax, paddingFraction)
  return { xMin: m0, xMax: m1 }
}

function paddedAxisAsY(
  min: number,
  max: number,
  fullMin: number,
  fullMax: number,
  paddingFraction: number,
): { yMin: number; yMax: number } {
  const { min: m0, max: m1 } = paddedAxis(min, max, fullMin, fullMax, paddingFraction)
  return { yMin: m0, yMax: m1 }
}

function isValidDomain(domain: ZoomView | null | undefined): domain is ZoomView {
  return (
    !!domain &&
    Number.isFinite(domain.xMin) &&
    Number.isFinite(domain.xMax) &&
    Number.isFinite(domain.yMin) &&
    Number.isFinite(domain.yMax) &&
    domain.xMin < domain.xMax &&
    domain.yMin < domain.yMax
  )
}

function clampInside(view: ZoomView, full: ZoomView): ZoomView {
  const xMin = Math.max(view.xMin, full.xMin)
  const xMax = Math.min(view.xMax, full.xMax)
  const yMin = Math.max(view.yMin, full.yMin)
  const yMax = Math.min(view.yMax, full.yMax)
  if (xMin >= xMax || yMin >= yMax) return view
  return { xMin, xMax, yMin, yMax }
}
