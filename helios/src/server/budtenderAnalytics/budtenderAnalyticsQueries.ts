import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type BudtenderAnalyticsResponse,
  type BudtenderCashierRow,
  type BudtenderDailyRow,
  type BudtenderReviewCashierRow,
  type BudtenderMissingDataCard,
  type BudtenderTotals,
} from '../../shared/contracts/index.js'
import { getPool } from '../db/pool.js'
import type { Queryable } from '../db/pool.js'
import { getStaffDirectoryFetchedAt } from '../db/queries/staffQueries.js'
import { nonCancelledOrderSql } from '../db/sweedOrderStatus.js'
import { bucketLocalExpr, bucketSelectExpr } from '../metrics/bucketSelectSql.js'

// ============================================================================
// Budtender Performance SQL
//
// One endpoint, one shared filtered scan of sweed_orders over the
// requested window, fans out via CTEs into:
//
//   * totals        — top-line KPI row
//   * daily         — per-day trend series
//   * cashier_agg   — per-cashier base aggregates
//   * baseline_lift — same-customer and similar-customer dollar lift
//                     (window functions over the orders CTE)
//   * drawer_agg    — per-cashier drawer-shift overlap minutes from
//                     sweed_drawer_shift_sessions × sweed_drawer_shifts
//   * peer_medians  — percentiles / medians across active cashiers
//                     for the peer-comparison columns
//
// Per oracle's design — see virusdave/top-level#7 and the budtender
// analytics contract — we deliberately AVOID:
//   * parsing raw_json on the hot path
//   * per-cashier follow-up queries (no N+1)
//   * touching unavailable sources (line items, returns, reviews)
//
// Performance: backed by a covering index (see migration 040). At the
// 90-day default range we expect O(n_orders) rows ≈ ~tens of K, with
// the cashier dimension bounded by ~tens. The percentile computation
// happens entirely in Postgres so the response is one row per
// cashier + daily rollup; the client does no further aggregation.
// ============================================================================

export const BUDTENDER_ANALYTICS_DEFAULT_WINDOW_DAYS = 90
export const BUDTENDER_STAFF_CACHE_MAX_AGE_MS = 15 * 60 * 1000
const DAY_MS = 86_400_000

export type BudtenderStaffRefreshTrigger =
  | 'budtender_cache_stale'
  | 'budtender_cashier_missing'

interface CashierStaffCacheProjection {
  cashierName: string | null
}

export function assessBudtenderStaffCache(
  cashiers: readonly CashierStaffCacheProjection[],
  fetchedAt: string | null,
  nowMs = Date.now(),
): BudtenderStaffRefreshTrigger | null {
  if (cashiers.length === 0) return null
  const fetchedAtMs = fetchedAt === null ? Number.NaN : Date.parse(fetchedAt)
  const cacheIsFresh =
    Number.isFinite(fetchedAtMs) && nowMs - fetchedAtMs < BUDTENDER_STAFF_CACHE_MAX_AGE_MS
  if (cacheIsFresh) return null
  return cashiers.some((cashier) => cashier.cashierName === null)
    ? 'budtender_cashier_missing'
    : 'budtender_cache_stale'
}

export interface BudtenderAnalyticsWithStaffCacheState {
  analytics: BudtenderAnalyticsResponse
  staffRefreshTrigger: BudtenderStaffRefreshTrigger | null
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

function asNum(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
function asInt(v: unknown): number | null {
  const n = asNum(v)
  return n === null ? null : Math.trunc(n)
}
function asReqNum(v: unknown): number {
  const n = asNum(v)
  return n ?? 0
}
function asReqInt(v: unknown): number {
  const n = asInt(v)
  return n ?? 0
}

interface QueryArgs {
  from: Date
  to: Date
  sites: readonly string[]
}

export async function queryBudtenderReviewCashiers(
  db: Queryable,
  dealerIds: readonly number[],
  from: Date,
  to: Date,
): Promise<BudtenderReviewCashierRow[]> {
  const reviewResult = await db.query(
    `select
       rs.matched_cashier_user_id as cashier_user_id,
       sd.full_name as cashier_full_name,
       count(*) as review_count,
       avg(rs.star_rating)::float8 as average_star_rating,
       count(rs.llm_verdict) as classified_review_count,
       count(*) filter (where rs.llm_verdict in ('lukewarm', 'negative')) as lukewarm_negative_count
     from review_submissions rs
     left join staff_directory_cache sd
       on sd.staff_id = rs.matched_cashier_user_id::text
     where rs.dealer_id = any($1::bigint[])
       and rs.created_at >= $2
       and rs.created_at < $3
       and rs.invoice_match_status = 'matched'
       and rs.fraud_marked = false
     group by rs.matched_cashier_user_id, sd.full_name
     order by review_count desc, rs.matched_cashier_user_id`,
    [dealerIds, from, to],
  )
  return reviewResult.rows.map((row) => {
    const classified = asReqInt(row.classified_review_count)
    const lukewarmNegative = asReqInt(row.lukewarm_negative_count)
    return {
      cashierId: String(row.cashier_user_id),
      cashierName: (row.cashier_full_name as string | null) ?? null,
      reviewCount: asReqInt(row.review_count),
      averageStarRating: asNum(row.average_star_rating),
      classifiedReviewCount: classified,
      lukewarmOrNegativeCount: lukewarmNegative,
      lukewarmOrNegativeRate: classified > 0 ? lukewarmNegative / classified : null,
    }
  })
}

export async function getBudtenderAnalytics(
  args: QueryArgs,
): Promise<BudtenderAnalyticsResponse> {
  return (await getBudtenderAnalyticsWithStaffCacheState(args)).analytics
}

export async function getBudtenderAnalyticsWithStaffCacheState(
  args: QueryArgs,
): Promise<BudtenderAnalyticsWithStaffCacheState> {
  const dealerIds = resolveDealerIds(args.sites)
  const generatedAt = new Date().toISOString()
  if (dealerIds.length === 0) {
    return {
      analytics: {
        range: { from: args.from.toISOString(), to: args.to.toISOString() },
        generatedAt,
        sites: [...args.sites],
        totals: emptyTotals(),
        daily: [],
        cashiers: [],
        reviewCashiers: [],
        missingDataCards: [...MISSING_DATA_CARDS],
      },
      staffRefreshTrigger: null,
    }
  }
  const pool = getPool()

  // ---- query 1: totals + daily series in a single round-trip ----------
  // Cashier identity comes straight from the dedicated
  // `sweed_orders.cashier_user_id` bigint column. The ingest worker
  // writes it from Sweed's canonical `creatorId` field (when
  // creatorType = 1 / User), and migration 061 backfilled every
  // historical row from raw_json->>'creatorId' (DB-cost epic phase F5
  // prerequisite, virusdave/top-level#11). We therefore no longer read
  // sweed_orders.raw_json here at all — which both honours the
  // "no raw_json on the hot path" design rule above and unblocks the
  // F5 drain of that column.
  const CASHIER_EXPR = `cashier_user_id`

  const dailyAndTotalsSql = `
    with orders as (
      select
        pay_time,
        ${CASHIER_EXPR}                          as cashier_user_id,
        coalesce(grand_total_dollars, 0)::float8  as grand_total,
        coalesce(subtotal_dollars, 0)::float8     as subtotal,
        coalesce(discount_dollars, 0)::float8     as discount
      from sweed_orders
      where dealer_id = any($1::bigint[])
        and pay_time >= $2
        and pay_time <  $3
        -- Fully-cancelled orders are not transactions; exclude from
        -- cashier attribution.
        ${nonCancelledOrderSql('')}
    ),
    daily as (
      select
        -- Business-day bucket re-wrapped to timestamptz so node-postgres
        -- gives us a real UTC instant (08:00 ET on the business date)
        -- that matches the JS-side bucket boundary. See
        -- helios/src/server/metrics/bucketSelectSql.ts for the
        -- business-day convention every metric query in helios shares.
        ${bucketSelectExpr('day', 'pay_time')} as day,
        count(*) filter (where cashier_user_id is not null)        as txn,
        count(*) filter (where cashier_user_id is null)            as unassigned_txn,
        coalesce(sum(grand_total) filter (where cashier_user_id is not null), 0)::float8 as sales,
        avg(grand_total) filter (where cashier_user_id is not null) as aov,
        (sum(discount) filter (where cashier_user_id is not null))
          / nullif(sum(subtotal) filter (where cashier_user_id is not null), 0) as discount_rate,
        count(distinct cashier_user_id) filter (where cashier_user_id is not null) as active_cashiers
      from orders
      group by 1
      order by 1
    ),
    totals as (
      select
        count(*) filter (where cashier_user_id is not null)              as attributed_txn,
        count(*) filter (where cashier_user_id is null)                  as unassigned_txn,
        coalesce(sum(grand_total) filter (where cashier_user_id is not null), 0)::float8 as attributed_sales,
        count(distinct cashier_user_id) filter (where cashier_user_id is not null) as active_cashiers,
        avg(grand_total) filter (where cashier_user_id is not null)     as aov,
        (sum(discount) filter (where cashier_user_id is not null))
          / nullif(sum(subtotal) filter (where cashier_user_id is not null), 0) as discount_rate
      from orders
    )
    select 'totals' as kind, null::timestamptz as day,
      attributed_txn, unassigned_txn, attributed_sales,
      active_cashiers, aov, discount_rate
      from totals
    union all
    select 'daily' as kind, day,
      txn, unassigned_txn, sales,
      active_cashiers, aov, discount_rate
      from daily
  `

  const dailyResult = await pool.query(dailyAndTotalsSql, [dealerIds, args.from, args.to])

  let totals: BudtenderTotals = emptyTotals()
  const daily: BudtenderDailyRow[] = []
  for (const row of dailyResult.rows) {
    if (row.kind === 'totals') {
      totals = {
        attributedTransactions: asReqInt(row.attributed_txn),
        unassignedTransactions: asReqInt(row.unassigned_txn),
        attributedSales: asReqNum(row.attributed_sales),
        activeCashiers: asReqInt(row.active_cashiers),
        avgOrderValue: asNum(row.aov),
        discountRate: asNum(row.discount_rate),
      }
    } else if (row.kind === 'daily' && row.day) {
      daily.push({
        day: new Date(row.day).toISOString(),
        transactions: asReqInt(row.attributed_txn),
        unassignedTransactions: asReqInt(row.unassigned_txn),
        sales: asReqNum(row.attributed_sales),
        avgOrderValue: asNum(row.aov),
        discountRate: asNum(row.discount_rate),
        activeCashiers: asReqInt(row.active_cashiers),
      })
    }
  }

  // ---- query 2: per-cashier aggregates + baselines + drawer overlap ---
  const cashierSql = `
    with orders as (
      select
        invoice_id,
        pay_time,
        ${CASHIER_EXPR}                           as cashier_user_id,
        customer_id,
        coalesce(is_guest, false) as is_guest,
        coalesce(first_time_for_customer, false) as first_time_for_customer,
        coalesce(grand_total_dollars, 0)::float8  as grand_total,
        coalesce(subtotal_dollars, 0)::float8     as subtotal,
        coalesce(tax_dollars, 0)::float8          as tax,
        coalesce(discount_dollars, 0)::float8     as discount,
        coalesce(fulfillment_type, 'unknown')     as fulfillment_type,
        coalesce(payment_method,  'unknown')      as payment_method
      from sweed_orders
      where dealer_id = any($1::bigint[])
        and pay_time >= $2
        and pay_time <  $3
        -- Fully-cancelled orders are not transactions; exclude from
        -- cashier attribution.
        ${nonCancelledOrderSql('')}
    ),
    -- Drop unattributed rows (NULL cashier_user_id) AFTER the
    -- projection.
    orders_attrib as (
      select * from orders where cashier_user_id is not null
    ),
    cashier_agg as (
      select
        cashier_user_id                                                                   as cashier_user_id,
        count(*)                                                                          as transactions,
        sum(grand_total)::float8                                                          as sales,
        sum(subtotal)::float8                                                             as subtotal,
        sum(tax)::float8                                                                  as tax,
        sum(discount)::float8                                                             as discount,
        avg(grand_total)                                                                  as avg_order_value,
        percentile_cont(0.5) within group (order by grand_total)                          as median_order_value,
        percentile_cont(0.9) within group (order by grand_total)                          as p90_order_value,
        (sum(discount) / nullif(sum(subtotal), 0))                                        as discount_rate,
        avg(discount)                                                                     as avg_discount_per_transaction,
        avg(case when discount > 0 then 1.0 else 0.0 end)                                 as discounted_transaction_rate,
        count(distinct customer_id) filter (where customer_id is not null and not is_guest) as unique_known_customers,
        avg(case when is_guest                                       then 1.0 else 0.0 end) as guest_rate,
        avg(case when first_time_for_customer                        then 1.0 else 0.0 end) as first_time_customer_rate,
        avg(case when not is_guest and not first_time_for_customer   then 1.0 else 0.0 end) as known_repeat_customer_rate,
        avg(case when fulfillment_type ilike 'delivery%'             then 1.0 else 0.0 end) as delivery_rate,
        avg(case when fulfillment_type ilike 'pickup%'               then 1.0 else 0.0 end) as pickup_rate,
        avg(case when payment_method  ilike 'cash%'                  then 1.0 else 0.0 end) as cash_payment_rate,
        -- active_days is only consumed inside SQL (count distinct), so we
        -- do not need to round-trip it through node-postgres - bucket the
        -- business-day local timestamp directly. Each unique business day
        -- (08:00-ET rollover) a cashier rang up a sale counts once.
        count(distinct ${bucketLocalExpr('day', 'pay_time')})                              as active_days
      from orders_attrib
      group by cashier_user_id
    ),
    -- same-customer baseline: leave-one-out mean over a single customer's other orders
    -- in the window (excluding the row itself). Only non-guest customers with ≥2 orders.
    same_baseline as (
      select
        cashier_user_id,
        invoice_id,
        grand_total,
        case
          when not is_guest and customer_id is not null then
            (sum(grand_total) over (partition by customer_id) - grand_total)
              / nullif(count(*) over (partition by customer_id) - 1, 0)
        end as baseline
      from orders_attrib
    ),
    -- similar-customer baseline: same idea but partitioned by cohort
    -- (is_guest, first_time_for_customer, fulfillment_type, payment_method)
    similar_baseline as (
      select
        cashier_user_id,
        invoice_id,
        grand_total,
        (sum(grand_total) over w - grand_total)
          / nullif(count(*) over w - 1, 0) as baseline
      from orders_attrib
      window w as (partition by is_guest, first_time_for_customer, fulfillment_type, payment_method)
    ),
    same_agg as (
      select
        cashier_user_id,
        avg(grand_total - baseline)
          filter (where baseline is not null)                                            as same_lift_dollars,
        avg((grand_total - baseline) / nullif(baseline, 0))
          filter (where baseline is not null)                                            as same_lift_pct,
        count(*) filter (where baseline is not null)                                     as same_lift_sample
      from same_baseline
      group by cashier_user_id
    ),
    similar_agg as (
      select
        cashier_user_id,
        avg(grand_total - baseline)
          filter (where baseline is not null)                                            as similar_lift_dollars,
        avg((grand_total - baseline) / nullif(baseline, 0))
          filter (where baseline is not null)                                            as similar_lift_pct,
        count(*) filter (where baseline is not null)                                     as similar_lift_sample
      from similar_baseline
      group by cashier_user_id
    ),
    -- drawer-shift overlap. A cashier counts as on-the-clock for the
    -- full drawer window for every drawer whose session list includes
    -- them — overcounts for handoffs but is the operator-approved
    -- approximation; same convention the existing
    -- cashier.transactions_per_hour metric uses.
    drawer_overlap as (
      select
        s.user_id as cashier_user_id,
        count(distinct (ds.dealer_id, ds.sweed_shift_id))                                  as drawer_count,
        sum(
          extract(epoch from (
            least(coalesce(ds.close_date, $3::timestamptz), $3::timestamptz)
            - greatest(ds.open_date, $2::timestamptz)
          )) / 60.0
        )::float8                                                                          as drawer_minutes
      from sweed_drawer_shift_sessions s
      join sweed_drawer_shifts ds
        on  ds.dealer_id = s.dealer_id
        and ds.sweed_shift_id = s.sweed_shift_id
      where ds.dealer_id = any($1::bigint[])
        and ds.close_date is not null
        and ds.open_date  <  $3::timestamptz
        and ds.close_date >  $2::timestamptz
      group by s.user_id
    ),
    joined as (
      select
        ca.*,
        coalesce(sa.same_lift_dollars, null)            as same_lift_dollars,
        coalesce(sa.same_lift_pct, null)                as same_lift_pct,
        coalesce(sa.same_lift_sample, 0)                as same_lift_sample,
        coalesce(sb.similar_lift_dollars, null)         as similar_lift_dollars,
        coalesce(sb.similar_lift_pct, null)             as similar_lift_pct,
        coalesce(sb.similar_lift_sample, 0)             as similar_lift_sample,
        dr.drawer_minutes                                as drawer_minutes,
        dr.drawer_count                                  as drawer_count
      from cashier_agg ca
      left join same_agg     sa on sa.cashier_user_id = ca.cashier_user_id
      left join similar_agg  sb on sb.cashier_user_id = ca.cashier_user_id
      left join drawer_overlap dr on dr.cashier_user_id = ca.cashier_user_id
    ),
    -- peer medians across all cashiers in the response. Computed
    -- in a separate single-row CTE because Postgres does NOT allow
    -- ordered-set aggregates (percentile_cont WITHIN GROUP) inside
    -- a window OVER clause — that errors with
    -- "OVER is not supported for ordered-set aggregate
    -- percentile_cont". Cross-join the one-row CTE in instead.
    peer_medians as (
      select
        percentile_cont(0.5) within group (order by avg_order_value)  as peer_median_aov,
        percentile_cont(0.5) within group (order by discount_rate)    as peer_median_disc,
        percentile_cont(0.5) within group (
          order by case when drawer_minutes > 0 then transactions / (drawer_minutes / 60.0) end
        )                                                             as peer_median_txn_per_hr,
        percentile_cont(0.5) within group (order by same_lift_dollars) as peer_median_same_lift
      from joined
    ),
    -- peer percentiles across all cashiers in the response. Window
    -- functions on percent_rank() ARE supported and cheap. They
    -- return NULL for a single-row partition (no "peers") — the
    -- contract makes those nullable.
    ranked as (
      select
        j.*,
        percent_rank() over (order by sales)                       as sales_pct,
        percent_rank() over (order by avg_order_value)             as aov_pct,
        percent_rank() over (order by discount_rate)               as disc_pct,
        percent_rank() over (
          order by case when drawer_minutes > 0 then transactions / (drawer_minutes / 60.0) end
        )                                                          as txn_per_hr_pct,
        percent_rank() over (order by same_lift_dollars)           as same_lift_pct_rank,
        percent_rank() over (order by similar_lift_dollars)        as similar_lift_pct_rank
      from joined j
    )
    select
      r.*,
      pm.peer_median_aov,
      pm.peer_median_disc,
      pm.peer_median_txn_per_hr,
      pm.peer_median_same_lift,
      sd.full_name        as cashier_full_name,
      sd.blocked          as cashier_blocked,
      sd.user_status      as cashier_user_status
    from ranked r
    cross join peer_medians pm
    left join staff_directory_cache sd
      on sd.staff_id = r.cashier_user_id::text
    order by transactions desc
  `
  const cashierResult = await pool.query(cashierSql, [dealerIds, args.from, args.to])

  const cashiers: BudtenderCashierRow[] = cashierResult.rows.map((row) => {
    const transactions = asReqInt(row.transactions)
    const drawerMinutes = asNum(row.drawer_minutes)
    const txnPerDrawerHr =
      drawerMinutes && drawerMinutes > 0 ? transactions / (drawerMinutes / 60) : null
    const salesPerDrawerHr =
      drawerMinutes && drawerMinutes > 0 ? asReqNum(row.sales) / (drawerMinutes / 60) : null
    const peerMedianAov = asNum(row.peer_median_aov)
    const peerMedianDisc = asNum(row.peer_median_disc)
    const peerMedianTxnPerHr = asNum(row.peer_median_txn_per_hr)
    const peerMedianSameLift = asNum(row.peer_median_same_lift)
    const aov = asNum(row.avg_order_value)
    const discRate = asNum(row.discount_rate)
    const sameLift = asNum(row.same_lift_dollars)
    const activeDays = asReqInt(row.active_days)
    return {
      cashierId: String(row.cashier_user_id),
      cashierName: (row.cashier_full_name as string | null) ?? null,
      blocked: typeof row.cashier_blocked === 'boolean' ? row.cashier_blocked : null,
      userStatus: asInt(row.cashier_user_status),
      transactions,
      sales: asReqNum(row.sales),
      subtotal: asReqNum(row.subtotal),
      tax: asReqNum(row.tax),
      discount: asReqNum(row.discount),
      avgOrderValue: aov,
      medianOrderValue: asNum(row.median_order_value),
      p90OrderValue: asNum(row.p90_order_value),
      discountRate: discRate,
      avgDiscountPerTransaction: asNum(row.avg_discount_per_transaction),
      discountedTransactionRate: asNum(row.discounted_transaction_rate),
      uniqueKnownCustomers: asReqInt(row.unique_known_customers),
      guestRate: asNum(row.guest_rate),
      firstTimeCustomerRate: asNum(row.first_time_customer_rate),
      knownRepeatCustomerRate: asNum(row.known_repeat_customer_rate),
      deliveryRate: asNum(row.delivery_rate),
      pickupRate: asNum(row.pickup_rate),
      cashPaymentRate: asNum(row.cash_payment_rate),
      activeDays,
      transactionsPerActiveDay: activeDays > 0 ? transactions / activeDays : null,
      salesPerActiveDay: activeDays > 0 ? asReqNum(row.sales) / activeDays : null,
      drawerMinutes,
      drawerCount: asInt(row.drawer_count),
      transactionsPerDrawerHour: txnPerDrawerHr,
      salesPerDrawerHour: salesPerDrawerHr,
      hasDrawerMatch: drawerMinutes != null && drawerMinutes > 0,
      sameCustomerLiftDollars: sameLift,
      sameCustomerLiftPct: asNum(row.same_lift_pct),
      sameCustomerLiftSample: asReqInt(row.same_lift_sample),
      similarCustomerLiftDollars: asNum(row.similar_lift_dollars),
      similarCustomerLiftPct: asNum(row.similar_lift_pct),
      similarCustomerLiftSample: asReqInt(row.similar_lift_sample),
      peer: {
        salesPercentile: asNum(row.sales_pct),
        avgOrderValuePercentile: asNum(row.aov_pct),
        discountRatePercentile: asNum(row.disc_pct),
        transactionsPerDrawerHourPercentile: asNum(row.txn_per_hr_pct),
        sameCustomerLiftPercentile: asNum(row.same_lift_pct_rank),
        similarCustomerLiftPercentile: asNum(row.similar_lift_pct_rank),
        avgOrderValueDeltaVsPeerMedian:
          aov != null && peerMedianAov != null ? aov - peerMedianAov : null,
        discountRateDeltaVsPeerMedian:
          discRate != null && peerMedianDisc != null ? discRate - peerMedianDisc : null,
        transactionsPerDrawerHourDeltaVsPeerMedian:
          txnPerDrawerHr != null && peerMedianTxnPerHr != null
            ? txnPerDrawerHr - peerMedianTxnPerHr
            : null,
        sameCustomerLiftDeltaVsPeerMedian:
          sameLift != null && peerMedianSameLift != null ? sameLift - peerMedianSameLift : null,
      },
    }
  })

  const reviewCashiers = await queryBudtenderReviewCashiers(pool, dealerIds, args.from, args.to)
  const staffDirectoryFetchedAt = await getStaffDirectoryFetchedAt(pool)
  return {
    analytics: {
      range: { from: args.from.toISOString(), to: args.to.toISOString() },
      generatedAt,
      sites: [...args.sites],
      totals,
      daily,
      cashiers,
      reviewCashiers,
      missingDataCards: [...MISSING_DATA_CARDS],
    },
    staffRefreshTrigger: assessBudtenderStaffCache(cashiers, staffDirectoryFetchedAt),
  }
}

function emptyTotals(): BudtenderTotals {
  return {
    attributedTransactions: 0,
    unassignedTransactions: 0,
    attributedSales: 0,
    activeCashiers: 0,
    avgOrderValue: null,
    discountRate: null,
  }
}

// ----------------------------------------------------------------------
// Cards that the UI renders as MISSING DATA. Centralised here so the
// SPA can render them alongside live cards without making them up
// itself — the source-of-truth for "which questions can we NOT yet
// answer about budtender performance" lives next to the SQL that
// answers everything else.
// ----------------------------------------------------------------------

const ISSUE_URL = 'https://github.com/virusdave/top-level/issues/7'

export const MISSING_DATA_CARDS: ReadonlyArray<BudtenderMissingDataCard> = [
  {
    id: 'product-subset',
    title: 'Per-product / subset comparison',
    whyMissing:
      'sweed_orders ingests invoice HEADERS only — there are no normalised line items, so we cannot ask "how does this cashier sell category X vs peers".',
    neededSource: 'sweed_order_line_items ingest (product / category / qty / line $ per invoice)',
    unlockedMetrics: [
      'Category / subcategory mix per cashier vs peers',
      'Brand / size / pack mix per cashier',
      'Items per transaction',
      'True (quantity-based) upsell',
      'Attach rates',
    ],
    blockedByUrl: ISSUE_URL,
  },
  {
    id: 'returns-refunds',
    title: 'Returns / refunds per cashier',
    whyMissing:
      'No sweed_returns / sweed_refunds table is ingested yet. We see the original sale only; refunded value never lands in Helios.',
    neededSource: 'Returns/refunds ingest with cashier attribution + invoice/item linkage',
    unlockedMetrics: [
      'Refund $ per cashier',
      'Refund frequency vs peers',
      'Refunded item / category distribution',
      'Net sales (gross − refunds) per cashier',
    ],
    blockedByUrl: ISSUE_URL,
  },
  {
    id: 'drawer-cash-reconciliation',
    title: 'Drawer cash +/- by cashier',
    whyMissing:
      'sweed_drawer_shifts captures expected session cash but not the actual cash-on-close reconciliation values.',
    neededSource: 'Sweed drawer-close actual cash + variance ingest',
    unlockedMetrics: [
      'Cash over / short per cashier',
      'Over/short frequency vs peers',
      'Trend of over/short over time',
    ],
    blockedByUrl: ISSUE_URL,
  },
]
