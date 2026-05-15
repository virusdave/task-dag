import { z } from 'zod'

export const HELIOS_SCREENS_BRONX_SITE_DEALER_ID = 210249
export const HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID = 210705

export const HeliosScreensSiteDealerSchema = z.object({
  dealerId: z.number().int().positive(),
  dealerName: z.string().trim().min(1),
})
export type HeliosScreensSiteDealer = z.infer<typeof HeliosScreensSiteDealerSchema>

export const HELIOS_SCREENS_SITE_DEALERS: ReadonlyArray<HeliosScreensSiteDealer> = [
  {
    dealerId: HELIOS_SCREENS_BRONX_SITE_DEALER_ID,
    dealerName: 'Freshly Baked NYC - The Bronx',
  },
  {
    dealerId: HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID,
    dealerName: 'Freshly Baked NYC - Midtown',
  },
]

export const HELIOS_SCREENS_BRONX_TO_MIDTOWN_IMAGE_FALLBACK_BANNER_NAMES = [
  'Fresh & INTENSE',
  'Priced to MOVE 5',
  'Priced to MOVE 10',
  'Priced to MOVE 15',
] as const

export const HELIOS_SCREENS_PRICED_TO_MOVE_PROMO_BANNER_NAMES = [
  'Priced to MOVE 5',
  'Priced to MOVE 10',
  'Priced to MOVE 15',
] as const

export const HeliosScreensPromoActionBindingSchema = z.object({
  actionId: z.string().trim().min(1),
  actionName: z.string().trim().min(1),
  bannerName: z.string().trim().min(1),
})
export type HeliosScreensPromoActionBinding = z.infer<typeof HeliosScreensPromoActionBindingSchema>

export const HELIOS_SCREENS_PRICED_TO_MOVE_PROMO_ACTIONS = [
  {
    actionId: '42260',
    actionName: 'Movers 5% off',
    bannerName: HELIOS_SCREENS_PRICED_TO_MOVE_PROMO_BANNER_NAMES[0],
  },
  {
    actionId: '42261',
    actionName: 'Movers 10% off',
    bannerName: HELIOS_SCREENS_PRICED_TO_MOVE_PROMO_BANNER_NAMES[1],
  },
  {
    actionId: '42262',
    actionName: 'Movers 15% off',
    bannerName: HELIOS_SCREENS_PRICED_TO_MOVE_PROMO_BANNER_NAMES[2],
  },
] as const satisfies ReadonlyArray<HeliosScreensPromoActionBinding>

export const HELIOS_SCREENS_FRESH_AND_INTENSE_BANNER_NAME = 'Fresh & INTENSE'
export const HELIOS_SCREENS_FRESH_AND_INTENSE_CAMPAIGN_ID = '12749'
export const HELIOS_SCREENS_FRESH_AND_INTENSE_CAMPAIGN_NAME = 'New Arrivals'
export const HELIOS_SCREENS_FRESH_AND_INTENSE_ACTION_ID = '42264'
export const HELIOS_SCREENS_FRESH_AND_INTENSE_ACTION_NAME = 'Fresh & Intense'

export const ScreensRunModeSchema = z.enum(['apply', 'dry_run'])
export type ScreensRunMode = z.infer<typeof ScreensRunModeSchema>

export const ScreensBannerRefreshModeSchema = ScreensRunModeSchema
export type ScreensBannerRefreshMode = ScreensRunMode

export const ScreensBannerRefreshIntentSchema = z.enum(['refresh', 'bounce'])
export type ScreensBannerRefreshIntent = z.infer<typeof ScreensBannerRefreshIntentSchema>

export const SCREENS_BANNER_BOUNCE_DEFAULT_HOLD_SECONDS = 30
export const SCREENS_BANNER_REFRESH_MAX_HOLD_SECONDS = 300

export const ScreensBannerRefreshJobPayloadSchema = z.object({
  mode: ScreensBannerRefreshModeSchema,
  requestedByUserId: z.number().int().positive().nullable().optional(),
  siteDealerIds: z.array(z.number().int().positive()).default([]),
  holdSeconds: z.number().nonnegative().max(SCREENS_BANNER_REFRESH_MAX_HOLD_SECONDS).default(0),
  intent: ScreensBannerRefreshIntentSchema.default('refresh'),
})
export type ScreensBannerRefreshJobPayload = z.infer<typeof ScreensBannerRefreshJobPayloadSchema>

export const ScreensEnableHealthyBannersJobPayloadSchema = z.object({
  mode: ScreensRunModeSchema,
  requestedByUserId: z.number().int().positive().nullable().optional(),
  siteDealerIds: z.array(z.number().int().positive()).default([]),
})
export type ScreensEnableHealthyBannersJobPayload = z.infer<typeof ScreensEnableHealthyBannersJobPayloadSchema>

export const ScreensBannerHealthMaintenanceTriggerSchema = z.enum(['manual_queue', 'scheduled'])
export type ScreensBannerHealthMaintenanceTrigger = z.infer<typeof ScreensBannerHealthMaintenanceTriggerSchema>

export const ScreensBannerHealthMaintenanceJobPayloadSchema = z.object({
  mode: ScreensRunModeSchema,
  requestedByUserId: z.number().int().positive().nullable().optional(),
  siteDealerIds: z.array(z.number().int().positive()).default([]),
  trigger: ScreensBannerHealthMaintenanceTriggerSchema.default('manual_queue'),
})
export type ScreensBannerHealthMaintenanceJobPayload = z.infer<typeof ScreensBannerHealthMaintenanceJobPayloadSchema>

export const ScreensBronxMidtownImageCloneJobPayloadSchema = z.object({
  mode: ScreensRunModeSchema,
  requestedByUserId: z.number().int().positive().nullable().optional(),
})
export type ScreensBronxMidtownImageCloneJobPayload = z.infer<typeof ScreensBronxMidtownImageCloneJobPayloadSchema>

export const ScreensMidtownPricedToMovePromoRebindJobPayloadSchema = z.object({
  mode: ScreensRunModeSchema,
  requestedByUserId: z.number().int().positive().nullable().optional(),
})
export type ScreensMidtownPricedToMovePromoRebindJobPayload = z.infer<typeof ScreensMidtownPricedToMovePromoRebindJobPayloadSchema>

export const ScreensMidtownFreshAndIntensePromoRebindJobPayloadSchema = z.object({
  mode: ScreensRunModeSchema,
  requestedByUserId: z.number().int().positive().nullable().optional(),
})
export type ScreensMidtownFreshAndIntensePromoRebindJobPayload = z.infer<typeof ScreensMidtownFreshAndIntensePromoRebindJobPayloadSchema>

export const ScreensImageBannerSyncTargetSchema = z.object({
  dealerId: z.number().int().positive(),
  screenId: z.number().int().positive(),
})
export type ScreensImageBannerSyncTarget = z.infer<typeof ScreensImageBannerSyncTargetSchema>

export const ScreensImageBannerSyncJobPayloadSchema = z.object({
  mode: ScreensRunModeSchema,
  requestedByUserId: z.number().int().positive().nullable().optional(),
  sourceBannerIds: z.array(z.string().trim().min(1)).min(1),
  sourceDealerId: z.number().int().positive(),
  sourceScreenId: z.number().int().positive(),
  targetScreens: z.array(ScreensImageBannerSyncTargetSchema).min(1),
})
export type ScreensImageBannerSyncJobPayload = z.infer<typeof ScreensImageBannerSyncJobPayloadSchema>

export function listHeliosScreensSiteDealers(): ReadonlyArray<HeliosScreensSiteDealer> {
  return HELIOS_SCREENS_SITE_DEALERS
}

export function getHeliosScreensSiteDealer(dealerId: number): HeliosScreensSiteDealer | null {
  return HELIOS_SCREENS_SITE_DEALERS.find((dealer) => dealer.dealerId === dealerId) ?? null
}

export function normalizeHeliosScreensSiteDealerIds(dealerIds: number[]): number[] {
  return [...new Set(dealerIds)]
    .filter((dealerId) => getHeliosScreensSiteDealer(dealerId) !== null)
    .sort((left, right) => left - right)
}
