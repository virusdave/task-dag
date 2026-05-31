import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type BasketByPurchaseNumberPoint,
  type CohortRetentionRow,
  type ContributionByPurchaseNumberPoint,
  type CustomerValueAnalyticsResponse,
  type CustomerValueCohortGranularity,
  type CustomerValueMissingDataCard,
  type CustomerValueSummary,
  type FirstSecondConversionRow,
  type LifetimeByTotalPurchasesPoint,
  type PurchaseCountBucket,
  type VeriscanCoverage,
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
  /**
   * v1.4 V4'3: when `true`, the response gains `cohortRetention[]`
   * and `firstSecondConversion[]` (extra SQL pass under the same
   * `customers_in_scope` + `purchase_events` CTE set; one round
   * trip with `Promise.all`). When `false`, both arrays are empty
   * and the existing callers pay zero extra cost.
   */
  includeRetention: boolean
  /**
   * v1.4 V4'3: cohort granularity for retention bucketing. Default
   * `'week'`. Only meaningful when `includeRetention === true`.
   */
  cohortGranularity: CustomerValueCohortGranularity
}

const MISSING_CARDS: ReadonlyArray<CustomerValueMissingDataCard> = [
  {
    id: 'customer-value.margin',
    title: 'Lifetime margin $ histograms',
    // v1.4 V4'2 attempted to land sweed_order_margin_mv but the
    // line-items ingest prerequisite (sweed_order_line_items +
    // product_cost_history) is not live on prod. Card stays until
    // that ingest lands; V4'2 ships as a separate commit once it
    // does. See top-level#7's v1.4 status comment.
    whyMissing:
      'Margin requires per-line-item revenue minus per-line-item wholesale cost. v1.4 V4\'2 planned a materialized sweed_order_margin_mv view but the prerequisite line-items ingest (sweed_order_line_items + product_cost_history) is not yet live on the prod warehouse. No stubs — the card stays until the ingest lands.',
    neededSource: 'sweed_order_line_items + product_cost_history ingest on prod, then sweed_order_margin_mv',
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
  // The "customer-value.cohort-retention" MISSING DATA card is removed in
  // v1.4 V4'3 — cohort retention curves + first-to-second conversion
  // sparkline now ship as real panels gated behind `?include=retention`.
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
    cohortGranularity: args.cohortGranularity,
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
    cohortRetention: [],
    firstSecondConversion: [],
    // v1.4 V4'5: empty-state coverage. `pct = 0` is the correct
    // value when there are no orders in window; the client will
    // render "0% linked" rather than "—%" so the operator can tell
    // "no orders" from "real but zero coverage".
    meta: { veriscanCoverage: { linked: 0, total: 0, pct: 0 } },
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

  // v1.4 V4'3: when ?include=retention is set, run the retention SQL in
  // parallel with the main union — one round-trip, two independent
  // queries. The existing main query is unaffected; existing callers
  // without ?include=retention pay zero extra cost.
  const guestSql = `
    select count(*)::int as n
      from sweed_orders
     where dealer_id = any($1::bigint[])
       and pay_time >= $2::timestamptz
       and pay_time < $3::timestamptz
       and customer_id is null
  `
  // v1.4 V4'5: VeriScan link coverage over the visible window.
  // `total` = all sweed_orders in window for the selected dealers
  // (known + guest); `linked` = subset whose customer_id matches a
  // `visitor_scan_links` row in `'linked'` status for the same dealer.
  // EXISTS (not JOIN) so a customer with multiple scans doesn't
  // double-count their orders. The partial index
  // `visitor_scan_links_sweed_customer_idx` makes the EXISTS cheap.
  const veriscanSql = `
    select
      count(*)::int as total,
      count(*) filter (where exists (
        select 1 from visitor_scan_links vsl
         where vsl.dealer_id = so.dealer_id
           and vsl.sweed_customer_id = so.customer_id
           and vsl.link_status = 'linked'
      ))::int as linked
    from sweed_orders so
    where so.dealer_id = any($1::bigint[])
      and so.pay_time >= $2::timestamptz
      and so.pay_time < $3::timestamptz
  `
  const [result, guestRes, retentionRes, veriscanRes] = await Promise.all([
    pool.query<UnionRow>(sql, [
      dealerIds,
      args.from.toISOString(),
      args.to.toISOString(),
      effectiveMaxN,
      args.cohortScope,
    ]),
    // Pull guest order count separately (summary.totalOrders = known + guest).
    pool.query<{ n: string | number }>(guestSql, [
      dealerIds,
      args.from.toISOString(),
      args.to.toISOString(),
    ]),
    args.includeRetention
      ? runRetentionQueries({
          pool,
          dealerIds,
          from: args.from,
          to: args.to,
          cohortScope: args.cohortScope,
          cohortGranularity: args.cohortGranularity,
        })
      : Promise.resolve({ cohortRetention: [], firstSecondConversion: [] } as RetentionPayload),
    pool.query<{ total: string | number; linked: string | number }>(veriscanSql, [
      dealerIds,
      args.from.toISOString(),
      args.to.toISOString(),
    ]),
  ])

  const guestCount = asReqInt(guestRes.rows[0]?.n)
  const veriscanTotal = asReqInt(veriscanRes.rows[0]?.total)
  const veriscanLinked = asReqInt(veriscanRes.rows[0]?.linked)
  const veriscanCoverage: VeriscanCoverage = {
    linked: veriscanLinked,
    total: veriscanTotal,
    pct: veriscanTotal > 0 ? veriscanLinked / veriscanTotal : 0,
  }

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
    cohortGranularity: args.cohortGranularity,
    summary,
    purchaseCountHistogram,
    basketByPurchaseNumber,
    lifetimeByTotalPurchases,
    contributionByPurchaseNumber,
    cohortRetention: retentionRes.cohortRetention,
    firstSecondConversion: retentionRes.firstSecondConversion,
    meta: { veriscanCoverage },
    missingDataCards: [...MISSING_CARDS],
  }
}

// ============================================================================
// v1.4 V4'3 — cohort retention + first-to-second conversion
//
// Acquisition cohort = `date_trunc(<granularity>, first_purchase_at)`,
// computed per-customer via the same per-customer rollup the main query
// uses. We rerun the rollup inline (rather than sharing CTEs across two
// pool.query calls) so the retention SQL is self-contained — the pool
// can't share CTEs across statements, so factoring them out via a temp
// table would actually be slower than re-deriving in a CTE.
//
// Two output rowsets:
//
//   * cohort_retention: one row per (cohort_key, period_index) where
//     period_index = 0 is the acquisition period. retained_count =
//     distinct customers in the cohort with at least one purchase in
//     period [cohort_key + period_index * granularity,
//     cohort_key + (period_index + 1) * granularity).
//   * first_second_conversion: one row per cohort_key with counts of
//     customers whose second-ever purchase landed within 30/60/90 days
//     of their first, plus an "ever" total.
//
// Both rowsets honour the existing site filter (via dealerIds) and
// cohort scope filter (via `customers_in_scope`-equivalent inline SQL).
// Server returns ALL cohorts in the range — the client picks the
// most recent 12 to display by default, with a "show all" toggle.
// ============================================================================

interface RetentionPayload {
  readonly cohortRetention: CohortRetentionRow[]
  readonly firstSecondConversion: FirstSecondConversionRow[]
}

interface RetentionQueryArgs {
  pool: ReturnType<typeof getPool>
  dealerIds: number[]
  from: Date
  to: Date
  cohortScope: CustomerValueCohortScope
  cohortGranularity: CustomerValueCohortGranularity
}

async function runRetentionQueries(args: RetentionQueryArgs): Promise<RetentionPayload> {
  const { pool, dealerIds, from, to, cohortScope, cohortGranularity } = args
  if (dealerIds.length === 0) {
    return { cohortRetention: [], firstSecondConversion: [] }
  }

  // The retention SQL re-derives the per-customer rollup (first
  // purchase time, total purchases, second purchase time) under
  // the same cohort-scope filter the main query uses. We use a
  // single statement that returns both rowsets via UNION ALL with
  // a `kind` discriminator — keeps the round-trip count to one.
  //
  // $1 = dealerIds (bigint[])
  // $2 = from (timestamptz, inclusive)
  // $3 = to   (timestamptz, exclusive — also the upper bound for cohort assignment)
  // $4 = cohortScope (text)
  // $5 = cohortGranularity (text — 'week' or 'month')
  const sql = `
    with orders as (
      select so.dealer_id, so.invoice_id, so.pay_time, so.customer_id
        from sweed_orders so
       where so.dealer_id = any($1::bigint[])
         and so.pay_time < $3::timestamptz
         and so.customer_id is not null
    ),
    purchase_events as (
      select o.*,
        row_number() over (
          partition by o.dealer_id, o.customer_id
          order by o.pay_time, o.invoice_id
        )::int as purchase_n
      from orders o
    ),
    customer_rollup as (
      select dealer_id, customer_id,
        min(pay_time) as first_purchase_at,
        max(pay_time) as last_purchase_at,
        count(*)::int as total_purchases,
        min(pay_time) filter (where purchase_n >= 2) as second_purchase_at
      from purchase_events
      group by dealer_id, customer_id
    ),
    customers_in_scope as (
      select cr.*,
        date_trunc($5::text, cr.first_purchase_at) as cohort_key
      from customer_rollup cr
      where case $4::text
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
    cohort_sizes as (
      select cohort_key, count(*)::int as cohort_size
        from customers_in_scope
       group by cohort_key
    ),
    -- retention: customer counted at period N if they have ≥1 purchase
    -- in [cohort_key + N * granularity, cohort_key + (N+1) * granularity).
    -- We compute period_index by floor-dividing seconds for 'week' and
    -- by month-difference for 'month' (calendar-aware).
    retention_events as (
      select cis.cohort_key, cis.cohort_size, pe.customer_id,
        case when $5::text = 'week'
          then floor(extract(epoch from (pe.pay_time - cis.cohort_key)) / (7 * 86400))::int
          else (
            (extract(year from pe.pay_time)::int - extract(year from cis.cohort_key)::int) * 12
            + (extract(month from pe.pay_time)::int - extract(month from cis.cohort_key)::int)
          )
        end as period_index
      from customers_in_scope cis
      join purchase_events pe
        on pe.dealer_id = cis.dealer_id and pe.customer_id = cis.customer_id
      where pe.pay_time >= cis.cohort_key
        and pe.pay_time < $3::timestamptz
    ),
    retention_grid as (
      select cohort_key,
        count(distinct customer_id) filter (where true) as cohort_size_chk,
        period_index,
        count(distinct customer_id)::int as retained_count
      from retention_events
      group by cohort_key, period_index
    )
    select 'retention'::text as kind,
      cohort_key as cohort_key,
      cs.cohort_size as cohort_size,
      rg.period_index as period_index,
      rg.retained_count as retained_count,
      null::numeric as f0,
      null::numeric as f1,
      null::numeric as f2,
      null::numeric as f3
    from retention_grid rg
    join cohort_sizes cs using (cohort_key)
    union all
    select 'first_second'::text,
      cis.cohort_key,
      cs.cohort_size,
      0,
      0,
      count(*) filter (where cis.second_purchase_at is not null)::numeric as ever,
      count(*) filter (where cis.second_purchase_at is not null
                       and cis.second_purchase_at <= cis.first_purchase_at + interval '30 days')::numeric as w30,
      count(*) filter (where cis.second_purchase_at is not null
                       and cis.second_purchase_at <= cis.first_purchase_at + interval '60 days')::numeric as w60,
      count(*) filter (where cis.second_purchase_at is not null
                       and cis.second_purchase_at <= cis.first_purchase_at + interval '90 days')::numeric as w90
    from customers_in_scope cis
    join cohort_sizes cs using (cohort_key)
    group by cis.cohort_key, cs.cohort_size
  `

  const res = await pool.query<{
    kind: string
    cohort_key: string | Date | null
    cohort_size: string | number | null
    period_index: string | number | null
    retained_count: string | number | null
    f0: string | number | null
    f1: string | number | null
    f2: string | number | null
    f3: string | number | null
  }>(sql, [
    dealerIds,
    from.toISOString(),
    to.toISOString(),
    cohortScope,
    cohortGranularity,
  ])

  const retention: CohortRetentionRow[] = []
  const conversion: FirstSecondConversionRow[] = []
  for (const r of res.rows) {
    const cohortKey =
      r.cohort_key == null
        ? null
        : r.cohort_key instanceof Date
          ? r.cohort_key.toISOString()
          : new Date(r.cohort_key).toISOString()
    if (cohortKey == null) continue
    const cohortSize = asReqInt(r.cohort_size)
    if (r.kind === 'retention') {
      const periodIndex = asReqInt(r.period_index)
      const retainedCount = asReqInt(r.retained_count)
      retention.push({
        cohortKey,
        cohortSize,
        periodIndex,
        retainedCount,
        retentionPct: cohortSize > 0 ? retainedCount / cohortSize : 0,
      })
    } else if (r.kind === 'first_second') {
      const everCount = asReqInt(r.f0)
      const within30dCount = asReqInt(r.f1)
      const within60dCount = asReqInt(r.f2)
      const within90dCount = asReqInt(r.f3)
      conversion.push({
        cohortKey,
        cohortSize,
        everCount,
        within30dCount,
        within60dCount,
        within90dCount,
        everPct: cohortSize > 0 ? everCount / cohortSize : 0,
        within30dPct: cohortSize > 0 ? within30dCount / cohortSize : 0,
        within60dPct: cohortSize > 0 ? within60dCount / cohortSize : 0,
        within90dPct: cohortSize > 0 ? within90dCount / cohortSize : 0,
      })
    }
  }

  retention.sort((a, b) =>
    a.cohortKey === b.cohortKey
      ? a.periodIndex - b.periodIndex
      : a.cohortKey.localeCompare(b.cohortKey),
  )
  conversion.sort((a, b) => a.cohortKey.localeCompare(b.cohortKey))

  return { cohortRetention: retention, firstSecondConversion: conversion }
}
