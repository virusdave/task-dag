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

export const ConfigBackgroundTaskDetailResponseSchema = z.object({
  schedule: ConfigWorkerScheduleSchema,
  recentSnapshots: z.array(
    z.object({
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
    }),
  ),
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
