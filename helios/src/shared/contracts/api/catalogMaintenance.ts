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

/**
 * A single physical package / inventory item / lot — what Sweed calls
 * an `inventory.item` and Metrc calls a tagged package. One variant
 * may have several lots at the same site at once. Carried on the
 * survey response so the Images & Barcodes page can render a
 * per-package "Move to Inspection" button without needing a second
 * fetch.
 *
 * `itemId` is Sweed's `inventory.item.id` (string in their API even
 * though numeric on the wire). `externalTrackCode` is the METRC
 * package tag. `stockType` / `stockLocation` carry both id and name
 * so the UI can label the source bucket without re-resolving against
 * `store.stock.location.list`.
 */
export const CatalogMaintenancePackageLotSchema = z.object({
  itemId: z.string(),
  externalTrackCode: z.string().nullable(),
  stockLocationId: z.number().int().nullable(),
  stockLocationName: z.string().nullable(),
  stockTypeId: z.number().int().nullable(),
  stockTypeName: z.string().nullable(),
  availableQty: z.number().nullable(),
  isForSale: z.boolean(),
  isTradeSample: z.boolean(),
})
export type CatalogMaintenancePackageLot = z.infer<typeof CatalogMaintenancePackageLotSchema>

export const CatalogMaintenanceSiteVariantSchema = z.object({
  productId: z.number().int(),
  name: z.string().nullable(),
  shortName: z.string().nullable(),
  tab: z.string().nullable(),
  packOfSize: z.number().int().nullable(),
  sizeName: z.string().nullable(),
  quantity: z.number().nullable(),
  metrcTags: z.array(z.string()),
  /**
   * Per-package detail derived from the same live grouped-inventory
   * pull that drives `liveVerifyCandidateSet`. Empty array when the
   * live verify pass could not run (no Sweed pool token, transport
   * failure, etc.) — the UI degrades to showing METRC tags without
   * action buttons in that case.
   */
  lots: z.array(CatalogMaintenancePackageLotSchema),
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
  /**
   * Sweed's numeric brand id. Used client-side to deep-link the
   * storefront's brand filter. Nullable because (a) older
   * catalog_groups rows were synced before brandId extraction was
   * added to liveState normalization and (b) some groups don't have
   * a brand on Sweed.
   */
  brandId: z.number().int().nullable(),
  categoryName: z.string().nullable(),
  categoryId: z.number().int().nullable(),
  subcategoryName: z.string().nullable(),
  subcategoryId: z.number().int().nullable(),
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

/**
 * Image-upload responses are now always asynchronous: the route
 * stashes bytes via PendingImageUploadStore and enqueues a worker
 * job (catalog.maintenance.upload_group_image). The client polls
 * /api/jobs/:id (the existing endpoint) to watch the job through
 * queued → running → succeeded | failed and shows ✓ / ✗ in the
 * per-card status banner. On failure the operator can retry without
 * re-selecting the file because the bytes are durable.
 *
 * Variant-image uploads remain parked — the route returns HTTP 410
 * for `targetType: 'variants'` until the Sweed RPC for attaching
 * variant-level images is figured out.
 */
export const CatalogMaintenanceUploadResultSchema = z.object({
  status: z.literal('queued'),
  jobId: z.number().int().positive(),
  stagedRef: z.string().min(1),
  sweedGroupId: z.number().int().positive(),
  targetType: z.literal('group'),
})
export type CatalogMaintenanceUploadResult = z.infer<typeof CatalogMaintenanceUploadResultSchema>

/**
 * Body for POST /api/catalog/maintenance/images/:stagedRef/retry.
 * No fields — the staged bytes already carry every input the worker
 * needs.
 */
export const CatalogMaintenanceRetryUploadRequestSchema = z.object({}).optional()
export type CatalogMaintenanceRetryUploadRequest = z.infer<
  typeof CatalogMaintenanceRetryUploadRequestSchema
>

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

/* -------------------------------------------------------------------------- */
/*  Move-package-to-inspection — write path.                                   */
/* -------------------------------------------------------------------------- */

/**
 * Body for POST /api/catalog/maintenance/move-package-to-inspection.
 *
 * The Images & Barcodes page sends `productId` + `externalTrackCode`
 * (the METRC tag) for the package the operator clicked on, plus the
 * `siteDealerId` that owns it. The server live-resolves the lot via
 * `store.inventory.product.item.list` and drains it into the
 * dealer's "NOT FOR SALE - Hold for Dave inspection" location using
 * `store.inventory.item.transfer`.
 *
 * The `expectedItemId` and `expectedLocationName` fields are
 * optimistic hints from the survey payload — if Sweed disagrees
 * (e.g. another operator just moved or sold the lot) we use Sweed's
 * fresh data, but we record the mismatch in the audit event so the
 * cache-staleness pattern is visible.
 */
export const CatalogMaintenanceMovePackageRequestSchema = z.object({
  siteDealerId: z.number().int().positive(),
  productId: z.number().int().positive(),
  externalTrackCode: z.string().trim().min(1).max(128),
  expectedItemId: z.string().trim().min(1).max(64).nullable().optional(),
  expectedLocationName: z.string().trim().min(1).max(128).nullable().optional(),
})
export type CatalogMaintenanceMovePackageRequest = z.infer<
  typeof CatalogMaintenanceMovePackageRequestSchema
>

export const CatalogMaintenanceMovePackageOutcomeSchema = z.enum([
  // Found the exact lot by METRC tag and transferred it.
  'moved-target-lot',
  // Could not find a lot for that METRC tag; transferred every
  // remaining lot of the product as a fallback.
  'moved-fallback-all-lots',
  // No live lots at all — nothing to move. The variant is already
  // off the floor; we just invalidate the survey cache.
  'nothing-to-move',
])
export type CatalogMaintenanceMovePackageOutcome = z.infer<
  typeof CatalogMaintenanceMovePackageOutcomeSchema
>

export const CatalogMaintenanceMovedLotSchema = z.object({
  itemId: z.string(),
  externalTrackCode: z.string().nullable(),
  qty: z.number(),
  fromStockLocationId: z.number().int(),
  fromStockLocationName: z.string(),
  fromStockTypeId: z.number().int(),
})
export type CatalogMaintenanceMovedLot = z.infer<typeof CatalogMaintenanceMovedLotSchema>

export const CatalogMaintenanceMovePackageResponseSchema = z.object({
  outcome: CatalogMaintenanceMovePackageOutcomeSchema,
  targetLocationId: z.number().int(),
  targetLocationName: z.string(),
  movedLots: z.array(CatalogMaintenanceMovedLotSchema),
})
export type CatalogMaintenanceMovePackageResponse = z.infer<
  typeof CatalogMaintenanceMovePackageResponseSchema
>
