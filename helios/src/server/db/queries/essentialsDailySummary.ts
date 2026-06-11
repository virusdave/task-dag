import {
  HELIOS_BUSINESS_DAY_START_HOUR,
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type EssentialsDailySummaryResponse,
  type EssentialsDailySummaryRow,
} from '../../../shared/contracts/index.js'
import { getPool, type Queryable } from '../pool.js'

// ============================================================================
// Essentials → "today, per site" daily summary.
//
// Per repo canon (AGENTS.md + shared/contracts/domain/businessDay.ts):
// all aggregate / display work uses the NYC business day. "Today" here
// is the current LOGICAL BUSINESS DAY in America/New_York — the
// business day rolls over at 08:00 NY (store open), not at calendar
// midnight. So between 00:00 and 07:59:59 NY the banner still shows the
// previous business day's sales (including any pre-open prepaid pickups
// / preorders placed before 08:00), and only flips to the new day at
// 08:00 NY.
//
// Concretely the window is `[businessDayStart, now())` where
//   businessDayStart_NY  = date_trunc('day', now_NY − 8h) + 8h
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
//   * netSales       = sum(subtotal_dollars)                 — pre-tax, POST-discount (booked)
//   * netReceipts    = sum(grand_total_dollars)              — incl tax, POST-discount (drawer)
//   * grossSales     = netSales + Σ ex-tax line discount     — pre-tax, PRE-discount (list)
//   * grossReceipts  = netReceipts + Σ OTD line discount     — incl tax, PRE-discount (list)
//     [Sweed's header `subtotalAmount` is POST-discount (= Σ line
//      subtotalAmount), and the header `discount_dollars` column is
//      ~always 0, so the discount is reconstructed from the line items:
//      `promoAmount` + `managerDiscount.amount` (both tax-inclusive),
//      with the ex-tax portion taken via each line's own tax ratio.
//      See sweedOrdersQueries.ts for the matching /metrics definitions.]
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
  net_receipts: string | null
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
  // the wall clock crosses the 08:00-NY business-day boundary while
  // we're loading. Business day = NY local time shifted back 8h then
  // truncated; see file header for the rationale.
  const shift = `interval '${HELIOS_BUSINESS_DAY_START_HOUR} hours'`
  const dayResult = await db.query<NyDayRow>(`
    with bd as (
      select
        date_trunc(
          'day',
          (now() at time zone 'America/New_York') - ${shift}
        ) as business_day_ny
    )
    select
      ((business_day_ny + ${shift}) at time zone 'America/New_York') as start_iso,
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
          so.tax_dollars,
          -- Promo / manager discount reconstructed from the line items
          -- (header discount_dollars is ~always 0). Sweed exposes it only
          -- in tax-inclusive (OTD) terms; we also derive the ex-tax
          -- portion via each line's own tax ratio. Canceled lines skipped.
          coalesce(ld.otd_discount, 0) as otd_discount,
          coalesce(ld.extax_discount, 0) as extax_discount,
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
        left join lateral (
          select
            sum(otd) as otd_discount,
            sum(otd * case when sa + ta > 0 then sa / (sa + ta) else 0 end) as extax_discount
          from (
            select
              ( coalesce(nullif(item->>'promoAmount','')::numeric, 0)
                + coalesce(nullif(item->'managerDiscount'->>'amount','')::numeric, 0) ) as otd,
              coalesce(nullif(item->>'subtotalAmount','')::numeric, 0) as sa,
              coalesce(nullif(item->>'taxesAmount','')::numeric, 0) as ta
            from jsonb_array_elements(so.raw_json->'items') as item
            where lower(coalesce(item->'invoiceItemStatus'->>'name', '')) <> 'canceled'
          ) lines
        ) ld on true
        where so.dealer_id = any($1::bigint[])
          and so.pay_time >= $2 and so.pay_time < $3
          -- A fully-cancelled order is not a purchase and contributes
          -- no revenue: drop it from counts AND sales/receipts. (Order
          -- status is spelled 'Cancelled'; line status is 'Canceled'.)
          and lower(coalesce(so.raw_json->'invoiceStatus'->>'name', '')) <> 'cancelled'
      )
      select
        dealer_id,
        count(*) filter (where is_first_time) as new_purchases,
        count(*) filter (where not is_first_time) as returning_purchases,
        -- Gross = pre-discount (list); Net = post-discount (booked).
        sum(coalesce(grand_total_dollars, 0) + otd_discount)::numeric as gross_receipts,
        sum(coalesce(subtotal_dollars, 0) + extax_discount)::numeric as gross_sales,
        sum(coalesce(subtotal_dollars, 0))::numeric as net_sales,
        sum(coalesce(grand_total_dollars, 0))::numeric as net_receipts
      from todays_orders
      group by dealer_id
    `,
    [dealerIds, startIso, endIso],
  )

  // Margin — LIVE / TODAY basis. This is deliberately NOT the Paid-only
  // item-level basis used by the historical /metrics margin charts (see
  // sweedPackageSnapshotsQueries.ts). Today's orders are live in-flight
  // kiosk/pickup orders that are still 'New' / 'In Process', not yet
  // 'Paid'. Sweed's order-LIST feed zeroes the per-item revenue
  // (subtotalAmount) for non-final lines while the ORDER HEADER total
  // (sweed_orders.subtotal_dollars) is already correct, and it also
  // drifts per-line currentQty to 0 for 'In Process' lines. The
  // pre-2026-06 calc paired item-level revenue with item-level
  // qty × cost, so it charged COGS against zero item-revenue and showed
  // e.g. Midtown −57% GM on a day that was really ~+58%.
  //
  // So for the live banner we compute margin per ORDER:
  //   * revenue = order-header subtotal_dollars (reliable even pre-Paid)
  //   * COGS    = Σ over non-canceled lines of expectedQty × unit_cost
  //              (expectedQty is the ordered/sold quantity; currentQty
  //               drifts to 0 before settlement)
  //   * an order is excluded from BOTH revenue and COGS if ANY of its
  //     non-canceled, positive-qty lines has an unknown wholesale cost
  //     (so a partial-cost order can't inflate the GM%). With current
  //     100% cost coverage this guard is a no-op, but it keeps the ratio
  //     honest if coverage ever drops.
  // Fully-cancelled orders are excluded outright (margin_orders WHERE):
  // their header subtotal is frequently NON-zero in Sweed's feed even
  // though every line is canceled (COGS=0), so leaving them in would
  // add pure revenue with no cost and inflate GM%. Partially-canceled
  // orders keep their non-canceled lines for COGS while the canceled
  // lines are dropped via is_canceled.
  const marginPromise = db.query<MarginRow>(
    `
      with order_lines as (
        select
          f.dealer_id,
          f.invoice_id,
          (f.raw_item->'invoiceItemStatus'->>'name') = 'Canceled' as is_canceled,
          coalesce(nullif(f.raw_item->>'expectedQty', '')::numeric, f.qty, 0) as qty,
          sweed_package_cost_as_of_or_earliest(
            f.dealer_id,
            f.inventory_item_id,
            f.pay_time
          ) as unit_cost
        from sweed_order_items_flat f
        where f.dealer_id = any($1::bigint[])
          and f.pay_time >= $2 and f.pay_time < $3
      ),
      order_cogs as (
        select
          dealer_id,
          invoice_id,
          sum(case when not is_canceled then qty * coalesce(unit_cost, 0) else 0 end) as order_cogs,
          bool_or(not is_canceled and qty > 0 and unit_cost is null) as missing_cost
        from order_lines
        group by dealer_id, invoice_id
      ),
      margin_orders as (
        select so.dealer_id, so.invoice_id, coalesce(so.subtotal_dollars, 0) as subtotal_dollars
        from sweed_orders so
        where so.dealer_id = any($1::bigint[])
          and so.pay_time >= $2 and so.pay_time < $3
          -- Exclude fully-cancelled orders: their header subtotal is
          -- often non-zero in Sweed's feed while every line is canceled
          -- (so COGS=0), which would otherwise add pure revenue with no
          -- cost and inflate GM%. (Order status is spelled 'Cancelled'.)
          and lower(coalesce(so.raw_json->'invoiceStatus'->>'name', '')) <> 'cancelled'
      )
      select
        o.dealer_id,
        sum(case when not coalesce(oc.missing_cost, false) then o.subtotal_dollars else 0 end)::numeric as priced_revenue,
        sum(case when not coalesce(oc.missing_cost, false) then coalesce(oc.order_cogs, 0) else 0 end)::numeric as priced_cogs
      from margin_orders o
      left join order_cogs oc
        on oc.dealer_id = o.dealer_id and oc.invoice_id = o.invoice_id
      group by o.dealer_id
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
      netReceiptsDollars: orders ? round2(Number(orders.net_receipts ?? 0)) : 0,
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
        netReceiptsDollars: acc.netReceiptsDollars + row.netReceiptsDollars,
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
      netReceiptsDollars: 0,
      marginDollars: 0,
      gmPct: null,
      marginCoverageDollars: 0,
    },
  )
  totals.grossReceiptsDollars = round2(totals.grossReceiptsDollars)
  totals.grossSalesDollars = round2(totals.grossSalesDollars)
  totals.netSalesDollars = round2(totals.netSalesDollars)
  totals.netReceiptsDollars = round2(totals.netReceiptsDollars)
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
