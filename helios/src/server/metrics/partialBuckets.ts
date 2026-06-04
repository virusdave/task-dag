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
 * Spec (operator: 2026-06-04 — replaces the older "actual stays on
 * the solid curve" model):
 *
 *   The displayed window may straddle a natural-bucket boundary on
 *   the LEFT, the RIGHT, or both. We label the buckets:
 *
 *     T1' — the natural full bucket *before* the left displayed edge
 *           (NOT inside the window). Used only as the spline's
 *           tangent neighbour at T2'; never drawn.
 *     T2' — the FULL-COMPLETION of the left partial bucket. Drawn as
 *           the leftmost knot. The "actual" sub-window measurement
 *           of T2 is intentionally not surfaced — the operator only
 *           sees the full bucket value.
 *     T3..T(N-1) — fully-contained interior buckets, drawn unchanged.
 *     T(N)' — extrapolated (or full-completion, for the truncated
 *           case) value of the right partial bucket. Drawn as the
 *           rightmost spline knot at the bucket's END (= next bucket
 *           start, i.e. one bucket-width past the row's `t`). The
 *           final spline segment to this knot is DASHED.
 *     T(N) actual — the floating, disconnected dot for the right
 *           partial's measured value, plotted proportionally inside
 *           the in-progress bucket at `(asOf, measured)`. Optionally
 *           linked to T(N)' via a light dotted curve when the
 *           prior-bucket sub-aggregation curve is available.
 *
 *   Bullet summary on the wire (see
 *   `shared/contracts/api/metrics.ts` `MetricDatumSchema` for the
 *   exhaustive contract):
 *
 *     LEFT partial row:
 *       row[seriesId] = T2' (full-completion value)
 *       partialTangentPrev[seriesId] = T1' (prior full bucket)
 *       partialTangentPrevT          = previousBucketStart(firstStart)
 *       partialProjected / partialProjectedT — NOT emitted
 *       partialActualT — NOT emitted (left actual is suppressed)
 *
 *     RIGHT partial row:
 *       row[seriesId] = T(N) measured (the floating-actual value)
 *       partialActualT               = observedRightThrough
 *       partialProjected[seriesId]   = T(N)' (extrapolated or full)
 *       partialProjectedT            = lastEnd
 *       partialProjectionCurve       = optional sub-agg trajectory
 *
 *   The wrapper still issues at most:
 *     * 1 base-window query (always)
 *     * +1 query per partial edge for the full-bucket value
 *     * +1 query for the prior-bucket pace denominator on
 *       extrapolated right edges
 *     * +1 sub-aggregated query for the projection curve, ONLY when
 *       the metric declares a smaller agg in `supportedAggregations`.
 *
 *   Bucket arithmetic remains NY-local via the helpers in
 *   `timeBuckets.ts`. Categorical (`total` / `dow` / `dom` /
 *   `dofortnight`) aggregations short-circuit straight through.
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
 * The natural "smaller" aggregation we'll request to sample the
 * projection curve. NULL means we have no smaller grain we trust;
 * the projection curve falls back to "straight dotted line" in the
 * client.
 */
function subAggregationFor(agg: MetricAggregation): MetricAggregation | null {
  switch (agg) {
    case 'month':
    case 'week':
      return 'date'
    case 'date':
      return 'hour'
    case 'hour':
      // No smaller grain we support; client renders a straight
      // dotted segment instead.
      return null
    default:
      return null
  }
}

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
  /**
   * Aggregations the metric's `query` is willing to honour. Used by
   * the projection-curve sampler to decide whether it can request a
   * finer sub-aggregation of the prior bucket. Omitted (or empty)
   * disables the sub-agg sampling — the wire's
   * `partialProjectionCurve` will be undefined and the client falls
   * back to a straight dotted segment.
   */
  readonly supportedAggregations?: readonly MetricAggregation[]
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
  const supportedAggSet = new Set<MetricAggregation>(
    opts.supportedAggregations ?? [],
  )

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
  // the partial edges, which represent only the sub-windows
  // `[from, firstEnd)` and `[lastStart, observedRightThrough)`).
  // For the LEFT edge the row's main value gets OVERWRITTEN with
  // the full-completion value below; for the RIGHT edge it stays as
  // measured (and becomes the floating-actual dot).
  const baseRows = await query({ ...args, from, to: observedRightThrough })

  const byT = new Map<string, MetricRowMut>()
  for (const r of baseRows) byT.set(r.t, { ...r })
  for (const b of buckets) {
    const iso = b.toISOString()
    if (!byT.has(iso)) byT.set(iso, { t: iso })
  }

  // Degenerate single-bucket case: the same row is both left and
  // right partial. We keep the legacy behaviour here (measured
  // value on the row, projected on `partialProjected`) because the
  // new "left → T2', right → floating actual + T(N)' knot" split
  // can't simultaneously apply to one row, and the chart has no
  // smooth spline to render anyway.
  const both =
    leftPartial && rightPartial && firstStart.getTime() === lastStart.getTime()

  if (leftPartial && !both) {
    const row = byT.get(firstStart.toISOString())
    if (row) {
      row.partial = 'left'
      row.partialKind = 'truncated'
      row.partialCoverage = coverage(firstStart, firstEnd, from, firstEnd)
      // Full natural-bucket value: one extra query [firstStart, firstEnd).
      // This OVERWRITES the row's main series values — the operator
      // sees T2' (full completion), never the truncated sub-window
      // measurement, on the leftmost spline knot.
      const fullRows = await query({
        ...args,
        from: firstStart,
        to: firstEnd,
      })
      const fullRow = fullRows.find((r) => r.t === firstStart.toISOString())
      const fullValues = projectionFromRow(fullRow, seriesIds)
      for (const sid of seriesIds) {
        if (sid in fullValues) row[sid] = fullValues[sid]
      }
      // T1': the natural full bucket preceding T2. The client uses
      // this only as the spline's tangent neighbour at T2'; it is
      // never drawn.
      const t1Start = previousBucketStart(firstStart, args.agg)
      const t1End = firstStart
      const priorRows = await query({
        ...args,
        from: t1Start,
        to: t1End,
      })
      const priorRow = priorRows.find((r) => r.t === t1Start.toISOString())
      const priorValues = projectionFromRow(priorRow, seriesIds)
      // Always emit the slot even when the query returned no row
      // (treat absent prior data as zero, which is the correct
      // tangent neighbour for a metric that genuinely had no
      // activity then).
      if (Object.keys(priorValues).length === 0) {
        for (const sid of seriesIds) priorValues[sid] = 0
      } else {
        for (const sid of seriesIds) {
          if (!(sid in priorValues)) priorValues[sid] = 0
        }
      }
      row.partialTangentPrev = priorValues
      row.partialTangentPrevT = t1Start.toISOString()
    }
  }

  if (rightPartial && !both) {
    const row = byT.get(lastStart.toISOString())
    if (row) {
      row.partial = 'right'
      row.partialCoverage = coverage(
        lastStart,
        lastEnd,
        lastStart,
        observedRightThrough,
      )
      // The floating-actual dot is plotted at the moment of
      // observation, not at the bucket boundary.
      row.partialActualT = observedRightThrough.toISOString()
      const rightFullAvailable = lastEnd.getTime() <= asOf.getTime()
      if (rightFullAvailable) {
        row.partialKind = 'truncated'
        // Full natural-bucket value: one extra query [lastStart, lastEnd).
        const fullRows = await query({
          ...args,
          from: lastStart,
          to: lastEnd,
        })
        const fullRow = fullRows.find((r) => r.t === lastStart.toISOString())
        row.partialProjected = projectionFromRow(fullRow, seriesIds)
        // Trajectory curve: sub-aggregate the CURRENT bucket itself
        // (we have the actual data) so the dotted connector traces
        // the real intra-bucket curve from `partialActualT` out to
        // `partialProjectedT`.
        row.partialProjectionCurve = await curveFromCurrentBucket({
          query,
          args,
          seriesIds,
          bucketStart: lastStart,
          bucketEnd: lastEnd,
          startedAt: observedRightThrough,
          supportedAggSet,
        })
      } else {
        row.partialKind = 'extrapolated'
        const paceResult = await pacePartialProjection({
          query,
          args,
          row,
          seriesIds,
          bucketStart: lastStart,
          bucketEnd: lastEnd,
          observedThrough: observedRightThrough,
        })
        row.partialProjected = paceResult.projected
        // Trajectory curve from the prior bucket's intra-bucket
        // cumulative shape, scaled by `T(N)' / priorBucketFull`.
        row.partialProjectionCurve = await curveFromPriorBucketPace({
          query,
          args,
          row,
          seriesIds,
          bucketStart: lastStart,
          bucketEnd: lastEnd,
          startedAt: observedRightThrough,
          projected: paceResult.projected,
          priorFullValues: paceResult.priorFullValues,
          supportedAggSet,
        })
      }
      // Right projected endpoint sits at the natural bucket end
      // (= next bucket start). The renderer places the projected
      // dot there and draws the spline's final dashed segment from
      // the previous interior point out to this position.
      row.partialProjectedT = lastEnd.toISOString()
    }
  }

  if (both) {
    // Single bucket spanning both edges — legacy behaviour: the row
    // is `partial: 'both'`, its main values stay measured, and the
    // projected (full-bucket or pace-extrapolated) is attached as a
    // generic `partialProjected` at `partialProjectedT = lastEnd`.
    const row = byT.get(firstStart.toISOString())
    if (row) {
      row.partial = 'both'
      row.partialCoverage = coverage(
        firstStart,
        firstEnd,
        from,
        observedRightThrough,
      )
      const rightFullAvailable = firstEnd.getTime() <= asOf.getTime()
      if (rightFullAvailable) {
        row.partialKind = 'truncated'
        const fullRows = await query({
          ...args,
          from: firstStart,
          to: firstEnd,
        })
        const fullRow = fullRows.find((r) => r.t === firstStart.toISOString())
        row.partialProjected = projectionFromRow(fullRow, seriesIds)
      } else {
        row.partialKind = 'extrapolated'
        const paceResult = await pacePartialProjection({
          query,
          args,
          row,
          seriesIds,
          bucketStart: firstStart,
          bucketEnd: firstEnd,
          observedThrough: observedRightThrough,
        })
        row.partialProjected = paceResult.projected
      }
      row.partialProjectedT = firstEnd.toISOString()
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
  partialTangentPrev?: Record<string, number>
  partialTangentPrevT?: string
  partialActualT?: string
  partialProjectionCurve?: Array<Record<string, string | number | null>>
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

interface PaceProjectionResult {
  readonly projected: Record<string, number>
  /** Prior-bucket full values, by series id. Returned alongside the
   *  projection so the curve-sampler can reuse them as scaling
   *  denominators without re-querying. */
  readonly priorFullValues: Record<string, number>
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
): Promise<PaceProjectionResult> {
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
  const priorFullValuesOut: Record<string, number> = {}
  const frac = coverage(bucketStart, bucketEnd, bucketStart, observedThrough)
  if (frac <= 0) {
    // Essentially no observation yet — return measured as-is so the
    // dashed extension is degenerate, rather than a wild projection.
    for (const sid of seriesIds) {
      const v = row[sid]
      if (typeof v === 'number' && Number.isFinite(v)) out[sid] = v
    }
    return { projected: out, priorFullValues: priorFullValuesOut }
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
    if (typeof pf === 'number' && Number.isFinite(pf)) {
      priorFullValuesOut[sid] = pf
    }
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
  return { projected: out, priorFullValues: priorFullValuesOut }
}

interface CurveFromPriorBucketOpts {
  readonly query: MetricQueryFn
  readonly args: MetricQueryArgs
  readonly row: MetricRowMut
  readonly seriesIds: readonly string[]
  readonly bucketStart: Date
  readonly bucketEnd: Date
  readonly startedAt: Date
  readonly projected: Record<string, number>
  readonly priorFullValues: Record<string, number>
  readonly supportedAggSet: ReadonlySet<MetricAggregation>
}

/**
 * Sample the prior bucket at the metric's natural sub-aggregation
 * (e.g. `hour` when `args.agg === 'date'`), build the cumulative
 * progression, and project it onto the current partial bucket via
 * `predicted(f) = projected[sid] * priorCumulativeAt(f) / priorFull`.
 *
 * Emits one curve point per sub-bucket whose end-fraction `f` is
 * strictly greater than the current observed fraction — i.e. only
 * the FUTURE half of the in-progress bucket, connecting the
 * floating-actual dot at `startedAt` out to the projected endpoint
 * at `bucketEnd`.
 *
 * Returns `undefined` when sub-aggregation isn't supported or when
 * the prior-bucket data is absent / zero (the client falls back to a
 * straight dotted segment in either case).
 */
async function curveFromPriorBucketPace(
  opts: CurveFromPriorBucketOpts,
): Promise<Array<Record<string, string | number | null>> | undefined> {
  const subAgg = subAggregationFor(opts.args.agg)
  if (subAgg === null || !opts.supportedAggSet.has(subAgg)) return undefined
  const {
    query,
    args,
    seriesIds,
    bucketStart,
    bucketEnd,
    startedAt,
    projected,
    priorFullValues,
  } = opts
  const priorStart = previousBucketStart(bucketStart, args.agg)
  const priorEnd = bucketStart
  const subRows = await query({
    ...args,
    from: priorStart,
    to: priorEnd,
    agg: subAgg,
  })
  if (subRows.length === 0) return undefined
  // Order sub-rows by t (the metric's query usually returns them
  // sorted, but don't trust it).
  const sortedSubRows = [...subRows].sort(
    (a, b) => Date.parse(a.t) - Date.parse(b.t),
  )
  const bucketSpan = bucketEnd.getTime() - bucketStart.getTime()
  const priorSpan = priorEnd.getTime() - priorStart.getTime()
  const currentFrac = coverage(bucketStart, bucketEnd, bucketStart, startedAt)
  const out: Array<Record<string, string | number | null>> = []
  // Per-series running cumulative (cumulative inside the prior
  // bucket, by sub-bucket end).
  const cum: Record<string, number> = {}
  for (const sid of seriesIds) cum[sid] = 0
  for (const sr of sortedSubRows) {
    const subStart = Date.parse(sr.t)
    if (!Number.isFinite(subStart)) continue
    // Add this sub-bucket's contribution.
    for (const sid of seriesIds) {
      const v = sr[sid]
      if (typeof v === 'number' && Number.isFinite(v)) cum[sid]! += v
    }
    // Sub-bucket end relative to the prior bucket. Use a coarse
    // "end = subStart + (priorSpan / nBuckets)" approximation; the
    // exact step depends on whether `date` rolls over month
    // boundaries inside a sub-aggregated `week`/`month` query, but
    // for the curve-sample purpose this is plenty precise.
    const subFrac = Math.min(
      1,
      Math.max(0, (subStart - priorStart.getTime() + 1) / priorSpan),
    )
    if (subFrac <= currentFrac) continue
    // Project to current bucket's x position: t = bucketStart + subFrac * bucketSpan.
    const tMs = bucketStart.getTime() + subFrac * bucketSpan
    if (tMs <= startedAt.getTime() || tMs >= bucketEnd.getTime()) continue
    const point: Record<string, string | number | null> = {
      t: new Date(tMs).toISOString(),
    }
    let anyValue = false
    for (const sid of seriesIds) {
      const pf = priorFullValues[sid]
      const proj = projected[sid]
      if (
        typeof pf !== 'number' ||
        !Number.isFinite(pf) ||
        pf <= 0 ||
        typeof proj !== 'number' ||
        !Number.isFinite(proj)
      ) {
        continue
      }
      const v = proj * (cum[sid]! / pf)
      if (Number.isFinite(v)) {
        point[sid] = v
        anyValue = true
      }
    }
    if (anyValue) out.push(point)
  }
  return out.length > 0 ? out : undefined
}

interface CurveFromCurrentBucketOpts {
  readonly query: MetricQueryFn
  readonly args: MetricQueryArgs
  readonly seriesIds: readonly string[]
  readonly bucketStart: Date
  readonly bucketEnd: Date
  readonly startedAt: Date
  readonly supportedAggSet: ReadonlySet<MetricAggregation>
}

/**
 * Trajectory for the TRUNCATED right edge — we have all the bucket's
 * real data, so we sub-aggregate the bucket itself and emit
 * cumulative points beyond the displayed window's right edge. The
 * dotted curve traces the genuine intra-bucket shape from the
 * floating actual at `startedAt` out to the projected (= full
 * bucket) endpoint at `bucketEnd`.
 */
async function curveFromCurrentBucket(
  opts: CurveFromCurrentBucketOpts,
): Promise<Array<Record<string, string | number | null>> | undefined> {
  const subAgg = subAggregationFor(opts.args.agg)
  if (subAgg === null || !opts.supportedAggSet.has(subAgg)) return undefined
  const { query, args, seriesIds, bucketStart, bucketEnd, startedAt } = opts
  const subRows = await query({
    ...args,
    from: bucketStart,
    to: bucketEnd,
    agg: subAgg,
  })
  if (subRows.length === 0) return undefined
  const sorted = [...subRows].sort(
    (a, b) => Date.parse(a.t) - Date.parse(b.t),
  )
  const cum: Record<string, number> = {}
  for (const sid of seriesIds) cum[sid] = 0
  const out: Array<Record<string, string | number | null>> = []
  for (const sr of sorted) {
    const subStart = Date.parse(sr.t)
    if (!Number.isFinite(subStart)) continue
    for (const sid of seriesIds) {
      const v = sr[sid]
      if (typeof v === 'number' && Number.isFinite(v)) cum[sid]! += v
    }
    if (subStart <= startedAt.getTime()) continue
    if (subStart >= bucketEnd.getTime()) continue
    const point: Record<string, string | number | null> = {
      t: new Date(subStart).toISOString(),
    }
    let anyValue = false
    for (const sid of seriesIds) {
      if (Number.isFinite(cum[sid])) {
        point[sid] = cum[sid]!
        anyValue = true
      }
    }
    if (anyValue) out.push(point)
  }
  return out.length > 0 ? out : undefined
}
