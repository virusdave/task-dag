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
// Phase 1 of this tab is header-grain (orders only): basket size, value /
// customer, repeat rate, discount rate, and fulfillment-channel affinity.
// Margin/customer and category/subcategory affinity arrive once the
// per-customer daily fact rollups land (EPIC_PLAN.md §4). See
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
  dataQuality: z.array(z.string()),
})
export type CrmSegmentAnalysisResponse = z.infer<typeof CrmSegmentAnalysisResponseSchema>
