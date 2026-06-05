// Shared SQL bucket-start expression for every helios metrics query
// that aggregates `sweed_orders.pay_time` (or analogous timestamptz
// columns) into chart buckets.
//
// Convention:
//   * Day / week / month grains bucket by the NYC **business day**,
//     which rolls over at 08:00 ET (NOT calendar midnight) — see
//     shared/contracts/domain/businessDay.ts for the operator rule.
//     Every store is in NYC and operators reason about "today" /
//     "this week" as the business day; a sale at 22:30 ET on Wednesday
//     lands in the Wednesday business-day bucket, and a pre-open
//     prepaid pickup at 07:30 ET Thursday lands in the *Wednesday*
//     business-day bucket (it is before Thursday's 08:00 open).
//   * Hour grain buckets at UTC top-of-hour. NY's UTC offset is always
//     whole-hours so UTC top-of-hour == NY top-of-hour on every day;
//     additionally bucketing 01:00 local during fall-back DST is
//     ambiguous (1:00 AM happens twice; date_trunc on NY-local would
//     collapse two real hours into one bucket). UTC-hour bucketing
//     preserves both real hours as distinct keys.
//
// Pattern (day grain shown):
//   (date_trunc('day', (pay_time at time zone 'America/New_York')
//                        - interval '8 hours') + interval '8 hours')
//     at time zone 'America/New_York' as bucket_start
//
// The inner `at time zone 'America/New_York'` converts the timestamptz
// to a `timestamp` whose components are NY wall-clock; we subtract the
// 8h business-day shift, date_trunc rounds to the business-day start,
// add the shift back so the boundary sits at 08:00 ET, then the outer
// `at time zone 'America/New_York'` casts back to `timestamptz` so
// node-postgres parses it as a real UTC instant (08:00 ET on the
// business date — 12:00Z under EDT, 13:00Z under EST), matching the
// JS-side bucket boundary produced by `walkBuckets`. Earlier (pre-2026-05)
// code skipped the outer cast and returned a naive `timestamp` that
// node-postgres mis-interpreted as server-local; see the long doc
// comment that used to live on `bucketSelectExpr` in
// sweedOrdersQueries.ts for the regression history.

import { HELIOS_BUSINESS_DAY_START_HOUR, HELIOS_RETAIL_TZ } from '../../shared/contracts/index.js'

const RETAIL_TZ = HELIOS_RETAIL_TZ

/** SQL `interval` literal for the business-day rollover shift (08:00 ET). */
const SHIFT = `interval '${HELIOS_BUSINESS_DAY_START_HOUR} hours'`

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
  return (
    `(date_trunc('${truncUnit}', (${payTimeExpr} at time zone '${RETAIL_TZ}') - ${SHIFT})` +
    ` + ${SHIFT}) at time zone '${RETAIL_TZ}'`
  )
}

/**
 * Bare (no rewrap) business-day bucket expression, suitable for use
 * inside `count(distinct ...)`-style aggregates where the result never
 * crosses the node-postgres timestamp parser. Cheaper than the
 * round-tripped variant when the caller only needs the value as a
 * stable per-business-day grouping key.
 *
 * Returns a `timestamp without time zone` whose fields are the
 * NY-business-local truncated boundary (08:00-shifted). Distinctness
 * (the only property `count(distinct ...)` cares about) is preserved,
 * and "days with sales" correctly counts business days rather than
 * calendar days.
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
  return `date_trunc('${truncUnit}', (${payTimeExpr} at time zone '${RETAIL_TZ}') - ${SHIFT})`
}

/** IANA name of the retail timezone every metric is bucketed in. */
export const RETAIL_TIMEZONE = RETAIL_TZ
