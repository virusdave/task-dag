/**
 * UI contracts for the unified proposal review framework.
 *
 * These types define the interface between the backend proposal system
 * and the reusable frontend review components.
 */

import { z } from 'zod'

export type FieldGroup = 'pricing' | 'promo' | 'taxonomy' | 'attributes' | 'mso_brand' | 'description'

export const UiFieldDescriptorSchema = z.object({
  path: z.string(),
  group: z.enum(['pricing', 'promo', 'taxonomy', 'attributes', 'mso_brand', 'description']),
  label: z.string(),
  valueType: z.enum(['string', 'number', 'boolean', 'price', 'json', 'pricingLadder', 'text']),
  editable: z.boolean(),
  editorComponent: z.enum([
    'text',
    'number',
    'boolean',
    'price',
    'pricingLadder',
    'promoBuilder',
    'attributeEditor',
    'textArea',
    'select',
  ]),
})

export type UiFieldDescriptor = z.infer<typeof UiFieldDescriptorSchema>

export const UiLineItemSchema = z.object({
  id: z.number(),
  field: UiFieldDescriptorSchema,
  baselineValue: z.unknown(),
  suggestedValue: z.unknown(),
  editedValue: z.unknown().optional(),
  effectiveValue: z.unknown(),
  approvalStatus: z.enum(['pending', 'approved', 'rejected']),
  validationIssues: z.array(z.unknown()).default([]),
  notes: z.string().nullable().optional(),
  version: z.number(),
})

export type UiLineItem = z.infer<typeof UiLineItemSchema>

export const MSOBrandAnnotationSchema = z.object({
  msoBrandId: z.number().nullable().optional(),
  isMSOBrand: z.boolean().optional(),
  isHouseBrand: z.boolean().optional(),
  notes: z.string().nullable().optional(),
})

export type MSOBrandAnnotation = z.infer<typeof MSOBrandAnnotationSchema>

export const UiProposalRowSchema = z.object({
  id: z.number(),
  rowTitle: z.string(),
  siteName: z.string().optional(),
  catalogName: z.string().optional(),
  brandName: z.string().nullable().optional(),
  itemName: z.string().nullable().optional(),
  msoAnnotation: MSOBrandAnnotationSchema.optional(),
  merchContext: z.record(z.string(), z.unknown()).default({}),
  evidence: z.record(z.string(), z.unknown()).default({}),
  lineItems: z.array(UiLineItemSchema),
  // Hierarchy for filtering
  siteId: z.number().optional(),
  catalogId: z.number().optional(),
  brandId: z.number().nullable().optional(),
  itemId: z.number().nullable().optional(),
})

export type UiProposalRow = z.infer<typeof UiProposalRowSchema>

export const ProposalReviewFiltersSchema = z.object({
  batchId: z.number().nullable().optional(),
  search: z.string().optional(),
  approvalStatus: z.enum(['pending', 'approved', 'rejected', '']).optional(),
  siteId: z.number().nullable().optional(),
  brandId: z.number().nullable().optional(),
  fieldGroup: z.enum(['pricing', 'promo', 'taxonomy', 'attributes', 'mso_brand', 'description', '']).optional(),
  showSuperseded: z.boolean().default(false),
})

export type ProposalReviewFilters = z.infer<typeof ProposalReviewFiltersSchema>

export const ProposalReviewResponseSchema = z.object({
  batchId: z.number(),
  batchType: z.string(),
  batchSource: z.string(),
  batchStatus: z.enum(['draft', 'ready', 'applied', 'cancelled']),
  filters: ProposalReviewFiltersSchema,
  rows: z.array(UiProposalRowSchema),
  totalRowCount: z.number(),
  summary: z.object({
    pendingCount: z.number(),
    approvedCount: z.number(),
    rejectedCount: z.number(),
    totalLineItems: z.number(),
  }),
})

export type ProposalReviewResponse = z.infer<typeof ProposalReviewResponseSchema>

export interface HierarchyNode {
  id: string // e.g., "site:123" or "brand:456"
  type: 'site' | 'catalog' | 'brand' | 'item'
  label: string
  itemCount: number // number of rows at this level
  children: HierarchyNode[]
  isExpanded: boolean
}

export const HierarchyNodeSchema: z.ZodType<HierarchyNode> = z.object({
  id: z.string(),
  type: z.enum(['site', 'catalog', 'brand', 'item']),
  label: z.string(),
  itemCount: z.number(),
  children: z.array(z.lazy(() => HierarchyNodeSchema)).default([]),
  isExpanded: z.boolean().default(false),
})

export const BulkActionRequestSchema = z.object({
  batchId: z.number(),
  lineItemIds: z.array(z.number()),
  action: z.enum(['approve', 'reject', 'edit']),
  editValue: z.unknown().optional(),
  note: z.string().nullable().optional(),
})

export type BulkActionRequest = z.infer<typeof BulkActionRequestSchema>
