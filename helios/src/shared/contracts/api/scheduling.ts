import { z } from 'zod'

import {
  DEFAULT_SCHEDULING_CANDIDATE_COUNT,
  LLMExtractedConstraintsSchema,
  NormalizedSolverInputSchema,
  ScheduleCandidateSchema,
  SchedulingCandidateCountSchema,
  SchedulingRunStatusSchema,
  SchedulingValidationIssueSchema,
  SchedulingWeekWindowSchema,
} from '../domain/scheduling.js'
import { MutationAcceptedResponseSchema } from './mutations.js'
import { JobStatusSchema } from '../domain/jobs.js'
import { JobListItemSchema } from './jobs.js'
import { AuditEventRecordSchema } from '../domain/audit.js'

const BlankStringSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
  z.string().trim().min(1).optional(),
)

export const SchedulingRunListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? undefined : value),
    SchedulingRunStatusSchema.optional(),
  ),
  search: BlankStringSchema,
})
export type SchedulingRunListQuery = z.infer<typeof SchedulingRunListQuerySchema>

export const QueueSchedulingRunRequestSchema = z.object({
  candidateCount: SchedulingCandidateCountSchema.default(DEFAULT_SCHEDULING_CANDIDATE_COUNT),
  pageOnExtractionResult: z.boolean().default(false),
  scheduleWeek: SchedulingWeekWindowSchema,
  sourceText: z.string().trim().min(20).max(20_000),
  title: z.string().trim().min(1).max(160).nullable().optional(),
})
export type QueueSchedulingRunRequest = z.infer<typeof QueueSchedulingRunRequestSchema>

export const QueueSchedulingRunAcceptedResponseSchema = MutationAcceptedResponseSchema.extend({
  schedulingRunId: z.number().int().positive(),
})
export type QueueSchedulingRunAcceptedResponse = z.infer<typeof QueueSchedulingRunAcceptedResponseSchema>

export const SchedulingRunRouteParamsSchema = z.object({
  schedulingRunId: z.coerce.number().int().positive(),
})
export type SchedulingRunRouteParams = z.infer<typeof SchedulingRunRouteParamsSchema>

export const SchedulingRunListItemSchema = z.object({
  approvedAt: z.iso.datetime().nullable(),
  approvedByUser: z.string().nullable(),
  candidateCount: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  createdByUser: z.string().nullable(),
  currentJobId: z.number().int().positive().nullable(),
  currentJobStatus: JobStatusSchema.nullable(),
  id: z.number().int().positive(),
  latestError: z.string().nullable(),
  pageOnExtractionResult: z.boolean().default(false),
  requestedCandidateCount: SchedulingCandidateCountSchema,
  scheduleWeek: SchedulingWeekWindowSchema.nullable(),
  selectedCandidateId: z.number().int().positive().nullable(),
  sourceTextPreview: z.string(),
  status: SchedulingRunStatusSchema,
  title: z.string(),
  validationIssues: z.array(SchedulingValidationIssueSchema),
})
export type SchedulingRunListItem = z.infer<typeof SchedulingRunListItemSchema>

export const SchedulingRunListResponseSchema = z.object({
  filters: SchedulingRunListQuerySchema,
  items: z.array(SchedulingRunListItemSchema),
  totalCount: z.number().int().min(0),
})
export type SchedulingRunListResponse = z.infer<typeof SchedulingRunListResponseSchema>

export const SchedulingCandidateRecordSchema = z.object({
  id: z.number().int().positive(),
  rank: z.number().int().min(1),
  schedule: ScheduleCandidateSchema,
})
export type SchedulingCandidateRecord = z.infer<typeof SchedulingCandidateRecordSchema>

export const SchedulingRunQueueWaitingReasonSchema = z.enum([
  'no_current_job',
  'not_queued',
  'running',
  'scheduled_for_future',
  'queued_behind_other_jobs',
  'waiting_for_worker',
])
export type SchedulingRunQueueWaitingReason = z.infer<typeof SchedulingRunQueueWaitingReasonSchema>

export const SchedulingRunQueueDebugSchema = z.object({
  blockingJobs: z.array(JobListItemSchema),
  currentTime: z.iso.datetime(),
  eligibleToRun: z.boolean(),
  queueAheadCount: z.number().int().min(0),
  runningJobCount: z.number().int().min(0),
  waitingReason: SchedulingRunQueueWaitingReasonSchema,
})
export type SchedulingRunQueueDebug = z.infer<typeof SchedulingRunQueueDebugSchema>

export const SchedulingRunDebugSchema = z.object({
  currentJob: JobListItemSchema.nullable(),
  queue: SchedulingRunQueueDebugSchema,
  recentEvents: z.array(AuditEventRecordSchema),
  relatedJobs: z.array(JobListItemSchema),
})
export type SchedulingRunDebug = z.infer<typeof SchedulingRunDebugSchema>

export const SchedulingRunDetailResponseSchema = z.object({
  debug: SchedulingRunDebugSchema,
  run: SchedulingRunListItemSchema.extend({
    extractedConstraints: LLMExtractedConstraintsSchema.nullable(),
    normalizedInput: NormalizedSolverInputSchema.nullable(),
    sourceText: z.string(),
  }),
  candidates: z.array(SchedulingCandidateRecordSchema),
})
export type SchedulingRunDetailResponse = z.infer<typeof SchedulingRunDetailResponseSchema>

export const SaveSchedulingNormalizedInputRequestSchema = z.object({
  normalizedInput: NormalizedSolverInputSchema,
})
export type SaveSchedulingNormalizedInputRequest = z.infer<typeof SaveSchedulingNormalizedInputRequestSchema>

export const QueueSchedulingCandidateGenerationRequestSchema = z.object({
  reason: z.string().trim().max(500).nullable().optional(),
})
export type QueueSchedulingCandidateGenerationRequest = z.infer<typeof QueueSchedulingCandidateGenerationRequestSchema>

export const QueueSchedulingCandidateGenerationAcceptedResponseSchema = MutationAcceptedResponseSchema.extend({
  schedulingRunId: z.number().int().positive(),
})
export type QueueSchedulingCandidateGenerationAcceptedResponse = z.infer<typeof QueueSchedulingCandidateGenerationAcceptedResponseSchema>

export const SelectSchedulingCandidateRequestSchema = z.object({
  candidateId: z.number().int().positive(),
})
export type SelectSchedulingCandidateRequest = z.infer<typeof SelectSchedulingCandidateRequestSchema>
