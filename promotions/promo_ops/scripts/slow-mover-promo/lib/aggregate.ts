/**
 * Joins live inventory and Cube sales into category and category x brand
 * rollups, computes slow-mover features, and ranks candidate promo groups.
 *
 * Group-of-action rules (per workspace policy):
 *   - we propose on a CATEGORY when it has >= 2 brands present and the
 *     entire category is moving slowly;
 *   - we propose on a CATEGORY x BRAND when only that brand-within-category
 *     is dragging (the rest of the category sells through fine);
 *   - single-SKU promos are intentionally avoided unless the entire group
 *     contains exactly one SKU.
 *
 * Scoring is fully deterministic; the LLM only re-ranks and writes prose.
 */
import type {
  CategoryBrandSales,
  CategorySales,
  InventoryProduct,
  InventorySnapshot,
  ProductSalesRow,
  SalesWindow,
  SiteSalesSnapshot,
} from './data.js'

export interface AggregateInputs {
  inventory: InventorySnapshot
  sales: SiteSalesSnapshot
}

export interface ProductRollup {
  productId: number
  productName: string
  brand: string
  category: string
  subcategory: string | null
  onHandQty: number
  forSaleQty: number
  retailPrice: number | null
  cost: number | null
  grossMarginPct: number | null
  inventoryRetailValue: number
  oldestReceivedAt: string | null
  daysSinceOldestReceived: number | null
  windowUnitsSold: number
  windowNetSales: number
  windowGrossMargin: number
  windowPromoDiscount: number
  unitsPerDay: number
  daysOfSupply: number | null
  sellThroughPct: number | null
}

export interface GroupRollup {
  /** Stable URL-safe slug used as the detail page filename. */
  slug: string
  /** Human-readable label (e.g. "Vapes - Fernway" or "Pre-Rolls (all brands)"). */
  label: string
  scope: 'category' | 'category-brand'
  category: string
  brand: string | null
  products: ProductRollup[]
  // Aggregated metrics over the products in this group:
  onHandQty: number
  inventoryRetailValue: number
  inventoryCostValue: number
  windowUnitsSold: number
  windowNetSales: number
  windowGrossMargin: number
  windowPromoDiscount: number
  windowSellingPerDay: number
  daysOfSupply: number | null
  sellThroughPct: number | null
  blendedGrossMarginPct: number | null
  oldestReceivedAt: string | null
  daysSinceOldestReceived: number | null
  // Scoring:
  opportunityScore: number
  signals: GroupSignal[]
}

export interface GroupSignal {
  kind: 'days-of-supply' | 'sell-through' | 'inventory-value' | 'age' | 'low-velocity' | 'gm-cushion'
  weight: number
  detail: string
}

export interface AggregateResult {
  inventoryFetchedAt: string
  salesFetchedAt: string
  window: SalesWindow
  totals: {
    onHandQty: number
    inventoryRetailValue: number
    windowUnitsSold: number
    windowNetSales: number
  }
  candidateGroups: GroupRollup[]
}

/**
 * Configurable thresholds. Defaults are tuned for a 14-day window at the
 * Midtown site, where typical fast-movers cycle every 7-21 days. Reviewers
 * can raise/lower these later via Helios config.
 */
export interface ScoringConfig {
  /** Minimum days-of-supply before a group is considered for promo. */
  minDaysOfSupply: number
  /** Minimum on-hand retail $ value for a group to be candidate-eligible. */
  minInventoryRetailValue: number
  /** Sell-through % at or below this is treated as a strong slow-mover signal. */
  weakSellThroughPct: number
  /** Inventory-aging (days since oldest receive) past this is a strong signal. */
  agedReceiveDays: number
}

export const DEFAULT_SCORING: ScoringConfig = {
  minDaysOfSupply: 21,
  minInventoryRetailValue: 250,
  weakSellThroughPct: 25,
  agedReceiveDays: 30,
}

export function aggregateSlowMovers(
  { inventory, sales }: AggregateInputs,
  scoring: ScoringConfig = DEFAULT_SCORING,
): AggregateResult {
  // 1) Build per-product rollups. Inventory is the spine; sales are looked up
  //    via productId, with fallbacks for products with sales but zero current
  //    on-hand (those are excluded from slow-mover scope by definition).
  const productRollups = buildProductRollups(inventory.products, sales)

  // 2) Roll up at category-brand level, then at category level.
  const categoryBrandGroups = rollUpByCategoryBrand(productRollups)
  const categoryGroups = rollUpByCategory(productRollups)

  // 3) Score every group, then choose the right reporting unit per category:
  //    if the category as a whole is slow, propose on the category;
  //    otherwise surface the slow brand-within-category groups individually.
  const scoredCategoryBrand = categoryBrandGroups.map((group) => scoreGroup(group, scoring))
  const scoredCategory = categoryGroups.map((group) => scoreGroup(group, scoring))

  const candidates: GroupRollup[] = []
  for (const categoryGroup of scoredCategory) {
    if (
      isCandidate(categoryGroup, scoring) &&
      hasMultipleBrands(productRollups, categoryGroup.category)
    ) {
      candidates.push(categoryGroup)
      continue
    }
    // Fallback: surface qualifying brand-within-category groups.
    const brandGroups = scoredCategoryBrand.filter(
      (group) => group.category === categoryGroup.category && isCandidate(group, scoring),
    )
    candidates.push(...brandGroups)
  }

  // Always include any standalone category-brand groups whose category did not
  // appear in `categoryGroups` at all (defensive; should be empty in practice).
  for (const group of scoredCategoryBrand) {
    if (
      isCandidate(group, scoring) &&
      !candidates.some((c) => c.slug === group.slug) &&
      !scoredCategory.some((c) => c.category === group.category)
    ) {
      candidates.push(group)
    }
  }

  // De-duplicate (a category-level proposal supersedes its brand splits).
  const dedup = new Map<string, GroupRollup>()
  for (const group of candidates) {
    if (group.scope === 'category') {
      // Drop any already-recorded brand splits under the same category.
      for (const key of [...dedup.keys()]) {
        const existing = dedup.get(key)
        if (existing && existing.scope === 'category-brand' && existing.category === group.category) {
          dedup.delete(key)
        }
      }
      dedup.set(group.slug, group)
    } else if (![...dedup.values()].some((g) => g.scope === 'category' && g.category === group.category)) {
      dedup.set(group.slug, group)
    }
  }

  const sorted = [...dedup.values()].sort((a, b) => b.opportunityScore - a.opportunityScore)

  return {
    inventoryFetchedAt: inventory.fetchedAt,
    salesFetchedAt: sales.fetchedAt,
    window: sales.window,
    totals: {
      onHandQty: sumNumber(productRollups.map((p) => p.onHandQty)),
      inventoryRetailValue: sumNumber(productRollups.map((p) => p.inventoryRetailValue)),
      windowUnitsSold: sumNumber(productRollups.map((p) => p.windowUnitsSold)),
      windowNetSales: sumNumber(productRollups.map((p) => p.windowNetSales)),
    },
    candidateGroups: sorted,
  }
}

// ---------------------------------------------------------------------------
// product rollup
// ---------------------------------------------------------------------------

function buildProductRollups(
  inventory: InventoryProduct[],
  sales: SiteSalesSnapshot,
): ProductRollup[] {
  const salesByProductId = new Map<number, ProductSalesRow>()
  for (const row of sales.byProduct) {
    if (row.productId !== null) {
      const existing = salesByProductId.get(row.productId)
      if (existing) {
        existing.netSales += row.netSales
        existing.units += row.units
        existing.grossMargin += row.grossMargin
        existing.promoDiscount += row.promoDiscount
      } else {
        salesByProductId.set(row.productId, { ...row })
      }
    }
  }

  const days = Math.max(1, sales.window.days)
  // Anchor "days since received" to the moment we pulled the inventory
  // snapshot, so per-SKU age and group-level age use the same clock.
  const snapshotTime = Date.parse(sales.fetchedAt)
  const referenceTime = Number.isFinite(snapshotTime) ? snapshotTime : Date.now()

  return inventory
    .filter((product) => (product.availableQty ?? 0) > 0 || product.forSaleAvailableQty > 0)
    .map((product) => {
      const salesRow = product.productId ? salesByProductId.get(product.productId) : null
      const onHand = product.availableQty ?? product.currentQty ?? 0
      const retail = product.retailPrice ?? null
      const cost = product.weightedAverageCost ?? null
      const grossMarginPct =
        retail !== null && retail > 0 && cost !== null
          ? roundTo((1 - (1.13 * cost) / retail) * 100, 1)
          : null
      const inventoryRetailValue = retail !== null ? roundTo(retail * onHand, 2) : 0
      const windowUnits = salesRow?.units ?? 0
      const windowNetSales = salesRow?.netSales ?? 0
      const windowGrossMargin = salesRow?.grossMargin ?? 0
      const windowPromoDiscount = salesRow?.promoDiscount ?? 0
      const unitsPerDay = roundTo(windowUnits / days, 3)
      const daysOfSupply = unitsPerDay > 0 ? roundTo(onHand / unitsPerDay, 1) : null
      const sellThroughPct =
        windowUnits + onHand > 0 ? roundTo((windowUnits / (windowUnits + onHand)) * 100, 1) : null

      const oldestParsed = product.oldestReceivedAt ? Date.parse(product.oldestReceivedAt) : null
      const daysSinceOldestReceived =
        oldestParsed && Number.isFinite(oldestParsed)
          ? Math.max(0, Math.round((referenceTime - oldestParsed) / 86_400_000))
          : null

      return {
        productId: product.productId,
        productName: product.productName,
        brand: product.brandName ?? 'Unbranded',
        category: product.categoryName ?? 'Uncategorized',
        subcategory: product.subcategoryName,
        onHandQty: onHand,
        forSaleQty: product.forSaleAvailableQty,
        retailPrice: retail,
        cost,
        grossMarginPct,
        inventoryRetailValue,
        oldestReceivedAt: product.oldestReceivedAt,
        daysSinceOldestReceived,
        windowUnitsSold: windowUnits,
        windowNetSales: roundTo(windowNetSales, 2),
        windowGrossMargin: roundTo(windowGrossMargin, 2),
        windowPromoDiscount: roundTo(windowPromoDiscount, 2),
        unitsPerDay,
        daysOfSupply,
        sellThroughPct,
      }
    })
}

// ---------------------------------------------------------------------------
// group rollups
// ---------------------------------------------------------------------------

function rollUpByCategoryBrand(products: ProductRollup[]): GroupRollup[] {
  const buckets = new Map<string, ProductRollup[]>()
  for (const product of products) {
    const key = `${product.category}::${product.brand}`
    const list = buckets.get(key) ?? []
    list.push(product)
    buckets.set(key, list)
  }
  return [...buckets.values()].map((group) =>
    buildGroupRollup({
      products: group,
      scope: 'category-brand',
      category: group[0].category,
      brand: group[0].brand,
      label: `${group[0].category} - ${group[0].brand}`,
      slug: slugify(`cb-${group[0].category}-${group[0].brand}`),
    }),
  )
}

function rollUpByCategory(products: ProductRollup[]): GroupRollup[] {
  const buckets = new Map<string, ProductRollup[]>()
  for (const product of products) {
    const list = buckets.get(product.category) ?? []
    list.push(product)
    buckets.set(product.category, list)
  }
  return [...buckets.values()].map((group) =>
    buildGroupRollup({
      products: group,
      scope: 'category',
      category: group[0].category,
      brand: null,
      label: `${group[0].category} (all brands)`,
      slug: slugify(`cat-${group[0].category}`),
    }),
  )
}

function buildGroupRollup(input: {
  products: ProductRollup[]
  scope: 'category' | 'category-brand'
  category: string
  brand: string | null
  label: string
  slug: string
}): GroupRollup {
  const onHandQty = sumNumber(input.products.map((p) => p.onHandQty))
  const inventoryRetailValue = sumNumber(input.products.map((p) => p.inventoryRetailValue))
  const inventoryCostValue = sumNumber(
    input.products.map((p) =>
      p.cost !== null && p.onHandQty > 0 ? p.cost * p.onHandQty : 0,
    ),
  )
  const windowUnitsSold = sumNumber(input.products.map((p) => p.windowUnitsSold))
  const windowNetSales = sumNumber(input.products.map((p) => p.windowNetSales))
  const windowGrossMargin = sumNumber(input.products.map((p) => p.windowGrossMargin))
  const windowPromoDiscount = sumNumber(input.products.map((p) => p.windowPromoDiscount))
  const days = Math.max(1, deriveWindowDays(input.products))
  const windowSellingPerDay = roundTo(windowUnitsSold / days, 3)
  const daysOfSupply = windowSellingPerDay > 0 ? roundTo(onHandQty / windowSellingPerDay, 1) : null
  const denom = windowUnitsSold + onHandQty
  const sellThroughPct = denom > 0 ? roundTo((windowUnitsSold / denom) * 100, 1) : null
  const blendedGrossMarginPct =
    windowNetSales > 0 ? roundTo((windowGrossMargin / windowNetSales) * 100, 1) : null
  const ages = input.products
    .map((p) => p.oldestReceivedAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value))
  const oldestReceivedAt = ages.length > 0 ? new Date(Math.min(...ages)).toISOString() : null
  const daysSinceOldestReceived =
    oldestReceivedAt !== null
      ? Math.max(0, Math.round((Date.now() - Date.parse(oldestReceivedAt)) / 86_400_000))
      : null

  return {
    slug: input.slug,
    label: input.label,
    scope: input.scope,
    category: input.category,
    brand: input.brand,
    products: [...input.products].sort((a, b) => b.inventoryRetailValue - a.inventoryRetailValue),
    onHandQty,
    inventoryRetailValue: roundTo(inventoryRetailValue, 2),
    inventoryCostValue: roundTo(inventoryCostValue, 2),
    windowUnitsSold,
    windowNetSales: roundTo(windowNetSales, 2),
    windowGrossMargin: roundTo(windowGrossMargin, 2),
    windowPromoDiscount: roundTo(windowPromoDiscount, 2),
    windowSellingPerDay,
    daysOfSupply,
    sellThroughPct,
    blendedGrossMarginPct,
    oldestReceivedAt,
    daysSinceOldestReceived,
    opportunityScore: 0,
    signals: [],
  }
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

function scoreGroup(group: GroupRollup, scoring: ScoringConfig): GroupRollup {
  const signals: GroupSignal[] = []

  // Days-of-supply signal: longer is worse. Capped to keep one giant SKU
  // from drowning every other group.
  if (group.daysOfSupply === null) {
    signals.push({
      kind: 'low-velocity',
      weight: 8,
      detail: `No sales in the window for ${group.products.length} SKU(s) on hand.`,
    })
  } else if (group.daysOfSupply >= scoring.minDaysOfSupply) {
    const dosWeight = Math.min(40, Math.round((group.daysOfSupply / scoring.minDaysOfSupply) * 8))
    signals.push({
      kind: 'days-of-supply',
      weight: dosWeight,
      detail: `${group.daysOfSupply} days of supply at the current ${group.windowSellingPerDay}/day pace.`,
    })
  }

  // Sell-through signal: lower is worse.
  if (group.sellThroughPct !== null && group.sellThroughPct <= scoring.weakSellThroughPct) {
    const stWeight = Math.min(20, Math.round((scoring.weakSellThroughPct - group.sellThroughPct) / 2))
    if (stWeight > 0) {
      signals.push({
        kind: 'sell-through',
        weight: stWeight,
        detail: `Window sell-through is ${group.sellThroughPct}% (sold/(sold+on-hand)).`,
      })
    }
  }

  // Inventory $ exposure: higher exposure = stronger candidate (but bounded).
  if (group.inventoryRetailValue >= scoring.minInventoryRetailValue) {
    const ivWeight = Math.min(
      20,
      Math.round(Math.log10(group.inventoryRetailValue / scoring.minInventoryRetailValue + 1) * 12),
    )
    signals.push({
      kind: 'inventory-value',
      weight: ivWeight,
      detail: `${formatUsd(group.inventoryRetailValue)} of retail value sitting on shelves.`,
    })
  }

  // Aging signal: oldest received older than threshold.
  if (group.daysSinceOldestReceived !== null && group.daysSinceOldestReceived >= scoring.agedReceiveDays) {
    const ageWeight = Math.min(20, Math.round((group.daysSinceOldestReceived - scoring.agedReceiveDays) / 5))
    if (ageWeight > 0) {
      signals.push({
        kind: 'age',
        weight: ageWeight,
        detail: `Oldest unit received ${group.daysSinceOldestReceived} days ago (${formatIsoDate(group.oldestReceivedAt)}).`,
      })
    }
  }

  // Margin cushion: higher GM% means more room to discount. Adds modest weight.
  if (group.blendedGrossMarginPct !== null && group.blendedGrossMarginPct >= 50) {
    const cushion = Math.min(10, Math.round((group.blendedGrossMarginPct - 50) / 2))
    if (cushion > 0) {
      signals.push({
        kind: 'gm-cushion',
        weight: cushion,
        detail: `${group.blendedGrossMarginPct}% blended GM gives discount room.`,
      })
    }
  }

  const opportunityScore = signals.reduce((sum, signal) => sum + signal.weight, 0)
  return { ...group, opportunityScore, signals }
}

function isCandidate(group: GroupRollup, scoring: ScoringConfig): boolean {
  if (group.inventoryRetailValue < scoring.minInventoryRetailValue) return false
  if (group.opportunityScore < 10) return false
  // Need a meaningful slow-mover signal, not just shelf $.
  return group.signals.some(
    (signal) =>
      signal.kind === 'days-of-supply' ||
      signal.kind === 'sell-through' ||
      signal.kind === 'low-velocity' ||
      signal.kind === 'age',
  )
}

function hasMultipleBrands(products: ProductRollup[], category: string): boolean {
  const brands = new Set(products.filter((p) => p.category === category).map((p) => p.brand))
  return brands.size >= 2
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sumNumber(values: number[]): number {
  return values.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0)
}

function deriveWindowDays(products: ProductRollup[]): number {
  // unitsPerDay was computed against the snapshot's window length; recover it
  // (defensively) by inverting one product with a non-zero pace.
  for (const product of products) {
    if (product.unitsPerDay > 0 && product.windowUnitsSold > 0) {
      return Math.max(1, Math.round(product.windowUnitsSold / product.unitsPerDay))
    }
  }
  return 14
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function formatUsd(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

function formatIsoDate(value: string | null): string {
  if (!value) return 'unknown'
  return value.slice(0, 10)
}
