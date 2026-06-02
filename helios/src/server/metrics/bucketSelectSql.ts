// Shared SQL bucket-start expression for every helios metrics query
// that aggregates `sweed_orders.pay_time` (or analogous timestamptz
// columns) into chart buckets.
//
// Convention:
//   * Day / week / month grains bucket in America/New_York wall-clock
//     time, because every store is in NYC and operators reason about
//     "today" / "this week" in local calendar time. A sale at
//     22:30 ET on Wednesday must land in the Wednesday bucket, not
//     the Thursday bucket (which it would in UTC).
//   * Hour grain buckets at UTC top-of-hour. NY's UTC offset is always
//     whole-hours so UTC top-of-hour == NY top-of-hour on every day;
//     additionally bucketing 01:00 local during fall-back DST is
//     ambiguous (1:00 AM happens twice; date_trunc on NY-local would
//     collapse two real hours into one bucket). UTC-hour bucketing
//     preserves both real hours as distinct keys.
//
// Pattern (day grain shown):
//   (date_trunc('day', pay_time at time zone 'America/New_York'))
//     at time zone 'America/New_York' as bucket_start
//
// The inner `at time zone 'America/New_York'` converts the timestamptz
// to a `timestamp` whose components are NY wall-clock, then
// date_trunc rounds those components, then the outer
// `at time zone 'America/New_York'` casts back to `timestamptz` so
// node-postgres parses it as a real UTC instant (matching the JS-side
// bucket boundary produced by `walkBuckets`). Earlier (pre-2026-05)
// code skipped the outer cast and returned a naive `timestamp` that
// node-postgres mis-interpreted as server-local; see the long doc
// comment that used to live on `bucketSelectExpr` in
// sweedOrdersQueries.ts for the regression history.

const RETAIL_TZ = 'America/New_York'

/**
 * Build a `(date_trunc(...)) ...` SELECT-list expression for the
 * given Postgres truncation unit ('hour' | 'day' | 'week' | 'month').
 *
 * @param truncUnit  null for categorical aggregations (no time axis);
 *                   the function returns the sentinel `null::timestamptz`
 *                   so callers can spread it uniformly into their SQL.
 * @param payTimeExpr  the timestamptz column / expression to bucket
 *                     (default `pay_time`). Pass `'so.pay_time'` from
 *                     joins, etc. NEVER interpolate user input.
 */
export function bucketSelectExpr(
  truncUnit: string | null,
  payTimeExpr: string = 'pay_time',
): string {
  if (truncUnit === null) return 'null::timestamptz'
  if (truncUnit === 'hour') {
    return `(date_trunc('hour', ${payTimeExpr} at time zone 'UTC')) at time zone 'UTC'`
  }
  return `(date_trunc('${truncUnit}', ${payTimeExpr} at time zone '${RETAIL_TZ}')) at time zone '${RETAIL_TZ}'`
}

/**
 * Bare (no rewrap) NY-local bucket expression, suitable for use inside
 * `count(distinct ...)`-style aggregates where the result never crosses
 * the node-postgres timestamp parser. Cheaper than the round-tripped
 * variant when the caller only needs the value for in-SQL grouping.
 *
 * Returns a `timestamp without time zone` whose fields are NY wall-clock.
 */
export function bucketLocalExpr(
  truncUnit: string,
  payTimeExpr: string = 'pay_time',
): string {
  if (truncUnit === 'hour') {
    // For hourly, the local timestamp's fields are exactly NY top-of-
    // hour because of the whole-hour offset rule.
    return `date_trunc('hour', ${payTimeExpr} at time zone '${RETAIL_TZ}')`
  }
  return `date_trunc('${truncUnit}', ${payTimeExpr} at time zone '${RETAIL_TZ}')`
}

/** IANA name of the retail timezone every metric is bucketed in. */
export const RETAIL_TIMEZONE = RETAIL_TZ
