import { z } from 'zod'

// API contract for the SEO metrics dashboard (P5 — the GA4/GSC feedback
// loop). Read-only views over the imported Search Console daily facts:
// top queries, top pages, and recent import provenance for a site + window.
//
// child FreshlyBakedNYC/automation#44 (P5) · Satisfies: virusdave/top-level#15

export const SeoMetricsQueryAggregateSchema = z.object({
  query: z.string(),
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  avgPosition: z.number().nullable(),
})
export type SeoMetricsQueryAggregate = z.infer<typeof SeoMetricsQueryAggregateSchema>

export const SeoMetricsPageAggregateSchema = z.object({
  pageUrl: z.string(),
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  avgPosition: z.number().nullable(),
})
export type SeoMetricsPageAggregate = z.infer<typeof SeoMetricsPageAggregateSchema>

export const SeoMetricsImportBatchSchema = z.object({
  importBatchId: z.string(),
  source: z.string(),
  property: z.string(),
  site: z.string(),
  status: z.string(),
  rowsInserted: z.number(),
  rowsUpdated: z.number(),
  rowsUnchanged: z.number(),
  rowsRejected: z.number(),
  exportStartDate: z.string().nullable(),
  exportEndDate: z.string().nullable(),
  createdAt: z.string(),
})
export type SeoMetricsImportBatch = z.infer<typeof SeoMetricsImportBatchSchema>

export const SeoMetricsOverviewResponseSchema = z.object({
  site: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  topQueries: z.array(SeoMetricsQueryAggregateSchema),
  topPages: z.array(SeoMetricsPageAggregateSchema),
  recentImports: z.array(SeoMetricsImportBatchSchema),
})
export type SeoMetricsOverviewResponse = z.infer<typeof SeoMetricsOverviewResponseSchema>
