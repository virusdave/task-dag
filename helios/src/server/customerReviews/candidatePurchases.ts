// =====================================================================
// Customer-Sentiment Capture — "candidate purchases for a contact-less
// review" surface.
//
// When a customer submits a star rating (and maybe a text review)
// without giving us a phone or email, helios has nothing to attach
// them to inside Sweed: no client lookup, no segment add, no email
// follow-up. This module fetches the few retail invoices the dealer
// rang up around the moment the review landed (a 30-minute look-back
// window plus a 4-minute look-ahead, since customers tend to submit
// the review while waiting for their order) and ranks them by time
// proximity so the operator can pick a likely match and treat that
// customer's phone/email as the reviewer's.
//
// The 4-minute look-ahead is operator-supplied: it accounts for
// customers who start filling out the form before the checkout has
// closed.
//
// Ranking is purely time-proximity — closest sale time to the
// review-submission moment wins. "Confidence" exposed to the UI is
// a 0..1 number, computed as `1 - |delta_seconds| /
// PROXIMITY_WINDOW_SECONDS`, clamped to [0, 1]. The first row is
// always the highest-confidence; the UI badges it visibly.
// =====================================================================

import { listSaleInvoices, type SweedInvoiceRow } from '../../worker/sweed/sales.js'
import { withSweedSession } from '../../worker/sweed/session.js'

// Look back this far before the submission to consider matching invoices.
export const LOOK_BACK_MINUTES = 30
// Look ahead this far after the submission (customer-submits-while-
// waiting buffer).
export const LOOK_AHEAD_MINUTES = 4
// Number of candidates surfaced to the operator.
export const MAX_CANDIDATES = 5
// Used as the confidence denominator. A sale exactly at the
// submission moment scores 1.0; a sale exactly LOOK_BACK_MINUTES
// before scores ~0.
const PROXIMITY_WINDOW_SECONDS = LOOK_BACK_MINUTES * 60

export interface PurchaseCandidate {
  invoiceId: string | null
  saleTime: string // ISO
  // Seconds between sale time and submission time. Negative means the
  // sale closed BEFORE the submission (the normal case). Positive
  // means the sale closed AFTER the submission (customer paid right
  // after submitting — still within the 4-minute look-ahead).
  deltaSeconds: number
  // 0..1 confidence score, sorted descending. First row is highest.
  confidence: number
  total: number | null
  clientId: number | null
  clientName: string | null
  clientPhone: string | null
  clientEmail: string | null
}

function scoreInvoice(invoice: SweedInvoiceRow, submittedAt: Date): PurchaseCandidate | null {
  if (invoice.saleTime === null) return null
  const deltaMs = invoice.saleTime.getTime() - submittedAt.getTime()
  const deltaSec = Math.round(deltaMs / 1000)
  const absDeltaSec = Math.abs(deltaSec)
  const confidence = Math.max(
    0,
    Math.min(1, 1 - absDeltaSec / PROXIMITY_WINDOW_SECONDS),
  )
  return {
    invoiceId: invoice.invoiceId,
    saleTime: invoice.saleTime.toISOString(),
    deltaSeconds: deltaSec,
    confidence,
    total: invoice.total,
    clientId: invoice.clientId,
    clientName: invoice.clientName,
    clientPhone: invoice.clientPhone,
    clientEmail: invoice.clientEmail,
  }
}

/**
 * Fetch + rank candidate purchases for a contact-less review
 * submission. Always opens a fresh Sweed session via
 * `withSweedSession`, never imports a SWEED_AUTH_TOKEN env shortcut
 * (per docs/sweed/getting-a-token-for-one-offs.md).
 *
 * Returns up to MAX_CANDIDATES rows ordered by descending
 * confidence (closest sale time first). Rows with no client-id are
 * filtered out since they can't be added to a segment.
 */
export async function loadCandidatePurchases(args: {
  dealerId: number
  submittedAt: Date
}): Promise<PurchaseCandidate[]> {
  const fromDate = new Date(args.submittedAt.getTime() - LOOK_BACK_MINUTES * 60_000)
  const toDate = new Date(args.submittedAt.getTime() + LOOK_AHEAD_MINUTES * 60_000)
  const invoices = await withSweedSession(() =>
    listSaleInvoices({
      dealerId: args.dealerId,
      fromDate,
      toDate,
      pageSize: 50,
    }),
  )
  const scored: PurchaseCandidate[] = []
  for (const invoice of invoices) {
    if (invoice.clientId === null) continue // can't segment without client id
    const candidate = scoreInvoice(invoice, args.submittedAt)
    if (candidate === null) continue
    scored.push(candidate)
  }
  // Sort by descending confidence (== ascending |deltaSeconds|).
  scored.sort((a, b) => b.confidence - a.confidence)
  return scored.slice(0, MAX_CANDIDATES)
}
