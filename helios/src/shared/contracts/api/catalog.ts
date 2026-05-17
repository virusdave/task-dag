import { z } from 'zod'

import { JsonValueSchema } from '../common/json.js'
import { CatalogGroupSummarySchema } from '../domain/catalog.js'
import { PendingPurchaseMarketListingSchema } from '../domain/pendingPurchases.js'
import { ProposalLineItemSchema } from '../domain/proposals.js'

export const CatalogBrowserQuerySchema = z.object({
  brand: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  reconcileStatus: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).optional(),
  subcategory: z.string().trim().min(1).optional(),
})
export type CatalogBrowserQuery = z.infer<typeof CatalogBrowserQuerySchema>

export const RecentSalesSummarySchema = z.object({
  combinationCount: z.number().int().min(0),
  coverageCount: z.number().int().min(0),
  daysPerUnit: z.number().positive().nullable(),
  last30DaysGrossSales: z.number().min(0).nullable(),
  onHand: z.number().min(0).nullable(),
  reportDate: z.iso.datetime().nullable(),
  unitsPerDay: z.number().min(0).nullable(),
})
export type RecentSalesSummary = z.infer<typeof RecentSalesSummarySchema>

export const GroupRecentSalesProductRowSchema = z.object({
  daysPerUnit: z.number().positive().nullable(),
  hasCoverage: z.boolean(),
  last30DaysGrossSales: z.number().min(0).nullable(),
  onHand: z.number().min(0).nullable(),
  productId: z.number().int().positive(),
  productName: z.string(),
  productTab: z.string(),
  reportDate: z.iso.datetime().nullable(),
  siteDealerId: z.number().int().positive(),
  siteKey: z.string().min(1),
  siteLabel: z.string().min(1),
  unitsPerDay: z.number().min(0).nullable(),
})
export type GroupRecentSalesProductRow = z.infer<typeof GroupRecentSalesProductRowSchema>

export const GroupRecentSalesSchema = z.object({
  productRows: z.array(GroupRecentSalesProductRowSchema),
  reportSource: z.literal('store.reports.reorder'),
  sites: z.array(
    z.object({
      siteDealerId: z.number().int().positive(),
      siteKey: z.string().min(1),
      siteLabel: z.string().min(1),
      summary: RecentSalesSummarySchema,
    }),
  ),
  summary: RecentSalesSummarySchema,
})
export type GroupRecentSales = z.infer<typeof GroupRecentSalesSchema>

export const CatalogBrowserItemSchema = CatalogGroupSummarySchema.extend({
  activeDesiredFieldCount: z.number().int().min(0),
  approvedLineItemCount: z.number().int().min(0),
  pendingLineItemCount: z.number().int().min(0),
  recentSales: RecentSalesSummarySchema,
})
export type CatalogBrowserItem = z.infer<typeof CatalogBrowserItemSchema>

export const CatalogBrowserResponseSchema = z.object({
  filters: CatalogBrowserQuerySchema,
  items: z.array(CatalogBrowserItemSchema),
  recentSalesIssue: z.string().nullable().optional(),
  totalCount: z.number().int().min(0),
})
export type CatalogBrowserResponse = z.infer<typeof CatalogBrowserResponseSchema>

export const CatalogGroupRouteParamsSchema = z.object({
  catalogGroupId: z.coerce.number().int().positive(),
})
export type CatalogGroupRouteParams = z.infer<typeof CatalogGroupRouteParamsSchema>

export const GroupProductMarketEvidenceSchema = z.object({
  productId: z.number().int().positive(),
  productName: z.string(),
  productTab: z.string().nullable(),
  livePrice: z.number().nullable(),
  capturedAt: z.iso.datetime().nullable(),
  freshness: z.enum(['fresh', 'stale', 'very_stale', 'expired', 'absent']),
  ageDays: z.number().nullable(),
  availability: z.string().nullable(),
  searchTermLabel: z.string().nullable(),
  notes: z.string().nullable(),
  brandName: z.string().nullable(),
  listingCount: z.number().int().min(0),
  eligibleListingCount: z.number().int().min(0),
  averagePostTaxPrice: z.number().nullable(),
  medianPostTaxPrice: z.number().nullable(),
  matchedListings: z.array(PendingPurchaseMarketListingSchema),
})
export type GroupProductMarketEvidence = z.infer<typeof GroupProductMarketEvidenceSchema>

export const GroupDetailResponseSchema = z.object({
  desiredState: z.array(
    z.object({
      active: z.boolean(),
      createdAt: z.iso.datetime(),
      desiredValue: JsonValueSchema,
      fieldPath: z.string(),
      paused: z.boolean(),
      revisionId: z.number().int().positive(),
      targetEntityId: z.number().int().positive(),
      targetEntityType: z.string(),
    }),
  ),
  group: z.object({
    brandName: z.string().nullable(),
    catalogGroupId: z.number().int().positive(),
    categoryName: z.string().nullable(),
    driftedAt: z.iso.datetime().nullable(),
    groupName: z.string(),
    lastSyncedAt: z.iso.datetime(),
    reconcileStatus: z.string(),
    strainName: z.string().nullable(),
    subcategoryName: z.string().nullable(),
    sweedGroupId: z.number().int().positive(),
  }),
  liveSnapshot: z.object({
    createdAt: z.iso.datetime(),
    snapshotId: z.number().int().positive(),
    source: z.string(),
    stateJson: JsonValueSchema,
  }).nullable(),
  marketEvidence: z.array(GroupProductMarketEvidenceSchema),
  recentSales: GroupRecentSalesSchema,
  recentSalesIssue: z.string().nullable().optional(),
  llmRuns: z.array(
    z.object({
      createdAt: z.iso.datetime(),
      forcedRefresh: z.boolean(),
      llmRunId: z.number().int().positive(),
      model: z.string(),
      promptVersion: z.string(),
      purpose: z.string(),
      status: z.string(),
      validationIssues: JsonValueSchema,
    }),
  ),
  proposalRows: z.array(
    z.object({
      createdAt: z.iso.datetime(),
      lineItems: z.array(ProposalLineItemSchema),
      proposalBatchId: z.number().int().positive(),
      proposalRowId: z.number().int().positive(),
      rowTitle: z.string(),
    }),
  ),
  recentAuditEvents: z.array(
    z.object({
      actorLabel: z.string(),
      createdAt: z.iso.datetime(),
      eventId: z.number().int().positive(),
      eventType: z.string(),
      undoStatus: z.string().nullable(),
    }),
  ),
  recentJobs: z.array(
    z.object({
      createdAt: z.iso.datetime(),
      finishedAt: z.iso.datetime().nullable(),
      jobId: z.number().int().positive(),
      jobType: z.string(),
      lastError: z.string().nullable(),
      runAt: z.iso.datetime(),
      startedAt: z.iso.datetime().nullable(),
      status: z.string(),
    }),
  ),
  writeOperations: z.array(
    z.object({
      createdAt: z.iso.datetime(),
      error: z.string().nullable(),
      finishedAt: z.iso.datetime().nullable(),
      operationType: z.string(),
      postWriteSnapshotId: z.number().int().positive().nullable(),
      preWriteSnapshotId: z.number().int().positive().nullable(),
      startedAt: z.iso.datetime().nullable(),
      status: z.string(),
      writeOperationId: z.number().int().positive(),
    }),
  ),
})
export type GroupDetailResponse = z.infer<typeof GroupDetailResponseSchema>
