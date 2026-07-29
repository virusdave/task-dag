import { z } from 'zod'

export const TradeSampleZeroItemSchema = z.object({
  currentQty: z.number().finite().positive(),
  externalTrackCode: z.string().trim().min(1),
  inventoryItemId: z.string().trim().min(1),
  packageLabel: z.string().nullable(),
  productId: z.number().int().positive(),
  productName: z.string().nullable(),
  productSku: z.string().nullable(),
})
export type TradeSampleZeroItem = z.infer<typeof TradeSampleZeroItemSchema>

export const TradeSampleZeroPreviewRequestSchema = z.object({ siteDealerId: z.number().int().positive() })
export const TradeSampleZeroPreviewResponseSchema = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  items: z.array(TradeSampleZeroItemSchema),
  siteDealerId: z.number().int().positive(),
})
export type TradeSampleZeroPreviewResponse = z.infer<typeof TradeSampleZeroPreviewResponseSchema>

export const TradeSampleZeroApplyRequestSchema = z.object({
  confirmation: z.string(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  items: z.array(TradeSampleZeroItemSchema).max(500),
  siteDealerId: z.number().int().positive(),
})
export const TradeSampleZeroOutcomeSchema = z.object({
  inventoryItemId: z.string(),
  status: z.enum(['completed', 'failed_unknown', 'not_applied_stale', 'not_applied_audit_failure']),
  error: z.string().optional(),
})
export const TradeSampleZeroApplyResponseSchema = z.object({
  counts: z.object({
    completed: z.number().int().nonnegative(),
    failedUnknown: z.number().int().nonnegative(),
    notAppliedStale: z.number().int().nonnegative(),
    notAppliedAuditFailure: z.number().int().nonnegative(),
  }),
  outcomes: z.array(TradeSampleZeroOutcomeSchema),
})
export type TradeSampleZeroApplyResponse = z.infer<typeof TradeSampleZeroApplyResponseSchema>
