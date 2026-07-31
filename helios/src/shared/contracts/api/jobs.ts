import { z } from 'zod'

import {
  JobExecutionPoolSchema,
  JobLinkedRecordRefsSchema,
  JobLogEntrySchema,
  JobModuleMetadataSchema,
  JobPriorityBandSchema,
  JobProgressSchema,
  JobStatusSchema,
  JobTypeSchema,
} from '../domain/jobs.js'
import { HeliosModuleCodeSchema } from '../domain/modules.js'
import { SweedAuthEventSchema } from './sweedAuthEvents.js'
import { TradeSampleStageResultSchema, TradeSampleZeroResultSchema } from './tradeSampleZero.js'

export const JobRouteParamsSchema = z.object({
  jobId: z.coerce.number().int().positive(),
})
export type JobRouteParams = z.infer<typeof JobRouteParamsSchema>

// Form GETs on /jobs send blank-but-present fields like `status=` and
// `jobType=` when the operator clears a filter. Treat those as "no
// filter" instead of rejecting the request with a validation error.
const emptyToUndefined = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.unknown(),
)

export const JobsQuerySchema = z.object({
  beforeRunAt: emptyToUndefined.pipe(z.string().optional()),
  jobType: emptyToUndefined.pipe(z.string().trim().min(1).optional()),
  module: emptyToUndefined.pipe(HeliosModuleCodeSchema.optional()),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  pool: emptyToUndefined.pipe(JobExecutionPoolSchema.optional()),
  priorityBand: emptyToUndefined.pipe(JobPriorityBandSchema.optional()),
  scopeEntityId: emptyToUndefined.pipe(z.string().trim().min(1).optional()),
  scopeEntityType: emptyToUndefined.pipe(z.string().trim().min(1).optional()),
  status: emptyToUndefined.pipe(JobStatusSchema.optional()),
})
export type JobsQuery = z.infer<typeof JobsQuerySchema>

export const JobListItemSchema = z.object({
  attemptCount: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  executionPool: JobExecutionPoolSchema,
  finishedAt: z.iso.datetime().nullable(),
  jobId: z.number().int().positive(),
  jobType: JobTypeSchema,
  lastError: z.string().nullable(),
  module: JobModuleMetadataSchema.shape.module,
  priority: z.number().int(),
  priorityBand: JobPriorityBandSchema,
  requestedByLabel: z.string().nullable(),
  requestedByUserId: z.number().int().positive().nullable(),
  runAt: z.iso.datetime(),
  scope: JobModuleMetadataSchema.shape.scope,
  startedAt: z.iso.datetime().nullable(),
  status: JobStatusSchema,
})
export type JobListItem = z.infer<typeof JobListItemSchema>

export const JobsResponseSchema = z.object({
  filters: JobsQuerySchema,
  items: z.array(JobListItemSchema),
  nextCursor: z.string().nullable(),
})
export type JobsResponse = z.infer<typeof JobsResponseSchema>

export const JobStatusResponseSchema = z.object({
  job: z.object({
    attemptCount: z.number().int().min(0),
    createdAt: z.iso.datetime(),
    executionPool: JobExecutionPoolSchema,
    finishedAt: z.iso.datetime().nullable(),
    jobId: z.number().int().positive(),
    jobType: JobTypeSchema,
    lastError: z.string().nullable(),
    module: JobModuleMetadataSchema.shape.module,
    priority: z.number().int(),
    priorityBand: JobPriorityBandSchema,
    requestedByLabel: z.string().nullable(),
    requestedByUserId: z.number().int().positive().nullable(),
    runAt: z.iso.datetime(),
    scope: JobModuleMetadataSchema.shape.scope,
    startedAt: z.iso.datetime().nullable(),
    status: JobStatusSchema,
  }),
  linkedRecords: JobLinkedRecordRefsSchema,
  progressLog: z.array(JobLogEntrySchema),
  progress: JobProgressSchema.nullable(),
  // Every Sweed JSON-RPC this job's worker process logged for this
  // job: every login/logout/dealer-set/initial-data call, plus every
  // failed RPC (auth-looking or otherwise). Always present; empty
  // array means either the job hasn't touched Sweed yet or migration
  // 011_sweed_auth_events hasn't been applied. Ordered oldest-first
  // so the UI can render a chronological timeline.
  sweedAuthEvents: z.array(SweedAuthEventSchema),
  tradeSampleZeroResult: TradeSampleZeroResultSchema.nullable(),
  tradeSampleStageResult: TradeSampleStageResultSchema.nullable(),
})
export type JobStatusResponse = z.infer<typeof JobStatusResponseSchema>

export const TradeSampleRecentStageJobQuerySchema = z.object({
  siteDealerId: z.coerce.number().int().positive(),
})
export const TradeSampleRecentStageJobResponseSchema = z.object({
  stageJob: JobStatusResponseSchema.nullable(),
})
export type TradeSampleRecentStageJobResponse = z.infer<typeof TradeSampleRecentStageJobResponseSchema>

/**
 * Live queue dashboard snapshot. Backs `/api/jobs/queue-metrics`,
 * polled by the Jobs page every ~10s.
 *
 * `cells` is a fully-populated pool × priority-band matrix (zero rows
 * present for empty cells) so the UI can render a stable grid.
 */
export const JobQueueMetricsCellSchema = z.object({
  pool: JobExecutionPoolSchema,
  priorityBand: JobPriorityBandSchema,
  /** queued + run_at <= now() — the actual "waiting" count. */
  readyCount: z.number().int().nonnegative(),
  /** queued + run_at > now() (future-scheduled retries / delays). */
  scheduledCount: z.number().int().nonnegative(),
  /** runtime status='running' in this pool/band. */
  runningCount: z.number().int().nonnegative(),
  /** max(now() - run_at) over ready jobs; null if readyCount=0. */
  oldestReadyWaitSeconds: z.number().int().nonnegative().nullable(),
  /** p50(now() - run_at) over ready jobs; null if readyCount=0. */
  p50ReadyWaitSeconds: z.number().int().nonnegative().nullable(),
  /** p95(now() - run_at) over ready jobs; null if readyCount=0. */
  p95ReadyWaitSeconds: z.number().int().nonnegative().nullable(),
  /** Front-of-queue job pointer; lets the cell link straight to it. */
  oldestReadyJob: z
    .object({
      jobId: z.number().int().positive(),
      jobType: JobTypeSchema,
      runAt: z.iso.datetime(),
      priority: z.number().int(),
    })
    .nullable(),
})
export type JobQueueMetricsCell = z.infer<typeof JobQueueMetricsCellSchema>

export const JobQueueMetricsPoolHealthSchema = z.object({
  pool: JobExecutionPoolSchema,
  runningCount: z.number().int().nonnegative(),
  readyTotal: z.number().int().nonnegative(),
  scheduledTotal: z.number().int().nonnegative(),
  oldestRunningSeconds: z.number().int().nonnegative().nullable(),
  runningOverOneHourCount: z.number().int().nonnegative(),
  expiredLeaseCount: z.number().int().nonnegative(),
  oldestRunningJob: z
    .object({
      jobId: z.number().int().positive(),
      jobType: JobTypeSchema,
      startedAt: z.iso.datetime(),
    })
    .nullable(),
})
export type JobQueueMetricsPoolHealth = z.infer<typeof JobQueueMetricsPoolHealthSchema>

export const JobQueueMetricsAlertsSchema = z.object({
  deadLetterLast24h: z.number().int().nonnegative(),
  failedLast1h: z.number().int().nonnegative(),
  expiredLeaseCount: z.number().int().nonnegative(),
})
export type JobQueueMetricsAlerts = z.infer<typeof JobQueueMetricsAlertsSchema>

export const JobQueueMetricsResponseSchema = z.object({
  generatedAt: z.iso.datetime(),
  cells: z.array(JobQueueMetricsCellSchema),
  pools: z.array(JobQueueMetricsPoolHealthSchema),
  alerts: JobQueueMetricsAlertsSchema,
})
export type JobQueueMetricsResponse = z.infer<typeof JobQueueMetricsResponseSchema>
