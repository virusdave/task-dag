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

// Multi-value list parser used by every list-page filter. Accepts
// EITHER a single comma-separated string (`?brandNames=A,B`) OR the
// repeated query-param form (`?brandNames=A&brandNames=B`) that
// fastify's default querystring parser surfaces as an array. Without
// the array branch, multiselect filters posted by the page UI 400
// out at the loader before they ever reach the SQL — that's exactly
// the bug that was hiding the "63 Midtown purchases" the operator
// expected to see when more than one financial-status / brand /
// distributor / site facet was checked at once.
const csvList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (value === undefined) return []
    const raw = Array.isArray(value) ? value : [value]
    const out: string[] = []
    for (const v of raw) {
      if (typeof v !== 'string') continue
      for (const piece of v.split(',')) {
        const trimmed = piece.trim()
        if (trimmed.length > 0) out.push(trimmed)
      }
    }
    return out
  })

// HTML forms submit unset numeric / date inputs as `""` rather than
// dropping the param. Without the preprocess, `z.coerce.number()`
// turned `totalMax=""` into 0, which then drove a SQL filter of
// `having max(po_total_dollars) <= 0` — making the list silently
// show only the handful of POs with a $0 total. Same shape would hit
// totalMin and any date range. Treat empty strings as "not set" so
// the loader stays in sync with what the user actually configured.
const optionalNumber = z.preprocess(
  (v) => (typeof v === 'string' && v.trim().length === 0 ? undefined : v),
  z.coerce.number().optional(),
)
const optionalDate = z.preprocess(
  (v) => (typeof v === 'string' && v.trim().length === 0 ? undefined : v),
  z.string().optional(),
)
const optionalText = z.preprocess(
  (v) => (typeof v === 'string' && v.trim().length === 0 ? undefined : v),
  z.string().optional(),
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
  deliveryFrom: optionalDate,
  deliveryTo: optionalDate,
  paymentDueFrom: optionalDate,
  paymentDueTo: optionalDate,
  totalMin: optionalNumber,
  totalMax: optionalNumber,
  brandNames: csvList,
  productSearch: optionalText,
  orderStatusNames: csvList,
  financialStatusNames: csvList,
  // POs under $2 are almost always distributor sample drops, not real
  // buys. They drown the list at default sort. We hide them by default
  // and let the operator opt them back in with `?includeSamples=1`.
  // The check is layered as a HAVING on the aggregated po total so it
  // composes cleanly with totalMin / totalMax if either is also set.
  includeSamples: z.preprocess(
    (v) => (typeof v === 'string' && v.trim().length === 0 ? undefined : v),
    z
      .union([z.boolean(), z.string()])
      .optional()
      .transform((value) => {
        if (value === undefined) return false
        if (typeof value === 'boolean') return value
        const norm = value.trim().toLowerCase()
        return norm === '1' || norm === 'true' || norm === 'on' || norm === 'yes'
      }),
  ),
  sort: CatalogPurchaseListSortSchema.default('deliveryDate'),
  // Default to oldest-first: when the operator opens the list to plan
  // vendor payments / extensions, the most actionable POs are the
  // oldest unpaid ones (closest to / past payment-due), not the
  // freshest deliveries. Operator can flip to newest-first by clicking
  // the column header.
  dir: z.enum(['asc', 'desc']).default('asc'),
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
 * One row on the list page.
 *
 * Field-name → operator-meaning crosswalk (KEEP STRAIGHT — these get
 * mixed up in the UI on every other rev):
 *
 *   * `realisedCostIfPaidForSoldOnlyDollars`
 *     = PO unit cost × units sold so far.
 *     = the **negotiation / vendor-payment basis** — the answer to
 *       "if I paid only for what's sold, what would I owe?".
 *
 *   * `costOfSoldItemsDollars`
 *     = sum over realised sales of qty × wholesale cost-as-of pay_time
 *       (falling back to PO unit cost when the snapshot is missing).
 *     = **realised COGS for margin math** — NOT the vendor payment
 *       basis. Demoted in the UI; surfaced only in margin context.
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

// ============================ Record-payment endpoint =======================

/**
 * Sweed `orderPaymentType` ids we are willing to write. Verified from
 * live Sweed traffic only:
 *   1 = Cash, 3 = Check.
 * The "unpayable balance" top-up is always written as a Check (3).
 * Do NOT add unverified ids here — a wrong id silently mislabels a real
 * financial record in Sweed.
 */
export const CATALOG_PURCHASE_PAYMENT_TYPES = [
  { id: 1, label: 'Cash' },
  { id: 3, label: 'Check' },
] as const
export const CatalogPurchasePaymentTypeIdSchema = z.union([z.literal(1), z.literal(3)])
export type CatalogPurchasePaymentTypeId = z.infer<typeof CatalogPurchasePaymentTypeIdSchema>

/**
 * Record one operator payment against a PO in Sweed.
 *
 * `markFullyPaid` semantics (per operator workflow): record the actual
 * `payAmount` paid with `orderPaymentTypeId`, then — if a balance still
 * remains — write the remainder as a Check (type 3) with the note
 * "unpayable balance", zeroing the PO out to "Fully paid". When
 * `markFullyPaid` is false the payment is recorded as-is (partial).
 *
 * `expectedOwedDollars` is the owed figure the operator saw when they
 * opened the form; the server rejects the write if Sweed's live owed has
 * drifted (stale tab / double-submit) so we never double-pay.
 */
export const CatalogPurchasePaymentRequestSchema = z.object({
  dealerId: z.coerce.number().int().positive(),
  payAmount: z.coerce.number().finite().nonnegative(),
  orderPaymentTypeId: CatalogPurchasePaymentTypeIdSchema.default(1),
  payTime: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'payTime must be YYYY-MM-DD')
    .optional(),
  markFullyPaid: z.boolean().default(false),
  expectedOwedDollars: z.coerce.number().finite().optional(),
})
export type CatalogPurchasePaymentRequest = z.infer<typeof CatalogPurchasePaymentRequestSchema>

/**
 * Response after a successful payment write: the refreshed PO detail
 * (same shape as the detail endpoint) plus a short human summary of what
 * was recorded, so the UI can confirm the top-up explicitly.
 */
export const CatalogPurchasePaymentResponseSchema = z.object({
  detail: CatalogPurchaseDetailResponseSchema,
  recorded: z.object({
    paymentDollars: z.number(),
    orderPaymentTypeId: CatalogPurchasePaymentTypeIdSchema,
    unpayableBalanceCheckDollars: z.number().nullable(),
    financialStatusName: z.string().nullable(),
    owedAfterDollars: z.number().nullable(),
  }),
})
export type CatalogPurchasePaymentResponse = z.infer<typeof CatalogPurchasePaymentResponseSchema>

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
