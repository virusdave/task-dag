import type { MetricAggregation } from '../../../shared/contracts/index.js'
import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  HELIOS_SITE_ZIP_BY_DEALER,
  type HeliosPendingPurchaseSiteDealer,
} from '../../../shared/contracts/index.js'
import { bucketSelectExpr } from '../bucketSelectSql.js'
import { getPool } from '../../db/pool.js'
import { advanceBucketStart, defaultWindow, walkBuckets } from '../timeBuckets.js'
import type { MetricQueryArgs, MetricRow } from '../types.js'
import { orderItemsCatalogFilterSql } from './catalogFilterSql.js'
import {
  FIRST_TIME_SERIES_EXPR,
  FULFILLMENT_SERIES_SQL_EXPR_SO,
} from './sweedOrdersQueries.js'

// ============================================================================
// Real-data SQL helpers for the COGS / margin / inventory metric stubs
// that depend on the sweed_package_snapshots table (issue #24).
//
// Pattern matches sweedOrdersQueries.ts exactly:
//   * Bucket grain comes from args.agg; categorical aggs collapse to
//     a single bucket via `collapseToSingleBucket` style merge.
//   * Sites resolved against the in-process dealer registry — never
//     splice into SQL.
//   * `defaultWindow` for missing from/to.
//   * Missing buckets default to 0 (counts / dollars) or null (ratios).
//
// COGS join: for each invoice line in sweed_orders.raw_json->'items'[]
// we look up the package's wholesale cost via
// `sweed_package_cost_as_of_or_earliest(dealer, inventory_item_id,
// pay_time)`. The "_or_earliest" variant falls back to the earliest
// snapshot when no snapshot exists with observed_at_min <= pay_time —
// the snapshot worker only began running 2026-05-26 and otherwise the
// trailing-30-day window would have <1% coverage.
//
// All line-item categories are derived from the live
// `item->'productCategory'->>'name'` field (not from the per-package
// snapshot row, where category_id is currently null on every row).
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

// `bucketSelectExpr` is imported from ../bucketSelectSql.js — the
// shared NY-day / UTC-hour convention every helios metrics query uses.

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

/**
 * Inventory metrics report "snapshot state observed AT or before the
 * END of the bucket" — so a daily bucket at `2026-05-26T04:00:00Z`
 * (NY midnight) needs the latest snapshot seen in [start, end).
 *
 * `advanceBucketStart` does the NY-calendar-aware step (correct across
 * DST: a spring-forward day is 23 elapsed hours, a fall-back day is
 * 25). The final bucket is clamped to `now()` by the caller below.
 */
function bucketEndForAgg(start: Date, agg: MetricAggregation): Date {
  return advanceBucketStart(start, agg)
}

function bucketEndsForBuckets(buckets: Date[], agg: MetricAggregation): Date[] {
  const now = Date.now()
  return buckets.map((b) => {
    const naturalEnd = bucketEndForAgg(b, agg)
    return new Date(Math.min(naturalEnd.getTime(), now))
  })
}

// ----- Series taxonomies (mirror the existing sweedOrdersQueries) -----

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

const INVENTORY_CATEGORY_SERIES_IDS = [
  'flower',
  'preroll',
  'edible',
  'vape',
  'concentrate',
  'accessory',
] as const

// Identity mapping — the FULFILLMENT_SERIES_SQL_EXPR_SO expression
// imported from sweedOrdersQueries emits the canonical series id
// directly (including the per-payment-method prepaid/COD/pickup-prepaid
// split), so JS-side bucketing is just a passthrough.
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

// ============================================================================
// Margin / COGS metrics
// ============================================================================

interface MarginBucketRow {
  bucket_start: string | Date | null
  series_id: string | null
  revenue: string | null
  cogs: string | null
}

/**
 * Run a (bucket, series) -> { revenue, cogs } query and shape the
 * result with `aggregator(revenue, cogs)`. `seriesIds` is the
 * universe to fill into; any (bucket, series) not produced by SQL
 * gets `defaultValue`.
 */
async function runMarginBucketedQuery(args: {
  sql: string
  params: unknown[]
  seriesIds: readonly string[]
  buckets: Date[]
  defaultValue: number | null
  collapseToSingleBucket: boolean
  /** Map (revenue, cogs) -> per-bucket-per-series numeric output. */
  aggregator: (revenue: number, cogs: number) => number | null
}): Promise<MetricRow[]> {
  const pool = getPool()
  const result = await pool.query<MarginBucketRow>(args.sql, args.params)
  const data = new Map<string, Map<string, { revenue: number; cogs: number }>>()
  for (const row of result.rows) {
    const bucketKey = args.collapseToSingleBucket
      ? args.buckets[0]!.toISOString()
      : row.bucket_start
        ? new Date(row.bucket_start).toISOString()
        : null
    if (bucketKey === null) continue
    const sid = row.series_id ?? '_unknown'
    let inner = data.get(bucketKey)
    if (!inner) {
      inner = new Map()
      data.set(bucketKey, inner)
    }
    const revenue = row.revenue === null ? 0 : Number(row.revenue)
    const cogs = row.cogs === null ? 0 : Number(row.cogs)
    const prev = inner.get(sid) ?? { revenue: 0, cogs: 0 }
    inner.set(sid, {
      revenue: prev.revenue + (Number.isFinite(revenue) ? revenue : 0),
      cogs: prev.cogs + (Number.isFinite(cogs) ? cogs : 0),
    })
  }
  return args.buckets.map((b) => {
    const inner = data.get(b.toISOString()) ?? new Map<string, { revenue: number; cogs: number }>()
    const out: Record<string, string | number | null> = { t: b.toISOString() }
    for (const sid of args.seriesIds) {
      const cell = inner.get(sid)
      if (cell === undefined) {
        out[sid] = args.defaultValue
      } else {
        out[sid] = args.aggregator(cell.revenue, cell.cogs)
      }
    }
    return out as MetricRow
  })
}

/** Canceled line items are voided sales — they must NEVER contribute
 *  revenue, qty, or COGS to any margin / velocity / sell-through
 *  metric. Sweed's per-LINE status lives at
 *  `raw_item.invoiceItemStatus.name`; a voided line reads 'Canceled'
 *  (note: the differently-spelled order-level status is 'Cancelled').
 *  Canceled lines DO carry a non-zero `subtotalAmount` (and sometimes
 *  qty) in Sweed's order-list feed, so without this guard they
 *  inflated revenue and (when qty was present) COGS. Case-insensitive
 *  for safety against Sweed taxonomy drift. */
export const NON_CANCELED_LINE_SQL = `lower(coalesce(f.raw_item->'invoiceItemStatus'->>'name', '')) <> 'canceled'`

/** Helper: per-line revenue / qty / COGS expressions over the
 *  materialised sweed_order_items_flat table (alias `f`), D1.
 *
 *   - REVENUE_EXPR: f.revenue (item->>'subtotalAmount'), 0 for canceled lines
 *   - QTY_EXPR:     f.qty     (item->>'currentQty'),     0 for canceled lines
 *   - COGS_EXPR:    qty * cost_as_of_or_earliest()
 *
 * Canceled lines are zeroed (not WHERE-filtered) so every downstream
 * query gets the exclusion centrally without each having to carry the
 * predicate — see NON_CANCELED_LINE_SQL.
 *
 * Every query below selects from `sweed_order_items_flat f` (joining
 * `sweed_orders so` only when it also needs order-level columns such as
 * so.customer_id / so.fulfillment_type / so.payment_method, which are
 * NOT in the flat table). Each metric query builds a
 * `select bucket_start, series_id, sum(revenue), sum(cogs)` around these.
 */
export const REVENUE_EXPR = `(case when ${NON_CANCELED_LINE_SQL} then f.revenue else 0 end)`
export const QTY_EXPR = `(case when ${NON_CANCELED_LINE_SQL} then f.qty else 0 end)`
export const COGS_EXPR = `${QTY_EXPR} * coalesce(sweed_package_cost_as_of_or_earliest(f.dealer_id, f.inventory_item_id, f.pay_time), 0)`

/** margins.gross_margin_dollars — sum(revenue - cogs) per bucket. */
export async function queryGrossMarginDollars(args: MetricQueryArgs): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { from, to, truncUnit, buckets } = resolveWindow(args)
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => ({ t: b.toISOString(), gm_dollars: 0 }))
  }
  const cf = orderItemsCatalogFilterSql(args, 4)
  const sql = `
    ${cf.withPrefix}
    select ${bucketSelectExpr(truncUnit, 'f.pay_time')} as bucket_start,
           'gm_dollars' as series_id,
           sum(${REVENUE_EXPR})::numeric as revenue,
           sum(${COGS_EXPR})::numeric as cogs
      from sweed_order_items_flat f
           ${cf.joinClause}
     where f.dealer_id = any($1::bigint[])
       and f.pay_time >= $2 and f.pay_time < $3
       ${cf.whereClause}
     group by 1
  `
  return runMarginBucketedQuery({
    sql,
    params: [dealerIds, from.toISOString(), to.toISOString(), ...cf.params],
    seriesIds: ['gm_dollars'],
    buckets,
    defaultValue: 0,
    collapseToSingleBucket: truncUnit === null,
    aggregator: (revenue, cogs) => round2(revenue - cogs),
  })
}

/** margins.effective_gm_pct — sum(revenue - cogs) / sum(revenue) per bucket.
 *  Line items without a known wholesale cost are excluded from BOTH
 *  numerator and denominator (per stub description). */
export async function queryEffectiveGmPct(args: MetricQueryArgs): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { from, to, truncUnit, buckets } = resolveWindow(args)
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => ({ t: b.toISOString(), gm_pct: null }))
  }
  const cf = orderItemsCatalogFilterSql(args, 4)
  const sql = `
    ${cf.withPrefix}
    select ${bucketSelectExpr(truncUnit, 'f.pay_time')} as bucket_start,
           'gm_pct' as series_id,
           sum(case when sweed_package_cost_as_of_or_earliest(f.dealer_id, f.inventory_item_id, f.pay_time) is not null
                    then ${REVENUE_EXPR} else 0 end)::numeric as revenue,
           sum(case when sweed_package_cost_as_of_or_earliest(f.dealer_id, f.inventory_item_id, f.pay_time) is not null
                    then ${COGS_EXPR} else 0 end)::numeric as cogs
      from sweed_order_items_flat f
           ${cf.joinClause}
     where f.dealer_id = any($1::bigint[])
       and f.pay_time >= $2 and f.pay_time < $3
       ${cf.whereClause}
     group by 1
  `
  return runMarginBucketedQuery({
    sql,
    params: [dealerIds, from.toISOString(), to.toISOString(), ...cf.params],
    seriesIds: ['gm_pct'],
    buckets,
    defaultValue: null,
    collapseToSingleBucket: truncUnit === null,
    aggregator: (revenue, cogs) => (revenue > 0 ? round4((revenue - cogs) / revenue) : null),
  })
}

/** margins.stack_new_vs_returning — gross margin $ stacked by whether
 *  THIS PURCHASE was the customer's first ever purchase
 *  (per-purchase yes/no, not per-customer dedupe). Guests counted as
 *  returning. */
export async function queryMarginStackNewVsReturning(args: MetricQueryArgs): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { from, to, truncUnit, buckets } = resolveWindow(args)
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => ({ t: b.toISOString(), first_time: 0, returning: 0 }))
  }
  const cf = orderItemsCatalogFilterSql(args, 4)
  const sql = `
    ${cf.withPrefix}
    select ${bucketSelectExpr(truncUnit, 'f.pay_time')} as bucket_start,
           ${FIRST_TIME_SERIES_EXPR} as series_id,
           sum(${REVENUE_EXPR})::numeric as revenue,
           sum(${COGS_EXPR})::numeric as cogs
      from sweed_order_items_flat f
           join sweed_orders so
             on so.dealer_id = f.dealer_id and so.invoice_id = f.invoice_id
           ${cf.joinClause}
     where f.dealer_id = any($1::bigint[])
       and f.pay_time >= $2 and f.pay_time < $3
       ${cf.whereClause}
     group by 1, 2
  `
  return runMarginBucketedQuery({
    sql,
    params: [dealerIds, from.toISOString(), to.toISOString(), ...cf.params],
    seriesIds: ['first_time', 'returning'],
    buckets,
    defaultValue: 0,
    collapseToSingleBucket: truncUnit === null,
    aggregator: (revenue, cogs) => round2(revenue - cogs),
  })
}

// Tristate area = NY / NJ / CT. A line item's customer region is
// resolved from a customer's geocoded address, trying three sources
// in priority order:
//
//   1. scan  — the address on the customer's scanned government ID,
//      via visitor_scan_links (link_status='linked') → visitor_scans
//      → addresses. This is the ONLY source currently carrying real
//      geocoded data for live orders (verified 2026-06-09), because…
//   2. prim  — the Sweed customer-profile primary address
//      (sweed_customer_addresses kind='primary' → addresses). The A5
//      enrichment presently links almost every recent customer to the
//      empty-address sentinel (geocode_status='not_us'), so this
//      resolves to NULL in practice today, but is kept so the metric
//      lights up automatically if/when that pipeline is fixed.
//   3. deliv — the order's delivery address. Also ~unpopulated on
//      recent orders today; kept for the same forward-compat reason.
//
// An order is classified 'far' ONLY when we positively resolved a
// state OUTSIDE the tristate area; an unknown / un-geocoded address
// falls back to 'tri'. That conservative default mirrors the "guests
// count as returning" convention elsewhere in these stacks — we don't
// claim a customer is "far" without a resolved out-of-area address, so
// the far bucket stays a high-confidence "we KNOW this person is out
// of the tristate" signal rather than a dumping ground for the (large)
// set of orders whose address never resolved.
const RESOLVED_STATE_SQL = `coalesce(scan.state_code, prim.state_code, deliv.state_code)`
const TRISTATE_REGION_EXPR = `
  case
    when ${RESOLVED_STATE_SQL} is not null
     and upper(btrim(${RESOLVED_STATE_SQL})) not in ('NY', 'NJ', 'CT')
    then 'far'
    else 'tri'
  end
`
// Combine the first-time/returning pin with the tristate region into
// one of THREE series ids: new_local / return_local / far.
//
// We deliberately do NOT cross new/returning with the far region: the
// old four-bucket split (new_far vs return_far) added noise without
// signal — the out-of-tristate population is small and its new/returning
// breakdown wasn't actionable. So everything we positively resolve as
// 'far' collapses into a single "far" series, and the new/returning pin
// only distinguishes the (local) tristate orders.
const NEW_VS_RETURNING_REGION_SERIES_EXPR = `
  case
    when (${TRISTATE_REGION_EXPR}) = 'far' then 'far'
    when ${FIRST_TIME_SERIES_EXPR} = 'first_time' then 'new_local'
    else 'return_local'
  end
`
// Address-resolution joins shared by the region-segmented margin
// query. None take bind params, so caller param numbering is
// unaffected. `scan` is the working source today; `prim` mirrors
// queryCustomerOriginMap; `deliv` is the order's delivery address.
const CUSTOMER_REGION_ADDRESS_JOINS = `
  left join lateral (
    select a.state_code
      from visitor_scan_links vsl
      join visitor_scans vs on vs.id = vsl.scan_id
      join addresses a on a.id = vs.address_id
     where vsl.dealer_id = so.dealer_id
       and vsl.sweed_customer_id = so.customer_id
       and vsl.link_status = 'linked'
       and a.geocode_status = 'ok'
     limit 1
  ) scan on so.customer_id is not null
  left join lateral (
    select a.state_code
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
`

/** margins.stack_new_vs_returning_region — gross margin $ stacked into
 *  THREE series: new (local) / return (local) / far. The first-time/
 *  returning pin (same as margins.stack_new_vs_returning) is applied
 *  only to LOCAL (tristate NY/NJ/CT) orders; every order we positively
 *  resolve as out-of-tristate collapses into a single 'far' series
 *  (the old new_far vs return_far split was noise). Customer region is
 *  resolved from the scanned-ID (VeriScan) address first, then the Sweed
 *  profile primary, then the order delivery address (see
 *  CUSTOMER_REGION_ADDRESS_JOINS); unknown/un-geocoded → local (see
 *  TRISTATE_REGION_EXPR comment). */
export async function queryMarginStackNewVsReturningByRegion(
  args: MetricQueryArgs,
): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { from, to, truncUnit, buckets } = resolveWindow(args)
  const seriesIds = ['new_local', 'return_local', 'far'] as const
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => {
      const row: Record<string, string | number | null> = { t: b.toISOString() }
      for (const sid of seriesIds) row[sid] = 0
      return row as MetricRow
    })
  }
  const cf = orderItemsCatalogFilterSql(args, 4)
  const sql = `
    ${cf.withPrefix}
    select ${bucketSelectExpr(truncUnit, 'f.pay_time')} as bucket_start,
           ${NEW_VS_RETURNING_REGION_SERIES_EXPR} as series_id,
           sum(${REVENUE_EXPR})::numeric as revenue,
           sum(${COGS_EXPR})::numeric as cogs
      from sweed_order_items_flat f
           join sweed_orders so
             on so.dealer_id = f.dealer_id and so.invoice_id = f.invoice_id
           ${CUSTOMER_REGION_ADDRESS_JOINS}
           ${cf.joinClause}
     where f.dealer_id = any($1::bigint[])
       and f.pay_time >= $2 and f.pay_time < $3
       ${cf.whereClause}
     group by 1, 2
  `
  return runMarginBucketedQuery({
    sql,
    params: [dealerIds, from.toISOString(), to.toISOString(), ...cf.params],
    seriesIds: [...seriesIds],
    buckets,
    defaultValue: 0,
    collapseToSingleBucket: truncUnit === null,
    aggregator: (revenue, cogs) => round2(revenue - cogs),
  })
}

/** category.margin_dollars_stack — gross margin $ stacked by
 *  product category. */
export async function queryCategoryMarginStack(args: MetricQueryArgs): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { from, to, truncUnit, buckets } = resolveWindow(args)
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => {
      const row: Record<string, string | number | null> = { t: b.toISOString() }
      for (const sid of CATEGORY_SERIES_IDS) row[sid] = 0
      return row as MetricRow
    })
  }
  const cf = orderItemsCatalogFilterSql(args, 4)
  const sql = `
    ${cf.withPrefix}
    select ${bucketSelectExpr(truncUnit, 'f.pay_time')} as bucket_start,
           coalesce(lower(f.product_category_name), '') as cat_value,
           sum(${REVENUE_EXPR})::numeric as revenue,
           sum(${COGS_EXPR})::numeric as cogs
      from sweed_order_items_flat f
           ${cf.joinClause}
     where f.dealer_id = any($1::bigint[])
       and f.pay_time >= $2 and f.pay_time < $3
       ${cf.whereClause}
     group by 1, 2
  `
  const pool = getPool()
  const result = await pool.query<{ bucket_start: string | Date | null; cat_value: string | null; revenue: string | null; cogs: string | null }>(
    sql,
    [dealerIds, from.toISOString(), to.toISOString(), ...cf.params],
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
    const canonical = (row.cat_value ?? '').trim().toLowerCase()
    const sid = CATEGORY_SERIES_BY_VALUE.get(canonical) ?? 'other'
    const revenue = row.revenue === null ? 0 : Number(row.revenue)
    const cogs = row.cogs === null ? 0 : Number(row.cogs)
    const margin = (Number.isFinite(revenue) ? revenue : 0) - (Number.isFinite(cogs) ? cogs : 0)
    let inner = data.get(bucketKey)
    if (!inner) {
      inner = new Map()
      data.set(bucketKey, inner)
    }
    inner.set(sid, (inner.get(sid) ?? 0) + margin)
  }
  return buckets.map((b) => {
    const inner = data.get(b.toISOString()) ?? new Map<string, number>()
    const out: Record<string, string | number | null> = { t: b.toISOString() }
    for (const sid of CATEGORY_SERIES_IDS) out[sid] = round2(inner.get(sid) ?? 0)
    return out as MetricRow
  })
}

/** fulfillment.margin_dollars — gross margin $ stacked by fulfillment type. */
export async function queryFulfillmentMarginDollars(args: MetricQueryArgs): Promise<MetricRow[]> {
  return queryFulfillmentMargin(args, 'dollars')
}

/** fulfillment.effective_gm_pct — gross margin % per bucket by fulfillment. */
export async function queryFulfillmentEffectiveGmPct(args: MetricQueryArgs): Promise<MetricRow[]> {
  return queryFulfillmentMargin(args, 'pct')
}

async function queryFulfillmentMargin(
  args: MetricQueryArgs,
  mode: 'dollars' | 'pct',
): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { from, to, truncUnit, buckets } = resolveWindow(args)
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => {
      const row: Record<string, string | number | null> = { t: b.toISOString() }
      for (const sid of FULFILLMENT_SERIES_IDS) row[sid] = mode === 'dollars' ? 0 : null
      return row as MetricRow
    })
  }
  const isPct = mode === 'pct'
  const cf = orderItemsCatalogFilterSql(args, 4)
  const sql = `
    ${cf.withPrefix}
    select ${bucketSelectExpr(truncUnit, 'f.pay_time')} as bucket_start,
           coalesce(${FULFILLMENT_SERIES_SQL_EXPR_SO}, '') as fulfillment_value,
           sum(${isPct ? `case when sweed_package_cost_as_of_or_earliest(f.dealer_id, f.inventory_item_id, f.pay_time) is not null then ${REVENUE_EXPR} else 0 end` : REVENUE_EXPR})::numeric as revenue,
           sum(${isPct ? `case when sweed_package_cost_as_of_or_earliest(f.dealer_id, f.inventory_item_id, f.pay_time) is not null then ${COGS_EXPR} else 0 end` : COGS_EXPR})::numeric as cogs
      from sweed_order_items_flat f
           join sweed_orders so
             on so.dealer_id = f.dealer_id and so.invoice_id = f.invoice_id
           ${cf.joinClause}
     where f.dealer_id = any($1::bigint[])
       and f.pay_time >= $2 and f.pay_time < $3
       ${cf.whereClause}
     group by 1, 2
  `
  const pool = getPool()
  const result = await pool.query<{ bucket_start: string | Date | null; fulfillment_value: string | null; revenue: string | null; cogs: string | null }>(
    sql,
    [dealerIds, from.toISOString(), to.toISOString(), ...cf.params],
  )
  const data = new Map<string, Map<string, { revenue: number; cogs: number }>>()
  for (const row of result.rows) {
    const bucketKey =
      truncUnit === null
        ? buckets[0]!.toISOString()
        : row.bucket_start
          ? new Date(row.bucket_start).toISOString()
          : null
    if (bucketKey === null) continue
    const canonical = (row.fulfillment_value ?? '').trim().toLowerCase()
    const sid = FULFILLMENT_SERIES_BY_VALUE.get(canonical) ?? 'in_store'
    const revenue = row.revenue === null ? 0 : Number(row.revenue)
    const cogs = row.cogs === null ? 0 : Number(row.cogs)
    let inner = data.get(bucketKey)
    if (!inner) {
      inner = new Map()
      data.set(bucketKey, inner)
    }
    const prev = inner.get(sid) ?? { revenue: 0, cogs: 0 }
    inner.set(sid, {
      revenue: prev.revenue + (Number.isFinite(revenue) ? revenue : 0),
      cogs: prev.cogs + (Number.isFinite(cogs) ? cogs : 0),
    })
  }
  return buckets.map((b) => {
    const inner = data.get(b.toISOString()) ?? new Map<string, { revenue: number; cogs: number }>()
    const out: Record<string, string | number | null> = { t: b.toISOString() }
    for (const sid of FULFILLMENT_SERIES_IDS) {
      const cell = inner.get(sid)
      if (cell === undefined) {
        out[sid] = mode === 'dollars' ? 0 : null
      } else if (mode === 'dollars') {
        out[sid] = round2(cell.revenue - cell.cogs)
      } else {
        out[sid] = cell.revenue > 0 ? round4((cell.revenue - cell.cogs) / cell.revenue) : null
      }
    }
    return out as MetricRow
  })
}

// ============================================================================
// Inventory metrics — back from sweed_package_current view.
//
// These are "snapshot at the latest bucket" metrics; the per-bucket
// time series projects the on-hand state observed on (or just before)
// each bucket end. Because snapshots are append-only with
// observed_at_min start times, we approximate the historical bucket
// state by selecting the per-package row with the latest
// observed_at_min <= bucket_end. For backfill / pre-snapshot buckets
// this falls through to the earliest known row (same as the
// _or_earliest variant of the cost function).
// ============================================================================

/**
 * inventory.cost_distribution — stacked on-hand inventory cost $
 * by top-level category at each bucket end. We approximate "as-of
 * bucket end" via the latest snapshot whose observed_at_max <=
 * bucket_end. For categories we have to fall back to a lookup
 * against the flattened order lines (sweed_order_items_flat, D1 —
 * the materialised sweed_orders.raw_json->'items' expansion), since
 * sweed_package_snapshots stores category_id as null in v1 — packages
 * that never appeared in any order line land in "other".
 */
export async function queryInventoryCostDistribution(args: MetricQueryArgs): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { buckets } = resolveWindow(args)
  const bucketEnds = bucketEndsForBuckets(buckets, args.agg)
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => {
      const row: Record<string, string | number | null> = { t: b.toISOString() }
      for (const sid of INVENTORY_CATEGORY_SERIES_IDS) row[sid] = 0
      return row as MetricRow
    })
  }
  // Build the per-package category lookup once (most-recent observed
  // category from sweed_orders line items per inventory_item_id) and
  // then iterate buckets, issuing one distinct-on snapshot lookup per
  // bucket end. Each lookup is O(snapshots) and uses the snapshot
  // primary key so the total cost stays linear in (buckets × packages).
  const pool = getPool()
  // Step 1: per-package category lookup. When catalog filters are
  // active, narrow the eligible package universe at this step (rather
  // than per-bucket inside the snapshot loop) so the bucket queries
  // remain cheap and parallel. Packages whose productId is not in the
  // filtered catalog mapping simply drop out of categoryByPackage and
  // therefore contribute nothing to any bucket's series sums.
  const cf = orderItemsCatalogFilterSql(args, 2)
  const perPackageCategorySql = `
    ${cf.withPrefix}
    select distinct on (f.dealer_id, f.inventory_item_id)
           f.dealer_id,
           f.inventory_item_id as inventory_item_id,
           lower(coalesce(f.product_category_name, '')) as category_value
      from sweed_order_items_flat f
           ${cf.joinClause}
     where f.dealer_id = any($1::bigint[])
       and f.inventory_item_id is not null
       ${cf.whereClause}
     order by f.dealer_id, f.inventory_item_id, f.pay_time desc
  `
  const catResult = await pool.query<{ dealer_id: string; inventory_item_id: string; category_value: string }>(
    perPackageCategorySql,
    [dealerIds, ...cf.params],
  )
  const categoryByPackage = new Map<string, string>()
  for (const row of catResult.rows) {
    const canonical = (row.category_value ?? '').trim().toLowerCase()
    const sid = CATEGORY_SERIES_BY_VALUE.get(canonical) ?? 'other'
    if (INVENTORY_CATEGORY_SERIES_IDS.includes(sid as (typeof INVENTORY_CATEGORY_SERIES_IDS)[number])) {
      categoryByPackage.set(`${row.dealer_id}:${row.inventory_item_id}`, sid)
    }
  }

  // Step 2: for each bucket end, get every package's latest snapshot
  // up to that bucket end, sum qty * cost grouped by category.
  // We issue one query per bucket end — typically <= 90 — and merge
  // the results in JS. Each query is O(snapshots) and uses the
  // (dealer_id, inventory_item_id, observed_at_min DESC) primary key
  // for fast distinct-on. Queries are issued in parallel and capped
  // by the pg pool's connection limit; per-bucket order is preserved
  // because we await the Promise.all in index order.
  const snapSql = `
    select distinct on (dealer_id, inventory_item_id)
           dealer_id::text as dealer_id,
           inventory_item_id,
           current_qty,
           wholesale_cost_dollars
      from sweed_package_snapshots
     where dealer_id = any($1::bigint[])
       and observed_at_min <= $2
     order by dealer_id, inventory_item_id, observed_at_min desc
  `
  const snapResults = await Promise.all(
    buckets.map((_, i) =>
      pool.query<{ dealer_id: string; inventory_item_id: string; current_qty: string | null; wholesale_cost_dollars: string | null }>(
        snapSql,
        [dealerIds, bucketEnds[i]!.toISOString()],
      ),
    ),
  )
  const out: MetricRow[] = []
  for (let i = 0; i < buckets.length; i++) {
    const bucketStartIso = buckets[i]!.toISOString()
    const snapResult = snapResults[i]!
    const byCategory = new Map<string, number>()
    for (const row of snapResult.rows) {
      const qty = row.current_qty === null ? 0 : Number(row.current_qty)
      const cost = row.wholesale_cost_dollars === null ? 0 : Number(row.wholesale_cost_dollars)
      if (!Number.isFinite(qty) || !Number.isFinite(cost) || qty <= 0) continue
      const sid = categoryByPackage.get(`${row.dealer_id}:${row.inventory_item_id}`)
      if (sid === undefined) continue // package never observed in any order → skip
      byCategory.set(sid, (byCategory.get(sid) ?? 0) + qty * cost)
    }
    const row: Record<string, string | number | null> = { t: bucketStartIso }
    for (const sid of INVENTORY_CATEGORY_SERIES_IDS) {
      row[sid] = round2(byCategory.get(sid) ?? 0)
    }
    out.push(row as MetricRow)
  }
  return out
}

/**
 * inventory.misalignment — single "signed deviation" series per
 * bucket. Stub spec: diverging bar at the latest bucket of
 * `(on_hand_cost / 30d_cogs_run_rate) - target_ratio`. Real-data
 * v1 emits the AGGREGATE deviation per bucket (sum of positive
 * deviations - sum of negative deviations across all packages), so
 * the chart shows whether the overall stock position is over or
 * under the target burn-rate. A future enhancement can break out
 * per-SKU rows.
 *
 * target_ratio is the operator's "carry ~21 days of supply"
 * default. The bucket end snapshot supplies on-hand cost; the 30-day
 * COGS run rate is computed per package against the trailing-30-day
 * sales window ending at each bucket.
 */
export async function queryInventoryMisalignment(args: MetricQueryArgs): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { buckets } = resolveWindow(args)
  const bucketEnds = bucketEndsForBuckets(buckets, args.agg)
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => ({ t: b.toISOString(), deviation: 0 }))
  }
  // Target supply: 21 days at current run rate (per stub spec).
  const TARGET_DAYS = 21
  const pool = getPool()
  // Per-package: on-hand cost as of bucket_end, and trailing-30d
  // run-rate cost (sum cogs / 30) computed against sweed_orders.
  // Queries are issued in parallel; order is preserved by index.
  const sql = `
    with snap as (
      select distinct on (dealer_id, inventory_item_id)
             dealer_id, inventory_item_id,
             coalesce(current_qty, 0) * coalesce(wholesale_cost_dollars, 0) as on_hand_cost
        from sweed_package_snapshots
       where dealer_id = any($1::bigint[])
         and observed_at_min <= $2::timestamptz
       order by dealer_id, inventory_item_id, observed_at_min desc
    ),
    run_rate as (
      select f.dealer_id,
             f.inventory_item_id as inventory_item_id,
             sum(${QTY_EXPR} * coalesce(sweed_package_cost_as_of_or_earliest(f.dealer_id, f.inventory_item_id, f.pay_time), 0)) / 30.0
               as daily_cogs
        from sweed_order_items_flat f
       where f.dealer_id = any($1::bigint[])
         and f.pay_time >= $2::timestamptz - interval '30 days'
         and f.pay_time < $2::timestamptz
         and f.inventory_item_id is not null
       group by f.dealer_id, f.inventory_item_id
    )
    select sum(case
                 when rr.daily_cogs is null or rr.daily_cogs <= 0
                   then 0
                 else (snap.on_hand_cost / rr.daily_cogs) - $3::numeric
               end) as deviation_total,
           count(*) as packages
      from snap
      left join run_rate rr
        on rr.dealer_id = snap.dealer_id
       and rr.inventory_item_id = snap.inventory_item_id
     where snap.on_hand_cost > 0
  `
  const results = await Promise.all(
    buckets.map((_, i) =>
      pool.query<{ deviation_total: string | null; packages: string }>(
        sql,
        [dealerIds, bucketEnds[i]!.toISOString(), String(TARGET_DAYS)],
      ),
    ),
  )
  const out: MetricRow[] = []
  for (let i = 0; i < buckets.length; i++) {
    const bucketStartIso = buckets[i]!.toISOString()
    const row0 = results[i]!.rows[0]
    const dev = row0?.deviation_total === null || row0?.deviation_total === undefined ? 0 : Number(row0.deviation_total)
    const pkg = row0 ? Number(row0.packages) : 0
    const avgDev = pkg > 0 ? dev / pkg : 0
    out.push({ t: bucketStartIso, deviation: round4(avgDev) })
  }
  return out
}

/**
 * slowmovers.cost_at_risk — aggregate cost-at-risk $ per bucket.
 * v1 implementation: SUM(on_hand_cost) over packages where the
 * trailing-30d sell-through is zero (no orders sold this package in
 * the trailing 30 days ending at bucket_end) OR the package is
 * within 30 days of its expiration date.
 */
export async function querySlowmoversCostAtRisk(args: MetricQueryArgs): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { buckets } = resolveWindow(args)
  const bucketEnds = bucketEndsForBuckets(buckets, args.agg)
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => ({ t: b.toISOString(), cost_at_risk_dollars: 0 }))
  }
  const pool = getPool()
  const sql = `
    with snap as (
      select distinct on (dealer_id, inventory_item_id)
             dealer_id, inventory_item_id,
             coalesce(current_qty, 0) * coalesce(wholesale_cost_dollars, 0) as on_hand_cost,
             expiration_date
        from sweed_package_snapshots
       where dealer_id = any($1::bigint[])
         and observed_at_min <= $2::timestamptz
       order by dealer_id, inventory_item_id, observed_at_min desc
    ),
    recent_sales as (
      select f.dealer_id, f.inventory_item_id as inventory_item_id, sum(${QTY_EXPR}) as qty_sold
        from sweed_order_items_flat f
       where f.dealer_id = any($1::bigint[])
         and f.pay_time >= $2::timestamptz - interval '30 days'
         and f.pay_time < $2::timestamptz
         and f.inventory_item_id is not null
       group by 1, 2
    )
    select coalesce(sum(snap.on_hand_cost) filter (
             where (rs.qty_sold is null or rs.qty_sold = 0)
                or (snap.expiration_date is not null
                    and snap.expiration_date <= ($2::timestamptz + interval '30 days')::date)
           ), 0) as cost_at_risk
      from snap
      left join recent_sales rs
        on rs.dealer_id = snap.dealer_id
       and rs.inventory_item_id = snap.inventory_item_id
     where snap.on_hand_cost > 0
  `
  const results = await Promise.all(
    buckets.map((_, i) =>
      pool.query<{ cost_at_risk: string | null }>(sql, [dealerIds, bucketEnds[i]!.toISOString()]),
    ),
  )
  const out: MetricRow[] = []
  for (let i = 0; i < buckets.length; i++) {
    const v = results[i]!.rows[0]?.cost_at_risk === null || results[i]!.rows[0]?.cost_at_risk === undefined
      ? 0
      : Number(results[i]!.rows[0]!.cost_at_risk)
    out.push({ t: buckets[i]!.toISOString(), cost_at_risk_dollars: round2(v) })
  }
  return out
}

/**
 * lowstock.upcoming_outs — aggregate expected-margin-loss $ per
 * bucket. v1 implementation: for each package, project trailing-21d
 * daily margin rate; flag packages whose available qty / daily sell
 * rate <= 2 days; sum (2 - days_of_supply) * daily_margin across
 * flagged packages. Currently-out packages (available_qty <= 0) with
 * positive trailing-21d sales contribute (2 * daily_margin).
 */
export async function queryLowstockUpcomingOuts(args: MetricQueryArgs): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { buckets } = resolveWindow(args)
  const bucketEnds = bucketEndsForBuckets(buckets, args.agg)
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => ({ t: b.toISOString(), expected_margin_loss_dollars: 0 }))
  }
  const pool = getPool()
  const sql = `
    with snap as (
      select distinct on (dealer_id, inventory_item_id)
             dealer_id, inventory_item_id,
             coalesce(available_qty, current_qty, 0) as on_hand_qty,
             coalesce(wholesale_cost_dollars, 0) as unit_cost
        from sweed_package_snapshots
       where dealer_id = any($1::bigint[])
         and observed_at_min <= $2::timestamptz
       order by dealer_id, inventory_item_id, observed_at_min desc
    ),
    recent as (
      select f.dealer_id, f.inventory_item_id as inventory_item_id,
             sum(${QTY_EXPR}) / 21.0 as daily_qty_sold,
             sum(${REVENUE_EXPR} - ${COGS_EXPR}) / 21.0 as daily_margin
        from sweed_order_items_flat f
       where f.dealer_id = any($1::bigint[])
         and f.pay_time >= $2::timestamptz - interval '21 days'
         and f.pay_time < $2::timestamptz
         and f.inventory_item_id is not null
       group by 1, 2
    )
    select coalesce(sum(
             case
               when r.daily_qty_sold is null or r.daily_qty_sold <= 0 then 0
               when snap.on_hand_qty <= 0 then 2.0 * r.daily_margin
               when (snap.on_hand_qty / r.daily_qty_sold) <= 2.0
                 then (2.0 - (snap.on_hand_qty / r.daily_qty_sold)) * r.daily_margin
               else 0
             end
           ), 0) as expected_margin_loss
      from snap
      left join recent r
        on r.dealer_id = snap.dealer_id
       and r.inventory_item_id = snap.inventory_item_id
  `
  const results = await Promise.all(
    buckets.map((_, i) =>
      pool.query<{ expected_margin_loss: string | null }>(sql, [dealerIds, bucketEnds[i]!.toISOString()]),
    ),
  )
  const out: MetricRow[] = []
  for (let i = 0; i < buckets.length; i++) {
    const v = results[i]!.rows[0]?.expected_margin_loss === null || results[i]!.rows[0]?.expected_margin_loss === undefined
      ? 0
      : Number(results[i]!.rows[0]!.expected_margin_loss)
    out.push({ t: buckets[i]!.toISOString(), expected_margin_loss_dollars: round2(Math.max(0, v)) })
  }
  return out
}

// ============================================================================
// Inventory cost (for-sale vs not-for-sale) — Sales & ops "Inventory cost"
// section (FreshlyBakedNYC/automation: operator request 2026-06-11).
//
// "For sale" vs "not for sale" is read off the per-package
// `stock_location` text on sweed_package_snapshots. The operator's
// Sweed taxonomy prefixes the location string with "FOR SALE - …"
// (sales floor / vault / mobile vault) for sellable stock and
// "NOT FOR SALE - …" (quarantine, hold-for-inspection, samples) plus a
// handful of deprecated / junk buckets for everything else. We treat
// `stock_location ILIKE 'FOR SALE%'` as the sellable set and ALL other
// in-stock packages (NOT FOR SALE, deprecated, samples, NULL) as the
// not-for-sale set, so received-but-unlisted / quarantined cost never
// silently vanishes.
//
// "In stock" = current_qty > 0. Cost = current_qty * wholesale_cost.
// All three queries report the snapshot state as-of each bucket END
// (latest snapshot with observed_at_min <= bucket_end per package),
// matching queryInventoryCostDistribution.
// ============================================================================

/** Sum of in-stock cost split by FOR SALE vs everything else, as-of each
 *  bucket end. */
export async function queryInventoryCostForSaleSplit(args: MetricQueryArgs): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { buckets } = resolveWindow(args)
  const bucketEnds = bucketEndsForBuckets(buckets, args.agg)
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => ({ t: b.toISOString(), for_sale: 0, not_for_sale: 0 }))
  }
  const pool = getPool()
  const sql = `
    select
      coalesce(sum(cost) filter (where stock_location ilike 'FOR SALE%'), 0) as for_sale,
      coalesce(sum(cost) filter (where stock_location is null
                                    or stock_location not ilike 'FOR SALE%'), 0) as not_for_sale
      from (
        select distinct on (dealer_id, inventory_item_id)
               coalesce(current_qty, 0) * coalesce(wholesale_cost_dollars, 0) as cost,
               stock_location
          from sweed_package_snapshots
         where dealer_id = any($1::bigint[])
           and observed_at_min <= $2::timestamptz
         order by dealer_id, inventory_item_id, observed_at_min desc
      ) snap
     where snap.cost > 0
  `
  const results = await Promise.all(
    buckets.map((_, i) =>
      pool.query<{ for_sale: string | null; not_for_sale: string | null }>(sql, [
        dealerIds,
        bucketEnds[i]!.toISOString(),
      ]),
    ),
  )
  return buckets.map((b, i) => {
    const row = results[i]!.rows[0]
    return {
      t: b.toISOString(),
      for_sale: round2(row?.for_sale == null ? 0 : Number(row.for_sale)),
      not_for_sale: round2(row?.not_for_sale == null ? 0 : Number(row.not_for_sale)),
    }
  })
}

/** Per-package category lookup (most-recent observed category from the
 *  flattened order lines), honouring active catalog filters. Shared by
 *  the for-sale-by-category breakdown. Packages never seen on an order
 *  line are absent (callers treat that as unclassifiable → drop). */
async function buildCategoryByPackage(args: MetricQueryArgs, dealerIds: number[]): Promise<Map<string, string>> {
  const pool = getPool()
  const cf = orderItemsCatalogFilterSql(args, 2)
  const sql = `
    ${cf.withPrefix}
    select distinct on (f.dealer_id, f.inventory_item_id)
           f.dealer_id,
           f.inventory_item_id as inventory_item_id,
           lower(coalesce(f.product_category_name, '')) as category_value
      from sweed_order_items_flat f
           ${cf.joinClause}
     where f.dealer_id = any($1::bigint[])
       and f.inventory_item_id is not null
       ${cf.whereClause}
     order by f.dealer_id, f.inventory_item_id, f.pay_time desc
  `
  const result = await pool.query<{ dealer_id: string; inventory_item_id: string; category_value: string }>(
    sql,
    [dealerIds, ...cf.params],
  )
  const map = new Map<string, string>()
  for (const row of result.rows) {
    const canonical = (row.category_value ?? '').trim().toLowerCase()
    const sid = CATEGORY_SERIES_BY_VALUE.get(canonical) ?? 'other'
    if (INVENTORY_CATEGORY_SERIES_IDS.includes(sid as (typeof INVENTORY_CATEGORY_SERIES_IDS)[number])) {
      map.set(`${row.dealer_id}:${row.inventory_item_id}`, sid)
    }
  }
  return map
}

/** For-sale (sellable) in-stock inventory cost stacked by top-level
 *  category, as-of each bucket end. Same category derivation as
 *  inventory.cost_distribution but restricted to FOR SALE stock. */
export async function queryInventoryForSaleCostByCategory(args: MetricQueryArgs): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { buckets } = resolveWindow(args)
  const bucketEnds = bucketEndsForBuckets(buckets, args.agg)
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => {
      const row: Record<string, string | number | null> = { t: b.toISOString() }
      for (const sid of INVENTORY_CATEGORY_SERIES_IDS) row[sid] = 0
      return row as MetricRow
    })
  }
  const pool = getPool()
  const categoryByPackage = await buildCategoryByPackage(args, dealerIds)
  const snapSql = `
    select distinct on (dealer_id, inventory_item_id)
           dealer_id::text as dealer_id,
           inventory_item_id,
           current_qty,
           wholesale_cost_dollars
      from sweed_package_snapshots
     where dealer_id = any($1::bigint[])
       and observed_at_min <= $2
       and stock_location ilike 'FOR SALE%'
     order by dealer_id, inventory_item_id, observed_at_min desc
  `
  const snapResults = await Promise.all(
    buckets.map((_, i) =>
      pool.query<{ dealer_id: string; inventory_item_id: string; current_qty: string | null; wholesale_cost_dollars: string | null }>(
        snapSql,
        [dealerIds, bucketEnds[i]!.toISOString()],
      ),
    ),
  )
  const out: MetricRow[] = []
  for (let i = 0; i < buckets.length; i++) {
    const byCategory = new Map<string, number>()
    for (const row of snapResults[i]!.rows) {
      const qty = row.current_qty === null ? 0 : Number(row.current_qty)
      const cost = row.wholesale_cost_dollars === null ? 0 : Number(row.wholesale_cost_dollars)
      if (!Number.isFinite(qty) || !Number.isFinite(cost) || qty <= 0) continue
      const sid = categoryByPackage.get(`${row.dealer_id}:${row.inventory_item_id}`)
      if (sid === undefined) continue
      byCategory.set(sid, (byCategory.get(sid) ?? 0) + qty * cost)
    }
    const row: Record<string, string | number | null> = { t: buckets[i]!.toISOString() }
    for (const sid of INVENTORY_CATEGORY_SERIES_IDS) row[sid] = round2(byCategory.get(sid) ?? 0)
    out.push(row as MetricRow)
  }
  return out
}

/** Scatter family: one dot per (site, bucket). X = average daily
 *  for-sale (sellable) inventory cost during the bucket; Y = net sales
 *  $ (ex-tax, post-discount = sum subtotal_dollars) booked in the
 *  bucket. Dots only appear for (site, bucket) pairs with snapshot
 *  coverage — snapshots begin 2026-05-26, so earlier buckets have no
 *  dot. Used to eyeball whether low sellable inventory coincides with
 *  weak sales. */
export async function querySalesVsSellableInventory(args: MetricQueryArgs): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { buckets } = resolveWindow(args)
  const bucketEnds = bucketEndsForBuckets(buckets, args.agg)
  if (dealerIds.length === 0 || buckets.length === 0) return []
  const pool = getPool()
  // Avg daily sellable inventory cost within each bucket window, per
  // dealer. Snapshots are INCREMENTAL — after the 2026-05-26 initial
  // sweep the worker only re-snapshots packages whose shape changed
  // (typically a few dozen / day), so summing only packages observed
  // ON a given day badly undercounts standing inventory. Instead we
  // carry forward: for each day in the bucket we take the latest
  // snapshot per package with observed_at_min < end-of-day, sum the
  // for-sale cost, then average across the days that have any snapshot
  // coverage yet (days entirely before the first snapshot contribute
  // nothing and are excluded so the average isn't dragged to 0).
  const invSql = `
    with days as (
      select generate_series(
               date_trunc('day', $2::timestamptz),
               date_trunc('day', $3::timestamptz - interval '1 second'),
               interval '1 day') as day_start
    ),
    asof as (
      select d.day_start, sub.dealer_id,
             count(*) as pkgs,
             coalesce(sum(sub.cost) filter (where sub.stock_location ilike 'FOR SALE%'), 0) as forsale_cost
        from days d
        cross join lateral (
          select distinct on (s.dealer_id, s.inventory_item_id)
                 s.dealer_id,
                 coalesce(s.current_qty, 0) * coalesce(s.wholesale_cost_dollars, 0) as cost,
                 s.stock_location
            from sweed_package_snapshots s
           where s.dealer_id = any($1::bigint[])
             and s.observed_at_min < d.day_start + interval '1 day'
           order by s.dealer_id, s.inventory_item_id, s.observed_at_min desc
        ) sub
       group by d.day_start, sub.dealer_id
    )
    select dealer_id::text as dealer_id, avg(forsale_cost)::numeric as avg_forsale_cost
      from asof
     where pkgs > 0
     group by dealer_id
  `
  const salesSql = `
    select dealer_id::text as dealer_id, coalesce(sum(subtotal_dollars), 0)::numeric as sales
      from sweed_orders
     where dealer_id = any($1::bigint[])
       and pay_time >= $2::timestamptz and pay_time < $3::timestamptz
     group by dealer_id
  `
  const invResults = await Promise.all(
    buckets.map((_, i) =>
      pool.query<{ dealer_id: string; avg_forsale_cost: string | null }>(invSql, [
        dealerIds,
        buckets[i]!.toISOString(),
        bucketEnds[i]!.toISOString(),
      ]),
    ),
  )
  const salesResults = await Promise.all(
    buckets.map((_, i) =>
      pool.query<{ dealer_id: string; sales: string | null }>(salesSql, [
        dealerIds,
        buckets[i]!.toISOString(),
        bucketEnds[i]!.toISOString(),
      ]),
    ),
  )
  const out: MetricRow[] = []
  for (let i = 0; i < buckets.length; i++) {
    const invByDealer = new Map<string, number>()
    for (const r of invResults[i]!.rows) {
      invByDealer.set(r.dealer_id, r.avg_forsale_cost == null ? 0 : Number(r.avg_forsale_cost))
    }
    const salesByDealer = new Map<string, number>()
    for (const r of salesResults[i]!.rows) {
      salesByDealer.set(r.dealer_id, r.sales == null ? 0 : Number(r.sales))
    }
    for (const dealerId of dealerIds) {
      const key = String(dealerId)
      const inv = invByDealer.get(key)
      if (inv === undefined) continue // no snapshot coverage in this bucket → no dot
      const sales = salesByDealer.get(key) ?? 0
      const zip = HELIOS_SITE_ZIP_BY_DEALER[dealerId] ?? null
      const row: Record<string, string | number | null> = {
        t: buckets[i]!.toISOString(),
        sellable_inventory_cost: round2(inv),
        sales_dollars: round2(sales),
      }
      if (zip) row.site_zip = zip
      out.push(row as MetricRow)
    }
  }
  return out
}
