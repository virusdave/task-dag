import { z } from 'zod'

/**
 * Canonical scope identifiers shared across modules. New modules should
 * extend this list rather than invent parallel scope shapes.
 */
export const SCOPE_KINDS = [
  'catalog_brand',
  'catalog_item',
  'catalog_group',
  'pending_purchase_row',
  'pending_purchase_packet',
  'proposal_line_item',
  'proposal_batch',
  'write_operation',
  'job',
  'audit_event',
] as const
export const ScopeKindSchema = z.enum(SCOPE_KINDS)
export type ScopeKind = z.infer<typeof ScopeKindSchema>

/**
 * Generic scope reference. id is the primary identifier for the row in
 * its native table; optional brandId / itemKey enable cross-scope lookups
 * (e.g. brand context for an item-level comment).
 */
export const ScopeRefSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().trim().min(1)]),
  brandId: z.union([z.number().int().positive(), z.string().trim().min(1)]).optional(),
  itemKey: z.string().trim().min(1).optional(),
})
export type ScopeRef = z.infer<typeof ScopeRefSchema>

export function scopeRefIdString(scopeRef: ScopeRef): string {
  return String(scopeRef.id)
}
