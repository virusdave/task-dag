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
//   GET  /api/catalog/purchases/:poId/lifecycle/release-targets?dealerId=…   (L2)
//   POST /api/catalog/purchases/:poId/lifecycle/repair-quarantine            (L2)
//   POST /api/catalog/purchases/:poId/lifecycle/release                      (L2)
//   POST /api/catalog/purchases/:poId/lifecycle/continue-release             (L2)
//   POST /api/catalog/purchases/:poId/lifecycle/rollback-release             (L2)
//
// L2 adds the gated reverse/release move (quarantine → chosen FOR SALE
// room) with a live price + live quarantine preflight immediately before
// each lot transfer, an execution lease so two callers can't release the
// same PO at once, and partial-failure recovery (continue / rollback).
//
// See the migration 095/096 headers and the top-level design referenced
// there for the authoritative state machine and gate semantics.
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
  // L2 release states (migration 096).
  'release_in_progress',
  'released',
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

  // L2 release evidence (migration 096). All null until a release is
  // attempted; release_verified_at is set ONLY after a live post-read
  // proves the lot is now in the chosen FOR SALE room and sellable.
  releaseTransferAttemptedAt: z.string().nullable(),
  releaseTransferredAt: z.string().nullable(),
  releaseVerifiedAt: z.string().nullable(),
  releaseStockLocation: z.string().nullable(),
  releaseCurrentQty: z.number().nullable(),
  releaseLastError: z.string().nullable(),

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

  // L2 release run-level fields (migration 096).
  releaseTargetLocationId: z.number().int().nullable(),
  releaseTargetLocationName: z.string().nullable(),
  releaseRequestedAt: z.string().nullable(),
  releasedAt: z.string().nullable(),
  releaseLastError: z.string().nullable(),

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
  // L2 release gate: expected lots not yet confirmed FOR-SALE & sellable
  // in the chosen room (from the last release/continue pass).
  releaseUnverifiedLotCount: z.number().int(),
  // L2 (decision 8) informational badge: product ids that already have
  // on-floor (FOR SALE) stock from the last quarantine read, so the
  // operator knows a reprice also touches existing live stock.
  productIdsWithOnFloorStock: z.array(z.number().int()),
})
export type PurchaseLifecycleGateSummary = z.infer<typeof PurchaseLifecycleGateSummarySchema>

export const PurchaseLifecycleStatusResponseSchema = z.object({
  // True when migration 095 has not been applied on this DB yet. The
  // panel shows a "pending migration" note instead of erroring, and all
  // action routes refuse with 409 until it is applied.
  migrationPending: z.boolean(),
  // True when migration 095 IS applied but the L2 release migration 096
  // is NOT yet. L1 functionality (quarantine/market/reprice) still works;
  // only the release/repair/rollback actions refuse with 409.
  releaseMigrationPending: z.boolean(),
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

// A FOR SALE stock location the operator can release a purchase's lots
// into. Resolved live from Sweed (store.stock.location.list); only
// enabled, non-retired, "FOR SALE …" rooms are offered.
export const PurchaseLifecycleReleaseTargetSchema = z.object({
  locationId: z.number().int(),
  locationName: z.string(),
  stockTypeId: z.number().int(),
  // True for the per-site default ("FOR SALE - Sales Floor"), so the
  // panel can preselect it (decision 6).
  isDefault: z.boolean(),
})
export type PurchaseLifecycleReleaseTarget = z.infer<
  typeof PurchaseLifecycleReleaseTargetSchema
>

export const PurchaseLifecycleReleaseTargetsResponseSchema = z.object({
  migrationPending: z.boolean(),
  releaseMigrationPending: z.boolean(),
  targets: z.array(PurchaseLifecycleReleaseTargetSchema),
})
export type PurchaseLifecycleReleaseTargetsResponse = z.infer<
  typeof PurchaseLifecycleReleaseTargetsResponseSchema
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

// The release action additionally carries the chosen FOR SALE room. The
// id is re-resolved live against Sweed at release time (never trusted
// blindly): it must still be an enabled, non-retired "FOR SALE …" room.
export const PurchaseLifecycleReleaseRequestSchema = z.object({
  dealerId: z.number().int(),
  expectedVersion: z.number().int(),
  targetLocationId: z.number().int(),
})
export type PurchaseLifecycleReleaseRequest = z.infer<
  typeof PurchaseLifecycleReleaseRequestSchema
>
