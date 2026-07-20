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
  inventoryBarcode: z.string().nullable(),
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
  imageUrl: z.string().url().nullable(),
  isCannabis: z.boolean(),
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

export const LOW_INVENTORY_DEFAULT_DESTINATION = 'NOT FOR SALE - Quantity Audit'
export const LOW_INVENTORY_TRANSFERS_ENABLED_BY_DEFAULT = true
export const LowInventoryClassificationSchema = z.enum(['equal', 'short', 'zero', 'over', 'held'])
export type LowInventoryClassification = z.infer<typeof LowInventoryClassificationSchema>

export const LowInventoryCountRequestSchema = z.object({
  dealerId: z.number().int().positive(),
  productId: z.number().int().positive(),
  inventoryItemId: z.string().trim().min(1),
  snapshotObservedAt: z.string().datetime(),
  physicalCount: z.number().nonnegative(),
}).strict()
export type LowInventoryCountRequest = z.infer<typeof LowInventoryCountRequestSchema>

export const LowInventoryCountBodySchema = LowInventoryCountRequestSchema.extend({
  metrcTag: z.string().trim().min(1).nullable(),
  sourceLocation: z.string().trim().min(1),
  snapshotCurrentQty: z.number().nonnegative(),
  snapshotAvailableQty: z.number().nonnegative(),
  snapshotHoldQty: z.number().nonnegative().nullable(),
  classification: LowInventoryClassificationSchema,
}).strict()
export type LowInventoryCountBody = z.infer<typeof LowInventoryCountBodySchema>

export const LowInventoryNotificationStatusSchema = z.enum(['not_requested', 'sent', 'failed'])
export const LowInventoryCountResponseSchema = z.object({
  auditId: z.number().int().positive(),
  notificationStatus: LowInventoryNotificationStatusSchema,
})

export const LowInventoryAuditListRequestSchema = z.object({
  dealerId: z.coerce.number().int().positive(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})
export const LowInventoryAuditResultSchema = LowInventoryCountBodySchema.extend({
  auditId: z.number().int().positive(),
  actorLabel: z.string(),
  createdAt: z.string().datetime(),
  transferStatus: z.enum(['not_applicable', 'pending', 'resolved']),
  transferAuditId: z.number().int().positive().nullable(),
})
export type LowInventoryAuditResult = z.infer<typeof LowInventoryAuditResultSchema>
export const LowInventoryAuditListResponseSchema = z.object({
  items: z.array(LowInventoryAuditResultSchema),
})

export const LowInventoryTransferConfigBodySchema = z.object({
  dealerId: z.number().int().positive(),
  destinationName: z.string().trim().min(1).max(200).refine(
    (name) => name.toLowerCase().startsWith('not for sale'),
    'Destination must be a NOT FOR SALE room.',
  ),
  transferEnabled: z.boolean(),
}).strict()
export type LowInventoryTransferConfigBody = z.infer<typeof LowInventoryTransferConfigBodySchema>
export const LowInventoryTransferConfigResponseSchema = LowInventoryTransferConfigBodySchema.extend({
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
})
export type LowInventoryTransferConfigResponse = z.infer<typeof LowInventoryTransferConfigResponseSchema>

export const LowInventoryTransferBodySchema = z.object({
  dealerId: z.number().int().positive(),
  countAuditId: z.number().int().positive(),
  confirmedConfigUpdatedAt: z.string().nullable(),
  confirmedDestinationName: z.string().trim().min(1).max(200),
}).strict()
export const LowInventoryTransferResponseSchema = z.object({
  transferAuditId: z.number().int().positive(),
  countAuditId: z.number().int().positive(),
  movedQty: z.number().positive(),
  notificationStatus: LowInventoryNotificationStatusSchema,
})
export type LowInventoryTransferResponse = z.infer<typeof LowInventoryTransferResponseSchema>
export const LowInventoryCountClassificationSchema = z.enum([
  'equal',
  'short',
  'zero',
  'zero-held',
  'over',
])
export type LowInventoryCountClassification = z.infer<
  typeof LowInventoryCountClassificationSchema
>

export const LowInventoryCountResolutionStatusSchema = z.enum(['not-needed', 'pending'])
export type LowInventoryCountResolutionStatus = z.infer<
  typeof LowInventoryCountResolutionStatusSchema
>

export const LowInventoryCountCaptureBodySchema = z
  .object({
    dealerId: z.coerce.number().int().positive(),
    inventoryItemId: z.string().trim().min(1).max(128),
    physicalQty: z.number().finite().min(0).max(1_000_000).multipleOf(0.001),
    requestId: z.string().uuid(),
  })
  .strict()
export type LowInventoryCountCaptureBody = z.infer<typeof LowInventoryCountCaptureBodySchema>

export const LowInventoryCountRecordSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().uuid(),
  dealerId: z.number().int().positive(),
  inventoryItemId: z.string().min(1),
  productId: z.number().int().positive(),
  productSku: z.string().nullable(),
  productName: z.string().nullable(),
  physicalQty: z.number(),
  classification: LowInventoryCountClassificationSchema,
  resolutionStatus: LowInventoryCountResolutionStatusSchema,
  actor: z.object({
    userId: z.number().int().positive(),
    email: z.string().email(),
    name: z.string().min(1),
  }),
  capturedAt: z.string().datetime(),
  sweedSnapshot: z.object({
    currentQty: z.number(),
    holdQty: z.number().nullable(),
    availableQty: z.number().nullable(),
    stockLocation: z.string().min(1),
    internalTrackCode: z.string().nullable(),
    metrcTag: z.string().nullable(),
    observedAt: z.string().datetime(),
  }),
})
export type LowInventoryCountRecord = z.infer<typeof LowInventoryCountRecordSchema>

export const LowInventoryCountCaptureResponseSchema = z.object({
  count: LowInventoryCountRecordSchema,
  inventoryChanged: z.literal(false),
  notificationSent: z.literal(false),
})
export type LowInventoryCountCaptureResponse = z.infer<
  typeof LowInventoryCountCaptureResponseSchema
>
