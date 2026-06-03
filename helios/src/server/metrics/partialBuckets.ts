import type { MetricAggregation } from '../../shared/contracts/index.js'
import {
  advanceBucketStart,
  defaultWindow,
  previousBucketStart,
  walkBuckets,
} from './timeBuckets.js'
import type { MetricQueryArgs, MetricQueryFn, MetricRow } from './types.js'

/**
 * Shared wrapper for "additive over time" metrics opted in via
 * `metric.supports.partialBuckets = true` on their MetricDef.
 *
 * Spec (operator: 2026-06-03):
 *
 *   "When the displayed window doesn't align with the bucket
 *    boundaries, the first/last datapoints are partial. Show a
 *    separate datapoint on each side, connected via a dashed curve
 *    to the main 'full window contents' buckets. The ACTUAL partial
 *    data point stays on the solid curve. If we have full data for
 *    the truncated window (historical edge), use the real value; if
 *    we don't (right edge crossing 'now'), extrapolate linearly via
 *    the prior bucket's pace: x = priorAtSameFracThrough /
 *    priorFull, projected = measured / x."
 *
 * Implementation:
 *
 *   1. Run the metric's own query exactly as the caller asked
 *      (`[from, to)`). This gives us the **actual measured** value
 *      for every bucket including the partial edges — those values
 *      stay on the row's regular series fields so the solid line
 *      stays anchored to real data.
 *
 *   2. For each partial edge, additionally compute the projected
 *      full-natural-bucket value and attach it as
 *      `row.partialProjected[seriesId]`:
 *
 *        * Left truncated edge → run a one-bucket query for
 *          `[firstStart, firstEnd)` and use the SQL aggregate.
 *
 *        * Right truncated edge (historical, fully observable) →
 *          run a one-bucket query for `[lastStart, lastEnd)`.
 *
 *        * Right extrapolated edge (current "now" inside the
 *          bucket) → fetch the prior bucket's value at the same
 *          fraction-through-bucket as `asOf`, fetch the prior
 *          bucket's full value, divide to get `x`, then project
 *          `measured / x`. Falls back to uniform pro-rata when
 *          prior-bucket pace is unavailable/pathological.
 *
 *   3. Edge rows are tagged with `partial`, `partialKind`,
 *      `partialCoverage` per the contract in
 *      `shared/contracts/api/metrics.ts`. Interior rows are untouched.
 *
 *   4. NY-local bucket arithmetic preserved by the helpers in
 *      `timeBuckets.ts`.
 *
 *   5. Only `hour` / `date` / `week` / `month` aggregations are
 *      eligible. Categorical (`total` / `dow` / `dom` /
 *      `dofortnight`) short-circuit straight through.
 */

const TIME_AGGS = new Set<MetricAggregation>(['hour', 'date', 'week', 'month'])

/**
 * Minimum prior-bucket coverage we'll trust as a pace denominator
 * before falling back to uniform pro-rata. A 1%-complete prior
 * bucket would produce 100× extrapolation noise — we don't want
 * that to drive the chart.
 */
const MIN_PACE_DENOMINATOR = 0.02

/**
 * Coverage fraction of a natural bucket `[bucketStart, bucketEnd)`
 * by an arbitrary interval `[a, b)`. Clamped to `[0, 1]`. Used both
 * for "how much of the left bucket is inside `[from, …)`" and "how
 * much of the right bucket is inside `[…, observedThrough)`".
 */
function coverage(bucketStart: Date, bucketEnd: Date, a: Date, b: Date): number {
  const denom = bucketEnd.getTime() - bucketStart.getTime()
  if (denom <= 0) return 1
  const overlap = Math.max(
    0,
    Math.min(bucketEnd.getTime(), b.getTime()) -
      Math.max(bucketStart.getTime(), a.getTime()),
  )
  return Math.max(0, Math.min(1, overlap / denom))
}

export interface PartialBucketWrapperOpts {
  readonly query: MetricQueryFn
  readonly args: MetricQueryArgs
  readonly seriesIds: readonly string[]
  /**
   * Override for "now" — defaults to `new Date()` at call time.
   * Test fixtures pass an explicit value so the right-edge
   * extrapolation is deterministic.
   */
  readonly asOf?: Date
}

/**
 * Public entry point. The metrics route calls this only when
 * `metric.supports.partialBuckets === true`; everyone else continues
 * to call `metric.query` directly so behaviour is bit-for-bit
 * unchanged for non-opted-in metrics.
 */
export async function queryWithPartialBuckets(
  opts: PartialBucketWrapperOpts,
): Promise<MetricRow[]> {
  const { query, args, seriesIds } = opts
  const asOf = opts.asOf ?? new Date()

  // Categorical / non-time aggregations have no notion of "edge
  // bucket"; pass through.
  if (!TIME_AGGS.has(args.agg)) return query(args)

  const { from, to } = defaultWindow(args.from, args.to, args.agg)
  const buckets = walkBuckets(from, to, args.agg)
  if (buckets.length === 0) return query({ ...args, from, to })

  const firstStart = buckets[0]!
  const firstEnd = advanceBucketStart(firstStart, args.agg)
  const lastStart = buckets[buckets.length - 1]!
  const lastEnd = advanceBucketStart(lastStart, args.agg)

  // The "effective right edge" of observation is the earlier of the
  // requested `to` and `asOf`. A request with `to` in the future is
  // still partial on the right whenever the natural bucket extends
  // beyond `asOf` — otherwise we'd silently hand back a full-bucket
  // value that hasn't been observed yet.
  const observedRightThrough = new Date(
    Math.min(to.getTime(), asOf.getTime()),
  )
  const leftPartial = from.getTime() > firstStart.getTime()
  const rightPartial = observedRightThrough.getTime() < lastEnd.getTime()

  // Aligned window — no edge handling needed; pass through with no
  // extra round-trips.
  if (!leftPartial && !rightPartial) {
    return query({ ...args, from, to })
  }

  // Base query: actual measured values for every bucket (including
  // the partial edges, which represent only the [from, firstEnd) /
  // [lastStart, observedRightThrough) sub-windows). These stay on
  // the row's regular series fields so the solid time-series line
  // remains anchored to real measurements.
  const baseRows = await query({ ...args, from, to: observedRightThrough })

  const byT = new Map<string, MetricRowMut>()
  for (const r of baseRows) byT.set(r.t, { ...r })
  for (const b of buckets) {
    const iso = b.toISOString()
    if (!byT.has(iso)) byT.set(iso, { t: iso })
  }

  if (leftPartial) {
    const row = byT.get(firstStart.toISOString())
    if (row) {
      row.partial =
        rightPartial && firstStart.getTime() === lastStart.getTime()
          ? 'both'
          : 'left'
      row.partialKind = 'truncated'
      row.partialCoverage = coverage(firstStart, firstEnd, from, firstEnd)
      // Full natural-bucket value: one extra query [firstStart, firstEnd).
      const fullRows = await query({
        ...args,
        from: firstStart,
        to: firstEnd,
      })
      const fullRow = fullRows.find((r) => r.t === firstStart.toISOString())
      row.partialProjected = projectionFromRow(fullRow, seriesIds)
      // Left projected sits at the natural bucket start (= row.t),
      // so the renderer treats the dashed extension as degenerate
      // and just outlines the partial-actual marker.
      row.partialProjectedT = firstStart.toISOString()
    }
  }

  if (rightPartial) {
    const row = byT.get(lastStart.toISOString())
    if (row) {
      // 'both' set by left-side branch above wins; otherwise mark right.
      if (row.partial !== 'both') row.partial = 'right'
      row.partialCoverage = coverage(
        lastStart,
        lastEnd,
        lastStart,
        observedRightThrough,
      )
      const rightFullAvailable = lastEnd.getTime() <= asOf.getTime()
      if (rightFullAvailable) {
        if (row.partialKind === undefined) row.partialKind = 'truncated'
        // Full natural-bucket value: one extra query [lastStart, lastEnd).
        const fullRows = await query({
          ...args,
          from: lastStart,
          to: lastEnd,
        })
        const fullRow = fullRows.find((r) => r.t === lastStart.toISOString())
        row.partialProjected = projectionFromRow(fullRow, seriesIds)
      } else {
        row.partialKind = 'extrapolated'
        // Pace projection from the prior bucket. See helper below.
        row.partialProjected = await pacePartialProjection({
          query,
          args,
          row,
          seriesIds,
          bucketStart: lastStart,
          bucketEnd: lastEnd,
          observedThrough: observedRightThrough,
        })
      }
      // Right projected endpoint sits at the natural bucket end
      // (= next bucket start). The renderer places the projected
      // dot there and draws the dashed extension from the actual
      // point at `lastStart` out to this position.
      row.partialProjectedT = lastEnd.toISOString()
    }
  }

  return buckets.map((b) => byT.get(b.toISOString())!) as MetricRow[]
}

// Internal mutable shape — we need to write `partial*` fields onto
// the row before returning it. The outward-facing `MetricRow` type
// is readonly, so we keep this alias narrow to this file.
type MetricRowMut = {
  -readonly [K in keyof MetricRow]: MetricRow[K]
} & {
  partialProjected?: Record<string, number>
  partialProjectedT?: string
}

/** Build a `Record<seriesId, number>` projection map from a one-bucket
 *  query row. Skips series whose value isn't a finite number. */
function projectionFromRow(
  row: MetricRow | undefined,
  seriesIds: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = {}
  if (!row) return out
  for (const sid of seriesIds) {
    const v = row[sid]
    if (typeof v === 'number' && Number.isFinite(v)) out[sid] = v
  }
  return out
}

interface PaceProjectionOpts {
  readonly query: MetricQueryFn
  readonly args: MetricQueryArgs
  readonly row: MetricRowMut
  readonly seriesIds: readonly string[]
  readonly bucketStart: Date
  readonly bucketEnd: Date
  readonly observedThrough: Date
}

/**
 * Right-edge prior-bucket-pace projection. For each numeric series on
 * the current partial bucket, compute the projected full-bucket value
 * as `measured / x`, where
 *
 *   x = priorBucketCumulativeAtSameFracThrough / priorBucketFull
 *
 * Falls back to uniform pro-rata (`measured / frac`) when the prior
 * bucket is missing, zero, or its pace denominator is below
 * `MIN_PACE_DENOMINATOR` (e.g. very early in the bucket on a slow
 * day — we'd rather a sensible over-estimate than a 50× explosion).
 */
async function pacePartialProjection(
  opts: PaceProjectionOpts,
): Promise<Record<string, number>> {
  const {
    query,
    args,
    row,
    seriesIds,
    bucketStart,
    bucketEnd,
    observedThrough,
  } = opts
  const out: Record<string, number> = {}
  const frac = coverage(bucketStart, bucketEnd, bucketStart, observedThrough)
  if (frac <= 0) {
    // Essentially no observation yet — return measured as-is so the
    // dashed extension is degenerate, rather than a wild projection.
    for (const sid of seriesIds) {
      const v = row[sid]
      if (typeof v === 'number' && Number.isFinite(v)) out[sid] = v
    }
    return out
  }
  const priorStart = previousBucketStart(bucketStart, args.agg)
  const priorEnd = bucketStart
  const priorCut = new Date(
    priorStart.getTime() + frac * (priorEnd.getTime() - priorStart.getTime()),
  )
  const [priorPartialRows, priorFullRows] = await Promise.all([
    query({ ...args, from: priorStart, to: priorCut }),
    query({ ...args, from: priorStart, to: priorEnd }),
  ])
  const priorIso = priorStart.toISOString()
  const priorPartial = priorPartialRows.find((r) => r.t === priorIso)
  const priorFull = priorFullRows.find((r) => r.t === priorIso)
  for (const sid of seriesIds) {
    const measured = row[sid]
    if (typeof measured !== 'number' || !Number.isFinite(measured)) continue
    let denominator: number | null = null
    const pp = priorPartial?.[sid]
    const pf = priorFull?.[sid]
    if (
      typeof pp === 'number' &&
      typeof pf === 'number' &&
      pf > 0 &&
      pp > 0
    ) {
      denominator = pp / pf
    }
    if (
      denominator === null ||
      !Number.isFinite(denominator) ||
      denominator < MIN_PACE_DENOMINATOR
    ) {
      denominator = Math.max(frac, MIN_PACE_DENOMINATOR)
    }
    out[sid] = measured / denominator
  }
  return out
}
