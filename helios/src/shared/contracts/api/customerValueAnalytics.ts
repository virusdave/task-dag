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
// Margin $ is a first-class money basis alongside gross sales / net
// sales / gross receipts. Per-line margin is computed from
// `sweed_order_items_flat` using the same convention as the proven
// `margins.gross_margin_dollars` registry metric (line revenue minus
// qty × `sweed_package_cost_as_of_or_earliest(...)`, unknown cost
// treated as $0, canceled lines excluded), pre-aggregated to invoice
// grain and LEFT JOINed to the order-grain purchase-event CTEs. See
// customerValueAnalyticsQueries.ts.
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
   * Marketing-segment lens (v1.4 V4'6). Comma-separated Sweed segment
   * ids; OR semantics (a customer matches if they belong to ANY of
   * them), same convention as the customer-map lens. When non-empty
   * the WHOLE page (KPIs, the four histograms, trailing spend,
   * retention, VeriScan coverage) is restricted to members of any
   * selected segment, read from the cached `sweed_customer_segments`
   * table. Empty / unset => no segment filter. Guests cannot belong
   * to a marketing segment, so the guest order count is forced to 0
   * when this is set.
   */
  marketingSegmentIds: csvList,
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
  /** Margin $ = line revenue − qty × package cost (unknown cost
   *  treated as $0; canceled lines excluded). Same convention as the
   *  `margins.gross_margin_dollars` registry metric. */
  marginDollars: z.number().nullable(),
})
export type TrailingSpendPercentile = z.infer<typeof TrailingSpendPercentileSchema>

export const TrailingSpendPercentilesSchema = z.array(TrailingSpendPercentileSchema)
export type TrailingSpendPercentiles = z.infer<typeof TrailingSpendPercentilesSchema>

/**
 * Minimum-visit thresholds for the repeat-only trailing-spend
 * percentile breakouts (operator request 2026-06-11): `> 1, > 2, > 3,
 * > 4` visits in the trailing window — i.e. `minVisits` of 2/3/4/5.
 */
export const TRAILING_SPEND_REPEAT_MIN_VISITS: readonly number[] = [2, 3, 4, 5]

/**
 * Trailing-12-month spend percentiles for one minimum-visit cohort.
 * `minVisits = 2` means "customers with > 1 visit", etc.
 */
export const TrailingSpendByMinVisitsSchema = z.object({
  minVisits: z.number().int().min(2),
  customers: z.number().int().nonnegative(),
  percentiles: TrailingSpendPercentilesSchema,
})
export type TrailingSpendByMinVisits = z.infer<typeof TrailingSpendByMinVisitsSchema>

export const CustomerValueSummarySchema = z.object({
  knownCustomers: z.number().int().nonnegative(),
  totalOrders: z.number().int().nonnegative(),
  firstPurchases: z.number().int().nonnegative(),
  repeatPurchases: z.number().int().nonnegative(),
  repeatPurchaseRate: z.number().nullable(),
  // Observed lifetime-to-date value per known customer, one pair
  // (avg + median) per money basis so the KPI strip can switch with
  // the `$ basis` selector. `…GrossDollars` is the gross-sales basis
  // (kept under its original name for back-compat).
  observedAvgLtvGrossDollars: z.number().nullable(),
  observedMedianLtvGrossDollars: z.number().nullable(),
  observedAvgLtvNetSalesDollars: z.number().nullable(),
  observedMedianLtvNetSalesDollars: z.number().nullable(),
  observedAvgLtvGrossReceiptsDollars: z.number().nullable(),
  observedMedianLtvGrossReceiptsDollars: z.number().nullable(),
  /** Margin basis (line revenue − qty × package cost; unknown cost $0,
   *  canceled lines excluded). Same convention as
   *  `margins.gross_margin_dollars`. */
  observedAvgLtvMarginDollars: z.number().nullable(),
  observedMedianLtvMarginDollars: z.number().nullable(),
  /** Percentiles of per-customer total purchase count (50/75/80/90/95). */
  purchaseCountPercentiles: PurchaseCountPercentilesSchema,
  /** Percentiles of per-customer trailing-12-month spend (50/80/90/95). */
  trailing12moSpendPercentiles: TrailingSpendPercentilesSchema,
  /**
   * Same trailing-12-month spend percentiles, broken out by repeat
   * cohort — customers with >= N non-cancelled orders in the trailing
   * window, for N in TRAILING_SPEND_REPEAT_MIN_VISITS (2/3/4/5, i.e.
   * > 1 / > 2 / > 3 / > 4 visits).
   */
  trailing12moSpendPercentilesByMinVisits: z.array(TrailingSpendByMinVisitsSchema),
  grossSalesDollars: z.number(),
  grossReceiptsDollars: z.number(),
  netSalesDollars: z.number(),
  /** Sum of margin $ across all in-scope orders in the visible window
   *  (same convention as `margins.gross_margin_dollars`). */
  marginDollars: z.number(),
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
  /** Margin basis (unknown package cost treated as $0; canceled lines
   *  excluded). Same convention as `margins.gross_margin_dollars`. */
  avgMarginDollars: z.number().nullable(),
  medianMarginDollars: z.number().nullable(),
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
  /** Margin basis (unknown package cost treated as $0; canceled lines
   *  excluded). Same convention as `margins.gross_margin_dollars`. */
  avgLifetimeMarginDollars: z.number().nullable(),
  medianLifetimeMarginDollars: z.number().nullable(),
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
  /** Margin basis (unknown package cost treated as $0; canceled lines
   *  excluded). Same convention as `margins.gross_margin_dollars`. */
  totalMarginDollars: z.number(),
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
 * Active marketing-segment lens echo (v1.4 V4'6). Carries the
 * server-sanitized set of segment ids actually applied to this
 * response so the client banner reflects what the server filtered on
 * (not just what the URL requested). Empty when no lens is active.
 */
export const CustomerValueSegmentLensSchema = z.object({
  selectedSegmentIds: z.array(z.string()),
})
export type CustomerValueSegmentLens = z.infer<typeof CustomerValueSegmentLensSchema>

/**
 * Per-response metadata bag (v1.4 V4'5). Carries `veriscanCoverage`
 * and (v1.4 V4'6) the active `marketingSegmentLens` echo; future
 * sections (e.g. data-freshness stamps, upstream-ingest health) attach
 * here without expanding the top-level response shape.
 */
export const CustomerValueMetaSchema = z.object({
  veriscanCoverage: VeriscanCoverageSchema,
  /** Active marketing-segment lens echo (v1.4 V4'6). Always present;
   *  `selectedSegmentIds` is empty when no lens is applied. */
  marketingSegmentLens: CustomerValueSegmentLensSchema,
})
export type CustomerValueMeta = z.infer<typeof CustomerValueMetaSchema>

// =========================== Segment vs rest (v1.4 V4'7) ==================

/**
 * Window-scoped aggregates for one population (segment or rest) in the
 * "Segment vs rest" comparison band (v1.4 V4'7). Known customers only
 * (guests excluded; they cannot be segment members). All sums are over
 * non-cancelled in-window orders for the selected sites.
 *
 *   - `activeCustomers` — distinct Sweed customer_ids that placed at
 *     least one in-window order in this population.
 *   - `orders`          — in-window order count for this population.
 *   - `grossSalesDollars` / `netSalesDollars` / `grossReceiptsDollars`
 *     — summed cash money bases (same conventions as the rest of the
 *     tab). These are cheap window sums.
 *
 * Margin $ is intentionally NOT included here: per-line margin requires
 * the `sweed_package_cost_as_of_or_earliest()` lookup per item, which
 * is multi-second over a 12 month window (the documented EPIC_PLAN §9
 * "graduate to daily facts" trigger). Rather than push the interactive
 * endpoint past the latency budget, the comparison band shows the cash
 * bases now and defers the margin split to the segment facts pipeline.
 * The client derives avg basket (`<basis>$ / orders`) and orders per
 * customer (`orders / activeCustomers`) from these so it can switch the
 * cash `$ basis` options without a re-fetch.
 */
export const CustomerValuePopulationStatsSchema = z.object({
  activeCustomers: z.number().int().nonnegative(),
  orders: z.number().int().nonnegative(),
  grossSalesDollars: z.number(),
  netSalesDollars: z.number(),
  grossReceiptsDollars: z.number(),
})
export type CustomerValuePopulationStats = z.infer<typeof CustomerValuePopulationStatsSchema>

/**
 * Segment vs rest comparison (v1.4 V4'7). Present (non-null) only when
 * the marketing-segment lens is active. `segment` = members of any
 * selected segment; `rest` = known non-members. Both are over the same
 * visible window / sites, computed in a single grouped pass so the two
 * populations are disjoint and additive (no double-counting, no
 * ratio-of-averages error). `null` when no lens is applied.
 */
export const CustomerValueSegmentComparisonSchema = z.object({
  segment: CustomerValuePopulationStatsSchema,
  rest: CustomerValuePopulationStatsSchema,
})
export type CustomerValueSegmentComparison = z.infer<typeof CustomerValueSegmentComparisonSchema>

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
  /**
   * Segment vs rest comparison (v1.4 V4'7). Non-null only when the
   * marketing-segment lens is active; the client renders the
   * "Segment vs rest" headline band from it. `null` otherwise.
   */
  segmentComparison: CustomerValueSegmentComparisonSchema.nullable().default(null),
  missingDataCards: z.array(CustomerValueMissingDataCardSchema),
})
export type CustomerValueAnalyticsResponse = z.infer<typeof CustomerValueAnalyticsResponseSchema>
