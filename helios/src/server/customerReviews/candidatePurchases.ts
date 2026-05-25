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
  return rankInvoices(invoices, args.submittedAt)
}

function rankInvoices(
  invoices: ReadonlyArray<SweedInvoiceRow>,
  submittedAt: Date,
): PurchaseCandidate[] {
  const scored: PurchaseCandidate[] = []
  for (const invoice of invoices) {
    if (invoice.clientId === null) continue
    const candidate = scoreInvoice(invoice, submittedAt)
    if (candidate === null) continue
    scored.push(candidate)
  }
  scored.sort((a, b) => b.confidence - a.confidence)
  return scored.slice(0, MAX_CANDIDATES)
}

export interface BulkCandidatesPerSubmission {
  submissionId: string
  candidates: PurchaseCandidate[]
}

/**
 * Bulk variant used at /reviews page load: takes every contact-less
 * submission visible on the page and returns candidates per
 * submissionId in ONE Sweed session.
 *
 * Implementation:
 *
 *   - Group submissions by dealerId.
 *   - For each dealer, compute the union time window covering all
 *     its submissions' [submitted-30min, submitted+4min] ranges and
 *     fire a single store.sale.invoice.list against that union with
 *     a generous page size. This is dramatically cheaper than one
 *     RPC per submission when the page shows ~100 contact-less
 *     submissions across 3 dealers (3 RPCs instead of 100).
 *   - Per submission, filter the dealer's invoices to its own window
 *     and rank by time-proximity.
 *
 * On any dealer-level Sweed failure we record an empty candidates
 * list for that dealer's submissions rather than failing the whole
 * batch — the SPA still renders, just without candidates for the
 * dead dealer; the per-submission GET endpoint can be used as a
 * retry.
 */
export async function loadCandidatePurchasesBulk(args: {
  submissions: ReadonlyArray<{ submissionId: string; dealerId: number; submittedAt: Date }>
  logger?: { error?: (obj: unknown, msg: string) => void }
}): Promise<BulkCandidatesPerSubmission[]> {
  if (args.submissions.length === 0) return []

  // Group submissions by dealer.
  const byDealer = new Map<
    number,
    Array<{ submissionId: string; submittedAt: Date }>
  >()
  for (const s of args.submissions) {
    const existing = byDealer.get(s.dealerId)
    if (existing) {
      existing.push({ submissionId: s.submissionId, submittedAt: s.submittedAt })
    } else {
      byDealer.set(s.dealerId, [{ submissionId: s.submissionId, submittedAt: s.submittedAt }])
    }
  }

  // One Sweed session for the whole bulk operation.
  return withSweedSession(async () => {
    const out: BulkCandidatesPerSubmission[] = []
    for (const [dealerId, dealerSubs] of byDealer.entries()) {
      const minSubmit = dealerSubs.reduce(
        (acc, s) => (s.submittedAt < acc ? s.submittedAt : acc),
        dealerSubs[0].submittedAt,
      )
      const maxSubmit = dealerSubs.reduce(
        (acc, s) => (s.submittedAt > acc ? s.submittedAt : acc),
        dealerSubs[0].submittedAt,
      )
      const fromDate = new Date(minSubmit.getTime() - LOOK_BACK_MINUTES * 60_000)
      const toDate = new Date(maxSubmit.getTime() + LOOK_AHEAD_MINUTES * 60_000)
      let invoices: SweedInvoiceRow[] = []
      try {
        // listSaleInvoices paginates internally; we let it use its
        // default per-page size (Sweed caps pageSize at 100).
        invoices = await listSaleInvoices({
          dealerId,
          fromDate,
          toDate,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        args.logger?.error?.(
          { err: msg, dealerId },
          'bulk candidate purchases: Sweed invoice list failed for dealer',
        )
        // Re-throw — silently returning empty candidates makes a
        // real Sweed-side failure look identical to "no matching
        // invoices", which is exactly the bug that surfaced when
        // pageSize=500 was rejected with 'Maximum page size
        // exceeded'. The route handler turns this into a 502 with
        // the underlying error message so the SPA shows it.
        throw new Error(`dealer ${dealerId}: ${msg}`)
      }
      for (const s of dealerSubs) {
        const windowStart = s.submittedAt.getTime() - LOOK_BACK_MINUTES * 60_000
        const windowEnd = s.submittedAt.getTime() + LOOK_AHEAD_MINUTES * 60_000
        const inWindow = invoices.filter((inv) => {
          if (inv.saleTime === null) return false
          const t = inv.saleTime.getTime()
          return t >= windowStart && t <= windowEnd
        })
        out.push({
          submissionId: s.submissionId,
          candidates: rankInvoices(inWindow, s.submittedAt),
        })
      }
    }
    return out
  })
}
