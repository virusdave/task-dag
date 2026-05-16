import { z } from 'zod'

export const CatalogMaintenanceVariantSchema = z.object({
  productId: z.number().int(),
  name: z.string().nullable(),
  shortName: z.string().nullable(),
  tab: z.string().nullable(),
  packOfSize: z.number().int().nullable(),
  sizeName: z.string().nullable(),
  inStockSites: z.array(z.string()),
  imageCount: z.number().int(),
  variantSpecificImageCount: z.number().int(),
  previewImageUrl: z.string().nullable(),
})
export type CatalogMaintenanceVariant = z.infer<typeof CatalogMaintenanceVariantSchema>

export const CatalogMaintenanceGroupSchema = z.object({
  groupId: z.number().int(),
  groupName: z.string().nullable(),
  brandName: z.string().nullable(),
  categoryName: z.string().nullable(),
  subcategoryName: z.string().nullable(),
  groupImageCount: z.number().int(),
  groupPreviewImageUrl: z.string().nullable(),
  inStockSites: z.array(z.string()),
  inStockVariantCount: z.number().int(),
  totalVariantCount: z.number().int(),
  variants: z.array(CatalogMaintenanceVariantSchema),
})
export type CatalogMaintenanceGroup = z.infer<typeof CatalogMaintenanceGroupSchema>

export const CatalogMaintenanceSurveyMetaSchema = z.object({
  generatedAt: z.string(),
  expiresAt: z.string(),
  scannedDealerIds: z.array(z.number().int()),
  totalInStockVariants: z.number().int(),
  totalUniqueGroups: z.number().int(),
  warnings: z.array(z.string()),
})
export type CatalogMaintenanceSurveyMeta = z.infer<typeof CatalogMaintenanceSurveyMetaSchema>

export const CatalogMaintenanceListResponseSchema = z.object({
  meta: CatalogMaintenanceSurveyMetaSchema,
  groups: z.array(CatalogMaintenanceGroupSchema),
})
export type CatalogMaintenanceListResponse = z.infer<typeof CatalogMaintenanceListResponseSchema>

export const CatalogMaintenanceUploadTargetTypeSchema = z.enum(['group', 'variants'])
export type CatalogMaintenanceUploadTargetType = z.infer<typeof CatalogMaintenanceUploadTargetTypeSchema>

export const CatalogMaintenanceUploadResultSchema = z.object({
  targetType: CatalogMaintenanceUploadTargetTypeSchema,
  groupId: z.number().int(),
  affectedProductIds: z.array(z.number().int()),
  uploadedBlobId: z.string(),
  blobUrl: z.string().nullable(),
})
export type CatalogMaintenanceUploadResult = z.infer<typeof CatalogMaintenanceUploadResultSchema>
