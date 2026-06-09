import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type CatalogPurchaseDetailResponse,
  type CatalogPurchaseFilterOption,
  type CatalogPurchaseHeader,
  type CatalogPurchaseLineDetailResponse,
  type CatalogPurchaseLineKpis,
  type CatalogPurchaseLineSellThrough,
  type CatalogPurchaseListFacets,
  type CatalogPurchaseListHeadline,
  type CatalogPurchaseListRequest,
  type CatalogPurchaseListResponse,
  type CatalogPurchaseListRow,
  type CatalogPurchaseSellThroughSummary,
} from '../../shared/contracts/index.js'
import { getPool } from '../db/pool.js'

// ============================================================================
// Catalog → Purchase Sell-Through query layer.
//
// Static PO facts live in sweed_purchases / sweed_purchase_line_items;
// the dynamic sell-through math is computed on read by joining each
// line's matched_inventory_item_ids[] against sweed_orders.raw_json
// items[]. Because we materialise the metrc_tag → inventoryItemId
// match at ingest time, this is a simple unnest + jsonb_array_elements
// join — no fuzzy matching on the read path.
//
// Headline summaries the operator can answer:
//   * "If I paid just for what has sold so far, what would I be paying?"
//     → sum(unit_cost_dollars × units_sold)
//   * Cost-of-sold (= realised COGS using package cost-as-of, falling
//     back to PO unit cost when the snapshot is missing).
//   * Remaining cost (= unit_cost × remaining_units) and remaining
//     list value (= current list × remaining_units).
// ============================================================================

function dealerIdsForSites(sites: readonly string[]): number[] | null {
  if (sites.length === 0) return null
  const wanted = new Set(sites.map((s) => s.toLowerCase()))
  const ids = HELIOS_PENDING_PURCHASE_SITE_DEALERS.filter((d) =>
    wanted.has(d.siteKey.toLowerCase()),
  ).map((d) => d.dealerId)
  return ids.length > 0 ? ids : []
}

function asNum(v: unknown): number {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}
function asNullableNum(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
function asInt(v: unknown): number {
  return Math.trunc(asNum(v))
}
function asStr(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s.length > 0 ? s : null
}

// --------------------------------------------------------------------------
// One shared per-line sell-through CTE. Used by the list (aggregated to
// PO-grain), detail (line-grain), and item endpoints.
//
// Inputs:
//   $1 = dealer_id array (or null = all dealers)
//   $2 = po_id (text) or null = every PO
//   $3 = line_id (text) or null = every line
//
// Output columns are per-line sell-through values; callers aggregate.
// --------------------------------------------------------------------------

const PER_LINE_CTE = `
  with target_lines as (
    select p.dealer_id, p.po_id, p.site_key, p.delivery_date, p.delivery_at,
           p.payment_due_date, p.order_status_name, p.financial_status_name,
           p.is_cash_on_delivery, p.distributor_name, p.distributor_id,
           p.po_name, p.external_order_id,
           p.po_total_dollars, p.po_subtotal_dollars,
           p.po_discount_amount_dollars, p.po_tax_dollars, p.po_owed_dollars,
           p.fetched_at,
           l.line_id, l.line_index,
           l.product_name, l.sweed_product_id, l.sweed_product_name,
           l.distributor_product_name,
           l.brand_name, l.category_name, l.subcategory_name,
           l.size_label, l.pack_count, l.metrc_tag,
           l.ordered_units, l.unit_cost_dollars, l.extended_cost_dollars,
           l.list_price_dollars_at_ingest,
           l.matched_inventory_item_ids,
           l.package_match_method, l.package_match_confidence,
           l.received_at_min, l.received_at_max
      from sweed_purchases p
      join sweed_purchase_line_items l using (dealer_id, po_id)
     where ($1::bigint[] is null or p.dealer_id = any($1::bigint[]))
       and ($2::text is null or p.po_id = $2)
       and ($3::text is null or l.line_id = $3)
  ),
  line_packages as (
    select tl.dealer_id, tl.po_id, tl.line_id,
           unnest(tl.matched_inventory_item_ids) as inventory_item_id
      from target_lines tl
     where cardinality(tl.matched_inventory_item_ids) > 0
  ),
  sale_items as (
    -- sweed_order_items_flat is the materialised expansion of
    -- sweed_orders.raw_json->items (one row per (dealer, invoice,
    -- item)). Joining against it is an indexed btree lookup on
    -- (dealer_id, inventory_item_id, pay_time) -- vs. the legacy
    -- jsonb_array_elements(raw_json->items) lateral expansion that
    -- iterated millions of intermediate rows per request and made
    -- this page take 15-50s to load. See migration
    -- 048_sweed_order_items_flat.sql and the upsertFlatOrderItems
    -- tail-fill hook in configWorkersSweedOrdersIngestJob.ts.
    select lp.dealer_id, lp.po_id, lp.line_id, lp.inventory_item_id,
           oi.pay_time, oi.qty, oi.revenue
      from line_packages lp
      join target_lines tl
        on tl.dealer_id = lp.dealer_id
       and tl.po_id = lp.po_id
       and tl.line_id = lp.line_id
      join sweed_order_items_flat oi
        on oi.dealer_id = lp.dealer_id
       and oi.inventory_item_id = lp.inventory_item_id
       and oi.pay_time >= coalesce(
         tl.received_at_min,
         tl.delivery_at,
         tl.delivery_date::timestamptz,
         '-infinity'::timestamptz
       )
  ),
  sales_by_line as (
    select si.dealer_id, si.po_id, si.line_id,
           sum(si.qty) as units_sold_to_date,
           sum(si.revenue) as sold_revenue_dollars,
           max(si.pay_time) as last_sold_at,
           sum(
             si.qty * coalesce(
               sweed_package_cost_as_of(si.dealer_id, si.inventory_item_id, si.pay_time),
               -- Same effective-unit-cost fallback used in the outer
               -- select; protects COGS-of-sold when both the package
               -- cost snapshot AND unit_cost_dollars are missing /
               -- 0 (e.g. HR Botanical legacy lines).
               nullif(tl.unit_cost_dollars, 0),
               tl.extended_cost_dollars / nullif(tl.ordered_units, 0),
               0
             )
           ) as cost_of_sold_items_dollars
      from sale_items si
      join target_lines tl
        on tl.dealer_id = si.dealer_id
       and tl.po_id = si.po_id
       and tl.line_id = si.line_id
     group by si.dealer_id, si.po_id, si.line_id
  ),
  package_current_by_line as (
    select lp.dealer_id, lp.po_id, lp.line_id,
           sum(coalesce(cur.current_qty, 0)) as package_current_qty
      from line_packages lp
      left join sweed_package_current cur
        on cur.dealer_id = lp.dealer_id
       and cur.inventory_item_id = lp.inventory_item_id
     group by lp.dealer_id, lp.po_id, lp.line_id
  )
  select tl.*,
         coalesce(s.units_sold_to_date, 0) as units_sold_to_date,
         coalesce(s.sold_revenue_dollars, 0) as sold_revenue_dollars,
         coalesce(s.cost_of_sold_items_dollars, 0) as cost_of_sold_items_dollars,
         -- Effective per-unit cost. The ingest worker normally fills
         -- unit_cost_dollars from distributor_product_price /
         -- discount_product_price / (extended / ordered), but some
         -- vendors (e.g. HR BOTANICAL) send 0 in the per-line unit
         -- price fields and carry the real number only in the
         -- extendedAmount field. The worker now treats a literal 0
         -- as "missing" and falls back, but legacy rows ingested
         -- before that fix still have unit_cost_dollars = 0.0000,
         -- which made every per-line cost ($/sold-through payment,
         -- $/remaining stock, $/adjusted) read as exactly $0 on the
         -- PO detail page. Compute the effective cost here so both
         -- the legacy rows and any future regression are self-
         -- correcting at read time.
         coalesce(
           nullif(tl.unit_cost_dollars, 0),
           tl.extended_cost_dollars / nullif(tl.ordered_units, 0),
           0
         ) as effective_unit_cost_dollars,
         coalesce(
           nullif(tl.unit_cost_dollars, 0),
           tl.extended_cost_dollars / nullif(tl.ordered_units, 0),
           0
         ) * coalesce(s.units_sold_to_date, 0)
           as realised_cost_if_paid_for_sold_only_dollars,
         case
           when cardinality(tl.matched_inventory_item_ids) > 0
             then coalesce(pc.package_current_qty, 0)
           else greatest(tl.ordered_units - coalesce(s.units_sold_to_date, 0), 0)
         end as remaining_units,
         -- ordered - sold - on-hand = units that were paid for but
         -- vanished from the package without showing up in a sale
         -- (shrinkage, breakage, destruction, return-to-distributor,
         -- samples). Only meaningful for matched lines; clamped >= 0
         -- so cross-PO pooling that briefly drives remaining > ordered
         -- doesn't produce a negative "adjusted" entry.
         case
           when cardinality(tl.matched_inventory_item_ids) > 0
             then greatest(
               tl.ordered_units
                 - coalesce(s.units_sold_to_date, 0)
                 - coalesce(pc.package_current_qty, 0),
               0
             )
           else 0
         end as adjusted_units,
         s.last_sold_at,
         coalesce(tl.list_price_dollars_at_ingest, 0) as current_list_price_dollars
    from target_lines tl
    left join sales_by_line s using (dealer_id, po_id, line_id)
    left join package_current_by_line pc using (dealer_id, po_id, line_id)
`

// Row shape returned by the PER_LINE_CTE select.
interface PerLineRow {
  dealer_id: number
  po_id: string
  site_key: string
  delivery_date: string | Date | null
  delivery_at: string | Date | null
  payment_due_date: string | Date | null
  order_status_name: string | null
  financial_status_name: string | null
  is_cash_on_delivery: boolean | null
  distributor_name: string | null
  distributor_id: number | null
  po_name: string | null
  external_order_id: string | null
  po_total_dollars: number | string | null
  po_subtotal_dollars: number | string | null
  po_discount_amount_dollars: number | string | null
  po_tax_dollars: number | string | null
  po_owed_dollars: number | string | null
  fetched_at: string | Date
  line_id: string
  line_index: number
  product_name: string | null
  sweed_product_id: number | null
  sweed_product_name: string | null
  distributor_product_name: string | null
  brand_name: string | null
  category_name: string | null
  subcategory_name: string | null
  size_label: string | null
  pack_count: number | null
  metrc_tag: string | null
  ordered_units: number | string
  unit_cost_dollars: number | string | null
  extended_cost_dollars: number | string | null
  list_price_dollars_at_ingest: number | string | null
  matched_inventory_item_ids: string[]
  package_match_method: string
  package_match_confidence: number | string | null
  received_at_min: string | Date | null
  received_at_max: string | Date | null
  units_sold_to_date: number | string
  sold_revenue_dollars: number | string
  cost_of_sold_items_dollars: number | string
  // PER_LINE_CTE-computed fallback for unit_cost_dollars when the
  // vendor sent 0 / null in the per-line price fields but a usable
  // extendedAmount. Always populated (>= 0).
  effective_unit_cost_dollars: number | string
  realised_cost_if_paid_for_sold_only_dollars: number | string
  remaining_units: number | string
  adjusted_units: number | string
  last_sold_at: string | Date | null
  current_list_price_dollars: number | string
}

function rowToLine(r: PerLineRow): CatalogPurchaseLineSellThrough {
  const ordered = asNum(r.ordered_units)
  const sold = asNum(r.units_sold_to_date)
  const remaining = asNum(r.remaining_units)
  const adjusted = asNum(r.adjusted_units)
  const sellThroughPercent = ordered > 0 ? Math.min(100, (sold / ordered) * 100) : null
  // Prefer the SQL-computed effective unit cost (handles legacy /
  // HR-Botanical-style rows where unit_cost_dollars is literally 0
  // but extended_cost_dollars / ordered_units is correct). The
  // displayed `unitCostDollars` on the page intentionally uses this
  // effective value too — having "unit cost $0" sitting next to a
  // "committed $160 / 20 units" line was the bug the operator caught
  // on PO 107719.
  const unitCost = asNum(r.effective_unit_cost_dollars)
  const listPrice = asNullableNum(r.current_list_price_dollars) ?? 0
  const grossMarginPercent =
    listPrice > 0 && unitCost > 0 ? ((listPrice - unitCost) / listPrice) * 100 : null
  const receivedAt = r.received_at_min ? new Date(r.received_at_min as string) : null
  const daysSinceReceived = receivedAt
    ? Math.max(0, Math.floor((Date.now() - receivedAt.getTime()) / 86_400_000))
    : null
  return {
    dealerId: asInt(r.dealer_id),
    poId: r.po_id,
    lineId: r.line_id,
    lineIndex: asInt(r.line_index),
    productName: r.product_name ?? r.sweed_product_name ?? null,
    distributorProductName: r.distributor_product_name,
    sweedProductId: r.sweed_product_id !== null ? asInt(r.sweed_product_id) : null,
    brandName: r.brand_name,
    categoryName: r.category_name,
    subcategoryName: r.subcategory_name,
    sizeLabel: r.size_label,
    packCount: r.pack_count !== null ? asInt(r.pack_count) : null,
    metrcTag: r.metrc_tag,
    orderedUnits: ordered,
    unitsSoldToDate: sold,
    remainingUnits: remaining,
    unitsAdjusted: adjusted,
    sellThroughPercent,
    daysSinceReceived,
    unitCostDollars: unitCost > 0 ? unitCost : null,
    extendedCostDollars: asNullableNum(r.extended_cost_dollars),
    soldRevenueDollars: asNum(r.sold_revenue_dollars),
    realisedCostIfPaidForSoldOnlyDollars: asNum(r.realised_cost_if_paid_for_sold_only_dollars),
    costOfSoldItemsDollars: asNum(r.cost_of_sold_items_dollars),
    costOfRemainingItemsDollars: unitCost * remaining,
    costOfAdjustedItemsDollars: unitCost * adjusted,
    currentListPriceOutstandingDollars: listPrice * remaining,
    currentListPriceDollars: listPrice > 0 ? listPrice : null,
    grossMarginPercent,
    matchedInventoryItemIds: r.matched_inventory_item_ids ?? [],
    packageMatchMethod: r.package_match_method,
    packageMatchConfidence: asNullableNum(r.package_match_confidence),
  }
}

// --------------------------------------------------------------------------
// List endpoint
// --------------------------------------------------------------------------

// Suppress Sweed/Metrc virtual purchase orders. Their external_order_id
// is the synthetic `V<store>_N<manifest>` shape (e.g. "V623_N39555"),
// optionally prefixed with "#" in some Sweed surfaces. The `_N<digits>`
// requirement deliberately spares real distributor POs that merely
// start with "V" (e.g. "Vireo 638 639 640"). Case-insensitive.
const VIRTUAL_PO_EXCLUSION_CLAUSE = `coalesce(external_order_id, '') !~* '^#?V[0-9]+_N[0-9]+'`

const VALID_SORT_COLUMNS: Record<
  CatalogPurchaseListRequest['sort'],
  string
> = {
  deliveryDate: 'delivery_date',
  paymentDueDate: 'payment_due_date',
  poTotalDollars: 'po_total_dollars',
  distributorName: 'distributor_name',
  unitsSold: 'units_sold',
  unitsRemaining: 'units_remaining',
  unitsAdjusted: 'units_adjusted',
  sellThroughPercent: 'sell_through_percent',
  realisedCostIfPaidForSoldOnlyDollars: 'realised_cost_if_paid_for_sold_only_dollars',
  costOfSoldItemsDollars: 'cost_of_sold_items_dollars',
  costOfRemainingItemsDollars: 'cost_of_remaining_items_dollars',
  costOfAdjustedItemsDollars: 'cost_of_adjusted_items_dollars',
  currentListPriceOutstandingDollars: 'current_list_price_outstanding_dollars',
}

export async function getCatalogPurchaseList(
  req: CatalogPurchaseListRequest,
): Promise<CatalogPurchaseListResponse> {
  const dealerIds = dealerIdsForSites(req.sites)
  // Empty dealerIds (sites passed but none resolved) → empty result.
  if (dealerIds !== null && dealerIds.length === 0) {
    return {
      resolved: {
        page: req.page,
        pageSize: req.pageSize,
        sort: req.sort,
        dir: req.dir,
        totalRows: 0,
      },
      headline: emptyHeadline(),
      facets: emptyFacets(),
      rows: [],
    }
  }
  const pool = getPool()
  const sortCol = VALID_SORT_COLUMNS[req.sort]
  const sortDir = req.dir === 'asc' ? 'asc' : 'desc'

  // Aggregate PER_LINE_CTE results to PO grain, apply filters in an
  // outer where clause so the aggregate columns are filter-able too.
  const baseSql = `
    ${PER_LINE_CTE}
  `
  const aggregateSql = `
    select * from (
      ${baseSql}
    ) per_line
  `

  // We build the aggregated query in a separate CTE that wraps the
  // per-line CTE. Filters that touch only header columns are applied
  // before the aggregate; filters that touch aggregate columns (total
  // amount range, brand contains, product search) get applied in the
  // outer where. Simpler: do everything in a HAVING clause.
  const params: unknown[] = [dealerIds, null, null]
  const filters: string[] = []
  let i = params.length

  // Always hide Sweed/Metrc "virtual purchase orders" — auto-generated
  // POs whose external_order_id is the synthetic `V<store>_N<manifest>`
  // shape (the operator sees these as manifest "#V…" in Sweed). These
  // are never real distributor invoices, so they're suppressed
  // unconditionally on every read (rows, count, headline, facets, and
  // the detail lookup). Constant clause, no bound param — safe literal.
  // NB: a real distributor PO like "Vireo 638 639 640" is NOT matched
  // (the `_N` digits requirement keeps it visible).
  filters.push(VIRTUAL_PO_EXCLUSION_CLAUSE)

  if (req.distributorNames.length > 0) {
    i += 1
    params.push(req.distributorNames)
    filters.push(`distributor_name = any($${i}::text[])`)
  }
  if (req.deliveryFrom) {
    i += 1
    params.push(req.deliveryFrom)
    filters.push(`delivery_date >= $${i}::date`)
  }
  if (req.deliveryTo) {
    i += 1
    params.push(req.deliveryTo)
    filters.push(`delivery_date <= $${i}::date`)
  }
  if (req.paymentDueFrom) {
    i += 1
    params.push(req.paymentDueFrom)
    filters.push(`payment_due_date >= $${i}::date`)
  }
  if (req.paymentDueTo) {
    i += 1
    params.push(req.paymentDueTo)
    filters.push(`payment_due_date <= $${i}::date`)
  }
  if (req.orderStatusNames.length > 0) {
    i += 1
    params.push(req.orderStatusNames)
    filters.push(`order_status_name = any($${i}::text[])`)
  }
  if (req.financialStatusNames.length > 0) {
    i += 1
    params.push(req.financialStatusNames)
    filters.push(`financial_status_name = any($${i}::text[])`)
  }
  if (req.brandNames.length > 0) {
    i += 1
    params.push(req.brandNames)
    filters.push(`brand_name = any($${i}::text[])`)
  }
  if (req.productSearch && req.productSearch.trim().length > 0) {
    const raw = req.productSearch.trim()
    i += 1
    const textParam = i
    params.push(`%${raw.toLowerCase()}%`)
    // The same box doubles as a PO finder: it matches product names AND
    // header identifiers (PO number / Sweed PO id / order name). When the
    // query looks like a money amount ("5159", "$5,159.00") we also match
    // it against the PO face value so the operator can scan to a PO by the
    // dollar figure they're eyeballing in the leftmost column.
    const clauses = [
      `lower(coalesce(product_name,'')) like $${textParam}`,
      `lower(coalesce(distributor_product_name,'')) like $${textParam}`,
      `lower(coalesce(sweed_product_name,'')) like $${textParam}`,
      `lower(coalesce(external_order_id,'')) like $${textParam}`,
      `lower(coalesce(po_name,'')) like $${textParam}`,
      `lower(coalesce(po_id,'')) like $${textParam}`,
    ]
    const amountRaw = raw.replace(/[$,\s]/g, '')
    if (/^\d+(\.\d+)?$/.test(amountRaw)) {
      i += 1
      params.push(`%${amountRaw}%`)
      clauses.push(`coalesce(po_total_dollars::text,'') like $${i}`)
    }
    filters.push(`(${clauses.join(' or ')})`)
  }

  // After line-level filtering, aggregate to PO grain and apply
  // total-amount range against po_total_dollars.
  const havingClauses: string[] = []
  if (req.totalMin !== undefined) {
    i += 1
    params.push(req.totalMin)
    havingClauses.push(`max(po_total_dollars) >= $${i}`)
  }
  if (req.totalMax !== undefined) {
    i += 1
    params.push(req.totalMax)
    havingClauses.push(`max(po_total_dollars) <= $${i}`)
  }
  // Sample-drop suppression: any PO under $2 is almost certainly a
  // distributor sample, not a real buy. Hide by default unless the
  // operator opted in via ?includeSamples=1. Skip when the user has
  // already set their own totalMin so they don't get a confusing
  // double filter.
  if (!req.includeSamples && req.totalMin === undefined) {
    havingClauses.push(`max(po_total_dollars) >= 2`)
  }

  const whereSql = filters.length > 0 ? `where ${filters.join(' and ')}` : ''
  const havingSql = havingClauses.length > 0 ? `having ${havingClauses.join(' and ')}` : ''

  const aggregatedSql = `
    with per_line as (
      ${baseSql}
    ),
    agg as (
      select dealer_id, po_id, site_key,
             max(po_name) as po_name,
             max(external_order_id) as external_order_id,
             max(distributor_name) as distributor_name,
             max(delivery_date) as delivery_date,
             max(payment_due_date) as payment_due_date,
             max(order_status_name) as order_status_name,
             max(financial_status_name) as financial_status_name,
             bool_or(is_cash_on_delivery) as is_cash_on_delivery,
             max(po_total_dollars) as po_total_dollars,
             sum(ordered_units) as units_ordered,
             sum(units_sold_to_date) as units_sold,
             sum(remaining_units) as units_remaining,
             sum(adjusted_units) as units_adjusted,
             case when sum(ordered_units) > 0
                  then least(100, sum(units_sold_to_date) / sum(ordered_units) * 100)
                  else null end as sell_through_percent,
             sum(cost_of_sold_items_dollars) as cost_of_sold_items_dollars,
             sum(realised_cost_if_paid_for_sold_only_dollars) as realised_cost_if_paid_for_sold_only_dollars,
             sum(effective_unit_cost_dollars * remaining_units) as cost_of_remaining_items_dollars,
             sum(effective_unit_cost_dollars * adjusted_units) as cost_of_adjusted_items_dollars,
             sum(coalesce(current_list_price_dollars,0) * remaining_units) as current_list_price_outstanding_dollars,
             sum(sold_revenue_dollars) as sold_revenue_dollars,
             count(*)::int as line_count,
             array_remove(array_agg(distinct brand_name), null) as brand_names,
             array_remove(array_agg(distinct coalesce(product_name, sweed_product_name)), null) as product_names_preview
        from per_line
        ${whereSql}
       group by dealer_id, po_id, site_key
       ${havingSql}
    )
    select * from agg
    order by ${sortCol} ${sortDir} nulls last, delivery_date desc, po_id asc
    limit $${i + 1} offset $${i + 2}
  `
  params.push(req.pageSize)
  params.push((req.page - 1) * req.pageSize)

  const countSql = `
    with per_line as (
      ${baseSql}
    ),
    agg as (
      select dealer_id, po_id,
             max(po_total_dollars) as po_total_dollars
        from per_line
        ${whereSql}
       group by dealer_id, po_id
       ${havingSql}
    )
    select count(*)::int as cnt from agg
  `

  // Headline aggregates across the full filtered set (not just the
  // page).
  const headlineSql = `
    with per_line as (
      ${baseSql}
    ),
    agg as (
      select dealer_id, po_id,
             max(po_total_dollars) as po_total_dollars,
             sum(ordered_units) as units_ordered,
             sum(units_sold_to_date) as units_sold,
             sum(remaining_units) as units_remaining,
             sum(adjusted_units) as units_adjusted,
             sum(cost_of_sold_items_dollars) as cost_of_sold_items_dollars,
             sum(realised_cost_if_paid_for_sold_only_dollars) as realised_cost_if_paid_for_sold_only_dollars,
             sum(effective_unit_cost_dollars * remaining_units) as cost_of_remaining_items_dollars,
             sum(effective_unit_cost_dollars * adjusted_units) as cost_of_adjusted_items_dollars,
             sum(coalesce(current_list_price_dollars,0) * remaining_units) as current_list_price_outstanding_dollars,
             sum(sold_revenue_dollars) as sold_revenue_dollars,
             count(*) as line_count
        from per_line
        ${whereSql}
       group by dealer_id, po_id
       ${havingSql}
    )
    select coalesce(sum(po_total_dollars), 0) as po_total_dollars,
           coalesce(sum(cost_of_sold_items_dollars), 0) as cost_of_sold_items_dollars,
           coalesce(sum(realised_cost_if_paid_for_sold_only_dollars), 0) as realised_cost_if_paid_for_sold_only_dollars,
           coalesce(sum(cost_of_remaining_items_dollars), 0) as cost_of_remaining_items_dollars,
           coalesce(sum(cost_of_adjusted_items_dollars), 0) as cost_of_adjusted_items_dollars,
           coalesce(sum(current_list_price_outstanding_dollars), 0) as current_list_price_outstanding_dollars,
           coalesce(sum(sold_revenue_dollars), 0) as sold_revenue_dollars,
           coalesce(sum(units_ordered), 0) as units_ordered,
           coalesce(sum(units_sold), 0) as units_sold,
           coalesce(sum(units_remaining), 0) as units_remaining,
           coalesce(sum(units_adjusted), 0) as units_adjusted,
           coalesce(sum(line_count), 0)::int as line_count,
           count(*)::int as purchase_count
      from agg
  `

  const [rowsRes, countRes, headlineRes, facetsRes] = await Promise.all([
    pool.query(aggregatedSql, params),
    pool.query(countSql, params.slice(0, params.length - 2)),
    pool.query(headlineSql, params.slice(0, params.length - 2)),
    pool.query(
      `select site_key,
              distributor_name,
              order_status_name,
              financial_status_name,
              brand_names
         from sweed_purchases
        where ($1::bigint[] is null or dealer_id = any($1::bigint[]))
          and ${VIRTUAL_PO_EXCLUSION_CLAUSE}`,
      [dealerIds],
    ),
  ])

  return {
    resolved: {
      page: req.page,
      pageSize: req.pageSize,
      sort: req.sort,
      dir: req.dir,
      totalRows: countRes.rows[0]?.cnt ?? 0,
    },
    headline: rowToHeadline(headlineRes.rows[0]),
    facets: buildFacets(facetsRes.rows),
    rows: rowsRes.rows.map(rowAggToListRow),
  }
}

function emptyHeadline(): CatalogPurchaseListHeadline {
  return {
    poTotalDollars: 0,
    costOfSoldItemsDollars: 0,
    realisedCostIfPaidForSoldOnlyDollars: 0,
    costOfRemainingItemsDollars: 0,
    costOfAdjustedItemsDollars: 0,
    currentListPriceOutstandingDollars: 0,
    soldRevenueDollars: 0,
    unitsOrdered: 0,
    unitsSold: 0,
    unitsRemaining: 0,
    unitsAdjusted: 0,
    purchaseCount: 0,
    lineCount: 0,
  }
}
function emptyFacets(): CatalogPurchaseListFacets {
  return { sites: [], distributors: [], brands: [], orderStatuses: [], financialStatuses: [] }
}

function rowToHeadline(r: unknown): CatalogPurchaseListHeadline {
  if (!r || typeof r !== 'object') return emptyHeadline()
  const row = r as Record<string, unknown>
  return {
    poTotalDollars: asNum(row.po_total_dollars),
    costOfSoldItemsDollars: asNum(row.cost_of_sold_items_dollars),
    realisedCostIfPaidForSoldOnlyDollars: asNum(row.realised_cost_if_paid_for_sold_only_dollars),
    costOfRemainingItemsDollars: asNum(row.cost_of_remaining_items_dollars),
    costOfAdjustedItemsDollars: asNum(row.cost_of_adjusted_items_dollars),
    currentListPriceOutstandingDollars: asNum(row.current_list_price_outstanding_dollars),
    soldRevenueDollars: asNum(row.sold_revenue_dollars),
    unitsOrdered: asNum(row.units_ordered),
    unitsSold: asNum(row.units_sold),
    unitsRemaining: asNum(row.units_remaining),
    unitsAdjusted: asNum(row.units_adjusted),
    purchaseCount: asInt(row.purchase_count),
    lineCount: asInt(row.line_count),
  }
}

function buildFacets(rows: unknown[]): CatalogPurchaseListFacets {
  const siteCounts = new Map<string, number>()
  const distCounts = new Map<string, number>()
  const orderStatusCounts = new Map<string, number>()
  const finStatusCounts = new Map<string, number>()
  const brandCounts = new Map<string, number>()
  for (const r0 of rows) {
    const r = r0 as Record<string, unknown>
    const site = asStr(r.site_key)
    if (site) siteCounts.set(site, (siteCounts.get(site) ?? 0) + 1)
    const dist = asStr(r.distributor_name)
    if (dist) distCounts.set(dist, (distCounts.get(dist) ?? 0) + 1)
    const os = asStr(r.order_status_name)
    if (os) orderStatusCounts.set(os, (orderStatusCounts.get(os) ?? 0) + 1)
    const fs = asStr(r.financial_status_name)
    if (fs) finStatusCounts.set(fs, (finStatusCounts.get(fs) ?? 0) + 1)
    const brands = r.brand_names
    if (Array.isArray(brands)) {
      for (const b of brands) {
        const v = asStr(b)
        if (v) brandCounts.set(v, (brandCounts.get(v) ?? 0) + 1)
      }
    }
  }
  function toOptions(m: Map<string, number>): CatalogPurchaseFilterOption[] {
    return [...m.entries()]
      .map(([id, count]) => ({ id, label: id, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  }
  return {
    sites: toOptions(siteCounts),
    distributors: toOptions(distCounts),
    orderStatuses: toOptions(orderStatusCounts),
    financialStatuses: toOptions(finStatusCounts),
    brands: toOptions(brandCounts).slice(0, 200),
  }
}

function rowAggToListRow(r: unknown): CatalogPurchaseListRow {
  const row = r as Record<string, unknown>
  return {
    dealerId: asInt(row.dealer_id),
    siteKey: String(row.site_key ?? ''),
    poId: String(row.po_id),
    poName: asStr(row.po_name),
    externalOrderId: asStr(row.external_order_id),
    distributorName: asStr(row.distributor_name),
    deliveryDate: coerceDate(row.delivery_date),
    paymentDueDate: coerceDate(row.payment_due_date),
    orderStatusName: asStr(row.order_status_name),
    financialStatusName: asStr(row.financial_status_name),
    isCashOnDelivery: row.is_cash_on_delivery as boolean | null,
    poTotalDollars: asNullableNum(row.po_total_dollars),
    unitsOrdered: asNum(row.units_ordered),
    unitsSold: asNum(row.units_sold),
    unitsRemaining: asNum(row.units_remaining),
    unitsAdjusted: asNum(row.units_adjusted),
    sellThroughPercent: asNullableNum(row.sell_through_percent),
    costOfSoldItemsDollars: asNum(row.cost_of_sold_items_dollars),
    realisedCostIfPaidForSoldOnlyDollars: asNum(row.realised_cost_if_paid_for_sold_only_dollars),
    costOfRemainingItemsDollars: asNum(row.cost_of_remaining_items_dollars),
    costOfAdjustedItemsDollars: asNum(row.cost_of_adjusted_items_dollars),
    currentListPriceOutstandingDollars: asNum(row.current_list_price_outstanding_dollars),
    soldRevenueDollars: asNum(row.sold_revenue_dollars),
    lineCount: asInt(row.line_count),
    brandNames: Array.isArray(row.brand_names) ? (row.brand_names as string[]) : [],
    productNamesPreview: Array.isArray(row.product_names_preview)
      ? (row.product_names_preview as string[]).slice(0, 5)
      : [],
  }
}

function coerceDate(v: unknown): string | null {
  if (!v) return null
  if (typeof v === 'string') return v.slice(0, 10)
  if (v instanceof Date) {
    const y = v.getUTCFullYear()
    const m = v.getUTCMonth() + 1
    const d = v.getUTCDate()
    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }
  return null
}

// --------------------------------------------------------------------------
// Detail (PO) endpoint
// --------------------------------------------------------------------------

export async function getCatalogPurchaseDetail(args: {
  dealerId: number
  poId: string
}): Promise<CatalogPurchaseDetailResponse | null> {
  const pool = getPool()
  const headerRes = await pool.query(
    // Virtual purchase orders are hidden everywhere on this page family,
    // including direct-URL detail loads (they have no real invoice to
    // reconcile against).
    `select * from sweed_purchases
      where dealer_id = $1 and po_id = $2
        and ${VIRTUAL_PO_EXCLUSION_CLAUSE}`,
    [args.dealerId, args.poId],
  )
  if (headerRes.rows.length === 0) return null
  const h = headerRes.rows[0] as Record<string, unknown>

  const lineRes = await pool.query<PerLineRow>(
    `${PER_LINE_CTE} order by tl.line_index asc`,
    [[args.dealerId], args.poId, null],
  )
  const lines = lineRes.rows.map(rowToLine)

  const summary = aggregateLinesToSummary(lines, asNullableNum(h.po_total_dollars))

  const header: CatalogPurchaseHeader = {
    dealerId: asInt(h.dealer_id),
    siteKey: String(h.site_key ?? ''),
    poId: String(h.po_id),
    poName: asStr(h.po_name),
    externalOrderId: asStr(h.external_order_id),
    deliveryDate: coerceDate(h.delivery_date),
    paymentDueDate: coerceDate(h.payment_due_date),
    orderStatusName: asStr(h.order_status_name),
    financialStatusName: asStr(h.financial_status_name),
    isCashOnDelivery: h.is_cash_on_delivery as boolean | null,
    distributorId: h.distributor_id !== null ? asInt(h.distributor_id) : null,
    distributorName: asStr(h.distributor_name),
    poTotalDollars: asNullableNum(h.po_total_dollars),
    poSubtotalDollars: asNullableNum(h.po_subtotal_dollars),
    poDiscountAmountDollars: asNullableNum(h.po_discount_amount_dollars),
    poTaxDollars: asNullableNum(h.po_tax_dollars),
    poOwedDollars: asNullableNum(h.po_owed_dollars),
    lineCount: asInt(h.line_count),
    fetchedAt: h.fetched_at instanceof Date ? h.fetched_at.toISOString() : String(h.fetched_at),
  }
  return { purchase: header, summary, lines }
}

function aggregateLinesToSummary(
  lines: CatalogPurchaseLineSellThrough[],
  poTotal: number | null,
): CatalogPurchaseSellThroughSummary {
  let costOfSold = 0
  let realisedIfSoldOnly = 0
  let costOfRemaining = 0
  let costOfAdjusted = 0
  let listOutstanding = 0
  let soldRevenue = 0
  let unitsOrdered = 0
  let unitsSold = 0
  let unitsRemaining = 0
  let unitsAdjusted = 0
  let matched = 0
  for (const l of lines) {
    costOfSold += l.costOfSoldItemsDollars
    realisedIfSoldOnly += l.realisedCostIfPaidForSoldOnlyDollars
    costOfRemaining += l.costOfRemainingItemsDollars
    costOfAdjusted += l.costOfAdjustedItemsDollars
    listOutstanding += l.currentListPriceOutstandingDollars
    soldRevenue += l.soldRevenueDollars
    unitsOrdered += l.orderedUnits
    unitsSold += l.unitsSoldToDate
    unitsRemaining += l.remainingUnits
    unitsAdjusted += l.unitsAdjusted
    if (l.matchedInventoryItemIds.length > 0) matched += 1
  }
  return {
    poTotalDollars: poTotal,
    costOfSoldItemsDollars: costOfSold,
    realisedCostIfPaidForSoldOnlyDollars: realisedIfSoldOnly,
    costOfRemainingItemsDollars: costOfRemaining,
    costOfAdjustedItemsDollars: costOfAdjusted,
    currentListPriceOutstandingDollars: listOutstanding,
    soldRevenueDollars: soldRevenue,
    unitsOrdered,
    unitsSold,
    unitsRemaining,
    unitsAdjusted,
    matchedLineCount: matched,
    totalLineCount: lines.length,
  }
}

// --------------------------------------------------------------------------
// Per-line item detail endpoint
// --------------------------------------------------------------------------

export async function getCatalogPurchaseLineDetail(args: {
  dealerId: number
  poId: string
  lineId: string
}): Promise<CatalogPurchaseLineDetailResponse | null> {
  const detail = await getCatalogPurchaseDetail({ dealerId: args.dealerId, poId: args.poId })
  if (!detail) return null
  const line = detail.lines.find((l) => l.lineId === args.lineId)
  if (!line) return null

  const pool = getPool()
  // 7d/30d/90d velocity for the line's matched packages — straight
  // jsonb scan over sweed_orders since matched inventory ids are
  // already known.
  const kpis = await computeLineKpis(line, pool)

  const embed = {
    sites: [detail.purchase.siteKey],
    categoryNames: line.categoryName ? [line.categoryName] : [],
    subcategoryNames: line.subcategoryName ? [line.subcategoryName] : [],
    brandNames: line.brandName ? [line.brandName] : [],
    sizes: line.sizeLabel ? [line.sizeLabel] : [],
    highlightSweedProductId: line.sweedProductId,
    highlightInventoryItemIds: line.matchedInventoryItemIds,
    highlightQuery: line.productName ?? line.distributorProductName ?? '',
    defaultWindowDays: 90,
  }

  return { purchase: detail.purchase, line, kpis, embed }
}

async function computeLineKpis(
  line: CatalogPurchaseLineSellThrough,
  pool: ReturnType<typeof getPool>,
): Promise<CatalogPurchaseLineKpis> {
  if (line.matchedInventoryItemIds.length === 0) {
    return {
      unitsSold7d: 0,
      unitsSold30d: 0,
      unitsSold90d: 0,
      velocityUnitsPerDay7d: null,
      velocityUnitsPerDay30d: null,
      velocityUnitsPerDay90d: null,
      revenue90dDollars: 0,
      avgUnitPriceDollars90d: null,
      grossMarginPercent90d: null,
      currentListPriceDollars: line.currentListPriceDollars,
      currentQtyOnHand: null,
    }
  }
  const res = await pool.query<{
    units_sold_7d: string | number
    units_sold_30d: string | number
    units_sold_90d: string | number
    revenue_90d: string | number
    cost_90d: string | number
    current_qty: string | number | null
  }>(
    // Use sweed_order_items_flat (materialised raw_json->items) so
    // this is an indexed btree scan, not a per-request lateral
    // expansion of every order's JSON. See migration
    // 048_sweed_order_items_flat.sql.
    `with sales as (
       select oi.qty, oi.revenue, oi.pay_time
         from sweed_order_items_flat oi
        where oi.dealer_id = $1
          and oi.inventory_item_id = any($2::text[])
     )
     select
       coalesce(sum(qty) filter (where pay_time >= now() - interval '7 days'), 0)  as units_sold_7d,
       coalesce(sum(qty) filter (where pay_time >= now() - interval '30 days'), 0) as units_sold_30d,
       coalesce(sum(qty) filter (where pay_time >= now() - interval '90 days'), 0) as units_sold_90d,
       coalesce(sum(revenue) filter (where pay_time >= now() - interval '90 days'), 0) as revenue_90d,
       0::numeric as cost_90d,
       (select coalesce(sum(current_qty), 0)
          from sweed_package_current
         where dealer_id = $1 and inventory_item_id = any($2::text[])) as current_qty
       from sales`,
    [line.dealerId, line.matchedInventoryItemIds],
  )
  const r = res.rows[0]
  const u7 = asNum(r?.units_sold_7d)
  const u30 = asNum(r?.units_sold_30d)
  const u90 = asNum(r?.units_sold_90d)
  const rev90 = asNum(r?.revenue_90d)
  const avgPx = u90 > 0 ? rev90 / u90 : null
  const unitCost = line.unitCostDollars ?? 0
  const gmPct = avgPx && avgPx > 0 && unitCost > 0 ? ((avgPx - unitCost) / avgPx) * 100 : null
  return {
    unitsSold7d: u7,
    unitsSold30d: u30,
    unitsSold90d: u90,
    velocityUnitsPerDay7d: u7 / 7,
    velocityUnitsPerDay30d: u30 / 30,
    velocityUnitsPerDay90d: u90 / 90,
    revenue90dDollars: rev90,
    avgUnitPriceDollars90d: avgPx,
    grossMarginPercent90d: gmPct,
    currentListPriceDollars: line.currentListPriceDollars,
    currentQtyOnHand: r?.current_qty !== undefined && r?.current_qty !== null ? asNum(r.current_qty) : null,
  }
}
