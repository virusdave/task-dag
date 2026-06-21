// Pure display-label helpers for the pricing-safety lifecycle panel
// (automation#54, L1). Kept free of React so they can be unit-tested: the
// money-safety point is that an UNCHECKED gate must never render as a green
// "0" (e.g. "0 lots still sellable" before quarantine has been verified, or
// "0 products awaiting market data" before any market pull was requested).
// "Not checked" / "Not requested" / "No batch" / "Generating" / "Skipped"
// are distinct from a real, post-check zero.

import type {
  PurchaseLifecycleGateSummary,
  PurchaseLifecycleRun,
  PurchaseLifecycleState,
} from '../../../shared/contracts/index.js'

/** Has the quarantine gate actually been evaluated for this run yet? */
function quarantineChecked(run: PurchaseLifecycleRun): boolean {
  return run.items.some(
    (item) => item.quarantineVerifiedAt !== null || item.quarantineCurrentQty !== null || item.quarantineStockLocation !== null,
  )
}

/** Label + danger flag for the "lots still sellable" row. */
export function quarantineGateLabel(
  run: PurchaseLifecycleRun,
  summary: PurchaseLifecycleGateSummary,
): { text: string; danger: boolean } {
  if (run.path === 'reprice_in_place') {
    return { text: 'Skipped (reprice in place)', danger: false }
  }
  if (!quarantineChecked(run)) {
    return { text: 'Not checked yet', danger: false }
  }
  return {
    text: String(summary.quarantineSellableLotCount),
    danger: summary.quarantineSellableLotCount > 0,
  }
}

/** Label for the "products awaiting market data" row. */
export function marketGateLabel(
  run: PurchaseLifecycleRun,
  summary: PurchaseLifecycleGateSummary,
): string {
  if (run.marketRequestedAt === null) {
    return 'Not requested yet'
  }
  return String(summary.marketPendingProductIds.length)
}

/** Whether the pricing gate rows can show a real count yet. */
function pricingGateState(run: PurchaseLifecycleRun): 'no_batch' | 'generating' | 'ready' {
  if (run.pricingBatchId === null) return 'no_batch'
  if (run.state === 'pricing_pending') return 'generating'
  return 'ready'
}

/** Label for the "products not yet price-approved" row. */
export function priceUnapprovedLabel(
  run: PurchaseLifecycleRun,
  summary: PurchaseLifecycleGateSummary,
): string {
  switch (pricingGateState(run)) {
    case 'no_batch':
      return 'No pricing batch yet'
    case 'generating':
      return 'Batch generating…'
    case 'ready':
      return String(summary.priceUnapprovedProductIds.length)
  }
}

/** Label for the "products not yet price-verified" row. */
export function priceUnverifiedLabel(
  run: PurchaseLifecycleRun,
  summary: PurchaseLifecycleGateSummary,
): string {
  switch (pricingGateState(run)) {
    case 'no_batch':
      return 'No pricing batch yet'
    case 'generating':
      return 'Batch generating…'
    case 'ready':
      return String(summary.priceUnverifiedProductIds.length)
  }
}

/**
 * The single reprice button's label — it does a different discrete step
 * depending on the run state, so the verb must match what the click does.
 */
export function repriceButtonLabel(state: PurchaseLifecycleState): string {
  switch (state) {
    case 'market_refresh_pending':
      return 'Check market gate'
    case 'market_ready':
      return 'Create pricing batch'
    case 'pricing_pending':
      return 'Check pricing batch'
    default:
      return 'Re-verify applied prices'
  }
}

// ----------------------------- L2 release labels ---------------------------

/** Has any release attempt run for this run yet? */
function releaseAttempted(run: PurchaseLifecycleRun): boolean {
  return (
    run.releaseRequestedAt !== null ||
    run.state === 'release_in_progress' ||
    run.state === 'released' ||
    run.items.some(
      (item) =>
        item.releaseTransferAttemptedAt !== null ||
        item.releaseTransferredAt !== null ||
        item.releaseVerifiedAt !== null,
    )
  )
}

/**
 * Label + danger flag for the "lots not yet released" row. As with the
 * quarantine gate, an UNCHECKED release must never render as a green "0":
 * "Not released yet" (no attempt made) and "Skipped" (reprice-in-place)
 * are distinct from a real post-release zero.
 */
export function releaseGateLabel(
  run: PurchaseLifecycleRun,
  summary: PurchaseLifecycleGateSummary,
): { text: string; danger: boolean } {
  if (run.path === 'reprice_in_place') {
    return { text: 'Skipped (reprice in place)', danger: false }
  }
  if (!releaseAttempted(run)) {
    return { text: 'Not released yet', danger: false }
  }
  return {
    text: String(summary.releaseUnverifiedLotCount),
    danger: summary.releaseUnverifiedLotCount > 0,
  }
}

/**
 * Decision-8 informational badge: how many of the expected SKUs already
 * have on-floor (FOR SALE) stock, so the operator knows a reprice also
 * touches existing live stock. Returns null when there is nothing to
 * badge (so the panel can omit the row entirely).
 */
export function onFloorStockBadge(summary: PurchaseLifecycleGateSummary): string | null {
  const n = summary.productIdsWithOnFloorStock.length
  if (n === 0) return null
  return n === 1
    ? '1 SKU already has on-floor stock'
    : `${n} SKUs already have on-floor stock`
}

/**
 * The release button's verb depends on whether a fresh release or a
 * resume of a partial/interrupted attempt is what the click will do.
 */
export function releaseButtonLabel(state: PurchaseLifecycleState): string {
  return state === 'release_in_progress' ? 'Continue release' : 'Release to FOR SALE'
}
