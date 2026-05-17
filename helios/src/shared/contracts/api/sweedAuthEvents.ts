import { z } from 'zod'

// Mirrors the worker-side SweedAuthEventKind union; kept in lock-step
// with helios/src/worker/sweed/authLog.ts.
export const SweedAuthEventKindSchema = z.enum([
  'login',
  'logout',
  'dealer_set',
  'initial_data',
  'rpc_auth_error',
])
export type SweedAuthEventKind = z.infer<typeof SweedAuthEventKindSchema>

export const SweedAuthEventOutcomeSchema = z.enum(['ok', 'error', 'retryable'])
export type SweedAuthEventOutcome = z.infer<typeof SweedAuthEventOutcomeSchema>

export const SweedAuthEventSchema = z.object({
  id: z.coerce.number().int(),
  createdAt: z.string(),
  jobId: z.coerce.number().int().nullable(),
  jobType: z.string().nullable(),
  rpcName: z.string(),
  eventKind: SweedAuthEventKindSchema,
  sessionOrigin: z.enum(['fresh', 'legacy']).nullable(),
  authTokenPrefix: z.string().nullable(),
  dealerId: z.coerce.number().int().nullable(),
  outcome: SweedAuthEventOutcomeSchema,
  httpStatus: z.number().int().nullable(),
  errorMessage: z.string().nullable(),
  durationMs: z.number().int(),
  context: z.record(z.string(), z.unknown()),
})
export type SweedAuthEvent = z.infer<typeof SweedAuthEventSchema>

export const SweedAuthEventsQuerySchema = z.object({
  jobId: z.coerce.number().int().positive().optional(),
  // 'errors' = anything not 'ok'; 'all' = no filter.
  outcomeFilter: z.enum(['all', 'errors']).default('all'),
  authTokenPrefix: z.string().trim().min(1).max(32).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})
export type SweedAuthEventsQuery = z.infer<typeof SweedAuthEventsQuerySchema>

export const SweedAuthEventsResponseSchema = z.object({
  items: z.array(SweedAuthEventSchema),
  truncated: z.boolean(),
})
export type SweedAuthEventsResponse = z.infer<typeof SweedAuthEventsResponseSchema>
