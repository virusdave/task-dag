import { z } from 'zod'

// ---------------------------------------------------------------------------
// Inventory / Procurement analytics
//
// Backs the /metrics → "Inventory" (a.k.a. "Reordering") tab. ONE
// consolidated endpoint returns a per-SKU fact table (product-grain)
// plus per-distributor lead-time / cadence stats. The client derives
// all four procurement views from this single payload without further
// round-trips:
//
//   * Reorder Queue     — out-now-and-regretting + runout-soon, with
//                         recommended order quantities.
//   * Distributor Baskets — batched per-distributor order guidance
//                         (order now / short order / wait).
//   * Exit / Liquidate  — deadweight capital, aging, stop-carry.
//   * Mix Drift         — inventory $/unit mix vs sales/margin mix at
//                         category / subcategory / brand / distributor.
//
// The server pre-computes every per-SKU scalar (velocity, days-supply,
// recommended qty, lost-margin/day, deadweight + reorder priority
// scores, confidence) so the client is pure presentation + group-by.
// See inventoryProcurementQueries.ts for the SQL + scoring strategy.
//
// Design: oracle thread T-019e6edf (2026-06-04). Procurement-grade —
// the page must tell the buyer exactly what to order, from whom, how
// much, and when. All windows/aggregation are NY-local per repo canon.
// ---------------------------------------------------------------------------

const csvList = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').filter((s) => s.length > 0) : []))

export const InventoryProcurementRequestSchema = z.object({
  /** Trailing demand window in days (velocity basis). Default 28. */
  windowDays: z.coerce.number().int().min(7).max(180).optional(),
  /** Default lead time (days) when distributor history is unavailable. */
  defaultLeadDays: z.coerce.number().int().min(1).max(45).optional(),
  /** Site filter (siteKey list). Empty = all. */
  sites: csvList,
})
export type InventoryProcurementRequest = z.infer<typeof InventoryProcurementRequestSchema>

// =============================== Per-SKU row ===============================

export const InventoryActionSchema = z.enum([
  'order_now',
  'order_now_supplier_unknown',
  'check_hidden_stock',
  'reorder_soon',
  'liquidate_now',
  'burn_down_stop_carry',
  'reprice_before_expiry',
  'reduce_future_orders',
  'accept_stockout',
  'hold',
  'do_not_reorder',
  // There IS demand, but the case-rounded minimum order would overstock
  // the SKU well past its target coverage window — buying it would tie up
  // capital / risk expiry. Distinct from do_not_reorder (no demand).
  'skip_min_order_overshoots',
])
export type InventoryAction = z.infer<typeof InventoryActionSchema>

// One weighted term of a 0–100 score (reorder priority or deadweight),
// surfaced so the UI can JUSTIFY the recommendation instead of showing a
// black-box number. `contribution` is the signed points this term added
// to the final score; the score is clamp(round(Σ contribution), 0, 100)
// (a term may be negative, e.g. the deadweight penalty on reorder).
export const InventoryScoreFactorSchema = z.object({
  key: z.string(),
  label: z.string(),
  weight: z.number(),
  /** Normalised 0..1 magnitude of this term before weighting. */
  norm: z.number(),
  /** Signed points this term contributed to the 0–100 score. */
  contribution: z.number(),
})
export type InventoryScoreFactor = z.infer<typeof InventoryScoreFactorSchema>

export const InventorySkuRowSchema = z.object({
  dealerId: z.number(),
  siteKey: z.string(),
  siteLabel: z.string(),
  productId: z.number().nullable(),
  productName: z.string(),
  productSku: z.string().nullable(),
  categoryName: z.string().nullable(),
  subcategoryName: z.string().nullable(),
  brandName: z.string().nullable(),
  /** Current shelf/menu price (effective actualPrice, else list price).
   *  Base for the breakeven-discount column; available even for SKUs with
   *  no recent sales (unlike avgUnitPrice). */
  listPrice: z.number().nullable(),
  distributorName: z.string().nullable(),

  // Inventory facts (latest snapshot per package, summed to SKU grain).
  physicalUnits: z.number(),
  heldUnits: z.number(),
  sellableUnits: z.number(),
  onHandCost: z.number(),
  unitCostCurrent: z.number().nullable(),
  packageCount: z.number(),
  hiddenStock: z.boolean(),
  firstReceivedAt: z.string().nullable(),
  avgInventoryAgeDays: z.number().nullable(),
  nearestExpiration: z.string().nullable(),
  daysToNearestExpiration: z.number().nullable(),
  expiringUnits60: z.number(),
  expiringCost60: z.number(),
  snapshotAgeHours: z.number().nullable(),

  // Sales / velocity facts.
  units7: z.number(),
  units28: z.number(),
  units90: z.number(),
  revenueWindow: z.number(),
  marginWindow: z.number(),
  avgUnitPrice: z.number().nullable(),
  unitMargin: z.number().nullable(),
  gmPct: z.number().nullable(),
  lastSaleAt: z.string().nullable(),
  velocity: z.number(),
  forecastDailyUnits: z.number(),
  daysSupply: z.number().nullable(),
  projectedStockoutAt: z.string().nullable(),

  // Reorder facts.
  leadTimeDays: z.number(),
  cadenceDays: z.number(),
  reorderPointDays: z.number(),
  targetCoverDays: z.number(),
  recommendedQty: z.number(),
  recommendedCost: z.number(),
  orderByDate: z.string().nullable(),
  /** Days of supply the SKU would have AFTER the case-snapped order
   *  (sellable + snapped qty) / forecast daily units. Null when there's
   *  no forecast demand or nothing to order. Diagnostic for the
   *  min-order-overshoots decision. */
  coverageAfterSnappedOrderDays: z.number().nullable(),
  /** True when there is real demand but the case-rounded minimum order
   *  would push coverage past the acceptable ceiling, so we suppress the
   *  recommendation (recommendedQty forced to 0). The qty we *would* have
   *  ordered is preserved in `suppressedRecommendedQty` for the operator. */
  minOrderOvershootsTarget: z.boolean(),
  /** When `minOrderOvershootsTarget`, the case-snapped qty we declined to
   *  recommend (e.g. 10). Null otherwise. Never enters baskets/totals. */
  suppressedRecommendedQty: z.number().nullable(),
  lostMarginPerDay: z.number(),
  expectedMarginLossBeforeReplenishment: z.number(),

  // Scores.
  reorderPriorityScore: z.number(),
  deadweightScore: z.number(),
  confidenceScore: z.number(),
  /** Weighted terms behind reorderPriorityScore (justification UI). */
  reorderFactors: z.array(InventoryScoreFactorSchema),
  /** Weighted terms behind deadweightScore (justification UI). */
  deadweightFactors: z.array(InventoryScoreFactorSchema),

  // Flags / classification.
  recentSeller: z.boolean(),
  outRegretted: z.boolean(),
  doNotReorder: z.boolean(),
  action: InventoryActionSchema,
})
export type InventorySkuRow = z.infer<typeof InventorySkuRowSchema>

// =========================== Per-distributor row ===========================

export const InventoryDistributorStatSchema = z.object({
  dealerId: z.number(),
  siteKey: z.string(),
  distributorName: z.string(),
  leadTimeDays: z.number(),
  cadenceDays: z.number(),
  lastDeliveryDate: z.string().nullable(),
  poCount: z.number(),
})
export type InventoryDistributorStat = z.infer<typeof InventoryDistributorStatSchema>

// ================================ Summary =================================

export const InventoryProcurementSummarySchema = z.object({
  skuCount: z.number(),
  totalOnHandCost: z.number(),
  outRegrettedCount: z.number(),
  outRegrettedLostMarginPerDay: z.number(),
  soonOutCount: z.number(),
  recommendedOrderCostTotal: z.number(),
  deadweightCapital: z.number(),
  zeroVelocityCapital: z.number(),
  expiringSoonCost: z.number(),
  lowConfidenceCount: z.number(),
})
export type InventoryProcurementSummary = z.infer<typeof InventoryProcurementSummarySchema>

// =========================== Category overhang ===========================
//
// SKU-level exit advice is myopic: it can't see that a whole *category*
// is carrying far more capital than its recent demand justifies (the
// "Flower is overstacked" problem). This rolls each category's on-hand
// capital share up against its share of realized window margin so the
// operator can target category-wide drawdowns, not just one-off SKUs.

export const InventoryCategoryOverhangSchema = z.object({
  categoryName: z.string(),
  skuCount: z.number(),
  /** On-hand inventory cost ($) across the category. */
  onHandCost: z.number(),
  /** Category share of total on-hand cost (0..1). */
  onHandCostShare: z.number(),
  /** Realized gross margin ($) over the demand window. */
  windowMargin: z.number(),
  /** Category share of total realized window margin (0..1). */
  marginShare: z.number(),
  /** Capital share ÷ margin share. >1 = carrying more capital than its
   *  demand earns; large values are the overstacked categories. */
  overhangRatio: z.number(),
  /** Estimated capital ($) held above a demand-proportional level —
   *  onHandCost − (marginShare · totalOnHandCost). Floored at 0. */
  excessCapital: z.number(),
  /** Capital ($) in this category flagged deadweight (score ≥ 70). */
  deadweightCapital: z.number(),
})
export type InventoryCategoryOverhang = z.infer<typeof InventoryCategoryOverhangSchema>

// ================================ Response ================================

export const InventoryProcurementResponseSchema = z.object({
  asOf: z.string(),
  generatedAt: z.string(),
  params: z.object({
    windowDays: z.number(),
    defaultLeadDays: z.number(),
    sites: z.array(z.string()),
  }),
  summary: InventoryProcurementSummarySchema,
  skus: z.array(InventorySkuRowSchema),
  distributors: z.array(InventoryDistributorStatSchema),
  /** Category-level capital-vs-demand overhang, worst first. */
  categoryOverhang: z.array(InventoryCategoryOverhangSchema),
  methodology: z.array(z.string()),
})
export type InventoryProcurementResponse = z.infer<typeof InventoryProcurementResponseSchema>

// =========================== SKU sales history ============================
//
// On-demand per-SKU daily sales series, fetched only when a buyer expands
// a row's insight panel (so the main procurement payload stays lean). The
// sparkline answers the buyer's trust question: "was this actually selling
// recently, or is the model inventing demand?"

export const InventorySkuHistoryRequestSchema = z.object({
  dealerId: z.coerce.number().int().positive(),
  productId: z.coerce.number().int().positive(),
  /** Trailing window in days. Default 90. */
  days: z.coerce.number().int().min(7).max(180).optional(),
})
export type InventorySkuHistoryRequest = z.infer<typeof InventorySkuHistoryRequestSchema>

export const InventorySkuHistoryPointSchema = z.object({
  /** NY-local business day (YYYY-MM-DD). */
  date: z.string(),
  units: z.number(),
  revenue: z.number(),
})
export type InventorySkuHistoryPoint = z.infer<typeof InventorySkuHistoryPointSchema>

export const InventorySkuHistoryResponseSchema = z.object({
  dealerId: z.number(),
  productId: z.number(),
  days: z.number(),
  totalUnits: z.number(),
  totalRevenue: z.number(),
  /** Zero-filled daily series, oldest → newest, so the chart is honest. */
  series: z.array(InventorySkuHistoryPointSchema),
})
export type InventorySkuHistoryResponse = z.infer<typeof InventorySkuHistoryResponseSchema>
