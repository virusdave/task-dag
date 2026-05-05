import { z } from 'zod'

import { ProposalTypeSchema } from '../domain/proposals.js'

export const QueueProposalBatchRequestSchema = z.object({
  catalogGroupIds: z.array(z.coerce.number().int().positive()).min(1).max(100),
  forceLiveRefresh: z.boolean().default(false),
  proposalType: ProposalTypeSchema,
  reason: z.string().trim().max(500).nullable().optional(),
})
export type QueueProposalBatchRequest = z.infer<typeof QueueProposalBatchRequestSchema>
