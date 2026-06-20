import { z } from 'zod'

// ---------------------------------------------------------------------------
// Catalog → Purchase inventory pricing-safety lifecycle (L1).
//
// A durable per-PO lifecycle that sequences the money-safety gates a
// brand-new received SKU must pass before it can sell. Backs a panel on
// the Catalog → Purchase detail page and reuses the existing pricing
// review UI for the actual price approval.
//
// Endpoints (all under the purchase namespace):
//   GET  /api/catalog/purchases/:poId/lifecycle?dealerId=…
//   POST /api/catalog/purchases/:poId/lifecycle/start
//   POST /api/catalog/purchases/:poId/lifecycle/verify-quarantine
//   POST /api/catalog/purchases/:poId/lifecycle/market-refresh
//   POST /api/catalog/purchases/:poId/lifecycle/reprice
//
// NO release/reverse-move route — that is L2.
//
// See the migration 095 header and the top-level design referenced there
// for the authoritative state machine and gate semantics.
// ---------------------------------------------------------------------------

export const PurchaseLifecycleStateSchema = z.enum([
  'not_started',
  'awaiting_receive_to_quarantine',
  'quarantined',
  'market_refresh_pending',
  'market_ready',
  'pricing_pending',
  'awaiting_price_approval',
  'price_apply_pending',
  'priced_verified',
  'blocked',
])
export type PurchaseLifecycleState = z.infer<typeof PurchaseLifecycleStateSchema>

export const PurchaseLifecyclePathSchema = z.enum(['quarantine', 'reprice_in_place'])
export type PurchaseLifecyclePath = z.infer<typeof PurchaseLifecyclePathSchema>

export const PurchaseLifecycleItemSchema = z.object({
  id: z.number().int(),
  lineId: z.string(),
  inventoryItemId: z.string(),
  sweedProductId: z.number().int(),
  metrcTag: z.string().nullable(),
  expectedQty: z.number().nullable(),

  quarantineVerifiedAt: z.string().nullable(),
  quarantineStockLocation: z.string().nullable(),
  quarantineCurrentQty: z.number().nullable(),

  marketObservationCapturedAt: z.string().nullable(),
  marketReadyAt: z.string().nullable(),

  priceAppliedVerifiedAt: z.string().nullable(),
  approvedPriceDollars: z.number().nullable(),
  livePriceDollars: z.number().nullable(),

  notes: z.string().nullable(),
})
export type PurchaseLifecycleItem = z.infer<typeof PurchaseLifecycleItemSchema>

export const PurchaseLifecycleRunSchema = z.object({
  id: z.number().int(),
  dealerId: z.number().int(),
  poId: z.string(),
  siteKey: z.string(),
  path: PurchaseLifecyclePathSchema,
  state: PurchaseLifecycleStateSchema,
  blockedReason: z.string().nullable(),
  marketRequestedAt: z.string().nullable(),
  pricingBatchId: z.number().int().nullable(),
  expectedProductIds: z.array(z.number().int()),
  version: z.number().int(),
  createdByUserId: z.number().int().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  items: z.array(PurchaseLifecycleItemSchema),
})
export type PurchaseLifecycleRun = z.infer<typeof PurchaseLifecycleRunSchema>

// A per-gate verifier summary the panel renders so the operator can see
// exactly why a gate has not passed yet (which products / lots are
// outstanding) without trawling the item table.
export const PurchaseLifecycleGateSummarySchema = z.object({
  // Quarantine gate: lots still sellable (in a FOR SALE room) that the
  // lifecycle expected to be quarantined.
  quarantineSellableLotCount: z.number().int(),
  // Market gate: product ids without a succeeded observation captured
  // after the run's market_requested_at cutoff.
  marketPendingProductIds: z.array(z.number().int()),
  // Price gate: product ids whose live Sweed price does not yet equal the
  // approved desired price (within 1¢), or that have no approved line.
  priceUnverifiedProductIds: z.array(z.number().int()),
  priceUnapprovedProductIds: z.array(z.number().int()),
})
export type PurchaseLifecycleGateSummary = z.infer<typeof PurchaseLifecycleGateSummarySchema>

export const PurchaseLifecycleStatusResponseSchema = z.object({
  // True when migration 095 has not been applied on this DB yet. The
  // panel shows a "pending migration" note instead of erroring, and all
  // action routes refuse with 409 until it is applied.
  migrationPending: z.boolean(),
  // The distinct product ids derived from the PO's positive-qty,
  // product-mapped lines. Surfaced even before a run exists so the panel
  // can explain what would be priced.
  expectedProductIds: z.array(z.number().int()),
  run: PurchaseLifecycleRunSchema.nullable(),
  gateSummary: PurchaseLifecycleGateSummarySchema.nullable(),
})
export type PurchaseLifecycleStatusResponse = z.infer<
  typeof PurchaseLifecycleStatusResponseSchema
>

// ----------------------------- Action requests -----------------------------

export const PurchaseLifecycleStartRequestSchema = z.object({
  dealerId: z.number().int(),
  path: PurchaseLifecyclePathSchema,
  notes: z.string().max(2000).optional(),
})
export type PurchaseLifecycleStartRequest = z.infer<
  typeof PurchaseLifecycleStartRequestSchema
>

// Mutating actions carry the version the operator's view was built from
// so a stale tab cannot drive a transition off the wrong state.
export const PurchaseLifecycleActionRequestSchema = z.object({
  dealerId: z.number().int(),
  expectedVersion: z.number().int(),
})
export type PurchaseLifecycleActionRequest = z.infer<
  typeof PurchaseLifecycleActionRequestSchema
>
