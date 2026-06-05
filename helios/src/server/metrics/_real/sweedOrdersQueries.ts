import type { MetricAggregation } from '../../../shared/contracts/index.js'
import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type HeliosPendingPurchaseSiteDealer,
} from '../../../shared/contracts/index.js'
import { bucketSelectExpr } from '../bucketSelectSql.js'
import { getPool } from '../../db/pool.js'
import { defaultWindow, walkBuckets } from '../timeBuckets.js'
import type { MetricQueryArgs, MetricRow } from '../types.js'
import {
  CATALOG_PRODUCT_MAPPING_CTE,
  catalogFilterParams,
  catalogFilterWhere,
  hasAnyCatalogFilter,
} from './catalogFilterSql.js'

// ============================================================================
// Real-data SQL helpers for `/metrics`.
//
// These query `sweed_orders` (mirrored by the ingest worker added in
// automation#22) and return `MetricRow[]` shaped exactly like the
// stubs they replace. The MetricDef.id / group / title / series are
// unchanged on swap so historical screenshots + annotations still
// line up.
//
// Common conventions for every helper here:
//   * Bucket grain comes from `args.agg`; we map it to a Postgres
//     `date_trunc()` unit. Categorical aggregations (`dow`, `dom`,
//     `dofortnight`, `total`) collapse to a single bucket per series.
//   * Site filtering: `args.sites` carries siteKey strings ('bronx',
//     'midtown'). We resolve them to dealer_ids against the in-process
//     dealer registry rather than splicing strings into SQL.
//   * Window: caller may pass null for from/to; we use the same
//     `defaultWindow()` the stubs use so the window math is identical.
//   * Missing buckets are filled with zero (count / dollar metrics)
//     or null (ratio metrics).
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
  buckets: Date[]
}

function resolveWindow(args: MetricQueryArgs): ResolvedWindow {
  const w = defaultWindow(args.from, args.to, args.agg)
  const buckets = walkBuckets(w.from, w.to, args.agg)
  const truncUnit =
    args.agg === 'dow' || args.agg === 'dom' || args.agg === 'dofortnight' || args.agg === 'total'
      ? null
      : POSTGRES_TRUNC_UNIT_BY_AGG[args.agg]
  return { from: w.from, to: w.to, truncUnit, buckets }
}

// `bucketSelectExpr` lives in ../bucketSelectSql.ts so every metric
// helper in the codebase uses the SAME NY-day / UTC-hour convention.
// See that file for the doc-comment and the regression history.

/**
 * SQL fragment producing the per-row series id for new-vs-returning
 * customer splits. **Must** be computed at QUERY time, not read from
 * the stored `first_time_for_customer` column.
 *
 * Why: the ingest worker records `first_time_for_customer` by checking
 * "does this customer have any prior pay_time row in the table right
 * now?". Forward polling ingests in ascending pay_time order, which
 * works fine — but the backfill loop walks **backwards** (newest day
 * to oldest day). When backfill arrives at a customer's earlier order
 * AFTER forward polling has already inserted a later one, the EXISTS
 * check sees no prior row (the only existing row has a *later*
 * pay_time) and marks the backfilled row as `first_time=true` as
 * well. Two "firsts" for the same customer. Operator observed this on
 * 2026-05-26 — Sweed's "new customers / week" was much smaller than
 * Helios's first_time count.
 *
 * Computing at query time via NOT EXISTS over the live table is
 * always correct regardless of insertion order. The
 * (customer_id, pay_time) partial index makes the per-row lookup
 * cheap (it short-circuits at the first prior row).
 *
 * Guests (customer_id IS NULL) are counted as 'returning' so the
 * curve is conservative — same convention the original insert-time
 * logic used.
 *
 * Requires the calling SQL to alias `sweed_orders` as `so`.
 */
export const FIRST_TIME_SERIES_EXPR = `
  case
    when so.customer_id is not null
     and not exists (
       select 1 from sweed_orders prior
        where prior.customer_id = so.customer_id
          and prior.pay_time < so.pay_time
     )
    then 'first_time'
    else 'returning'
  end
`

/**
 * Run a bucketed query that produces one row per (bucket_start, series_id, value)
 * and shape the result into MetricRow[] with one row per expected bucket.
 *
 * `seriesIds` is the universe of series the metric declared. Any
 * (bucket, series) pair the SQL didn't produce gets `defaultValue`
 * (typically 0 for counts / sums, null for ratios).
 */
async function runBucketedQuery(args: {
  sql: string
  params: unknown[]
  seriesIds: readonly string[]
  buckets: Date[]
  defaultValue: number | null
  /** When agg is categorical (`total` etc.), collapse all SQL rows into
   *  the single bucket at buckets[0]. */
  collapseToSingleBucket: boolean
}): Promise<MetricRow[]> {
  const pool = getPool()
  const result = await pool.query<{ bucket_start: string | null; series_id: string; value: string | null }>(
    args.sql,
    args.params,
  )

  // Map bucket-iso -> series-id -> value
  const data = new Map<string, Map<string, number | null>>()
  for (const row of result.rows) {
    const key = args.collapseToSingleBucket
      ? args.buckets[0]!.toISOString()
      : row.bucket_start
        ? new Date(row.bucket_start).toISOString()
        : null
    if (key === null) continue
    let inner = data.get(key)
    if (!inner) {
      inner = new Map()
      data.set(key, inner)
    }
    const num = row.value === null ? null : Number(row.value)
    inner.set(row.series_id, Number.isFinite(num as number) ? (num as number) : null)
  }

  return args.buckets.map((b) => {
    const isoKey = b.toISOString()
    const inner = data.get(isoKey) ?? new Map<string, number | null>()
    const out: Record<string, string | number | null> = { t: isoKey }
    for (const sid of args.seriesIds) {
      const v = inner.get(sid)
      out[sid] = v === undefined ? args.defaultValue : v
    }
    return out as MetricRow
  })
}

// ----- Concrete metric queries -----

/** acquisition.first_vs_returning — count of completed orders per
 *  bucket, split by whether THIS PURCHASE was the customer's first
 *  ever purchase (per-purchase yes/no, not per-customer dedupe). */
export async function queryFirstVsReturning(args: MetricQueryArgs): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { from, to, truncUnit, buckets } = resolveWindow(args)
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => ({ t: b.toISOString(), first_time: 0, returning: 0 }))
  }
  if (truncUnit === null) {
    const sql = `
      select ${FIRST_TIME_SERIES_EXPR} as series_id,
             count(*) as value
        from sweed_orders so
       where so.dealer_id = any($1::bigint[])
         and so.pay_time >= $2 and so.pay_time < $3
       group by 1
    `
    return runBucketedQuery({
      sql,
      params: [dealerIds, from.toISOString(), to.toISOString()],
      seriesIds: ['first_time', 'returning'],
      buckets,
      defaultValue: 0,
      collapseToSingleBucket: true,
    })
  }
  const sql = `
    select ${bucketSelectExpr(truncUnit, 'so.pay_time')} as bucket_start,
           ${FIRST_TIME_SERIES_EXPR} as series_id,
           count(*) as value
      from sweed_orders so
     where so.dealer_id = any($1::bigint[])
       and so.pay_time >= $2 and so.pay_time < $3
     group by 1, 2
  `
  return runBucketedQuery({
    sql,
    params: [dealerIds, from.toISOString(), to.toISOString()],
    seriesIds: ['first_time', 'returning'],
    buckets,
    defaultValue: 0,
    collapseToSingleBucket: false,
  })
}

/** Generic "count or sum by some categorical column / expression" bucketed
 *  query. `colExpr` is interpolated unparsed — callers MUST use only
 *  whitelisted column names + literal CASE expressions, never user input.
 */
async function queryGroupedByColumn(args: {
  args: MetricQueryArgs
  /** SQL expression evaluated per row whose value names the series.
   *  Either a plain whitelisted column name (e.g. `lower(payment_method)`)
   *  or a derived CASE expression (e.g. FULFILLMENT_SERIES_SQL_EXPR). */
  colExpr: string
  /** SQL aggregate expression, e.g. 'count(*)' or 'sum(grand_total_dollars)'. */
  aggExpr: string
  /** Mapping from canonical column value to series id. Values not in
   *  this map fall into `unknownSeriesId` (e.g. 'other'). Pass an
   *  identity-style map (`Map([['delivery_prepaid','delivery_prepaid'],…])`)
   *  when colExpr already returns a series id. */
  seriesByValue: ReadonlyMap<string, string>
  seriesIds: readonly string[]
  unknownSeriesId: string
}): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.args.sites)
  const { from, to, truncUnit, buckets } = resolveWindow(args.args)
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => {
      const row: Record<string, string | number | null> = { t: b.toISOString() }
      for (const sid of args.seriesIds) row[sid] = 0
      return row as MetricRow
    })
  }
  const bucketSelect = bucketSelectExpr(truncUnit)
  const sql = `
    select ${bucketSelect} as bucket_start,
           coalesce(${args.colExpr}, '') as col_value,
           ${args.aggExpr}::numeric as value
      from sweed_orders
     where dealer_id = any($1::bigint[])
       and pay_time >= $2 and pay_time < $3
     group by 1, 2
  `
  const pool = getPool()
  const result = await pool.query<{ bucket_start: string | null; col_value: string | null; value: string | null }>(
    sql,
    [dealerIds, from.toISOString(), to.toISOString()],
  )
  const data = new Map<string, Map<string, number>>()
  for (const row of result.rows) {
    const bucketKey =
      truncUnit === null
        ? buckets[0]!.toISOString()
        : row.bucket_start
          ? new Date(row.bucket_start).toISOString()
          : null
    if (bucketKey === null) continue
    const canonical = (row.col_value ?? '').trim().toLowerCase()
    const sid = args.seriesByValue.get(canonical) ?? args.unknownSeriesId
    let inner = data.get(bucketKey)
    if (!inner) {
      inner = new Map()
      data.set(bucketKey, inner)
    }
    const num = row.value === null ? 0 : Number(row.value)
    inner.set(sid, (inner.get(sid) ?? 0) + (Number.isFinite(num) ? num : 0))
  }
  return buckets.map((b) => {
    const inner = data.get(b.toISOString()) ?? new Map<string, number>()
    const out: Record<string, string | number | null> = { t: b.toISOString() }
    for (const sid of args.seriesIds) out[sid] = inner.get(sid) ?? 0
    return out as MetricRow
  })
}

/** basket.size_by_fulfillment — avg basket $ by fulfillment type. */
export async function queryBasketSizeByFulfillment(args: MetricQueryArgs): Promise<MetricRow[]> {
  return queryAvgGroupedByFulfillment(args, 'avg(grand_total_dollars)')
}

/** basket.size_by_customer_type — avg basket $ split by whether
 *  THIS PURCHASE was the customer's first ever purchase
 *  (per-purchase yes/no, not per-customer dedupe). */
export async function queryBasketSizeByCustomerType(args: MetricQueryArgs): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { from, to, truncUnit, buckets } = resolveWindow(args)
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => ({ t: b.toISOString(), first_time: 0, returning: 0 }))
  }
  const bucketSelect = bucketSelectExpr(truncUnit, 'so.pay_time')
  const sql = `
    select ${bucketSelect} as bucket_start,
           ${FIRST_TIME_SERIES_EXPR} as series_id,
           avg(so.grand_total_dollars)::numeric as value
      from sweed_orders so
     where so.dealer_id = any($1::bigint[])
       and so.pay_time >= $2 and so.pay_time < $3
     group by 1, 2
  `
  return runBucketedQuery({
    sql,
    params: [dealerIds, from.toISOString(), to.toISOString()],
    seriesIds: ['first_time', 'returning'],
    buckets,
    defaultValue: 0,
    collapseToSingleBucket: truncUnit === null,
  })
}

// Sweed's canonical `issuingType.name` values, as observed in live
// Bronx + Midtown invoices on 2026-05-26.
//
// Per-purchase prepaid-vs-COD classification (operator directive
// 2026-05-27): we derive this from BOTH `fulfillment_type` AND
// `payment_method`, server-side at query time, so the classification
// always reflects the latest rule without a historical reclass
// backfill being necessary.
//
//   * Delivery payment = aeropay   → 'delivery_prepaid'
//     Delivery payment = anything  → 'delivery_cod'   (cash / debit /
//                                                       credit / unknown)
//   * Pickup   payment = aeropay   → 'pickup_prepaid'
//     Pickup   payment = anything  → 'pickup'
//   * Kiosk                        → 'kiosk'
//   * Walk-in / pharmacy / pos / unknown → 'in_store'
//
// The split anticipates Sweed exposing additional integrated payment
// rails (integrated debit / credit) as "prepaid": when that lands,
// extend the aeropay membership test below.

const PREPAID_PAYMENT_METHODS_SQL = `lower(coalesce(payment_method, '')) in ('aeropay')`

const DELIVERY_FULFILLMENT_VALUES_SQL = `(
  'delivery sale',
  'delivery (prepaid)',
  'delivery prepaid',
  'delivery (cod)',
  'delivery cod',
  'delivery',
  'website'
)`

const PICKUP_FULFILLMENT_VALUES_SQL = `(
  'pick-up sale',
  'pickup sale',
  'pickup'
)`

const KIOSK_FULFILLMENT_VALUES_SQL = `(
  'kiosk order',
  'kiosk'
)`

/** SQL expression returning the canonical series id directly.
 *  Use as `colExpr` to queryGroupedByColumn / inline in other SQL.
 *
 *  IMPORTANT: keep the membership lists in sync with the per-purchase
 *  classification rule documented above. */
const FULFILLMENT_SERIES_SQL_EXPR = `
  case
    when lower(coalesce(fulfillment_type, '')) in ${DELIVERY_FULFILLMENT_VALUES_SQL}
      then case when ${PREPAID_PAYMENT_METHODS_SQL} then 'delivery_prepaid' else 'delivery_cod' end
    when lower(coalesce(fulfillment_type, '')) in ${PICKUP_FULFILLMENT_VALUES_SQL}
      then case when ${PREPAID_PAYMENT_METHODS_SQL} then 'pickup_prepaid' else 'pickup' end
    when lower(coalesce(fulfillment_type, '')) in ${KIOSK_FULFILLMENT_VALUES_SQL}
      then 'kiosk'
    else 'in_store'
  end
`
/** Same expression but for SQL that aliases sweed_orders as `so`. */
const FULFILLMENT_SERIES_SQL_EXPR_SO = FULFILLMENT_SERIES_SQL_EXPR
  .replaceAll('fulfillment_type', 'so.fulfillment_type')
  .replaceAll('payment_method', 'so.payment_method')

// Identity map — the SQL expression above already emits the canonical
// series id, so JS-side mapping is just a passthrough.
const FULFILLMENT_SERIES_BY_VALUE: ReadonlyMap<string, string> = new Map([
  ['delivery_prepaid', 'delivery_prepaid'],
  ['delivery_cod', 'delivery_cod'],
  ['kiosk', 'kiosk'],
  ['pickup', 'pickup'],
  ['pickup_prepaid', 'pickup_prepaid'],
  ['in_store', 'in_store'],
])

const FULFILLMENT_SERIES_IDS = [
  'delivery_prepaid',
  'delivery_cod',
  'kiosk',
  'pickup_prepaid',
  'pickup',
  'in_store',
] as const

export { FULFILLMENT_SERIES_SQL_EXPR, FULFILLMENT_SERIES_SQL_EXPR_SO }

async function queryAvgGroupedByFulfillment(args: MetricQueryArgs, aggExpr: string): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { from, to, truncUnit, buckets } = resolveWindow(args)
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => {
      const row: Record<string, string | number | null> = { t: b.toISOString() }
      for (const sid of FULFILLMENT_SERIES_IDS) row[sid] = 0
      return row as MetricRow
    })
  }
  const bucketSelect = bucketSelectExpr(truncUnit)
  const sql = `
    select ${bucketSelect} as bucket_start,
           coalesce(${FULFILLMENT_SERIES_SQL_EXPR}, '') as col_value,
           ${aggExpr}::numeric as value
      from sweed_orders
     where dealer_id = any($1::bigint[])
       and pay_time >= $2 and pay_time < $3
     group by 1, 2
  `
  const pool = getPool()
  const result = await pool.query<{ bucket_start: string | null; col_value: string | null; value: string | null }>(
    sql,
    [dealerIds, from.toISOString(), to.toISOString()],
  )
  const data = new Map<string, Map<string, { sum: number; count: number }>>()
  // For averages, we have to weight by count to combine same-series rows.
  // Re-issue the query so we get both sum and count per (bucket, value).
  const sql2 = `
    select ${bucketSelect} as bucket_start,
           coalesce(${FULFILLMENT_SERIES_SQL_EXPR}, '') as col_value,
           sum(grand_total_dollars)::numeric as sum_value,
           count(*) as cnt
      from sweed_orders
     where dealer_id = any($1::bigint[])
       and pay_time >= $2 and pay_time < $3
     group by 1, 2
  `
  const r2 = await pool.query<{ bucket_start: string | null; col_value: string | null; sum_value: string | null; cnt: string }>(
    sql2,
    [dealerIds, from.toISOString(), to.toISOString()],
  )
  for (const row of r2.rows) {
    const bucketKey =
      truncUnit === null
        ? buckets[0]!.toISOString()
        : row.bucket_start
          ? new Date(row.bucket_start).toISOString()
          : null
    if (bucketKey === null) continue
    const canonical = (row.col_value ?? '').trim().toLowerCase()
    const sid = FULFILLMENT_SERIES_BY_VALUE.get(canonical) ?? 'in_store'
    let inner = data.get(bucketKey)
    if (!inner) {
      inner = new Map()
      data.set(bucketKey, inner)
    }
    const sumNum = row.sum_value === null ? 0 : Number(row.sum_value)
    const cntNum = Number(row.cnt)
    const prev = inner.get(sid) ?? { sum: 0, count: 0 }
    inner.set(sid, { sum: prev.sum + (Number.isFinite(sumNum) ? sumNum : 0), count: prev.count + (Number.isFinite(cntNum) ? cntNum : 0) })
  }
  // Avoid unused-variable lint on the count-only result.
  void result
  return buckets.map((b) => {
    const inner = data.get(b.toISOString()) ?? new Map<string, { sum: number; count: number }>()
    const out: Record<string, string | number | null> = { t: b.toISOString() }
    for (const sid of FULFILLMENT_SERIES_IDS) {
      const v = inner.get(sid)
      out[sid] = v && v.count > 0 ? round2(v.sum / v.count) : 0
    }
    return out as MetricRow
  })
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** fulfillment.order_count — order count split by fulfillment type
 *  (delivery / pickup are further split prepaid-vs-COD by payment
 *  method; see FULFILLMENT_SERIES_SQL_EXPR). */
export function queryFulfillmentOrderCount(args: MetricQueryArgs): Promise<MetricRow[]> {
  return queryGroupedByColumn({
    args,
    colExpr: FULFILLMENT_SERIES_SQL_EXPR,
    aggExpr: 'count(*)',
    seriesByValue: FULFILLMENT_SERIES_BY_VALUE,
    seriesIds: FULFILLMENT_SERIES_IDS,
    unknownSeriesId: 'in_store',
  })
}

/** fulfillment.sales_dollars — sum(grand_total) split by fulfillment type
 *  (with prepaid/COD split, same as above). */
export function queryFulfillmentSalesDollars(args: MetricQueryArgs): Promise<MetricRow[]> {
  return queryGroupedByColumn({
    args,
    colExpr: FULFILLMENT_SERIES_SQL_EXPR,
    aggExpr: 'sum(grand_total_dollars)',
    seriesByValue: FULFILLMENT_SERIES_BY_VALUE,
    seriesIds: FULFILLMENT_SERIES_IDS,
    unknownSeriesId: 'in_store',
  })
}

// Sweed's canonical `payments[].paymentMethod.name` values, observed
// live on Bronx + Midtown on 2026-05-26: "Cash", "Debit Card",
// "Aeropay", "Reverse ATM change". The reverse-ATM tender is the
// kiosk's change-dispensing rail; it always rides on a primary
// tender that we already pick as the largest-amount method, so any
// row that has it as the primary is a refund / edge case and lands
// in 'other'.
const PAYMENT_SERIES_BY_VALUE: ReadonlyMap<string, string> = new Map([
  ['cash', 'cash'],
  ['debit card', 'debit'],
  ['debit', 'debit'],
  ['credit card', 'credit'],
  ['credit', 'credit'],
  ['aeropay', 'aeropay'],
  ['reverse atm change', 'other'],
  ['', 'other'],
])

const PAYMENT_SERIES_IDS = ['cash', 'debit', 'credit', 'aeropay', 'other'] as const

/** payment.order_count — order count split by payment method. */
export function queryPaymentOrderCount(args: MetricQueryArgs): Promise<MetricRow[]> {
  return queryGroupedByColumn({
    args,
    colExpr: 'lower(payment_method)',
    aggExpr: 'count(*)',
    seriesByValue: PAYMENT_SERIES_BY_VALUE,
    seriesIds: PAYMENT_SERIES_IDS,
    unknownSeriesId: 'other',
  })
}

/** payment.sales_dollars — sum(grand_total) split by payment method. */
export function queryPaymentSalesDollars(args: MetricQueryArgs): Promise<MetricRow[]> {
  return queryGroupedByColumn({
    args,
    colExpr: 'lower(payment_method)',
    aggExpr: 'sum(grand_total_dollars)',
    seriesByValue: PAYMENT_SERIES_BY_VALUE,
    seriesIds: PAYMENT_SERIES_IDS,
    unknownSeriesId: 'other',
  })
}

// ----- Customer-origin map (P6) + Delivery order-count-by-zone (P5) -----
//
// Both metrics bucket each order into a geographic series. The
// canonical bucketing is by **county** of the resolved address:
// the five NYC boroughs map 1-to-1 to NY counties, NJ (any
// county) gets its own bucket, and everything else falls into
// 'other'.
//
// Address resolution path (FreshlyBakedNYC/automation#25 wires
// these in via A1/A4/A5; A6 = this rewrite consuming them):
//
//   * For `customers.origin_map` — prefer the customer's primary
//     address from sweed_customer_addresses (kind='primary'), fall
//     back to the order's delivery_address_id, then to NULL ('other').
//   * For `delivery.order_count_by_zone` — only the order's
//     delivery_address_id, since the metric is about where the
//     delivery actually went.
//
// Counties for the five NYC boroughs (per US Census):
//
//   Manhattan   = New York County
//   Brooklyn    = Kings County
//   Queens      = Queens County
//   Bronx       = Bronx County
//   Staten Is.  = Richmond County
//
// We match `addresses.county` case-insensitively against the
// county basename (Census returns either "New York" or
// "New York County" depending on response shape — we lower-case
// and strip a trailing " county" before matching).

const NYC_COUNTY_TO_SERIES: ReadonlyMap<string, string> = new Map([
  ['new york', 'manhattan'],
  ['kings', 'brooklyn'],
  ['queens', 'queens'],
  ['bronx', 'bronx'],
  ['richmond', 'staten_island'],
])

const ORIGIN_SERIES_IDS = [
  'manhattan',
  'brooklyn',
  'queens',
  'bronx',
  'staten_island',
  'nj',
  'other',
] as const

export function bucketForAddress(county: string | null, stateCode: string | null): string {
  const stateUpper = stateCode === null ? null : stateCode.trim().toUpperCase()
  if (county !== null && stateUpper === 'NY') {
    const canonical = county.trim().toLowerCase().replace(/\s+county$/, '')
    const series = NYC_COUNTY_TO_SERIES.get(canonical)
    if (series !== undefined) return series
  }
  if (stateUpper === 'NJ') return 'nj'
  return 'other'
}

// ----- Category sales (P3) -----
//
// `store.sale.invoice.list` returns each order with a `raw_json.items[]`
// array. Each item has a `productCategory.name` (e.g. "Pre-Rolls",
// "Flower", "Vapes") and per-item `subtotalAmount`. We aggregate
// `sum(subtotalAmount)` per (bucket, category) and bin the live category
// names into the stub-declared series IDs.
//
// COGS-based metrics (category.margin_dollars_stack, fulfillment.margin_*)
// still need wholesale cost — and `store.sale.invoice.list` returns
// `wholesaleCost: 0` on every item (observed across 1,252 line items
// on 2026-05-26). The fix needs either:
//   (a) a per-invoice `store.sale.invoice.get` poll that includes cost, or
//   (b) a separate `store.product.list` cache keyed by inventoryItemId.
// Tracked as a follow-on under #22; until then those metrics stay stubs.

// Sweed's live `items[].productCategory.name` values, observed on Bronx
// + Midtown on 2026-05-26. Any value not in this map falls into 'other'.
const CATEGORY_SERIES_BY_VALUE: ReadonlyMap<string, string> = new Map([
  ['pre-rolls', 'preroll'],
  ['pre rolls', 'preroll'],
  ['preroll', 'preroll'],
  ['flower', 'flower'],
  ['edibles', 'edible'],
  ['edible', 'edible'],
  ['vapes', 'vape'],
  ['vape', 'vape'],
  ['concentrates', 'concentrate'],
  ['concentrate', 'concentrate'],
  ['accessories', 'accessory'],
  ['accessory', 'accessory'],
  ['beverages', 'other'],
  ['beverage', 'other'],
  ['other', 'other'],
  ['', 'other'],
])

const CATEGORY_SERIES_IDS = [
  'flower',
  'preroll',
  'edible',
  'vape',
  'concentrate',
  'accessory',
  'other',
] as const

/** Run a "sum/avg per (bucket, productCategory) over raw_json items"
 *  query and shape into MetricRow[] with category-series binning. */
async function queryCategoryLineItems(args: MetricQueryArgs): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { from, to, truncUnit, buckets } = resolveWindow(args)
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => {
      const row: Record<string, string | number | null> = { t: b.toISOString() }
      for (const sid of CATEGORY_SERIES_IDS) row[sid] = 0
      return row as MetricRow
    })
  }
  const bucketSelect = bucketSelectExpr(truncUnit, 'f.pay_time')
  // D1: reads the materialised sweed_order_items_flat table instead of
  // unrolling sweed_orders.raw_json->'items' per request. Series-binning
  // is by f.product_category_name (mirrors item->'productCategory'->>
  // 'name'; mapped to a stable canonical series id below) and value is
  // f.revenue (mirrors subtotalAmount).
  //
  // When catalog filters are active we narrow which line items
  // participate by joining catalog_product_mapping on the item's product
  // id. The OLD raw_json path joined on `item->>'productId'`, a key that
  // never exists in Sweed's payload (the id lives at
  // item->'product'->>'id'), so every catalog-filtered category query
  // silently returned ZERO rows. D1a captured the correct id into
  // f.product_id (bigint); we now join cpm.product_id (text) =
  // f.product_id::text, which FIXES that latent bug — catalog-filtered
  // category series now return real numbers. This is an intentional
  // behaviour change approved for D1 (not an "identical numbers"
  // migration for the filtered path).
  const filtersActive = hasAnyCatalogFilter(args)
  const sql = filtersActive
    ? `
      with ${CATALOG_PRODUCT_MAPPING_CTE}
      select ${bucketSelect} as bucket_start,
             coalesce(lower(f.product_category_name), '') as col_value,
             sum(f.revenue) as value
        from sweed_order_items_flat f
             join catalog_product_mapping cpm on cpm.product_id = f.product_id::text
       where f.dealer_id = any($1::bigint[])
         and f.pay_time >= $2 and f.pay_time < $3
         ${catalogFilterWhere('cpm', 4)}
       group by 1, 2
    `
    : `
      select ${bucketSelect} as bucket_start,
             coalesce(lower(f.product_category_name), '') as col_value,
             sum(f.revenue) as value
        from sweed_order_items_flat f
       where f.dealer_id = any($1::bigint[])
         and f.pay_time >= $2 and f.pay_time < $3
       group by 1, 2
    `
  const pool = getPool()
  const params: unknown[] = filtersActive
    ? [dealerIds, from.toISOString(), to.toISOString(), ...catalogFilterParams(args)]
    : [dealerIds, from.toISOString(), to.toISOString()]
  const result = await pool.query<{ bucket_start: string | null; col_value: string | null; value: string | null }>(
    sql,
    params,
  )
  const data = new Map<string, Map<string, number>>()
  for (const row of result.rows) {
    const bucketKey =
      truncUnit === null
        ? buckets[0]!.toISOString()
        : row.bucket_start
          ? new Date(row.bucket_start).toISOString()
          : null
    if (bucketKey === null) continue
    const canonical = (row.col_value ?? '').trim().toLowerCase()
    const sid = CATEGORY_SERIES_BY_VALUE.get(canonical) ?? 'other'
    let inner = data.get(bucketKey)
    if (!inner) {
      inner = new Map()
      data.set(bucketKey, inner)
    }
    const num = row.value === null ? 0 : Number(row.value)
    inner.set(sid, (inner.get(sid) ?? 0) + (Number.isFinite(num) ? num : 0))
  }
  return buckets.map((b) => {
    const inner = data.get(b.toISOString()) ?? new Map<string, number>()
    const out: Record<string, string | number | null> = { t: b.toISOString() }
    for (const sid of CATEGORY_SERIES_IDS) out[sid] = round2(inner.get(sid) ?? 0)
    return out as MetricRow
  })
}

/** category.sales_stack_dollars — stacked sales $ by product category. */
export function queryCategorySalesStackDollars(args: MetricQueryArgs): Promise<MetricRow[]> {
  return queryCategoryLineItems(args)
}

/** category.sales_stack_fraction — same as dollars but normalised to
 *  fractions per bucket. Sum across series is 1.0 in any non-empty
 *  bucket, 0.0 in empty buckets. */
export async function queryCategorySalesStackFraction(args: MetricQueryArgs): Promise<MetricRow[]> {
  const rows = await queryCategoryLineItems(args)
  return rows.map((row) => {
    let total = 0
    for (const sid of CATEGORY_SERIES_IDS) {
      const v = row[sid]
      if (typeof v === 'number') total += v
    }
    const out: Record<string, string | number | null> = { t: row.t }
    for (const sid of CATEGORY_SERIES_IDS) {
      const v = row[sid]
      const num = typeof v === 'number' ? v : 0
      out[sid] = total > 0 ? Math.round((num / total) * 10000) / 10000 : 0
    }
    return out as MetricRow
  })
}

/** customers.origin_map — order count by customer-origin borough.
 *  Prefers the customer's primary address (sweed_customer_addresses
 *  kind='primary' → addresses), falls back to the delivery_address
 *  on the order itself, falls back to 'other'. Counts ALL orders
 *  (delivery + in-store + kiosk) so the origin map reflects where
 *  our customers live, not just where deliveries went. */
export async function queryCustomerOriginMap(args: MetricQueryArgs): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { from, to, truncUnit, buckets } = resolveWindow(args)
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => {
      const row: Record<string, string | number | null> = { t: b.toISOString() }
      for (const sid of ORIGIN_SERIES_IDS) row[sid] = 0
      return row as MetricRow
    })
  }
  const bucketSelect = bucketSelectExpr(truncUnit)
  // Resolve each order to ONE address row: prefer the customer's
  // primary, fall back to the order's delivery address. Both joins
  // are filtered to addresses we've successfully geocoded so the
  // bucketing has real county/state to work with — un-geocoded
  // addresses fall through to 'other' just like missing-address
  // rows do.
  const sql = `
    with resolved as (
      -- sweed_orders has a composite PK (dealer_id, invoice_id); there is
      -- no single 'id' column, so we project only the fields the outer
      -- aggregation actually reads. Earlier versions selected so.id here
      -- and produced 500: column so.id does not exist at runtime.
      select ${bucketSelect} as bucket_start,
             coalesce(prim.county, deliv.county)     as county,
             coalesce(prim.state_code, deliv.state_code) as state_code
        from sweed_orders so
        left join lateral (
          select a.county, a.state_code
            from sweed_customer_addresses sca
            join addresses a on a.id = sca.address_id
           where sca.dealer_id = so.dealer_id
             and sca.customer_id = so.customer_id
             and sca.kind = 'primary'
             and a.geocode_status = 'ok'
           limit 1
        ) prim on so.customer_id is not null
        left join addresses deliv
          on deliv.id = so.delivery_address_id
         and deliv.geocode_status = 'ok'
       where so.dealer_id = any($1::bigint[])
         and so.pay_time >= $2 and so.pay_time < $3
    )
    select bucket_start, county, state_code, count(*)::numeric as value
      from resolved
     group by bucket_start, county, state_code
  `
  const pool = getPool()
  const result = await pool.query<{
    bucket_start: string | null
    county: string | null
    state_code: string | null
    value: string | null
  }>(sql, [dealerIds, from.toISOString(), to.toISOString()])
  const data = new Map<string, Map<string, number>>()
  for (const row of result.rows) {
    const bucketKey =
      truncUnit === null
        ? buckets[0]!.toISOString()
        : row.bucket_start
          ? new Date(row.bucket_start).toISOString()
          : null
    if (bucketKey === null) continue
    const sid = bucketForAddress(row.county, row.state_code)
    let inner = data.get(bucketKey)
    if (!inner) {
      inner = new Map()
      data.set(bucketKey, inner)
    }
    const num = row.value === null ? 0 : Number(row.value)
    inner.set(sid, (inner.get(sid) ?? 0) + (Number.isFinite(num) ? num : 0))
  }
  return buckets.map((b) => {
    const inner = data.get(b.toISOString()) ?? new Map<string, number>()
    const out: Record<string, string | number | null> = { t: b.toISOString() }
    for (const sid of ORIGIN_SERIES_IDS) out[sid] = inner.get(sid) ?? 0
    return out as MetricRow
  })
}

/** delivery.order_count_by_zone — delivery-only order count by
 *  delivery-destination borough. Strictly uses the order's
 *  delivery_address_id (no customer-primary fallback), since the
 *  metric is about where the delivery actually went. Falls into
 *  'other' when the order is not delivery-typed, when the
 *  delivery address hasn't been enriched yet, or when geocoding
 *  failed. */
export async function queryDeliveryOrderCountByZone(args: MetricQueryArgs): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { from, to, truncUnit, buckets } = resolveWindow(args)
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => {
      const row: Record<string, string | number | null> = { t: b.toISOString() }
      for (const sid of ORIGIN_SERIES_IDS) row[sid] = 0
      return row as MetricRow
    })
  }
  const bucketSelect = bucketSelectExpr(truncUnit)
  const sql = `
    select ${bucketSelect} as bucket_start,
           a.county     as county,
           a.state_code as state_code,
           count(*)::numeric as value
      from sweed_orders so
      left join addresses a
        on a.id = so.delivery_address_id
       and a.geocode_status = 'ok'
     where so.dealer_id = any($1::bigint[])
       and so.pay_time >= $2 and so.pay_time < $3
       and so.fulfillment_type ~* '^delivery'
     group by bucket_start, a.county, a.state_code
  `
  const pool = getPool()
  const result = await pool.query<{
    bucket_start: string | null
    county: string | null
    state_code: string | null
    value: string | null
  }>(sql, [dealerIds, from.toISOString(), to.toISOString()])
  const data = new Map<string, Map<string, number>>()
  for (const row of result.rows) {
    const bucketKey =
      truncUnit === null
        ? buckets[0]!.toISOString()
        : row.bucket_start
          ? new Date(row.bucket_start).toISOString()
          : null
    if (bucketKey === null) continue
    const sid = bucketForAddress(row.county, row.state_code)
    let inner = data.get(bucketKey)
    if (!inner) {
      inner = new Map()
      data.set(bucketKey, inner)
    }
    const num = row.value === null ? 0 : Number(row.value)
    inner.set(sid, (inner.get(sid) ?? 0) + (Number.isFinite(num) ? num : 0))
  }
  return buckets.map((b) => {
    const inner = data.get(b.toISOString()) ?? new Map<string, number>()
    const out: Record<string, string | number | null> = { t: b.toISOString() }
    for (const sid of ORIGIN_SERIES_IDS) out[sid] = inner.get(sid) ?? 0
    return out as MetricRow
  })
}

// ============================================================================
// Essentials — header-only time-series for top-of-house revenue numbers.
//
// Three single-series metrics derived directly from sweed_orders header
// columns; no line-item math, no joins. Used both by the Essentials tab
// and the Sales & ops tab (per the operator's spec, these belong in both).
//
// Definitions (matching Sweed invoice envelope fields):
//   * Gross Sales (ex-tax, PRE-discount) = subtotal_dollars
//     [Sweed's `subtotalAmount` is the PRE-discount, pre-tax list
//     total. Verified against live data 2026-06-04: for every invoice
//     with a discount, grand_total = subtotal − discount + tax, which
//     only holds when `subtotal` is pre-discount. So gross sales =
//     subtotal_dollars alone — "list price before promos/discounts".]
//   * Gross Receipts (incl tax)          = grand_total_dollars
//   * Net Sales (ex-tax, POST-discount)  = subtotal_dollars − discount_dollars
//     [Gross sales minus promos/discounts; still excludes tax.]
//
// NOTE (2026-06-04): the pre-2026-06-04 code had this backwards — it
// assumed `subtotalAmount` was post-discount, so it reported gross =
// subtotal+discount (double-counting the discount) and net = subtotal
// (= the gross/list value). Both are corrected here. Discounts are
// rare (~0.2% of orders) so historical charts barely move, but the
// definitions are now right.
// ============================================================================

async function querySingleSumPerBucket(
  args: MetricQueryArgs,
  seriesId: string,
  sumExpr: string,
): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { from, to, truncUnit, buckets } = resolveWindow(args)
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => ({ t: b.toISOString(), [seriesId]: 0 } as MetricRow))
  }
  const bucketSelect = bucketSelectExpr(truncUnit)
  const sql = `
    select ${bucketSelect} as bucket_start,
           '${seriesId}'::text as series_id,
           coalesce(${sumExpr}, 0)::numeric as value
      from sweed_orders
     where dealer_id = any($1::bigint[])
       and pay_time >= $2 and pay_time < $3
     group by 1
  `
  return runBucketedQuery({
    sql,
    params: [dealerIds, from.toISOString(), to.toISOString()],
    seriesIds: [seriesId],
    buckets,
    defaultValue: 0,
    collapseToSingleBucket: truncUnit === null,
  })
}

/** essentials.gross_sales — sum(subtotal) per bucket: pre-tax, PRE-discount list price. */
export function queryGrossSalesDollars(args: MetricQueryArgs): Promise<MetricRow[]> {
  return querySingleSumPerBucket(
    args,
    'gross_sales',
    'sum(coalesce(subtotal_dollars, 0))',
  )
}

/** essentials.gross_receipts — sum(grand_total) per bucket, incl. tax. */
export function queryGrossReceiptsDollars(args: MetricQueryArgs): Promise<MetricRow[]> {
  return querySingleSumPerBucket(
    args,
    'gross_receipts',
    'sum(coalesce(grand_total_dollars, 0))',
  )
}

/** essentials.net_sales — sum(subtotal − discount) per bucket: pre-tax, POST-discount. */
export function queryNetSalesDollars(args: MetricQueryArgs): Promise<MetricRow[]> {
  return querySingleSumPerBucket(
    args,
    'net_sales',
    'sum(coalesce(subtotal_dollars, 0) - coalesce(discount_dollars, 0))',
  )
}
