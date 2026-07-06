import { z } from 'zod'

// ---------------------------------------------------------------------------
// Categorical Family Explorer (issue #55, task T1) — temporary operator-only
// audit surface. The server ships the WHOLE variant catalog (raw, ungrouped)
// once; the client groups it into categorical families (via the shared
// `familyExplorer.ts` module) and toggles nonbrand/brand mode WITHOUT a
// refetch. Keeping grouping client-side keeps the server trivial and the mode
// toggle instant at this scale (~3.5k small rows).
// ---------------------------------------------------------------------------

export const CatalogFamilyExplorerVariantSchema = z.object({
  catalogGroupId: z.number().int(),
  productId: z.number().int(),
  name: z.string().nullable(),
  sku: z.string().nullable(),
  brandName: z.string().nullable(),
  categoryName: z.string().nullable(),
  subcategoryName: z.string().nullable(),
  packCount: z.number().int().nullable(),
  sizeLabel: z.string().nullable(),
})
export type CatalogFamilyExplorerVariant = z.infer<typeof CatalogFamilyExplorerVariantSchema>

export const CatalogFamilyExplorerResponseSchema = z.object({
  /** ISO-8601 UTC instant the catalog snapshot was read (displayed in NY tz). */
  generatedAt: z.string(),
  variants: z.array(CatalogFamilyExplorerVariantSchema),
})
export type CatalogFamilyExplorerResponse = z.infer<typeof CatalogFamilyExplorerResponseSchema>
