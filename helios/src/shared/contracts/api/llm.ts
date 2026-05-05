import { z } from 'zod'

import { JsonValueSchema } from '../common/json.js'

export const LlmRunRouteParamsSchema = z.object({
  llmRunId: z.coerce.number().int().positive(),
})
export type LlmRunRouteParams = z.infer<typeof LlmRunRouteParamsSchema>

export const LlmRunDetailResponseSchema = z.object({
  groupSummary: z.object({
    brandName: z.string().nullable(),
    catalogGroupId: z.number().int().positive(),
    categoryName: z.string().nullable(),
    groupName: z.string(),
    subcategoryName: z.string().nullable(),
  }).nullable(),
  proposalContext: z.object({
    lineItemIds: z.array(z.number().int().positive()),
    proposalBatchId: z.number().int().positive(),
    proposalRowId: z.number().int().positive(),
  }).nullable(),
  run: z.object({
    catalogGroupId: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    createdByUser: z.string().nullable(),
    forcedRefresh: z.boolean(),
    inputJson: JsonValueSchema,
    llmRunId: z.number().int().positive(),
    model: z.string(),
    parsedOutputJson: JsonValueSchema.nullable(),
    promptVersion: z.string(),
    purpose: z.string(),
    rawOutputText: z.string(),
    status: z.string(),
    supersedesRunId: z.number().int().positive().nullable(),
    validationIssues: JsonValueSchema,
  }),
})
export type LlmRunDetailResponse = z.infer<typeof LlmRunDetailResponseSchema>
