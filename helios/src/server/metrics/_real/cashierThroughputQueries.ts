import type { MetricAggregation } from '../../../shared/contracts/index.js'
import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type HeliosPendingPurchaseSiteDealer,
} from '../../../shared/contracts/index.js'
import { bucketSelectExpr } from '../bucketSelectSql.js'
import { getPool } from '../../db/pool.js'
import { defaultWindow, walkBuckets } from '../timeBuckets.js'
import type { MetricQueryArgs, MetricRow } from '../types.js'

// ============================================================================
// Real-data query for the `cashier.transactions_per_hour` metric
// (FreshlyBakedNYC/automation#27 follow-on; backs the P5 stub from
// virusdave/top-level#7).
//
// Definition:
//
//   transactions_per_hour[bucket]
//     = count(sweed_orders rows whose pay_time falls in bucket)
//       /
//       (cashier-hours in bucket)
//
//   cashier-hours[bucket]
//     = sum over CLOSED drawer-shifts ds whose interval
//        [open_date, close_date] intersects bucket of:
//          ((min(close_date, bucket_end) - max(open_date, bucket_start))
//             in seconds / 3600)
//          * count(sweed_drawer_shift_sessions for ds)
//
// Per the operator's 2026-05-26 Option-A guidance, every cashier
// listed in a drawer-shift's `sessions[]` is treated as on-the-clock
// for the entire drawer window. This over-estimates cashier-hours
// slightly for mid-shift handoffs but is the right approximation for
// the "transactions per on-the-clock cashier-hour as the business
// scales" question this metric exists to answer. A future v2 can use
// `sweed_orders.cashier_user_id` for exact per-transaction
// attribution.
//
// Open drawer-shifts (close_date IS NULL) are EXCLUDED. Their final
// duration is unknown, and including them would jitter live buckets
// as they close. The drawer-shifts ingest worker re-upserts open
// shifts on each poll, so the row "appears" in the metric only once
// it has closed and a final duration is known.
// ============================================================================

const POSTGRES_TRUNC_UNIT_BY_AGG: Record<
  Exclude<MetricAggregation, 'dow' | 'dom' | 'dofortnight' | 'total'>,
  string
> = {
  hour: 'hour',
  date: 'day',
  week: 'week',
  month: 'month',
}

const POSTGRES_INTERVAL_BY_AGG: Record<
  Exclude<MetricAggregation, 'dow' | 'dom' | 'dofortnight' | 'total'>,
  string
> = {
  hour: '1 hour',
  date: '1 day',
  week: '1 week',
  month: '1 month',
}

function resolveDealerIds(sites: readonly string[]): number[] {
  if (sites.length === 0) {
    return HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((d) => d.dealerId)
  }
  const wanted = new Set(sites.map((s) => s.toLowerCase()))
  const matched: HeliosPendingPurchaseSiteDealer[] = HELIOS_PENDING_PURCHASE_SITE_DEALERS.filter(
    (d) => wanted.has(d.siteKey.toLowerCase()),
  )
  return matched.map((d) => d.dealerId)
}

interface ResolvedWindow {
  from: Date
  to: Date
  truncUnit: string | null
  intervalLiteral: string | null
  buckets: Date[]
}

function resolveWindow(args: MetricQueryArgs): ResolvedWindow {
  const w = defaultWindow(args.from, args.to, args.agg)
  const buckets = walkBuckets(w.from, w.to, args.agg)
  const isCategorical =
    args.agg === 'dow' || args.agg === 'dom' || args.agg === 'dofortnight' || args.agg === 'total'
  return {
    from: w.from,
    to: w.to,
    truncUnit: isCategorical ? null : POSTGRES_TRUNC_UNIT_BY_AGG[args.agg],
    intervalLiteral: isCategorical ? null : POSTGRES_INTERVAL_BY_AGG[args.agg],
    buckets,
  }
}

const SERIES_ID = 'tx_per_hour'

/**
 * `cashier.transactions_per_hour` real query — see file header.
 *
 * Supports the same aggregations as the rest of the /metrics page
 * (hour / date / week / month, plus the categorical buckets via the
 * `total`-style single-bucket collapse). DoW / DoM / DoFortnight
 * are NOT supported here in v1 because apportioning across a
 * non-contiguous categorical bucket complicates the SQL without
 * adding insight at this stage; they fall back to the metric's
 * defaultAggregation if requested.
 */
export async function queryCashierTransactionsPerHour(args: MetricQueryArgs): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { from, to, truncUnit, intervalLiteral, buckets } = resolveWindow(args)
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => ({ t: b.toISOString(), [SERIES_ID]: null }))
  }
  const pool = getPool()

  if (truncUnit === null || intervalLiteral === null) {
    // Categorical bucket — collapse the whole window into one value.
    const sql = `
      with drawer_intervals as (
        select ds.dealer_id,
               ds.open_date,
               ds.close_date,
               (select count(*) from sweed_drawer_shift_sessions s
                 where s.dealer_id = ds.dealer_id
                   and s.sweed_shift_id = ds.sweed_shift_id)::int as n_sessions
          from sweed_drawer_shifts ds
         where ds.dealer_id = any($1::bigint[])
           and ds.close_date is not null
           and ds.close_date > $2::timestamptz
           and ds.open_date  < $3::timestamptz
      ),
      hours as (
        select coalesce(sum(
          extract(epoch from (
            least(close_date, $3::timestamptz) - greatest(open_date, $2::timestamptz)
          )) / 3600.0 * n_sessions
        ), 0)::float as cashier_hours
          from drawer_intervals
      ),
      tx as (
        select count(*)::float as tx
          from sweed_orders so
         where so.dealer_id = any($1::bigint[])
           and so.pay_time >= $2::timestamptz
           and so.pay_time <  $3::timestamptz
      )
      select case when h.cashier_hours > 0
                  then (t.tx / h.cashier_hours)
                  else null
             end as value
        from tx t cross join hours h
    `
    const result = await pool.query<{ value: string | null }>(sql, [
      dealerIds,
      from.toISOString(),
      to.toISOString(),
    ])
    const raw = result.rows[0]?.value ?? null
    const num = raw === null ? null : Number(raw)
    const value = num === null || !Number.isFinite(num) ? null : num
    return buckets.map((b, i) => ({
      t: b.toISOString(),
      [SERIES_ID]: i === 0 ? value : null,
    }))
  }

  // Bucketed: apportion each drawer-shift's (duration × n_sessions)
  // across every bucket it touches. The lateral generate_series
  // enumerates one bucket-start per bucket the shift overlaps; the
  // per-bucket "slice" cashier-hours is then
  //   (min(close_date, slice_end) - max(open_date, slice_start)) seconds
  //   / 3600 * n_sessions.
  //
  // We trunc the start-of-iteration to the bucket boundary so a
  // shift that opens at 13:42 contributes its 13:00–14:00 partial
  // hour to the 13:00 bucket rather than starting the iteration at
  // 13:42 and creating a stray 13:42-bucket key.
  //
  // TZ-correctness: day / week / month buckets MUST step in America/
  // New_York calendar time. We generate a `timestamp without time zone`
  // series whose components are NY-local, then convert each boundary
  // back to `timestamptz` with `at time zone 'America/New_York'`.
  // This makes a fall-back day correctly contribute 25 elapsed UTC
  // hours and a spring-forward day 23. For hour grain we use UTC
  // stepping (NY UTC offset is always whole-hours so UTC top-of-hour
  // == NY top-of-hour, and UTC stepping avoids the fall-back-Sunday
  // ambiguity where 01:00 NY happens twice). See
  // helios/src/server/metrics/bucketSelectSql.ts for the convention.
  const isHourGrain = truncUnit === 'hour'
  const sliceStartTz = isHourGrain
    ? 'slice_start'
    : "(slice_start at time zone 'America/New_York')"
  const sliceEndTz = isHourGrain
    ? `(slice_start + interval '${intervalLiteral}')`
    : `((slice_start + interval '${intervalLiteral}') at time zone 'America/New_York')`
  // generate_series start expression:
  //   - hour grain: trunc(...) on the UTC instant, step in interval.
  //   - calendar grain: trunc(...) on the NY-local timestamp (the
  //     `at time zone 'America/New_York'` cast yields a `timestamp`
  //     without time zone whose fields are NY wall-clock), step the
  //     NY-local series, convert each boundary back to timestamptz
  //     when comparing against open/close dates above.
  const seriesStart = isHourGrain
    ? `date_trunc('hour', greatest(di.open_date, $2::timestamptz))`
    : `date_trunc('${truncUnit}', greatest(di.open_date, $2::timestamptz) at time zone 'America/New_York')`
  const seriesStop = isHourGrain
    ? `least(di.close_date, $3::timestamptz)`
    : `(least(di.close_date, $3::timestamptz) at time zone 'America/New_York')`
  const bucketStartExpr = isHourGrain
    ? "slice_start"
    : "(slice_start at time zone 'America/New_York')"
  const sql = `
    with drawer_intervals as (
      select ds.dealer_id,
             ds.open_date,
             ds.close_date,
             (select count(*) from sweed_drawer_shift_sessions s
               where s.dealer_id = ds.dealer_id
                 and s.sweed_shift_id = ds.sweed_shift_id)::int as n_sessions
        from sweed_drawer_shifts ds
       where ds.dealer_id = any($1::bigint[])
         and ds.close_date is not null
         and ds.close_date > $2::timestamptz
         and ds.open_date  < $3::timestamptz
    ),
    shift_buckets as (
      select ${bucketStartExpr} as bucket_start,
             extract(epoch from (
               least(di.close_date, ${sliceEndTz}) -
               greatest(di.open_date, ${sliceStartTz})
             )) / 3600.0 * di.n_sessions as cashier_hours
        from drawer_intervals di
        cross join lateral generate_series(
          ${seriesStart},
          ${seriesStop},
          interval '${intervalLiteral}'
        ) as slice_start
    ),
    cashier_hours_per_bucket as (
      select bucket_start, sum(cashier_hours) as cashier_hours
        from shift_buckets
       where cashier_hours > 0
       group by bucket_start
    ),
    tx_per_bucket as (
      select ${bucketSelectExpr(truncUnit, 'so.pay_time')} as bucket_start,
             count(*)::float as tx
        from sweed_orders so
       where so.dealer_id = any($1::bigint[])
         and so.pay_time >= $2::timestamptz
         and so.pay_time <  $3::timestamptz
       group by 1
    )
    select c.bucket_start as bucket_start,
           case when c.cashier_hours > 0
                then (coalesce(t.tx, 0) / c.cashier_hours)
                else null
           end as value
      from cashier_hours_per_bucket c
      left join tx_per_bucket t on t.bucket_start = c.bucket_start
  `

  const result = await pool.query<{ bucket_start: string | Date | null; value: string | null }>(sql, [
    dealerIds,
    from.toISOString(),
    to.toISOString(),
  ])

  const valueByBucketIso = new Map<string, number | null>()
  for (const row of result.rows) {
    if (row.bucket_start === null) continue
    const iso = new Date(row.bucket_start as string).toISOString()
    const raw = row.value === null ? null : Number(row.value)
    valueByBucketIso.set(iso, raw === null || !Number.isFinite(raw) ? null : raw)
  }

  return buckets.map((b) => {
    const iso = b.toISOString()
    const v = valueByBucketIso.has(iso) ? (valueByBucketIso.get(iso) ?? null) : null
    return { t: iso, [SERIES_ID]: v }
  })
}
