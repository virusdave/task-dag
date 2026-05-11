/**
 * Pulls the two data inputs the slow-mover packet needs from Sweed:
 *
 *   1. Live grouped inventory at the chosen site (currently Midtown).
 *      Source: `store.inventory.item.list.grouped` paged at the site dealer.
 *      Provides per-product on-hand, retail price, brand+category, oldest
 *      received-date, and per-lot wholesale cost.
 *
 *   2. Last-N-day sales aggregated at four levels from the BI Cube
 *      `PromotionEffectiveness` fact table, filtered to the site dealer:
 *        - by category               (rollup A)
 *        - by category x brand       (rollup B - the unit we propose on)
 *        - by category x brand x productID (drill-in for the price ladder)
 *
 * Everything is read-only.
 */
import {
  callCubeLoad,
  callSweedRpc,
  getCubeJwt,
  runInDealerSession,
  type SweedClientConfig,
} from './sweed.js'

export interface SiteScope {
  dealerId: number
  label: string
}

export const MIDTOWN_SITE: SiteScope = { dealerId: 210705, label: 'Freshly Baked NYC - Midtown' }

export interface InventoryLot {
  receivedAt: string | null
  wholesaleCost: number | null
  availableQty: number | null
  stockLocationName: string | null
  isAvailableOnline: boolean | null
  isNotForSale: boolean | null
  isTradeSample: boolean | null
}

export interface InventoryProduct {
  productId: number
  productName: string
  brandId: number | null
  brandName: string | null
  categoryId: number | null
  categoryName: string | null
  subcategoryId: number | null
  subcategoryName: string | null
  currentQty: number | null
  availableQty: number | null
  retailPrice: number | null
  oldestReceivedAt: string | null
  newestReceivedAt: string | null
  lotCount: number
  weightedAverageCost: number | null
  forSaleAvailableQty: number
  lots: InventoryLot[]
}

export interface InventorySnapshot {
  fetchedAt: string
  site: SiteScope
  totalProducts: number
  products: InventoryProduct[]
}

interface RawGroupedInventoryResponse {
  data?: Array<Record<string, unknown>>
  totalCount?: number
}

const INVENTORY_PAGE_SIZE = 200

export async function loadLiveInventory(
  config: SweedClientConfig,
  site: SiteScope,
): Promise<InventorySnapshot> {
  return runInDealerSession(config, site.dealerId, async () => {
    const products: InventoryProduct[] = []
    let page = 1

    while (true) {
      const raw = await callSweedRpc<RawGroupedInventoryResponse>(
        config,
        'store.inventory.item.list.grouped',
        { page, pageSize: INVENTORY_PAGE_SIZE, isOnStock: true },
      )
      const rows = raw.data ?? []
      for (const row of rows) {
        const product = parseInventoryRow(row)
        if (product) products.push(product)
      }
      if (rows.length < INVENTORY_PAGE_SIZE) break
      page += 1
    }

    return {
      fetchedAt: new Date().toISOString(),
      site,
      totalProducts: products.length,
      products,
    }
  })
}

function parseInventoryRow(row: Record<string, unknown>): InventoryProduct | null {
  const product = (row.product ?? {}) as { id?: unknown; name?: unknown; shortName?: unknown }
  const productId = toIntegerId(product.id)
  if (productId === null) return null

  const brand = (row.productBrand ?? null) as { id?: unknown; name?: unknown } | null
  const category = (row.category ?? null) as { id?: unknown; name?: unknown } | null
  const subcategory = (row.subcategory ?? null) as { id?: unknown; name?: unknown } | null
  const itemsRaw = Array.isArray(row.items) ? (row.items as Array<Record<string, unknown>>) : []

  const lots: InventoryLot[] = itemsRaw.map((it) => ({
    receivedAt: typeof it.dateTimeReceived === 'string' ? it.dateTimeReceived : null,
    wholesaleCost: toNumber(it.wholesaleCost),
    availableQty: toNumber(it.availableQty) ?? toNumber(it.currentQty),
    stockLocationName:
      typeof (it.stockLocation as { name?: string } | undefined)?.name === 'string'
        ? ((it.stockLocation as { name?: string }).name as string)
        : null,
    isAvailableOnline: typeof it.isAvailableOnline === 'boolean' ? (it.isAvailableOnline as boolean) : null,
    isNotForSale: typeof it.isNotForSale === 'boolean' ? (it.isNotForSale as boolean) : null,
    isTradeSample: typeof it.isTradeSample === 'boolean' ? (it.isTradeSample as boolean) : null,
  }))

  const receivedTimestamps = lots
    .map((lot) => lot.receivedAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value))

  const forSaleLots = lots.filter(
    (lot) =>
      !lot.isTradeSample &&
      !lot.isNotForSale &&
      lot.isAvailableOnline !== false &&
      isForSaleStockLocation(lot.stockLocationName),
  )
  const forSaleAvailableQty = forSaleLots.reduce((sum, lot) => sum + (lot.availableQty ?? 0), 0)

  const costEvidence = lots
    .map((lot) => ({
      cost: lot.wholesaleCost,
      qty: lot.availableQty,
    }))
    .filter((entry): entry is { cost: number; qty: number | null } => entry.cost !== null && entry.cost > 0)
  const weightedAverageCost = computeWeightedAverageCost(costEvidence)

  return {
    productId,
    productName:
      normalizeText((product.shortName as string | null | undefined) ?? (product.name as string | null | undefined)) ||
      `Product #${productId}`,
    brandId: toIntegerId(brand?.id),
    brandName: normalizeText(brand?.name as string | null | undefined),
    categoryId: toIntegerId(category?.id),
    categoryName: normalizeText(category?.name as string | null | undefined),
    subcategoryId: toIntegerId(subcategory?.id),
    subcategoryName: normalizeText(subcategory?.name as string | null | undefined),
    currentQty: toNumber(row.currentQty),
    availableQty: toNumber(row.availableQty) ?? toNumber(row.currentQty),
    retailPrice: toNumber(row.localPrice) ?? toNumber(row.globalPrice),
    oldestReceivedAt:
      receivedTimestamps.length > 0 ? new Date(Math.min(...receivedTimestamps)).toISOString() : null,
    newestReceivedAt:
      receivedTimestamps.length > 0 ? new Date(Math.max(...receivedTimestamps)).toISOString() : null,
    lotCount: lots.length,
    weightedAverageCost,
    forSaleAvailableQty,
    lots,
  }
}

function computeWeightedAverageCost(
  entries: Array<{ cost: number; qty: number | null }>,
): number | null {
  if (entries.length === 0) return null
  const totalQty = entries.reduce((sum, entry) => sum + Math.max(0, entry.qty ?? 0), 0)
  if (totalQty <= 0) {
    // Fall back to plain mean of lot costs when we have cost evidence but no usable qty.
    const meanCost = entries.reduce((sum, entry) => sum + entry.cost, 0) / entries.length
    return roundTo(meanCost, 4)
  }
  const weighted =
    entries.reduce((sum, entry) => sum + entry.cost * Math.max(0, entry.qty ?? 0), 0) / totalQty
  return roundTo(weighted, 4)
}

function isForSaleStockLocation(name: string | null): boolean {
  if (!name) return false
  return /for sale/i.test(name)
}

// ---------------------------------------------------------------------------
// Sales (Cube BI)
// ---------------------------------------------------------------------------

export interface SalesWindow {
  /** Inclusive ISO date (YYYY-MM-DD) - first day in the window. */
  startDate: string
  /** Inclusive ISO date (YYYY-MM-DD) - last day in the window. */
  endDate: string
  /** Calendar-day count in the window (= last - first + 1). */
  days: number
}

export interface CategoryBrandSales {
  category: string
  brand: string
  netSales: number
  units: number
  grossMargin: number
  promoDiscount: number
}

export interface CategorySales {
  category: string
  netSales: number
  units: number
  grossMargin: number
  promoDiscount: number
}

export interface ProductSalesRow {
  category: string
  brand: string
  productId: number | null
  productName: string
  netSales: number
  units: number
  grossMargin: number
  promoDiscount: number
}

export interface SiteSalesSnapshot {
  fetchedAt: string
  site: SiteScope
  window: SalesWindow
  byCategory: CategorySales[]
  byCategoryBrand: CategoryBrandSales[]
  byProduct: ProductSalesRow[]
}

const SALES_MEASURES = [
  'PromotionEffectiveness.netSales',
  'PromotionEffectiveness.quantity',
  'PromotionEffectiveness.grossMargin',
  'PromotionEffectiveness.promoDiscount',
] as const

export function buildSalesWindow(days: number, todayIso?: string): SalesWindow {
  if (days < 1) throw new Error('Sales window must be at least 1 day')
  const today = todayIso ? new Date(todayIso) : new Date()
  const end = new Date(today)
  end.setUTCDate(end.getUTCDate() - 1) // exclude today (incomplete trading day)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - (days - 1))
  return {
    startDate: isoDate(start),
    endDate: isoDate(end),
    days,
  }
}

export async function loadSiteSales(
  config: SweedClientConfig,
  site: SiteScope,
  window: SalesWindow,
): Promise<SiteSalesSnapshot> {
  // Cube BI is a state-level dataset filtered by dealerID; no dealer.set required,
  // but we still wrap in a session so the BI JWT call piggybacks on the same lock.
  return runInDealerSession(config, site.dealerId, async () => {
    const jwt = await getCubeJwt(config)

    const dealerFilter = {
      member: 'PromotionEffectiveness.dealerID',
      operator: 'equals',
      values: [String(site.dealerId)],
    }

    const timeDimension = {
      dimension: 'PromotionEffectiveness.invoiceDatetime',
      dateRange: [window.startDate, window.endDate] as [string, string],
    }

    const byCategory = (
      await callCubeLoad(config, jwt, {
        dimensions: ['PromotionEffectiveness.productCategory'],
        filters: [dealerFilter],
        measures: [...SALES_MEASURES],
        order: { 'PromotionEffectiveness.netSales': 'desc' },
        renewQuery: true,
        timeDimensions: [timeDimension],
        timezone: 'America/New_York',
        limit: 200,
      })
    ).data
      .map((row) => ({
        category: stringValue(row['PromotionEffectiveness.productCategory']) ?? 'Uncategorized',
        netSales: numberValue(row['PromotionEffectiveness.netSales']) ?? 0,
        units: numberValue(row['PromotionEffectiveness.quantity']) ?? 0,
        grossMargin: numberValue(row['PromotionEffectiveness.grossMargin']) ?? 0,
        promoDiscount: numberValue(row['PromotionEffectiveness.promoDiscount']) ?? 0,
      }))

    const byCategoryBrand = (
      await callCubeLoad(config, jwt, {
        dimensions: [
          'PromotionEffectiveness.productCategory',
          'PromotionEffectiveness.productBrand',
        ],
        filters: [dealerFilter],
        measures: [...SALES_MEASURES],
        order: { 'PromotionEffectiveness.netSales': 'desc' },
        renewQuery: true,
        timeDimensions: [timeDimension],
        timezone: 'America/New_York',
        limit: 2000,
      })
    ).data
      .map((row) => ({
        category: stringValue(row['PromotionEffectiveness.productCategory']) ?? 'Uncategorized',
        brand: stringValue(row['PromotionEffectiveness.productBrand']) ?? 'Unbranded',
        netSales: numberValue(row['PromotionEffectiveness.netSales']) ?? 0,
        units: numberValue(row['PromotionEffectiveness.quantity']) ?? 0,
        grossMargin: numberValue(row['PromotionEffectiveness.grossMargin']) ?? 0,
        promoDiscount: numberValue(row['PromotionEffectiveness.promoDiscount']) ?? 0,
      }))

    const byProduct = (
      await callCubeLoad(config, jwt, {
        dimensions: [
          'PromotionEffectiveness.productCategory',
          'PromotionEffectiveness.productBrand',
          'PromotionEffectiveness.productID',
          'PromotionEffectiveness.productName',
        ],
        filters: [dealerFilter],
        measures: [...SALES_MEASURES],
        order: { 'PromotionEffectiveness.netSales': 'desc' },
        renewQuery: true,
        timeDimensions: [timeDimension],
        timezone: 'America/New_York',
        limit: 5000,
      })
    ).data
      .map((row) => ({
        category: stringValue(row['PromotionEffectiveness.productCategory']) ?? 'Uncategorized',
        brand: stringValue(row['PromotionEffectiveness.productBrand']) ?? 'Unbranded',
        productId: numberValue(row['PromotionEffectiveness.productID']) ?? null,
        productName:
          stringValue(row['PromotionEffectiveness.productName']) ?? '(unknown product)',
        netSales: numberValue(row['PromotionEffectiveness.netSales']) ?? 0,
        units: numberValue(row['PromotionEffectiveness.quantity']) ?? 0,
        grossMargin: numberValue(row['PromotionEffectiveness.grossMargin']) ?? 0,
        promoDiscount: numberValue(row['PromotionEffectiveness.promoDiscount']) ?? 0,
      }))

    return {
      fetchedAt: new Date().toISOString(),
      site,
      window,
      byCategory,
      byCategoryBrand,
      byProduct,
    }
  })
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toIntegerId(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function numberValue(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function stringValue(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

function normalizeText(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
