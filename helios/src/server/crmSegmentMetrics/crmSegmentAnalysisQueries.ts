// Read model for the CRM "Segment Analysis" tab
// (/metrics/crm-segment-analysis, virusdave/top-level#12).
//
// Segment-vs-REST comparison computed in a single classify-and-group pass
// over sweed_orders (each order's customer is tagged in_segment via a LEFT
// JOIN to the membership cache). Three small grouped reads — customer-grain,
// order-grain, and channel-grain — then segmentStats.ts turns the aggregates
// into deltas / lift / significance in TS.
//
// Phase 1 is header-grain (orders only): basket size, value/customer, repeat
// rate, discount rate, fulfillment-channel affinity. Margin/customer and
// category affinity arrive with the per-customer daily fact rollups
// (EPIC_PLAN.md §4). Rides idx 080 sweed_customer_segments(segment_id,…) and
// idx 043 sweed_orders(dealer_id,customer_id,pay_time).

import {
  type CrmCategoryAffinityRow,
  type CrmChannelAffinityRow,
  type CrmComparisonMetric,
  type CrmPopulationSummary,
  type CrmSegmentAnalysisResponse,
  type CrmSubcategoryAffinityRow,
} from '../../shared/contracts/index.js'
import type { Queryable } from '../db/pool.js'
import { getSegmentDetails } from '../db/queries/marketingSegmentDetailsQueries.js'
import { FULFILLMENT_SERIES_SQL_EXPR_SO } from '../metrics/_real/sweedOrdersQueries.js'
import {
  nonCancelledOrderSql,
  resolveDealerIds,
  siteKeysForDealerIds,
} from './crmSegmentMetricsQueries.js'
import {
  benjaminiHochberg,
  confidenceLabel,
  MIN_GROUP_N,
  proportionSampleOk,
  twoProportionTest,
  welchTest,
} from './segmentStats.js'

interface CrmSegmentAnalysisArgs {
  readonly segmentId: number
  readonly sites: readonly string[]
  readonly from: Date
  readonly to: Date
}

// Shared CTE prefix: the in-window, in-scope, non-cancelled orders tagged
// with segment membership. `$1` segmentId, `$2` dealerIds, `$3` from, `$4` to.
function ordersCte(): string {
  return `
    members as (
      select distinct sweed_customer_id::bigint as cid
        from sweed_customer_segments
       where segment_id = $1
    ),
    o as (
      select so.customer_id,
             (m.cid is not null) as in_seg,
             coalesce(so.subtotal_dollars, 0)::numeric as gross,
             (coalesce(so.subtotal_dollars, 0)
              - coalesce(so.discount_dollars, 0))::numeric as net,
             coalesce(so.grand_total_dollars, 0)::numeric as receipts,
             coalesce(so.discount_dollars, 0)::numeric as discount,
             -- Precomputed invoice margin (COGS done once at ingest; see
             -- analytics_invoice_margin_facts / migration 085). LEFT JOIN
             -- so an invoice with no fact row contributes $0 rather than
             -- dropping the order.
             coalesce(aimf.margin_dollars, 0)::numeric as margin,
             coalesce(aimf.revenue_dollars, 0)::numeric as margin_revenue,
             ${FULFILLMENT_SERIES_SQL_EXPR_SO} as channel
        from sweed_orders so
        left join members m on m.cid = so.customer_id
        left join analytics_invoice_margin_facts aimf
               on aimf.dealer_id = so.dealer_id
              and aimf.invoice_id = so.invoice_id
       where so.dealer_id = any($2::bigint[])
         and so.customer_id is not null
         and so.pay_time >= $3::timestamptz
         and so.pay_time <  $4::timestamptz
         ${nonCancelledOrderSql('so')}
    )`
}

interface CustRow {
  in_seg: boolean
  customers: number
  orders: number
  repeat_customers: number
  net_sales: number
  gross_receipts: number
  net_per_customer_mean: number
  net_per_customer_var: number
  orders_per_customer_mean: number
  orders_per_customer_var: number
  margin_dollars: number
  margin_revenue: number
  margin_per_customer_mean: number
  margin_per_customer_var: number
}

interface OrderRow {
  in_seg: boolean
  orders: number
  aov_mean: number
  aov_var: number
  gross_sales: number
  discount: number
}

interface ChannelRow {
  in_seg: boolean
  channel: string
  orders: number
}

interface CategoryRow {
  in_seg: boolean
  category: string
  buyers: number
  revenue: number
}

interface SubcategoryRow {
  in_seg: boolean
  subcategory: string
  buyers: number
  revenue: number
}

// Cap the affinity lists so the UI stays legible; rows are ranked by
// segment penetration before truncation.
const TOP_N_CATEGORIES = 20
const TOP_N_SUBCATEGORIES = 25

const ZERO_CUST: Omit<CustRow, 'in_seg'> = {
  customers: 0,
  orders: 0,
  repeat_customers: 0,
  net_sales: 0,
  gross_receipts: 0,
  net_per_customer_mean: 0,
  net_per_customer_var: 0,
  orders_per_customer_mean: 0,
  orders_per_customer_var: 0,
  margin_dollars: 0,
  margin_revenue: 0,
  margin_per_customer_mean: 0,
  margin_per_customer_var: 0,
}
const ZERO_ORDER: Omit<OrderRow, 'in_seg'> = {
  orders: 0,
  aov_mean: 0,
  aov_var: 0,
  gross_sales: 0,
  discount: 0,
}

function ratio(n: number, d: number): number | null {
  return d > 0 ? n / d : null
}

export async function getCrmSegmentAnalysis(
  db: Queryable,
  args: CrmSegmentAnalysisArgs,
): Promise<CrmSegmentAnalysisResponse | null> {
  const details = await getSegmentDetails(db, args.segmentId)
  // Retired segments are hidden everywhere except the segment config
  // pages; treat a direct (e.g. bookmarked) analysis request as not found.
  if (details === null || details.segment.isRetired) return null

  const dealerIds = resolveDealerIds(args.sites)
  const fromIso = args.from.toISOString()
  const toIso = args.to.toISOString()
  const params = [args.segmentId, dealerIds, fromIso, toIso]
  const dataQuality: string[] = []

  let custRows: CustRow[] = []
  let orderRows: OrderRow[] = []
  let channelRows: ChannelRow[] = []
  let categoryRows: CategoryRow[] = []
  let subcategoryRows: SubcategoryRow[] = []

  if (dealerIds.length === 0) {
    dataQuality.push('No store sites selected — comparison is empty.')
  } else {
    const [custRes, orderRes, channelRes, categoryRes, subcategoryRes] = await Promise.all([
      db.query<CustRow>(
        `with ${ordersCte()},
         cust as (
           select customer_id,
                  bool_or(in_seg) as in_seg,
                  count(*) as orders,
                  sum(net) as net,
                  sum(receipts) as receipts,
                  sum(margin) as margin,
                  sum(margin_revenue) as margin_revenue
             from o
            group by customer_id
         )
         select in_seg,
                count(*)::int as customers,
                sum(orders)::int as orders,
                count(*) filter (where orders >= 2)::int as repeat_customers,
                coalesce(sum(net), 0)::float8 as net_sales,
                coalesce(sum(receipts), 0)::float8 as gross_receipts,
                coalesce(avg(net), 0)::float8 as net_per_customer_mean,
                coalesce(var_samp(net), 0)::float8 as net_per_customer_var,
                coalesce(avg(orders), 0)::float8 as orders_per_customer_mean,
                coalesce(var_samp(orders), 0)::float8 as orders_per_customer_var,
                coalesce(sum(margin), 0)::float8 as margin_dollars,
                coalesce(sum(margin_revenue), 0)::float8 as margin_revenue,
                coalesce(avg(margin), 0)::float8 as margin_per_customer_mean,
                coalesce(var_samp(margin), 0)::float8 as margin_per_customer_var
           from cust
          group by in_seg`,
        params,
      ),
      db.query<OrderRow>(
        `with ${ordersCte()}
         select in_seg,
                count(*)::int as orders,
                coalesce(avg(receipts), 0)::float8 as aov_mean,
                coalesce(var_samp(receipts), 0)::float8 as aov_var,
                coalesce(sum(gross), 0)::float8 as gross_sales,
                coalesce(sum(discount), 0)::float8 as discount
           from o
          group by in_seg`,
        params,
      ),
      db.query<ChannelRow>(
        `with ${ordersCte()}
         select in_seg, channel, count(*)::int as orders
           from o
          group by in_seg, channel`,
        params,
      ),
      // Category affinity: customer penetration per category. Joins the
      // flattened line items (typed product_category_name, migration 060,
      // covered by idx sweed_order_items_flat_dealer_pay_idx) back to the
      // order for customer_id + segment membership + cancel guard. No COGS
      // function — pure category grouping, so it stays interactive.
      db.query<CategoryRow>(
        `with members as (
           select distinct sweed_customer_id::bigint as cid
             from sweed_customer_segments
            where segment_id = $1
         ),
         lines as (
           select so.customer_id,
                  (m.cid is not null) as in_seg,
                  coalesce(nullif(lower(f.product_category_name), ''), '(uncategorised)') as category,
                  f.revenue::numeric as revenue
             from sweed_order_items_flat f
             join sweed_orders so
               on so.dealer_id = f.dealer_id and so.invoice_id = f.invoice_id
             left join members m on m.cid = so.customer_id
            where f.dealer_id = any($2::bigint[])
              and f.pay_time >= $3::timestamptz
              and f.pay_time <  $4::timestamptz
              and so.customer_id is not null
              ${nonCancelledOrderSql('so')}
         )
         select in_seg,
                category,
                count(distinct customer_id)::int as buyers,
                coalesce(sum(revenue), 0)::float8 as revenue
           from lines
          group by in_seg, category`,
        params,
      ),
      // Subcategory affinity: same customer-penetration cut, one level
      // finer. Subcategory is NOT on the order line (its productCategory
      // is just {id,name}); it comes from the Helios catalog taxonomy via
      // the line's typed product_id (backfilled in migration 084) ->
      // catalog_group_products(product_id) [indexed] ->
      // catalog_groups.subcategory_name. A product can appear in more than
      // one catalog group, so collapse to ONE deterministic subcategory
      // per product first (min name) to avoid multiplying line revenue /
      // buyer counts. Still no COGS function — stays interactive.
      db.query<SubcategoryRow>(
        `with members as (
           select distinct sweed_customer_id::bigint as cid
             from sweed_customer_segments
            where segment_id = $1
         ),
         product_subcategory as (
           select cgp.product_id,
                  nullif(lower(min(cg.subcategory_name)), '') as subcategory
             from catalog_group_products cgp
             join catalog_groups cg on cg.id = cgp.catalog_group_id
            group by cgp.product_id
         ),
         lines as (
           select so.customer_id,
                  (m.cid is not null) as in_seg,
                  coalesce(ps.subcategory, '(uncategorised)') as subcategory,
                  f.revenue::numeric as revenue
             from sweed_order_items_flat f
             join sweed_orders so
               on so.dealer_id = f.dealer_id and so.invoice_id = f.invoice_id
             left join members m on m.cid = so.customer_id
             left join product_subcategory ps on ps.product_id = f.product_id
            where f.dealer_id = any($2::bigint[])
              and f.pay_time >= $3::timestamptz
              and f.pay_time <  $4::timestamptz
              and so.customer_id is not null
              ${nonCancelledOrderSql('so')}
         )
         select in_seg,
                subcategory,
                count(distinct customer_id)::int as buyers,
                coalesce(sum(revenue), 0)::float8 as revenue
           from lines
          group by in_seg, subcategory`,
        params,
      ),
    ])
    custRows = custRes.rows
    orderRows = orderRes.rows
    channelRows = channelRes.rows
    categoryRows = categoryRes.rows
    subcategoryRows = subcategoryRes.rows
  }

  const seg = { ...ZERO_CUST, ...custRows.find((r) => r.in_seg) }
  const rest = { ...ZERO_CUST, ...custRows.find((r) => !r.in_seg) }
  const segO = { ...ZERO_ORDER, ...orderRows.find((r) => r.in_seg) }
  const restO = { ...ZERO_ORDER, ...orderRows.find((r) => !r.in_seg) }

  const populations: CrmSegmentAnalysisResponse['populations'] = {
    segment: popSummary(seg),
    rest: popSummary(rest),
    everyone: {
      customers: seg.customers + rest.customers,
      orders: seg.orders + rest.orders,
      netSalesDollars: seg.net_sales + rest.net_sales,
      grossReceiptsDollars: seg.gross_receipts + rest.gross_receipts,
    },
  }

  const customerShare = ratio(seg.customers, populations.everyone.customers)
  const netSalesShare = ratio(seg.net_sales, populations.everyone.netSalesDollars)
  const valueIndex =
    customerShare !== null && netSalesShare !== null && customerShare > 0
      ? netSalesShare / customerShare
      : null

  const metrics: CrmComparisonMetric[] = []

  // AOV — Welch on order-grain receipts.
  {
    const w = welchTest(segO.aov_mean, segO.aov_var, segO.orders, restO.aov_mean, restO.aov_var, restO.orders)
    const ok = segO.orders >= MIN_GROUP_N && restO.orders >= MIN_GROUP_N
    metrics.push({
      key: 'aov',
      label: 'Avg order value',
      unit: 'money',
      help: 'Gross receipts (incl. tax) ÷ orders. Welch t vs rest.',
      segment: segO.orders > 0 ? segO.aov_mean : null,
      rest: restO.orders > 0 ? restO.aov_mean : null,
      everyone: ratio(seg.gross_receipts + rest.gross_receipts, seg.orders + rest.orders),
      deltaVsRest: w.delta,
      indexVsRest: w.index,
      pValue: w.pValue,
      confidence: confidenceLabel(w.pValue, ok),
    })
  }

  // Net sales / customer — Welch on customer-grain net.
  {
    const w = welchTest(
      seg.net_per_customer_mean,
      seg.net_per_customer_var,
      seg.customers,
      rest.net_per_customer_mean,
      rest.net_per_customer_var,
      rest.customers,
    )
    const ok = seg.customers >= MIN_GROUP_N && rest.customers >= MIN_GROUP_N
    metrics.push({
      key: 'net_per_customer',
      label: 'Net sales / customer',
      unit: 'money',
      help: 'After-discount, pre-tax sales per active customer. Welch t vs rest.',
      segment: seg.customers > 0 ? seg.net_per_customer_mean : null,
      rest: rest.customers > 0 ? rest.net_per_customer_mean : null,
      everyone: ratio(seg.net_sales + rest.net_sales, seg.customers + rest.customers),
      deltaVsRest: w.delta,
      indexVsRest: w.index,
      pValue: w.pValue,
      confidence: confidenceLabel(w.pValue, ok),
    })
  }

  // Orders / customer — Welch on customer-grain order count.
  {
    const w = welchTest(
      seg.orders_per_customer_mean,
      seg.orders_per_customer_var,
      seg.customers,
      rest.orders_per_customer_mean,
      rest.orders_per_customer_var,
      rest.customers,
    )
    const ok = seg.customers >= MIN_GROUP_N && rest.customers >= MIN_GROUP_N
    metrics.push({
      key: 'orders_per_customer',
      label: 'Orders / customer',
      unit: 'ratio',
      help: 'Purchase frequency per active customer in the window. Welch t vs rest.',
      segment: seg.customers > 0 ? seg.orders_per_customer_mean : null,
      rest: rest.customers > 0 ? rest.orders_per_customer_mean : null,
      everyone: ratio(seg.orders + rest.orders, seg.customers + rest.customers),
      deltaVsRest: w.delta,
      indexVsRest: w.index,
      pValue: w.pValue,
      confidence: confidenceLabel(w.pValue, ok),
    })
  }

  // Margin / customer — Welch on customer-grain margin $ (COGS precomputed
  // in analytics_invoice_margin_facts; unknown package cost counted as $0).
  {
    const w = welchTest(
      seg.margin_per_customer_mean,
      seg.margin_per_customer_var,
      seg.customers,
      rest.margin_per_customer_mean,
      rest.margin_per_customer_var,
      rest.customers,
    )
    const ok = seg.customers >= MIN_GROUP_N && rest.customers >= MIN_GROUP_N
    metrics.push({
      key: 'margin_per_customer',
      label: 'Margin / customer',
      unit: 'money',
      help: 'Gross margin $ (line revenue − package COGS; unknown cost = $0) per active customer. Welch t vs rest.',
      segment: seg.customers > 0 ? seg.margin_per_customer_mean : null,
      rest: rest.customers > 0 ? rest.margin_per_customer_mean : null,
      everyone: ratio(seg.margin_dollars + rest.margin_dollars, seg.customers + rest.customers),
      deltaVsRest: w.delta,
      indexVsRest: w.index,
      pValue: w.pValue,
      confidence: confidenceLabel(w.pValue, ok),
    })
  }

  // Gross-margin % — dollar ratio (margin $ ÷ margin revenue $); shown for
  // context, not significance-tested (it's a ratio of sums, not a mean).
  {
    const segGm = ratio(seg.margin_dollars, seg.margin_revenue)
    const restGm = ratio(rest.margin_dollars, rest.margin_revenue)
    const ok = seg.customers >= MIN_GROUP_N && rest.customers >= MIN_GROUP_N
    metrics.push({
      key: 'gross_margin_pct',
      label: 'Gross-margin %',
      unit: 'rate',
      help: 'Gross margin $ ÷ pre-tax line revenue $. A dollar ratio, so shown for context but not significance-tested.',
      segment: segGm,
      rest: restGm,
      everyone: ratio(seg.margin_dollars + rest.margin_dollars, seg.margin_revenue + rest.margin_revenue),
      deltaVsRest: segGm !== null && restGm !== null ? segGm - restGm : null,
      indexVsRest: segGm !== null && restGm !== null && restGm > 0 ? segGm / restGm : null,
      pValue: null,
      confidence: ok ? 'directional' : 'too_small',
    })
  }

  // Repeat rate — two-proportion z (customers with ≥2 orders).
  {
    const t = twoProportionTest(seg.repeat_customers, seg.customers, rest.repeat_customers, rest.customers)
    const ok = proportionSampleOk(seg.repeat_customers, seg.customers, rest.repeat_customers, rest.customers)
    metrics.push({
      key: 'repeat_rate',
      label: 'Repeat-purchase rate',
      unit: 'rate',
      help: 'Share of active customers with ≥2 orders in the window. Two-proportion z vs rest.',
      segment: t.segmentRate,
      rest: t.restRate,
      everyone: ratio(seg.repeat_customers + rest.repeat_customers, seg.customers + rest.customers),
      deltaVsRest: t.deltaPp,
      indexVsRest: t.index,
      pValue: t.pValue,
      confidence: confidenceLabel(t.pValue, ok),
    })
  }

  // Discount rate — dollar ratio; shown but not significance-tested.
  {
    const segRate = ratio(segO.discount, segO.gross_sales)
    const restRate = ratio(restO.discount, restO.gross_sales)
    const ok = segO.orders >= MIN_GROUP_N && restO.orders >= MIN_GROUP_N
    metrics.push({
      key: 'discount_rate',
      label: 'Discount rate',
      unit: 'rate',
      help: 'Discount $ ÷ gross (pre-discount) sales. A dollar ratio, so shown for context but not significance-tested.',
      segment: segRate,
      rest: restRate,
      everyone: ratio(segO.discount + restO.discount, segO.gross_sales + restO.gross_sales),
      deltaVsRest: segRate !== null && restRate !== null ? segRate - restRate : null,
      indexVsRest: segRate !== null && restRate !== null && restRate > 0 ? segRate / restRate : null,
      pValue: null,
      confidence: ok ? 'directional' : 'too_small',
    })
  }

  // Fulfillment-channel affinity — order-share two-proportion z + BH FDR.
  const channelAffinity = buildChannelAffinity(channelRows, seg.orders, rest.orders)

  // Category affinity — customer penetration two-proportion z + BH FDR.
  const categoryAffinity = buildCategoryAffinity(categoryRows, seg.customers, rest.customers)

  // Subcategory affinity — same treatment, one taxonomy level finer.
  const subcategoryAffinity = buildSubcategoryAffinity(subcategoryRows, seg.customers, rest.customers)

  // Data-quality caveats.
  if (seg.customers === 0) {
    dataQuality.push(
      details.membership.cachedMemberCount === 0
        ? 'No members cached for this segment — refresh membership on the segment details page.'
        : 'No segment members were active in the selected window & sites.',
    )
  } else if (seg.customers < MIN_GROUP_N || rest.customers < MIN_GROUP_N) {
    dataQuality.push(
      `Small sample (segment ${seg.customers} / rest ${rest.customers} active customers) — most comparisons are directional, not significance-badged.`,
    )
  }
  dataQuality.push(
    'Margin $ uses package wholesale cost as-of each sale (unknown cost counted as $0); ' +
      'subcategory comes from the Helios catalog taxonomy, so a product with no catalog ' +
      'group maps to “(uncategorised)”.',
  )

  return {
    segment: details.segment,
    window: { from: fromIso, to: toIso },
    scope: { siteKeys: siteKeysForDealerIds(dealerIds), dealerIds },
    populations,
    shares: { customerShare, netSalesShare, valueIndex },
    metrics,
    channelAffinity,
    categoryAffinity,
    subcategoryAffinity,
    dataQuality,
  }
}

function popSummary(r: CustRow | (Omit<CustRow, 'in_seg'> & { in_seg?: boolean })): CrmPopulationSummary {
  return {
    customers: r.customers,
    orders: r.orders,
    netSalesDollars: r.net_sales,
    grossReceiptsDollars: r.gross_receipts,
  }
}

function buildChannelAffinity(
  rows: ReadonlyArray<ChannelRow>,
  segTotal: number,
  restTotal: number,
): CrmChannelAffinityRow[] {
  const channels = [...new Set(rows.map((r) => r.channel))]
  const segByCh = new Map(rows.filter((r) => r.in_seg).map((r) => [r.channel, r.orders]))
  const restByCh = new Map(rows.filter((r) => !r.in_seg).map((r) => [r.channel, r.orders]))

  const prelim = channels.map((channel) => {
    const xSeg = segByCh.get(channel) ?? 0
    const xRest = restByCh.get(channel) ?? 0
    const t = twoProportionTest(xSeg, segTotal, xRest, restTotal)
    const ok = proportionSampleOk(xSeg, segTotal, xRest, restTotal)
    return { channel, xSeg, xRest, t, ok }
  })

  // Benjamini-Hochberg across the channel family (only over testable cells).
  const qValues = benjaminiHochberg(prelim.map((p) => (p.ok ? p.t.pValue : null)))

  return prelim
    .map((p, i) => ({
      channel: p.channel,
      segmentShare: p.t.segmentRate,
      restShare: p.t.restRate,
      everyoneShare: ratio(p.xSeg + p.xRest, segTotal + restTotal),
      deltaPp: p.t.deltaPp,
      index: p.t.index,
      pValue: p.t.pValue,
      qValue: qValues[i],
      confidence: confidenceLabel(qValues[i] ?? p.t.pValue, p.ok),
    }))
    .sort((a, b) => (b.segmentShare ?? 0) - (a.segmentShare ?? 0))
}

function buildCategoryAffinity(
  rows: ReadonlyArray<CategoryRow>,
  segCustomers: number,
  restCustomers: number,
): CrmCategoryAffinityRow[] {
  const categories = [...new Set(rows.map((r) => r.category))]
  const segByCat = new Map(rows.filter((r) => r.in_seg).map((r) => [r.category, r]))
  const restByCat = new Map(rows.filter((r) => !r.in_seg).map((r) => [r.category, r]))
  const segRevenueTotal = rows
    .filter((r) => r.in_seg)
    .reduce((sum, r) => sum + r.revenue, 0)

  const prelim = categories.map((category) => {
    const xSeg = segByCat.get(category)?.buyers ?? 0
    const xRest = restByCat.get(category)?.buyers ?? 0
    const segRevenue = segByCat.get(category)?.revenue ?? 0
    const t = twoProportionTest(xSeg, segCustomers, xRest, restCustomers)
    const ok = proportionSampleOk(xSeg, segCustomers, xRest, restCustomers)
    return { category, xSeg, xRest, segRevenue, t, ok }
  })

  const qValues = benjaminiHochberg(prelim.map((p) => (p.ok ? p.t.pValue : null)))

  return prelim
    .map((p, i) => ({
      category: p.category,
      segmentBuyers: p.xSeg,
      restBuyers: p.xRest,
      segmentPenetration: p.t.segmentRate,
      restPenetration: p.t.restRate,
      everyonePenetration: ratio(p.xSeg + p.xRest, segCustomers + restCustomers),
      deltaPp: p.t.deltaPp,
      index: p.t.index,
      segmentRevenueShare: ratio(p.segRevenue, segRevenueTotal),
      pValue: p.t.pValue,
      qValue: qValues[i],
      confidence: confidenceLabel(qValues[i] ?? p.t.pValue, p.ok),
    }))
    // Rank by segment penetration (the headline "what they buy" ordering),
    // then cap for legibility.
    .sort((a, b) => (b.segmentPenetration ?? 0) - (a.segmentPenetration ?? 0))
    .slice(0, TOP_N_CATEGORIES)
}

function buildSubcategoryAffinity(
  rows: ReadonlyArray<SubcategoryRow>,
  segCustomers: number,
  restCustomers: number,
): CrmSubcategoryAffinityRow[] {
  const subcategories = [...new Set(rows.map((r) => r.subcategory))]
  const segBySub = new Map(rows.filter((r) => r.in_seg).map((r) => [r.subcategory, r]))
  const restBySub = new Map(rows.filter((r) => !r.in_seg).map((r) => [r.subcategory, r]))
  const segRevenueTotal = rows
    .filter((r) => r.in_seg)
    .reduce((sum, r) => sum + r.revenue, 0)

  const prelim = subcategories.map((subcategory) => {
    const xSeg = segBySub.get(subcategory)?.buyers ?? 0
    const xRest = restBySub.get(subcategory)?.buyers ?? 0
    const segRevenue = segBySub.get(subcategory)?.revenue ?? 0
    const t = twoProportionTest(xSeg, segCustomers, xRest, restCustomers)
    const ok = proportionSampleOk(xSeg, segCustomers, xRest, restCustomers)
    return { subcategory, xSeg, xRest, segRevenue, t, ok }
  })

  const qValues = benjaminiHochberg(prelim.map((p) => (p.ok ? p.t.pValue : null)))

  return prelim
    .map((p, i) => ({
      subcategory: p.subcategory,
      segmentBuyers: p.xSeg,
      restBuyers: p.xRest,
      segmentPenetration: p.t.segmentRate,
      restPenetration: p.t.restRate,
      everyonePenetration: ratio(p.xSeg + p.xRest, segCustomers + restCustomers),
      deltaPp: p.t.deltaPp,
      index: p.t.index,
      segmentRevenueShare: ratio(p.segRevenue, segRevenueTotal),
      pValue: p.t.pValue,
      qValue: qValues[i],
      confidence: confidenceLabel(qValues[i] ?? p.t.pValue, p.ok),
    }))
    .sort((a, b) => (b.segmentPenetration ?? 0) - (a.segmentPenetration ?? 0))
    .slice(0, TOP_N_SUBCATEGORIES)
}
