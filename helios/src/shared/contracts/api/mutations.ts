import { z } from 'zod'

export const MutationAcceptedResponseSchema = z.object({
  auditEventId: z.number().int().positive().nullable(),
  jobId: z.number().int().positive().nullable(),
  requestId: z.string(),
})
export type MutationAcceptedResponse = z.infer<typeof MutationAcceptedResponseSchema>
