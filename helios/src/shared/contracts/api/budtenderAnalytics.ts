import { z } from 'zod'

// ---------------------------------------------------------------------------
// Budtender Performance analytics
//
// Backs the /metrics → "Budtender performance" tab. Returns one row
// per cashier over the requested window, plus daily aggregates and
// top-line totals — all in one endpoint so the page makes ONE backend
// round-trip rather than N. Patterned after the catalog-analytics
// surface (one consolidated CTE feeds many cards) but pivoted on
// cashier instead of inventory-item.
//
// Per oracle's design (https://ampcode.com/threads/T-019e654a-…):
// every metric here is computed from REAL data we already have
// (sweed_orders header + sweed_drawer_shifts + sweed_drawer_shift_sessions
// + staff_directory_cache). Metrics that would require new ingest
// (line items, returns, cashier-attributed reviews, drawer cash
// over/short) are NOT returned here — the SPA renders explicit
// MISSING DATA cards for them and links to the future-work issue.
// ---------------------------------------------------------------------------

// ============================ Request schema ===============================

const csvList = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').filter((s) => s.length > 0) : []))

export const BudtenderAnalyticsRequestSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  sites: csvList,
})
export type BudtenderAnalyticsRequest = z.infer<typeof BudtenderAnalyticsRequestSchema>

// ============================ Per-cashier row ==============================

/**
 * Aggregate row for ONE cashier over the requested window.
 *
 * Naming: every numeric metric is named so the SPA's scatter axis
 * picker can present it directly. `null` means "the underlying input
 * was unavailable / sample too small" — the renderer skips nulls.
 */
export const BudtenderCashierRowSchema = z.object({
  cashierId: z.string(),
  cashierName: z.string().nullable(),
  /** Sweed user.compliance.list `blocked`. This, rather than the
   *  numeric userStatus classification, determines whether the user
   *  is blocked. Null means the cashier is absent from the cache. */
  blocked: z.boolean().nullable(),
  /** Raw Sweed userStatus classification. Active users currently
   *  carry non-zero values, so this is informational only. */
  userStatus: z.number().int().nullable(),

  // -------- Volume / sales --------
  transactions: z.number().int().nonnegative(),
  sales: z.number(),
  subtotal: z.number(),
  tax: z.number(),
  discount: z.number(),
  avgOrderValue: z.number().nullable(),
  medianOrderValue: z.number().nullable(),
  p90OrderValue: z.number().nullable(),

  // -------- Discount behaviour --------
  discountRate: z.number().nullable(),
  avgDiscountPerTransaction: z.number().nullable(),
  discountedTransactionRate: z.number().nullable(),

  // -------- Customer mix --------
  uniqueKnownCustomers: z.number().int().nonnegative(),
  guestRate: z.number().nullable(),
  firstTimeCustomerRate: z.number().nullable(),
  knownRepeatCustomerRate: z.number().nullable(),

  // -------- Fulfillment / payment mix --------
  deliveryRate: z.number().nullable(),
  pickupRate: z.number().nullable(),
  cashPaymentRate: z.number().nullable(),

  // -------- Activity --------
  activeDays: z.number().int().nonnegative(),
  transactionsPerActiveDay: z.number().nullable(),
  salesPerActiveDay: z.number().nullable(),

  // -------- Shift productivity (from drawer-shift sessions) --------
  /** Total drawer-shift minutes (overlapped with the request window)
   *  the cashier was on as a session participant. NULL when the
   *  cashier user_id never appeared in a drawer-shift session row in
   *  the window (e.g. mobile-app order rings before drawer-shifts
   *  ingest was running). */
  drawerMinutes: z.number().nullable(),
  drawerCount: z.number().int().nullable(),
  transactionsPerDrawerHour: z.number().nullable(),
  salesPerDrawerHour: z.number().nullable(),
  hasDrawerMatch: z.boolean(),

  // -------- Upsell / basket lift (dollar-based; quantity unknown) --------
  /** Per-transaction mean of (this order's grand_total - same
   *  customer's leave-one-out mean grand_total). Only non-guest
   *  customers with ≥2 orders contribute. Positive ⇒ this cashier
   *  rings larger-than-baseline baskets for the SAME customer. */
  sameCustomerLiftDollars: z.number().nullable(),
  sameCustomerLiftPct: z.number().nullable(),
  sameCustomerLiftSample: z.number().int().nonnegative(),

  /** Like above but cohort = (is_guest, first_time_for_customer,
   *  fulfillment_type, payment_method). Quantifies upsell against
   *  "similar-looking" customers regardless of whether we've seen
   *  the specific customer before. */
  similarCustomerLiftDollars: z.number().nullable(),
  similarCustomerLiftPct: z.number().nullable(),
  similarCustomerLiftSample: z.number().int().nonnegative(),

  // -------- Peer-normalised --------
  peer: z.object({
    salesPercentile: z.number().nullable(),
    avgOrderValuePercentile: z.number().nullable(),
    discountRatePercentile: z.number().nullable(),
    transactionsPerDrawerHourPercentile: z.number().nullable(),
    sameCustomerLiftPercentile: z.number().nullable(),
    similarCustomerLiftPercentile: z.number().nullable(),

    avgOrderValueDeltaVsPeerMedian: z.number().nullable(),
    discountRateDeltaVsPeerMedian: z.number().nullable(),
    transactionsPerDrawerHourDeltaVsPeerMedian: z.number().nullable(),
    sameCustomerLiftDeltaVsPeerMedian: z.number().nullable(),
  }),
})
export type BudtenderCashierRow = z.infer<typeof BudtenderCashierRowSchema>

export type BudtenderCashierBlockedStatus = 'blocked' | 'not_blocked' | 'unknown'

export function budtenderCashierBlockedStatus(
  cashier: Pick<BudtenderCashierRow, 'blocked'>,
): BudtenderCashierBlockedStatus {
  if (cashier.blocked === null) return 'unknown'
  return cashier.blocked ? 'blocked' : 'not_blocked'
}

/** Sweed's explicit blocked flag owns disabled-badge semantics. */
export function isBudtenderCashierDisabled(
  cashier: Pick<BudtenderCashierRow, 'blocked'>,
): boolean {
  return budtenderCashierBlockedStatus(cashier) === 'blocked'
}

export const BudtenderReviewCashierRowSchema = z.object({
  cashierId: z.string(),
  cashierName: z.string().nullable(),
  reviewCount: z.number().int().nonnegative(),
  averageStarRating: z.number().nullable(),
  classifiedReviewCount: z.number().int().nonnegative(),
  lukewarmOrNegativeCount: z.number().int().nonnegative(),
  lukewarmOrNegativeRate: z.number().nullable(),
})
export type BudtenderReviewCashierRow = z.infer<typeof BudtenderReviewCashierRowSchema>

// ============================ Daily roll-up ================================

export const BudtenderDailyRowSchema = z.object({
  day: z.string(), // ISO date (UTC day boundary in v1)
  transactions: z.number().int().nonnegative(),
  unassignedTransactions: z.number().int().nonnegative(),
  sales: z.number(),
  avgOrderValue: z.number().nullable(),
  discountRate: z.number().nullable(),
  activeCashiers: z.number().int().nonnegative(),
})
export type BudtenderDailyRow = z.infer<typeof BudtenderDailyRowSchema>

// ============================ Top-line totals ==============================

export const BudtenderTotalsSchema = z.object({
  attributedTransactions: z.number().int().nonnegative(),
  unassignedTransactions: z.number().int().nonnegative(),
  attributedSales: z.number(),
  activeCashiers: z.number().int().nonnegative(),
  avgOrderValue: z.number().nullable(),
  discountRate: z.number().nullable(),
})
export type BudtenderTotals = z.infer<typeof BudtenderTotalsSchema>

// ============================ MISSING DATA cards ===========================

export const BudtenderMissingDataCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  whyMissing: z.string(),
  neededSource: z.string(),
  unlockedMetrics: z.array(z.string()),
  blockedByUrl: z.string().url().nullable(),
})
export type BudtenderMissingDataCard = z.infer<typeof BudtenderMissingDataCardSchema>

// ============================ Response =====================================

export const BudtenderAnalyticsResponseSchema = z.object({
  range: z.object({ from: z.string().datetime(), to: z.string().datetime() }),
  generatedAt: z.string().datetime(),
  sites: z.array(z.string()),
  totals: BudtenderTotalsSchema,
  daily: z.array(BudtenderDailyRowSchema),
  cashiers: z.array(BudtenderCashierRowSchema),
  reviewCashiers: z.array(BudtenderReviewCashierRowSchema),
  missingDataCards: z.array(BudtenderMissingDataCardSchema),
})
export type BudtenderAnalyticsResponse = z.infer<typeof BudtenderAnalyticsResponseSchema>
