import { z } from 'zod'

/**
 * Schemas for the brand_expiry_overrides admin surface.
 *
 * Backs:
 *   GET    /api/config/brand-expiry-overrides
 *   PUT    /api/config/brand-expiry-overrides/:brandName
 *   DELETE /api/config/brand-expiry-overrides/:brandName
 */

export const BrandExpiryOverrideSchema = z.object({
  brandId: z.number().int().nullable(),
  brandName: z.string(),
  expiryDays: z.number().int().min(1).max(30),
  notes: z.string().nullable(),
  updatedAt: z.string(),
  updatedByUserId: z.number().int().nullable(),
})
export type BrandExpiryOverride = z.infer<typeof BrandExpiryOverrideSchema>

export const BrandExpiryOverridesListResponseSchema = z.object({
  items: z.array(BrandExpiryOverrideSchema),
})
export type BrandExpiryOverridesListResponse = z.infer<typeof BrandExpiryOverridesListResponseSchema>

export const BrandExpiryOverrideUpsertRequestSchema = z.object({
  expiryDays: z.coerce.number().int().min(1).max(30),
  brandId: z.coerce.number().int().positive().nullable().optional(),
  notes: z.string().trim().min(1).max(500).nullable().optional(),
})
export type BrandExpiryOverrideUpsertRequest = z.infer<typeof BrandExpiryOverrideUpsertRequestSchema>

export const BrandExpiryOverrideResponseSchema = z.object({
  item: BrandExpiryOverrideSchema,
})
export type BrandExpiryOverrideResponse = z.infer<typeof BrandExpiryOverrideResponseSchema>
