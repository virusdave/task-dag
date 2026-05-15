import { z } from 'zod'

import {
  PolicyReplacementDraftStateSchema,
  PolicyReplacementItemIdSchema,
  PolicyReplacementItemStateSchema,
} from '../domain/communications.js'

export const PolicyReplacementPacketRouteParamsSchema = z.object({
  packetId: z.string().trim().min(1),
})
export type PolicyReplacementPacketRouteParams = z.infer<typeof PolicyReplacementPacketRouteParamsSchema>

export const PolicyReplacementDraftPostBodySchema = z.object({
  packetId: z.string().trim().min(1),
  items: z.record(PolicyReplacementItemIdSchema, PolicyReplacementItemStateSchema).default({}),
  submit: z.boolean().optional(),
})
export type PolicyReplacementDraftPostBody = z.infer<typeof PolicyReplacementDraftPostBodySchema>

export const PolicyReplacementDraftResponseSchema = PolicyReplacementDraftStateSchema
export type PolicyReplacementDraftResponse = z.infer<typeof PolicyReplacementDraftResponseSchema>

export const PolicyReplacementDraftEmptyResponseSchema = z.object({
  packetId: z.string().trim().min(1),
  error: z.string(),
})
export type PolicyReplacementDraftEmptyResponse = z.infer<typeof PolicyReplacementDraftEmptyResponseSchema>

export const PolicyReplacementPacketSummarySchema = z.object({
  packetId: z.string().trim().min(1),
  generatedAt: z.string().nullable(),
  itemIdCount: z.number().int().min(0),
  categories: z.object({
    visualReplacementPlans: z.number().int().min(0),
    headlines: z.number().int().min(0),
    longHeadlines: z.number().int().min(0),
    descriptions: z.number().int().min(0),
    templateFamilies: z.number().int().min(0),
    textReplacementMappings: z.number().int().min(0),
  }),
})
export type PolicyReplacementPacketSummary = z.infer<typeof PolicyReplacementPacketSummarySchema>
