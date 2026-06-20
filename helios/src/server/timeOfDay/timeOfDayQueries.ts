import {
  HELIOS_BUSINESS_DAY_START_HOUR,
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  HELIOS_RETAIL_TZ,
  type TimeOfDayCell,
  type TimeOfDayFulfillmentSlice,
  type TimeOfDayResponse,
} from '../../shared/contracts/index.js'
import { getPool } from '../db/pool.js'
import {
  FULFILLMENT_SERIES_SQL_EXPR_SO,
  LINE_EXTAX_DISCOUNT_EXPR,
  LINE_OTD_DISCOUNT_EXPR,
  NON_CANCELLED_ORDER_SQL,
} from '../metrics/_real/sweedOrdersQueries.js'
import { COGS_EXPR, REVENUE_EXPR } from '../metrics/_real/sweedPackageSnapshotsQueries.js'

// ---------------------------------------------------------------------------
// Time-of-day analytics query.
//
// Returns a weekday × hour grid of order economics for a site/range/slice.
// Weekday is the BUSINESS weekday (day rolls at 08:00 ET); hour is the
// local (America/New_York) wall-clock hour. Money is reported as all four
// bases per cell so the client can switch basis without a refetch; the
// FULFILLMENT slice is a server-side row filter (refetch on change).
//
// See shared/contracts/api/timeOfDay.ts for the exact basis definitions
// and the occurrence-count semantics.
// ---------------------------------------------------------------------------

/** Resolve site keys → Sweed dealer ids (empty = all sites). Mirrors the
 *  local helper every other analytics query module carries. */
function resolveDealerIds(sites: readonly string[]): number[] {
  if (sites.length === 0) {
    return HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((d) => d.dealerId)
  }
  const wanted = new Set(sites.map((s) => s.toLowerCase()))
  return HELIOS_PENDING_PURCHASE_SITE_DEALERS.filter((d) =>
    wanted.has(d.siteKey.toLowerCase()),
  ).map((d) => d.dealerId)
}

/** SQL predicate (param-free) narrowing to the requested fulfillment
 *  slice. `slice` is a validated enum value, never raw user input, so
 *  inlining the literal is safe. `delivery` folds both delivery variants. */
function fulfillmentPredicate(slice: TimeOfDayFulfillmentSlice): string {
  const cls = `(${FULFILLMENT_SERIES_SQL_EXPR_SO})`
  switch (slice) {
    case 'all':
      return ''
    case 'delivery':
      return `and ${cls} in ('delivery_prepaid', 'delivery_cod')`
    case 'pickup':
      return `and ${cls} = 'pickup'`
    case 'pickup_prepaid':
      return `and ${cls} = 'pickup_prepaid'`
    case 'kiosk':
      return `and ${cls} = 'kiosk'`
    case 'in_store':
      return `and ${cls} = 'in_store'`
  }
}

const TZ = HELIOS_RETAIL_TZ
const SHIFT = `interval '${HELIOS_BUSINESS_DAY_START_HOUR} hours'`

/** Business weekday (Postgres dow 0–6) of an order: shift the local
 *  wall-clock time back by the 08:00 rollover, then take dow. */
const BUSINESS_WEEKDAY_EXPR = `extract(dow from ((so.pay_time at time zone '${TZ}') - ${SHIFT}))::int`
/** Local (NY) wall-clock hour 0–23 of the sale instant. */
const LOCAL_HOUR_EXPR = `extract(hour from (so.pay_time at time zone '${TZ}'))::int`

function num(v: unknown): number {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

export interface TimeOfDayQueryArgs {
  readonly sites: readonly string[]
  readonly from: Date
  readonly to: Date
  readonly fulfillment: TimeOfDayFulfillmentSlice
}

export async function queryTimeOfDayGrid(
  args: TimeOfDayQueryArgs,
): Promise<TimeOfDayResponse> {
  const dealerIds = resolveDealerIds(args.sites)
  const fromIso = args.from.toISOString()
  const toIso = args.to.toISOString()
  const base: Omit<TimeOfDayResponse, 'cells' | 'occurrencesByWeekday'> = {
    from: fromIso,
    to: toIso,
    sites: [...args.sites],
    fulfillment: args.fulfillment,
  }

  if (dealerIds.length === 0) {
    return { ...base, occurrencesByWeekday: [0, 0, 0, 0, 0, 0, 0], cells: [] }
  }

  const pool = getPool()

  // 1) Cell aggregates: per (business weekday, local hour).
  const gridSql = `
    with invoice_margin as (
      select f.dealer_id, f.invoice_id,
             sum(${REVENUE_EXPR} - ${COGS_EXPR})::numeric as margin_dollars
        from sweed_order_items_flat f
       where f.dealer_id = any($1::bigint[])
         and f.pay_time >= $2::timestamptz and f.pay_time < $3::timestamptz
       group by f.dealer_id, f.invoice_id
    )
    select
      ${BUSINESS_WEEKDAY_EXPR} as weekday,
      ${LOCAL_HOUR_EXPR} as hour,
      -- Money basis definitions match the Essentials / Sales-ops metrics
      -- (see sweedOrdersQueries.ts): subtotal_dollars is ex-tax and
      -- POST-discount (= net sales); grand_total_dollars is incl-tax and
      -- POST-discount (= net receipts). The header discount column is
      -- ~always 0, so GROSS (pre-discount) is reconstructed by adding the
      -- per-line discount (ex-tax for sales, OTD for receipts).
      sum(coalesce(so.subtotal_dollars, 0) + coalesce(d.extax_disc, 0))::numeric as gross_sales,
      sum(coalesce(so.subtotal_dollars, 0))::numeric as net_sales,
      sum(coalesce(so.grand_total_dollars, 0) + coalesce(d.otd_disc, 0))::numeric as gross_receipts,
      sum(coalesce(so.grand_total_dollars, 0))::numeric as net_receipts,
      sum(coalesce(im.margin_dollars, 0))::numeric as margin,
      count(*)::int as orders
    from sweed_orders so
    left join invoice_margin im
      on im.dealer_id = so.dealer_id and im.invoice_id = so.invoice_id
    left join lateral (
      select sum(${LINE_EXTAX_DISCOUNT_EXPR}) as extax_disc,
             sum(${LINE_OTD_DISCOUNT_EXPR}) as otd_disc
        from jsonb_array_elements(so.raw_json->'items') as item
       where lower(coalesce(item->'invoiceItemStatus'->>'name', '')) <> 'canceled'
    ) d on true
    where so.dealer_id = any($1::bigint[])
      and so.pay_time >= $2::timestamptz and so.pay_time < $3::timestamptz
      ${NON_CANCELLED_ORDER_SQL}
      ${fulfillmentPredicate(args.fulfillment)}
    group by 1, 2
  `

  // 2) Occurrence denominators: business-days of each weekday in window.
  //    Spine runs from businessDate(from) to businessDate(to - epsilon)
  //    so the exclusive upper bound never adds a phantom extra day.
  const occSql = `
    select extract(dow from d)::int as weekday, count(*)::int as occurrences
      from generate_series(
        (date_trunc('day', ($1::timestamptz at time zone '${TZ}') - ${SHIFT}))::date,
        (date_trunc('day', (($2::timestamptz - interval '1 microsecond') at time zone '${TZ}') - ${SHIFT}))::date,
        interval '1 day'
      ) d
     group by 1
  `

  const [gridRes, occRes] = await Promise.all([
    pool.query(gridSql, [dealerIds, fromIso, toIso]),
    pool.query(occSql, [fromIso, toIso]),
  ])

  const occurrencesByWeekday = [0, 0, 0, 0, 0, 0, 0]
  for (const r of occRes.rows as Array<{ weekday: number; occurrences: number }>) {
    const w = num(r.weekday)
    if (w >= 0 && w <= 6) occurrencesByWeekday[w] = num(r.occurrences)
  }

  const cells: TimeOfDayCell[] = (gridRes.rows as Array<Record<string, unknown>>).map((r) => ({
    weekday: num(r.weekday),
    hour: num(r.hour),
    grossSales: num(r.gross_sales),
    netSales: num(r.net_sales),
    grossReceipts: num(r.gross_receipts),
    netReceipts: num(r.net_receipts),
    margin: num(r.margin),
    orders: num(r.orders),
  }))

  return { ...base, occurrencesByWeekday, cells }
}
