import { z } from 'zod'

import { JsonValueSchema } from '../common/json.js'
import { FieldPathSchema } from '../../domain/fieldPaths.js'

export const ProposalTypeSchema = z.enum(['description', 'pricing'])
export type ProposalType = z.infer<typeof ProposalTypeSchema>

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'superseded'])
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>

export const TargetEntityTypeSchema = z.enum(['catalog_group', 'catalog_product'])
export type TargetEntityType = z.infer<typeof TargetEntityTypeSchema>

export const ValidationIssueSchema = z.object({
  code: z.string(),
  detail: z.string(),
  severity: z.enum(['error', 'warning']).default('warning'),
})
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>

export const FieldTargetRefSchema = z.object({
  catalogGroupId: z.number().int().positive(),
  fieldPath: FieldPathSchema,
  targetEntityId: z.number().int().positive(),
  targetEntityType: TargetEntityTypeSchema,
})
export type FieldTargetRef = z.infer<typeof FieldTargetRefSchema>

export const ProposalLineItemValuePreviewSchema = z.object({
  baselineText: z.string(),
  editedText: z.string(),
  effectiveText: z.string(),
  isTruncated: z.boolean(),
  suggestedText: z.string(),
})
export type ProposalLineItemValuePreview = z.infer<typeof ProposalLineItemValuePreviewSchema>

export const ProposalLineItemSchema = z.object({
  activeDesiredStateRevisionId: z.number().int().positive().nullable(),
  approvalStatus: ApprovalStatusSchema,
  approvalUpdatedAt: z.iso.datetime().nullable(),
  approvedByUser: z.string().nullable(),
  baselineSnapshotId: z.number().int().positive().nullable(),
  baselineValue: JsonValueSchema,
  catalogGroupId: z.number().int().positive(),
  effectiveValue: JsonValueSchema,
  editedValue: JsonValueSchema.nullable(),
  fieldPath: FieldPathSchema,
  groupSummary: z.object({
    brandName: z.string().nullable(),
    categoryName: z.string().nullable(),
    groupName: z.string(),
    liveStateHash: z.string(),
    reconcileStatus: z.string(),
    subcategoryName: z.string().nullable(),
  }),
  lineItemId: z.number().int().positive(),
  notes: z.string().nullable(),
  rowId: z.number().int().positive(),
  suggestedValue: JsonValueSchema,
  targetEntityId: z.number().int().positive(),
  targetEntityType: TargetEntityTypeSchema,
  validationIssues: z.array(ValidationIssueSchema),
  valuePreview: ProposalLineItemValuePreviewSchema,
  version: z.number().int().positive(),
})
export type ProposalLineItem = z.infer<typeof ProposalLineItemSchema>
