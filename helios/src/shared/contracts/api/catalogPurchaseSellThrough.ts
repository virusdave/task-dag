import { z } from 'zod'

// ---------------------------------------------------------------------------
// Catalog → Purchase Sell-Through page family.
//
// Three endpoints:
//
//   GET /api/catalog/purchases
//     - Paginated, filterable list of purchases with per-row sell-
//       through summary columns (cost-paid, cost-of-sold-so-far,
//       remaining cost, current outstanding list value, units in /
//       sold / remaining).
//
//   GET /api/catalog/purchases/:poId?dealerId=...
//     - One PO header + every line item with full sell-through
//       computation per line.
//
//   GET /api/catalog/purchases/:poId/items/:lineId?dealerId=...
//     - One line item + a sales-KPI block + the filter context the
//       embedded /metrics/catalog scatter grid uses to pre-filter
//       and highlight this SKU.
// ---------------------------------------------------------------------------

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

// ============================ List endpoint ================================

/**
 * Sort columns we can `order by` on the list page. Whitelisted to
 * avoid SQL-injection-by-query-string. Sort direction is independent
 * (`asc` | `desc`).
 */
export const CatalogPurchaseListSortSchema = z.enum([
  'deliveryDate',
  'paymentDueDate',
  'poTotalDollars',
  'distributorName',
  'unitsSold',
  'unitsRemaining',
  'unitsAdjusted',
  'sellThroughPercent',
  'realisedCostIfPaidForSoldOnlyDollars',
  'costOfSoldItemsDollars',
  'costOfRemainingItemsDollars',
  'costOfAdjustedItemsDollars',
  'currentListPriceOutstandingDollars',
])
export type CatalogPurchaseListSort = z.infer<typeof CatalogPurchaseListSortSchema>

export const CatalogPurchaseListRequestSchema = z.object({
  sites: csvList,
  distributorNames: csvList,
  deliveryFrom: z.string().optional(),
  deliveryTo: z.string().optional(),
  paymentDueFrom: z.string().optional(),
  paymentDueTo: z.string().optional(),
  totalMin: z.coerce.number().optional(),
  totalMax: z.coerce.number().optional(),
  brandNames: csvList,
  productSearch: z.string().optional(),
  orderStatusNames: csvList,
  financialStatusNames: csvList,
  sort: CatalogPurchaseListSortSchema.default('deliveryDate'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})
export type CatalogPurchaseListRequest = z.infer<typeof CatalogPurchaseListRequestSchema>

/**
 * A facet entry surfaced in the list-page filter chips. Counts are
 * scoped to whatever filter state is being computed for; the server
 * is free to ignore them when expensive.
 */
export const CatalogPurchaseFilterOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  count: z.number().int().nonnegative(),
})
export type CatalogPurchaseFilterOption = z.infer<typeof CatalogPurchaseFilterOptionSchema>

export const CatalogPurchaseListFacetsSchema = z.object({
  sites: z.array(CatalogPurchaseFilterOptionSchema),
  distributors: z.array(CatalogPurchaseFilterOptionSchema),
  brands: z.array(CatalogPurchaseFilterOptionSchema),
  orderStatuses: z.array(CatalogPurchaseFilterOptionSchema),
  financialStatuses: z.array(CatalogPurchaseFilterOptionSchema),
})
export type CatalogPurchaseListFacets = z.infer<typeof CatalogPurchaseListFacetsSchema>

/**
 * One row on the list page. `costOfSoldItemsDollars` is the realised
 * cost we have actually paid out for goods that have already sold
 * through (PO unit cost × units sold to date). It is the answer to
 * the operator's headline question "if I paid only for what's sold,
 * what would I be paying?".
 */
export const CatalogPurchaseListRowSchema = z.object({
  dealerId: z.number().int(),
  siteKey: z.string(),
  poId: z.string(),
  poName: z.string().nullable(),
  externalOrderId: z.string().nullable(),
  distributorName: z.string().nullable(),
  deliveryDate: z.string().nullable(),
  paymentDueDate: z.string().nullable(),
  orderStatusName: z.string().nullable(),
  financialStatusName: z.string().nullable(),
  isCashOnDelivery: z.boolean().nullable(),

  poTotalDollars: z.number().nullable(),

  unitsOrdered: z.number(),
  unitsSold: z.number(),
  unitsRemaining: z.number(),
  // ordered - sold - remaining (clamped >= 0). Units of the PO that
  // are neither still on hand nor in a sold invoice — i.e. shrinkage /
  // breakage / destruction / return-to-distributor / sample-out /
  // unaccounted adjustments. Only meaningful for matched lines.
  unitsAdjusted: z.number(),
  sellThroughPercent: z.number().nullable(),

  // The headline cash summaries the list page exposes per row. They
  // reconcile (modulo unmatched lines / cost edits):
  //   cost_of_sold + cost_of_remaining + cost_of_adjusted ≈ ordered × unit_cost
  costOfSoldItemsDollars: z.number(),
  realisedCostIfPaidForSoldOnlyDollars: z.number(),
  costOfRemainingItemsDollars: z.number(),
  // Realised cost (at PO unit cost) of the adjusted / non-sold units
  // — i.e. money paid out for product that did not sell and is no
  // longer on hand.
  costOfAdjustedItemsDollars: z.number(),
  currentListPriceOutstandingDollars: z.number(),

  // Sold revenue (gross of discount). Lets the operator eyeball
  // realised margin per PO (soldRevenue - costOfSoldItems).
  soldRevenueDollars: z.number(),

  // Number of distinct line items + a short preview of brand /
  // product names so the row is readable without drilling in.
  lineCount: z.number().int(),
  brandNames: z.array(z.string()),
  productNamesPreview: z.array(z.string()),
})
export type CatalogPurchaseListRow = z.infer<typeof CatalogPurchaseListRowSchema>

export const CatalogPurchaseListHeadlineSchema = z.object({
  poTotalDollars: z.number(),
  costOfSoldItemsDollars: z.number(),
  realisedCostIfPaidForSoldOnlyDollars: z.number(),
  costOfRemainingItemsDollars: z.number(),
  costOfAdjustedItemsDollars: z.number(),
  currentListPriceOutstandingDollars: z.number(),
  soldRevenueDollars: z.number(),
  unitsOrdered: z.number(),
  unitsSold: z.number(),
  unitsRemaining: z.number(),
  unitsAdjusted: z.number(),
  purchaseCount: z.number().int(),
  lineCount: z.number().int(),
})
export type CatalogPurchaseListHeadline = z.infer<typeof CatalogPurchaseListHeadlineSchema>

export const CatalogPurchaseListResponseSchema = z.object({
  resolved: z.object({
    page: z.number().int(),
    pageSize: z.number().int(),
    sort: CatalogPurchaseListSortSchema,
    dir: z.enum(['asc', 'desc']),
    totalRows: z.number().int(),
  }),
  headline: CatalogPurchaseListHeadlineSchema,
  facets: CatalogPurchaseListFacetsSchema,
  rows: z.array(CatalogPurchaseListRowSchema),
})
export type CatalogPurchaseListResponse = z.infer<typeof CatalogPurchaseListResponseSchema>

// ============================ Detail (PO) endpoint ==========================

export const CatalogPurchaseHeaderSchema = z.object({
  dealerId: z.number().int(),
  siteKey: z.string(),
  poId: z.string(),
  poName: z.string().nullable(),
  externalOrderId: z.string().nullable(),
  deliveryDate: z.string().nullable(),
  paymentDueDate: z.string().nullable(),
  orderStatusName: z.string().nullable(),
  financialStatusName: z.string().nullable(),
  isCashOnDelivery: z.boolean().nullable(),
  distributorId: z.number().int().nullable(),
  distributorName: z.string().nullable(),

  poTotalDollars: z.number().nullable(),
  poSubtotalDollars: z.number().nullable(),
  poDiscountAmountDollars: z.number().nullable(),
  poTaxDollars: z.number().nullable(),
  poOwedDollars: z.number().nullable(),

  lineCount: z.number().int(),
  fetchedAt: z.string(),
})
export type CatalogPurchaseHeader = z.infer<typeof CatalogPurchaseHeaderSchema>

export const CatalogPurchaseLineSellThroughSchema = z.object({
  dealerId: z.number().int(),
  poId: z.string(),
  lineId: z.string(),
  lineIndex: z.number().int(),

  productName: z.string().nullable(),
  distributorProductName: z.string().nullable(),
  sweedProductId: z.number().int().nullable(),
  brandName: z.string().nullable(),
  categoryName: z.string().nullable(),
  subcategoryName: z.string().nullable(),
  sizeLabel: z.string().nullable(),
  packCount: z.number().int().nullable(),
  metrcTag: z.string().nullable(),

  orderedUnits: z.number(),
  unitsSoldToDate: z.number(),
  remainingUnits: z.number(),
  // ordered - sold - remaining (clamped >= 0). Units of this PO line
  // that are neither still on hand nor in a sold invoice — i.e.
  // shrinkage / breakage / destruction / return-to-distributor /
  // samples / unaccounted adjustments. Only meaningful when the line
  // is package-matched (we can see current on-hand); for unmatched
  // lines this is reported as 0 because we have no qty signal beyond
  // ordered.
  unitsAdjusted: z.number(),
  sellThroughPercent: z.number().nullable(),
  daysSinceReceived: z.number().nullable(),

  unitCostDollars: z.number().nullable(),
  extendedCostDollars: z.number().nullable(),
  soldRevenueDollars: z.number(),
  // PO unit-cost × units sold. The "what would I be paying right
  // now if I only paid for what sold" answer at line grain.
  realisedCostIfPaidForSoldOnlyDollars: z.number(),
  // Sum over actual sales of qty × package wholesale-cost-as-of
  // pay_time (falling back to PO unit cost when the package cost
  // snapshot is missing). Closer to true COGS than the PO unit
  // cost times units sold because mid-PO restocks / corrections
  // are honoured by the as-of join.
  costOfSoldItemsDollars: z.number(),
  costOfRemainingItemsDollars: z.number(),
  // PO unit_cost × unitsAdjusted. The dollar value of stock that was
  // paid for and is gone from the package without showing up as a
  // retail sale.
  costOfAdjustedItemsDollars: z.number(),
  currentListPriceOutstandingDollars: z.number(),

  currentListPriceDollars: z.number().nullable(),
  grossMarginPercent: z.number().nullable(),

  matchedInventoryItemIds: z.array(z.string()),
  packageMatchMethod: z.string(),
  packageMatchConfidence: z.number().nullable(),
})
export type CatalogPurchaseLineSellThrough = z.infer<typeof CatalogPurchaseLineSellThroughSchema>

export const CatalogPurchaseSellThroughSummarySchema = z.object({
  poTotalDollars: z.number().nullable(),
  costOfSoldItemsDollars: z.number(),
  realisedCostIfPaidForSoldOnlyDollars: z.number(),
  costOfRemainingItemsDollars: z.number(),
  costOfAdjustedItemsDollars: z.number(),
  currentListPriceOutstandingDollars: z.number(),
  soldRevenueDollars: z.number(),
  unitsOrdered: z.number(),
  unitsSold: z.number(),
  unitsRemaining: z.number(),
  unitsAdjusted: z.number(),
  matchedLineCount: z.number().int(),
  totalLineCount: z.number().int(),
})
export type CatalogPurchaseSellThroughSummary = z.infer<
  typeof CatalogPurchaseSellThroughSummarySchema
>

export const CatalogPurchaseDetailResponseSchema = z.object({
  purchase: CatalogPurchaseHeaderSchema,
  summary: CatalogPurchaseSellThroughSummarySchema,
  lines: z.array(CatalogPurchaseLineSellThroughSchema),
})
export type CatalogPurchaseDetailResponse = z.infer<typeof CatalogPurchaseDetailResponseSchema>

// ============================ Line-item detail endpoint =====================

export const CatalogPurchaseLineKpisSchema = z.object({
  unitsSold7d: z.number(),
  unitsSold30d: z.number(),
  unitsSold90d: z.number(),
  velocityUnitsPerDay7d: z.number().nullable(),
  velocityUnitsPerDay30d: z.number().nullable(),
  velocityUnitsPerDay90d: z.number().nullable(),
  revenue90dDollars: z.number(),
  avgUnitPriceDollars90d: z.number().nullable(),
  grossMarginPercent90d: z.number().nullable(),
  currentListPriceDollars: z.number().nullable(),
  currentQtyOnHand: z.number().nullable(),
})
export type CatalogPurchaseLineKpis = z.infer<typeof CatalogPurchaseLineKpisSchema>

/**
 * Context the per-item page hands to the embedded
 * `CatalogAnalyticsTab` so it pre-filters and highlights this SKU.
 * The Tab accepts an `embedded` prop and reads this object.
 */
export const CatalogPurchaseLineAnalyticsEmbedSchema = z.object({
  sites: z.array(z.string()),
  categoryNames: z.array(z.string()),
  subcategoryNames: z.array(z.string()),
  brandNames: z.array(z.string()),
  sizes: z.array(z.string()),
  highlightSweedProductId: z.number().int().nullable(),
  highlightInventoryItemIds: z.array(z.string()),
  highlightQuery: z.string(),
  defaultWindowDays: z.number().int(),
})
export type CatalogPurchaseLineAnalyticsEmbed = z.infer<
  typeof CatalogPurchaseLineAnalyticsEmbedSchema
>

export const CatalogPurchaseLineDetailResponseSchema = z.object({
  purchase: CatalogPurchaseHeaderSchema,
  line: CatalogPurchaseLineSellThroughSchema,
  kpis: CatalogPurchaseLineKpisSchema,
  embed: CatalogPurchaseLineAnalyticsEmbedSchema,
})
export type CatalogPurchaseLineDetailResponse = z.infer<
  typeof CatalogPurchaseLineDetailResponseSchema
>

// Worker payload lives in shared/contracts/domain/jobs.ts to match
// every other periodic ingest worker (orders / shifts / packages).
