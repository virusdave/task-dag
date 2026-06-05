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
])
export type InventoryAction = z.infer<typeof InventoryActionSchema>

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
  lostMarginPerDay: z.number(),
  expectedMarginLossBeforeReplenishment: z.number(),

  // Scores.
  reorderPriorityScore: z.number(),
  deadweightScore: z.number(),
  confidenceScore: z.number(),

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
  methodology: z.array(z.string()),
})
export type InventoryProcurementResponse = z.infer<typeof InventoryProcurementResponseSchema>
