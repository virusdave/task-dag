import { z } from 'zod'

export const LOW_INVENTORY_DEFAULT_THRESHOLD = 2
export const LOW_INVENTORY_MAX_THRESHOLD = 100
export const LOW_INVENTORY_STALE_AFTER_MINUTES = 15

export const LowInventoryThresholdSchema = z
  .number()
  .int()
  .min(1)
  .max(LOW_INVENTORY_MAX_THRESHOLD)

export const LowInventoryRequestSchema = z.object({
  dealerId: z.coerce.number().int().positive(),
})
export type LowInventoryRequest = z.infer<typeof LowInventoryRequestSchema>

export const LowInventoryConfigPutBodySchema = z
  .object({
    threshold: LowInventoryThresholdSchema,
  })
  .strict()
export type LowInventoryConfigPutBody = z.infer<typeof LowInventoryConfigPutBodySchema>

export const LowInventoryConfigResponseSchema = z.object({
  threshold: LowInventoryThresholdSchema,
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
})
export type LowInventoryConfigResponse = z.infer<typeof LowInventoryConfigResponseSchema>

export const LowInventoryLocationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('shelf'), label: z.string().min(1) }),
  z.object({ kind: z.literal('stock-room'), label: z.string().min(1) }),
])
export type LowInventoryLocation = z.infer<typeof LowInventoryLocationSchema>

export const LowInventoryPackageSchema = z.object({
  availableQty: z.number(),
  currentQty: z.number().nullable(),
  holdQty: z.number().nullable(),
  internalTrackCode: z.string().nullable(),
  inventoryItemId: z.string().min(1),
  metrcTag: z.string().nullable(),
  observedAt: z.string().datetime(),
  productId: z.number().int().positive(),
  productName: z.string().nullable(),
  stockLocation: z.string().min(1),
})
export type LowInventoryPackage = z.infer<typeof LowInventoryPackageSchema>

export const LowInventorySkuSchema = z.object({
  categoryName: z.string().nullable(),
  combinedAvailableQty: z.number(),
  packages: z.array(LowInventoryPackageSchema),
  productIds: z.array(z.number().int().positive()),
  productName: z.string().nullable(),
  productSku: z.string().nullable(),
  subcategoryName: z.string().nullable(),
})
export type LowInventorySku = z.infer<typeof LowInventorySkuSchema>

export const LowInventoryLocationGroupSchema = z.object({
  location: LowInventoryLocationSchema,
  skus: z.array(LowInventorySkuSchema),
})
export type LowInventoryLocationGroup = z.infer<typeof LowInventoryLocationGroupSchema>

export const LowInventoryReadModelSchema = z.object({
  dealerId: z.number().int().positive(),
  locationGroups: z.array(LowInventoryLocationGroupSchema),
  snapshotObservedAt: z.string().datetime().nullable(),
  threshold: LowInventoryThresholdSchema,
})
export type LowInventoryReadModel = z.infer<typeof LowInventoryReadModelSchema>

export const LowInventoryFreshnessSchema = z.object({
  isStale: z.boolean(),
  staleAfterMinutes: z.number().int().positive(),
})
export type LowInventoryFreshness = z.infer<typeof LowInventoryFreshnessSchema>

export const LowInventoryResponseSchema = z.object({
  data: LowInventoryReadModelSchema,
  freshness: LowInventoryFreshnessSchema,
  site: z.object({
    dealerId: z.number().int().positive(),
    siteKey: z.string().min(1),
    siteLabel: z.string().min(1),
  }),
})
export type LowInventoryResponse = z.infer<typeof LowInventoryResponseSchema>
