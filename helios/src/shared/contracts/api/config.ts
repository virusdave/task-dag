import { z } from 'zod'

import {
  ConfigBackgroundTaskKeySchema,
  ConfigWorkerScheduleSchema,
  ConfigWorkerScheduleWindowSchema,
} from '../domain/config.js'

export const ConfigBackgroundTasksListResponseSchema = z.object({
  schedules: z.array(ConfigWorkerScheduleSchema),
})
export type ConfigBackgroundTasksListResponse = z.infer<typeof ConfigBackgroundTasksListResponseSchema>

const RecentStockSnapshotSchema = z.object({
  id: z.number().int().positive(),
  siteDealerId: z.number().int(),
  siteKey: z.string(),
  siteLabel: z.string(),
  status: z.enum(['running', 'succeeded', 'failed']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  variantCount: z.number().int().min(0).nullable(),
  inStockVariantCount: z.number().int().min(0).nullable(),
  newlyInStockVariantCount: z.number().int().min(0).nullable(),
  newlyOutOfStockVariantCount: z.number().int().min(0).nullable(),
  litalertsRefreshEnqueuedCount: z.number().int().min(0).nullable(),
  jobId: z.number().int().positive().nullable(),
  error: z.string().nullable(),
})
export type RecentStockSnapshot = z.infer<typeof RecentStockSnapshotSchema>

const RecentLitalertsObservationSchema = z.object({
  id: z.number().int().positive(),
  queueRowId: z.number().int().positive().nullable(),
  productId: z.number().int().positive(),
  siteDealerId: z.number().int().nullable(),
  sourceSnapshotId: z.number().int().positive().nullable(),
  jobId: z.number().int().positive().nullable(),
  status: z.enum(['succeeded', 'failed']),
  brandId: z.number().int().nullable(),
  brandName: z.string().nullable(),
  groupId: z.number().int().nullable(),
  groupName: z.string().nullable(),
  categoryName: z.string().nullable(),
  searchTermLabel: z.string().nullable(),
  availability: z.string().nullable(),
  listingCount: z.number().int().min(0),
  pricingEligibleListingCount: z.number().int().min(0),
  nearListingCount: z.number().int().min(0),
  midListingCount: z.number().int().min(0),
  farListingCount: z.number().int().min(0),
  notes: z.string().nullable(),
  error: z.string().nullable(),
  capturedAt: z.string(),
})
export type RecentLitalertsObservation = z.infer<typeof RecentLitalertsObservationSchema>

const PendingLitalertsRefreshSchema = z.object({
  id: z.number().int().positive(),
  productId: z.number().int().positive(),
  siteDealerId: z.number().int().nullable(),
  reason: z.enum(['variant_in_stock_transition', 'manual', 'daily_full_sweep']),
  sourceSnapshotId: z.number().int().positive().nullable(),
  enqueuedAt: z.string(),
  notes: z.string().nullable(),
})
export type PendingLitalertsRefresh = z.infer<typeof PendingLitalertsRefreshSchema>

const RecentCatalogTaxonomySnapshotSchema = z.object({
  id: z.number().int().positive(),
  stateDealerId: z.number().int(),
  jobId: z.number().int().positive().nullable(),
  status: z.enum(['running', 'succeeded', 'failed']),
  trigger: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  productCount: z.number().int().min(0).nullable(),
  groupCount: z.number().int().min(0).nullable(),
  categoryCount: z.number().int().min(0).nullable(),
  subcategoryCount: z.number().int().min(0).nullable(),
  brandCount: z.number().int().min(0).nullable(),
  strainCount: z.number().int().min(0).nullable(),
  prevalenceCount: z.number().int().min(0).nullable(),
  sizeCount: z.number().int().min(0).nullable(),
  distributorCount: z.number().int().min(0).nullable(),
  error: z.string().nullable(),
})
export type RecentCatalogTaxonomySnapshot = z.infer<typeof RecentCatalogTaxonomySnapshotSchema>

const SweedOrdersIngestDealerStatusSchema = z.object({
  dealerId: z.number().int().positive(),
  siteKey: z.string().nullable(),
  siteLabel: z.string().nullable(),
  highwaterPayTime: z.string(),
  minPayTime: z.string(),
  backfillCursorDay: z.string().nullable(),
  lastPolledAt: z.string(),
  lastSeenCount: z.number().int().min(0),
  lastInsertedCount: z.number().int().min(0),
  consecutiveEmptyPolls: z.number().int().min(0),
  notes: z.string().nullable(),
  orderRowCount: z.number().int().min(0),
  earliestOrderPayTime: z.string().nullable(),
  latestOrderPayTime: z.string().nullable(),
})
export type SweedOrdersIngestDealerStatus = z.infer<typeof SweedOrdersIngestDealerStatusSchema>

const RecentSweedOrdersIngestRunSchema = z.object({
  jobId: z.number().int().positive(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'dead_letter']),
  runAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  attemptCount: z.number().int().min(0),
  trigger: z.string().nullable(),
  error: z.string().nullable(),
})
export type RecentSweedOrdersIngestRun = z.infer<typeof RecentSweedOrdersIngestRunSchema>

export const ConfigBackgroundTaskDetailResponseSchema = z.object({
  schedule: ConfigWorkerScheduleSchema,
  recentSnapshots: z.array(RecentStockSnapshotSchema),
  litalerts: z
    .object({
      pendingQueueDepth: z.number().int().min(0),
      pendingQueueSample: z.array(PendingLitalertsRefreshSchema),
      recentObservations: z.array(RecentLitalertsObservationSchema),
    })
    .nullable(),
  catalog: z
    .object({
      recentSnapshots: z.array(RecentCatalogTaxonomySnapshotSchema),
    })
    .nullable(),
  sweedOrdersIngest: z
    .object({
      dealers: z.array(SweedOrdersIngestDealerStatusSchema),
      recentRuns: z.array(RecentSweedOrdersIngestRunSchema),
    })
    .nullable(),
})
export type ConfigBackgroundTaskDetailResponse = z.infer<typeof ConfigBackgroundTaskDetailResponseSchema>

export const ConfigBackgroundTaskScheduleUpdateRequestSchema = z.object({
  taskKey: ConfigBackgroundTaskKeySchema,
  windows: z.array(
    ConfigWorkerScheduleWindowSchema.omit({ id: true }).extend({
      id: z.number().int().positive().nullable().optional(),
    }),
  ),
})
export type ConfigBackgroundTaskScheduleUpdateRequest = z.infer<typeof ConfigBackgroundTaskScheduleUpdateRequestSchema>

export const ConfigBackgroundTaskRunNowRequestSchema = z.object({
  taskKey: ConfigBackgroundTaskKeySchema,
})
export type ConfigBackgroundTaskRunNowRequest = z.infer<typeof ConfigBackgroundTaskRunNowRequestSchema>

export const ConfigBackgroundTaskRunNowResponseSchema = z.object({
  jobId: z.number().int().positive(),
})
export type ConfigBackgroundTaskRunNowResponse = z.infer<typeof ConfigBackgroundTaskRunNowResponseSchema>
