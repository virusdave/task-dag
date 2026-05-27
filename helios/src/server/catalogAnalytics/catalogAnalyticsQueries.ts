import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type CatalogAnalyticsFiltersResponse,
  type CatalogAnalyticsPoint,
  type CatalogAnalyticsPointsResponse,
  type CatalogFilterOption,
} from '../../shared/contracts/index.js'
import { getPool } from '../db/pool.js'

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
  readonly sizes?: readonly string[]
  readonly packCounts?: readonly string[]
}

export async function getCatalogAnalyticsFilters(
  opts: CatalogAnalyticsFiltersArgs,
): Promise<CatalogAnalyticsFiltersResponse> {
  const dealerIds = resolveDealerIds(opts.sites)
  if (dealerIds.length === 0) {
    return { categories: [], subcategories: [], brands: [], sizes: [], packCounts: [] }
  }
  const pool = getPool()

  const categoryIds = opts.categoryIds ?? []
  const subcategoryIds = opts.subcategoryIds ?? []
  const brandIds = opts.brandIds ?? []
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
  //
  // Cumulative semantics: each dimension's option list is computed by
  // applying the OTHER three dimensions' selections, but ignoring its
  // own. That way the operator can deselect what they just chose, and
  // selecting category=Flower narrows brand/subcategory/size to peers
  // within Flower with correct (n=) counts.
  //
  // Parameter slots:
  //   $1 = dealerIds bigint[]
  //   $2 = categoryIds text[]    (selected categories — coalesced labels)
  //   $3 = subcategoryIds text[] (selected subcategories)
  //   $4 = brandIds text[]       (selected brands)
  //   $5 = sizes text[]          (selected sizes)
  //   $6 = packCounts text[]     (selected pack counts, integers-as-strings)
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
             m.size_name,
             m.pack_of_size,
             coalesce(nullif(m.category_name, ''),    '(uncategorised)')   as category_label,
             coalesce(nullif(m.subcategory_name, ''), '(no subcategory)')  as subcategory_label,
             coalesce(nullif(m.brand_name, ''),       '(no brand)')        as brand_label,
             coalesce(nullif(m.size_name, ''),        '(no size)')         as size_label,
             case when m.pack_of_size is null then '(unknown)'
                  else m.pack_of_size::text end as pack_count_label
      from sweed_package_current spc
        left join mapping m on m.product_id = spc.product_id
      where spc.dealer_id = any($1::bigint[])
    )
    -- categories: apply subcat + brand + size + pack-count, NOT category
    select 'category' as kind,
           category_label as id,
           category_label as label,
           count(distinct inventory_item_id)::int as item_count
    from base
    where category_name is not null
      and (cardinality($3::text[]) = 0 or subcategory_label = any($3::text[]))
      and (cardinality($4::text[]) = 0 or brand_label       = any($4::text[]))
      and (cardinality($5::text[]) = 0 or size_label        = any($5::text[]))
      and (cardinality($6::text[]) = 0 or pack_count_label  = any($6::text[]))
    group by 1, 2, 3
    union all
    -- subcategories: apply category + brand + size + pack-count, NOT subcategory
    select 'subcategory',
           subcategory_label,
           subcategory_label,
           count(distinct inventory_item_id)::int
    from base
    where subcategory_name is not null
      and (cardinality($2::text[]) = 0 or category_label = any($2::text[]))
      and (cardinality($4::text[]) = 0 or brand_label    = any($4::text[]))
      and (cardinality($5::text[]) = 0 or size_label     = any($5::text[]))
      and (cardinality($6::text[]) = 0 or pack_count_label = any($6::text[]))
    group by 1, 2, 3
    union all
    -- brands: apply category + subcat + size + pack-count, NOT brand
    select 'brand',
           brand_label,
           brand_label,
           count(distinct inventory_item_id)::int
    from base
    where brand_name is not null
      and (cardinality($2::text[]) = 0 or category_label    = any($2::text[]))
      and (cardinality($3::text[]) = 0 or subcategory_label = any($3::text[]))
      and (cardinality($5::text[]) = 0 or size_label        = any($5::text[]))
      and (cardinality($6::text[]) = 0 or pack_count_label  = any($6::text[]))
    group by 1, 2, 3
    union all
    -- sizes: apply category + subcat + brand + pack-count, NOT size
    select 'size',
           size_label,
           size_label,
           count(distinct inventory_item_id)::int
    from base
    where size_name is not null
      and (cardinality($2::text[]) = 0 or category_label    = any($2::text[]))
      and (cardinality($3::text[]) = 0 or subcategory_label = any($3::text[]))
      and (cardinality($4::text[]) = 0 or brand_label       = any($4::text[]))
      and (cardinality($6::text[]) = 0 or pack_count_label  = any($6::text[]))
    group by 1, 2, 3
    union all
    -- pack counts: apply category + subcat + brand + size, NOT pack-count
    select 'packCount',
           pack_count_label,
           pack_count_label,
           count(distinct inventory_item_id)::int
    from base
    where (cardinality($2::text[]) = 0 or category_label    = any($2::text[]))
      and (cardinality($3::text[]) = 0 or subcategory_label = any($3::text[]))
      and (cardinality($4::text[]) = 0 or brand_label       = any($4::text[]))
      and (cardinality($5::text[]) = 0 or size_label        = any($5::text[]))
    group by 1, 2, 3
  `

  const result = await pool.query<{
    kind: 'category' | 'subcategory' | 'brand' | 'size' | 'packCount'
    id: string
    label: string
    item_count: number
  }>(sql, [dealerIds, categoryIds, subcategoryIds, brandIds, sizes, packCounts])

  const out: CatalogAnalyticsFiltersResponse = {
    categories: [],
    subcategories: [],
    brands: [],
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
    else out.sizes.push(opt)
  }
  // Sort:
  //  * categories / subcategories / sizes — count desc, label asc.
  //    These are short, structurally-meaningful enumerations where
  //    "what's biggest first" is what the operator looks for.
  //  * brands — alphabetical only. There are dozens of comparable
  //    brands; the operator generally knows the brand they're looking
  //    for and wants to find it by name, not by volume.
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
  //   $7 = sizes text[]            (empty = unfiltered) — joined off catalog_groups
  //   $8 = packCounts text[]       (empty = unfiltered) — integers-as-strings; "(unknown)" matches null packOfSize
  const params: unknown[] = [
    dealerIds,
    args.from,
    args.to,
    args.categoryIds,
    args.subcategoryIds,
    args.brandIds,
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
      select so.dealer_id,
             item->>'inventoryItemId' as inventory_item_id,
             sum(coalesce((item->>'currentQty')::numeric, 0)) as units_sold,
             sum(coalesce((item->>'subtotalAmount')::numeric, 0)) as revenue,
             sum(coalesce((item->>'currentQty')::numeric, 0)
                 * coalesce(sweed_package_cost_as_of_or_earliest(
                     so.dealer_id, item->>'inventoryItemId', so.pay_time), 0)) as cogs,
             count(distinct so.invoice_id) as invoice_count,
             -- Distinct calendar days (ET) that this variant sold on.
             -- Powers the "sales-day coverage" scatter and the
             -- promo-event vs reliable-demand quadrant analysis.
             count(distinct date_trunc('day', so.pay_time at time zone 'America/New_York')) as days_with_sales
      from sweed_orders so
        cross join lateral jsonb_array_elements(so.raw_json->'items') as item
      where so.dealer_id = any($1::bigint[])
        and so.pay_time >= $2 and so.pay_time < $3
        and item->>'inventoryItemId' is not null
      group by so.dealer_id, item->>'inventoryItemId'
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
      and (cardinality($7::text[]) = 0 or coalesce(m.size_name, '(no size)')               = any($7::text[]))
      and (cardinality($8::text[]) = 0 or
           (case when m.pack_of_size is null then '(unknown)'
                 else m.pack_of_size::text end) = any($8::text[]))
  `

  const result = await pool.query(sql, params)

  // Collapse multi-dealer rows for the same inventory_item_id into one
  // "variant" point. Different dealers can stock the same package id so
  // we want one dot per (product, size) — sum the qty / sales fields,
  // pick the most-recent snapshot's metadata (already current per the
  // sweed_package_current view).
  type Acc = {
    point: CatalogAnalyticsPoint
    unitsSold: number
    revenue: number
    cogs: number
    invoiceCount: number
    /**
     * Max(distinct-days-sold) across dealers. Strictly, the union of
     * per-dealer day-sets would be more correct (some days appear at
     * both stores). Taking the max is a conservative lower bound on
     * coverage that avoids double-counting. Good enough for the
     * sales-day-coverage scatter; if it becomes operator-relevant we
     * can switch to a per-day GROUP-BY round-trip.
     */
    daysWithSales: number
    currentQty: number
    availableQty: number
    taxRatio: number
    taxRatioCount: number
  }
  const byId = new Map<string, Acc>()
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const id = asStr(row.inventory_item_id)
    if (!id) continue
    const existing = byId.get(id)
    const unitsSold = asNum(row.units_sold) ?? 0
    const revenue = asNum(row.revenue) ?? 0
    const cogs = asNum(row.cogs) ?? 0
    const invoiceCount = asInt(row.invoice_count) ?? 0
    const daysWithSales = asInt(row.days_with_sales) ?? 0
    const currentQty = asNum(row.current_qty) ?? 0
    const availableQty = asNum(row.available_qty) ?? 0
    const taxRatio = asNum(row.tax_ratio) ?? 1.0
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
    byId.set(id, {
      point: {
        inventoryItemId: id,
        productId: asStr(row.product_id),
        productName: asStr(row.product_name) ?? '(unnamed)',
        productShortName: asStr(row.product_short_name),
        sku: asStr(row.product_sku),
        categoryId: null,
        categoryName: asStr(row.category_name),
        subcategoryId: null,
        subcategoryName: asStr(row.subcategory_name),
        brandId: null,
        brandName: asStr(row.brand_name),
        sizeLabel,
        currentQty: null,
        availableQty: null,
        isOnStock: typeof row.is_on_stock === 'boolean' ? row.is_on_stock : null,
        wholesaleCostDollars: asNum(row.wholesale_cost_dollars),
        labThcPct: asNum(row.lab_thc_pct),
        labCbdPct: asNum(row.lab_cbd_pct),
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
    })
  }

  const points: CatalogAnalyticsPoint[] = []
  for (const acc of byId.values()) {
    const p = acc.point
    p.currentQty = acc.currentQty
    p.availableQty = acc.availableQty
    p.invoiceCount = acc.invoiceCount
    p.daysWithSales = acc.daysWithSales
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
