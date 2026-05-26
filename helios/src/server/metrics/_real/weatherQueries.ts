import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  HELIOS_SITE_ZIP_BY_DEALER,
  type HeliosPendingPurchaseSiteDealer,
} from '../../../shared/contracts/index.js'
import { getPool } from '../../db/pool.js'
import { defaultWindow, walkBuckets } from '../timeBuckets.js'
import type { MetricAggregation } from '../../../shared/contracts/index.js'
import type { MetricQueryArgs, MetricRow } from '../types.js'

// ============================================================================
// Weather-correlation metric queries (FreshlyBakedNYC/automation#26).
//
// Each metric returns one row per (site_zip, day) tuple within the
// requested window, with two series populated:
//
//   * `weather_value`    — the per-day weather observation (high °F,
//                          low °F, or precip inches depending on the
//                          metric variant)
//   * `margin_dollars`   — daily sum of (grand_total - tax - discount)
//                          from `sweed_orders`, joined to the
//                          weather row on ET date.
//
// The existing chart wrapper renders two-series rows as a time
// series over `t`; the operator can read the per-day correlation by
// eye until a scatter renderer ships in the SPA. When that lands,
// no query change is needed — the data is already shaped as
// "(weather_x, margin_y) per (site, day)".
//
// Bucketing: at `date` agg (the default) we return one row per day
// per site. At `week` / `month` agg we collapse to the average of
// each axis within the bucket, weighted equally per day. At `total`
// agg we collapse to a single all-time average. Hourly and
// categorical (`dow`, `dom`, `dofortnight`) aggregations are NOT
// supported because the underlying weather data has daily grain.
// ============================================================================

const SUPPORTED_AGGS: ReadonlyArray<MetricAggregation> = ['total', 'month', 'week', 'date']

const POSTGRES_TRUNC_UNIT_BY_AGG: Partial<Record<MetricAggregation, string>> = {
  date: 'day',
  week: 'week',
  month: 'month',
}

export type WeatherVariable = 'high_temp_f' | 'low_temp_f' | 'precip_in'

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

function resolveWindow(args: MetricQueryArgs): { from: Date; to: Date; buckets: Date[] } {
  const w = defaultWindow(args.from, args.to, args.agg)
  const buckets = walkBuckets(w.from, w.to, args.agg)
  return { from: w.from, to: w.to, buckets }
}

/**
 * Resolve the supplied dealer IDs (filtered by `args.sites`) to site
 * ZIPs the worker writes into `weather_daily`. Returns an empty
 * array if no resolved dealer has a known ZIP mapping.
 */
function resolveSiteZips(sites: readonly string[]): string[] {
  const dealerIds = resolveDealerIds(sites)
  const zips: string[] = []
  for (const id of dealerIds) {
    const zip = HELIOS_SITE_ZIP_BY_DEALER[id]
    if (zip) zips.push(zip)
  }
  return [...new Set(zips)]
}

/**
 * Map (dealer_id, pay_time) → (site_zip, et_date) so we can join
 * `sweed_orders` to `weather_daily` on (site_zip, date). The
 * mapping uses a literal `case` on dealer_id so we keep the
 * site-zip constant in TypeScript (the issue's explicit operator
 * preference) without standing up a `site_dealer_zips` table.
 */
function dealerZipCaseExpr(): string {
  // Built from HELIOS_SITE_ZIP_BY_DEALER — safe because the values
  // are literal integers and quoted strings we control.
  const whens = Object.entries(HELIOS_SITE_ZIP_BY_DEALER)
    .map(([dealerId, zip]) => `when ${Number(dealerId)} then '${zip}'`)
    .join(' ')
  return `case dealer_id ${whens} else null end`
}

interface DayWeatherMarginRow {
  site_zip: string
  date: string // YYYY-MM-DD
  weather_value: number | null
  margin_dollars: number | null
}

async function fetchPerDayRows(
  variable: WeatherVariable,
  dealerIds: number[],
  zips: string[],
  from: Date,
  to: Date,
): Promise<DayWeatherMarginRow[]> {
  const pool = getPool()
  const sql = `
    with per_day_margin as (
      select ${dealerZipCaseExpr()} as site_zip,
             (pay_time at time zone $1)::date as date,
             sum(coalesce(grand_total_dollars, 0)
                 - coalesce(tax_dollars, 0)
                 - coalesce(discount_dollars, 0)) as margin_dollars
        from sweed_orders
       where dealer_id = any($2::bigint[])
         and pay_time >= $3 and pay_time < $4
       group by 1, 2
    )
    select w.site_zip::text as site_zip,
           to_char(w.date, 'YYYY-MM-DD') as date,
           w.${variable}::numeric as weather_value,
           p.margin_dollars::numeric as margin_dollars
      from weather_daily w
      left join per_day_margin p
        on p.site_zip = w.site_zip
       and p.date = w.date
     where w.site_zip = any($5::text[])
       and w.date >= ($3::timestamptz at time zone $1)::date
       and w.date <  ($4::timestamptz at time zone $1)::date
     order by w.date, w.site_zip
  `
  const result = await pool.query<{
    site_zip: string
    date: string
    weather_value: string | null
    margin_dollars: string | null
  }>(sql, ['America/New_York', dealerIds, from.toISOString(), to.toISOString(), zips])

  return result.rows.map((r) => ({
    site_zip: r.site_zip,
    date: r.date,
    weather_value: r.weather_value === null ? null : Number(r.weather_value),
    margin_dollars: r.margin_dollars === null ? null : Number(r.margin_dollars),
  }))
}

/**
 * Map the SQL per-day rows into MetricRow[] bucketed at the
 * requested aggregation. For `date` agg we surface one row per
 * (day, site) — collisions across sites within the same bucket
 * are averaged because the SPA chart only has one (weather,
 * margin) slot per bucket. (When a scatter renderer lands, this
 * collapse step gets dropped and each (site, day) becomes its
 * own point.)
 */
function shapeBuckets(
  rows: DayWeatherMarginRow[],
  buckets: Date[],
  agg: MetricAggregation,
): MetricRow[] {
  if (buckets.length === 0) return []

  // Per-bucket accumulator. We average weather and sum margin per
  // bucket; for the daily agg this is a no-op (one row per bucket).
  const acc = new Map<
    string,
    {
      weatherSum: number
      weatherCount: number
      marginSum: number
      marginCount: number
    }
  >()

  const truncUnit = POSTGRES_TRUNC_UNIT_BY_AGG[agg] ?? null

  for (const row of rows) {
    const bucketIso = bucketIsoForRow(row.date, agg, buckets)
    if (bucketIso === null) continue
    let entry = acc.get(bucketIso)
    if (!entry) {
      entry = { weatherSum: 0, weatherCount: 0, marginSum: 0, marginCount: 0 }
      acc.set(bucketIso, entry)
    }
    if (row.weather_value !== null && Number.isFinite(row.weather_value)) {
      entry.weatherSum += row.weather_value
      entry.weatherCount += 1
    }
    if (row.margin_dollars !== null && Number.isFinite(row.margin_dollars)) {
      entry.marginSum += row.margin_dollars
      entry.marginCount += 1
    }
  }

  return buckets.map((b) => {
    const key = b.toISOString()
    const entry = acc.get(key)
    const out: Record<string, string | number | null> = { t: key }
    if (!entry) {
      out.weather_value = null
      out.margin_dollars = null
      return out as MetricRow
    }
    out.weather_value = entry.weatherCount > 0 ? entry.weatherSum / entry.weatherCount : null
    if (agg === 'date' || truncUnit === null) {
      // For daily / total agg we surface the SUM of margins in the
      // bucket (one day's margin for `date`, all margins for
      // `total`). The weather value is the daily observation
      // average — the per-day grain of the source means at `date`
      // agg both axes are simple one-element averages.
      out.margin_dollars = entry.marginCount > 0 ? entry.marginSum : null
    } else {
      // For week / month we average the daily margin so the chart
      // shows "typical day-in-this-period" not a fluctuating sum
      // (which would otherwise look bigger on full-week buckets
      // than on partial-week leading / trailing buckets).
      out.margin_dollars = entry.marginCount > 0 ? entry.marginSum / entry.marginCount : null
    }
    return out as MetricRow
  })
}

/** Find the bucket-start ISO key (as ISO string) for the given ET
 * date `YYYY-MM-DD`. We binary-search-ish via the sorted `buckets`
 * array: each bucket is the start of its window, and the row's
 * date belongs to the latest bucket whose start <= the row's
 * date midnight. Linear scan is fine — buckets is small. */
function bucketIsoForRow(rowDate: string, agg: MetricAggregation, buckets: Date[]): string | null {
  if (agg === 'total') {
    return buckets[0]?.toISOString() ?? null
  }
  const [yStr, mStr, dStr] = rowDate.split('-')
  // Treat the row's date as 00:00 UTC for comparison (the bucket
  // boundaries themselves are stored as UTC instants aligned to
  // ET-day starts — within a 7-day or 30-day window the UTC and
  // ET-midnights line up to the same ordering, which is all we
  // need to bin into the right bucket).
  const rowMs = Date.UTC(Number(yStr), Number(mStr) - 1, Number(dStr))

  let best: Date | null = null
  for (const b of buckets) {
    if (b.getTime() <= rowMs) {
      best = b
    } else {
      break
    }
  }
  if (best === null) return null
  return best.toISOString()
}

async function queryWeatherMargin(
  variable: WeatherVariable,
  args: MetricQueryArgs,
): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const zips = resolveSiteZips(args.sites)
  const { from, to, buckets } = resolveWindow(args)
  if (dealerIds.length === 0 || zips.length === 0 || buckets.length === 0) {
    return buckets.map((b) => ({ t: b.toISOString(), weather_value: null, margin_dollars: null }))
  }
  const rows = await fetchPerDayRows(variable, dealerIds, zips, from, to)
  return shapeBuckets(rows, buckets, args.agg)
}

export const WEATHER_METRIC_SUPPORTED_AGGS = SUPPORTED_AGGS

export async function queryWeatherMarginVsHighTemp(args: MetricQueryArgs): Promise<MetricRow[]> {
  return queryWeatherMargin('high_temp_f', args)
}

export async function queryWeatherMarginVsLowTemp(args: MetricQueryArgs): Promise<MetricRow[]> {
  return queryWeatherMargin('low_temp_f', args)
}

export async function queryWeatherMarginVsPrecip(args: MetricQueryArgs): Promise<MetricRow[]> {
  return queryWeatherMargin('precip_in', args)
}
