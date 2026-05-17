import { z } from 'zod'

import { JobLinkedRecordRefsSchema, JobLogEntrySchema, JobModuleMetadataSchema, JobProgressSchema, JobStatusSchema, JobTypeSchema } from '../domain/jobs.js'
import { HeliosModuleCodeSchema } from '../domain/modules.js'
import { SweedAuthEventSchema } from './sweedAuthEvents.js'

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
  scopeEntityId: emptyToUndefined.pipe(z.string().trim().min(1).optional()),
  scopeEntityType: emptyToUndefined.pipe(z.string().trim().min(1).optional()),
  status: emptyToUndefined.pipe(JobStatusSchema.optional()),
})
export type JobsQuery = z.infer<typeof JobsQuerySchema>

export const JobListItemSchema = z.object({
  attemptCount: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  jobId: z.number().int().positive(),
  jobType: JobTypeSchema,
  lastError: z.string().nullable(),
  module: JobModuleMetadataSchema.shape.module,
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
    finishedAt: z.iso.datetime().nullable(),
    jobId: z.number().int().positive(),
    jobType: JobTypeSchema,
    lastError: z.string().nullable(),
    module: JobModuleMetadataSchema.shape.module,
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
})
export type JobStatusResponse = z.infer<typeof JobStatusResponseSchema>
