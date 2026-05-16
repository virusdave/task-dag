import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import {
  HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID,
  HELIOS_SCREENS_PRICED_TO_MOVE_PROMO_ACTIONS,
  getHeliosScreensSiteDealer,
  type ScreensMidtownPricedToMovePromoRebindJobPayload,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'
import { callSweedRpc } from '../sweed/rpc.js'

const PRODUCT_MENU_TYPE_ID = 3
const CARD_LAYOUT_TYPE_ID = 2
const STANDARD_PRODUCTS_DISPLAYED = 3
const STANDARD_BANNER_DURATION_SECONDS = 5

const ScreensMidtownPricedToMovePromoRebindArtifactSchema = z.object({
  finishedAt: z.string(),
  mode: z.enum(['apply', 'dry-run']),
  promoActions: z.array(
    z
      .object({
        actionId: z.string(),
        actionName: z.string(),
        bannerName: z.string(),
        finalEnabled: z.boolean(),
      })
      .passthrough(),
  ),
  screens: z.array(
    z
      .object({
        createdProductMenuBanners: z
          .array(
            z
              .object({
                bannerId: z.string(),
                bannerName: z.string(),
                finalEnabled: z.boolean().optional(),
                finalTotalDuration: z.number().int().optional(),
              })
              .passthrough(),
          )
          .optional()
          .default([]),
        plannedProductMenuBanners: z
          .array(z.object({ bannerName: z.string() }).passthrough())
          .optional()
          .default([]),
        screenId: z.number().int(),
        screenName: z.string(),
        skippedTargets: z
          .array(
            z
              .object({
                bannerName: z.string(),
                reason: z.string(),
              })
              .passthrough(),
          )
          .optional()
          .default([]),
      })
      .passthrough(),
  ),
  sourceCloneArtifactPath: z.string().optional(),
  startedAt: z.string(),
})
type ScreensMidtownPricedToMovePromoRebindArtifact = z.infer<
  typeof ScreensMidtownPricedToMovePromoRebindArtifactSchema
>

const ScreenListResponseSchema = z
  .object({
    data: z.array(
      z
        .object({
          enabled: z.boolean(),
          id: z.coerce.number().int().positive(),
          name: z.string().trim().min(1),
        })
        .passthrough(),
    ),
  })
  .passthrough()

const BannerListResponseSchema = z.array(
  z
    .object({
      enabled: z.boolean(),
      id: z.union([z.string(), z.number()]).transform((value) => String(value)),
      name: z.string().trim().min(1),
      ordering: z.coerce.number().int().nullable().optional(),
      totalDuration: z.coerce.number().int().nullable().optional(),
      type: z.union([
        z.string().trim().min(1),
        z.object({ name: z.string().trim().min(1) }).passthrough().transform((value) => value.name),
      ]),
    })
    .passthrough(),
)

const BannerDetailSchema = z
  .object({
    brands: z.unknown().optional(),
    categories: z.unknown().optional(),
    cronExpression: z.string().nullable().optional(),
    duration: z.coerce.number().int().nullable().optional(),
    enabled: z.boolean(),
    fromDate: z.string().nullable().optional(),
    fromTime: z.string().nullable().optional(),
    id: z.union([z.string(), z.number()]).transform((value) => String(value)),
    layoutType: z.object({ id: z.coerce.number().int() }).passthrough().nullable().optional(),
    maxWholesaleCost: z.unknown().optional(),
    media: z.object({ id: z.string().trim().min(1) }).passthrough().nullable().optional(),
    minWholesaleCost: z.unknown().optional(),
    name: z.string().trim().min(1),
    ordering: z.coerce.number().int().nullable().optional(),
    productGroups: z.unknown().optional(),
    productTypes: z.unknown().optional(),
    products: z.unknown().optional(),
    promoActionId: z
      .union([z.string(), z.number()])
      .transform((value) => String(value))
      .nullable()
      .optional(),
    qualityLines: z.unknown().optional(),
    screenId: z.coerce.number().int().positive(),
    sizes: z.unknown().optional(),
    subCategories: z.unknown().optional(),
    toDate: z.string().nullable().optional(),
    toTime: z.string().nullable().optional(),
    totalDuration: z.coerce.number().int().nullable().optional(),
    type: z.object({ id: z.coerce.number().int(), name: z.string().trim().min(1) }).passthrough(),
    usePromoHeader: z.boolean().nullable().optional(),
  })
  .passthrough()

type BannerDetail = z.infer<typeof BannerDetailSchema>

const PromoActionDetailSchema = z
  .object({
    enabled: z.boolean(),
    id: z.union([z.string(), z.number()]).transform((value) => String(value)),
    name: z.string(),
  })
  .passthrough()

export async function runScreensMidtownPricedToMovePromoRebindJob(
  context: JobHandlerContext,
  payload: ScreensMidtownPricedToMovePromoRebindJobPayload,
): Promise<void> {
  const artifactPath = await runScreensMidtownPricedToMovePromoRebindInline(context.id, payload)
  const artifact = ScreensMidtownPricedToMovePromoRebindArtifactSchema.parse(
    JSON.parse(await readFile(artifactPath, 'utf-8')),
  )
  const summary = summarizeArtifact(artifact)

  await withTransaction(async (db) => {
    await db.query(
      `
        update job_queue
        set payload_json = payload_json || $2::jsonb,
            updated_at = now()
        where id = $1
      `,
      [
        context.id,
        JSON.stringify({
          artifactPath,
          completedAt: artifact.finishedAt,
          runSummary: summary,
        }),
      ],
    )

    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(context.id),
      entityType: 'job',
      eventType: 'screens.midtown_priced_to_move_promo_rebind.completed',
      module: 'screens',
      payload: {
        actionIds: artifact.promoActions.map((action) => action.actionId),
        actionNames: artifact.promoActions.map((action) => action.actionName),
        artifactPath,
        bannerNames: HELIOS_SCREENS_PRICED_TO_MOVE_PROMO_ACTIONS.map((action) => action.bannerName),
        createdReplacementCount: summary.createdReplacementCount,
        enabledReplacementCount: summary.enabledReplacementCount,
        mode: artifact.mode,
        plannedReplacementCount: summary.plannedReplacementCount,
        promoActionCount: summary.promoActionCount,
        queuedJobId: context.id,
        screenCount: summary.screenCount,
        skippedTargetCount: summary.skippedTargetCount,
        sourceCloneArtifactPath: artifact.sourceCloneArtifactPath ?? null,
        summary: buildCompletionSummary(artifact.mode, summary),
        targetDealerId: HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID,
        targetDealerName: readDealerName(HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID),
        zeroDurationDisabledCount: summary.zeroDurationDisabledCount,
      },
      requestId: randomUUID(),
      scope: context.scope,
      undoPayload: null,
    })
  })
}

async function runScreensMidtownPricedToMovePromoRebindInline(
  jobId: number,
  payload: ScreensMidtownPricedToMovePromoRebindJobPayload,
): Promise<string> {
  const startedAt = new Date().toISOString()
  const mode: 'apply' | 'dry-run' = payload.mode === 'apply' ? 'apply' : 'dry-run'
  const dealerId = HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID

  // 1) Ensure each Velocity Boosters promo action exists, has the expected name, and is enabled.
  const promoActionsArtifact: ScreensMidtownPricedToMovePromoRebindArtifact['promoActions'] = []
  const promoActionByBannerName = new Map<string, { actionId: string }>()
  for (const promo of HELIOS_SCREENS_PRICED_TO_MOVE_PROMO_ACTIONS) {
    const detail = PromoActionDetailSchema.parse(
      await callSweedRpc(dealerId, 'store.promo.action.get', { id: promo.actionId }),
    )
    if (detail.name !== promo.actionName) {
      throw new Error(
        `Promo action ${promo.actionId} resolved to ${detail.name} instead of ${promo.actionName}.`,
      )
    }
    if (mode === 'apply' && !detail.enabled) {
      await callSweedRpc(dealerId, 'store.promo.action.edit', { id: promo.actionId, enabled: true })
    }
    promoActionsArtifact.push({
      actionId: detail.id,
      actionName: detail.name,
      bannerName: promo.bannerName,
      finalEnabled: mode === 'apply' ? true : detail.enabled,
    })
    promoActionByBannerName.set(promo.bannerName, { actionId: detail.id })
  }

  // 2) For each Midtown screen, find existing image banners by target name and replace them with promo product-menu banners.
  const screens = await listScreens(dealerId)
  const screenArtifacts: ScreensMidtownPricedToMovePromoRebindArtifact['screens'] = []

  for (const screen of screens) {
    const existing = await listScreenBanners(dealerId, screen.screenId)
    const existingByName = new Map(existing.map((banner) => [banner.name, banner]))

    const plannedProductMenuBanners: ScreensMidtownPricedToMovePromoRebindArtifact['screens'][number]['plannedProductMenuBanners'] =
      []
    const skippedTargets: ScreensMidtownPricedToMovePromoRebindArtifact['screens'][number]['skippedTargets'] = []
    const createdProductMenuBanners: ScreensMidtownPricedToMovePromoRebindArtifact['screens'][number]['createdProductMenuBanners'] =
      []

    for (const promo of HELIOS_SCREENS_PRICED_TO_MOVE_PROMO_ACTIONS) {
      const existingBanner = existingByName.get(promo.bannerName)
      // If we already have a product-menu banner with the right name, treat as done.
      if (existingBanner && existingBanner.type.toLowerCase() !== 'image') {
        continue
      }
      if (!existingBanner) {
        skippedTargets.push({ bannerName: promo.bannerName, reason: 'image_banner_not_found' })
        continue
      }
      plannedProductMenuBanners.push({ bannerName: promo.bannerName })

      if (mode !== 'apply') {
        continue
      }

      const existingDetail = await getBannerDetail(dealerId, existingBanner.bannerId)
      const ordering = existingDetail.ordering ?? existingBanner.ordering ?? 1
      const duration = existingDetail.duration ?? STANDARD_BANNER_DURATION_SECONDS
      const actionId = promoActionByBannerName.get(promo.bannerName)!.actionId

      const createdId = await addProductMenuBanner(dealerId, {
        duration,
        name: promo.bannerName,
        ordering,
        promoActionId: actionId,
        screenId: screen.screenId,
      })

      // Disable + delete the old image banner.
      if (existingDetail.enabled) {
        await setBannerEnabledFromDetail(dealerId, existingDetail, false)
      }
      await callSweedRpc(dealerId, 'store.screen.carousel.edit', {
        enabled: false,
        id: screen.screenId,
      })
      await callSweedRpc(dealerId, 'store.screen.carousel.banner.delete', { id: existingDetail.id })

      // Enable the created banner (and force-off if zero-duration).
      let createdDetail = await getBannerDetail(dealerId, createdId)
      await setBannerEnabledFromDetail(dealerId, createdDetail, true)
      createdDetail = await getBannerDetail(dealerId, createdId)
      if ((createdDetail.totalDuration ?? 0) === 0 && createdDetail.enabled) {
        await setBannerEnabledFromDetail(dealerId, createdDetail, false)
        createdDetail = await getBannerDetail(dealerId, createdId)
      }
      createdProductMenuBanners.push({
        bannerId: createdId,
        bannerName: promo.bannerName,
        finalEnabled: createdDetail.enabled,
        finalTotalDuration: createdDetail.totalDuration ?? 0,
      })

      // Re-enable the screen.
      await callSweedRpc(dealerId, 'store.screen.carousel.edit', {
        enabled: true,
        id: screen.screenId,
      })
    }

    screenArtifacts.push({
      createdProductMenuBanners,
      plannedProductMenuBanners,
      screenId: screen.screenId,
      screenName: screen.screenName,
      skippedTargets,
    })
  }

  const finishedAt = new Date().toISOString()
  const artifact: ScreensMidtownPricedToMovePromoRebindArtifact = {
    finishedAt,
    mode,
    promoActions: promoActionsArtifact,
    screens: screenArtifacts,
    startedAt,
  }

  const artifactDirectory = resolve(process.cwd(), 'runtime-artifacts/screens')
  await mkdir(artifactDirectory, { recursive: true })
  const outputPath = resolve(
    artifactDirectory,
    `screens-midtown-priced-to-move-promo-rebind-job-${jobId}-${finishedAt.replace(/[:.]/g, '-')}.json`,
  )
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8')
  return outputPath
}

function summarizeArtifact(artifact: ScreensMidtownPricedToMovePromoRebindArtifact): {
  createdReplacementCount: number
  enabledReplacementCount: number
  plannedReplacementCount: number
  promoActionCount: number
  screenCount: number
  skippedTargetCount: number
  zeroDurationDisabledCount: number
} {
  let plannedReplacementCount = 0
  let createdReplacementCount = 0
  let enabledReplacementCount = 0
  let skippedTargetCount = 0
  let zeroDurationDisabledCount = 0

  for (const screen of artifact.screens) {
    plannedReplacementCount += screen.plannedProductMenuBanners.length
    createdReplacementCount += screen.createdProductMenuBanners.length
    skippedTargetCount += screen.skippedTargets.length
    for (const banner of screen.createdProductMenuBanners) {
      if (banner.finalEnabled) {
        enabledReplacementCount += 1
        continue
      }
      if (banner.finalTotalDuration === 0) {
        zeroDurationDisabledCount += 1
      }
    }
  }

  return {
    createdReplacementCount,
    enabledReplacementCount,
    plannedReplacementCount,
    promoActionCount: artifact.promoActions.length,
    screenCount: artifact.screens.length,
    skippedTargetCount,
    zeroDurationDisabledCount,
  }
}

function buildCompletionSummary(
  mode: 'apply' | 'dry-run',
  summary: {
    createdReplacementCount: number
    enabledReplacementCount: number
    plannedReplacementCount: number
    promoActionCount: number
    screenCount: number
    skippedTargetCount: number
    zeroDurationDisabledCount: number
  },
): string {
  const skippedClause = summary.skippedTargetCount > 0
    ? ` ${summary.skippedTargetCount} target banner(s) were already missing and were skipped.`
    : ''

  if (mode === 'apply') {
    return `Applied Midtown Priced to MOVE promo rebinding across ${summary.screenCount} screen(s); planned ${summary.plannedReplacementCount} replacement(s), created ${summary.createdReplacementCount} promo-backed banner(s), ${summary.enabledReplacementCount} finished enabled, and ${summary.zeroDurationDisabledCount} remained disabled with zero duration.${skippedClause}`
  }

  return `Completed Midtown Priced to MOVE promo rebinding dry-run across ${summary.screenCount} screen(s); planned ${summary.plannedReplacementCount} replacement(s) using ${summary.promoActionCount} Velocity Boosters promo action(s).${skippedClause}`
}

function readDealerName(dealerId: number): string {
  return getHeliosScreensSiteDealer(dealerId)?.dealerName ?? `dealer ${dealerId}`
}

async function listScreens(
  dealerId: number,
): Promise<Array<{ enabled: boolean; screenId: number; screenName: string }>> {
  const result = ScreenListResponseSchema.parse(
    await callSweedRpc(dealerId, 'store.screen.carousel.list', { page: 1, pageSize: 200 }),
  )
  return result.data.map((screen) => ({
    enabled: screen.enabled,
    screenId: screen.id,
    screenName: screen.name,
  }))
}

async function listScreenBanners(
  dealerId: number,
  screenId: number,
): Promise<
  Array<{ bannerId: string; enabled: boolean; name: string; ordering: number | null; totalDuration: number | null; type: string }>
> {
  const result = BannerListResponseSchema.parse(
    await callSweedRpc(dealerId, 'store.screen.carousel.banner.list', { screenId }),
  )
  return result.map((banner) => ({
    bannerId: banner.id,
    enabled: banner.enabled,
    name: banner.name,
    ordering: banner.ordering ?? null,
    totalDuration: banner.totalDuration ?? null,
    type: banner.type,
  }))
}

async function getBannerDetail(dealerId: number, bannerId: string): Promise<BannerDetail> {
  return BannerDetailSchema.parse(await callSweedRpc(dealerId, 'store.screen.carousel.banner.get', { id: bannerId }))
}

async function addProductMenuBanner(
  dealerId: number,
  banner: {
    duration: number
    name: string
    ordering: number
    promoActionId: string
    screenId: number
  },
): Promise<string> {
  const result = await callSweedRpc<unknown>(dealerId, 'store.screen.carousel.banner.add', {
    cronExpression: '0 0 * * * *',
    duration: banner.duration,
    enabled: false,
    fromDate: new Date().toISOString().slice(0, 10),
    layoutTypeId: CARD_LAYOUT_TYPE_ID,
    name: banner.name,
    ordering: banner.ordering,
    promoActionId: banner.promoActionId,
    productsDisplayed: STANDARD_PRODUCTS_DISPLAYED,
    screenId: banner.screenId,
    showCategoryInHeader: true,
    showNumberOfItemsInHeader: true,
    typeId: PRODUCT_MENU_TYPE_ID,
    usePromoHeader: false,
  })

  if (typeof result === 'string' || typeof result === 'number') {
    return String(result)
  }
  if (result && typeof result === 'object' && 'id' in result) {
    const idValue = (result as { id: unknown }).id
    if (typeof idValue === 'string' || typeof idValue === 'number') {
      return String(idValue)
    }
  }

  throw new Error(`store.screen.carousel.banner.add returned no banner id for ${banner.name}.`)
}

async function setBannerEnabledFromDetail(
  dealerId: number,
  detail: BannerDetail,
  enabled: boolean,
): Promise<void> {
  if (detail.enabled === enabled) return
  await callSweedRpc(dealerId, 'store.screen.carousel.banner.edit', buildBannerEditParams(detail, enabled))
}

function buildBannerEditParams(detail: BannerDetail, enabled: boolean): Record<string, unknown> {
  const typeId = detail.type.id
  const params: Record<string, unknown> = {
    brands: normalizeSelectorIds(detail.brands),
    categories: normalizeSelectorIds(detail.categories),
    enabled,
    fromDate: toDateOnly(detail.fromDate),
    id: detail.id,
    maxWholesaleCost: detail.maxWholesaleCost ?? null,
    minWholesaleCost: detail.minWholesaleCost ?? null,
    productGroups: normalizeSelectorIds(detail.productGroups),
    productTypes: normalizeSelectorIds(detail.productTypes),
    products: normalizeSelectorIds(detail.products),
    promoActionId: detail.promoActionId ?? null,
    qualityLines: normalizeSelectorIds(detail.qualityLines),
    sizes: normalizeSelectorIds(detail.sizes),
    subCategories: normalizeSelectorIds(detail.subCategories),
    toDate: toDateOnly(detail.toDate),
    typeId,
    usePromoHeader: detail.usePromoHeader ?? false,
  }

  if (typeId === PRODUCT_MENU_TYPE_ID) {
    params.layoutTypeId = CARD_LAYOUT_TYPE_ID
    params.productsDisplayed = STANDARD_PRODUCTS_DISPLAYED
  } else if (detail.layoutType?.id) {
    params.layoutTypeId = detail.layoutType.id
  }

  if (detail.cronExpression !== undefined) {
    params.cronExpression = detail.cronExpression
  }
  if (detail.fromTime !== undefined) {
    params.fromTime = detail.fromTime
  }
  if (detail.toTime !== undefined) {
    params.toTime = detail.toTime
  }
  if (detail.duration !== undefined && detail.duration !== null) {
    params.duration = detail.duration
  }

  return params
}

function normalizeSelectorIds(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null
  }
  if (Array.isArray(value) && value.every((item) => item && typeof item === 'object' && 'id' in item)) {
    return value
      .map((item) => (item as { id: unknown }).id)
      .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
  }
  return value
}

function toDateOnly(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  const separatorIndex = value.indexOf('T')
  return separatorIndex === -1 ? value : value.slice(0, separatorIndex)
}
