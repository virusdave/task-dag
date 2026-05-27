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

// ============================ Filters endpoint =============================

export async function getCatalogAnalyticsFilters(opts: {
  sites: readonly string[]
}): Promise<CatalogAnalyticsFiltersResponse> {
  const dealerIds = resolveDealerIds(opts.sites)
  if (dealerIds.length === 0) {
    return { categories: [], subcategories: [], brands: [], sizes: [] }
  }
  const pool = getPool()

  // Restrict filter options to packages that are currently active (on
  // stock or recently observed) so the dropdowns don't drown the operator
  // in long-tail historical SKUs. We still keep zero-on-hand packages
  // because they are part of valid analytics queries (sold through, want
  // to see how they did).
  //
  // Taxonomy (brand / category / subcategory) lives on `catalog_groups`,
  // not on the snapshot row itself — `sweed_package_snapshots.brand_*` /
  // `category_*` columns are currently NULL because the live grouped
  // inventory feed doesn't carry them. We join through
  // `live_state_json->'products'[]` whose `productId` matches
  // `sweed_package_current.product_id`. (99%+ coverage observed.)
  // Size label is also carried in the catalog_groups products list as
  // `sizeName` — the snapshot's `size_label` column is empty for the
  // same reason.
  const sql = `
    with mapping as (
      select cg.brand_name,
             cg.category_name,
             cg.subcategory_name,
             (prod->>'productId')::bigint as product_id,
             prod->>'sizeName' as size_name
      from catalog_groups cg,
           jsonb_array_elements(cg.live_state_json->'products') as prod
      where cg.deleted_at is null
    ),
    cur as (
      select spc.dealer_id,
             spc.inventory_item_id,
             m.category_name,
             m.subcategory_name,
             m.brand_name,
             m.size_name as size_label
      from sweed_package_current spc
        left join mapping m on m.product_id = spc.product_id
      where spc.dealer_id = any($1::bigint[])
    )
    select 'category' as kind,
           coalesce(nullif(category_name, ''), '(uncategorised)') as id,
           coalesce(nullif(category_name, ''), '(uncategorised)') as label,
           count(distinct inventory_item_id)::int as item_count
    from cur
    where category_name is not null
    group by 1, 2, 3
    union all
    select 'subcategory',
           coalesce(nullif(subcategory_name, ''), '(no subcategory)'),
           coalesce(nullif(subcategory_name, ''), '(no subcategory)'),
           count(distinct inventory_item_id)::int
    from cur
    where subcategory_name is not null
    group by 1, 2, 3
    union all
    select 'brand',
           coalesce(nullif(brand_name, ''), '(no brand)'),
           coalesce(nullif(brand_name, ''), '(no brand)'),
           count(distinct inventory_item_id)::int
    from cur
    where brand_name is not null
    group by 1, 2, 3
    union all
    select 'size',
           coalesce(nullif(size_label, ''), '(no size)'),
           coalesce(nullif(size_label, ''), '(no size)'),
           count(distinct inventory_item_id)::int
    from cur
    where size_label is not null
    group by 1, 2, 3
  `

  const result = await pool.query<{
    kind: 'category' | 'subcategory' | 'brand' | 'size'
    id: string
    label: string
    item_count: number
  }>(sql, [dealerIds])

  const out: CatalogAnalyticsFiltersResponse = {
    categories: [],
    subcategories: [],
    brands: [],
    sizes: [],
  }
  for (const row of result.rows) {
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
  // Sort each list by item_count desc, then label asc — high-signal
  // options bubble to the top.
  const sortByCount = (a: CatalogFilterOption, b: CatalogFilterOption) =>
    b.itemCount - a.itemCount || a.label.localeCompare(b.label)
  out.categories.sort(sortByCount)
  out.subcategories.sort(sortByCount)
  out.brands.sort(sortByCount)
  out.sizes.sort(sortByCount)
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
  const params: unknown[] = [
    dealerIds,
    args.from,
    args.to,
    args.categoryIds,
    args.subcategoryIds,
    args.brandIds,
    args.sizes,
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
             count(distinct so.invoice_id) as invoice_count
      from sweed_orders so
        cross join lateral jsonb_array_elements(so.raw_json->'items') as item
      where so.dealer_id = any($1::bigint[])
        and so.pay_time >= $2 and so.pay_time < $3
        and item->>'inventoryItemId' is not null
      group by so.dealer_id, item->>'inventoryItemId'
    ),
    mapping as (
      select cg.brand_name,
             cg.category_name,
             cg.subcategory_name,
             cg.group_name,
             (prod->>'productId')::bigint as product_id,
             prod->>'sizeName' as size_name,
             prod->>'name' as product_name,
             prod->>'shortName' as product_short_name,
             prod->>'sku' as product_sku
      from catalog_groups cg,
           jsonb_array_elements(cg.live_state_json->'products') as prod
      where cg.deleted_at is null
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
           cur.current_qty,
           cur.available_qty,
           cur.is_on_stock,
           cur.wholesale_cost_dollars,
           nullif(cur.raw_json->>'thcPercent', '')::numeric as lab_thc_pct,
           nullif(cur.raw_json->>'cbdPercent', '')::numeric as lab_cbd_pct,
           s.units_sold,
           s.revenue,
           s.cogs,
           s.invoice_count,
           coalesce(tr.ratio, 1.0) as tax_ratio
    from sweed_package_current cur
      left join mapping m on m.product_id = cur.product_id
      left join sales s
        on s.dealer_id = cur.dealer_id
       and s.inventory_item_id = cur.inventory_item_id
      left join tax_ratio tr on tr.dealer_id = cur.dealer_id
    where cur.dealer_id = any($1::bigint[])
      and (cardinality($4::text[]) = 0 or coalesce(m.category_name, '(uncategorised)')   = any($4::text[]))
      and (cardinality($5::text[]) = 0 or coalesce(m.subcategory_name, '(no subcategory)') = any($5::text[]))
      and (cardinality($6::text[]) = 0 or coalesce(m.brand_name, '(no brand)')             = any($6::text[]))
      and (cardinality($7::text[]) = 0 or coalesce(m.size_name, '(no size)')               = any($7::text[]))
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
    const currentQty = asNum(row.current_qty) ?? 0
    const availableQty = asNum(row.available_qty) ?? 0
    const taxRatio = asNum(row.tax_ratio) ?? 1.0
    if (existing) {
      existing.unitsSold += unitsSold
      existing.revenue += revenue
      existing.cogs += cogs
      existing.invoiceCount += invoiceCount
      existing.currentQty += currentQty
      existing.availableQty += availableQty
      existing.taxRatio += taxRatio
      existing.taxRatioCount += 1
      continue
    }
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
        sizeLabel: asStr(row.size_label),
        currentQty: null,
        availableQty: null,
        isOnStock: typeof row.is_on_stock === 'boolean' ? row.is_on_stock : null,
        wholesaleCostDollars: asNum(row.wholesale_cost_dollars),
        labThcPct: asNum(row.lab_thc_pct),
        labCbdPct: asNum(row.lab_cbd_pct),
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
      },
      unitsSold,
      revenue,
      cogs,
      invoiceCount,
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
      const taxRatio = acc.taxRatioCount > 0 ? acc.taxRatio / acc.taxRatioCount : 1.0
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
