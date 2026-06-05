import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import {
  HELIOS_SCREENS_SITE_DEALERS,
  getHeliosScreensSiteDealer,
  type ScreensBannerRefreshJobPayload,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { getPool } from '../../server/db/pool.js'
import { withTransaction } from '../../server/db/tx.js'
import { pageDave } from '../runtime/pageDave.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'
import { callSweedRpc } from '../sweed/rpc.js'
import { isScreenEligibleForBannerOps, looksLikeSweedDeadScreenError } from './screensCarouselHelpers.js'

export const ScreenBannerArtifactSchema = z.object({
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
              bannerCount: z.number().int(),
              banners: z.array(
                z
                  .object({
                    bannerId: z.string(),
                    bannerName: z.string(),
                    duration: z.number().int().nullable().optional(),
                    finalEnabled: z.boolean().optional(),
                    finalTotalDuration: z.number().int().optional(),
                    forcedDisabledBecauseZero: z.boolean(),
                    originalEnabled: z.boolean(),
                    originalTotalDuration: z.number().int(),
                    promoActionId: z.string().nullable().optional(),
                    totalDuration: z.number().int().nullable().optional(),
                    type: z.string(),
                  })
                  .passthrough(),
              ),
              screenId: z.number().int(),
              screenName: z.string(),
              screenToggle: z
                .object({
                  finalEnabled: z.boolean().optional(),
                  originalEnabled: z.boolean().optional(),
                })
                .passthrough()
                .optional(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  ),
  startedAt: z.string(),
})
export type ScreenBannerArtifact = z.infer<typeof ScreenBannerArtifactSchema>

export interface ScreenBannerArtifactSummary {
  bannerCount: number
  screenCount: number
  siteDealerCount: number
  zeroDurationBannerCount: number
}

const MAX_JOB_PROGRESS_LOG_ENTRIES = 200

interface JobProgressBeacon {
  phase: string
  phaseIndex: number
  phaseCount: number
  message: string
  completed: number | null
  total: number | null
}

const TOTAL_PHASES = 5

const STAGE_TO_PHASE: Record<string, { phaseIndex: number; phase: string }> = {
  starting: { phaseIndex: 1, phase: 'Starting refresh' },
  banners_off: { phaseIndex: 2, phase: 'Disabling banners' },
  hold_started: { phaseIndex: 3, phase: 'Holding screens off' },
  hold_finished: { phaseIndex: 4, phase: 'Re-enabling banners' },
  reenable: { phaseIndex: 4, phase: 'Re-enabling banners' },
  finalize: { phaseIndex: 5, phase: 'Finalizing artifact' },
  completed: { phaseIndex: 5, phase: 'Completed' },
}

const ScreenListResponseSchema = z
  .object({
    data: z.array(
      z
        .object({
          enabled: z.boolean(),
          id: z.coerce.number().int().positive(),
          name: z.string().trim().min(1),
          totalScreenDuration: z.coerce.number().int().nullable().optional(),
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
      duration: z.coerce.number().int().nullable().optional(),
      ordering: z.coerce.number().int().nullable().optional(),
      promoActionId: z
        .union([z.string(), z.number()])
        .transform((value) => String(value))
        .nullable()
        .optional(),
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

interface ScreenSnapshot {
  enabled: boolean
  screenId: number
  screenName: string
}

interface BannerSnapshot {
  bannerId: string
  bannerName: string
  duration: number | null
  enabled: boolean
  promoActionId: string | null
  totalDuration: number | null
  type: string
}

export async function runScreensBannerRefreshJob(
  context: JobHandlerContext,
  payload: ScreensBannerRefreshJobPayload,
): Promise<void> {
  const startedAtMs = Date.now()
  await updateJobProgress(context.id, {
    phase: 'Starting refresh',
    phaseIndex: 1,
    phaseCount: TOTAL_PHASES,
    message:
      payload.intent === 'bounce'
        ? `Starting ${payload.holdSeconds}-second banner/screen bounce.`
        : 'Starting screens banner refresh.',
    completed: null,
    total: null,
  })

  let artifactPath: string
  let artifact: ScreenBannerArtifact
  let summary: ScreenBannerArtifactSummary
  try {
    artifactPath = await runScreensRefreshScript(context.id, payload)
    artifact = ScreenBannerArtifactSchema.parse(JSON.parse(await readArtifactFile(artifactPath)))
    summary = summarizeScreenBannerArtifact(artifact)
  } catch (error) {
    if (payload.intent === 'bounce') {
      await pageDaveSafe(buildBounceFailureMessage(context.id, payload, error))
    }
    throw error
  }

  const elapsedSeconds = Math.round((Date.now() - startedAtMs) / 1000)

  await updateJobProgress(context.id, {
    phase: 'Completed',
    phaseIndex: TOTAL_PHASES,
    phaseCount: TOTAL_PHASES,
    message: buildScreenBannerRefreshCompletionSummary(artifact.mode, summary, payload, elapsedSeconds),
    completed: summary.bannerCount,
    total: summary.bannerCount,
  })

  const completionSummary = buildScreenBannerRefreshCompletionSummary(artifact.mode, summary, payload, elapsedSeconds)

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
          elapsedSeconds,
          runSummary: summary,
        }),
      ],
    )

    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(context.id),
      entityType: 'job',
      eventType: 'screens.banner_refresh.completed',
      module: 'screens',
      payload: {
        artifactPath,
        bannerCount: summary.bannerCount,
        elapsedSeconds,
        holdSeconds: payload.holdSeconds,
        intent: payload.intent,
        mode: artifact.mode,
        queuedJobId: context.id,
        screenCount: summary.screenCount,
        siteDealerCount: summary.siteDealerCount,
        siteDealerIds: payload.siteDealerIds,
        siteDealerNames: artifact.siteDealers.map((siteDealer) => siteDealer.dealerName),
        summary: completionSummary,
        zeroDurationBannerCount: summary.zeroDurationBannerCount,
      },
      requestId: randomUUID(),
      scope: context.scope,
      undoPayload: null,
    })
  })

  if (payload.intent === 'bounce') {
    await pageDaveSafe(
      [
        `Helios screens bounce job #${context.id} ${artifact.mode === 'apply' ? 'applied' : 'dry-run'} succeeded.`,
        completionSummary,
        `Elapsed ${elapsedSeconds}s. Artifact: ${artifactPath}`,
      ].join(' '),
    )
  }
}

/**
 * Runs the screens banner refresh / bounce inline (TypeScript only, no python).
 * Returns the path to a JSON artifact that matches `ScreenBannerArtifactSchema`.
 */
export async function runScreensRefreshScript(jobId: number, payload: ScreensBannerRefreshJobPayload): Promise<string> {
  const startedAt = new Date().toISOString()
  const mode: 'apply' | 'dry-run' = payload.mode === 'apply' ? 'apply' : 'dry-run'
  // When the operator picked specific TVs, narrow to exactly those
  // screens (and only the dealers that own them). Otherwise fall back to
  // whole-site behaviour driven by siteDealerIds.
  const targetScreenKeys = payload.targetScreens.length > 0
    ? new Set(payload.targetScreens.map((target) => `${target.dealerId}:${target.screenId}`))
    : null
  const targetDealers = targetScreenKeys
    ? resolveTargetDealers([...new Set(payload.targetScreens.map((target) => target.dealerId))])
    : resolveTargetDealers(payload.siteDealerIds)

  await emitStage(jobId, 'starting', payload)

  const siteDealerArtifacts: ScreenBannerArtifact['siteDealers'] = []
  const allBanners: { dealerId: number; screenId: number; banner: BannerSnapshot }[] = []
  const allScreens: { dealerId: number; screen: ScreenSnapshot }[] = []

  // 1) Read original inventory for every target site/screen/banner.
  for (const dealer of targetDealers) {
    const allDealerScreens = await listScreens(dealer.dealerId)
    const screens = targetScreenKeys
      ? allDealerScreens.filter((screen) => targetScreenKeys.has(`${dealer.dealerId}:${screen.screenId}`))
      : allDealerScreens
    const screenArtifacts: ScreenBannerArtifact['siteDealers'][number]['screens'] = []

    for (const screen of screens) {
      const banners = await listScreenBanners(dealer.dealerId, screen.screenId)
      for (const banner of banners) {
        allBanners.push({ dealerId: dealer.dealerId, screenId: screen.screenId, banner })
      }
      allScreens.push({ dealerId: dealer.dealerId, screen })

      screenArtifacts.push({
        bannerCount: banners.length,
        banners: banners.map((banner) => ({
          bannerId: banner.bannerId,
          bannerName: banner.bannerName,
          duration: banner.duration ?? null,
          forcedDisabledBecauseZero: false,
          originalEnabled: banner.enabled,
          originalTotalDuration: banner.totalDuration ?? 0,
          promoActionId: banner.promoActionId ?? null,
          totalDuration: banner.totalDuration ?? null,
          type: banner.type,
        })),
        screenId: screen.screenId,
        screenName: screen.screenName,
        screenToggle: {
          originalEnabled: screen.enabled,
        },
      })
    }

    siteDealerArtifacts.push({
      dealerId: dealer.dealerId,
      dealerName: dealer.dealerName,
      screens: screenArtifacts,
    })
  }

  // 2) On dry-run, just freeze the snapshot and report.
  if (mode === 'dry-run') {
    for (const site of siteDealerArtifacts) {
      for (const screen of site.screens) {
        for (const banner of screen.banners) {
          banner.finalEnabled = banner.originalEnabled
          banner.finalTotalDuration = banner.originalTotalDuration
          banner.forcedDisabledBecauseZero =
            banner.originalEnabled === false && banner.originalTotalDuration === 0
        }
        screen.screenToggle = {
          ...screen.screenToggle,
          finalEnabled: screen.screenToggle?.originalEnabled ?? false,
        }
      }
    }
    return writeArtifact(jobId, mode, startedAt, siteDealerArtifacts)
  }

  // 3) APPLY mode. Standard bounce: banners off → screens off → hold → screens on → healthy banners back on.
  if (payload.intent === 'bounce' || payload.intent === 'refresh') {
    await emitStage(jobId, 'banners_off', payload)
    for (const entry of allBanners) {
      if (entry.banner.enabled) {
        await setBannerEnabled(entry.dealerId, entry.banner.bannerId, false)
      }
    }

    await emitStage(jobId, 'hold_started', payload)
    for (const entry of allScreens) {
      if (entry.screen.enabled) {
        await setScreenEnabled(entry.dealerId, entry.screen.screenId, false)
      }
    }

    if (payload.holdSeconds > 0) {
      await sleep(payload.holdSeconds * 1000)
    }

    await emitStage(jobId, 'hold_finished', payload)
    for (const entry of allScreens) {
      if (entry.screen.enabled) {
        await setScreenEnabled(entry.dealerId, entry.screen.screenId, true)
      }
    }

    await emitStage(jobId, 'reenable', payload)
    for (const entry of allBanners) {
      const wasHealthyAndEnabled = entry.banner.enabled && (entry.banner.totalDuration ?? 0) > 0
      if (wasHealthyAndEnabled) {
        await setBannerEnabled(entry.dealerId, entry.banner.bannerId, true)
      }
    }
  }

  await emitStage(jobId, 'finalize', payload)

  // 4) Re-read state to record final values.
  for (const site of siteDealerArtifacts) {
    for (const screen of site.screens) {
      const post = await listScreenBanners(site.dealerId, screen.screenId)
      const byId = new Map(post.map((banner) => [banner.bannerId, banner]))
      for (const banner of screen.banners) {
        const after = byId.get(banner.bannerId)
        banner.finalEnabled = after?.enabled ?? banner.originalEnabled
        banner.finalTotalDuration = after?.totalDuration ?? banner.originalTotalDuration
        banner.forcedDisabledBecauseZero =
          banner.originalEnabled === true &&
          banner.originalTotalDuration === 0 &&
          banner.finalEnabled === false
      }

      const postScreens = await listScreens(site.dealerId)
      const screenAfter = postScreens.find((candidate) => candidate.screenId === screen.screenId)
      screen.screenToggle = {
        ...screen.screenToggle,
        finalEnabled: screenAfter?.enabled ?? screen.screenToggle?.originalEnabled ?? false,
      }
    }
  }

  return writeArtifact(jobId, mode, startedAt, siteDealerArtifacts)
}

export function summarizeScreenBannerArtifact(artifact: ScreenBannerArtifact): ScreenBannerArtifactSummary {
  let screenCount = 0
  let bannerCount = 0
  let zeroDurationBannerCount = 0

  for (const siteDealer of artifact.siteDealers) {
    screenCount += siteDealer.screens.length
    for (const screen of siteDealer.screens) {
      bannerCount += screen.banners.length
      for (const banner of screen.banners) {
        if (artifact.mode === 'apply') {
          if (banner.finalEnabled === false && banner.finalTotalDuration === 0) {
            zeroDurationBannerCount += 1
          }
          continue
        }

        if (banner.originalEnabled === false && banner.originalTotalDuration === 0) {
          zeroDurationBannerCount += 1
        }
      }
    }
  }

  return {
    bannerCount,
    screenCount,
    siteDealerCount: artifact.siteDealers.length,
    zeroDurationBannerCount,
  }
}

export function buildScreenBannerRefreshCompletionSummary(
  mode: 'apply' | 'dry-run',
  summary: ScreenBannerArtifactSummary,
  payload?: ScreensBannerRefreshJobPayload,
  elapsedSeconds?: number,
): string {
  const intentLabel =
    payload?.intent === 'bounce'
      ? `${payload.holdSeconds > 0 ? `${payload.holdSeconds}-second ` : ''}banner/screen bounce`
      : 'screens banner refresh'
  const elapsedTail = typeof elapsedSeconds === 'number' ? ` Elapsed ${elapsedSeconds}s.` : ''
  if (mode === 'apply') {
    return `Applied ${intentLabel} across ${summary.siteDealerCount} site(s), ${summary.screenCount} screen(s), and ${summary.bannerCount} banner(s); ${summary.zeroDurationBannerCount} zero-duration banner(s) remained disabled.${elapsedTail}`
  }

  return `Completed ${intentLabel} dry-run across ${summary.siteDealerCount} site(s), ${summary.screenCount} screen(s), and ${summary.bannerCount} banner(s); ${summary.zeroDurationBannerCount} banner(s) are currently disabled with zero duration.${elapsedTail}`
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

async function listScreens(dealerId: number): Promise<ScreenSnapshot[]> {
  const result = ScreenListResponseSchema.parse(
    await callSweedRpc(dealerId, 'store.screen.carousel.list', { page: 1, pageSize: 200 }),
  )
  // Drop disabled screens — Sweed rejects banner.list on them with a
  // misleading "Action does not exist or you do not have permission"
  // error. See screensCarouselHelpers for the full diagnosis.
  return result.data
    .filter(isScreenEligibleForBannerOps)
    .map((screen) => ({
      enabled: screen.enabled,
      screenId: screen.id,
      screenName: screen.name,
    }))
}

async function listScreenBanners(dealerId: number, screenId: number): Promise<BannerSnapshot[]> {
  let raw: unknown
  try {
    raw = await callSweedRpc(dealerId, 'store.screen.carousel.banner.list', { screenId })
  } catch (error) {
    if (looksLikeSweedDeadScreenError(error)) {
      console.warn(
        `[screens.banner_refresh] dealer ${dealerId} screen ${screenId}: ` +
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
    duration: banner.duration ?? null,
    enabled: banner.enabled,
    promoActionId: banner.promoActionId ?? null,
    totalDuration: banner.totalDuration ?? null,
    type: banner.type,
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

async function setScreenEnabled(dealerId: number, screenId: number, enabled: boolean): Promise<void> {
  await callSweedRpc(dealerId, 'store.screen.carousel.edit', { enabled, id: screenId })
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

async function writeArtifact(
  jobId: number,
  mode: 'apply' | 'dry-run',
  startedAt: string,
  siteDealers: ScreenBannerArtifact['siteDealers'],
): Promise<string> {
  const finishedAt = new Date().toISOString()
  const artifact: ScreenBannerArtifact = {
    finishedAt,
    mode,
    siteDealers,
    startedAt,
  }
  const artifactDirectory = resolve(process.cwd(), 'runtime-artifacts/screens')
  await mkdir(artifactDirectory, { recursive: true })
  const outputPath = resolve(
    artifactDirectory,
    `screens-banner-refresh-job-${jobId}-${finishedAt.replace(/[:.]/g, '-')}.json`,
  )
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8')
  return outputPath
}

async function readArtifactFile(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(path, 'utf-8')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function emitStage(jobId: number, stage: string, payload: ScreensBannerRefreshJobPayload): Promise<void> {
  console.log(`[screens.banner_refresh][job ${jobId}] HELIOS_STAGE ${stage}`)
  await writeStageProgress(jobId, stage, payload).catch((error) => {
    console.error(
      `[screens.banner_refresh][job ${jobId}] failed to record stage progress: ${(error as Error).message}`,
    )
  })
}

function buildBounceFailureMessage(jobId: number, payload: ScreensBannerRefreshJobPayload, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const truncated = message.length > 400 ? `${message.slice(0, 399)}…` : message
  return `Helios screens bounce job #${jobId} (${payload.mode}, hold=${payload.holdSeconds}s) FAILED: ${truncated}`
}

async function pageDaveSafe(message: string): Promise<void> {
  try {
    await pageDave(message)
  } catch (error) {
    console.error(`[screens.banner_refresh] page-dave failed: ${(error as Error).message}`)
  }
}

async function writeStageProgress(
  jobId: number,
  stage: string,
  payload: ScreensBannerRefreshJobPayload,
): Promise<void> {
  const mapped = STAGE_TO_PHASE[stage]
  if (!mapped) return

  const messages: Record<string, string> = {
    starting:
      payload.intent === 'bounce'
        ? `Starting ${payload.holdSeconds}-second banner/screen bounce.`
        : 'Starting screens banner refresh.',
    banners_off: 'Turning targeted banners off.',
    hold_started:
      payload.holdSeconds > 0
        ? `Screens off; holding for ${payload.holdSeconds} seconds.`
        : 'Screens off; immediate continuation.',
    hold_finished: 'Hold complete; re-enabling banners.',
    reenable: 'Re-enabling banners.',
    finalize: 'Finalizing artifact and readback.',
    completed: 'Completed.',
  }

  await updateJobProgress(jobId, {
    phase: mapped.phase,
    phaseIndex: mapped.phaseIndex,
    phaseCount: TOTAL_PHASES,
    message: messages[stage] ?? mapped.phase,
    completed: null,
    total: null,
  })
}

async function updateJobProgress(jobId: number, progress: JobProgressBeacon): Promise<void> {
  const progressLogEntry = JSON.stringify({
    createdAt: new Date().toISOString(),
    message: progress.message,
  })

  await getPool().query(
    `
      update job_queue
      set payload_json = (
            jsonb_set(
              jsonb_set(coalesce(payload_json, '{}'::jsonb), '{progress}', $2::jsonb, true),
              '{progressLog}',
              (
                select coalesce(jsonb_agg(entry order by ordinality asc), '[]'::jsonb)
                from (
                  select entry, ordinality
                  from (
                    select entry, ordinality
                    from jsonb_array_elements(coalesce(payload_json->'progressLog', '[]'::jsonb) || $3::jsonb) with ordinality as log_entries(entry, ordinality)
                    order by ordinality desc
                    limit ${MAX_JOB_PROGRESS_LOG_ENTRIES}
                  ) recent_entries
                ) trimmed_entries
              ),
              true
            )
          ),
          updated_at = now()
      where id = $1
    `,
    [jobId, JSON.stringify(progress), progressLogEntry],
  )
}
