// Pure gate logic for the purchase inventory pricing-safety lifecycle
// (automation#54, L1). Kept free of DB / Sweed I/O so the money-safety
// rules can be unit-tested deterministically; the service module
// (purchaseInventoryLifecycleService.ts) feeds these functions live data
// and persists their verdicts.

/** Price equality tolerance: 1¢, matching worker `waitForProductPrice`. */
export const PRICE_EQUALITY_TOLERANCE_DOLLARS = 0.01

/**
 * Mirror of `isForSaleStockLocationName` in catalog/maintenance.ts and
 * the worker stock-refresh job: a lot is "for sale" (customer-visible /
 * sellable) only when its stock-location name starts with the literal
 * prefix `for sale` (case-insensitive). Everything else — Reception,
 * Quarantine, "NOT FOR SALE - Hold for Dave inspection", etc. — is a
 * not-for-sale room.
 */
export function isForSaleStockLocationName(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false
  return name.trim().toLowerCase().startsWith('for sale')
}

export interface LiveLot {
  inventoryItemId: string
  metrcTag: string | null
  qty: number
  stockLocationName: string | null
}

export interface ExpectedLot {
  inventoryItemId: string
  metrcTag: string | null
}

export interface ItemQuarantineVerdict {
  /** A representative current location for the lot (for display/audit). */
  stockLocation: string | null
  /** A representative current on-hand qty for the lot. */
  currentQty: number | null
  /**
   * True when no positive-qty matching live lot is in a FOR SALE room —
   * i.e. the lot is safely not sellable (quarantined, or already
   * gone/zero). False when at least one positive-qty matching lot is
   * still in a FOR SALE room (a money-safety breach for the quarantine
   * path).
   */
  quarantined: boolean
}

/**
 * Decide whether a single expected lot is currently non-sellable, given
 * the live lots Sweed reports for its product. We match on inventory
 * item id first, falling back to METRC tag (Sweed can re-id a lot across
 * a move while preserving its track code).
 */
export function evaluateItemQuarantine(
  expected: ExpectedLot,
  liveLots: LiveLot[],
): ItemQuarantineVerdict {
  const matching = liveLots.filter(
    (lot) =>
      lot.inventoryItemId === expected.inventoryItemId ||
      (expected.metrcTag !== null &&
        lot.metrcTag !== null &&
        lot.metrcTag === expected.metrcTag),
  )

  const positiveQtyLots = matching.filter((lot) => lot.qty > 0)
  if (positiveQtyLots.length === 0) {
    // Gone / zero on hand → not sellable. Report any observed location.
    const representative = matching[0]
    return {
      stockLocation: representative?.stockLocationName ?? null,
      currentQty: representative ? representative.qty : 0,
      quarantined: true,
    }
  }

  const sellableLot = positiveQtyLots.find((lot) =>
    isForSaleStockLocationName(lot.stockLocationName),
  )
  const representative = sellableLot ?? positiveQtyLots[0]!
  return {
    stockLocation: representative.stockLocationName,
    currentQty: representative.qty,
    quarantined: sellableLot === undefined,
  }
}

export interface ItemReleaseVerdict {
  /** A representative current location for the lot (for display/audit). */
  stockLocation: string | null
  /** A representative current on-hand qty for the lot. */
  currentQty: number | null
  /**
   * True when the expected lot has been successfully released — i.e. a
   * positive-qty matching live lot is now in a FOR SALE room, OR the lot
   * is gone/zero (nothing left to release, so it cannot be a "not-yet-
   * priced lot still on the floor" risk). False when at least one
   * positive-qty matching lot is still in a NON-for-sale room (still to
   * be moved).
   */
  released: boolean
  /** True specifically when a positive-qty matching lot is now sellable. */
  sellable: boolean
}

/**
 * Decide whether a single expected lot is now released (sellable in a FOR
 * SALE room), given the live lots Sweed reports for its product. The
 * inverse of `evaluateItemQuarantine`: there, sellable is a breach; here,
 * sellable is the goal. Matching is by inventory item id, falling back to
 * METRC tag (Sweed can re-id a lot across a move).
 */
export function evaluateItemReleased(
  expected: ExpectedLot,
  liveLots: LiveLot[],
): ItemReleaseVerdict {
  const matching = liveLots.filter(
    (lot) =>
      lot.inventoryItemId === expected.inventoryItemId ||
      (expected.metrcTag !== null &&
        lot.metrcTag !== null &&
        lot.metrcTag === expected.metrcTag),
  )

  const positiveQtyLots = matching.filter((lot) => lot.qty > 0)
  if (positiveQtyLots.length === 0) {
    // Gone / zero on hand → nothing left to release (cannot be a
    // not-yet-priced lot on the floor). Report any observed location.
    const representative = matching[0]
    return {
      stockLocation: representative?.stockLocationName ?? null,
      currentQty: representative ? representative.qty : 0,
      released: true,
      sellable: false,
    }
  }

  const sellableLot = positiveQtyLots.find((lot) =>
    isForSaleStockLocationName(lot.stockLocationName),
  )
  const representative = sellableLot ?? positiveQtyLots[0]!
  // Released only when EVERY positive-qty matching lot is sellable; a
  // single still-quarantined positive-qty lot means more work remains.
  const allSellable = positiveQtyLots.every((lot) =>
    isForSaleStockLocationName(lot.stockLocationName),
  )
  return {
    stockLocation: representative.stockLocationName,
    currentQty: representative.qty,
    released: allSellable,
    sellable: sellableLot !== undefined,
  }
}

/**
 * Decision-8 badge: of the expected products, which already have on-floor
 * (positive-qty FOR SALE) stock right now. Surfaced so the operator knows
 * a SKU-level reprice/release also touches existing live stock. Purely
 * informational — never blocks.
 */
export function computeProductsWithOnFloorStock(
  productIds: number[],
  liveLotsByProduct: ReadonlyMap<number, LiveLot[]>,
): number[] {
  return productIds.filter((productId) => {
    const lots = liveLotsByProduct.get(productId) ?? []
    return lots.some((lot) => lot.qty > 0 && isForSaleStockLocationName(lot.stockLocationName))
  })
}

export interface MarketGateResult {
  /** Product ids without a succeeded observation after the cutoff. */
  pendingProductIds: number[]
  ready: boolean
}

/**
 * The market-ready gate: every expected product must have a succeeded
 * competitor observation captured AFTER the run's market_requested_at
 * cutoff. `readyProductIds` is the set the observation query proved
 * fresh; everything else is still pending.
 */
export function computeMarketGate(
  expectedProductIds: number[],
  readyProductIds: ReadonlySet<number>,
): MarketGateResult {
  const pendingProductIds = expectedProductIds.filter((id) => !readyProductIds.has(id))
  return {
    pendingProductIds,
    ready: expectedProductIds.length > 0 && pendingProductIds.length === 0,
  }
}

export interface PriceGateInputProduct {
  productId: number
  /** Approved desired price from the run's pricing batch, if approved. */
  approvedPriceDollars: number | null
  /** Live Sweed price read fresh, if readable. */
  livePriceDollars: number | null
}

export interface PriceGateResult {
  /** Products with no approved, finite price line in the pricing batch. */
  unapprovedProductIds: number[]
  /** Approved products whose live price != approved price (within 1¢). */
  unverifiedProductIds: number[]
  verified: boolean
}

/**
 * The price-applied gate: for every expected product, an approved finite
 * desired price must exist AND the live Sweed price must equal it within
 * 1¢. "Batch ready" / "line approved" is insufficient — approval only
 * enqueues the reconcile that writes to Sweed, so we compare the live
 * read.
 */
export function computePriceGate(products: PriceGateInputProduct[]): PriceGateResult {
  const unapprovedProductIds: number[] = []
  const unverifiedProductIds: number[] = []

  for (const product of products) {
    const approved = product.approvedPriceDollars
    if (approved === null || !Number.isFinite(approved)) {
      unapprovedProductIds.push(product.productId)
      continue
    }
    const live = product.livePriceDollars
    if (
      live === null ||
      !Number.isFinite(live) ||
      Math.abs(live - approved) >= PRICE_EQUALITY_TOLERANCE_DOLLARS
    ) {
      unverifiedProductIds.push(product.productId)
    }
  }

  return {
    unapprovedProductIds,
    unverifiedProductIds,
    verified:
      products.length > 0 &&
      unapprovedProductIds.length === 0 &&
      unverifiedProductIds.length === 0,
  }
}
