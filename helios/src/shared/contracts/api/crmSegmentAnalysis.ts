import { z } from 'zod'

import { SegmentIdentitySchema } from './marketingSegments.js'

// API contract for the CRM "Segment Analysis" metrics tab
// (/metrics/crm-segment-analysis, virusdave/top-level#12).
//
// "How is this segment different?" — segment-vs-REST comparison (rest =
// everyone − segment, the honest baseline), with "everyone" shown as
// context. Each comparable metric carries an absolute delta, a lift/index
// (segment ÷ rest), and a significance badge computed by segmentStats.ts
// (two-proportion z for rates/shares, Welch for means, Benjamini-Hochberg
// across the channel family).
//
// Metrics: basket size, net sales / customer, orders / customer, repeat
// rate, discount rate, margin / customer, gross-margin %, plus
// fulfillment-channel, category, and subcategory affinity. Margin rides
// the invoice-grain analytics_invoice_margin_facts rollup (precomputed
// COGS); subcategory rides the Helios catalog taxonomy. See
// server/crmSegmentMetrics/crmSegmentAnalysisQueries.ts.

export const CrmSegmentAnalysisRequestSchema = z.object({
  segmentId: z.coerce.number().int().positive(),
  sites: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v): string[] =>
      v === undefined ? [] : Array.isArray(v) ? v : v.split(',').map((s) => s.trim()).filter(Boolean),
    ),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
})
export type CrmSegmentAnalysisRequest = z.infer<typeof CrmSegmentAnalysisRequestSchema>

export const CrmConfidenceLabelSchema = z.enum([
  'strong',
  'notable',
  'directional',
  'too_small',
])
export type CrmConfidenceLabel = z.infer<typeof CrmConfidenceLabelSchema>

export const CrmMetricUnitSchema = z.enum(['money', 'count', 'rate', 'ratio'])
export type CrmMetricUnit = z.infer<typeof CrmMetricUnitSchema>

// One comparison row. `everyone` is context; significance is segment-vs-rest.
export const CrmComparisonMetricSchema = z.object({
  key: z.string(),
  label: z.string(),
  unit: CrmMetricUnitSchema,
  help: z.string(),
  segment: z.number().nullable(),
  rest: z.number().nullable(),
  everyone: z.number().nullable(),
  deltaVsRest: z.number().nullable(),
  indexVsRest: z.number().nullable(),
  pValue: z.number().nullable(),
  confidence: CrmConfidenceLabelSchema,
})
export type CrmComparisonMetric = z.infer<typeof CrmComparisonMetricSchema>

export const CrmPopulationSummarySchema = z.object({
  customers: z.number().int().nonnegative(),
  orders: z.number().int().nonnegative(),
  netSalesDollars: z.number(),
  grossReceiptsDollars: z.number(),
})
export type CrmPopulationSummary = z.infer<typeof CrmPopulationSummarySchema>

export const CrmChannelAffinityRowSchema = z.object({
  channel: z.string(),
  segmentShare: z.number().nullable(),
  restShare: z.number().nullable(),
  everyoneShare: z.number().nullable(),
  deltaPp: z.number().nullable(),
  index: z.number().nullable(),
  pValue: z.number().nullable(),
  qValue: z.number().nullable(),
  confidence: CrmConfidenceLabelSchema,
})
export type CrmChannelAffinityRow = z.infer<typeof CrmChannelAffinityRowSchema>

// Category affinity: customer PENETRATION (share of a population's active
// customers who bought the category) segment-vs-rest, the most actionable
// "what's different" signal. Two-proportion z + BH-FDR across categories.
export const CrmCategoryAffinityRowSchema = z.object({
  category: z.string(),
  segmentBuyers: z.number().int().nonnegative(),
  restBuyers: z.number().int().nonnegative(),
  segmentPenetration: z.number().nullable(),
  restPenetration: z.number().nullable(),
  everyonePenetration: z.number().nullable(),
  deltaPp: z.number().nullable(),
  index: z.number().nullable(),
  // Category's share of the SEGMENT's line revenue (context for materiality).
  segmentRevenueShare: z.number().nullable(),
  pValue: z.number().nullable(),
  qValue: z.number().nullable(),
  confidence: CrmConfidenceLabelSchema,
})
export type CrmCategoryAffinityRow = z.infer<typeof CrmCategoryAffinityRowSchema>

// Subcategory affinity: same customer-PENETRATION comparison as category,
// one level finer. Subcategory is NOT on the Sweed order line (its
// productCategory is just {id,name}); it comes from the Helios catalog
// taxonomy (catalog_groups.subcategory_name) joined on the line's
// product_id. Same two-proportion z + BH-FDR treatment as category.
export const CrmSubcategoryAffinityRowSchema = z.object({
  subcategory: z.string(),
  segmentBuyers: z.number().int().nonnegative(),
  restBuyers: z.number().int().nonnegative(),
  segmentPenetration: z.number().nullable(),
  restPenetration: z.number().nullable(),
  everyonePenetration: z.number().nullable(),
  deltaPp: z.number().nullable(),
  index: z.number().nullable(),
  segmentRevenueShare: z.number().nullable(),
  pValue: z.number().nullable(),
  qValue: z.number().nullable(),
  confidence: CrmConfidenceLabelSchema,
})
export type CrmSubcategoryAffinityRow = z.infer<typeof CrmSubcategoryAffinityRowSchema>

export const CrmSegmentAnalysisResponseSchema = z.object({
  segment: SegmentIdentitySchema,
  window: z.object({ from: z.iso.datetime(), to: z.iso.datetime() }),
  scope: z.object({ siteKeys: z.array(z.string()), dealerIds: z.array(z.number().int()) }),
  populations: z.object({
    segment: CrmPopulationSummarySchema,
    rest: CrmPopulationSummarySchema,
    everyone: CrmPopulationSummarySchema,
  }),
  // Segment's share within everyone, and the headline value index
  // (sales-share ÷ customer-share).
  shares: z.object({
    customerShare: z.number().nullable(),
    netSalesShare: z.number().nullable(),
    valueIndex: z.number().nullable(),
  }),
  metrics: z.array(CrmComparisonMetricSchema),
  channelAffinity: z.array(CrmChannelAffinityRowSchema),
  categoryAffinity: z.array(CrmCategoryAffinityRowSchema),
  subcategoryAffinity: z.array(CrmSubcategoryAffinityRowSchema),
  dataQuality: z.array(z.string()),
})
export type CrmSegmentAnalysisResponse = z.infer<typeof CrmSegmentAnalysisResponseSchema>
