import { z } from 'zod'

/* -------------------------------------------------------------------------- */
/*  Survey response — Images & Barcodes page.                                  */
/* -------------------------------------------------------------------------- */

export const CatalogMaintenanceBarcodeStatusSchema = z.enum(['ok', 'missing', 'invalid'])
export type CatalogMaintenanceBarcodeStatus = z.infer<typeof CatalogMaintenanceBarcodeStatusSchema>

export const CatalogMaintenanceSectionKindSchema = z.enum([
  'missing-catalog-image',
  'missing-variant-image',
  'missing-or-invalid-barcode',
])
export type CatalogMaintenanceSectionKind = z.infer<typeof CatalogMaintenanceSectionKindSchema>

export const CatalogMaintenanceSiteVariantSchema = z.object({
  productId: z.number().int(),
  name: z.string().nullable(),
  shortName: z.string().nullable(),
  tab: z.string().nullable(),
  packOfSize: z.number().int().nullable(),
  sizeName: z.string().nullable(),
  quantity: z.number().nullable(),
  metrcTags: z.array(z.string()),
  previewImageUrl: z.string().nullable(),
  imageCount: z.number().int(),
  variantSpecificImageCount: z.number().int(),
  externalBarcode: z.string().nullable(),
  barcodeStatus: CatalogMaintenanceBarcodeStatusSchema,
  barcodeIssueReason: z.string().nullable(),
})
export type CatalogMaintenanceSiteVariant = z.infer<typeof CatalogMaintenanceSiteVariantSchema>

export const CatalogMaintenanceSiteGroupSchema = z.object({
  groupId: z.number().int(),
  groupName: z.string().nullable(),
  brandName: z.string().nullable(),
  categoryName: z.string().nullable(),
  subcategoryName: z.string().nullable(),
  groupImageCount: z.number().int(),
  groupPreviewImageUrl: z.string().nullable(),
  siteKey: z.string(),
  siteLabel: z.string(),
  totalVariantCount: z.number().int(),
  variants: z.array(CatalogMaintenanceSiteVariantSchema),
  needsReanalysis: z.boolean(),
})
export type CatalogMaintenanceSiteGroup = z.infer<typeof CatalogMaintenanceSiteGroupSchema>

export const CatalogMaintenanceSurveySectionSchema = z.object({
  kind: CatalogMaintenanceSectionKindSchema,
  label: z.string(),
  targetId: z.string(),
  issueCount: z.number().int(),
  groups: z.array(CatalogMaintenanceSiteGroupSchema),
})
export type CatalogMaintenanceSurveySection = z.infer<typeof CatalogMaintenanceSurveySectionSchema>

export const CatalogMaintenanceSurveySiteSchema = z.object({
  siteKey: z.string(),
  siteLabel: z.string(),
  targetId: z.string(),
  totalIssueCount: z.number().int(),
  sections: z.array(CatalogMaintenanceSurveySectionSchema),
})
export type CatalogMaintenanceSurveySite = z.infer<typeof CatalogMaintenanceSurveySiteSchema>

export const CatalogMaintenanceQuickFilterBrandSchema = z.object({
  brandName: z.string(),
  issueCount: z.number().int(),
})
export type CatalogMaintenanceQuickFilterBrand = z.infer<typeof CatalogMaintenanceQuickFilterBrandSchema>

export const CatalogMaintenanceFatalReasonCodeSchema = z.enum([
  'orphan-in-stock-variants',
  'stock-metrc-tags-missing',
  'live-state-schema-stale',
  'live-state-parse-failed',
])
export type CatalogMaintenanceFatalReasonCode = z.infer<typeof CatalogMaintenanceFatalReasonCodeSchema>

export const CatalogMaintenanceFatalReasonSchema = z.object({
  code: CatalogMaintenanceFatalReasonCodeSchema,
  message: z.string(),
  count: z.number().int(),
  sampleIds: z.array(z.union([z.number().int(), z.string()])),
})
export type CatalogMaintenanceFatalReason = z.infer<typeof CatalogMaintenanceFatalReasonSchema>

export const CatalogMaintenanceFatalBannerSchema = z.object({
  title: z.string(),
  message: z.string(),
  reasons: z.array(CatalogMaintenanceFatalReasonSchema),
  canRepair: z.boolean(),
})
export type CatalogMaintenanceFatalBanner = z.infer<typeof CatalogMaintenanceFatalBannerSchema>

export const CatalogMaintenanceSurveyMetaSchema = z.object({
  generatedAt: z.string(),
  expiresAt: z.string(),
  scannedDealerIds: z.array(z.number().int()),
  totalInStockVariants: z.number().int(),
  totalUniqueGroups: z.number().int(),
  warnings: z.array(z.string()),
})
export type CatalogMaintenanceSurveyMeta = z.infer<typeof CatalogMaintenanceSurveyMetaSchema>

export const CatalogMaintenanceSurveyResponseSchema = z.object({
  meta: CatalogMaintenanceSurveyMetaSchema,
  fatal: CatalogMaintenanceFatalBannerSchema.nullable(),
  sites: z.array(CatalogMaintenanceSurveySiteSchema),
  quickFilters: z.object({
    brands: z.array(CatalogMaintenanceQuickFilterBrandSchema),
  }),
})
export type CatalogMaintenanceSurveyResponse = z.infer<typeof CatalogMaintenanceSurveyResponseSchema>

/* -------------------------------------------------------------------------- */
/*  Write paths (unchanged shapes, plus repair endpoint).                      */
/* -------------------------------------------------------------------------- */

export const CatalogMaintenanceUploadTargetTypeSchema = z.enum(['group', 'variants'])
export type CatalogMaintenanceUploadTargetType = z.infer<typeof CatalogMaintenanceUploadTargetTypeSchema>

export const CatalogMaintenanceUploadResultSchema = z.object({
  targetType: CatalogMaintenanceUploadTargetTypeSchema,
  groupId: z.number().int(),
  affectedProductIds: z.array(z.number().int()),
  uploadedBlobId: z.string(),
  blobUrl: z.string().nullable(),
  reanalysisJobId: z.number().int().nullable(),
})
export type CatalogMaintenanceUploadResult = z.infer<typeof CatalogMaintenanceUploadResultSchema>

export const CatalogMaintenanceUpdateBarcodeRequestSchema = z.object({
  productId: z.number().int().positive(),
  sweedGroupId: z.number().int().positive(),
  externalBarcode: z.string().trim().min(1).max(128),
})
export type CatalogMaintenanceUpdateBarcodeRequest = z.infer<
  typeof CatalogMaintenanceUpdateBarcodeRequestSchema
>

export const CatalogMaintenanceUpdateBarcodeResponseSchema = z.object({
  productId: z.number().int(),
  externalBarcode: z.string(),
  reanalysisJobId: z.number().int().nullable(),
})
export type CatalogMaintenanceUpdateBarcodeResponse = z.infer<
  typeof CatalogMaintenanceUpdateBarcodeResponseSchema
>

export const CatalogMaintenanceCacheRepairResponseSchema = z.object({
  fullSummaryJobId: z.number().int().nullable(),
  stockRefreshJobId: z.number().int().nullable(),
  discoverOrphanGroupsJobId: z.number().int().nullable(),
})
export type CatalogMaintenanceCacheRepairResponse = z.infer<typeof CatalogMaintenanceCacheRepairResponseSchema>
