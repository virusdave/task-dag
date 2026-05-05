import { z } from 'zod'

import { JsonValueSchema } from '../common/json.js'
import { ProposalLineItemSchema, ProposalTypeSchema } from '../domain/proposals.js'

const BlankStringSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
  z.string().trim().min(1).optional(),
)

const BlankApprovalStatusSchema = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.enum(['pending', 'approved', 'rejected']).optional(),
)

const BlankProposalTypeSchema = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  ProposalTypeSchema.optional(),
)

export const ReviewLineItemListQuerySchema = z.object({
  approvalStatus: BlankApprovalStatusSchema,
  batchStatus: BlankStringSchema,
  driftOnly: z.coerce.boolean().optional(),
  hasValidationIssues: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  proposalType: BlankProposalTypeSchema,
  search: BlankStringSchema,
})
export type ReviewLineItemListQuery = z.infer<typeof ReviewLineItemListQuerySchema>

export const ReviewLineItemListResponseSchema = z.object({
  batchSummary: z.object({
    batchId: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    status: z.string(),
    type: z.string(),
  }).nullable(),
  filters: ReviewLineItemListQuerySchema,
  items: z.array(ProposalLineItemSchema),
  totalCount: z.number().int().min(0),
})
export type ReviewLineItemListResponse = z.infer<typeof ReviewLineItemListResponseSchema>

export const EditProposalLineItemRequestSchema = z.object({
  editedValue: JsonValueSchema.nullable(),
  expectedVersion: z.number().int().positive(),
})
export type EditProposalLineItemRequest = z.infer<typeof EditProposalLineItemRequestSchema>

export const UpdateProposalLineItemNoteRequestSchema = z.object({
  note: z.string().trim().max(5000).nullable(),
})
export type UpdateProposalLineItemNoteRequest = z.infer<typeof UpdateProposalLineItemNoteRequestSchema>

export const ApproveProposalLineItemRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
})
export type ApproveProposalLineItemRequest = z.infer<typeof ApproveProposalLineItemRequestSchema>

export const RejectProposalLineItemRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
})
export type RejectProposalLineItemRequest = z.infer<typeof RejectProposalLineItemRequestSchema>
