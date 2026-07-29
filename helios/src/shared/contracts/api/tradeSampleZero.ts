import { z } from 'zod'

export const TRADE_SAMPLE_LOCATION_NAME = 'NOT FOR SALE - Samples'
export const TRADE_SAMPLE_STAGE_CONFIRMATION = 'STAGE TRADE SAMPLES'
export const TRADE_SAMPLE_APPROVAL_CONFIRMATION = 'I VERIFIED ONLY TRADE SAMPLES'

export const TradeSampleLocationSchema = z.object({ id: z.number().int().positive(), name: z.literal(TRADE_SAMPLE_LOCATION_NAME), stockTypeId: z.number().int().positive() }).strict()
export const TradeSampleZeroItemSchema = z.object({
  currentQty: z.number().finite().positive(), availableQty: z.number().finite().positive(),
  externalTrackCode: z.string().trim().min(1), inventoryItemId: z.string().trim().min(1),
  packageLabel: z.string().nullable(), productId: z.number().int().positive(), productName: z.string().nullable(), productSku: z.string().nullable(),
  sourceLocationId: z.number().int().positive(), sourceLocationName: z.string().trim().min(1), sourceStockTypeId: z.number().int().positive(),
}).strict()
export type TradeSampleZeroItem = z.infer<typeof TradeSampleZeroItemSchema>

export const TradeSampleZeroPreviewRequestSchema = z.object({ siteDealerId: z.number().int().positive() })
export const TradeSampleZeroPreviewResponseSchema = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), destination: TradeSampleLocationSchema,
  items: z.array(TradeSampleZeroItemSchema), previewId: z.uuid(), previewToken: z.string().min(1), siteDealerId: z.number().int().positive() })
export type TradeSampleZeroPreviewResponse = z.infer<typeof TradeSampleZeroPreviewResponseSchema>
export const TradeSampleZeroApplyRequestSchema = TradeSampleZeroPreviewResponseSchema.extend({ confirmation: z.literal(TRADE_SAMPLE_STAGE_CONFIRMATION) })
export const TradeSampleZeroApprovalRequestSchema = z.object({ confirmation: z.literal(TRADE_SAMPLE_APPROVAL_CONFIRMATION) })
export const TradeSampleZeroEnqueueResponseSchema = z.object({ jobId: z.number().int().positive() })

export const TradeSampleZeroOutcomeSchema = z.object({ inventoryItemId: z.string(), status: z.enum(['completed', 'failed_unknown', 'not_applied_stale', 'not_applied_audit_failure']) })
export const TradeSampleOutcomeCountsSchema = z.object({ completed: z.number().int().nonnegative(), failedUnknown: z.number().int().nonnegative(), notAppliedStale: z.number().int().nonnegative(), notAppliedAuditFailure: z.number().int().nonnegative() })
export const TradeSampleStageResultSchema = z.object({ operationId: z.string().min(1), siteDealerId: z.number().int().positive(), destination: TradeSampleLocationSchema,
  items: z.array(TradeSampleZeroItemSchema), complete: z.boolean(), counts: TradeSampleOutcomeCountsSchema, outcomes: z.array(TradeSampleZeroOutcomeSchema), message: z.string().min(1) }).strict()
export type TradeSampleStageResult = z.infer<typeof TradeSampleStageResultSchema>
export const TradeSampleZeroResultSchema = z.object({ operationId: z.string().min(1), siteDealerId: z.number().int().positive(), destination: TradeSampleLocationSchema,
  items: z.array(TradeSampleZeroItemSchema), stageJobId: z.number().int().positive(), counts: TradeSampleOutcomeCountsSchema, outcomes: z.array(TradeSampleZeroOutcomeSchema), message: z.string().min(1) }).strict()
export type TradeSampleZeroResult = z.infer<typeof TradeSampleZeroResultSchema>
