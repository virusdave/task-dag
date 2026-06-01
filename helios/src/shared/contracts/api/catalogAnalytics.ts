import { z } from 'zod'

// ---------------------------------------------------------------------------
// Catalog analytics — per-variant performance scatter plots.
//
// Backs the /metrics → "Catalog analytics" tab. Unlike the time-series
// metrics endpoint (one dot per bucket, lots of buckets per series),
// these endpoints return ONE point PER inventory_item (per SKU/variant)
// aggregated over a date window. The SPA renders the result as a
// hover-able scatter where the operator picks X and Y from a fixed set
// of per-variant metrics, and can filter by category / subcategory /
// brand / size.
//
// Why a dedicated API surface rather than another `/api/metrics/<id>`?
//   * The metric is two-dimensional in the user-picked sense (any pair
//     of metrics on the X / Y axes), not a fixed (axisX, axisY) pair.
//   * The natural grain is per-variant, not per-(time-bucket × site).
//     Bucketing by week is meaningless when each point already
//     represents a long-window aggregate of one item's lifetime sales.
//   * Filters (category / subcategory / brand / size / variant) and
//     cohort overlays don't fit the metric registry shape.
// ---------------------------------------------------------------------------

// ============================ Filters endpoint =============================

/**
 * One filter option (category / subcategory / brand / size / distributor).
 *
 * `id` is the stable join key (e.g. category_id) used by the points
 * endpoint; `label` is what the SPA shows in the dropdown chip. For
 * `size`, `id === label` (size_label is the join key).
 */
export const CatalogFilterOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  // How many distinct inventory_item rows currently fall under this
  // option. Drives the (n=…) hint in the dropdown so the operator
  // sees at a glance whether filtering will yield a meaningful set.
  itemCount: z.number().int().nonnegative(),
})
export type CatalogFilterOption = z.infer<typeof CatalogFilterOptionSchema>

export const CatalogAnalyticsFiltersResponseSchema = z.object({
  categories: z.array(CatalogFilterOptionSchema),
  subcategories: z.array(CatalogFilterOptionSchema),
  brands: z.array(CatalogFilterOptionSchema),
  /** Distributor names sourced from sweed_package_current.distributor_name. */
  distributors: z.array(CatalogFilterOptionSchema),
  sizes: z.array(CatalogFilterOptionSchema),
  /**
   * Pack counts (units per package) sourced from
   * catalog_groups.live_state_json->'products'[i].packOfSize. ids are
   * the integer pack-count rendered as a string (e.g. "1", "5",
   * "10"); label is "{n}-pack" for n>1 and "1 per pkg" for n=1.
   */
  packCounts: z.array(CatalogFilterOptionSchema),
})
export type CatalogAnalyticsFiltersResponse = z.infer<
  typeof CatalogAnalyticsFiltersResponseSchema
>

const csvList = z
  .string()
  .optional()
  .transform((value) =>
    value && value.trim().length > 0
      ? value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [],
  )

// Distributor names are business names, not stable machine IDs, and can
// contain commas. Accept repeated query params (`?distributorNames=A&…=B`)
// without CSV-splitting the values so names round-trip exactly.
const repeatedStringList = z.preprocess((value) => {
  if (value === undefined || value === null) return []
  const rawValues = Array.isArray(value) ? value : [value]
  const cleaned = rawValues
    .flatMap((item) => (typeof item === 'string' ? [item.trim()] : []))
    .filter((item) => item.length > 0)
  return [...new Set(cleaned)]
}, z.array(z.string().min(1)))

/**
 * Cumulative-filter request. Each selected-dimension list narrows the
 * options/counts returned for the OTHER dimensions (the dimension's
 * own selection is intentionally ignored when computing its own list
 * — otherwise the user could only ever see what they already picked).
 */
export const CatalogAnalyticsFiltersRequestSchema = z.object({
  sites: csvList,
  categoryIds: csvList,
  subcategoryIds: csvList,
  brandIds: csvList,
  distributorNames: repeatedStringList,
  sizes: csvList,
  /** CSV of pack-count ids (integer strings, e.g. "1,5,10"). */
  packCounts: csvList,
})
export type CatalogAnalyticsFiltersRequest = z.infer<
  typeof CatalogAnalyticsFiltersRequestSchema
>

// =============================== Points endpoint ===========================

export const CatalogAnalyticsPointsRequestSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  sites: csvList,
  categoryIds: csvList,
  subcategoryIds: csvList,
  brandIds: csvList,
  distributorNames: repeatedStringList,
  sizes: csvList,
  /** CSV of pack-count ids (integer strings, e.g. "1,5,10"). */
  packCounts: csvList,
})
export type CatalogAnalyticsPointsRequest = z.infer<
  typeof CatalogAnalyticsPointsRequestSchema
>

/**
 * One scatter dot. Each numeric metric is optional because not every
 * variant has data for every dimension (e.g. lab THC is null on
 * accessories; sales velocity is 0 / null for never-sold packages).
 * The renderer hides points missing the operator-selected X or Y.
 *
 * Identity fields (`inventoryItemId`, `productName`, `sku`, `sizeLabel`,
 * etc.) drive the hover tooltip and the cohort overlay grouping.
 */
export const CatalogAnalyticsPointSchema = z.object({
  inventoryItemId: z.string().min(1),
  productId: z.string().nullable(),
  productName: z.string(),
  productShortName: z.string().nullable(),
  sku: z.string().nullable(),
  categoryId: z.string().nullable(),
  categoryName: z.string().nullable(),
  subcategoryId: z.string().nullable(),
  subcategoryName: z.string().nullable(),
  brandId: z.string().nullable(),
  brandName: z.string().nullable(),
  distributorName: z.string().nullable(),
  sizeLabel: z.string().nullable(),

  // --- snapshot-driven (current state) ---
  currentQty: z.number().nullable(),
  availableQty: z.number().nullable(),
  isOnStock: z.boolean().nullable(),
  wholesaleCostDollars: z.number().nullable(),
  labThcPct: z.number().nullable(),
  labCbdPct: z.number().nullable(),

  // --- catalog-driven (list / shelf state) ---
  /** Pre-tax list (shelf) price per unit, from catalog_groups. */
  listPriceDollars: z.number().nullable(),
  /**
   * Units per package — `live_state_json.products[i].packOfSize` on
   * the matching catalog_group product. 1 for single-unit packages
   * (one flower jar, one cart). >1 for multi-pack pre-rolls,
   * gummies-per-tin, etc. Doubles as a filterable dimension.
   */
  packCount: z.number().int().nullable(),
  /**
   * Numeric unit size in grams parsed from `sizeLabel` (e.g. "1g" →
   * 1, "3.5g" → 3.5). Null for sizes that don't express grams
   * (e.g. edibles, tinctures — see `unitSizeMg` for those, or "1ct"
   * accessories).
   */
  unitSizeGrams: z.number().nullable(),
  /**
   * Numeric unit size in milligrams parsed from `sizeLabel` (e.g.
   * "10mg", "100mg"). Used for edibles / tinctures.
   */
  unitSizeMg: z.number().nullable(),
  /**
   * Median pre-tax market price per unit, derived from
   * catalog_market_matches × fuzzy_skus (live verdicts of
   * exact/brand_family). Null if no live market matches exist for
   * this product or no listing carried a usable price. NOT the
   * post-tax (OTD) price — compare with `listPriceDollars`, not
   * with `otdUnitPriceDollars`.
   */
  marketPricePretaxDollars: z.number().nullable(),
  /** Count of live market listings backing `marketPricePretaxDollars`. */
  marketSampleCount: z.number().int().nonnegative().nullable(),

  // --- window-driven (sales over [from, to]) ---
  unitsSold: z.number().nullable(),
  revenueDollars: z.number().nullable(),
  cogsDollars: z.number().nullable(),
  marginDollars: z.number().nullable(),
  marginDollarsPerUnit: z.number().nullable(),
  gmPercent: z.number().nullable(),
  /** Average sold price per unit ($) — revenue / units. */
  avgUnitPriceDollars: z.number().nullable(),
  /** Estimated OTD per unit ($) — avg unit price × dealer's effective tax ratio. */
  otdUnitPriceDollars: z.number().nullable(),
  /** Units sold per day over the window (units_sold / window_days). */
  salesVelocityUnitsPerDay: z.number().nullable(),
  /** Margin dollars per day over the window. */
  marginVelocityDollarsPerDay: z.number().nullable(),
  /** Distinct invoices that contained this variant in the window. */
  invoiceCount: z.number().int().nonnegative().nullable(),
  /** Distinct ET-local dates with at least one sale in the window. */
  daysWithSales: z.number().int().nonnegative().nullable(),
  /** Dealer-window tax ratio used to derive otdUnitPriceDollars. */
  taxRatio: z.number().nullable(),
})
export type CatalogAnalyticsPoint = z.infer<typeof CatalogAnalyticsPointSchema>

export const CatalogAnalyticsPointsResponseSchema = z.object({
  resolved: z.object({
    from: z.string(),
    to: z.string(),
    sites: z.array(z.string()),
    categoryIds: z.array(z.string()),
    subcategoryIds: z.array(z.string()),
    brandIds: z.array(z.string()),
    distributorNames: z.array(z.string()),
    sizes: z.array(z.string()),
    packCounts: z.array(z.string()),
    windowDays: z.number(),
  }),
  points: z.array(CatalogAnalyticsPointSchema),
})
export type CatalogAnalyticsPointsResponse = z.infer<
  typeof CatalogAnalyticsPointsResponseSchema
>
