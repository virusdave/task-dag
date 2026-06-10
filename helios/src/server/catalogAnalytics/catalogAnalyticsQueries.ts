import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type CatalogAnalyticsFiltersResponse,
  type CatalogAnalyticsPoint,
  type CatalogAnalyticsPointsResponse,
  type CatalogFilterOption,
  type MetricsEntityKind,
  type MetricsEntityRankingRow,
  type MetricsEntityRankingsResponse,
} from '../../shared/contracts/index.js'
import { getPool } from '../db/pool.js'
import { bucketLocalExpr } from '../metrics/bucketSelectSql.js'

// ============================================================================
// Catalog analytics SQL helpers
//
// Backs the /metrics → "Catalog analytics" tab. Returns per-variant
// (per inventory_item_id) aggregates so the SPA can render hover-able
// scatter plots.
//
// Joins are conceptually:
//
//   sweed_package_current cur   (one row per (dealer, inventory_item))
//     ↳ wholesale_cost_dollars, current/available_qty, lab_thc/cbd_pct,
//       product/category/subcategory/brand/size metadata
//   LEFT JOIN aggregated sales (sweed_orders, raw_json items) over [from, to]
//     ↳ units_sold, revenue, cogs, invoice_count
//
// Both filter and points endpoints share the same dealer-id resolution
// against the in-process site registry — never splice strings into SQL.
// ============================================================================

const DEFAULT_WINDOW_DAYS = 90

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

function asStr(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v)
  return s.length > 0 ? s : null
}

/**
 * Parse a Sweed `sizeName` string and return its numeric unit size in
 * grams + milligrams (whichever the input expresses, never both).
 *
 *   "1g"     → { grams: 1,    mg: null }
 *   "3.5g"   → { grams: 3.5,  mg: null }
 *   "0.5g"   → { grams: 0.5,  mg: null }
 *   "10mg"   → { grams: null, mg: 10 }
 *   "100 MG" → { grams: null, mg: 100 }
 *   "1oz"    → { grams: 28.3495, mg: null }
 *   "1ct" / "Each" / unparseable → { grams: null, mg: null }
 *
 * Returned in a single object so the caller doesn't have to invoke
 * two regexes per row. `mg` parsing takes precedence — "10mg" must
 * not be misread as 10g via the `g` branch.
 */
function parseUnitSize(sizeLabel: string | null): {
  grams: number | null
  mg: number | null
} {
  if (!sizeLabel) return { grams: null, mg: null }
  const s = sizeLabel.trim().toLowerCase()
  if (s.length === 0) return { grams: null, mg: null }
  // Try mg first (otherwise "10mg" matches the `g` branch as 10g).
  const mgMatch = s.match(/(\d+(?:\.\d+)?)\s*mg\b/)
  if (mgMatch?.[1]) {
    const n = Number.parseFloat(mgMatch[1])
    if (Number.isFinite(n) && n > 0) return { grams: null, mg: n }
  }
  // Grams — require a word boundary to avoid "mg".
  const gMatch = s.match(/(\d+(?:\.\d+)?)\s*g\b/)
  if (gMatch?.[1]) {
    const n = Number.parseFloat(gMatch[1])
    if (Number.isFinite(n) && n > 0) return { grams: n, mg: null }
  }
  // Ounces — convert to grams (1 oz = 28.3495 g, ish; precise enough
  // for the scatter / for "total grams sold" aggregates).
  const ozMatch = s.match(/(\d+(?:\.\d+)?)\s*oz\b/)
  if (ozMatch?.[1]) {
    const n = Number.parseFloat(ozMatch[1])
    if (Number.isFinite(n) && n > 0) return { grams: n * 28.3495, mg: null }
  }
  return { grams: null, mg: null }
}

// ============================ Filters endpoint =============================

export interface CatalogAnalyticsFiltersArgs {
  readonly sites: readonly string[]
  readonly categoryIds?: readonly string[]
  readonly subcategoryIds?: readonly string[]
  readonly brandIds?: readonly string[]
  readonly distributorNames?: readonly string[]
  readonly sizes?: readonly string[]
  readonly packCounts?: readonly string[]
}

export async function getCatalogAnalyticsFilters(
  opts: CatalogAnalyticsFiltersArgs,
): Promise<CatalogAnalyticsFiltersResponse> {
  const dealerIds = resolveDealerIds(opts.sites)
  if (dealerIds.length === 0) {
    return {
      categories: [],
      subcategories: [],
      brands: [],
      distributors: [],
      sizes: [],
      packCounts: [],
    }
  }
  const pool = getPool()

  const categoryIds = opts.categoryIds ?? []
  const subcategoryIds = opts.subcategoryIds ?? []
  const brandIds = opts.brandIds ?? []
  const distributorNames = opts.distributorNames ?? []
  const sizes = opts.sizes ?? []
  const packCounts = opts.packCounts ?? []

  // Restrict filter options to packages currently in sweed_package_current.
  // We keep zero-on-hand packages because they are valid analytics
  // targets (sold-through, want to see how they did).
  //
  // Taxonomy (brand / category / subcategory / size) lives on
  // `catalog_groups`, not on the snapshot row itself — those snapshot
  // columns ship NULL from the grouped inventory feed. We join through
  // `live_state_json->'products'[]` (productId match). 99%+ coverage.
  // Distributor comes directly from sweed_package_current so selecting
  // a brand can narrow to the distributor(s) carrying it, and selecting
  // a distributor can narrow to the remaining brand options.
  //
  // Cumulative semantics: each dimension's option list is computed by
  // applying the OTHER dimensions' selections, but ignoring its own.
  // That way the operator can deselect what they just chose, and
  // selecting distributor=Curaleaf narrows brand/category/size to peers
  // within Curaleaf with correct (n=) counts.
  //
  // Parameter slots:
  //   $1 = dealerIds bigint[]
  //   $2 = categoryIds text[]      (selected categories — coalesced labels)
  //   $3 = subcategoryIds text[]   (selected subcategories)
  //   $4 = brandIds text[]         (selected brands)
  //   $5 = distributorNames text[] (selected distributors)
  //   $6 = sizes text[]            (selected sizes)
  //   $7 = packCounts text[]       (selected pack counts, integers-as-strings)
  const sql = `
    with mapping as (
      select cg.brand_name,
             cg.category_name,
             cg.subcategory_name,
             (prod->>'productId')::bigint as product_id,
             prod->>'sizeName' as size_name,
             nullif(prod->>'packOfSize', '')::int as pack_of_size
      from catalog_groups cg,
           jsonb_array_elements(cg.live_state_json->'products') as prod
      where cg.deleted_at is null
    ),
    base as (
      select spc.inventory_item_id,
             m.category_name,
             m.subcategory_name,
             m.brand_name,
             spc.distributor_name,
             m.size_name,
             m.pack_of_size,
             coalesce(nullif(m.category_name, ''),    '(uncategorised)')   as category_label,
             coalesce(nullif(m.subcategory_name, ''), '(no subcategory)')  as subcategory_label,
             coalesce(nullif(m.brand_name, ''),       '(no brand)')        as brand_label,
             coalesce(nullif(spc.distributor_name, ''), '(no distributor)') as distributor_label,
             coalesce(nullif(m.size_name, ''),        '(no size)')         as size_label,
             case when m.pack_of_size is null then '(unknown)'
                  else m.pack_of_size::text end as pack_count_label
      from sweed_package_current spc
        left join mapping m on m.product_id = spc.product_id
      where spc.dealer_id = any($1::bigint[])
    )
    -- categories: apply subcat + brand + distributor + size + pack-count, NOT category
    select 'category' as kind,
           category_label as id,
           category_label as label,
           count(distinct inventory_item_id)::int as item_count
    from base
    where category_name is not null
      and (cardinality($3::text[]) = 0 or subcategory_label = any($3::text[]))
      and (cardinality($4::text[]) = 0 or brand_label       = any($4::text[]))
      and (cardinality($5::text[]) = 0 or distributor_label = any($5::text[]))
      and (cardinality($6::text[]) = 0 or size_label        = any($6::text[]))
      and (cardinality($7::text[]) = 0 or pack_count_label  = any($7::text[]))
    group by 1, 2, 3
    union all
    -- subcategories: apply category + brand + distributor + size + pack-count, NOT subcategory
    select 'subcategory',
           subcategory_label,
           subcategory_label,
           count(distinct inventory_item_id)::int
    from base
    where subcategory_name is not null
      and (cardinality($2::text[]) = 0 or category_label = any($2::text[]))
      and (cardinality($4::text[]) = 0 or brand_label    = any($4::text[]))
      and (cardinality($5::text[]) = 0 or distributor_label = any($5::text[]))
      and (cardinality($6::text[]) = 0 or size_label     = any($6::text[]))
      and (cardinality($7::text[]) = 0 or pack_count_label = any($7::text[]))
    group by 1, 2, 3
    union all
    -- brands: apply category + subcat + distributor + size + pack-count, NOT brand
    select 'brand',
           brand_label,
           brand_label,
           count(distinct inventory_item_id)::int
    from base
    where brand_name is not null
      and (cardinality($2::text[]) = 0 or category_label    = any($2::text[]))
      and (cardinality($3::text[]) = 0 or subcategory_label = any($3::text[]))
      and (cardinality($5::text[]) = 0 or distributor_label = any($5::text[]))
      and (cardinality($6::text[]) = 0 or size_label        = any($6::text[]))
      and (cardinality($7::text[]) = 0 or pack_count_label  = any($7::text[]))
    group by 1, 2, 3
    union all
    -- distributors: apply category + subcat + brand + size + pack-count, NOT distributor
    select 'distributor',
           distributor_label,
           distributor_label,
           count(distinct inventory_item_id)::int
    from base
    where distributor_name is not null
      and (cardinality($2::text[]) = 0 or category_label    = any($2::text[]))
      and (cardinality($3::text[]) = 0 or subcategory_label = any($3::text[]))
      and (cardinality($4::text[]) = 0 or brand_label       = any($4::text[]))
      and (cardinality($6::text[]) = 0 or size_label        = any($6::text[]))
      and (cardinality($7::text[]) = 0 or pack_count_label  = any($7::text[]))
    group by 1, 2, 3
    union all
    -- sizes: apply category + subcat + brand + distributor + pack-count, NOT size
    select 'size',
           size_label,
           size_label,
           count(distinct inventory_item_id)::int
    from base
    where size_name is not null
      and (cardinality($2::text[]) = 0 or category_label    = any($2::text[]))
      and (cardinality($3::text[]) = 0 or subcategory_label = any($3::text[]))
      and (cardinality($4::text[]) = 0 or brand_label       = any($4::text[]))
      and (cardinality($5::text[]) = 0 or distributor_label = any($5::text[]))
      and (cardinality($7::text[]) = 0 or pack_count_label  = any($7::text[]))
    group by 1, 2, 3
    union all
    -- pack counts: apply category + subcat + brand + distributor + size, NOT pack-count
    select 'packCount',
           pack_count_label,
           pack_count_label,
           count(distinct inventory_item_id)::int
    from base
    where (cardinality($2::text[]) = 0 or category_label    = any($2::text[]))
      and (cardinality($3::text[]) = 0 or subcategory_label = any($3::text[]))
      and (cardinality($4::text[]) = 0 or brand_label       = any($4::text[]))
      and (cardinality($5::text[]) = 0 or distributor_label = any($5::text[]))
      and (cardinality($6::text[]) = 0 or size_label        = any($6::text[]))
    group by 1, 2, 3
  `

  const result = await pool.query<{
    kind: 'category' | 'subcategory' | 'brand' | 'distributor' | 'size' | 'packCount'
    id: string
    label: string
    item_count: number
  }>(sql, [
    dealerIds,
    categoryIds,
    subcategoryIds,
    brandIds,
    distributorNames,
    sizes,
    packCounts,
  ])

  const out: CatalogAnalyticsFiltersResponse = {
    categories: [],
    subcategories: [],
    brands: [],
    distributors: [],
    sizes: [],
    packCounts: [],
  }
  for (const row of result.rows) {
    if (row.kind === 'packCount') {
      // Pre-display: "1" → "1 per pkg", "5" → "5-pack", unknown → "unknown".
      // The id stays the raw integer string so the round-trip filter
      // param matches what the SQL pack_count_label compares against.
      const n = Number.parseInt(row.id, 10)
      const label = Number.isFinite(n)
        ? n === 1
          ? '1 per pkg'
          : `${n}-pack`
        : row.label
      out.packCounts.push({ id: row.id, label, itemCount: row.item_count })
      continue
    }
    const opt: CatalogFilterOption = {
      id: row.id,
      label: row.label,
      itemCount: row.item_count,
    }
    if (row.kind === 'category') out.categories.push(opt)
    else if (row.kind === 'subcategory') out.subcategories.push(opt)
    else if (row.kind === 'brand') out.brands.push(opt)
    else if (row.kind === 'distributor') out.distributors.push(opt)
    else out.sizes.push(opt)
  }
  // Sort:
  //  * categories / subcategories / sizes — count desc, label asc.
  //    These are short, structurally-meaningful enumerations where
  //    "what's biggest first" is what the operator looks for.
  //  * brands / distributors — alphabetical only. There are dozens of
  //    comparable names; the operator generally knows what they're
  //    looking for and wants to find it by name, not by volume.
  //  * packCounts — numeric ascending; "(unknown)" sinks to the end.
  const sortByCount = (a: CatalogFilterOption, b: CatalogFilterOption) =>
    b.itemCount - a.itemCount || a.label.localeCompare(b.label)
  const sortByLabel = (a: CatalogFilterOption, b: CatalogFilterOption) =>
    a.label.localeCompare(b.label)
  const sortPackCount = (a: CatalogFilterOption, b: CatalogFilterOption) => {
    const an = Number.parseInt(a.id, 10)
    const bn = Number.parseInt(b.id, 10)
    const aIsNum = Number.isFinite(an)
    const bIsNum = Number.isFinite(bn)
    if (aIsNum && bIsNum) return an - bn
    if (aIsNum) return -1
    if (bIsNum) return 1
    return a.label.localeCompare(b.label)
  }
  out.categories.sort(sortByCount)
  out.subcategories.sort(sortByCount)
  out.sizes.sort(sortByCount)
  out.brands.sort(sortByLabel)
  out.distributors.sort(sortByLabel)
  out.packCounts.sort(sortPackCount)
  return out
}

// =============================== Points endpoint ===========================

export interface CatalogAnalyticsPointsArgs {
  readonly from: Date
  readonly to: Date
  readonly sites: readonly string[]
  readonly categoryIds: readonly string[]
  readonly subcategoryIds: readonly string[]
  readonly brandIds: readonly string[]
  readonly distributorNames: readonly string[]
  readonly sizes: readonly string[]
  readonly packCounts: readonly string[]
}

export async function getCatalogAnalyticsPoints(
  args: CatalogAnalyticsPointsArgs,
): Promise<CatalogAnalyticsPointsResponse> {
  const dealerIds = resolveDealerIds(args.sites)
  const windowDays = Math.max(
    1,
    Math.round((args.to.getTime() - args.from.getTime()) / 86_400_000),
  )

  const resolved = {
    from: args.from.toISOString(),
    to: args.to.toISOString(),
    sites: [...args.sites],
    categoryIds: [...args.categoryIds],
    subcategoryIds: [...args.subcategoryIds],
    brandIds: [...args.brandIds],
    distributorNames: [...args.distributorNames],
    sizes: [...args.sizes],
    packCounts: [...args.packCounts],
    windowDays,
  }

  if (dealerIds.length === 0) {
    return { resolved, points: [] }
  }

  const pool = getPool()

  // Parameter slots ($N) — keep the array layout in lock-step with the SQL.
  //   $1 = dealerIds bigint[]
  //   $2 = from (timestamptz)
  //   $3 = to (timestamptz)
  //   $4 = categoryNames text[]    (empty = unfiltered) — joined off catalog_groups
  //   $5 = subcategoryNames text[] (empty = unfiltered) — joined off catalog_groups
  //   $6 = brandNames text[]       (empty = unfiltered) — joined off catalog_groups
  //   $7 = distributorNames text[] (empty = unfiltered) — joined off sweed_package_current
  //   $8 = sizes text[]            (empty = unfiltered) — joined off catalog_groups
  //   $9 = packCounts text[]       (empty = unfiltered) — integers-as-strings; "(unknown)" matches null packOfSize
  const params: unknown[] = [
    dealerIds,
    args.from,
    args.to,
    args.categoryIds,
    args.subcategoryIds,
    args.brandIds,
    args.distributorNames,
    args.sizes,
    args.packCounts,
  ]

  // Effective tax ratio per dealer over the window. NYC cannabis tax is
  // baked into grand_total but not split per line; we approximate
  // per-unit OTD by multiplying revenue by the dealer's
  // (grand_total / subtotal) ratio over the window. Falls back to 1.0
  // (no tax markup) for dealers with no orders in window.
  //
  // Taxonomy join: `sweed_package_snapshots` doesn't carry brand /
  // category / subcategory / size — those columns ship NULL from the
  // grouped inventory feed. We pull them from `catalog_groups` via
  // `live_state_json->'products'[]` (productId match). See
  // `getCatalogAnalyticsFilters` for the same join. THC / CBD %
  // similarly come from the snapshot raw_json blob (`thcPercent`,
  // `cbdPercent`), not the typed `lab_*` columns.
  const sql = `
    with tax_ratio as (
      select dealer_id,
             case
               when sum(subtotal_dollars) > 0
                 then sum(grand_total_dollars) / sum(subtotal_dollars)
               else 1.0
             end as ratio
      from sweed_orders
      where dealer_id = any($1::bigint[])
        and pay_time >= $2 and pay_time < $3
      group by dealer_id
    ),
    sales as (
      -- D1: reads the materialised sweed_order_items_flat (oi) instead
      -- of unrolling sweed_orders.raw_json->'items' at request time.
      -- oi.qty == old currentQty (verified 0 fallback rows) and
      -- oi.revenue == old subtotalAmount; flat rows are a 1:1 mirror.
      select oi.dealer_id,
             oi.inventory_item_id,
             sum(oi.qty) as units_sold,
             sum(oi.revenue) as revenue,
             sum(oi.qty
                 * coalesce(sweed_package_cost_as_of_or_earliest(
                     oi.dealer_id, oi.inventory_item_id, oi.pay_time), 0)) as cogs,
             count(distinct oi.invoice_id) as invoice_count,
             -- Distinct calendar days (ET) that this variant sold on.
             -- Powers the "sales-day coverage" scatter and the
             -- promo-event vs reliable-demand quadrant analysis.
             count(distinct ${bucketLocalExpr('day', 'oi.pay_time')}) as days_with_sales
      from sweed_order_items_flat oi
      where oi.dealer_id = any($1::bigint[])
        and oi.pay_time >= $2 and oi.pay_time < $3
        and oi.inventory_item_id is not null
        -- Canceled (voided) lines carry a non-zero subtotalAmount/qty
        -- in Sweed's feed but are not real sales; exclude them from
        -- units / revenue / COGS / sales-day coverage. (Line status is
        -- spelled 'Canceled'; order status is 'Cancelled'.)
        and lower(coalesce(oi.raw_item->'invoiceItemStatus'->>'name', '')) <> 'canceled'
      group by oi.dealer_id, oi.inventory_item_id
    ),
    mapping as (
      select cg.id as catalog_group_id,
             cg.brand_name,
             cg.category_name,
             cg.subcategory_name,
             cg.group_name,
             (prod->>'productId')::bigint as product_id,
             prod->>'sizeName' as size_name,
             prod->>'name' as product_name,
             prod->>'shortName' as product_short_name,
             prod->>'sku' as product_sku,
             nullif(prod->>'packOfSize', '')::int as pack_of_size,
             -- Pre-tax list (shelf) price per unit. Catalog groups carry
             -- one product entry per (size) variant, so this is the
             -- shelf price for THIS specific (product_id, size_name).
             -- Powers all of the "list vs effective" promo-erosion
             -- scatter plots.
             nullif(prod->>'price', '')::numeric as list_price_dollars
      from catalog_groups cg,
           jsonb_array_elements(cg.live_state_json->'products') as prod
      where cg.deleted_at is null
    ),
    -- Median pre-tax market price per matched catalog_group × product.
    -- Sourced from live (non-superseded) exact / brand_family verdicts
    -- in catalog_market_matches, joined to the original LitAlerts /
    -- partner listing's salePrice ?? normalPrice. Only product-scoped
    -- matches (catalog_product_id not null) are included so different-
    -- size matches on the same brand/group don't pollute each other.
    -- Variants with no matches surface as NULL — the chart renderer
    -- drops null-axis points cleanly.
    market_price as (
      select cmm.catalog_group_id,
             cmm.catalog_product_id,
             percentile_cont(0.5) within group (order by
               coalesce(
                 nullif(fs.raw_input_jsonb->>'salePrice', '')::numeric,
                 nullif(fs.raw_input_jsonb->>'normalPrice', '')::numeric
               )
             ) as median_pretax_price,
             count(*)::int as sample_count
      from catalog_market_matches cmm
        join fuzzy_skus fs on fs.id = cmm.fuzzy_sku_id
      where cmm.superseded_by_id is null
        and cmm.verdict in ('exact', 'brand_family')
        and cmm.catalog_product_id is not null
        and coalesce(
              nullif(fs.raw_input_jsonb->>'salePrice', '')::numeric,
              nullif(fs.raw_input_jsonb->>'normalPrice', '')::numeric
            ) > 0
      group by cmm.catalog_group_id, cmm.catalog_product_id
    )
    select cur.dealer_id,
           cur.inventory_item_id,
           cur.product_id,
           coalesce(m.product_name, cur.product_name) as product_name,
           coalesce(m.product_short_name, cur.product_short_name) as product_short_name,
           coalesce(m.product_sku, cur.product_sku) as product_sku,
           m.category_name,
           m.subcategory_name,
           m.brand_name,
           cur.distributor_name,
           m.size_name as size_label,
           m.pack_of_size,
           cur.current_qty,
           cur.available_qty,
           cur.is_on_stock,
           cur.wholesale_cost_dollars,
           nullif(cur.raw_json->>'thcPercent', '')::numeric as lab_thc_pct,
           nullif(cur.raw_json->>'cbdPercent', '')::numeric as lab_cbd_pct,
           m.list_price_dollars,
           mp.median_pretax_price as market_price_pretax_dollars,
           mp.sample_count        as market_sample_count,
           s.units_sold,
           s.revenue,
           s.cogs,
           s.invoice_count,
           s.days_with_sales,
           coalesce(tr.ratio, 1.0) as tax_ratio
    from sweed_package_current cur
      left join mapping m on m.product_id = cur.product_id
      left join market_price mp
        on mp.catalog_group_id = m.catalog_group_id
       and mp.catalog_product_id = cur.product_id
      left join sales s
        on s.dealer_id = cur.dealer_id
       and s.inventory_item_id = cur.inventory_item_id
      left join tax_ratio tr on tr.dealer_id = cur.dealer_id
    where cur.dealer_id = any($1::bigint[])
      and (cardinality($4::text[]) = 0 or coalesce(m.category_name, '(uncategorised)')   = any($4::text[]))
      and (cardinality($5::text[]) = 0 or coalesce(m.subcategory_name, '(no subcategory)') = any($5::text[]))
      and (cardinality($6::text[]) = 0 or coalesce(m.brand_name, '(no brand)')             = any($6::text[]))
      and (cardinality($7::text[]) = 0 or coalesce(cur.distributor_name, '(no distributor)') = any($7::text[]))
      and (cardinality($8::text[]) = 0 or coalesce(m.size_name, '(no size)')               = any($8::text[]))
      and (cardinality($9::text[]) = 0 or
           (case when m.pack_of_size is null then '(unknown)'
                 else m.pack_of_size::text end) = any($9::text[]))
  `

  const result = await pool.query(sql, params)

  // Collapse to ONE dot per VARIANT (catalog product_id = the
  // per-(product, size) SKU), aggregating every inventory package /
  // lot AND every dealer that stocks it. The SQL returns one row per
  // (dealer, inventory_item_id) — i.e. per physical lot — and a single
  // variant routinely has several lots (e.g. "STIIIZY Blue Dream Pod
  // 0.5g" product_id 477355 carries 3 lots with different wholesale
  // costs). Keying the scatter on inventory_item_id therefore drew one
  // dot per lot, which is wrong: the operator reasons per-SKU. We key
  // on product_id and roll the lots up.
  //
  // Additive fields (qty, units, revenue, cogs, invoices) sum. Per-unit
  // lot attributes that differ across lots (wholesale cost, lab THC/CBD)
  // are collapsed to a current-inventory-quantity-weighted average so a
  // big fresh lot dominates a tiny remnant; when no lot has stock on
  // hand we fall back to a simple mean of the populated lots. Margin %,
  // $/unit and velocities are recomputed from the summed totals (COGS is
  // already per-lot-accurate via sweed_package_cost_as_of_or_earliest),
  // so they stay correct regardless of the cost-field averaging.
  //
  // Packages that never mapped to a catalog product (product_id null)
  // can't be variant-grouped, so each stays its own dot keyed by its
  // lot id.
  type Acc = {
    point: CatalogAnalyticsPoint
    unitsSold: number
    revenue: number
    cogs: number
    invoiceCount: number
    /**
     * Max(distinct-days-sold) across lots / dealers. Strictly, the
     * union of per-lot day-sets would be more correct (some days appear
     * across lots). Taking the max is a conservative lower bound on
     * coverage that avoids double-counting. Good enough for the
     * sales-day-coverage scatter; if it becomes operator-relevant we
     * can switch to a per-day GROUP-BY round-trip.
     */
    daysWithSales: number
    currentQty: number
    availableQty: number
    taxRatio: number
    taxRatioCount: number
    // qty-weighted-average accumulators for per-unit lot attributes.
    costWeightedSum: number
    costWeight: number
    costSimpleSum: number
    costSimpleCount: number
    thcWeightedSum: number
    thcWeight: number
    thcSimpleSum: number
    thcSimpleCount: number
    cbdWeightedSum: number
    cbdWeight: number
    cbdSimpleSum: number
    cbdSimpleCount: number
    // representative distributor = the one shipping the most on-hand qty.
    bestDistributor: string | null
    bestDistributorQty: number
  }
  const byVariant = new Map<string, Acc>()
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const lotId = asStr(row.inventory_item_id)
    if (!lotId) continue
    const productId = asStr(row.product_id)
    // One dot per variant; un-mapped lots (no product_id) keep their own
    // lot-scoped key so they aren't silently merged together.
    const key = productId ?? `iiid:${lotId}`
    const unitsSold = asNum(row.units_sold) ?? 0
    const revenue = asNum(row.revenue) ?? 0
    const cogs = asNum(row.cogs) ?? 0
    const invoiceCount = asInt(row.invoice_count) ?? 0
    const daysWithSales = asInt(row.days_with_sales) ?? 0
    const currentQty = asNum(row.current_qty) ?? 0
    const availableQty = asNum(row.available_qty) ?? 0
    const taxRatio = asNum(row.tax_ratio) ?? 1.0
    const cost = asNum(row.wholesale_cost_dollars)
    const thc = asNum(row.lab_thc_pct)
    const cbd = asNum(row.lab_cbd_pct)
    const distributor = asStr(row.distributor_name)
    const onStock = typeof row.is_on_stock === 'boolean' ? row.is_on_stock : null
    const w = currentQty > 0 ? currentQty : 0

    const existing = byVariant.get(key)
    if (existing) {
      existing.unitsSold += unitsSold
      existing.revenue += revenue
      existing.cogs += cogs
      existing.invoiceCount += invoiceCount
      if (daysWithSales > existing.daysWithSales) {
        existing.daysWithSales = daysWithSales
      }
      existing.currentQty += currentQty
      existing.availableQty += availableQty
      existing.taxRatio += taxRatio
      existing.taxRatioCount += 1
      if (cost !== null) {
        existing.costWeightedSum += cost * w
        existing.costWeight += w
        existing.costSimpleSum += cost
        existing.costSimpleCount += 1
      }
      if (thc !== null) {
        existing.thcWeightedSum += thc * w
        existing.thcWeight += w
        existing.thcSimpleSum += thc
        existing.thcSimpleCount += 1
      }
      if (cbd !== null) {
        existing.cbdWeightedSum += cbd * w
        existing.cbdWeight += w
        existing.cbdSimpleSum += cbd
        existing.cbdSimpleCount += 1
      }
      if (onStock === true) existing.point.isOnStock = true
      else if (onStock === false && existing.point.isOnStock == null) {
        existing.point.isOnStock = false
      }
      if (distributor !== null && currentQty > existing.bestDistributorQty) {
        existing.bestDistributor = distributor
        existing.bestDistributorQty = currentQty
      }
      // List / market price are keyed on the variant (product_id) so
      // they're identical across lots; keep the first non-null.
      if (existing.point.listPriceDollars == null) {
        existing.point.listPriceDollars = asNum(row.list_price_dollars)
      }
      if (existing.point.marketPricePretaxDollars == null) {
        existing.point.marketPricePretaxDollars = asNum(row.market_price_pretax_dollars)
        existing.point.marketSampleCount = asInt(row.market_sample_count)
      }
      continue
    }
    const sizeLabel = asStr(row.size_label)
    const unitSize = parseUnitSize(sizeLabel)
    byVariant.set(key, {
      point: {
        // The dot identity is the variant, not a physical lot. Keep the
        // field name (contract) but populate it with the variant key so
        // selection / highlight stay 1:1 with the rendered dot.
        inventoryItemId: key,
        productId,
        productName: asStr(row.product_name) ?? '(unnamed)',
        productShortName: asStr(row.product_short_name),
        sku: asStr(row.product_sku),
        categoryId: null,
        categoryName: asStr(row.category_name),
        subcategoryId: null,
        subcategoryName: asStr(row.subcategory_name),
        brandId: null,
        brandName: asStr(row.brand_name),
        distributorName: distributor,
        sizeLabel,
        currentQty: null,
        availableQty: null,
        isOnStock: onStock,
        wholesaleCostDollars: null,
        labThcPct: null,
        labCbdPct: null,
        listPriceDollars: asNum(row.list_price_dollars),
        packCount: asInt(row.pack_of_size),
        unitSizeGrams: unitSize.grams,
        unitSizeMg: unitSize.mg,
        marketPricePretaxDollars: asNum(row.market_price_pretax_dollars),
        marketSampleCount: asInt(row.market_sample_count),
        unitsSold: null,
        revenueDollars: null,
        cogsDollars: null,
        marginDollars: null,
        marginDollarsPerUnit: null,
        gmPercent: null,
        avgUnitPriceDollars: null,
        otdUnitPriceDollars: null,
        salesVelocityUnitsPerDay: null,
        marginVelocityDollarsPerDay: null,
        invoiceCount: null,
        daysWithSales: null,
        taxRatio: null,
      },
      unitsSold,
      revenue,
      cogs,
      invoiceCount,
      daysWithSales,
      currentQty,
      availableQty,
      taxRatio,
      taxRatioCount: 1,
      costWeightedSum: cost !== null ? cost * w : 0,
      costWeight: cost !== null ? w : 0,
      costSimpleSum: cost ?? 0,
      costSimpleCount: cost !== null ? 1 : 0,
      thcWeightedSum: thc !== null ? thc * w : 0,
      thcWeight: thc !== null ? w : 0,
      thcSimpleSum: thc ?? 0,
      thcSimpleCount: thc !== null ? 1 : 0,
      cbdWeightedSum: cbd !== null ? cbd * w : 0,
      cbdWeight: cbd !== null ? w : 0,
      cbdSimpleSum: cbd ?? 0,
      cbdSimpleCount: cbd !== null ? 1 : 0,
      bestDistributor: distributor,
      bestDistributorQty: currentQty,
    })
  }

  // qty-weighted average of a per-unit lot attribute, falling back to a
  // simple mean of the populated lots when no lot has stock on hand.
  const weightedAvg = (
    weightedSum: number,
    weight: number,
    simpleSum: number,
    simpleCount: number,
  ): number | null => {
    if (weight > 0) return weightedSum / weight
    if (simpleCount > 0) return simpleSum / simpleCount
    return null
  }

  const points: CatalogAnalyticsPoint[] = []
  for (const acc of byVariant.values()) {
    const p = acc.point
    p.currentQty = acc.currentQty
    p.availableQty = acc.availableQty
    p.invoiceCount = acc.invoiceCount
    p.daysWithSales = acc.daysWithSales
    p.distributorName = acc.bestDistributor
    p.wholesaleCostDollars = weightedAvg(
      acc.costWeightedSum,
      acc.costWeight,
      acc.costSimpleSum,
      acc.costSimpleCount,
    )
    p.labThcPct = weightedAvg(
      acc.thcWeightedSum,
      acc.thcWeight,
      acc.thcSimpleSum,
      acc.thcSimpleCount,
    )
    p.labCbdPct = weightedAvg(
      acc.cbdWeightedSum,
      acc.cbdWeight,
      acc.cbdSimpleSum,
      acc.cbdSimpleCount,
    )
    const taxRatio = acc.taxRatioCount > 0 ? acc.taxRatio / acc.taxRatioCount : 1.0
    p.taxRatio = taxRatio
    if (acc.unitsSold > 0 || acc.revenue > 0) {
      p.unitsSold = acc.unitsSold
      p.revenueDollars = acc.revenue
      p.cogsDollars = acc.cogs
      p.marginDollars = acc.revenue - acc.cogs
      p.marginDollarsPerUnit =
        acc.unitsSold > 0 ? (acc.revenue - acc.cogs) / acc.unitsSold : null
      p.gmPercent = acc.revenue > 0 ? ((acc.revenue - acc.cogs) / acc.revenue) * 100 : null
      p.avgUnitPriceDollars =
        acc.unitsSold > 0 ? acc.revenue / acc.unitsSold : null
      p.otdUnitPriceDollars =
        p.avgUnitPriceDollars !== null ? p.avgUnitPriceDollars * taxRatio : null
      p.salesVelocityUnitsPerDay = acc.unitsSold / windowDays
      p.marginVelocityDollarsPerDay = (acc.revenue - acc.cogs) / windowDays
    }
    points.push(p)
  }

  // Stable sort by margin desc so debugging the JSON is humane.
  points.sort(
    (a, b) =>
      (b.marginDollars ?? -Infinity) - (a.marginDollars ?? -Infinity) ||
      a.inventoryItemId.localeCompare(b.inventoryItemId),
  )

  return { resolved, points }
}

export const CATALOG_ANALYTICS_DEFAULT_WINDOW_DAYS = DEFAULT_WINDOW_DAYS

// ============================ Entity rankings endpoint ====================
//
// Brand / distributor leaderboard powering the
// /metrics/brands and /metrics/distributors index pages.
//
// Returns one row per brand / distributor currently visible on
// sweed_package_current for the requested sites, with three sortable
// columns:
//
//   * live_item_count        — distinct inventory_item_id (lots /
//                              batches). Matches the legacy
//                              `CatalogFilterOption.itemCount` value
//                              so the column is comparable to the
//                              previous "Live items" display.
//   * in_stock_product_count — distinct product_id restricted to
//                              packages currently in stock
//                              (coalesce(is_on_stock, true) AND
//                              coalesce(available_qty, current_qty)
//                              > 0). This is the operator-meaningful
//                              "how many unique products is this
//                              brand actually shelving right now"
//                              measure.
//   * last_order_at          — max(sweed_orders.pay_time) for an
//                              order line whose inventoryItemId
//                              matches any of this entity's
//                              packages. Bounded to the last 365
//                              days so the join stays cheap; rows
//                              with no orders inside that window
//                              return NULL and the SPA renders "—".
// ===========================================================================

const ENTITY_RANKING_LAST_ORDER_LOOKBACK_DAYS = 365

export interface MetricsEntityRankingsArgs {
  readonly kind: MetricsEntityKind
  readonly sites: readonly string[]
}

export async function getMetricsEntityRankings(
  opts: MetricsEntityRankingsArgs,
): Promise<MetricsEntityRankingsResponse> {
  const dealerIds = resolveDealerIds(opts.sites)
  const lookbackSince = new Date(
    Date.now() - ENTITY_RANKING_LAST_ORDER_LOOKBACK_DAYS * 86_400_000,
  )

  if (dealerIds.length === 0) {
    return {
      kind: opts.kind,
      lastOrderLookbackSince: lookbackSince.toISOString(),
      rows: [],
    }
  }

  const pool = getPool()

  // Parameter slots:
  //   $1 = dealerIds bigint[]
  //   $2 = lookback cutoff for last_order_at (timestamptz)
  //
  // The `entity_label` expression switches per kind. We resolve it
  // server-side rather than splicing arbitrary identifiers into the
  // SQL string so the query plan stays cacheable. brand_name lives
  // on catalog_groups (joined via the live_state_json products
  // array, same pattern as getCatalogAnalyticsFilters);
  // distributor_name lives directly on sweed_package_current.
  const entityLabelExpr =
    opts.kind === 'brand'
      ? "coalesce(nullif(m.brand_name, ''), '(no brand)')"
      : "coalesce(nullif(spc.distributor_name, ''), '(no distributor)')"
  // `entity_present` filters out rows whose entity source column
  // is NULL/empty. For brand, that drops rows whose product_id
  // didn't resolve in catalog_groups (which the existing filter
  // SQL also excludes via `where brand_name is not null`). For
  // distributor, that drops packages whose distributor_name is
  // unset on sweed_package_current.
  const entityPresentExpr =
    opts.kind === 'brand'
      ? 'm.brand_name is not null'
      : 'spc.distributor_name is not null'

  const sql = `
    with mapping as (
      select cg.brand_name,
             (prod->>'productId')::bigint as product_id
      from catalog_groups cg,
           jsonb_array_elements(cg.live_state_json->'products') as prod
      where cg.deleted_at is null
    ),
    base as (
      select spc.dealer_id,
             spc.inventory_item_id,
             spc.product_id,
             spc.is_on_stock,
             coalesce(spc.available_qty, spc.current_qty, 0) as live_qty,
             ${entityLabelExpr} as entity_label
      from sweed_package_current spc
        left join mapping m on m.product_id = spc.product_id
      where spc.dealer_id = any($1::bigint[])
        and ${entityPresentExpr}
    ),
    presence as (
      select entity_label,
             count(distinct inventory_item_id)::int as live_item_count,
             count(distinct product_id)
               filter (where coalesce(is_on_stock, true) and live_qty > 0)::int
                                                         as in_stock_product_count
      from base
      group by 1
    ),
    -- Map each live inventory_item to the entity it belongs to so we
    -- can roll order lines (which only carry inventoryItemId) up to
    -- the brand / distributor without re-deriving the taxonomy join
    -- inside the sweed_orders cross-lateral. Tied to the same
    -- (dealer_id, inventory_item_id) we already have in base.
    inventory_entity as (
      select distinct dealer_id, inventory_item_id, entity_label
      from base
    ),
    last_order as (
      -- D1: same materialised flat table; max(pay_time) per entity.
      select ie.entity_label,
             max(oi.pay_time) as last_pay_time
      from sweed_order_items_flat oi
        join inventory_entity ie
          on ie.dealer_id = oi.dealer_id
         and ie.inventory_item_id = oi.inventory_item_id
      where oi.dealer_id = any($1::bigint[])
        and oi.pay_time >= $2
        and oi.inventory_item_id is not null
      group by 1
    )
    select p.entity_label as label,
           p.live_item_count,
           p.in_stock_product_count,
           lo.last_pay_time as last_order_at
    from presence p
      left join last_order lo on lo.entity_label = p.entity_label
    order by p.in_stock_product_count desc, p.entity_label asc
  `

  const result = await pool.query<{
    label: string
    live_item_count: number
    in_stock_product_count: number
    last_order_at: Date | string | null
  }>(sql, [dealerIds, lookbackSince])

  const rows: MetricsEntityRankingRow[] = result.rows.map((row) => {
    let lastOrderAt: string | null = null
    if (row.last_order_at instanceof Date) {
      lastOrderAt = row.last_order_at.toISOString()
    } else if (typeof row.last_order_at === 'string' && row.last_order_at.length > 0) {
      // Defensive: pg can return strings if a custom parser is registered.
      const parsed = new Date(row.last_order_at)
      lastOrderAt = Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
    }
    return {
      // The entity_label is the join key the rest of the catalog
      // filter machinery uses (it matches `CatalogFilterOption.id`
      // for the same dimension), so use it for both id and label.
      id: row.label,
      label: row.label,
      liveItemCount: asInt(row.live_item_count) ?? 0,
      inStockProductCount: asInt(row.in_stock_product_count) ?? 0,
      lastOrderAt,
    }
  })

  return {
    kind: opts.kind,
    lastOrderLookbackSince: lookbackSince.toISOString(),
    rows,
  }
}
