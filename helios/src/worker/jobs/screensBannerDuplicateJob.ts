import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import {
  SCREENS_IMAGE_BANNER_TYPE_ID,
  SCREENS_PRODUCT_MENU_BANNER_TYPE_ID,
  getHeliosScreensSiteDealer,
  type ScreensBannerDuplicateJobPayload,
  type ScreensBannerDuplicateTarget,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'
import { callSweedRpc } from '../sweed/rpc.js'
import { looksLikeSweedDeadScreenError } from './screensCarouselHelpers.js'

// Sweed product-menu banners always render with the card layout and a
// fixed product count; mirror the proven shape used by the Midtown
// priced-to-move promo rebind job.
const CARD_LAYOUT_TYPE_ID = 2
const STANDARD_PRODUCTS_DISPLAYED = 3
const DEFAULT_BANNER_DURATION_SECONDS = 10

const ScreenListResponseSchema = z.object({
  data: z.array(z.object({
    enabled: z.boolean(),
    id: z.coerce.number().int().positive(),
    name: z.string().trim().min(1),
    totalScreenDuration: z.coerce.number().int().nullable().optional(),
  }).passthrough()),
}).passthrough()

const BannerListResponseSchema = z.array(z.object({
  enabled: z.boolean(),
  id: z.union([z.string(), z.number()]).transform((value) => String(value)),
  name: z.string().trim().min(1),
  ordering: z.coerce.number().int().nullable().optional(),
  totalDuration: z.coerce.number().int().nullable().optional(),
  type: z.union([
    z.string().trim().min(1),
    z.object({ name: z.string().trim().min(1) }).passthrough().transform((value) => value.name),
  ]),
}).passthrough())

const BannerDetailSchema = z.object({
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
  promoActionId: z.union([z.string(), z.number()]).transform((value) => String(value)).nullable().optional(),
  qualityLines: z.unknown().optional(),
  screenId: z.coerce.number().int().positive(),
  sizes: z.unknown().optional(),
  subCategories: z.unknown().optional(),
  toDate: z.string().nullable().optional(),
  toTime: z.string().nullable().optional(),
  totalDuration: z.coerce.number().int().nullable().optional(),
  type: z.object({
    id: z.coerce.number().int(),
    name: z.string().trim().min(1),
  }).passthrough(),
  usePromoHeader: z.boolean().nullable().optional(),
}).passthrough()

type BannerDetail = z.infer<typeof BannerDetailSchema>

interface ScreenSummary {
  enabled: boolean
  name: string
  screenId: number
  totalScreenDuration: number | null
}

interface BannerListRow {
  bannerId: string
  bannerName: string
  enabled: boolean
  ordering: number | null
  totalDuration: number | null
  typeName: string
}

type SourceBannerPlan =
  | {
      bannerId: string
      bannerName: string
      duration: number
      kind: 'image'
      mediaId: string
      typeName: string
    }
  | {
      bannerId: string
      bannerName: string
      duration: number
      kind: 'product_menu'
      promoActionId: string
      typeName: string
      usePromoHeader: boolean
    }

interface TargetRunSummary {
  createdBanners: Array<{ bannerId: string; bannerName: string }>
  deletedBannerIds: string[]
  existingMatchBannerIds: string[]
  finalBanners: Array<{ bannerId: string; bannerName: string; enabled: boolean; totalDuration: number | null }>
  originalScreenEnabled: boolean
  plannedCreates: Array<{ bannerName: string; ordering: number }>
  screenId: number
  screenName: string
  targetDealerId: number
  targetDealerName: string
}

export async function runScreensBannerDuplicateJob(
  context: JobHandlerContext,
  payload: ScreensBannerDuplicateJobPayload,
): Promise<void> {
  const startedAt = new Date().toISOString()
  const dedupedTargets = dedupeTargets(payload.targetScreens).filter(
    (target) => !(target.dealerId === payload.sourceDealerId && target.screenId === payload.sourceScreenId),
  )
  if (dedupedTargets.length === 0) {
    throw new Error('Banner duplicate needs at least one target screen beyond the source screen.')
  }

  const sourceScreen = await readScreen(payload.sourceDealerId, payload.sourceScreenId)
  const sourceBanners = await Promise.all(
    [...new Set(payload.sourceBannerIds)].map(async (bannerId) => readSourceBanner(payload.sourceDealerId, payload.sourceScreenId, bannerId)),
  )

  // promoActionId is dealer-scoped: a product-menu banner cannot be safely
  // recreated against a screen at a different site because the promo action
  // does not exist there. Reject before mutating anything.
  const promoBanners = sourceBanners.filter((banner) => banner.kind === 'product_menu')
  const crossSiteTargets = dedupedTargets.filter((target) => target.dealerId !== payload.sourceDealerId)
  if (promoBanners.length > 0 && crossSiteTargets.length > 0) {
    throw new Error(
      `Cannot duplicate product-menu/promo banner(s) across sites because promoActionId is dealer-scoped. ` +
        `Duplicate product-menu banners only within ${readDealerName(payload.sourceDealerId)}, or use a site-specific promo rebind workflow.`,
    )
  }

  const targetRuns: TargetRunSummary[] = []
  for (const target of dedupedTargets) {
    targetRuns.push(await duplicateToTargetScreen(target, sourceBanners, payload.mode === 'apply'))
  }

  const finishedAt = new Date().toISOString()
  const artifact = {
    finishedAt,
    mode: payload.mode === 'apply' ? 'apply' : 'dry-run',
    source: {
      bannerCount: sourceBanners.length,
      banners: sourceBanners,
      dealerId: payload.sourceDealerId,
      dealerName: readDealerName(payload.sourceDealerId),
      screenId: payload.sourceScreenId,
      screenName: sourceScreen.name,
    },
    startedAt,
    targets: targetRuns,
  }

  const artifactPath = await writeArtifact(context.id, artifact)
  const summary = summarizeTargetRuns(targetRuns)

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
          completedAt: finishedAt,
          runSummary: summary,
        }),
      ],
    )

    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(context.id),
      entityType: 'job',
      eventType: 'screens.banner_duplicate.completed',
      module: 'screens',
      payload: {
        artifactPath,
        createdBannerCount: summary.createdBannerCount,
        deletedBannerCount: summary.deletedBannerCount,
        mode: payload.mode,
        queuedJobId: context.id,
        sourceBannerCount: sourceBanners.length,
        sourceDealerId: payload.sourceDealerId,
        sourceDealerName: readDealerName(payload.sourceDealerId),
        sourceScreenId: payload.sourceScreenId,
        sourceScreenName: sourceScreen.name,
        summary: buildCompletionSummary(payload.mode, summary),
        targetDealerIds: [...new Set(targetRuns.map((target) => target.targetDealerId))],
        targetScreenCount: summary.targetScreenCount,
      },
      requestId: randomUUID(),
      scope: context.scope,
      undoPayload: null,
    })
  })
}

async function duplicateToTargetScreen(
  target: ScreensBannerDuplicateTarget,
  sourceBanners: SourceBannerPlan[],
  applyChanges: boolean,
): Promise<TargetRunSummary> {
  const screen = await readScreen(target.dealerId, target.screenId)
  const targetBanners = await listScreenBanners(target.dealerId, target.screenId)
  const sourceKeySet = new Set(sourceBanners.map((banner) => bannerMatchKey(banner.bannerName, banner.typeName)))
  // Replace pre-existing banners only when both name AND type match a source
  // banner; never touch unrelated banner types on the target screen.
  const existingMatches = targetBanners.filter(
    (banner) => sourceKeySet.has(bannerMatchKey(banner.bannerName, banner.typeName)),
  )
  const maxOrdering = Math.max(0, ...targetBanners.map((banner) => banner.ordering ?? 0))
  const plannedCreates = sourceBanners.map((banner, index) => ({
    bannerName: banner.bannerName,
    ordering:
      existingMatches.find(
        (candidate) => bannerMatchKey(candidate.bannerName, candidate.typeName) === bannerMatchKey(banner.bannerName, banner.typeName),
      )?.ordering ?? maxOrdering + index + 1,
  }))

  if (!applyChanges) {
    return {
      createdBanners: [],
      deletedBannerIds: [],
      existingMatchBannerIds: existingMatches.map((banner) => banner.bannerId),
      finalBanners: existingMatches.map((banner) => ({
        bannerId: banner.bannerId,
        bannerName: banner.bannerName,
        enabled: banner.enabled,
        totalDuration: banner.totalDuration,
      })),
      originalScreenEnabled: screen.enabled,
      plannedCreates,
      screenId: target.screenId,
      screenName: screen.name,
      targetDealerId: target.dealerId,
      targetDealerName: readDealerName(target.dealerId),
    }
  }

  const createdBanners: Array<{ bannerId: string; bannerName: string }> = []
  for (const [index, sourceBanner] of sourceBanners.entries()) {
    const createdBannerId = sourceBanner.kind === 'image'
      ? await addImageBanner(target.dealerId, {
          duration: sourceBanner.duration,
          mediaId: sourceBanner.mediaId,
          name: sourceBanner.bannerName,
          ordering: plannedCreates[index].ordering,
          screenId: target.screenId,
        })
      : await addProductMenuBanner(target.dealerId, {
          duration: sourceBanner.duration,
          name: sourceBanner.bannerName,
          ordering: plannedCreates[index].ordering,
          promoActionId: sourceBanner.promoActionId,
          screenId: target.screenId,
          usePromoHeader: sourceBanner.usePromoHeader,
        })
    createdBanners.push({ bannerId: createdBannerId, bannerName: sourceBanner.bannerName })
  }

  const deletedBannerIds: string[] = []
  let screenDisabled = false
  try {
    await setScreenEnabled(target.dealerId, target.screenId, false)
    screenDisabled = true

    for (const existingMatch of existingMatches) {
      await deleteBanner(target.dealerId, existingMatch.bannerId)
      deletedBannerIds.push(existingMatch.bannerId)
    }

    for (const createdBanner of createdBanners) {
      const detail = await getBannerDetail(target.dealerId, createdBanner.bannerId)
      await editBannerEnabled(target.dealerId, detail, true)
    }
  } finally {
    if (screenDisabled) {
      await setScreenEnabled(target.dealerId, target.screenId, screen.enabled)
    }
  }

  const finalBannerMap = new Map(
    (await listScreenBanners(target.dealerId, target.screenId)).map((banner) => [banner.bannerId, banner]),
  )

  return {
    createdBanners,
    deletedBannerIds,
    existingMatchBannerIds: existingMatches.map((banner) => banner.bannerId),
    finalBanners: createdBanners.map((createdBanner) => {
      const finalBanner = finalBannerMap.get(createdBanner.bannerId)
      return {
        bannerId: createdBanner.bannerId,
        bannerName: createdBanner.bannerName,
        enabled: finalBanner?.enabled ?? true,
        totalDuration: finalBanner?.totalDuration ?? null,
      }
    }),
    originalScreenEnabled: screen.enabled,
    plannedCreates,
    screenId: target.screenId,
    screenName: screen.name,
    targetDealerId: target.dealerId,
    targetDealerName: readDealerName(target.dealerId),
  }
}

async function readSourceBanner(dealerId: number, screenId: number, bannerId: string): Promise<SourceBannerPlan> {
  const banner = await getBannerDetail(dealerId, bannerId)
  if (banner.screenId !== screenId) {
    throw new Error(`Banner ${bannerId} does not belong to source screen ${screenId}.`)
  }

  const duration = banner.duration ?? DEFAULT_BANNER_DURATION_SECONDS

  if (banner.type.id === SCREENS_IMAGE_BANNER_TYPE_ID) {
    if (!banner.media?.id) {
      throw new Error(`Banner ${banner.name} does not expose a reusable media id.`)
    }
    return {
      bannerId: banner.id,
      bannerName: banner.name,
      duration,
      kind: 'image',
      mediaId: banner.media.id,
      typeName: banner.type.name,
    }
  }

  if (banner.type.id === SCREENS_PRODUCT_MENU_BANNER_TYPE_ID) {
    if (!banner.promoActionId) {
      throw new Error(`Banner ${banner.name} is a product-menu banner without a promo action; it cannot be duplicated.`)
    }
    return {
      bannerId: banner.id,
      bannerName: banner.name,
      duration,
      kind: 'product_menu',
      promoActionId: banner.promoActionId,
      typeName: banner.type.name,
      usePromoHeader: banner.usePromoHeader ?? false,
    }
  }

  throw new Error(
    `Banner ${banner.name} is ${banner.type.name}; banner duplicate currently supports image banners and product-menu promo banners only.`,
  )
}

function bannerMatchKey(name: string, typeName: string): string {
  return `${typeName.trim().toLowerCase()}:${name.trim().toLowerCase()}`
}

async function readScreen(dealerId: number, screenId: number): Promise<ScreenSummary> {
  const screens = await listScreens(dealerId)
  const screen = screens.find((candidate) => candidate.screenId === screenId)
  if (!screen) {
    throw new Error(`Screen ${screenId} is not visible in dealer ${dealerId}.`)
  }
  return screen
}

async function listScreens(dealerId: number): Promise<ScreenSummary[]> {
  const result = ScreenListResponseSchema.parse(await callSweedRpc(dealerId, 'store.screen.carousel.list', { page: 1, pageSize: 200 }))
  return result.data.map((screen) => ({
    enabled: screen.enabled,
    name: screen.name,
    screenId: screen.id,
    totalScreenDuration: screen.totalScreenDuration ?? null,
  }))
}

async function listScreenBanners(dealerId: number, screenId: number): Promise<BannerListRow[]> {
  let raw: unknown
  try {
    raw = await callSweedRpc(dealerId, 'store.screen.carousel.banner.list', { screenId })
  } catch (error) {
    if (looksLikeSweedDeadScreenError(error)) {
      // Disabled / soft-deleted screen — treat as empty rather than
      // aborting the whole run. See screensCarouselHelpers.
      console.warn(
        `[screens.banner_duplicate] dealer ${dealerId} screen ${screenId}: ` +
          `Sweed rejected banner.list (${(error as Error).message}); treating as empty.`,
      )
      return []
    }
    throw error
  }
  const result = BannerListResponseSchema.parse(raw)
  return result.map((banner) => ({
    bannerId: banner.id,
    bannerName: banner.name,
    enabled: banner.enabled,
    ordering: banner.ordering ?? null,
    totalDuration: banner.totalDuration ?? null,
    typeName: banner.type,
  }))
}

async function getBannerDetail(dealerId: number, bannerId: string): Promise<BannerDetail> {
  return BannerDetailSchema.parse(await callSweedRpc(dealerId, 'store.screen.carousel.banner.get', { id: bannerId }))
}

async function addImageBanner(
  dealerId: number,
  banner: { duration: number; mediaId: string; name: string; ordering: number; screenId: number },
): Promise<string> {
  const result = await callSweedRpc<unknown>(dealerId, 'store.screen.carousel.banner.add', {
    duration: banner.duration,
    enabled: false,
    fromDate: new Date().toISOString().slice(0, 10),
    mediaId: banner.mediaId,
    name: banner.name,
    ordering: banner.ordering,
    screenId: banner.screenId,
    typeId: SCREENS_IMAGE_BANNER_TYPE_ID,
  })

  return parseCreatedBannerId(result, banner.name)
}

async function addProductMenuBanner(
  dealerId: number,
  banner: {
    duration: number
    name: string
    ordering: number
    promoActionId: string
    screenId: number
    usePromoHeader: boolean
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
    typeId: SCREENS_PRODUCT_MENU_BANNER_TYPE_ID,
    usePromoHeader: banner.usePromoHeader,
  })

  return parseCreatedBannerId(result, banner.name)
}

function parseCreatedBannerId(result: unknown, bannerName: string): string {
  if (typeof result === 'string' || typeof result === 'number') {
    return String(result)
  }
  if (result && typeof result === 'object' && 'id' in result) {
    const idValue = (result as { id: unknown }).id
    if (typeof idValue === 'string' || typeof idValue === 'number') {
      return String(idValue)
    }
  }

  throw new Error(`store.screen.carousel.banner.add returned no banner id for ${bannerName}.`)
}

async function deleteBanner(dealerId: number, bannerId: string): Promise<void> {
  await callSweedRpc(dealerId, 'store.screen.carousel.banner.delete', { id: bannerId })
}

async function editBannerEnabled(
  dealerId: number,
  bannerDetail: BannerDetail,
  enabled: boolean,
): Promise<void> {
  await callSweedRpc(dealerId, 'store.screen.carousel.banner.edit', buildBannerEditParams(bannerDetail, enabled))
}

async function setScreenEnabled(dealerId: number, screenId: number, enabled: boolean): Promise<void> {
  await callSweedRpc(dealerId, 'store.screen.carousel.edit', { enabled, id: screenId })
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

  if (typeId === SCREENS_PRODUCT_MENU_BANNER_TYPE_ID) {
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

async function writeArtifact(jobId: number, artifact: unknown): Promise<string> {
  const artifactDirectory = resolve(process.cwd(), 'runtime-artifacts/screens')
  await mkdir(artifactDirectory, { recursive: true })

  const artifactPath = resolve(
    artifactDirectory,
    `screens-banner-duplicate-job-${jobId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  )
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8')
  return artifactPath
}

function summarizeTargetRuns(targetRuns: TargetRunSummary[]) {
  return {
    createdBannerCount: targetRuns.reduce(
      (count, target) => count + (target.createdBanners.length > 0 ? target.createdBanners.length : target.plannedCreates.length),
      0,
    ),
    deletedBannerCount: targetRuns.reduce(
      (count, target) => count + (target.deletedBannerIds.length > 0 ? target.deletedBannerIds.length : target.existingMatchBannerIds.length),
      0,
    ),
    targetScreenCount: targetRuns.length,
  }
}

function buildCompletionSummary(
  mode: 'apply' | 'dry_run',
  summary: { createdBannerCount: number; deletedBannerCount: number; targetScreenCount: number },
): string {
  if (mode === 'apply') {
    return `Applied banner duplicate across ${summary.targetScreenCount} target screen(s); created ${summary.createdBannerCount} banner(s) and removed ${summary.deletedBannerCount} replaced banner(s).`
  }

  return `Completed banner duplicate dry-run across ${summary.targetScreenCount} target screen(s); ${summary.createdBannerCount} banner(s) would be created and ${summary.deletedBannerCount} replaced banner(s) would be removed.`
}

function dedupeTargets(targets: ScreensBannerDuplicateTarget[]): ScreensBannerDuplicateTarget[] {
  const seen = new Set<string>()
  const result: ScreensBannerDuplicateTarget[] = []

  for (const target of targets) {
    const key = `${target.dealerId}:${target.screenId}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(target)
  }

  return result
}

function readDealerName(dealerId: number): string {
  return getHeliosScreensSiteDealer(dealerId)?.dealerName ?? `dealer ${dealerId}`
}
