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
  type CrmChannelAffinityRow,
  type CrmComparisonMetric,
  type CrmPopulationSummary,
  type CrmSegmentAnalysisResponse,
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
             ${FULFILLMENT_SERIES_SQL_EXPR_SO} as channel
        from sweed_orders so
        left join members m on m.cid = so.customer_id
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
  if (details === null) return null

  const dealerIds = resolveDealerIds(args.sites)
  const fromIso = args.from.toISOString()
  const toIso = args.to.toISOString()
  const params = [args.segmentId, dealerIds, fromIso, toIso]
  const dataQuality: string[] = []

  let custRows: CustRow[] = []
  let orderRows: OrderRow[] = []
  let channelRows: ChannelRow[] = []

  if (dealerIds.length === 0) {
    dataQuality.push('No store sites selected — comparison is empty.')
  } else {
    const [custRes, orderRes, channelRes] = await Promise.all([
      db.query<CustRow>(
        `with ${ordersCte()},
         cust as (
           select customer_id,
                  bool_or(in_seg) as in_seg,
                  count(*) as orders,
                  sum(net) as net,
                  sum(receipts) as receipts
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
                coalesce(var_samp(orders), 0)::float8 as orders_per_customer_var
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
    ])
    custRows = custRes.rows
    orderRows = orderRes.rows
    channelRows = channelRes.rows
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
  dataQuality.push('Margin/customer and category affinity arrive in a later phase (need the per-customer fact rollups).')

  return {
    segment: details.segment,
    window: { from: fromIso, to: toIso },
    scope: { siteKeys: siteKeysForDealerIds(dealerIds), dealerIds },
    populations,
    shares: { customerShare, netSalesShare, valueIndex },
    metrics,
    channelAffinity,
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
