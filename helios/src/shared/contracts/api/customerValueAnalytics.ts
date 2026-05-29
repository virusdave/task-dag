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
// follow-on once the per-order margin can be joined cheaply. The SPA
// renders an explicit MISSING DATA card for the margin variants.
// ---------------------------------------------------------------------------

const csvList = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').filter((s) => s.length > 0) : []))

export const CustomerValueAnalyticsRequestSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  sites: csvList,
  maxPurchaseNumber: z.coerce.number().int().min(2).max(50).optional(),
  cohortScope: z.enum(['all_as_of_end', 'active_in_range', 'acquired_in_range']).optional(),
})
export type CustomerValueAnalyticsRequest = z.infer<typeof CustomerValueAnalyticsRequestSchema>

// =========================== Summary KPIs ==================================

export const CustomerValueSummarySchema = z.object({
  knownCustomers: z.number().int().nonnegative(),
  totalOrders: z.number().int().nonnegative(),
  firstPurchases: z.number().int().nonnegative(),
  repeatPurchases: z.number().int().nonnegative(),
  repeatPurchaseRate: z.number().nullable(),
  observedAvgLtvGrossDollars: z.number().nullable(),
  observedMedianLtvGrossDollars: z.number().nullable(),
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
  summary: CustomerValueSummarySchema,
  purchaseCountHistogram: z.array(PurchaseCountBucketSchema),
  basketByPurchaseNumber: z.array(BasketByPurchaseNumberPointSchema),
  lifetimeByTotalPurchases: z.array(LifetimeByTotalPurchasesPointSchema),
  contributionByPurchaseNumber: z.array(ContributionByPurchaseNumberPointSchema),
  missingDataCards: z.array(CustomerValueMissingDataCardSchema),
})
export type CustomerValueAnalyticsResponse = z.infer<typeof CustomerValueAnalyticsResponseSchema>
