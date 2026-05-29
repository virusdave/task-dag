import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type BasketByPurchaseNumberPoint,
  type ContributionByPurchaseNumberPoint,
  type CustomerValueAnalyticsResponse,
  type CustomerValueMissingDataCard,
  type CustomerValueSummary,
  type LifetimeByTotalPurchasesPoint,
  type PurchaseCountBucket,
} from '../../shared/contracts/index.js'
import { getPool } from '../db/pool.js'

// ============================================================================
// Customer Value analytics SQL
//
// One endpoint backed by a single shared CTE pass over sweed_orders:
//
//   1. orders_for_lifetime  — every KNOWN-customer order in the dealer
//      set up to `to` (NOT just within the window; ordinals depend on
//      complete history).
//   2. purchase_events      — adds ROW_NUMBER() purchase ordinal.
//   3. customer_rollup      — per-customer aggregates as of `to`.
//   4. customers_in_scope   — apply cohort scope filter (+ overflow
//      bucketing).
//   5. events_in_scope      — events from in-scope customers, with
//      purchase-N overflow bucketing.
//
// Fan out to the 4 mandatory histograms in a single UNION ALL query
// (one round-trip; rows are tagged with `kind` so the JS layer can
// route them).
//
// Per oracle's design (https://ampcode.com/threads/T-019e654a-…):
//
//   * Use ROW_NUMBER() OVER (PARTITION BY dealer_id, customer_id ORDER
//     BY pay_time, invoice_id) — exact ordinal, NOT an estimate. Must
//     be computed over ALL history through `to`, not just the visible
//     window.
//   * Exclude guests (customer_id IS NULL) from per-customer LTV
//     histograms — they can't be deduped into unique customers.
//   * Margin $ is not in v1; would require expanding raw_json items
//     and joining sweed_package_snapshots on the hot path. Render a
//     MISSING DATA card instead of fabricating.
// ============================================================================

export const CUSTOMER_VALUE_ANALYTICS_DEFAULT_WINDOW_DAYS = 90
export const CUSTOMER_VALUE_ANALYTICS_MAX_N_HARD_CAP = 50

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
function asReqNum(v: unknown): number {
  const n = asNum(v)
  return n ?? 0
}
function asReqInt(v: unknown): number {
  const n = asNum(v)
  return n === null ? 0 : Math.trunc(n)
}

export type CustomerValueCohortScope = 'all_as_of_end' | 'active_in_range' | 'acquired_in_range'

/** SQL fragment used by the 'auto' max-N probe — narrows the
 *  customer set to the same scope the main query will then apply. */
function cohortScopeProbeFilter(
  scope: CustomerValueCohortScope,
  fromParam: string,
  toParam: string,
): string {
  switch (scope) {
    case 'acquired_in_range':
      // First-ever order in range. We approximate via min() at the
      // outer scope so we still benefit from the (dealer, pay_time)
      // index — for the probe we just need to know which customers
      // have ≥2 orders, so a HAVING on the first purchase suffices.
      return `and (
        select min(pay_time) from sweed_orders so2
         where so2.dealer_id = sweed_orders.dealer_id
           and so2.customer_id = sweed_orders.customer_id
      ) >= ${fromParam}::timestamptz and (
        select min(pay_time) from sweed_orders so2
         where so2.dealer_id = sweed_orders.dealer_id
           and so2.customer_id = sweed_orders.customer_id
      ) < ${toParam}::timestamptz`
    case 'active_in_range':
      // Customer must have at least one order inside the range.
      return `and exists (
        select 1 from sweed_orders so2
         where so2.dealer_id = sweed_orders.dealer_id
           and so2.customer_id = sweed_orders.customer_id
           and so2.pay_time >= ${fromParam}::timestamptz
           and so2.pay_time < ${toParam}::timestamptz
      )`
    case 'all_as_of_end':
    default:
      return ''
  }
}

interface QueryArgs {
  from: Date
  to: Date
  sites: readonly string[]
  /** Either a fixed bucket cap (2..MAX_N_HARD_CAP) or 'auto' to let
   *  the server choose. 'auto' picks the smallest N such that all
   *  total-purchase buckets > N hold ≤1 customer (the long-tail
   *  cliff), capped at MAX_N_HARD_CAP. Default is 'auto'. */
  maxPurchaseNumber: number | 'auto'
  cohortScope: CustomerValueCohortScope
}

const MISSING_CARDS: ReadonlyArray<CustomerValueMissingDataCard> = [
  {
    id: 'customer-value.margin',
    title: 'Lifetime margin $ histograms',
    whyMissing:
      'Margin requires per-line-item revenue minus per-line-item wholesale cost via sweed_package_snapshots. Doing that join on every order in a 1+ year LTV window blows past our request budget; needs a materialized per-invoice margin view.',
    neededSource: 'sweed_order_margin_mv (materialized view, one row per invoice) or per-line-item table',
    unlockedMetrics: [
      'Avg lifetime margin $ by total purchases',
      'Total margin $ contributed by purchase ordinal',
      'Margin-basis basket-size escalation',
    ],
    blockedByUrl: null,
  },
  {
    id: 'customer-value.scan-funnel',
    title: 'Scan-to-purchase funnel',
    whyMissing:
      'visitor_scan_links coverage is incomplete: many visitor_scans rows are still in pending status and have not been resolved to a sweed customer_id. Until link coverage exceeds ~80%, funnel rates would systematically under-count true scan-to-purchase conversion.',
    neededSource: 'higher visitor_scan_links resolution rate (current pending → linked)',
    unlockedMetrics: [
      'VeriScan check-in → first purchase conversion rate',
      'Avg days from first scan to first purchase',
      'Scan count histogram (per person_key)',
    ],
    blockedByUrl: null,
  },
  {
    id: 'customer-value.cohort-retention',
    title: 'Cohort retention curves',
    whyMissing:
      'Acquisition-cohort retention curves (Month-0 acquired, % returning by month) are computable but deliberately deferred to P1 to keep the v1 endpoint cheap. The shared per-customer rollup CTE already produces first_purchase_at — adding the cohort × age-month grid is straight-forward follow-on.',
    neededSource: 'P1 endpoint extension; data is available',
    unlockedMetrics: [
      'Retention curves by acquisition cohort month',
      'First-to-second conversion rate by cohort',
      'Days-between-purchases distribution',
    ],
    blockedByUrl: null,
  },
  {
    id: 'customer-value.marketing-attribution',
    title: 'Marketing-spend / CAC attribution',
    whyMissing:
      'We have no marketing-spend table, no campaign/source attribution on orders, and no first-touch channel. True CAC payback requires all three.',
    neededSource: 'ad spend by campaign/site/date, plus per-customer first-touch channel attribution',
    unlockedMetrics: [
      'Allowed spend to convert 1st-time → 2nd-time customer',
      'LTV by acquisition channel',
      'CAC payback period by campaign',
    ],
    blockedByUrl: null,
  },
]

interface UnionRow {
  kind: string
  bucket: string | number | null
  overflow: boolean | null
  n: string | number | null
  // Eight generic numeric "value slots". Each `kind` branch fills the
  // slots in a documented order; the dispatcher below maps them back
  // to typed contract fields.
  v1: string | number | null
  v2: string | number | null
  v3: string | number | null
  v4: string | number | null
  v5: string | number | null
  v6: string | number | null
  v7: string | number | null
  v8: string | number | null
}

export async function getCustomerValueAnalytics(
  args: QueryArgs,
): Promise<CustomerValueAnalyticsResponse> {
  const dealerIds = resolveDealerIds(args.sites)
  const pool = getPool()
  const generatedAt = new Date()

  // Resolve the maxPurchaseNumber:
  //   * numeric         → use as-is (clamped to [2, MAX_N_HARD_CAP])
  //   * 'auto' (default) → run a cheap probe that returns the largest
  //     total_purchases value held by ≥2 in-scope customers; that's
  //     the cliff above which the histogram is just one-off long
  //     tail. Cap at MAX_N_HARD_CAP so the rendered bar count never
  //     exceeds the operator-agreed visual budget.
  let effectiveMaxN: number
  if (args.maxPurchaseNumber === 'auto') {
    if (dealerIds.length === 0) {
      effectiveMaxN = 20
    } else {
      const probeSql = `
        with cr as (
          select customer_id, count(*) as total_purchases
            from sweed_orders
           where dealer_id = any($1::bigint[])
             and pay_time < $2::timestamptz
             and customer_id is not null
             ${cohortScopeProbeFilter(args.cohortScope, '$3', '$4')}
           group by dealer_id, customer_id
        ), per_n as (
          -- One row per distinct total_purchases value; we want the
          -- LARGEST such value whose bucket still holds ≥2 customers
          -- (above that the histogram is just a one-off long tail).
          select total_purchases, count(*)::int as customers
            from cr
           group by total_purchases
        )
        select coalesce(
          (select max(total_purchases)::int from per_n where customers >= 2),
          2
        ) as max_n_with_ge2
      `
      const probeParams: unknown[] = [dealerIds, args.to.toISOString()]
      if (args.cohortScope !== 'all_as_of_end') {
        probeParams.push(args.from.toISOString(), args.to.toISOString())
      }
      const probe = await pool.query<{ max_n_with_ge2: string | number | null }>(
        probeSql,
        probeParams,
      )
      const raw = asNum(probe.rows[0]?.max_n_with_ge2) ?? 20
      // Clamp into [2, hard cap]. Auto can never exceed the cap.
      effectiveMaxN = Math.max(2, Math.min(CUSTOMER_VALUE_ANALYTICS_MAX_N_HARD_CAP, Math.trunc(raw)))
    }
  } else {
    effectiveMaxN = Math.max(2, Math.min(CUSTOMER_VALUE_ANALYTICS_MAX_N_HARD_CAP, args.maxPurchaseNumber))
  }

  const emptyResp: CustomerValueAnalyticsResponse = {
    range: { from: args.from.toISOString(), to: args.to.toISOString() },
    generatedAt: generatedAt.toISOString(),
    sites: [...args.sites],
    maxPurchaseNumber: effectiveMaxN,
    cohortScope: args.cohortScope,
    summary: {
      knownCustomers: 0,
      totalOrders: 0,
      firstPurchases: 0,
      repeatPurchases: 0,
      repeatPurchaseRate: null,
      observedAvgLtvGrossDollars: null,
      observedMedianLtvGrossDollars: null,
      grossSalesDollars: 0,
      grossReceiptsDollars: 0,
      netSalesDollars: 0,
    },
    purchaseCountHistogram: [],
    basketByPurchaseNumber: [],
    lifetimeByTotalPurchases: [],
    contributionByPurchaseNumber: [],
    missingDataCards: [...MISSING_CARDS],
  }

  if (dealerIds.length === 0) return emptyResp

  // Single-statement UNION ALL: every branch returns the same column
  // shape (kind, bucket, overflow, n, v1..v8). Branches document what
  // they put in each value slot.
  const sql = `
    with orders_for_lifetime as (
      select
        so.dealer_id,
        so.invoice_id,
        so.pay_time,
        so.customer_id,
        (coalesce(so.subtotal_dollars, 0)
         + coalesce(so.discount_dollars, 0))::numeric    as gross_sales_dollars,
        coalesce(so.subtotal_dollars, 0)::numeric        as net_sales_dollars,
        coalesce(so.grand_total_dollars, 0)::numeric     as gross_receipts_dollars
      from sweed_orders so
      where so.dealer_id = any($1::bigint[])
        and so.pay_time < $3::timestamptz
        and so.customer_id is not null
    ),
    purchase_events as (
      select
        ofl.*,
        row_number() over (
          partition by ofl.dealer_id, ofl.customer_id
          order by ofl.pay_time, ofl.invoice_id
        )::int as purchase_n
      from orders_for_lifetime ofl
    ),
    customer_rollup as (
      select
        dealer_id,
        customer_id,
        min(pay_time) as first_purchase_at,
        max(pay_time) as last_purchase_at,
        count(*)::int as total_purchases,
        sum(gross_sales_dollars)::numeric    as lifetime_gross_sales_dollars,
        sum(net_sales_dollars)::numeric      as lifetime_net_sales_dollars,
        sum(gross_receipts_dollars)::numeric as lifetime_gross_receipts_dollars
      from purchase_events
      group by dealer_id, customer_id
    ),
    customers_in_scope as (
      select cr.*,
        case when cr.total_purchases > $4::int then $4::int + 1 else cr.total_purchases end
          as total_purchases_bucket
      from customer_rollup cr
      where case $5::text
        when 'acquired_in_range' then
          cr.first_purchase_at >= $2::timestamptz
          and cr.first_purchase_at < $3::timestamptz
        when 'active_in_range' then exists (
          select 1 from purchase_events pe
           where pe.dealer_id = cr.dealer_id
             and pe.customer_id = cr.customer_id
             and pe.pay_time >= $2::timestamptz
             and pe.pay_time < $3::timestamptz
        )
        else true
      end
    ),
    events_in_scope as (
      select pe.*,
        case when pe.purchase_n > $4::int then $4::int + 1 else pe.purchase_n end
          as purchase_n_bucket
      from purchase_events pe
      join customers_in_scope cis
        on cis.dealer_id = pe.dealer_id and cis.customer_id = pe.customer_id
    )
    -- ===========================================================
    -- summary
    --   bucket  : unused (0)
    --   n       : knownCustomers
    --   v1..v3  : n_orders_in_window / n_first / n_repeat
    --   v4..v5  : avg / median lifetime gross sales (LTV)
    --   v6..v8  : sum gross / sum net / sum receipts in window
    -- ===========================================================
    select
      'summary'::text                                    as kind,
      0::int                                              as bucket,
      false                                               as overflow,
      (select count(*) from customers_in_scope)::int     as n,
      (select count(*) from events_in_scope
         where pay_time >= $2::timestamptz
           and pay_time < $3::timestamptz)::numeric      as v1,
      (select count(*) filter (where purchase_n = 1)
         from events_in_scope
         where pay_time >= $2::timestamptz
           and pay_time < $3::timestamptz)::numeric      as v2,
      (select count(*) filter (where purchase_n > 1)
         from events_in_scope
         where pay_time >= $2::timestamptz
           and pay_time < $3::timestamptz)::numeric      as v3,
      (select avg(lifetime_gross_sales_dollars)
         from customers_in_scope)                        as v4,
      (select percentile_cont(0.5) within group (order by lifetime_gross_sales_dollars)
         from customers_in_scope)                        as v5,
      (select sum(gross_sales_dollars)
         from events_in_scope
         where pay_time >= $2::timestamptz
           and pay_time < $3::timestamptz)               as v6,
      (select sum(net_sales_dollars)
         from events_in_scope
         where pay_time >= $2::timestamptz
           and pay_time < $3::timestamptz)               as v7,
      (select sum(gross_receipts_dollars)
         from events_in_scope
         where pay_time >= $2::timestamptz
           and pay_time < $3::timestamptz)               as v8
    union all
    -- ===========================================================
    -- purchase_count (Hist 1)
    --   bucket  : totalPurchases (overflow = $4+1)
    --   n       : customerCount
    --   v1..v3  : sum gross / sum net / sum receipts (lifetime $ in bucket)
    --   v4..v8  : unused
    -- ===========================================================
    select
      'purchase_count'::text,
      total_purchases_bucket,
      total_purchases_bucket = $4::int + 1,
      count(*)::int,
      sum(lifetime_gross_sales_dollars),
      sum(lifetime_net_sales_dollars),
      sum(lifetime_gross_receipts_dollars),
      null::numeric, null::numeric, null::numeric, null::numeric, null::numeric
    from customers_in_scope
    group by total_purchases_bucket
    union all
    -- ===========================================================
    -- basket_by_n (Hist 2)
    --   bucket  : purchaseNumber
    --   n       : orderCount
    --   v1..v5  : avg gross / median gross / avg net / median net / avg receipts
    --   v6..v8  : unused
    -- ===========================================================
    select
      'basket_by_n'::text,
      purchase_n_bucket,
      purchase_n_bucket = $4::int + 1,
      count(*)::int,
      avg(gross_sales_dollars),
      percentile_cont(0.5) within group (order by gross_sales_dollars),
      avg(net_sales_dollars),
      percentile_cont(0.5) within group (order by net_sales_dollars),
      avg(gross_receipts_dollars),
      null::numeric, null::numeric, null::numeric
    from events_in_scope
    group by purchase_n_bucket
    union all
    -- ===========================================================
    -- lifetime_by_total (Hist 3)
    --   bucket  : totalPurchases
    --   n       : customerCount
    --   v1..v4  : avg gross / median gross / avg net / median net (lifetime $)
    --   v5..v8  : unused
    -- ===========================================================
    select
      'lifetime_by_total'::text,
      total_purchases_bucket,
      total_purchases_bucket = $4::int + 1,
      count(*)::int,
      avg(lifetime_gross_sales_dollars),
      percentile_cont(0.5) within group (order by lifetime_gross_sales_dollars),
      avg(lifetime_net_sales_dollars),
      percentile_cont(0.5) within group (order by lifetime_net_sales_dollars),
      null::numeric, null::numeric, null::numeric, null::numeric
    from customers_in_scope
    group by total_purchases_bucket
    union all
    -- ===========================================================
    -- contribution_by_n (Hist 4) — window-scoped events
    --   bucket  : purchaseNumber
    --   n       : orderCount
    --   v1..v3  : sum gross / sum net / sum receipts ($ in bucket, in window)
    --   v4..v8  : unused
    -- ===========================================================
    select
      'contribution_by_n'::text,
      purchase_n_bucket,
      purchase_n_bucket = $4::int + 1,
      count(*)::int,
      sum(gross_sales_dollars),
      sum(net_sales_dollars),
      sum(gross_receipts_dollars),
      null::numeric, null::numeric, null::numeric, null::numeric, null::numeric
    from events_in_scope
    where pay_time >= $2::timestamptz
      and pay_time < $3::timestamptz
    group by purchase_n_bucket
  `

  const result = await pool.query<UnionRow>(sql, [
    dealerIds,
    args.from.toISOString(),
    args.to.toISOString(),
    effectiveMaxN,
    args.cohortScope,
  ])

  // Pull guest order count separately (summary.totalOrders = known + guest).
  const guestSql = `
    select count(*)::int as n
      from sweed_orders
     where dealer_id = any($1::bigint[])
       and pay_time >= $2::timestamptz
       and pay_time < $3::timestamptz
       and customer_id is null
  `
  const guestRes = await pool.query<{ n: string | number }>(guestSql, [
    dealerIds,
    args.from.toISOString(),
    args.to.toISOString(),
  ])
  const guestCount = asReqInt(guestRes.rows[0]?.n)

  const summary: CustomerValueSummary = {
    knownCustomers: 0,
    totalOrders: 0,
    firstPurchases: 0,
    repeatPurchases: 0,
    repeatPurchaseRate: null,
    observedAvgLtvGrossDollars: null,
    observedMedianLtvGrossDollars: null,
    grossSalesDollars: 0,
    grossReceiptsDollars: 0,
    netSalesDollars: 0,
  }
  const purchaseCountHistogram: PurchaseCountBucket[] = []
  const basketByPurchaseNumber: BasketByPurchaseNumberPoint[] = []
  const lifetimeByTotalPurchases: LifetimeByTotalPurchasesPoint[] = []
  const contributionByPurchaseNumber: ContributionByPurchaseNumberPoint[] = []

  for (const row of result.rows) {
    const bucket = asReqInt(row.bucket)
    const overflow = !!row.overflow
    const n = asReqInt(row.n)
    switch (row.kind) {
      case 'summary': {
        const knownOrdersInWindow = asReqInt(row.v1)
        summary.knownCustomers = n
        summary.totalOrders = knownOrdersInWindow + guestCount
        summary.firstPurchases = asReqInt(row.v2)
        summary.repeatPurchases = asReqInt(row.v3)
        summary.repeatPurchaseRate =
          knownOrdersInWindow > 0 ? summary.repeatPurchases / knownOrdersInWindow : null
        summary.observedAvgLtvGrossDollars = asNum(row.v4)
        summary.observedMedianLtvGrossDollars = asNum(row.v5)
        summary.grossSalesDollars = asReqNum(row.v6)
        summary.netSalesDollars = asReqNum(row.v7)
        summary.grossReceiptsDollars = asReqNum(row.v8)
        break
      }
      case 'purchase_count': {
        purchaseCountHistogram.push({
          totalPurchases: bucket,
          isOverflowBucket: overflow,
          customerCount: n,
          totalGrossSalesDollars: asReqNum(row.v1),
          totalNetSalesDollars: asReqNum(row.v2),
          totalGrossReceiptsDollars: asReqNum(row.v3),
        })
        break
      }
      case 'basket_by_n': {
        basketByPurchaseNumber.push({
          purchaseNumber: bucket,
          isOverflowBucket: overflow,
          orderCount: n,
          avgGrossSalesDollars: asNum(row.v1),
          medianGrossSalesDollars: asNum(row.v2),
          avgNetSalesDollars: asNum(row.v3),
          medianNetSalesDollars: asNum(row.v4),
          avgGrossReceiptsDollars: asNum(row.v5),
        })
        break
      }
      case 'lifetime_by_total': {
        lifetimeByTotalPurchases.push({
          totalPurchases: bucket,
          isOverflowBucket: overflow,
          customerCount: n,
          avgLifetimeGrossSalesDollars: asNum(row.v1),
          medianLifetimeGrossSalesDollars: asNum(row.v2),
          avgLifetimeNetSalesDollars: asNum(row.v3),
          medianLifetimeNetSalesDollars: asNum(row.v4),
        })
        break
      }
      case 'contribution_by_n': {
        contributionByPurchaseNumber.push({
          purchaseNumber: bucket,
          isOverflowBucket: overflow,
          orderCount: n,
          totalGrossSalesDollars: asReqNum(row.v1),
          totalNetSalesDollars: asReqNum(row.v2),
          totalGrossReceiptsDollars: asReqNum(row.v3),
        })
        break
      }
    }
  }

  purchaseCountHistogram.sort((a, b) => a.totalPurchases - b.totalPurchases)
  basketByPurchaseNumber.sort((a, b) => a.purchaseNumber - b.purchaseNumber)
  lifetimeByTotalPurchases.sort((a, b) => a.totalPurchases - b.totalPurchases)
  contributionByPurchaseNumber.sort((a, b) => a.purchaseNumber - b.purchaseNumber)

  return {
    range: { from: args.from.toISOString(), to: args.to.toISOString() },
    generatedAt: generatedAt.toISOString(),
    sites: [...args.sites],
    maxPurchaseNumber: effectiveMaxN,
    cohortScope: args.cohortScope,
    summary,
    purchaseCountHistogram,
    basketByPurchaseNumber,
    lifetimeByTotalPurchases,
    contributionByPurchaseNumber,
    missingDataCards: [...MISSING_CARDS],
  }
}
