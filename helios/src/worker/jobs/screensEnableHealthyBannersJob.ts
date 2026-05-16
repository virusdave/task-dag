import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import {
  HELIOS_SCREENS_SITE_DEALERS,
  getHeliosScreensSiteDealer,
  type ScreensEnableHealthyBannersJobPayload,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'
import { callSweedRpc } from '../sweed/rpc.js'

export const ScreensEnableHealthyBannersArtifactSchema = z.object({
  finishedAt: z.string(),
  mode: z.enum(['apply', 'dry-run']),
  siteDealers: z.array(
    z
      .object({
        dealerId: z.number().int(),
        dealerName: z.string(),
        screens: z.array(
          z
            .object({
              screenId: z.number().int(),
              screenName: z.string(),
              targetBannerCount: z.number().int(),
              targetBanners: z.array(
                z
                  .object({
                    bannerId: z.string().optional(),
                    bannerName: z.string().optional(),
                    finalEnabled: z.boolean().optional(),
                    finalTotalDuration: z.number().int().optional(),
                    forcedDisabledBecauseZero: z.boolean().optional(),
                    originalEnabled: z.boolean(),
                    originalTotalDuration: z.number().int(),
                  })
                  .passthrough(),
              ),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  ),
  startedAt: z.string(),
})
export type ScreensEnableHealthyBannersArtifact = z.infer<typeof ScreensEnableHealthyBannersArtifactSchema>

export interface ScreensEnableHealthyBannersArtifactSummary {
  enabledBannerCount: number
  screenCount: number
  siteDealerCount: number
  targetBannerCount: number
  targetedScreenCount: number
  zeroDurationDisabledCount: number
}

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
      totalDuration: z.coerce.number().int().nullable().optional(),
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

export async function runScreensEnableHealthyBannersJob(
  context: JobHandlerContext,
  payload: ScreensEnableHealthyBannersJobPayload,
): Promise<void> {
  const artifactPath = await runScreensEnableHealthyBannersScript(context.id, payload)
  const artifact = ScreensEnableHealthyBannersArtifactSchema.parse(JSON.parse(await readFile(artifactPath, 'utf-8')))
  const summary = summarizeScreensEnableHealthyBannersArtifact(artifact)

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
      eventType: 'screens.enable_healthy_banners.completed',
      module: 'screens',
      payload: {
        artifactPath,
        enabledBannerCount: summary.enabledBannerCount,
        mode: artifact.mode,
        queuedJobId: context.id,
        screenCount: summary.screenCount,
        siteDealerCount: summary.siteDealerCount,
        siteDealerIds: payload.siteDealerIds,
        siteDealerNames: artifact.siteDealers.map((siteDealer) => siteDealer.dealerName),
        summary: buildScreensEnableHealthyBannersCompletionSummary(artifact.mode, summary),
        targetBannerCount: summary.targetBannerCount,
        targetedScreenCount: summary.targetedScreenCount,
        zeroDurationDisabledCount: summary.zeroDurationDisabledCount,
      },
      requestId: randomUUID(),
      scope: context.scope,
      undoPayload: null,
    })
  })
}

export async function runScreensEnableHealthyBannersScript(
  jobId: number,
  payload: ScreensEnableHealthyBannersJobPayload,
): Promise<string> {
  const startedAt = new Date().toISOString()
  const mode: 'apply' | 'dry-run' = payload.mode === 'apply' ? 'apply' : 'dry-run'
  const targetDealers = resolveTargetDealers(payload.siteDealerIds)

  const siteArtifacts: ScreensEnableHealthyBannersArtifact['siteDealers'] = []

  for (const dealer of targetDealers) {
    const screens = await listScreens(dealer.dealerId)
    const screenArtifacts: ScreensEnableHealthyBannersArtifact['siteDealers'][number]['screens'] = []

    for (const screen of screens) {
      const banners = await listScreenBanners(dealer.dealerId, screen.screenId)
      // Targets: banners currently disabled but with totalDuration > 0
      const targets = banners.filter(
        (banner) => banner.enabled === false && (banner.totalDuration ?? 0) > 0,
      )

      const targetBanners: ScreensEnableHealthyBannersArtifact['siteDealers'][number]['screens'][number]['targetBanners'] = []
      for (const banner of targets) {
        const originalEnabled = banner.enabled
        const originalTotalDuration = banner.totalDuration ?? 0

        let finalEnabled = originalEnabled
        let finalTotalDuration = originalTotalDuration
        let forcedDisabledBecauseZero = false

        if (mode === 'apply') {
          await setBannerEnabled(dealer.dealerId, banner.bannerId, true)
          const after = await getBannerDetail(dealer.dealerId, banner.bannerId)
          finalEnabled = after.enabled
          finalTotalDuration = after.totalDuration ?? 0
          // If after enabling it the duration is now zero, force it back off (zero-duration banners are
          // disallowed: they consume a slot without rendering).
          if (finalTotalDuration === 0) {
            await setBannerEnabled(dealer.dealerId, banner.bannerId, false)
            const afterDisable = await getBannerDetail(dealer.dealerId, banner.bannerId)
            finalEnabled = afterDisable.enabled
            finalTotalDuration = afterDisable.totalDuration ?? 0
            forcedDisabledBecauseZero = true
          }
        } else {
          finalEnabled = true
          finalTotalDuration = originalTotalDuration
        }

        targetBanners.push({
          bannerId: banner.bannerId,
          bannerName: banner.bannerName,
          finalEnabled,
          finalTotalDuration,
          forcedDisabledBecauseZero,
          originalEnabled,
          originalTotalDuration,
        })
      }

      screenArtifacts.push({
        screenId: screen.screenId,
        screenName: screen.screenName,
        targetBannerCount: targets.length,
        targetBanners,
      })
    }

    siteArtifacts.push({
      dealerId: dealer.dealerId,
      dealerName: dealer.dealerName,
      screens: screenArtifacts,
    })
  }

  const finishedAt = new Date().toISOString()
  const artifact: ScreensEnableHealthyBannersArtifact = {
    finishedAt,
    mode,
    siteDealers: siteArtifacts,
    startedAt,
  }

  const artifactDirectory = resolve(process.cwd(), 'runtime-artifacts/screens')
  await mkdir(artifactDirectory, { recursive: true })
  const outputPath = resolve(
    artifactDirectory,
    `screens-enable-healthy-banners-job-${jobId}-${finishedAt.replace(/[:.]/g, '-')}.json`,
  )
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8')
  return outputPath
}

export function summarizeScreensEnableHealthyBannersArtifact(
  artifact: ScreensEnableHealthyBannersArtifact,
): ScreensEnableHealthyBannersArtifactSummary {
  let targetBannerCount = 0
  let targetedScreenCount = 0
  let enabledBannerCount = 0
  let zeroDurationDisabledCount = 0

  for (const siteDealer of artifact.siteDealers) {
    for (const screen of siteDealer.screens) {
      targetBannerCount += screen.targetBanners.length
      if (screen.targetBannerCount > 0) {
        targetedScreenCount += 1
      }
      for (const banner of screen.targetBanners) {
        if (artifact.mode === 'apply') {
          if (banner.finalEnabled) {
            enabledBannerCount += 1
            continue
          }
          if (banner.finalTotalDuration === 0) {
            zeroDurationDisabledCount += 1
          }
          continue
        }

        enabledBannerCount += 1
      }
    }
  }

  return {
    enabledBannerCount,
    screenCount: artifact.siteDealers.reduce((count, siteDealer) => count + siteDealer.screens.length, 0),
    siteDealerCount: artifact.siteDealers.length,
    targetBannerCount,
    targetedScreenCount,
    zeroDurationDisabledCount,
  }
}

export function buildScreensEnableHealthyBannersCompletionSummary(
  mode: 'apply' | 'dry-run',
  summary: ScreensEnableHealthyBannersArtifactSummary,
): string {
  if (mode === 'apply') {
    return `Applied healthy-banner enable sweep across ${summary.siteDealerCount} site(s) and ${summary.targetedScreenCount} screen(s); ${summary.enabledBannerCount} banner(s) finished enabled and ${summary.zeroDurationDisabledCount} reread at zero duration and stayed disabled.`
  }

  return `Completed healthy-banner enable sweep dry-run across ${summary.siteDealerCount} site(s) and ${summary.screenCount} screen(s); ${summary.targetBannerCount} disabled banner(s) currently read with positive duration and would be re-enabled.`
}

function resolveTargetDealers(siteDealerIds: number[]): ReadonlyArray<{ dealerId: number; dealerName: string }> {
  if (siteDealerIds.length === 0) {
    return HELIOS_SCREENS_SITE_DEALERS
  }
  return siteDealerIds.map((dealerId) => {
    const dealer = getHeliosScreensSiteDealer(dealerId)
    if (!dealer) {
      throw new Error(`Unknown screens site dealer ${dealerId}.`)
    }
    return dealer
  })
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
): Promise<Array<{ bannerId: string; bannerName: string; enabled: boolean; totalDuration: number | null }>> {
  const result = BannerListResponseSchema.parse(
    await callSweedRpc(dealerId, 'store.screen.carousel.banner.list', { screenId }),
  )
  return result.map((banner) => ({
    bannerId: banner.id,
    bannerName: banner.name,
    enabled: banner.enabled,
    totalDuration: banner.totalDuration ?? null,
  }))
}

async function getBannerDetail(dealerId: number, bannerId: string): Promise<BannerDetail> {
  return BannerDetailSchema.parse(await callSweedRpc(dealerId, 'store.screen.carousel.banner.get', { id: bannerId }))
}

async function setBannerEnabled(dealerId: number, bannerId: string, enabled: boolean): Promise<void> {
  const detail = await getBannerDetail(dealerId, bannerId)
  if (detail.enabled === enabled) {
    return
  }
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
