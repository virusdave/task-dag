import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import {
  HELIOS_SCREENS_BRONX_SITE_DEALER_ID,
  HELIOS_SCREENS_BRONX_TO_MIDTOWN_IMAGE_FALLBACK_BANNER_NAMES,
  HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID,
  getHeliosScreensSiteDealer,
  type ScreensBronxMidtownImageCloneJobPayload,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'
import { callSweedRpc } from '../sweed/rpc.js'
import { isScreenEligibleForBannerOps, looksLikeSweedDeadScreenError } from './screensCarouselHelpers.js'

const ScreensBronxMidtownImageCloneArtifactSchema = z.object({
  bronxSources: z.array(
    z
      .object({
        bannerId: z.string(),
        bannerName: z.string(),
        mediaPlan: z
          .object({
            strategy: z.enum(['reuse_existing_media', 'upload_from_promo_media_url', 'upload_required']),
          })
          .passthrough(),
      })
      .passthrough(),
  ),
  finishedAt: z.string(),
  midtownCloneRun: z.object({
    screens: z.array(
      z
        .object({
          created: z
            .array(
              z
                .object({
                  bannerId: z.string(),
                  bannerName: z.string(),
                  duration: z.number().int().optional(),
                  ordering: z.number().int().optional(),
                })
                .passthrough(),
            )
            .optional()
            .default([]),
          final: z
            .array(
              z
                .object({
                  bannerId: z.string(),
                  bannerName: z.string(),
                  finalEnabled: z.boolean(),
                  finalTotalDuration: z.number().int(),
                })
                .passthrough(),
            )
            .optional()
            .default([]),
          plannedCreates: z.array(
            z
              .object({
                bannerName: z.string(),
              })
              .passthrough(),
          ),
          screenId: z.number().int(),
          screenName: z.string(),
        })
        .passthrough(),
    ),
  }),
  mode: z.enum(['apply', 'dry-run']),
  startedAt: z.string(),
})
type ScreensBronxMidtownImageCloneArtifact = z.infer<typeof ScreensBronxMidtownImageCloneArtifactSchema>

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

export async function runScreensBronxMidtownImageCloneJob(
  context: JobHandlerContext,
  payload: ScreensBronxMidtownImageCloneJobPayload,
): Promise<void> {
  const artifactPath = await runScreensBronxMidtownImageCloneInline(context.id, payload)
  const artifact = ScreensBronxMidtownImageCloneArtifactSchema.parse(JSON.parse(await readFile(artifactPath, 'utf-8')))
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
      eventType: 'screens.bronx_midtown_image_clone.completed',
      module: 'screens',
      payload: {
        artifactPath,
        bannerNames: artifact.bronxSources.map((source) => source.bannerName),
        createdCloneCount: summary.createdCloneCount,
        enabledCloneCount: summary.enabledCloneCount,
        mode: artifact.mode,
        plannedCloneCount: summary.plannedCloneCount,
        queuedJobId: context.id,
        screenCount: summary.screenCount,
        sourceBannerCount: summary.sourceBannerCount,
        sourceDealerId: HELIOS_SCREENS_BRONX_SITE_DEALER_ID,
        sourceDealerName: readDealerName(HELIOS_SCREENS_BRONX_SITE_DEALER_ID),
        summary: buildCompletionSummary(artifact.mode, summary),
        targetDealerId: HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID,
        targetDealerName: readDealerName(HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID),
        uploadedMediaCount: summary.uploadedMediaCount,
        uploadRequiredCount: summary.uploadRequiredCount,
        zeroDurationDisabledCount: summary.zeroDurationDisabledCount,
      },
      requestId: randomUUID(),
      scope: context.scope,
      undoPayload: null,
    })
  })
}

async function runScreensBronxMidtownImageCloneInline(
  jobId: number,
  payload: ScreensBronxMidtownImageCloneJobPayload,
): Promise<string> {
  const startedAt = new Date().toISOString()
  const mode: 'apply' | 'dry-run' = payload.mode === 'apply' ? 'apply' : 'dry-run'

  // 1) Discover Bronx source banners: for each target name, find the first image banner on any Bronx screen.
  const bronxScreens = await listScreens(HELIOS_SCREENS_BRONX_SITE_DEALER_ID)
  const bronxSources: ScreensBronxMidtownImageCloneArtifact['bronxSources'] = []
  const sourceDetailByName = new Map<string, BannerDetail>()

  for (const bannerName of HELIOS_SCREENS_BRONX_TO_MIDTOWN_IMAGE_FALLBACK_BANNER_NAMES) {
    let foundDetail: BannerDetail | null = null
    for (const screen of bronxScreens) {
      const banners = await listScreenBanners(HELIOS_SCREENS_BRONX_SITE_DEALER_ID, screen.screenId)
      const match = banners.find((banner) => banner.name === bannerName && banner.type.toLowerCase() === 'image')
      if (!match) continue
      const detail = await getBannerDetail(HELIOS_SCREENS_BRONX_SITE_DEALER_ID, match.bannerId)
      if (detail.media?.id) {
        foundDetail = detail
        break
      }
    }
    if (!foundDetail) {
      bronxSources.push({
        bannerId: '',
        bannerName,
        mediaPlan: { strategy: 'upload_required' },
      })
      continue
    }
    sourceDetailByName.set(bannerName, foundDetail)
    bronxSources.push({
      bannerId: foundDetail.id,
      bannerName,
      mediaPlan: { strategy: 'reuse_existing_media' },
    })
  }

  // 2) Plan/apply per Midtown screen.
  const midtownScreens = await listScreens(HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID)
  const screenRuns: ScreensBronxMidtownImageCloneArtifact['midtownCloneRun']['screens'] = []

  for (const screen of midtownScreens) {
    const existing = await listScreenBanners(HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID, screen.screenId)
    const existingByName = new Map(existing.map((banner) => [banner.name, banner]))
    const maxOrdering = Math.max(0, ...existing.map((banner) => banner.ordering ?? 0))

    const plannedCreates: ScreensBronxMidtownImageCloneArtifact['midtownCloneRun']['screens'][number]['plannedCreates'] =
      []
    const created: ScreensBronxMidtownImageCloneArtifact['midtownCloneRun']['screens'][number]['created'] = []
    const final: ScreensBronxMidtownImageCloneArtifact['midtownCloneRun']['screens'][number]['final'] = []

    for (const bannerName of HELIOS_SCREENS_BRONX_TO_MIDTOWN_IMAGE_FALLBACK_BANNER_NAMES) {
      if (existingByName.has(bannerName)) {
        // Already present, no clone needed.
        continue
      }
      const sourceDetail = sourceDetailByName.get(bannerName)
      if (!sourceDetail || !sourceDetail.media?.id) {
        continue
      }
      plannedCreates.push({ bannerName })

      if (mode !== 'apply') {
        continue
      }

      const ordering = maxOrdering + plannedCreates.length
      const duration = sourceDetail.duration ?? 10
      const newBannerId = await addImageBanner(HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID, {
        duration,
        mediaId: sourceDetail.media.id,
        name: bannerName,
        ordering,
        screenId: screen.screenId,
      })

      created.push({ bannerId: newBannerId, bannerName, duration, ordering })

      // Enable, then disable if zero-duration.
      let detail = await getBannerDetail(HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID, newBannerId)
      await setBannerEnabled(HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID, detail, true)
      detail = await getBannerDetail(HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID, newBannerId)
      if ((detail.totalDuration ?? 0) === 0 && detail.enabled) {
        await setBannerEnabled(HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID, detail, false)
        detail = await getBannerDetail(HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID, newBannerId)
      }

      final.push({
        bannerId: newBannerId,
        bannerName,
        finalEnabled: detail.enabled,
        finalTotalDuration: detail.totalDuration ?? 0,
      })
    }

    screenRuns.push({
      created,
      final,
      plannedCreates,
      screenId: screen.screenId,
      screenName: screen.screenName,
    })
  }

  const finishedAt = new Date().toISOString()
  const artifact: ScreensBronxMidtownImageCloneArtifact = {
    bronxSources,
    finishedAt,
    midtownCloneRun: { screens: screenRuns },
    mode,
    startedAt,
  }

  const artifactDirectory = resolve(process.cwd(), 'runtime-artifacts/screens')
  await mkdir(artifactDirectory, { recursive: true })
  const outputPath = resolve(
    artifactDirectory,
    `screens-bronx-midtown-image-clone-job-${jobId}-${finishedAt.replace(/[:.]/g, '-')}.json`,
  )
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8')
  return outputPath
}

function summarizeArtifact(artifact: ScreensBronxMidtownImageCloneArtifact): {
  createdCloneCount: number
  enabledCloneCount: number
  plannedCloneCount: number
  screenCount: number
  sourceBannerCount: number
  uploadedMediaCount: number
  uploadRequiredCount: number
  zeroDurationDisabledCount: number
} {
  let plannedCloneCount = 0
  let createdCloneCount = 0
  let enabledCloneCount = 0
  let zeroDurationDisabledCount = 0

  for (const screen of artifact.midtownCloneRun.screens) {
    plannedCloneCount += screen.plannedCreates.length
    createdCloneCount += screen.created.length
    for (const banner of screen.final) {
      if (banner.finalEnabled) {
        enabledCloneCount += 1
        continue
      }

      if (banner.finalTotalDuration === 0) {
        zeroDurationDisabledCount += 1
      }
    }
  }

  return {
    createdCloneCount,
    enabledCloneCount,
    plannedCloneCount,
    screenCount: artifact.midtownCloneRun.screens.length,
    sourceBannerCount: artifact.bronxSources.length,
    uploadedMediaCount: artifact.bronxSources.filter(
      (source) => source.mediaPlan.strategy === 'upload_from_promo_media_url',
    ).length,
    uploadRequiredCount: artifact.bronxSources.filter((source) => source.mediaPlan.strategy === 'upload_required').length,
    zeroDurationDisabledCount,
  }
}

function buildCompletionSummary(
  mode: 'apply' | 'dry-run',
  summary: {
    createdCloneCount: number
    enabledCloneCount: number
    plannedCloneCount: number
    screenCount: number
    sourceBannerCount: number
    uploadedMediaCount: number
    uploadRequiredCount: number
    zeroDurationDisabledCount: number
  },
): string {
  if (mode === 'apply') {
    return `Applied Bronx-to-Midtown image fallback clone for ${summary.sourceBannerCount} Bronx source banner(s) across ${summary.screenCount} Midtown screen(s); created ${summary.createdCloneCount} image banner(s), ${summary.enabledCloneCount} finished enabled, ${summary.zeroDurationDisabledCount} zero-duration banner(s) remained disabled, and ${summary.uploadedMediaCount} source asset(s) required Midtown uploads.`
  }

  return `Completed Bronx-to-Midtown image fallback dry-run for ${summary.sourceBannerCount} Bronx source banner(s) across ${summary.screenCount} Midtown screen(s); planned ${summary.plannedCloneCount} image banner(s) and ${summary.uploadRequiredCount} source asset(s) would require Midtown uploads.`
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
  // Skip disabled screens — Sweed rejects banner.list on them with a
  // misleading 14002 error. See screensCarouselHelpers.
  return result.data
    .filter(isScreenEligibleForBannerOps)
    .map((screen) => ({
      enabled: screen.enabled,
      screenId: screen.id,
      screenName: screen.name,
    }))
}

async function listScreenBanners(
  dealerId: number,
  screenId: number,
): Promise<
  Array<{
    bannerId: string
    enabled: boolean
    name: string
    ordering: number | null
    totalDuration: number | null
    type: string
  }>
> {
  let raw: unknown
  try {
    raw = await callSweedRpc(dealerId, 'store.screen.carousel.banner.list', { screenId })
  } catch (error) {
    if (looksLikeSweedDeadScreenError(error)) {
      console.warn(
        `[screens.bronx_midtown_image_clone] dealer ${dealerId} screen ${screenId}: ` +
          `Sweed rejected banner.list (${(error as Error).message}); treating as empty.`,
      )
      return []
    }
    throw error
  }
  const result = BannerListResponseSchema.parse(raw)
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
    typeId: 1,
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

async function setBannerEnabled(dealerId: number, detail: BannerDetail, enabled: boolean): Promise<void> {
  if (detail.enabled === enabled) return
  await callSweedRpc(dealerId, 'store.screen.carousel.banner.edit', buildBannerEditParams(detail, enabled))
}

function buildBannerEditParams(detail: BannerDetail, enabled: boolean): Record<string, unknown> {
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
    typeId: detail.type.id,
    usePromoHeader: detail.usePromoHeader ?? false,
  }

  if (detail.layoutType?.id) {
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
