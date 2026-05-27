import type { MetricAggregation } from '../../../shared/contracts/index.js'
import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type HeliosPendingPurchaseSiteDealer,
} from '../../../shared/contracts/index.js'
import { getPool } from '../../db/pool.js'
import { defaultWindow, walkBuckets } from '../timeBuckets.js'
import type { MetricQueryArgs, MetricRow } from '../types.js'
import { FIRST_TIME_SERIES_EXPR } from './sweedOrdersQueries.js'

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

/**
 * Bucket-start SELECT expression. Always wraps the trunc in a
 * `at time zone 'UTC'` so the column comes back as a timestamptz at
 * UTC, which node-postgres parses as a JS Date at the same instant
 * regardless of server TZ. See sweedOrdersQueries.ts for the full
 * regression context (2026-05-26 "all live metrics show zero" bug).
 */
function bucketSelectExpr(truncUnit: string | null, payTimeExpr: string = 'pay_time'): string {
  if (truncUnit === null) return 'null::timestamptz'
  return `(date_trunc('${truncUnit}', ${payTimeExpr} at time zone 'UTC')) at time zone 'UTC'`
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Inventory metrics report "snapshot state observed AT or before the
 * END of the bucket" — so a daily bucket at `2026-05-26T00:00:00Z`
 * needs the latest snapshot seen in [start, end). We compute the
 * end of each bucket by stepping forward one grain (day / week /
 * month / hour) from the start. The final bucket is clamped to
 * `now()` so we never query the future, and small backfill buckets
 * that pre-date the snapshot worker still get a value via the
 * earliest-snapshot fallback the function already provides.
 */
function bucketEndForAgg(start: Date, agg: MetricAggregation): Date {
  switch (agg) {
    case 'hour':
      return new Date(start.getTime() + 60 * 60 * 1000)
    case 'date':
      return new Date(start.getTime() + DAY_MS)
    case 'week':
      return new Date(start.getTime() + 7 * DAY_MS)
    case 'month':
      return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
    case 'total':
    case 'dow':
    case 'dom':
    case 'dofortnight':
      return new Date(start.getTime() + DAY_MS)
  }
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

// Same canonical mapping the orders queries use for `issuingType.name`;
// duplicated here so the two files stay independently editable when
// Sweed adds a new fulfillment value.
const FULFILLMENT_SERIES_BY_VALUE: ReadonlyMap<string, string> = new Map([
  ['kiosk order', 'kiosk'],
  ['kiosk', 'kiosk'],
  ['pick-up sale', 'pickup'],
  ['pickup sale', 'pickup'],
  ['pickup', 'pickup'],
  ['delivery sale', 'delivery_prepaid'],
  ['delivery (prepaid)', 'delivery_prepaid'],
  ['delivery prepaid', 'delivery_prepaid'],
  ['delivery (cod)', 'delivery_cod'],
  ['delivery cod', 'delivery_cod'],
  ['delivery', 'delivery_prepaid'],
  ['pharmacy order', 'in_store'],
  ['walk-in sale', 'in_store'],
  ['walk in sale', 'in_store'],
  ['walk-in refund/exchange', 'in_store'],
  ['in-store sale', 'in_store'],
  ['in-store', 'in_store'],
  ['in store', 'in_store'],
  ['pos', 'in_store'],
  ['website', 'delivery_prepaid'],
  ['', 'in_store'],
])

const FULFILLMENT_SERIES_IDS = ['delivery_prepaid', 'delivery_cod', 'kiosk', 'pickup', 'in_store'] as const

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

/** Helper: produce the inner sweed_orders × items COGS join expressions.
 *
 *   - revenue_expr: `(item->>'subtotalAmount')::numeric`
 *   - cogs_expr: `qty * cost_as_of_or_earliest()`
 *
 * Each metric query builds a `select bucket_start, series_id, sum(revenue), sum(cogs)`
 * around these.
 */
const REVENUE_EXPR = `(item->>'subtotalAmount')::numeric`
const QTY_EXPR = `(item->>'currentQty')::numeric`
const COGS_EXPR = `${QTY_EXPR} * coalesce(sweed_package_cost_as_of_or_earliest(so.dealer_id, item->>'inventoryItemId', so.pay_time), 0)`

/** margins.gross_margin_dollars — sum(revenue - cogs) per bucket. */
export async function queryGrossMarginDollars(args: MetricQueryArgs): Promise<MetricRow[]> {
  const dealerIds = resolveDealerIds(args.sites)
  const { from, to, truncUnit, buckets } = resolveWindow(args)
  if (dealerIds.length === 0 || buckets.length === 0) {
    return buckets.map((b) => ({ t: b.toISOString(), gm_dollars: 0 }))
  }
  const sql = `
    select ${bucketSelectExpr(truncUnit, 'so.pay_time')} as bucket_start,
           'gm_dollars' as series_id,
           sum(${REVENUE_EXPR})::numeric as revenue,
           sum(${COGS_EXPR})::numeric as cogs
      from sweed_orders so,
           jsonb_array_elements(so.raw_json->'items') as item
     where so.dealer_id = any($1::bigint[])
       and so.pay_time >= $2 and so.pay_time < $3
     group by 1
  `
  return runMarginBucketedQuery({
    sql,
    params: [dealerIds, from.toISOString(), to.toISOString()],
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
  const sql = `
    select ${bucketSelectExpr(truncUnit, 'so.pay_time')} as bucket_start,
           'gm_pct' as series_id,
           sum(case when sweed_package_cost_as_of_or_earliest(so.dealer_id, item->>'inventoryItemId', so.pay_time) is not null
                    then ${REVENUE_EXPR} else 0 end)::numeric as revenue,
           sum(case when sweed_package_cost_as_of_or_earliest(so.dealer_id, item->>'inventoryItemId', so.pay_time) is not null
                    then ${COGS_EXPR} else 0 end)::numeric as cogs
      from sweed_orders so,
           jsonb_array_elements(so.raw_json->'items') as item
     where so.dealer_id = any($1::bigint[])
       and so.pay_time >= $2 and so.pay_time < $3
     group by 1
  `
  return runMarginBucketedQuery({
    sql,
    params: [dealerIds, from.toISOString(), to.toISOString()],
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
  const sql = `
    select ${bucketSelectExpr(truncUnit, 'so.pay_time')} as bucket_start,
           ${FIRST_TIME_SERIES_EXPR} as series_id,
           sum(${REVENUE_EXPR})::numeric as revenue,
           sum(${COGS_EXPR})::numeric as cogs
      from sweed_orders so,
           jsonb_array_elements(so.raw_json->'items') as item
     where so.dealer_id = any($1::bigint[])
       and so.pay_time >= $2 and so.pay_time < $3
     group by 1, 2
  `
  return runMarginBucketedQuery({
    sql,
    params: [dealerIds, from.toISOString(), to.toISOString()],
    seriesIds: ['first_time', 'returning'],
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
  const sql = `
    select ${bucketSelectExpr(truncUnit, 'so.pay_time')} as bucket_start,
           coalesce(lower(item->'productCategory'->>'name'), '') as cat_value,
           sum(${REVENUE_EXPR})::numeric as revenue,
           sum(${COGS_EXPR})::numeric as cogs
      from sweed_orders so,
           jsonb_array_elements(so.raw_json->'items') as item
     where so.dealer_id = any($1::bigint[])
       and so.pay_time >= $2 and so.pay_time < $3
     group by 1, 2
  `
  const pool = getPool()
  const result = await pool.query<{ bucket_start: string | Date | null; cat_value: string | null; revenue: string | null; cogs: string | null }>(
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
  const sql = `
    select ${bucketSelectExpr(truncUnit, 'so.pay_time')} as bucket_start,
           coalesce(lower(so.fulfillment_type), '') as fulfillment_value,
           sum(${isPct ? `case when sweed_package_cost_as_of_or_earliest(so.dealer_id, item->>'inventoryItemId', so.pay_time) is not null then ${REVENUE_EXPR} else 0 end` : REVENUE_EXPR})::numeric as revenue,
           sum(${isPct ? `case when sweed_package_cost_as_of_or_earliest(so.dealer_id, item->>'inventoryItemId', so.pay_time) is not null then ${COGS_EXPR} else 0 end` : COGS_EXPR})::numeric as cogs
      from sweed_orders so,
           jsonb_array_elements(so.raw_json->'items') as item
     where so.dealer_id = any($1::bigint[])
       and so.pay_time >= $2 and so.pay_time < $3
     group by 1, 2
  `
  const pool = getPool()
  const result = await pool.query<{ bucket_start: string | Date | null; fulfillment_value: string | null; revenue: string | null; cogs: string | null }>(
    sql,
    [dealerIds, from.toISOString(), to.toISOString()],
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
 * against sweed_orders raw_json (since sweed_package_snapshots
 * stores category_id as null in v1) — packages that never appeared
 * in any sweed_orders line land in "other".
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
  const perPackageCategorySql = `
    select distinct on (so.dealer_id, item->>'inventoryItemId')
           so.dealer_id,
           item->>'inventoryItemId' as inventory_item_id,
           lower(coalesce(item->'productCategory'->>'name', '')) as category_value
      from sweed_orders so, jsonb_array_elements(so.raw_json->'items') as item
     where so.dealer_id = any($1::bigint[])
       and item->>'inventoryItemId' is not null
     order by so.dealer_id, item->>'inventoryItemId', so.pay_time desc
  `
  // Step 1: per-package category lookup.
  const catResult = await pool.query<{ dealer_id: string; inventory_item_id: string; category_value: string }>(
    perPackageCategorySql,
    [dealerIds],
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
      select so.dealer_id,
             item->>'inventoryItemId' as inventory_item_id,
             sum(${QTY_EXPR} * coalesce(sweed_package_cost_as_of_or_earliest(so.dealer_id, item->>'inventoryItemId', so.pay_time), 0)) / 30.0
               as daily_cogs
        from sweed_orders so, jsonb_array_elements(so.raw_json->'items') as item
       where so.dealer_id = any($1::bigint[])
         and so.pay_time >= $2::timestamptz - interval '30 days'
         and so.pay_time < $2::timestamptz
         and item->>'inventoryItemId' is not null
       group by so.dealer_id, item->>'inventoryItemId'
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
      select so.dealer_id, item->>'inventoryItemId' as inventory_item_id, sum(${QTY_EXPR}) as qty_sold
        from sweed_orders so, jsonb_array_elements(so.raw_json->'items') as item
       where so.dealer_id = any($1::bigint[])
         and so.pay_time >= $2::timestamptz - interval '30 days'
         and so.pay_time < $2::timestamptz
         and item->>'inventoryItemId' is not null
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
      select so.dealer_id, item->>'inventoryItemId' as inventory_item_id,
             sum(${QTY_EXPR}) / 21.0 as daily_qty_sold,
             sum(${REVENUE_EXPR} - ${COGS_EXPR}) / 21.0 as daily_margin
        from sweed_orders so, jsonb_array_elements(so.raw_json->'items') as item
       where so.dealer_id = any($1::bigint[])
         and so.pay_time >= $2::timestamptz - interval '21 days'
         and so.pay_time < $2::timestamptz
         and item->>'inventoryItemId' is not null
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
