import { z } from 'zod'

export const QueueReviewPacketImportRequestSchema = z.object({
  filePath: z.string().trim().min(1).max(4096),
  reason: z.string().trim().max(500).nullable().optional(),
})
export type QueueReviewPacketImportRequest = z.infer<typeof QueueReviewPacketImportRequestSchema>
