import type { QueryResultRow } from 'pg'

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type CatalogBrowserQuery,
} from '../../../shared/contracts/index.js'
import { buildCatalogCohortKey, parseUnitSize } from '../../../shared/domain/catalogCohort.js'
import type { Queryable } from '../pool.js'
import { buildCatalogWhere } from './catalogQueries.js'

// ---------------------------------------------------------------------------
// Per-(site × variant) snapshot CSV exports backing the "Download CSV" buttons
// on /catalog/browser (catalog snapshot) and /catalog/inventory/stock-refresh
// (current inventory snapshot).
//
// These are deliberately SALES-FREE: unlike getCatalogAnalyticsPoints() (which
// powers the scatter plots and joins the sweed_orders window), the snapshot
// exports never touch sales/velocity/margin. They carry only structured
// attributes, pricing, current on-hand state, a synthetic `has_image`, and the
// synthetic `cohort_key` (identical to the scatter-plot cohort grouping, via
// the shared shared/domain/catalogCohort.ts helpers).
//
// Grain is one row per (site × catalog variant). The catalog export starts
// from the filtered catalog and annotates each site's current stock; the stock
// export starts from current inventory and annotates each row with catalog
// attributes. Lots are rolled up to (dealer, variant): quantities sum,
// per-unit lot attributes (wholesale cost, lab THC/CBD) collapse to a
// current-quantity-weighted average (matching the scatter rollup), and the
// representative distributor is the highest-on-hand lot's.
// ---------------------------------------------------------------------------

export interface CatalogSnapshotCsvRow {
  readonly siteKey: string
  readonly siteLabel: string
  readonly dealerId: number
  readonly catalogGroupId: number | null
  readonly sweedGroupId: number | null
  readonly productId: number | null
  readonly sku: string | null
  readonly productName: string | null
  readonly brandName: string | null
  readonly categoryName: string | null
  readonly subcategoryName: string | null
  readonly sizeLabel: string | null
  readonly unitSizeGrams: number | null
  readonly unitSizeMg: number | null
  readonly packCount: number | null
  readonly cohortKey: string
  readonly distributorName: string | null
  readonly listPriceDollars: number | null
  readonly wholesaleCostDollars: number | null
  readonly marketPricePretaxDollars: number | null
  readonly currentQty: number | null
  readonly availableQty: number | null
  readonly isOnStock: boolean | null
  readonly labThcPct: number | null
  readonly labCbdPct: number | null
  readonly hasImage: boolean
}

interface SnapshotSqlRow extends QueryResultRow {
  site_key: string
  site_label: string
  dealer_id: string | number
  catalog_group_id: string | number | null
  sweed_group_id: string | number | null
  product_id: string | number | null
  product_sku: string | null
  product_name: string | null
  brand_name: string | null
  category_name: string | null
  subcategory_name: string | null
  size_label: string | null
  pack_count: number | null
  distributor_name: string | null
  list_price_dollars: string | number | null
  wholesale_cost_dollars: string | number | null
  market_price_pretax_dollars: string | number | null
  current_qty: string | number | null
  available_qty: string | number | null
  is_on_stock: boolean | null
  lab_thc_pct: string | number | null
  lab_cbd_pct: string | number | null
  has_image: boolean | null
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

const SITE_DEALER_IDS: number[] = HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((d) => d.dealerId)
const SITE_KEYS: string[] = HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((d) => d.siteKey)
const SITE_LABELS: string[] = HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((d) => d.siteLabel)

/**
 * Shared `has_image` boolean: true when the product entry OR its group carries
 * at least one image with a non-empty URL in live_state_json. `prodAlias` and
 * `cgAlias` are the SQL aliases for the exploded product jsonb and the
 * catalog_groups row.
 */
function hasImageSql(prodAlias: string, cgAlias: string): string {
  return `(
    exists (
      select 1 from jsonb_array_elements(coalesce(${prodAlias}->'images', '[]'::jsonb)) img
      where nullif(btrim(img->>'url'), '') is not null
    )
    or exists (
      select 1 from jsonb_array_elements(coalesce(${cgAlias}.live_state_json->'images', '[]'::jsonb)) img
      where nullif(btrim(img->>'url'), '') is not null
    )
  )`
}

/**
 * Per-(dealer, variant) inventory rollup over sweed_package_current. `$N` is
 * the bind index of the dealer-id bigint[]. Emitted as CTE text so both
 * exports share one definition.
 */
function inventoryRollupCte(dealerParam: string): string {
  return `
    inventory_lots as (
      select
        cur.dealer_id,
        coalesce(cur.product_id::text, 'ii:' || cur.inventory_item_id::text) as variant_key,
        cur.product_id,
        cur.product_name,
        cur.product_sku,
        cur.distributor_name,
        coalesce(cur.current_qty, 0) as current_qty,
        coalesce(cur.available_qty, 0) as available_qty,
        coalesce(cur.is_on_stock, false) as is_on_stock,
        cur.wholesale_cost_dollars,
        nullif(cur.raw_json->>'thcPercent', '')::numeric as lab_thc_pct,
        nullif(cur.raw_json->>'cbdPercent', '')::numeric as lab_cbd_pct
      from sweed_package_current cur
      where cur.dealer_id = any(${dealerParam}::bigint[])
    ),
    inventory_rollup as (
      select
        dealer_id,
        variant_key,
        max(product_id) as product_id,
        sum(current_qty) as current_qty,
        sum(available_qty) as available_qty,
        bool_or(is_on_stock) as is_on_stock,
        (array_agg(distributor_name order by current_qty desc nulls last)
          filter (where nullif(distributor_name, '') is not null))[1] as distributor_name,
        (array_agg(product_name order by current_qty desc nulls last)
          filter (where nullif(product_name, '') is not null))[1] as product_name,
        (array_agg(product_sku order by current_qty desc nulls last)
          filter (where nullif(product_sku, '') is not null))[1] as product_sku,
        case
          when sum(current_qty) filter (where wholesale_cost_dollars is not null and current_qty > 0) > 0
          then sum(wholesale_cost_dollars * current_qty) filter (where wholesale_cost_dollars is not null and current_qty > 0)
             / sum(current_qty) filter (where wholesale_cost_dollars is not null and current_qty > 0)
          else avg(wholesale_cost_dollars) filter (where wholesale_cost_dollars is not null)
        end as wholesale_cost_dollars,
        case
          when sum(current_qty) filter (where lab_thc_pct is not null and current_qty > 0) > 0
          then sum(lab_thc_pct * current_qty) filter (where lab_thc_pct is not null and current_qty > 0)
             / sum(current_qty) filter (where lab_thc_pct is not null and current_qty > 0)
          else avg(lab_thc_pct) filter (where lab_thc_pct is not null)
        end as lab_thc_pct,
        case
          when sum(current_qty) filter (where lab_cbd_pct is not null and current_qty > 0) > 0
          then sum(lab_cbd_pct * current_qty) filter (where lab_cbd_pct is not null and current_qty > 0)
             / sum(current_qty) filter (where lab_cbd_pct is not null and current_qty > 0)
          else avg(lab_cbd_pct) filter (where lab_cbd_pct is not null)
        end as lab_cbd_pct
      from inventory_lots
      group by dealer_id, variant_key
    )`
}

const MARKET_PRICE_MEDIAN_EXPR = `percentile_cont(0.5) within group (order by coalesce(
  nullif(fs.raw_input_jsonb->>'salePrice', '')::numeric,
  nullif(fs.raw_input_jsonb->>'normalPrice', '')::numeric
))`

const MARKET_PRICE_WHERE = `cmm.superseded_by_id is null
  and cmm.verdict in ('exact', 'brand_family')
  and cmm.catalog_product_id is not null
  and coalesce(
    nullif(fs.raw_input_jsonb->>'salePrice', '')::numeric,
    nullif(fs.raw_input_jsonb->>'normalPrice', '')::numeric
  ) > 0`

function mapRow(row: SnapshotSqlRow): CatalogSnapshotCsvRow {
  const sizeLabel = asStr(row.size_label)
  const packCount = asInt(row.pack_count)
  const { grams, mg } = parseUnitSize(sizeLabel)
  const categoryName = asStr(row.category_name)
  const subcategoryName = asStr(row.subcategory_name)
  return {
    siteKey: row.site_key,
    siteLabel: row.site_label,
    dealerId: asInt(row.dealer_id) ?? 0,
    catalogGroupId: asInt(row.catalog_group_id),
    sweedGroupId: asInt(row.sweed_group_id),
    productId: asInt(row.product_id),
    sku: asStr(row.product_sku),
    productName: asStr(row.product_name),
    brandName: asStr(row.brand_name),
    categoryName,
    subcategoryName,
    sizeLabel,
    unitSizeGrams: grams,
    unitSizeMg: mg,
    packCount,
    cohortKey: buildCatalogCohortKey({
      categoryName,
      subcategoryName,
      sizeLabel,
      unitSizeGrams: grams,
      unitSizeMg: mg,
      packCount,
    }),
    distributorName: asStr(row.distributor_name),
    listPriceDollars: asNum(row.list_price_dollars),
    wholesaleCostDollars: asNum(row.wholesale_cost_dollars),
    marketPricePretaxDollars: asNum(row.market_price_pretax_dollars),
    currentQty: asNum(row.current_qty),
    availableQty: asNum(row.available_qty),
    isOnStock: typeof row.is_on_stock === 'boolean' ? row.is_on_stock : null,
    labThcPct: asNum(row.lab_thc_pct),
    labCbdPct: asNum(row.lab_cbd_pct),
    hasImage: row.has_image === true,
  }
}

/**
 * Catalog snapshot CSV rows: one row per (site × catalog variant) for the
 * catalog matching the browser filters, annotated with each site's current
 * stock. `limit` caps the result (caller passes limit + 1 to detect overflow).
 */
export async function listCatalogBrowserCsvRows(
  db: Queryable,
  filters: CatalogBrowserQuery,
  limit: number,
): Promise<CatalogSnapshotCsvRow[]> {
  // Reuse the browser's exact group-level filter semantics ($1..$k on alias cg).
  const { values, whereSql } = buildCatalogWhere(filters)
  const k = values.length
  const pDealers = `$${k + 1}`
  const pSiteKeys = `$${k + 2}`
  const pSiteLabels = `$${k + 3}`
  const pSize = `$${k + 4}`
  const pLimit = `$${k + 5}`

  const sql = `
    with selected_dealers as (
      select * from unnest(${pDealers}::bigint[], ${pSiteKeys}::text[], ${pSiteLabels}::text[])
        as d(dealer_id, site_key, site_label)
    ),
    ${inventoryRollupCte(pDealers)},
    filtered_groups as (
      select cg.id, cg.sweed_group_id, cg.group_name, cg.brand_name,
             cg.category_name, cg.subcategory_name, cg.live_state_json
      from catalog_groups cg
      ${whereSql}
    ),
    catalog_products as (
      select
        fg.id as catalog_group_id,
        fg.sweed_group_id,
        fg.group_name,
        fg.brand_name,
        fg.category_name,
        fg.subcategory_name,
        nullif(prod->>'productId', '')::bigint as product_id,
        nullif(prod->>'name', '') as product_name,
        nullif(prod->>'sku', '') as product_sku,
        nullif(prod->>'sizeName', '') as size_label,
        nullif(prod->>'packOfSize', '')::int as pack_count,
        nullif(prod->>'price', '')::numeric as list_price_dollars,
        ${hasImageSql('prod', 'fg')} as has_image
      from filtered_groups fg
      cross join lateral jsonb_array_elements(coalesce(fg.live_state_json->'products', '[]'::jsonb)) prod
      where (${pSize}::text is null or trim(prod->>'sizeName') = ${pSize}::text)
    ),
    market_price as (
      select cmm.catalog_group_id, cmm.catalog_product_id, ${MARKET_PRICE_MEDIAN_EXPR} as median_pretax_price
      from catalog_market_matches cmm
        join fuzzy_skus fs on fs.id = cmm.fuzzy_sku_id
        join catalog_products cp
          on cp.catalog_group_id = cmm.catalog_group_id
         and cp.product_id = cmm.catalog_product_id
      where ${MARKET_PRICE_WHERE}
      group by cmm.catalog_group_id, cmm.catalog_product_id
    )
    select
      d.site_key, d.site_label, d.dealer_id,
      cp.catalog_group_id, cp.sweed_group_id, cp.product_id,
      coalesce(cp.product_sku, inv.product_sku) as product_sku,
      coalesce(cp.product_name, inv.product_name) as product_name,
      cp.brand_name, cp.category_name, cp.subcategory_name,
      cp.size_label, cp.pack_count,
      inv.distributor_name,
      cp.list_price_dollars,
      inv.wholesale_cost_dollars,
      mp.median_pretax_price as market_price_pretax_dollars,
      coalesce(inv.current_qty, 0) as current_qty,
      coalesce(inv.available_qty, 0) as available_qty,
      coalesce(inv.is_on_stock, false) as is_on_stock,
      inv.lab_thc_pct, inv.lab_cbd_pct,
      cp.has_image
    from catalog_products cp
      cross join selected_dealers d
      left join inventory_rollup inv on inv.dealer_id = d.dealer_id and inv.product_id = cp.product_id
      left join market_price mp on mp.catalog_group_id = cp.catalog_group_id and mp.catalog_product_id = cp.product_id
    order by cp.brand_name nulls last, cp.group_name, cp.size_label nulls last, d.site_label
    limit ${pLimit}
  `

  const params = [...values, SITE_DEALER_IDS, SITE_KEYS, SITE_LABELS, filters.size ?? null, limit]
  const result = await db.query<SnapshotSqlRow>(sql, params)
  return result.rows.map(mapRow)
}

/**
 * Stock snapshot CSV rows: one row per (site × variant) of current inventory
 * (sweed_package_current), annotated with catalog attributes. Includes
 * out-of-stock current rows (the `is_on_stock` column carries the truth).
 */
export async function listStockSnapshotCsvRows(
  db: Queryable,
  limit: number,
): Promise<CatalogSnapshotCsvRow[]> {
  const sql = `
    with selected_dealers as (
      select * from unnest($1::bigint[], $2::text[], $3::text[]) as d(dealer_id, site_key, site_label)
    ),
    ${inventoryRollupCte('$1')},
    mapping as (
      select distinct on ((prod->>'productId')::bigint)
        cg.id as catalog_group_id,
        cg.sweed_group_id,
        cg.group_name,
        cg.brand_name,
        cg.category_name,
        cg.subcategory_name,
        (prod->>'productId')::bigint as product_id,
        nullif(prod->>'name', '') as product_name,
        nullif(prod->>'sku', '') as product_sku,
        nullif(prod->>'sizeName', '') as size_label,
        nullif(prod->>'packOfSize', '')::int as pack_count,
        nullif(prod->>'price', '')::numeric as list_price_dollars,
        ${hasImageSql('prod', 'cg')} as has_image
      from catalog_groups cg
      cross join lateral jsonb_array_elements(coalesce(cg.live_state_json->'products', '[]'::jsonb)) prod
      where nullif(prod->>'productId', '') is not null
      order by (prod->>'productId')::bigint, cg.last_synced_at desc nulls last
    ),
    market_price as (
      select cmm.catalog_group_id, cmm.catalog_product_id, ${MARKET_PRICE_MEDIAN_EXPR} as median_pretax_price
      from catalog_market_matches cmm
        join fuzzy_skus fs on fs.id = cmm.fuzzy_sku_id
        join inventory_rollup inv on inv.product_id = cmm.catalog_product_id
      where ${MARKET_PRICE_WHERE}
      group by cmm.catalog_group_id, cmm.catalog_product_id
    )
    select
      d.site_key, d.site_label, d.dealer_id,
      m.catalog_group_id, m.sweed_group_id, inv.product_id,
      coalesce(m.product_sku, inv.product_sku) as product_sku,
      coalesce(m.product_name, inv.product_name) as product_name,
      m.brand_name, m.category_name, m.subcategory_name,
      m.size_label, m.pack_count,
      inv.distributor_name,
      m.list_price_dollars,
      inv.wholesale_cost_dollars,
      mp.median_pretax_price as market_price_pretax_dollars,
      inv.current_qty, inv.available_qty, inv.is_on_stock,
      inv.lab_thc_pct, inv.lab_cbd_pct,
      coalesce(m.has_image, false) as has_image
    from inventory_rollup inv
      join selected_dealers d on d.dealer_id = inv.dealer_id
      left join mapping m on m.product_id = inv.product_id
      left join market_price mp on mp.catalog_group_id = m.catalog_group_id and mp.catalog_product_id = inv.product_id
    order by d.site_label, m.brand_name nulls last, product_name nulls last
    limit $4
  `

  const params = [SITE_DEALER_IDS, SITE_KEYS, SITE_LABELS, limit]
  const result = await db.query<SnapshotSqlRow>(sql, params)
  return result.rows.map(mapRow)
}

// ---------------------------------------------------------------------------
// CSV rendering (RFC 4180). Shared by both exports so the column set stays
// identical. Money to 2dp, potency to 2dp, quantities raw.
// ---------------------------------------------------------------------------

const CSV_HEADER = [
  'site',
  'site_key',
  'dealer_id',
  'catalog_group_id',
  'sweed_group_id',
  'product_id',
  'sku',
  'product_name',
  'brand',
  'category',
  'subcategory',
  'size_label',
  'unit_size_g',
  'unit_size_mg',
  'pack_count',
  'cohort_key',
  'distributor',
  'list_price',
  'wholesale_cost',
  'market_price_pretax',
  'current_qty',
  'available_qty',
  'is_on_stock',
  'lab_thc_pct',
  'lab_cbd_pct',
  'has_image',
] as const

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function money(v: number | null): string {
  return v === null ? '' : v.toFixed(2)
}

function pct(v: number | null): string {
  return v === null ? '' : v.toFixed(2)
}

export function renderCatalogSnapshotCsv(rows: readonly CatalogSnapshotCsvRow[]): string {
  const lines = [CSV_HEADER.join(',')]
  for (const r of rows) {
    lines.push(
      [
        r.siteLabel,
        r.siteKey,
        r.dealerId,
        r.catalogGroupId ?? '',
        r.sweedGroupId ?? '',
        r.productId ?? '',
        r.sku ?? '',
        r.productName ?? '',
        r.brandName ?? '',
        r.categoryName ?? '(no category)',
        r.subcategoryName ?? '(no subcategory)',
        r.sizeLabel ?? '',
        r.unitSizeGrams ?? '',
        r.unitSizeMg ?? '',
        r.packCount ?? '',
        r.cohortKey,
        r.distributorName ?? '',
        money(r.listPriceDollars),
        money(r.wholesaleCostDollars),
        money(r.marketPricePretaxDollars),
        r.currentQty ?? '',
        r.availableQty ?? '',
        r.isOnStock === null ? '' : r.isOnStock,
        pct(r.labThcPct),
        pct(r.labCbdPct),
        r.hasImage,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return lines.join('\n') + '\n'
}
