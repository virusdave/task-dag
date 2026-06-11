import { z } from 'zod'

// ---------------------------------------------------------------------------
// Customer Value analytics
//
// Backs the /metrics → "Customer value" tab. One consolidated endpoint
// that powers the four mandatory LTV histograms (customer count by
// purchase number, basket-size escalation, lifetime $ by total
// purchases, revenue mix by purchase ordinal) plus a KPI strip, all
// from a single CTE pass over `sweed_orders`.
//
// Margin $ is derived elsewhere (sweed_package_snapshots) and not
// included in this v1 endpoint — margin-basis histograms will be a
// follow-on once the per-order margin can be joined cheaply (see v1.4
// V4'2 — currently BLOCKED on prod line-items ingest). The SPA renders
// an explicit MISSING DATA card for the margin variants.
//
// v1.4 V4'3 adds cohort retention + first-to-second conversion behind
// an `?include=retention` query-param toggle (V4'0 decision). Existing
// callers don't pay the cost.
// ---------------------------------------------------------------------------

const csvList = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').filter((s) => s.length > 0) : []))

// `maxPurchaseNumber` is either a number 2..50 or the string 'auto'.
// On 'auto' the server picks the smallest N such that all buckets > N
// hold ≤1 customer, capped at 50 (so the long tail collapses into the
// overflow bucket without losing visible-bucket detail). Default if
// not specified is 'auto'.
const MaxPurchaseNumberParam = z.union([
  z.coerce.number().int().min(2).max(50),
  z.literal('auto'),
])

/**
 * Granularity for cohort retention bucketing (v1.4 V4'3). Acquisition
 * cohort = `date_trunc(<granularity>, first_purchase_at)`; retention
 * row per `(cohort_key, period_index)` where `period_index = 0` is the
 * acquisition period, `1` is one period later, etc. Default: `week`.
 */
export const CustomerValueCohortGranularitySchema = z.enum(['week', 'month'])
export type CustomerValueCohortGranularity = z.infer<typeof CustomerValueCohortGranularitySchema>

/**
 * Optional `?include=…` toggle (v1.4 V4'3). Comma-separated list of
 * extra payload sections to compute. Today only `retention` is
 * supported — it adds `cohortRetention[]` and
 * `firstSecondConversion[]` to the response. Future iterations may
 * add more sections here (e.g. `?include=retention,veriscan`).
 */
export const CustomerValueIncludeSectionSchema = z.enum(['retention'])
export type CustomerValueIncludeSection = z.infer<typeof CustomerValueIncludeSectionSchema>

/**
 * Purchase-count percentiles the Customer Value tab reports. Exactly
 * five, each an integer in `[50, 99]`. The operator can pick which
 * five via the `?percentiles=` request param; the default mirrors the
 * original fixed set.
 */
export const PURCHASE_COUNT_PERCENTILE_SLOTS = 5
export const PURCHASE_COUNT_PERCENTILE_MIN = 50
export const PURCHASE_COUNT_PERCENTILE_MAX = 99
export const DEFAULT_PURCHASE_COUNT_PERCENTILES: readonly number[] = [50, 75, 80, 90, 95]

/** Clamp + round one requested percentile into the supported range. */
export function normalizePurchaseCountPercentile(n: number): number {
  return Math.min(
    PURCHASE_COUNT_PERCENTILE_MAX,
    Math.max(PURCHASE_COUNT_PERCENTILE_MIN, Math.round(n)),
  )
}

/**
 * Normalize an arbitrary requested list into exactly five valid
 * percentiles: drop non-finite entries, clamp each to `[50, 99]`,
 * truncate beyond five, and pad short lists from the default set.
 * Order is preserved (the operator chose it).
 */
export function normalizePurchaseCountPercentiles(input: readonly number[]): number[] {
  const cleaned = input
    .filter((n) => Number.isFinite(n))
    .map(normalizePurchaseCountPercentile)
    .slice(0, PURCHASE_COUNT_PERCENTILE_SLOTS)
  while (cleaned.length < PURCHASE_COUNT_PERCENTILE_SLOTS) {
    cleaned.push(DEFAULT_PURCHASE_COUNT_PERCENTILES[cleaned.length])
  }
  return cleaned
}

// `?percentiles=` — comma-separated integers; normalized to exactly
// five values in [50, 99]. Empty / unset → the default set.
const PercentilesParam = z
  .string()
  .optional()
  .transform((v) =>
    normalizePurchaseCountPercentiles(
      v
        ? v
            .split(',')
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n))
        : [],
    ),
  )

export const CustomerValueAnalyticsRequestSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  sites: csvList,
  maxPurchaseNumber: MaxPurchaseNumberParam.optional(),
  cohortScope: z.enum(['all_as_of_end', 'active_in_range', 'acquired_in_range']).optional(),
  /**
   * Comma-separated list of additive payload sections. v1.4 V4'3:
   * `retention` adds cohort retention + first-to-second conversion.
   * Unknown sections are rejected (Zod enum) so a typo doesn't
   * silently degrade to "no retention data".
   */
  include: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter((s) => s.length > 0) : []))
    .pipe(z.array(CustomerValueIncludeSectionSchema)),
  /** Cohort retention granularity. Only meaningful when `include=retention`. */
  cohortGranularity: CustomerValueCohortGranularitySchema.optional(),
  /**
   * Which five purchase-count percentiles to report (each 50..99).
   * Comma-separated; normalized to exactly five. Empty / unset →
   * the default set (50/75/80/90/95).
   */
  percentiles: PercentilesParam,
})
export type CustomerValueAnalyticsRequest = z.infer<typeof CustomerValueAnalyticsRequestSchema>

// =========================== Summary KPIs ==================================

/**
 * One reported percentile of per-customer total purchase count
 * (number of purchases) across the in-scope customer set.
 *
 *   - `percentile` — the requested percentile (50..99).
 *   - `value`      — the smallest purchase count at or below which
 *     that fraction of customers fall (`percentile_disc` — an actual
 *     observed integer count, never an interpolated fraction).
 *     `null` when there are no in-scope customers.
 *
 * Honours the same site + date + cohort-scope filters as the rest of
 * the page. The response always carries exactly five entries, in the
 * order the operator requested (default 50/75/80/90/95).
 */
export const PurchaseCountPercentileSchema = z.object({
  percentile: z.number().int().min(50).max(99),
  value: z.number().nullable(),
})
export type PurchaseCountPercentile = z.infer<typeof PurchaseCountPercentileSchema>

export const PurchaseCountPercentilesSchema = z.array(PurchaseCountPercentileSchema)
export type PurchaseCountPercentiles = z.infer<typeof PurchaseCountPercentilesSchema>

/**
 * Fixed set of trailing-12-month per-customer spend percentiles the
 * Customer Value tab reports (operator request 2026-06-11). Unlike the
 * purchase-count percentiles these are NOT operator-adjustable.
 */
export const TRAILING_SPEND_PERCENTILES: readonly number[] = [50, 80, 90, 95]

/**
 * One reported percentile of per-customer spend over the trailing 12
 * months ending at the window `to`. The population is non-guest
 * customers with at least one non-cancelled order at the selected
 * sites in [to − 12 months, to). All three $ bases are reported so the
 * client can switch with the page's `$ basis` selector without a
 * re-fetch; each value is `null` when the population is empty.
 */
export const TrailingSpendPercentileSchema = z.object({
  percentile: z.number().int().min(1).max(99),
  grossSalesDollars: z.number().nullable(),
  netSalesDollars: z.number().nullable(),
  grossReceiptsDollars: z.number().nullable(),
})
export type TrailingSpendPercentile = z.infer<typeof TrailingSpendPercentileSchema>

export const TrailingSpendPercentilesSchema = z.array(TrailingSpendPercentileSchema)
export type TrailingSpendPercentiles = z.infer<typeof TrailingSpendPercentilesSchema>

export const CustomerValueSummarySchema = z.object({
  knownCustomers: z.number().int().nonnegative(),
  totalOrders: z.number().int().nonnegative(),
  firstPurchases: z.number().int().nonnegative(),
  repeatPurchases: z.number().int().nonnegative(),
  repeatPurchaseRate: z.number().nullable(),
  observedAvgLtvGrossDollars: z.number().nullable(),
  observedMedianLtvGrossDollars: z.number().nullable(),
  /** Percentiles of per-customer total purchase count (50/75/80/90/95). */
  purchaseCountPercentiles: PurchaseCountPercentilesSchema,
  /** Percentiles of per-customer trailing-12-month spend (50/80/90/95). */
  trailing12moSpendPercentiles: TrailingSpendPercentilesSchema,
  grossSalesDollars: z.number(),
  grossReceiptsDollars: z.number(),
  netSalesDollars: z.number(),
})
export type CustomerValueSummary = z.infer<typeof CustomerValueSummarySchema>

// =========================== Chart point shapes ============================

/** Histogram 1: customer count by total purchase count. */
export const PurchaseCountBucketSchema = z.object({
  totalPurchases: z.number().int().positive(),
  /** When `totalPurchases > maxPurchaseNumber` this is true and the
   *  bucket aggregates everyone in the long tail. */
  isOverflowBucket: z.boolean(),
  customerCount: z.number().int().nonnegative(),
  totalGrossSalesDollars: z.number(),
  totalNetSalesDollars: z.number(),
  totalGrossReceiptsDollars: z.number(),
})
export type PurchaseCountBucket = z.infer<typeof PurchaseCountBucketSchema>

/** Histogram 2: avg basket at the Nth purchase ordinal. */
export const BasketByPurchaseNumberPointSchema = z.object({
  purchaseNumber: z.number().int().positive(),
  isOverflowBucket: z.boolean(),
  orderCount: z.number().int().nonnegative(),
  avgGrossSalesDollars: z.number().nullable(),
  medianGrossSalesDollars: z.number().nullable(),
  avgNetSalesDollars: z.number().nullable(),
  medianNetSalesDollars: z.number().nullable(),
  avgGrossReceiptsDollars: z.number().nullable(),
})
export type BasketByPurchaseNumberPoint = z.infer<typeof BasketByPurchaseNumberPointSchema>

/** Histogram 3: avg lifetime value for customers who end up purchasing X times. */
export const LifetimeByTotalPurchasesPointSchema = z.object({
  totalPurchases: z.number().int().positive(),
  isOverflowBucket: z.boolean(),
  customerCount: z.number().int().nonnegative(),
  avgLifetimeGrossSalesDollars: z.number().nullable(),
  medianLifetimeGrossSalesDollars: z.number().nullable(),
  avgLifetimeNetSalesDollars: z.number().nullable(),
  medianLifetimeNetSalesDollars: z.number().nullable(),
})
export type LifetimeByTotalPurchasesPoint = z.infer<typeof LifetimeByTotalPurchasesPointSchema>

/** Histogram 4: total revenue contributed at purchase ordinal X (within window). */
export const ContributionByPurchaseNumberPointSchema = z.object({
  purchaseNumber: z.number().int().positive(),
  isOverflowBucket: z.boolean(),
  orderCount: z.number().int().nonnegative(),
  totalGrossSalesDollars: z.number(),
  totalNetSalesDollars: z.number(),
  totalGrossReceiptsDollars: z.number(),
})
export type ContributionByPurchaseNumberPoint = z.infer<typeof ContributionByPurchaseNumberPointSchema>

// =========================== Cohort retention (v1.4 V4'3) =================

/**
 * One row of the cohort retention grid (v1.4 V4'3). Acquisition
 * cohort = `date_trunc(<granularity>, first_purchase_at)`; one row
 * per `(cohort_key, period_index)` where `period_index = 0` is the
 * acquisition period, `1` is one period later, etc.
 *
 * `retention_pct` is the fraction in `[0, 1]` (operator convention —
 * client formats as `pct` via `formatAxisValue`).
 */
export const CohortRetentionRowSchema = z.object({
  /** ISO-8601 datetime of the cohort's first period (UTC). */
  cohortKey: z.string().datetime(),
  cohortSize: z.number().int().nonnegative(),
  periodIndex: z.number().int().nonnegative(),
  retainedCount: z.number().int().nonnegative(),
  retentionPct: z.number(),
})
export type CohortRetentionRow = z.infer<typeof CohortRetentionRowSchema>

/**
 * One row per acquisition cohort summarising first-to-second purchase
 * conversion (v1.4 V4'3). The four `*_pct` fields are fractions in
 * `[0, 1]` over the cohort size.
 *
 *   - `everPct`     — fraction of cohort with a second purchase ever
 *                     (before `to`).
 *   - `within30dPct`/`within60dPct`/`within90dPct` — fraction whose
 *                     second purchase fell within N days of the first.
 */
export const FirstSecondConversionRowSchema = z.object({
  /** ISO-8601 datetime of the cohort's first period (UTC). */
  cohortKey: z.string().datetime(),
  cohortSize: z.number().int().nonnegative(),
  everCount: z.number().int().nonnegative(),
  within30dCount: z.number().int().nonnegative(),
  within60dCount: z.number().int().nonnegative(),
  within90dCount: z.number().int().nonnegative(),
  everPct: z.number(),
  within30dPct: z.number(),
  within60dPct: z.number(),
  within90dPct: z.number(),
})
export type FirstSecondConversionRow = z.infer<typeof FirstSecondConversionRowSchema>

// =========================== VeriScan coverage (v1.4 V4'5) ================

/**
 * Window-scoped VeriScan link coverage (v1.4 V4'5). Counts the rows
 * of `sweed_orders` whose `customer_id` is linked to a VeriScan-known
 * identity via `visitor_scan_links` (`link_status = 'linked'`) over
 * the visible window. Always present on the consolidated payload —
 * the badge is in the tab header and the query is cheap.
 *
 *   * `linked` — sweed_orders rows in window whose customer_id has a
 *     linked visitor_scan_links row for the same dealer.
 *   * `total`  — total sweed_orders rows in window for the selected
 *     dealers (known + guest).
 *   * `pct`    — `linked / total`, fraction in `[0, 1]`. `0` when
 *     `total === 0` (no orders in window).
 *
 * Operator-set threshold for promoting VeriScan-keyed views from
 * MISSING DATA to real is 25% (`pct >= 0.25`); see the
 * "Show only VeriScan-linked customers" toggle on the Customer Value
 * tab header. Full VeriScan-keyed views are v1.4.1 scope.
 */
export const VeriscanCoverageSchema = z.object({
  linked: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  pct: z.number().min(0).max(1),
})
export type VeriscanCoverage = z.infer<typeof VeriscanCoverageSchema>

/**
 * Per-response metadata bag (v1.4 V4'5). Today only carries
 * `veriscanCoverage`; future sections (e.g. data-freshness stamps,
 * upstream-ingest health) attach here without expanding the
 * top-level response shape.
 */
export const CustomerValueMetaSchema = z.object({
  veriscanCoverage: VeriscanCoverageSchema,
})
export type CustomerValueMeta = z.infer<typeof CustomerValueMetaSchema>

// =========================== Missing-data card =============================

export const CustomerValueMissingDataCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  whyMissing: z.string(),
  neededSource: z.string(),
  unlockedMetrics: z.array(z.string()),
  blockedByUrl: z.string().url().nullable(),
})
export type CustomerValueMissingDataCard = z.infer<typeof CustomerValueMissingDataCardSchema>

// =========================== Top-level response ============================

export const CustomerValueAnalyticsResponseSchema = z.object({
  range: z.object({ from: z.string().datetime(), to: z.string().datetime() }),
  generatedAt: z.string().datetime(),
  sites: z.array(z.string()),
  maxPurchaseNumber: z.number().int().positive(),
  cohortScope: z.enum(['all_as_of_end', 'active_in_range', 'acquired_in_range']),
  /**
   * Cohort retention granularity used in the response (v1.4 V4'3).
   * Echoed back so the client can label the X axis correctly even
   * if the operator's request and the server's default differed.
   */
  cohortGranularity: CustomerValueCohortGranularitySchema,
  summary: CustomerValueSummarySchema,
  purchaseCountHistogram: z.array(PurchaseCountBucketSchema),
  basketByPurchaseNumber: z.array(BasketByPurchaseNumberPointSchema),
  lifetimeByTotalPurchases: z.array(LifetimeByTotalPurchasesPointSchema),
  contributionByPurchaseNumber: z.array(ContributionByPurchaseNumberPointSchema),
  /**
   * Cohort retention rows (v1.4 V4'3). Empty unless the request
   * carried `include=retention`. Sorted by `(cohortKey, periodIndex)`.
   */
  cohortRetention: z.array(CohortRetentionRowSchema).default([]),
  /**
   * Per-cohort first-to-second-purchase conversion rows (v1.4 V4'3).
   * Empty unless the request carried `include=retention`. Sorted by
   * `cohortKey`.
   */
  firstSecondConversion: z.array(FirstSecondConversionRowSchema).default([]),
  /**
   * Per-response metadata (v1.4 V4'5). Carries the window-scoped
   * `veriscanCoverage` triple used by the Customer Value tab header
   * badge + the gated "VeriScan-linked only" toggle. Always present.
   */
  meta: CustomerValueMetaSchema,
  missingDataCards: z.array(CustomerValueMissingDataCardSchema),
})
export type CustomerValueAnalyticsResponse = z.infer<typeof CustomerValueAnalyticsResponseSchema>
