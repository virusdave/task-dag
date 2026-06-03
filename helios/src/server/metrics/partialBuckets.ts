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
 * `metric.supports.partialBuckets = true` on their MetricDef. The
 * wrapper performs the partial-bucket projection that's spec'd as:
 *
 *   "When the displayed window doesn't align with the bucket
 *    boundaries, the first/last datapoints are partial. Show a
 *    separate datapoint on each side, connected via a dashed curve
 *    to the main 'full window' buckets. If we have full data for the
 *    truncated window (historical edge), use the real value; if we
 *    don't (right edge crossing 'now'), extrapolate as Y / x where x
 *    is the fraction of the prior bucket already complete at the
 *    same fraction-through-bucket."
 *
 * Implementation notes:
 *
 *   1. We re-issue the metric's own query with a WIDENED window
 *      `[firstBucketStart, lastBucketEnd_or_now)` so we get the
 *      true full-bucket values for both edges in one round-trip
 *      whenever the natural bucket is observable.
 *
 *   2. For the right edge crossing `asOf` (typically `now`), the
 *      bucket is not yet observable in full, so we additionally
 *      issue two extra queries against the prior bucket — one
 *      through the same fraction-of-bucket as `asOf`, one through
 *      the whole prior bucket — and divide them to get x. We then
 *      project the current partial measurement Y to Y / x for every
 *      numeric series on the row.
 *
 *   3. Edge rows on the way out are tagged with `partial`,
 *      `partialKind`, and `partialCoverage` per the contract in
 *      `shared/contracts/api/metrics.ts`. Interior rows are untouched.
 *
 *   4. NY-local bucket arithmetic is preserved everywhere — the
 *      helpers in `timeBuckets.ts` already handle DST + the
 *      hour-vs-NY-day convention.
 *
 *   5. Only `hour` / `date` / `week` / `month` aggregations are
 *      eligible. Categorical (`total` / `dow` / `dom` /
 *      `dofortnight`) aggregations short-circuit straight through.
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
  // requested `to` and `asOf`. A request with `to` in the future (or
  // exactly at "now"+1ms) is still partial on the right whenever the
  // natural bucket extends beyond `asOf` — otherwise we'd silently
  // hand back a full-bucket value that hasn't been observed yet.
  const observedRightThrough = new Date(
    Math.min(to.getTime(), asOf.getTime()),
  )
  const leftPartial = from.getTime() > firstStart.getTime()
  const rightPartial = observedRightThrough.getTime() < lastEnd.getTime()

  // Aligned window — no edge handling needed; pass through.
  if (!leftPartial && !rightPartial) {
    return query({ ...args, from, to })
  }

  // Is the natural right-edge bucket fully observable yet? If the
  // bucket end has already passed, we can fetch real data for the
  // truncated portion; otherwise the bucket is still being filled
  // and we'll have to extrapolate.
  const rightFullAvailable = rightPartial
    ? lastEnd.getTime() <= asOf.getTime()
    : true

  // Widen the window so the SQL includes the full natural buckets at
  // both edges. For an unobservable right edge ("now" is mid-bucket)
  // we don't widen past `asOf` — there's nothing there yet and
  // some metric SQLs would fail on `to <= from`.
  const widenedFrom = firstStart
  const widenedTo =
    rightPartial && !rightFullAvailable ? observedRightThrough : lastEnd

  const rows = await query({
    ...args,
    from: widenedFrom,
    to: widenedTo,
  })

  // Reshape into a map keyed on bucket-start iso. Drop any rows the
  // query produced outside our expected bucket set defensively (it
  // would mean a bug in the query that we don't want silently
  // surfaced as a phantom point on the chart).
  const wanted = new Set(buckets.map((b) => b.toISOString()))
  const byT = new Map<string, MetricRowMut>()
  for (const r of rows) {
    if (wanted.has(r.t)) byT.set(r.t, { ...r })
  }
  // Ensure every bucket gets a row, even if SQL returned nothing
  // (e.g. dead site, no data). Empty rows are how the chart shows
  // "zero" for additive metrics.
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
      // The left edge is always historical (everything before the
      // operator's `from`); the natural bucket has long since closed
      // and the value we just fetched IS the real full-bucket total.
      row.partialKind = 'truncated'
      row.partialCoverage = coverage(firstStart, firstEnd, from, firstEnd)
    }
  }

  if (rightPartial) {
    const row = byT.get(lastStart.toISOString())
    if (row) {
      // If `partial` was already set to 'both' by the left-side pass
      // (single-bucket zoom window), keep it; otherwise mark 'right'.
      if (row.partial !== 'both') row.partial = 'right'
      row.partialCoverage = coverage(
        lastStart,
        lastEnd,
        lastStart,
        observedRightThrough,
      )

      if (rightFullAvailable) {
        // Historical right edge: real data, just a window-alignment
        // artefact.
        if (row.partialKind === undefined) row.partialKind = 'truncated'
      } else {
        // "Now" sits inside this bucket — project from the prior
        // bucket's pace at the same fraction-of-bucket.
        row.partialKind = 'extrapolated'
        await extrapolateRightEdgeInPlace({
          query,
          args,
          row,
          seriesIds,
          bucketStart: lastStart,
          bucketEnd: lastEnd,
          observedThrough: observedRightThrough,
        })
      }
    }
  }

  return buckets.map((b) => byT.get(b.toISOString())!) as MetricRow[]
}

// Internal mutable shape — we need to write `partial*` fields onto
// the row before returning it. The outward-facing `MetricRow` type
// is readonly, so we keep this alias narrow to this file.
type MetricRowMut = {
  -readonly [K in keyof MetricRow]: MetricRow[K]
}

interface ExtrapolateOpts {
  readonly query: MetricQueryFn
  readonly args: MetricQueryArgs
  readonly row: MetricRowMut
  readonly seriesIds: readonly string[]
  readonly bucketStart: Date
  readonly bucketEnd: Date
  readonly observedThrough: Date
}

/**
 * Right-edge extrapolation: for each numeric series on the current
 * partial bucket's row, project the full-bucket total as
 * `measured / x`, where `x = priorBucketAtSameFrac / priorBucketFull`.
 *
 * Falls back to uniform pro-rata (`measured / frac`) when the prior
 * bucket is missing, zero, or its pace denominator drops below
 * `MIN_PACE_DENOMINATOR` (e.g. very early in the bucket on a slow
 * day — we'd prefer a sensible over-estimate to a 50× explosion).
 */
async function extrapolateRightEdgeInPlace(opts: ExtrapolateOpts): Promise<void> {
  const {
    query,
    args,
    row,
    seriesIds,
    bucketStart,
    bucketEnd,
    observedThrough,
  } = opts

  const frac = coverage(bucketStart, bucketEnd, bucketStart, observedThrough)
  // If we've observed essentially none of the current bucket, leave
  // the measured value alone — extrapolation noise would be infinite.
  if (frac <= 0) return

  const priorStart = previousBucketStart(bucketStart, args.agg)
  const priorEnd = bucketStart
  const priorCut = new Date(
    priorStart.getTime() + frac * (priorEnd.getTime() - priorStart.getTime()),
  )

  // Two queries against the prior bucket: one through the same
  // fraction-of-bucket as `now`, one through the whole bucket. The
  // metric's own `query` already returns one row per bucket, keyed
  // on the bucket-start, so we just look up the prior bucket's iso.
  const [priorPartialRows, priorFullRows] = await Promise.all([
    query({ ...args, from: priorStart, to: priorCut }),
    query({ ...args, from: priorStart, to: priorEnd }),
  ])

  const priorIso = priorStart.toISOString()
  const priorPartial = priorPartialRows.find((r) => r.t === priorIso)
  const priorFull = priorFullRows.find((r) => r.t === priorIso)

  for (const sid of seriesIds) {
    const measured = row[sid]
    if (typeof measured !== 'number') continue

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
      // Fallback: uniform pro-rata. Still bounded by
      // MIN_PACE_DENOMINATOR so a tiny `frac` doesn't blow up.
      denominator = Math.max(frac, MIN_PACE_DENOMINATOR)
    }
    row[sid] = measured / denominator
  }
}
