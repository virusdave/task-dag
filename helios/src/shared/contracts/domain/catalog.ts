import { z } from 'zod'

export const ReconcileStatusSchema = z.enum(['unknown', 'in_sync', 'drifted', 'queued', 'applying', 'error'])
export type ReconcileStatus = z.infer<typeof ReconcileStatusSchema>

export const CatalogGroupSummarySchema = z.object({
  brandName: z.string().nullable(),
  catalogGroupId: z.number().int().positive(),
  categoryName: z.string().nullable(),
  driftedAt: z.iso.datetime().nullable(),
  groupName: z.string(),
  lastSyncedAt: z.iso.datetime(),
  productTabs: z.array(z.string()),
  reconcileStatus: ReconcileStatusSchema,
  subcategoryName: z.string().nullable(),
  sweedGroupId: z.number().int().positive(),
})
export type CatalogGroupSummary = z.infer<typeof CatalogGroupSummarySchema>

/** Categories that do not represent regulated cannabis inventory. */
export const NON_CANNABIS_CATEGORY_NAMES: ReadonlySet<string> = new Set([
  'Accessories',
  'Other',
])

/** Unknown categories stay included so incomplete catalog data fails visibly. */
export function isCannabisCategory(categoryName: string | null): boolean {
  if (categoryName === null) return true
  return !NON_CANNABIS_CATEGORY_NAMES.has(categoryName.trim())
}
