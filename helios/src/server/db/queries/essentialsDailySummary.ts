import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type EssentialsDailySummaryResponse,
  type EssentialsDailySummaryRow,
} from '../../../shared/contracts/index.js'
import { getPool, type Queryable } from '../pool.js'

// ============================================================================
// Essentials → "today, per site" daily summary.
//
// Per repo canon (AGENTS.md): all aggregate / display work uses NY
// time. "Today" here is the current LOGICAL BUSINESS DAY in
// America/New_York — the business day rolls over at 04:00 NY, not
// at calendar midnight. So between 00:00 and 03:59:59 NY the banner
// still shows the previous calendar day's sales, and only flips to
// the new day at 04:00 NY.
//
// Concretely the window is `[businessDayStart, now())` where
//   businessDayStart_NY  = date_trunc('day', now_NY − 4h) + 4h
// and `now_NY` is `now() at time zone 'America/New_York'`. Converted
// back to UTC for use as a query bound, this becomes the `start_iso`
// returned to the client. The SQL is the source of truth so DST
// transitions are handled without JS-side date arithmetic.
//
// Shape: one row per known dealer (Bronx + Midtown today), plus an
// aggregate Totals row. Sums add across sites; GM% is recomputed as
// the aggregate ratio (sum_priced_revenue − sum_priced_cogs) /
// sum_priced_revenue, not the average of per-site percentages.
//
// Definitions (mirror what the Essentials cards already use — see
// sweedOrdersQueries.queryGrossSalesDollars / queryGrossReceiptsDollars
// / queryNetSalesDollars and sweedPackageSnapshotsQueries.queryGrossMarginDollars
// / queryEffectiveGmPct):
//
//   * grossReceipts  = sum(grand_total_dollars)              — includes tax
//   * grossSales     = sum(subtotal_dollars)                 — pre-tax, PRE-discount (list price)
//   * netSales       = sum(subtotal_dollars − discount_dollars) — pre-tax, POST-discount
//     [Sweed's `subtotalAmount` is PRE-discount; verified 2026-06-04
//      that grand_total = subtotal − discount + tax. The prior code
//      had gross = subtotal+discount and net = subtotal, both wrong.]
//   * marginDollars  = Σ_lines (rev − qty·cost) over line items with a
//                      KNOWN cost. Line items without a known cost
//                      contribute revenue to grossSales/netSales (those
//                      are order-grain) but are excluded from margin
//                      and from the GM% denominator (same convention
//                      as margins.effective_gm_pct).
//   * gmPct          = (priced_revenue − priced_cogs) / priced_revenue
//
// First-time vs returning:
//   * Orders: NOT EXISTS over sweed_orders by customer_id (guests with
//     customer_id IS NULL count as returning — conservative bias).
//   * Scans: NOT EXISTS over visitor_scans by (provider, person_key)
//     using `coalesce(scanned_at, ingested_at)`. Scans with no
//     person_key count as returning. Uses the partial index
//     `visitor_scans_person_key_time_idx` for an O(log N) per-scan
//     lookup; for a normal day's ~hundreds of scans this is sub-ms.
//
// Site mapping:
//   - dealer_id 210249 ↔ site_slug 'bx' ↔ siteKey 'bronx'
//   - dealer_id 210705 ↔ site_slug 'mh' ↔ siteKey 'midtown'
// ============================================================================

interface SiteBinding {
  readonly siteKey: 'bronx' | 'midtown'
  readonly siteLabel: string
  readonly dealerId: number
  readonly siteSlug: 'bx' | 'mh'
}

const SITE_BINDINGS: ReadonlyArray<SiteBinding> = HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((d) => ({
  siteKey: d.siteKey as 'bronx' | 'midtown',
  siteLabel: d.siteLabel,
  dealerId: d.dealerId,
  // Hard-coded mapping to the visitor_scans webhook site_slug values.
  // See helios/src/server/routes/visitorScans.ts `SUPPORTED_SITES`.
  siteSlug: d.siteKey === 'bronx' ? 'bx' : 'mh',
}))

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

interface OrderTotalsRow {
  dealer_id: string | number
  new_purchases: string | number | null
  returning_purchases: string | number | null
  gross_receipts: string | null
  gross_sales: string | null
  net_sales: string | null
}

interface MarginRow {
  dealer_id: string | number
  priced_revenue: string | null
  priced_cogs: string | null
}

interface ScanRow {
  site_slug: string
  new_scans: string | number | null
  returning_scans: string | number | null
}

interface NyDayRow {
  start_iso: string | Date
  end_iso: string | Date
  ny_date: string
}

/**
 * Fetch the "today, per site + totals" essentials summary.
 *
 * The three underlying queries (orders header, item-grain margin, scans)
 * are issued in parallel against a single connection-pool checkout each;
 * each is independently cheap (NY-day partial-day window over a single
 * day's worth of rows), so request fan-out doesn't materially add load.
 */
export async function loadEssentialsDailySummary(
  db: Queryable = getPool(),
): Promise<EssentialsDailySummaryResponse> {
  const dealerIds = SITE_BINDINGS.map((s) => s.dealerId)
  const siteSlugs = SITE_BINDINGS.map((s) => s.siteSlug)

  // Single SQL round-trip for the day boundary so the four queries
  // below all see the same `[start, end)` instants even if a tick of
  // the wall clock crosses the 04:00-NY business-day boundary while
  // we're loading. Business day = NY local time shifted back 4h then
  // truncated; see file header for the rationale.
  const dayResult = await db.query<NyDayRow>(`
    with bd as (
      select
        date_trunc(
          'day',
          (now() at time zone 'America/New_York') - interval '4 hours'
        ) as business_day_ny
    )
    select
      ((business_day_ny + interval '4 hours') at time zone 'America/New_York') as start_iso,
      now() as end_iso,
      to_char(business_day_ny, 'YYYY-MM-DD') as ny_date
    from bd
  `)
  const dayRow = dayResult.rows[0]!
  const startIso = new Date(dayRow.start_iso).toISOString()
  const endIso = new Date(dayRow.end_iso).toISOString()
  const nyDate = dayRow.ny_date

  // Orders header — counts + revenue per dealer. The NOT EXISTS uses
  // the (customer_id, pay_time) partial index recorded by Sweed's
  // ingest worker; each row is O(log N) and we only iterate today's
  // orders. Guest checkouts (customer_id null) fall into 'returning'.
  const ordersPromise = db.query<OrderTotalsRow>(
    `
      with todays_orders as (
        select
          so.dealer_id,
          so.grand_total_dollars,
          so.subtotal_dollars,
          so.discount_dollars,
          case
            when so.customer_id is not null
             and not exists (
               select 1 from sweed_orders prior
                where prior.customer_id = so.customer_id
                  and prior.pay_time < so.pay_time
             )
            then true
            else false
          end as is_first_time
        from sweed_orders so
        where so.dealer_id = any($1::bigint[])
          and so.pay_time >= $2 and so.pay_time < $3
      )
      select
        dealer_id,
        count(*) filter (where is_first_time) as new_purchases,
        count(*) filter (where not is_first_time) as returning_purchases,
        sum(coalesce(grand_total_dollars, 0))::numeric as gross_receipts,
        sum(coalesce(subtotal_dollars, 0))::numeric as gross_sales,
        sum(coalesce(subtotal_dollars, 0) - coalesce(discount_dollars, 0))::numeric as net_sales
      from todays_orders
      group by dealer_id
    `,
    [dealerIds, startIso, endIso],
  )

  // Margin — per-item revenue × cost. Mirrors the SQL pattern used
  // by margins.gross_margin_dollars / margins.effective_gm_pct so
  // the daily summary numbers reconcile with the cards beneath.
  const marginPromise = db.query<MarginRow>(
    `
      with todays_items as (
        -- D1: reads materialised sweed_order_items_flat instead of
        -- unrolling sweed_orders.raw_json->'items' per request. f.revenue
        -- mirrors subtotalAmount; f.qty mirrors currentQty (with the same
        -- quantity/qty fallback the flat ingest applies). Live dark-diff
        -- over the rolling 30d window showed 0 priced_revenue/priced_cogs
        -- differences vs the old raw_json path.
        select
          f.dealer_id,
          f.revenue as revenue,
          f.qty as qty,
          sweed_package_cost_as_of_or_earliest(
            f.dealer_id,
            f.inventory_item_id,
            f.pay_time
          ) as unit_cost
        from sweed_order_items_flat f
        where f.dealer_id = any($1::bigint[])
          and f.pay_time >= $2 and f.pay_time < $3
      )
      select
        dealer_id,
        sum(case when unit_cost is not null then revenue else 0 end)::numeric as priced_revenue,
        sum(case when unit_cost is not null then qty * unit_cost else 0 end)::numeric as priced_cogs
      from todays_items
      group by dealer_id
    `,
    [dealerIds, startIso, endIso],
  )

  // Scans — counts per site_slug, partitioned by first-time vs returning.
  // The NOT EXISTS rides on visitor_scans_person_key_time_idx
  // (provider, person_key, COALESCE(scanned_at, ingested_at) DESC).
  const scansPromise = db.query<ScanRow>(
    `
      with todays_scans as (
        select
          vs.site_slug,
          (
            vs.person_key is not null
            and not exists (
              select 1 from visitor_scans prior
              where prior.provider = vs.provider
                and prior.person_key = vs.person_key
                and coalesce(prior.scanned_at, prior.ingested_at) <
                    coalesce(vs.scanned_at, vs.ingested_at)
            )
          ) as is_first_time
        from visitor_scans vs
        where vs.site_slug = any($1::text[])
          and coalesce(vs.scanned_at, vs.ingested_at) >= $2
          and coalesce(vs.scanned_at, vs.ingested_at) < $3
      )
      select
        site_slug,
        count(*) filter (where is_first_time) as new_scans,
        count(*) filter (where not is_first_time) as returning_scans
      from todays_scans
      group by site_slug
    `,
    [siteSlugs, startIso, endIso],
  )

  const [ordersResult, marginResult, scansResult] = await Promise.all([
    ordersPromise,
    marginPromise,
    scansPromise,
  ])

  const ordersByDealer = new Map<number, OrderTotalsRow>(
    ordersResult.rows.map((r) => [Number(r.dealer_id), r]),
  )
  const marginByDealer = new Map<number, MarginRow>(
    marginResult.rows.map((r) => [Number(r.dealer_id), r]),
  )
  const scansBySlug = new Map<string, ScanRow>(
    scansResult.rows.map((r) => [r.site_slug, r]),
  )

  const sites: EssentialsDailySummaryRow[] = SITE_BINDINGS.map((binding) => {
    const orders = ordersByDealer.get(binding.dealerId)
    const margin = marginByDealer.get(binding.dealerId)
    const scans = scansBySlug.get(binding.siteSlug)

    const pricedRevenue = margin ? Number(margin.priced_revenue ?? 0) : 0
    const pricedCogs = margin ? Number(margin.priced_cogs ?? 0) : 0
    const marginDollars = pricedRevenue - pricedCogs
    const gmPct = pricedRevenue > 0 ? round4(marginDollars / pricedRevenue) : null

    return {
      siteKey: binding.siteKey,
      siteLabel: binding.siteLabel,
      newScans: scans ? Number(scans.new_scans ?? 0) : 0,
      returningScans: scans ? Number(scans.returning_scans ?? 0) : 0,
      newPurchases: orders ? Number(orders.new_purchases ?? 0) : 0,
      returningPurchases: orders ? Number(orders.returning_purchases ?? 0) : 0,
      grossReceiptsDollars: orders ? round2(Number(orders.gross_receipts ?? 0)) : 0,
      grossSalesDollars: orders ? round2(Number(orders.gross_sales ?? 0)) : 0,
      netSalesDollars: orders ? round2(Number(orders.net_sales ?? 0)) : 0,
      marginDollars: round2(marginDollars),
      gmPct,
      marginCoverageDollars: round2(pricedRevenue),
    }
  })

  // Totals: sum scalar fields; recompute GM% as the aggregate ratio
  // (NOT the average of per-site percentages, which would be biased
  // toward the smaller site on slow days).
  let totalPricedRevenue = 0
  let totalMarginDollars = 0
  const totals: EssentialsDailySummaryRow = sites.reduce<EssentialsDailySummaryRow>(
    (acc, row) => {
      totalPricedRevenue += row.marginCoverageDollars
      totalMarginDollars += row.marginDollars
      return {
        siteKey: 'totals',
        siteLabel: 'Totals',
        newScans: acc.newScans + row.newScans,
        returningScans: acc.returningScans + row.returningScans,
        newPurchases: acc.newPurchases + row.newPurchases,
        returningPurchases: acc.returningPurchases + row.returningPurchases,
        grossReceiptsDollars: acc.grossReceiptsDollars + row.grossReceiptsDollars,
        grossSalesDollars: acc.grossSalesDollars + row.grossSalesDollars,
        netSalesDollars: acc.netSalesDollars + row.netSalesDollars,
        marginDollars: acc.marginDollars + row.marginDollars,
        // gmPct/marginCoverageDollars overwritten after the fold.
        gmPct: null,
        marginCoverageDollars: acc.marginCoverageDollars + row.marginCoverageDollars,
      }
    },
    {
      siteKey: 'totals',
      siteLabel: 'Totals',
      newScans: 0,
      returningScans: 0,
      newPurchases: 0,
      returningPurchases: 0,
      grossReceiptsDollars: 0,
      grossSalesDollars: 0,
      netSalesDollars: 0,
      marginDollars: 0,
      gmPct: null,
      marginCoverageDollars: 0,
    },
  )
  totals.grossReceiptsDollars = round2(totals.grossReceiptsDollars)
  totals.grossSalesDollars = round2(totals.grossSalesDollars)
  totals.netSalesDollars = round2(totals.netSalesDollars)
  totals.marginDollars = round2(totalMarginDollars)
  totals.marginCoverageDollars = round2(totalPricedRevenue)
  totals.gmPct = totalPricedRevenue > 0 ? round4(totalMarginDollars / totalPricedRevenue) : null

  return {
    asOf: new Date().toISOString(),
    today: {
      startIso,
      endIso,
      nyDate,
    },
    sites,
    totals,
  }
}
