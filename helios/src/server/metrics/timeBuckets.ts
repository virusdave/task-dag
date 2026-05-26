import type { MetricAggregation } from '../../shared/contracts/index.js'

/**
 * Pure helpers shared by the demo metrics (and likely by future
 * SQL-backed metrics that need to know how many buckets to default
 * to when the caller doesn't specify a window).
 */

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Pick a default `[from, to)` window for a metric that the caller
 * invoked without explicit `from` / `to`. Window length is chosen so
 * that the chart has "enough but not too many" buckets at the given
 * aggregation:
 *
 *   - hour:        last  7 days  (~168 buckets)
 *   - date:        last 90 days
 *   - week:        last 26 weeks
 *   - month:       last 24 months
 *   - dow, dom, dofortnight, total: last 90 days
 *
 * `to` defaults to "now", `from` is derived. If the caller supplied
 * one bound but not the other, we fill the missing bound from "now"
 * minus the default span (or vice versa).
 */
export function defaultWindow(
  from: Date | null,
  to: Date | null,
  agg: MetricAggregation,
): { from: Date; to: Date } {
  const now = new Date()
  const spanMs = defaultSpanMsForAggregation(agg)
  const resolvedTo = to ?? now
  const resolvedFrom = from ?? new Date(resolvedTo.getTime() - spanMs)
  return { from: resolvedFrom, to: resolvedTo }
}

function defaultSpanMsForAggregation(agg: MetricAggregation): number {
  switch (agg) {
    case 'hour':
      return 7 * DAY_MS
    case 'date':
    case 'dow':
    case 'dom':
    case 'dofortnight':
    case 'total':
      return 90 * DAY_MS
    case 'week':
      return 26 * 7 * DAY_MS
    case 'month':
      return 24 * 30 * DAY_MS
  }
}

/**
 * Enumerate the bucket-start timestamps in `[from, to)` at the given
 * aggregation. The first bucket is `from` rounded DOWN to the nearest
 * bucket boundary in UTC (we treat all helios bucketing as UTC so the
 * client can convert for display without changing membership).
 *
 * `total` returns a single bucket at `from`. The non-time-axis
 * aggregations (`dow`, `dom`, `dofortnight`) are out of scope for
 * the bucket walker — they slice the data on a categorical axis
 * which a SQL-backed metric does itself. We treat them like `total`
 * here for the demo use case (one bucket per window).
 */
export function walkBuckets(from: Date, to: Date, agg: MetricAggregation): Date[] {
  if (agg === 'total' || agg === 'dow' || agg === 'dom' || agg === 'dofortnight') {
    return [floorTo(from, 'date')]
  }
  const out: Date[] = []
  let cursor = floorTo(from, agg)
  // Bail-out cap so a misconfigured caller cannot DoS the server with
  // a 10-year `hour` walk (~87k buckets) — we still render the first
  // 20k buckets which is way more than any chart can usefully show.
  const HARD_CAP = 20_000
  while (cursor < to && out.length < HARD_CAP) {
    out.push(cursor)
    cursor = advance(cursor, agg)
  }
  return out
}

function floorTo(d: Date, agg: MetricAggregation): Date {
  // Work in UTC so the boundary is stable across server timezones.
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  const day = d.getUTCDate()
  const hour = d.getUTCHours()
  switch (agg) {
    case 'hour':
      return new Date(Date.UTC(y, m, day, hour))
    case 'date':
      return new Date(Date.UTC(y, m, day))
    case 'week': {
      // ISO week starts Monday. JS getUTCDay(): Sun=0..Sat=6.
      const dow = (d.getUTCDay() + 6) % 7
      return new Date(Date.UTC(y, m, day - dow))
    }
    case 'month':
      return new Date(Date.UTC(y, m, 1))
    case 'total':
    case 'dow':
    case 'dom':
    case 'dofortnight':
      return new Date(Date.UTC(y, m, day))
  }
}

function advance(d: Date, agg: MetricAggregation): Date {
  switch (agg) {
    case 'hour':
      return new Date(d.getTime() + 60 * 60 * 1000)
    case 'date':
      return new Date(d.getTime() + DAY_MS)
    case 'week':
      return new Date(d.getTime() + 7 * DAY_MS)
    case 'month':
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
    case 'total':
    case 'dow':
    case 'dom':
    case 'dofortnight':
      // Only one bucket; this is unreachable from walkBuckets, but
      // we return something non-equal to break the loop defensively.
      return new Date(d.getTime() + DAY_MS)
  }
}
