// Read model for the CRM "Segments" metrics tab
// (/metrics/crm-segments, virusdave/top-level#12).
//
// "About the segment" analytics: identity + membership (reused from the
// segment-details cache reader), plus order-grain activity / recency /
// fulfillment computed over `sweed_orders` joined to the cached
// `sweed_customer_segments` membership.
//
// Phase 1 is deliberately header-grain (no per-line margin, no category
// affinity) so every read stays inside the interactive budget at current
// volume. The members CTE rides the migration-080 index on
// sweed_customer_segments(segment_id, …); the order scans ride the existing
// sweed_orders(dealer_id, pay_time) index. Margin / category mix arrive once
// the per-customer daily fact rollups land — see
// docs/helios/customer-segmentation/EPIC_PLAN.md §4.
//
// Segment-vs-rest / segment-vs-everyone comparison is a separate tab
// (CRM Segment Analysis) and a separate query module.

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type CrmRecencyBucketKey,
  type CrmSegmentListResponse,
  type CrmSegmentMetricsResponse,
} from '../../shared/contracts/index.js'
import type { Queryable } from '../db/pool.js'
import {
  getSegmentDetails,
  mapSegmentType,
  scopeOf,
} from '../db/queries/marketingSegmentDetailsQueries.js'
import { FULFILLMENT_SERIES_SQL_EXPR_SO } from '../metrics/_real/sweedOrdersQueries.js'

export const CRM_SEGMENT_METRICS_DEFAULT_WINDOW_DAYS = 90

const DAY_MS = 86_400_000

// Exclude fully-cancelled Sweed orders. Shares the exact convention used by
// the customer-value reader (header subtotal/grand_total can be non-zero on
// cancelled orders, so without this guard cancelled activity inflates every
// rollup). Keep in sync with customerValueAnalyticsQueries.nonCancelledOrderSql.
function nonCancelledOrderSql(alias = ''): string {
  const prefix = alias ? `${alias}.` : ''
  return `and lower(coalesce(${prefix}raw_json->'invoiceStatus'->>'name', '')) <> 'cancelled'`
}

function resolveDealerIds(sites: readonly string[]): number[] {
  if (sites.length === 0) {
    return HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((d) => d.dealerId)
  }
  const wanted = new Set(sites.map((s) => s.toLowerCase()))
  return HELIOS_PENDING_PURCHASE_SITE_DEALERS.filter((d) =>
    wanted.has(d.siteKey.toLowerCase()),
  ).map((d) => d.dealerId)
}

function siteKeysForDealerIds(dealerIds: readonly number[]): string[] {
  return HELIOS_PENDING_PURCHASE_SITE_DEALERS.filter((d) =>
    dealerIds.includes(d.dealerId),
  ).map((d) => d.siteKey)
}

function ratio(numer: number, denom: number): number | null {
  return denom > 0 ? numer / denom : null
}

// ---------------------------------------------------------------------------
// Segment picker list
// ---------------------------------------------------------------------------

export async function getCrmSegmentList(
  db: Queryable,
): Promise<CrmSegmentListResponse> {
  const res = await db.query<{
    segment_id: string | number
    segment_name: string | null
    segment_type_id: number | null
    enabled: boolean | null
    total_customers: number | null
    scope_dealer_id: string | number | null
    scope_dealer_name: string | null
    cached_member_count: number
  }>(
    `select c.segment_id,
            c.segment_name,
            c.segment_type_id,
            c.enabled,
            c.total_customers,
            c.scope_dealer_id,
            nullif(c.scope_dealer_name, '') as scope_dealer_name,
            coalesce(m.cnt, 0)::int as cached_member_count
       from sweed_marketing_segments c
       left join (
         select segment_id, count(distinct sweed_customer_id)::int as cnt
           from sweed_customer_segments
          group by segment_id
       ) m on m.segment_id = c.segment_id
      order by coalesce(m.cnt, 0) desc, lower(coalesce(c.segment_name, ''))`,
  )

  return {
    segments: res.rows.map((r) => {
      const scope = scopeOf(
        r.scope_dealer_id === null ? null : Number(r.scope_dealer_id),
        r.scope_dealer_name,
      )
      return {
        segmentId: Number(r.segment_id),
        name: (r.segment_name ?? '').trim() || `Segment #${Number(r.segment_id)}`,
        type: mapSegmentType(r.segment_type_id),
        enabled: r.enabled,
        scopeLevel: scope.scopeLevel,
        scopeLabel: scope.scopeLabel,
        cachedMemberCount: r.cached_member_count,
        sweedTotalCustomers: r.total_customers,
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// Per-segment metrics
// ---------------------------------------------------------------------------

interface CrmSegmentMetricsArgs {
  readonly segmentId: number
  readonly sites: readonly string[]
  readonly from: Date
  readonly to: Date
}

export async function getCrmSegmentMetrics(
  db: Queryable,
  args: CrmSegmentMetricsArgs,
): Promise<CrmSegmentMetricsResponse | null> {
  const details = await getSegmentDetails(db, args.segmentId)
  if (details === null) return null

  const dealerIds = resolveDealerIds(args.sites)
  const cachedMemberCount = details.membership.cachedMemberCount
  const fromIso = args.from.toISOString()
  const toIso = args.to.toISOString()
  const dataQuality: string[] = []

  // No store scope resolved (operator filtered to an unknown site) — emit a
  // zeroed activity block rather than running an `= any('{}')` scan.
  if (dealerIds.length === 0) {
    dataQuality.push('No store sites selected — activity metrics are empty.')
  }

  // -- Window activity (single pass: members ⋈ in-window orders) -----------
  const activityRes =
    dealerIds.length === 0
      ? null
      : await db.query<{
          active_members: number
          orders: number
          gross_sales: number
          net_sales: number
          gross_receipts: number
          discount: number
        }>(
          `with members as (
             select distinct sweed_customer_id::bigint as customer_id
               from sweed_customer_segments
              where segment_id = $1
           ),
           win_orders as (
             select so.customer_id,
                    coalesce(so.subtotal_dollars, 0)::numeric as gross_sales,
                    (coalesce(so.subtotal_dollars, 0)
                     - coalesce(so.discount_dollars, 0))::numeric as net_sales,
                    coalesce(so.grand_total_dollars, 0)::numeric as gross_receipts,
                    coalesce(so.discount_dollars, 0)::numeric as discount
               from sweed_orders so
               join members m on m.customer_id = so.customer_id
              where so.dealer_id = any($2::bigint[])
                and so.customer_id is not null
                and so.pay_time >= $3::timestamptz
                and so.pay_time <  $4::timestamptz
                ${nonCancelledOrderSql('so')}
           )
           select
             count(distinct customer_id)::int as active_members,
             count(*)::int as orders,
             coalesce(sum(gross_sales), 0)::float8 as gross_sales,
             coalesce(sum(net_sales), 0)::float8 as net_sales,
             coalesce(sum(gross_receipts), 0)::float8 as gross_receipts,
             coalesce(sum(discount), 0)::float8 as discount
           from win_orders`,
          [args.segmentId, dealerIds, fromIso, toIso],
        )

  const a = activityRes?.rows[0] ?? {
    active_members: 0,
    orders: 0,
    gross_sales: 0,
    net_sales: 0,
    gross_receipts: 0,
    discount: 0,
  }

  // -- Recency buckets (per-member last purchase, all-time up to `to`) ------
  const recencyRes =
    dealerIds.length === 0
      ? null
      : await db.query<{
          b0_30: number
          b31_60: number
          b61_90: number
          b91_180: number
          b181_plus: number
          purchasers: number
        }>(
          `with members as (
             select distinct sweed_customer_id::bigint as customer_id
               from sweed_customer_segments
              where segment_id = $1
           ),
           last_orders as (
             select so.customer_id, max(so.pay_time) as last_at
               from sweed_orders so
               join members m on m.customer_id = so.customer_id
              where so.dealer_id = any($2::bigint[])
                and so.customer_id is not null
                and so.pay_time < $3::timestamptz
                ${nonCancelledOrderSql('so')}
              group by so.customer_id
           ),
           d as (
             select extract(epoch from ($3::timestamptz - last_at)) / 86400.0 as days
               from last_orders
           )
           select
             count(*) filter (where days <= 30)::int as b0_30,
             count(*) filter (where days > 30 and days <= 60)::int as b31_60,
             count(*) filter (where days > 60 and days <= 90)::int as b61_90,
             count(*) filter (where days > 90 and days <= 180)::int as b91_180,
             count(*) filter (where days > 180)::int as b181_plus,
             count(*)::int as purchasers
           from d`,
          [args.segmentId, dealerIds, toIso],
        )

  const rec = recencyRes?.rows[0] ?? {
    b0_30: 0,
    b31_60: 0,
    b61_90: 0,
    b91_180: 0,
    b181_plus: 0,
    purchasers: 0,
  }
  const neverCount = Math.max(0, cachedMemberCount - rec.purchasers)
  const recencyBuckets: Array<{ bucket: CrmRecencyBucketKey; memberCount: number }> = [
    { bucket: '0_30', memberCount: rec.b0_30 },
    { bucket: '31_60', memberCount: rec.b31_60 },
    { bucket: '61_90', memberCount: rec.b61_90 },
    { bucket: '91_180', memberCount: rec.b91_180 },
    { bucket: '181_plus', memberCount: rec.b181_plus },
    { bucket: 'never', memberCount: neverCount },
  ]

  // -- Fulfillment mix (in-window) -----------------------------------------
  const fulfillmentRes =
    dealerIds.length === 0
      ? null
      : await db.query<{ channel: string; orders: number; net_sales: number }>(
          `with members as (
             select distinct sweed_customer_id::bigint as customer_id
               from sweed_customer_segments
              where segment_id = $1
           )
           select ${FULFILLMENT_SERIES_SQL_EXPR_SO} as channel,
                  count(*)::int as orders,
                  coalesce(sum(coalesce(so.subtotal_dollars, 0)
                              - coalesce(so.discount_dollars, 0)), 0)::float8 as net_sales
             from sweed_orders so
             join members m on m.customer_id = so.customer_id
            where so.dealer_id = any($2::bigint[])
              and so.customer_id is not null
              and so.pay_time >= $3::timestamptz
              and so.pay_time <  $4::timestamptz
              ${nonCancelledOrderSql('so')}
            group by 1
            order by orders desc`,
          [args.segmentId, dealerIds, fromIso, toIso],
        )

  // -- Data-quality caveats ------------------------------------------------
  if (cachedMemberCount === 0) {
    dataQuality.push(
      'No members cached for this segment yet — refresh membership on the segment details page.',
    )
  } else if (details.refreshState.status === 'never' || details.refreshState.status === 'untracked') {
    dataQuality.push(
      'Membership cache freshness is untracked — counts may lag the live Sweed segment.',
    )
  }
  if (cachedMemberCount > 0 && cachedMemberCount < 30) {
    dataQuality.push('Small segment (<30 cached members) — treat rates as directional.')
  }

  return {
    segment: details.segment,
    membership: details.membership,
    window: { from: fromIso, to: toIso },
    scope: { siteKeys: siteKeysForDealerIds(dealerIds), dealerIds },
    activity: {
      activeMembers: a.active_members,
      activeRate: ratio(a.active_members, cachedMemberCount),
      orders: a.orders,
      ordersPerMember: ratio(a.orders, cachedMemberCount),
      ordersPerActiveMember: ratio(a.orders, a.active_members),
      grossSalesDollars: a.gross_sales,
      netSalesDollars: a.net_sales,
      grossReceiptsDollars: a.gross_receipts,
      discountDollars: a.discount,
      avgOrderValueDollars: ratio(a.gross_receipts, a.orders),
      netSalesPerMember: ratio(a.net_sales, cachedMemberCount),
      netSalesPerActiveMember: ratio(a.net_sales, a.active_members),
    },
    recencyBuckets,
    fulfillmentMix: (fulfillmentRes?.rows ?? []).map((r) => ({
      channel: r.channel,
      orders: r.orders,
      netSalesDollars: r.net_sales,
    })),
    entryHistogram: details.entryHistogram,
    dataQuality,
  }
}

export function defaultCrmWindow(toIso?: string, fromIso?: string): { from: Date; to: Date } {
  const to = toIso ? new Date(toIso) : new Date()
  const from = fromIso
    ? new Date(fromIso)
    : new Date(to.getTime() - CRM_SEGMENT_METRICS_DEFAULT_WINDOW_DAYS * DAY_MS)
  return { from, to }
}
