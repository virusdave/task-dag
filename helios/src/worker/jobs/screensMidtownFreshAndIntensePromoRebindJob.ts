import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import {
  HELIOS_SCREENS_FRESH_AND_INTENSE_ACTION_ID,
  HELIOS_SCREENS_FRESH_AND_INTENSE_ACTION_NAME,
  HELIOS_SCREENS_FRESH_AND_INTENSE_BANNER_NAME,
  HELIOS_SCREENS_FRESH_AND_INTENSE_CAMPAIGN_ID,
  HELIOS_SCREENS_FRESH_AND_INTENSE_CAMPAIGN_NAME,
  HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID,
  getHeliosScreensSiteDealer,
  type ScreensMidtownFreshAndIntensePromoRebindJobPayload,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'
import { callSweedRpc } from '../sweed/rpc.js'

const PRODUCT_MENU_TYPE_ID = 3
const CARD_LAYOUT_TYPE_ID = 2
const STANDARD_PRODUCTS_DISPLAYED = 3
const STANDARD_BANNER_DURATION_SECONDS = 5

const ScreensMidtownFreshAndIntensePromoRebindArtifactSchema = z.object({
  action: z
    .object({
      id: z.string().nullable().optional(),
      name: z.string(),
      readyForReplacement: z.boolean().optional(),
      selectorProductCount: z.number().int().nullable().optional(),
      status: z.string(),
    })
    .passthrough(),
  campaign: z
    .object({
      id: z.string().nullable().optional(),
      name: z.string(),
      status: z.string(),
    })
    .passthrough(),
  finishedAt: z.string(),
  mode: z.enum(['apply', 'dry-run']),
  screens: z.array(
    z
      .object({
        deletedImageBanner: z
          .object({ bannerId: z.string(), bannerName: z.string() })
          .passthrough()
          .nullable()
          .optional(),
        keptImageFallback: z
          .object({ bannerId: z.string(), bannerName: z.string() })
          .passthrough()
          .nullable()
          .optional(),
        newProductMenuBanner: z
          .object({
            bannerId: z.string(),
            bannerName: z.string(),
            finalEnabled: z.boolean().optional(),
            finalTotalDuration: z.number().int().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        plannedProductMenuBanner: z
          .object({ bannerName: z.string() })
          .passthrough()
          .nullable()
          .optional(),
        screenId: z.number().int(),
        screenName: z.string(),
        skippedTargetReason: z.string().nullable().optional(),
      })
      .passthrough(),
  ),
  sourceCloneArtifactPath: z.string().optional(),
  startedAt: z.string(),
})
type ScreensMidtownFreshAndIntensePromoRebindArtifact = z.infer<
  typeof ScreensMidtownFreshAndIntensePromoRebindArtifactSchema
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
    getSelectors: z
      .array(z.object({ productCount: z.coerce.number().int().nullable().optional() }).passthrough())
      .optional(),
  })
  .passthrough()

export async function runScreensMidtownFreshAndIntensePromoRebindJob(
  context: JobHandlerContext,
  payload: ScreensMidtownFreshAndIntensePromoRebindJobPayload,
): Promise<void> {
  const artifactPath = await runScreensMidtownFreshAndIntensePromoRebindInline(context.id, payload)
  const artifact = ScreensMidtownFreshAndIntensePromoRebindArtifactSchema.parse(
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
      eventType: 'screens.midtown_fresh_and_intense_promo_rebind.completed',
      module: 'screens',
      payload: {
        actionId: artifact.action.id ?? HELIOS_SCREENS_FRESH_AND_INTENSE_ACTION_ID,
        actionName: artifact.action.name,
        artifactPath,
        bannerName: HELIOS_SCREENS_FRESH_AND_INTENSE_BANNER_NAME,
        campaignId: artifact.campaign.id ?? HELIOS_SCREENS_FRESH_AND_INTENSE_CAMPAIGN_ID,
        campaignName: artifact.campaign.name ?? HELIOS_SCREENS_FRESH_AND_INTENSE_CAMPAIGN_NAME,
        createdReplacementCount: summary.createdReplacementCount,
        deletedImageFallbackCount: summary.deletedImageFallbackCount,
        enabledReplacementCount: summary.enabledReplacementCount,
        keptImageFallbackCount: summary.keptImageFallbackCount,
        mode: artifact.mode,
        plannedReplacementCount: summary.plannedReplacementCount,
        queuedJobId: context.id,
        screenCount: summary.screenCount,
        selectorProductCount: artifact.action.selectorProductCount ?? null,
        skippedTargetCount: summary.skippedTargetCount,
        sourceCloneArtifactPath: artifact.sourceCloneArtifactPath ?? null,
        summary: buildCompletionSummary(artifact.mode, summary, artifact.action.selectorProductCount ?? null),
        targetDealerId: HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID,
        targetDealerName: readDealerName(HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID),
      },
      requestId: randomUUID(),
      scope: context.scope,
      undoPayload: null,
    })
  })
}

async function runScreensMidtownFreshAndIntensePromoRebindInline(
  jobId: number,
  payload: ScreensMidtownFreshAndIntensePromoRebindJobPayload,
): Promise<string> {
  const startedAt = new Date().toISOString()
  const mode: 'apply' | 'dry-run' = payload.mode === 'apply' ? 'apply' : 'dry-run'
  const dealerId = HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID

  // 1) Read the Fresh & Intense promo action and ensure it's enabled (apply mode).
  const actionDetail = PromoActionDetailSchema.parse(
    await callSweedRpc(dealerId, 'store.promo.action.get', { id: HELIOS_SCREENS_FRESH_AND_INTENSE_ACTION_ID }),
  )
  if (actionDetail.name !== HELIOS_SCREENS_FRESH_AND_INTENSE_ACTION_NAME) {
    throw new Error(
      `Promo action ${HELIOS_SCREENS_FRESH_AND_INTENSE_ACTION_ID} resolved to ${actionDetail.name}; expected ${HELIOS_SCREENS_FRESH_AND_INTENSE_ACTION_NAME}.`,
    )
  }
  if (mode === 'apply' && !actionDetail.enabled) {
    await callSweedRpc(dealerId, 'store.promo.action.edit', {
      id: HELIOS_SCREENS_FRESH_AND_INTENSE_ACTION_ID,
      enabled: true,
    })
  }
  const selectorProductCount =
    actionDetail.getSelectors && actionDetail.getSelectors.length === 1
      ? actionDetail.getSelectors[0].productCount ?? 0
      : null
  const actionSummary: ScreensMidtownFreshAndIntensePromoRebindArtifact['action'] = {
    id: actionDetail.id,
    name: actionDetail.name,
    readyForReplacement: typeof selectorProductCount === 'number' && selectorProductCount > 0,
    selectorProductCount,
    status: mode === 'apply' ? (actionDetail.enabled ? 'updated' : 'enabled') : 'existing',
  }
  const campaignSummary: ScreensMidtownFreshAndIntensePromoRebindArtifact['campaign'] = {
    id: HELIOS_SCREENS_FRESH_AND_INTENSE_CAMPAIGN_ID,
    name: HELIOS_SCREENS_FRESH_AND_INTENSE_CAMPAIGN_NAME,
    status: 'existing',
  }

  // 2) Per Midtown screen, replace the named image banner with a promo product-menu banner.
  const screens = await listScreens(dealerId)
  const screenArtifacts: ScreensMidtownFreshAndIntensePromoRebindArtifact['screens'] = []

  for (const screen of screens) {
    const existing = await listScreenBanners(dealerId, screen.screenId)
    const existingByName = new Map(existing.map((banner) => [banner.name, banner]))
    const target = existingByName.get(HELIOS_SCREENS_FRESH_AND_INTENSE_BANNER_NAME)

    const baseRecord: ScreensMidtownFreshAndIntensePromoRebindArtifact['screens'][number] = {
      screenId: screen.screenId,
      screenName: screen.screenName,
    }

    if (!target) {
      baseRecord.skippedTargetReason = 'image_banner_not_found'
      screenArtifacts.push(baseRecord)
      continue
    }
    // If it's already a promo product-menu banner, keep it.
    if (target.type.toLowerCase() !== 'image') {
      baseRecord.keptImageFallback = { bannerId: target.bannerId, bannerName: target.name }
      screenArtifacts.push(baseRecord)
      continue
    }

    baseRecord.plannedProductMenuBanner = { bannerName: HELIOS_SCREENS_FRESH_AND_INTENSE_BANNER_NAME }

    if (mode !== 'apply') {
      screenArtifacts.push(baseRecord)
      continue
    }
    if (!actionSummary.readyForReplacement) {
      baseRecord.skippedTargetReason = 'promo_selector_empty'
      screenArtifacts.push(baseRecord)
      continue
    }

    const existingDetail = await getBannerDetail(dealerId, target.bannerId)
    const ordering = existingDetail.ordering ?? target.ordering ?? 1
    const duration = existingDetail.duration ?? STANDARD_BANNER_DURATION_SECONDS

    const createdId = await addProductMenuBanner(dealerId, {
      duration,
      name: HELIOS_SCREENS_FRESH_AND_INTENSE_BANNER_NAME,
      ordering,
      promoActionId: HELIOS_SCREENS_FRESH_AND_INTENSE_ACTION_ID,
      screenId: screen.screenId,
    })

    if (existingDetail.enabled) {
      await setBannerEnabledFromDetail(dealerId, existingDetail, false)
    }
    await callSweedRpc(dealerId, 'store.screen.carousel.edit', { enabled: false, id: screen.screenId })
    await callSweedRpc(dealerId, 'store.screen.carousel.banner.delete', { id: existingDetail.id })
    baseRecord.deletedImageBanner = { bannerId: existingDetail.id, bannerName: existingDetail.name }

    let createdDetail = await getBannerDetail(dealerId, createdId)
    await setBannerEnabledFromDetail(dealerId, createdDetail, true)
    createdDetail = await getBannerDetail(dealerId, createdId)
    if ((createdDetail.totalDuration ?? 0) === 0 && createdDetail.enabled) {
      await setBannerEnabledFromDetail(dealerId, createdDetail, false)
      createdDetail = await getBannerDetail(dealerId, createdId)
    }
    baseRecord.newProductMenuBanner = {
      bannerId: createdId,
      bannerName: HELIOS_SCREENS_FRESH_AND_INTENSE_BANNER_NAME,
      finalEnabled: createdDetail.enabled,
      finalTotalDuration: createdDetail.totalDuration ?? 0,
    }
    await callSweedRpc(dealerId, 'store.screen.carousel.edit', { enabled: true, id: screen.screenId })

    screenArtifacts.push(baseRecord)
  }

  const finishedAt = new Date().toISOString()
  const artifact: ScreensMidtownFreshAndIntensePromoRebindArtifact = {
    action: actionSummary,
    campaign: campaignSummary,
    finishedAt,
    mode,
    screens: screenArtifacts,
    startedAt,
  }

  const artifactDirectory = resolve(process.cwd(), 'runtime-artifacts/screens')
  await mkdir(artifactDirectory, { recursive: true })
  const outputPath = resolve(
    artifactDirectory,
    `screens-midtown-fresh-and-intense-promo-rebind-job-${jobId}-${finishedAt.replace(/[:.]/g, '-')}.json`,
  )
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8')
  return outputPath
}

function summarizeArtifact(artifact: ScreensMidtownFreshAndIntensePromoRebindArtifact): {
  createdReplacementCount: number
  deletedImageFallbackCount: number
  enabledReplacementCount: number
  keptImageFallbackCount: number
  plannedReplacementCount: number
  screenCount: number
  skippedTargetCount: number
} {
  let createdReplacementCount = 0
  let deletedImageFallbackCount = 0
  let enabledReplacementCount = 0
  let keptImageFallbackCount = 0
  let plannedReplacementCount = 0
  let skippedTargetCount = 0

  for (const screen of artifact.screens) {
    if (screen.plannedProductMenuBanner) {
      plannedReplacementCount += 1
    }
    if (screen.newProductMenuBanner) {
      createdReplacementCount += 1
      if (screen.newProductMenuBanner.finalEnabled) {
        enabledReplacementCount += 1
      }
    }
    if (screen.deletedImageBanner) {
      deletedImageFallbackCount += 1
    }
    if (screen.keptImageFallback) {
      keptImageFallbackCount += 1
    }
    if (screen.skippedTargetReason) {
      skippedTargetCount += 1
    }
  }

  return {
    createdReplacementCount,
    deletedImageFallbackCount,
    enabledReplacementCount,
    keptImageFallbackCount,
    plannedReplacementCount,
    screenCount: artifact.screens.length,
    skippedTargetCount,
  }
}

function buildCompletionSummary(
  mode: 'apply' | 'dry-run',
  summary: {
    createdReplacementCount: number
    deletedImageFallbackCount: number
    enabledReplacementCount: number
    keptImageFallbackCount: number
    plannedReplacementCount: number
    screenCount: number
    skippedTargetCount: number
  },
  selectorProductCount: number | null,
): string {
  const selectorClause = typeof selectorProductCount === 'number'
    ? ` The selector currently resolves ${selectorProductCount} product(s).`
    : ''
  const skippedClause = summary.skippedTargetCount > 0
    ? ` ${summary.skippedTargetCount} target banner(s) were already missing and were skipped.`
    : ''

  if (mode === 'apply') {
    return `Applied Midtown Fresh & INTENSE promo rebinding across ${summary.screenCount} screen(s); planned ${summary.plannedReplacementCount} replacement(s), created ${summary.createdReplacementCount} promo-backed banner(s), deleted ${summary.deletedImageFallbackCount} image fallback banner(s), kept ${summary.keptImageFallbackCount} image fallback banner(s), and ${summary.enabledReplacementCount} finished enabled.${selectorClause}${skippedClause}`
  }

  return `Completed Midtown Fresh & INTENSE promo rebinding dry-run across ${summary.screenCount} screen(s); planned ${summary.plannedReplacementCount} replacement(s) using the Midtown New Arrivals campaign and Fresh & Intense promo action.${selectorClause}${skippedClause}`
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
