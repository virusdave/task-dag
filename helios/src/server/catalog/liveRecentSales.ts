import { z } from 'zod'

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type GroupRecentSales,
  type GroupRecentSalesProductRow,
  type JsonValue,
  type RecentSalesSummary,
} from '../../shared/contracts/index.js'
import type { Queryable } from '../db/pool.js'

const CatalogGroupProductsSchema = z.object({
  products: z.array(
    z.object({
      name: z.string().nullable().optional(),
      productId: z.coerce.number().int().positive(),
      tab: z.string().nullable().optional(),
    }).passthrough(),
  ).default([]),
})

interface ProductDealerMetrics {
  last30DaysGrossSales: number | null
  onHand: number | null
  unitsPerDay: number | null
}

interface GroupProduct {
  productId: number
  productName: string
  productTab: string
}

interface GroupRecentSalesInput {
  catalogGroupId: number
  liveState: JsonValue
}

export function buildEmptyGroupRecentSales(liveState: JsonValue): GroupRecentSales {
  const products = extractGroupProducts(liveState)
  const productRows = HELIOS_PENDING_PURCHASE_SITE_DEALERS.flatMap((site) =>
    products.map((product) => buildProductRow(site, product, null, null)),
  )

  return {
    productRows,
    reportSource: 'helios.sweed_orders',
    sites: HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => ({
      siteDealerId: site.dealerId,
      siteKey: site.siteKey,
      siteLabel: site.siteLabel,
      summary: buildRecentSalesSummary(productRows.filter((row) => row.siteDealerId === site.dealerId)),
    })),
    summary: buildRecentSalesSummary(productRows),
  }
}

/**
 * Compute per-(dealer, product) recent-sales metrics for the given
 * catalog groups directly from helios's own `sweed_orders` mirror +
 * `sweed_package_current` view.
 *
 * History (May 2026):
 *
 *   v1 of this loader called Sweed's `store.reports.reorder` RPC and
 *   paginated the entire per-dealer reorder report (pageSize=200) on
 *   every cache miss — the only way the partner API exposes
 *   per-product 7d-units / 30d-gross / on-hand. For a single
 *   `/catalog/groups/:id` request that wanted exactly 1-3 productIds
 *   we were pulling ~30 RPC pages × 2 dealers, which made the cold
 *   detail page take ~24s. That's why a previous commit ripped recent
 *   sales out of the detail page entirely and replaced it with a
 *   "not loaded on this page" banner.
 *
 *   We now own the underlying line items locally in
 *   `sweed_orders.raw_json->'items'[]` (filed by the orders-ingest
 *   worker; see `sweed_orders` schema) and the inventoryItemId →
 *   productId mapping in `sweed_package_current`. That's enough to
 *   compute identical metrics with a single ~250ms SQL query that
 *   touches only the productIds the caller actually asked for —
 *   no Sweed RPC, no per-dealer pagination, no 24s cold path.
 *
 *   `reportSource` is bumped to `'helios.sweed_orders'` so the
 *   reviewer-facing label on the SPA reflects the provenance shift.
 */
export async function loadRecentSalesForGroups(
  db: Queryable,
  groups: GroupRecentSalesInput[],
): Promise<Map<number, GroupRecentSales>> {
  const parsedGroups = groups.map((group) => ({
    catalogGroupId: group.catalogGroupId,
    products: extractGroupProducts(group.liveState),
  }))

  const allProductIds = Array.from(
    new Set(parsedGroups.flatMap((group) => group.products.map((product) => product.productId))),
  )

  const metricsByProductByDealer = allProductIds.length === 0
    ? new Map<number, Map<number, ProductDealerMetrics>>()
    : await loadProductDealerMetrics(db, allProductIds)

  const reportDate = new Date().toISOString()
  return new Map(
    parsedGroups.map((group) => [
      group.catalogGroupId,
      buildGroupRecentSales(group.products, metricsByProductByDealer, reportDate),
    ]),
  )
}

async function loadProductDealerMetrics(
  db: Queryable,
  productIds: number[],
): Promise<Map<number, Map<number, ProductDealerMetrics>>> {
  // One DB-side aggregation covers every (productId, dealerId) pair
  // the caller asked about. We:
  //
  //   1. Resolve target productIds → (dealer_id, inventory_item_id)
  //      via `sweed_package_current` (the DISTINCT ON view that
  //      collapses sweed_package_snapshots to its latest shape per
  //      package).
  //   2. Read the last 30 days of order line items from the
  //      materialised `sweed_order_items_flat` table (D1), driven by
  //      `sweed_order_items_flat_dealer_pay_idx` on (dealer_id,
  //      pay_time) so we only touch rolling-30d rows, not the full
  //      order history — and never re-unroll raw_json at request time.
  //   3. Aggregate per (dealer_id, product_id): sum gross over 30d,
  //      sum units over the last 7d (the reorder report used a
  //      7d unitsPerDay window — keep parity), and full-outer-join
  //      against the same view to pull current on-hand for products
  //      that had no recent sales but still have stock.
  //
  // Restricted to HELIOS_PENDING_PURCHASE_SITE_DEALERS so we don't
  // bleed metrics from any non-NYC dealer ingest that ends up in
  // sweed_orders/sweed_package_current.
  const dealerIds = HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => site.dealerId)
  const result = await db.query<{
    dealer_id: string
    product_id: string
    last_30d_gross: string | null
    units_7d: string | null
    on_hand: string | null
  }>(
    `with target_products as (
       select unnest($1::bigint[]) as product_id
     ),
     target_dealers as (
       select unnest($2::bigint[]) as dealer_id
     ),
     target_packages as (
       select spc.dealer_id, spc.inventory_item_id, spc.product_id
         from sweed_package_current spc
         join target_products tp on tp.product_id = spc.product_id
         join target_dealers td on td.dealer_id = spc.dealer_id
     ),
     last_30d_lines as (
       -- D1: reads materialised sweed_order_items_flat instead of
       -- unrolling sweed_orders.raw_json->'items' per request. f.qty
       -- mirrors currentQty, f.revenue mirrors subtotalAmount, and the
       -- flat table only stores rows with a non-null inventory_item_id
       -- (which is exactly what the target_packages join below keeps).
       -- Live dark-diff over the rolling 30d window showed 0 differences
       -- in per-(dealer,inventory_item) 30d gross / 7d units.
       select f.dealer_id,
              f.pay_time,
              f.inventory_item_id as inventory_item_id,
              f.qty as qty,
              f.revenue as gross
         from sweed_order_items_flat f
        where f.pay_time >= now() - interval '30 days'
          and f.dealer_id in (select dealer_id from target_dealers)
     ),
     sales_per_dp as (
       select tp.dealer_id, tp.product_id,
              sum(l.gross) as last_30d_gross,
              sum(l.qty) filter (where l.pay_time >= now() - interval '7 days') as units_7d
         from last_30d_lines l
         join target_packages tp using (dealer_id, inventory_item_id)
        group by tp.dealer_id, tp.product_id
     ),
     on_hand_per_dp as (
       select spc.dealer_id, spc.product_id,
              sum(coalesce(spc.available_qty, spc.current_qty, 0)) as on_hand
         from sweed_package_current spc
         join target_products tp on tp.product_id = spc.product_id
         join target_dealers td on td.dealer_id = spc.dealer_id
        where coalesce(spc.is_on_stock, true)
        group by spc.dealer_id, spc.product_id
     )
     select coalesce(s.dealer_id, h.dealer_id)::text as dealer_id,
            coalesce(s.product_id, h.product_id)::text as product_id,
            s.last_30d_gross::text as last_30d_gross,
            s.units_7d::text as units_7d,
            h.on_hand::text as on_hand
       from sales_per_dp s
       full outer join on_hand_per_dp h
         on h.dealer_id = s.dealer_id and h.product_id = s.product_id`,
    [productIds, dealerIds],
  )

  const byProduct = new Map<number, Map<number, ProductDealerMetrics>>()
  for (const row of result.rows) {
    const dealerId = Number.parseInt(row.dealer_id, 10)
    const productId = Number.parseInt(row.product_id, 10)
    if (!Number.isFinite(dealerId) || !Number.isFinite(productId)) continue
    const last30 = parseNullableNumber(row.last_30d_gross)
    const units7 = parseNullableNumber(row.units_7d)
    const onHand = parseNullableNumber(row.on_hand)
    const unitsPerDay = units7 !== null ? roundNumber(units7 / 7) : null
    let inner = byProduct.get(productId)
    if (!inner) {
      inner = new Map<number, ProductDealerMetrics>()
      byProduct.set(productId, inner)
    }
    inner.set(dealerId, {
      last30DaysGrossSales: last30 !== null ? roundNumber(last30) : null,
      onHand: onHand !== null ? roundNumber(onHand) : null,
      unitsPerDay,
    })
  }
  return byProduct
}

function buildGroupRecentSales(
  products: GroupProduct[],
  metricsByProductByDealer: Map<number, Map<number, ProductDealerMetrics>>,
  reportDate: string,
): GroupRecentSales {
  const productRows = HELIOS_PENDING_PURCHASE_SITE_DEALERS.flatMap((site) =>
    products.map((product) => {
      const metrics = metricsByProductByDealer.get(product.productId)?.get(site.dealerId) ?? null
      return buildProductRow(site, product, metrics, reportDate)
    }),
  )

  const sites = HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((site) => ({
    siteDealerId: site.dealerId,
    siteKey: site.siteKey,
    siteLabel: site.siteLabel,
    summary: buildRecentSalesSummary(productRows.filter((row) => row.siteDealerId === site.dealerId)),
  }))

  return {
    productRows,
    reportSource: 'helios.sweed_orders',
    sites,
    summary: buildRecentSalesSummary(productRows),
  }
}

function buildProductRow(
  site: (typeof HELIOS_PENDING_PURCHASE_SITE_DEALERS)[number],
  product: GroupProduct,
  metrics: ProductDealerMetrics | null,
  fallbackReportDate: string | null,
): GroupRecentSalesProductRow {
  const unitsPerDay = metrics?.unitsPerDay ?? null
  // A row "has coverage" iff helios saw evidence for it — either a
  // recent sale OR current on-hand stock. We never fabricate
  // zero-units rows for products that aren't in the catalog mirror
  // yet, because that would silently understate `coverageCount` in
  // the aggregate summary.
  const hasCoverage = metrics !== null && (
    metrics.last30DaysGrossSales !== null ||
    metrics.onHand !== null ||
    metrics.unitsPerDay !== null
  )

  return {
    daysPerUnit: unitsPerDay !== null && unitsPerDay > 0 ? roundNumber(1 / unitsPerDay) : null,
    hasCoverage,
    last30DaysGrossSales: metrics?.last30DaysGrossSales ?? null,
    onHand: metrics?.onHand ?? null,
    productId: product.productId,
    productName: product.productName,
    productTab: product.productTab,
    reportDate: fallbackReportDate,
    siteDealerId: site.dealerId,
    siteKey: site.siteKey,
    siteLabel: site.siteLabel,
    unitsPerDay,
  }
}

function buildRecentSalesSummary(rows: GroupRecentSalesProductRow[]): RecentSalesSummary {
  const coveredRows = rows.filter((row) => row.hasCoverage)
  const totalUnitsPerDay = sumNullable(coveredRows.map((row) => row.unitsPerDay))
  const totalOnHand = sumNullable(coveredRows.map((row) => row.onHand))
  const totalLast30DaysGrossSales = sumNullable(coveredRows.map((row) => row.last30DaysGrossSales))
  const reportDate = latestReportDate(coveredRows.map((row) => row.reportDate))

  return {
    combinationCount: rows.length,
    coverageCount: coveredRows.length,
    daysPerUnit:
      totalUnitsPerDay !== null && totalUnitsPerDay > 0 ? roundNumber(1 / totalUnitsPerDay) : null,
    last30DaysGrossSales: totalLast30DaysGrossSales,
    onHand: totalOnHand,
    reportDate,
    unitsPerDay: totalUnitsPerDay,
  }
}

function extractGroupProducts(liveState: JsonValue): GroupProduct[] {
  const parsed = CatalogGroupProductsSchema.safeParse(liveState)
  if (!parsed.success) {
    return []
  }

  const dedupedProducts = new Map<number, GroupProduct>()
  for (const product of parsed.data.products) {
    dedupedProducts.set(product.productId, {
      productId: product.productId,
      productName: normalizeText(product.name) || `Product #${product.productId}`,
      productTab: normalizeText(product.tab) || 'No tab',
    })
  }

  return [...dedupedProducts.values()].sort((left, right) => {
    if (left.productTab !== right.productTab) {
      return left.productTab.localeCompare(right.productTab)
    }
    if (left.productName !== right.productName) {
      return left.productName.localeCompare(right.productName)
    }
    return left.productId - right.productId
  })
}

function latestReportDate(reportDates: Array<string | null>): string | null {
  let latestValue: string | null = null
  let latestTimestamp = Number.NEGATIVE_INFINITY

  for (const reportDate of reportDates) {
    if (!reportDate) {
      continue
    }
    const timestamp = Date.parse(reportDate)
    if (!Number.isFinite(timestamp) || timestamp <= latestTimestamp) {
      continue
    }

    latestValue = reportDate
    latestTimestamp = timestamp
  }

  return latestValue
}

function sumNullable(values: Array<number | null>): number | null {
  const presentValues = values.filter((value): value is number => value !== null)
  if (presentValues.length === 0) {
    return null
  }

  return roundNumber(presentValues.reduce((sum, value) => sum + value, 0))
}

function parseNullableNumber(value: string | null): number | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  const parsed = Number.parseFloat(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100
}

function normalizeText(value: string | null | undefined): string {
  return String(value ?? '')
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .join(' ')
    .trim()
}
