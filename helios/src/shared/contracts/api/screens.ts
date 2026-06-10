import { z } from 'zod'

import {
  ScreensBannerBulkToggleTargetSchema,
  ScreensBannerDuplicateTargetSchema,
  ScreensImageBannerSyncTargetSchema,
  ScreensRunModeSchema,
} from '../domain/screens.js'

export const ScreensInventoryBannerSchema = z.object({
  bannerId: z.string().trim().min(1),
  bannerName: z.string().trim().min(1),
  duration: z.number().int().min(0).nullable(),
  enabled: z.boolean(),
  promoActionId: z.string().trim().min(1).nullable(),
  totalDuration: z.number().int().min(0).nullable(),
  type: z.string().trim().min(1),
})
export type ScreensInventoryBanner = z.infer<typeof ScreensInventoryBannerSchema>

export const ScreensInventoryDeviceSchema = z.object({
  banners: z.array(ScreensInventoryBannerSchema),
  screenEnabled: z.boolean().nullable(),
  screenId: z.number().int().positive(),
  screenName: z.string().trim().min(1),
  totalScreenDuration: z.number().int().min(0).nullable(),
})
export type ScreensInventoryDevice = z.infer<typeof ScreensInventoryDeviceSchema>

export const ScreensInventorySiteSchema = z.object({
  dealerId: z.number().int().positive(),
  dealerName: z.string().trim().min(1),
  screens: z.array(ScreensInventoryDeviceSchema),
})
export type ScreensInventorySite = z.infer<typeof ScreensInventorySiteSchema>

export const ScreensInventorySourceSchema = z.object({
  artifactKind: z.enum(['direct_readback', 'refresh_run']),
  artifactPath: z.string().trim().min(1),
  capturedAt: z.iso.datetime(),
  mode: ScreensRunModeSchema.nullable(),
})
export type ScreensInventorySource = z.infer<typeof ScreensInventorySourceSchema>

export const ScreensInventorySummarySchema = z.object({
  bannerCount: z.number().int().min(0),
  imageBannerCount: z.number().int().min(0),
  screenCount: z.number().int().min(0),
  siteCount: z.number().int().min(0),
  zeroDurationBannerCount: z.number().int().min(0),
})
export type ScreensInventorySummary = z.infer<typeof ScreensInventorySummarySchema>

export const ScreensInventoryResponseSchema = z.object({
  configuredSiteDealers: z.array(z.number().int().positive()),
  inventorySource: ScreensInventorySourceSchema.nullable(),
  sites: z.array(ScreensInventorySiteSchema),
  summary: ScreensInventorySummarySchema,
})
export type ScreensInventoryResponse = z.infer<typeof ScreensInventoryResponseSchema>

export const QueueScreensImageBannerSyncRequestSchema = z.object({
  apply: z.boolean().default(false),
  reason: z.string().trim().max(500).nullable().optional(),
  sourceBannerIds: z.array(z.string().trim().min(1)).min(1),
  sourceDealerId: z.number().int().positive(),
  sourceScreenId: z.number().int().positive(),
  targetScreens: z.array(ScreensImageBannerSyncTargetSchema).min(1),
})
export type QueueScreensImageBannerSyncRequest = z.infer<typeof QueueScreensImageBannerSyncRequestSchema>

export const QueueScreensBannerDuplicateRequestSchema = z.object({
  apply: z.boolean().default(false),
  reason: z.string().trim().max(500).nullable().optional(),
  sourceBannerIds: z.array(z.string().trim().min(1)).min(1),
  sourceDealerId: z.number().int().positive(),
  sourceScreenId: z.number().int().positive(),
  targetScreens: z.array(ScreensBannerDuplicateTargetSchema).min(1),
})
export type QueueScreensBannerDuplicateRequest = z.infer<typeof QueueScreensBannerDuplicateRequestSchema>

export const QueueScreensBannerBulkToggleRequestSchema = z.object({
  apply: z.boolean().default(false),
  desiredEnabled: z.boolean(),
  reason: z.string().trim().max(500).nullable().optional(),
  target: ScreensBannerBulkToggleTargetSchema,
})
export type QueueScreensBannerBulkToggleRequest = z.infer<typeof QueueScreensBannerBulkToggleRequestSchema>
