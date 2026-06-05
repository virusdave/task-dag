import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import {
  HELIOS_SCREENS_SITE_DEALERS,
  getHeliosScreensSiteDealer,
  type ScreensBannerBulkTogglePredicate,
  type ScreensBannerBulkToggleJobPayload,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'
import { callSweedRpc } from '../sweed/rpc.js'
import { isScreenEligibleForBannerOps, looksLikeSweedDeadScreenError } from './screensCarouselHelpers.js'

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

interface ScreenRow {
  dealerId: number
  dealerName: string
  enabled: boolean
  screenId: number
  screenName: string
}

interface BannerRow {
  bannerId: string
  bannerName: string
  enabled: boolean
  promoActionId: string | null
  totalDuration: number | null
  type: string
}

type BannerOutcome =
  | 'enabled'
  | 'disabled'
  | 'already_desired'
  | 'blocked_zero_duration'
  | 'forced_disabled_because_zero'
  | 'skipped_dead_screen'

interface BannerResult {
  bannerId: string
  bannerName: string
  dealerId: number
  finalEnabled: boolean
  finalTotalDuration: number | null
  originalEnabled: boolean
  originalTotalDuration: number | null
  outcome: BannerOutcome
  screenId: number
  screenName: string
}

interface BulkToggleSummary {
  alreadyDesiredCount: number
  blockedZeroDurationCount: number
  changedBannerCount: number
  desiredEnabled: boolean
  forcedDisabledBecauseZeroCount: number
  matchedBannerCount: number
  mode: 'apply' | 'dry-run'
  skippedDeadScreenCount: number
  targetScreenCount: number
}

export async function runScreensBannerBulkToggleJob(
  context: JobHandlerContext,
  payload: ScreensBannerBulkToggleJobPayload,
): Promise<void> {
  const startedAt = new Date().toISOString()
  const mode: 'apply' | 'dry-run' = payload.mode === 'apply' ? 'apply' : 'dry-run'
  const applyChanges = mode === 'apply'

  const { results, skippedDeadScreenCount } = await resolveAndToggle(payload, applyChanges)
  const finishedAt = new Date().toISOString()
  const summary = summarizeResults(mode, payload.desiredEnabled, results, skippedDeadScreenCount)

  const artifactPath = await writeArtifact(context.id, {
    desiredEnabled: payload.desiredEnabled,
    finishedAt,
    mode,
    results,
    startedAt,
    summary,
    target: payload.target,
  })

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
      eventType: 'screens.banner_bulk_toggle.completed',
      module: 'screens',
      payload: {
        artifactPath,
        alreadyDesiredCount: summary.alreadyDesiredCount,
        blockedZeroDurationCount: summary.blockedZeroDurationCount,
        changedBannerCount: summary.changedBannerCount,
        desiredEnabled: payload.desiredEnabled,
        forcedDisabledBecauseZeroCount: summary.forcedDisabledBecauseZeroCount,
        matchedBannerCount: summary.matchedBannerCount,
        mode: payload.mode,
        queuedJobId: context.id,
        skippedDeadScreenCount: summary.skippedDeadScreenCount,
        summary: buildCompletionSummary(summary),
        targetKind: payload.target.kind,
        targetScreenCount: summary.targetScreenCount,
      },
      requestId: randomUUID(),
      scope: context.scope,
      undoPayload: null,
    })
  })
}

async function resolveAndToggle(
  payload: ScreensBannerBulkToggleJobPayload,
  applyChanges: boolean,
): Promise<{ results: BannerResult[]; skippedDeadScreenCount: number }> {
  const results: BannerResult[] = []
  let skippedDeadScreenCount = 0

  if (payload.target.kind === 'explicit_banners') {
    // Group the requested banners by their owning screen, then resolve
    // each screen's eligibility + current banner state in one live read.
    const requestedByScreen = new Map<string, { dealerId: number; screenId: number; bannerIds: Set<string> }>()
    for (const ref of payload.target.banners) {
      const key = `${ref.dealerId}:${ref.screenId}`
      const entry = requestedByScreen.get(key) ?? { dealerId: ref.dealerId, screenId: ref.screenId, bannerIds: new Set<string>() }
      entry.bannerIds.add(ref.bannerId)
      requestedByScreen.set(key, entry)
    }

    const eligibleScreens = await collectEligibleScreens(
      [...new Set(payload.target.banners.map((ref) => ref.dealerId))],
      payload.target.banners.map((ref) => ({ dealerId: ref.dealerId, screenId: ref.screenId })),
    )
    const eligibleByKey = new Map(eligibleScreens.map((screen) => [`${screen.dealerId}:${screen.screenId}`, screen]))

    for (const [key, entry] of requestedByScreen) {
      const screen = eligibleByKey.get(key)
      if (!screen) {
        skippedDeadScreenCount += 1
        continue
      }
      const banners = await listScreenBanners(screen.dealerId, screen.screenId)
      const matched = banners.filter((banner) => entry.bannerIds.has(banner.bannerId))
      for (const banner of matched) {
        results.push(await applyToggle(screen, banner, payload.desiredEnabled, applyChanges))
      }
    }

    return { results, skippedDeadScreenCount }
  }

  // Predicate-driven resolution.
  const predicate = payload.target.predicate
  const screens = await collectPredicateScreens(predicate)
  for (const screen of screens) {
    const banners = await listScreenBanners(screen.dealerId, screen.screenId)
    const matched = banners.filter((banner) => matchesPredicate(banner, predicate))
    for (const banner of matched) {
      results.push(await applyToggle(screen, banner, payload.desiredEnabled, applyChanges))
    }
  }

  return { results, skippedDeadScreenCount }
}

async function applyToggle(
  screen: ScreenRow,
  banner: BannerRow,
  desiredEnabled: boolean,
  applyChanges: boolean,
): Promise<BannerResult> {
  const base: Omit<BannerResult, 'finalEnabled' | 'finalTotalDuration' | 'outcome'> = {
    bannerId: banner.bannerId,
    bannerName: banner.bannerName,
    dealerId: screen.dealerId,
    originalEnabled: banner.enabled,
    originalTotalDuration: banner.totalDuration,
    screenId: screen.screenId,
    screenName: screen.screenName,
  }

  // Zero-duration guardrail: enabling a zero-duration banner produces an
  // invisible slot-consumer. Never enable one; record it as blocked.
  if (desiredEnabled && (banner.totalDuration ?? 0) === 0) {
    return { ...base, finalEnabled: banner.enabled, finalTotalDuration: banner.totalDuration, outcome: 'blocked_zero_duration' }
  }

  if (banner.enabled === desiredEnabled) {
    return { ...base, finalEnabled: banner.enabled, finalTotalDuration: banner.totalDuration, outcome: 'already_desired' }
  }

  if (!applyChanges) {
    return {
      ...base,
      finalEnabled: desiredEnabled,
      finalTotalDuration: banner.totalDuration,
      outcome: desiredEnabled ? 'enabled' : 'disabled',
    }
  }

  await setBannerEnabled(screen.dealerId, banner.bannerId, desiredEnabled)
  const after = await getBannerDetail(screen.dealerId, banner.bannerId)
  let finalEnabled = after.enabled
  let finalTotalDuration = after.totalDuration ?? 0

  // If enabling revealed a zero duration (e.g. an expired schedule),
  // force it back off — zero-duration enabled banners are disallowed.
  if (desiredEnabled && finalTotalDuration === 0) {
    await setBannerEnabled(screen.dealerId, banner.bannerId, false)
    const afterDisable = await getBannerDetail(screen.dealerId, banner.bannerId)
    finalEnabled = afterDisable.enabled
    finalTotalDuration = afterDisable.totalDuration ?? 0
    return { ...base, finalEnabled, finalTotalDuration, outcome: 'forced_disabled_because_zero' }
  }

  return { ...base, finalEnabled, finalTotalDuration, outcome: desiredEnabled ? 'enabled' : 'disabled' }
}

function matchesPredicate(banner: BannerRow, predicate: ScreensBannerBulkTogglePredicate): boolean {
  if (predicate.currentEnabled !== null && banner.enabled !== predicate.currentEnabled) {
    return false
  }
  if (predicate.typeIn.length > 0) {
    const typeLower = banner.type.toLowerCase()
    if (!predicate.typeIn.some((candidate) => candidate.toLowerCase() === typeLower)) {
      return false
    }
  }
  if (predicate.nameContains) {
    if (!banner.bannerName.toLowerCase().includes(predicate.nameContains.toLowerCase())) {
      return false
    }
  }
  if (predicate.durationState !== 'any') {
    const duration = banner.totalDuration ?? 0
    if (predicate.durationState === 'zero' && duration !== 0) {
      return false
    }
    if (predicate.durationState === 'positive' && duration <= 0) {
      return false
    }
  }
  if (predicate.hasPromoAction !== null) {
    const hasPromo = banner.promoActionId !== null
    if (hasPromo !== predicate.hasPromoAction) {
      return false
    }
  }
  return true
}

async function collectPredicateScreens(predicate: ScreensBannerBulkTogglePredicate): Promise<ScreenRow[]> {
  const dealers = resolveTargetDealers(predicate.siteDealerIds)
  const dealerIds = dealers.map((dealer) => dealer.dealerId)
  const screenRefs = predicate.screenRefs.length > 0 ? predicate.screenRefs : null
  return collectEligibleScreens(dealerIds, screenRefs)
}

async function collectEligibleScreens(
  dealerIds: number[],
  screenRefs: Array<{ dealerId: number; screenId: number }> | null,
): Promise<ScreenRow[]> {
  const allowedScreenKeys = screenRefs ? new Set(screenRefs.map((ref) => `${ref.dealerId}:${ref.screenId}`)) : null
  const rows: ScreenRow[] = []

  for (const dealerId of [...new Set(dealerIds)]) {
    const dealer = getHeliosScreensSiteDealer(dealerId)
    if (!dealer) {
      throw new Error(`Unknown screens site dealer ${dealerId}.`)
    }
    const screens = await listScreens(dealerId)
    for (const screen of screens) {
      if (allowedScreenKeys && !allowedScreenKeys.has(`${dealerId}:${screen.screenId}`)) {
        continue
      }
      rows.push({
        dealerId,
        dealerName: dealer.dealerName,
        enabled: screen.enabled,
        screenId: screen.screenId,
        screenName: screen.screenName,
      })
    }
  }

  return rows
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

async function listScreens(dealerId: number): Promise<Array<{ enabled: boolean; screenId: number; screenName: string }>> {
  const result = ScreenListResponseSchema.parse(
    await callSweedRpc(dealerId, 'store.screen.carousel.list', { page: 1, pageSize: 200 }),
  )
  // Skip disabled / DEAD-named screens — Sweed rejects banner ops on
  // them with a misleading 14002 error. See screensCarouselHelpers.
  return result.data
    .filter((screen) => isScreenEligibleForBannerOps({ enabled: screen.enabled, name: screen.name }))
    .map((screen) => ({ enabled: screen.enabled, screenId: screen.id, screenName: screen.name }))
}

async function listScreenBanners(dealerId: number, screenId: number): Promise<BannerRow[]> {
  let raw: unknown
  try {
    raw = await callSweedRpc(dealerId, 'store.screen.carousel.banner.list', { screenId })
  } catch (error) {
    if (looksLikeSweedDeadScreenError(error)) {
      console.warn(
        `[screens.banner_bulk_toggle] dealer ${dealerId} screen ${screenId}: ` +
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

function summarizeResults(
  mode: 'apply' | 'dry-run',
  desiredEnabled: boolean,
  results: BannerResult[],
  skippedDeadScreenCount: number,
): BulkToggleSummary {
  const targetScreens = new Set<string>()
  let alreadyDesiredCount = 0
  let blockedZeroDurationCount = 0
  let changedBannerCount = 0
  let forcedDisabledBecauseZeroCount = 0

  for (const result of results) {
    targetScreens.add(`${result.dealerId}:${result.screenId}`)
    switch (result.outcome) {
      case 'enabled':
      case 'disabled':
        changedBannerCount += 1
        break
      case 'already_desired':
        alreadyDesiredCount += 1
        break
      case 'blocked_zero_duration':
        blockedZeroDurationCount += 1
        break
      case 'forced_disabled_because_zero':
        forcedDisabledBecauseZeroCount += 1
        break
      default:
        break
    }
  }

  return {
    alreadyDesiredCount,
    blockedZeroDurationCount,
    changedBannerCount,
    desiredEnabled,
    forcedDisabledBecauseZeroCount,
    matchedBannerCount: results.length,
    mode,
    skippedDeadScreenCount,
    targetScreenCount: targetScreens.size,
  }
}

function buildCompletionSummary(summary: BulkToggleSummary): string {
  const action = summary.desiredEnabled ? 'enable' : 'disable'
  const blockedTail =
    summary.blockedZeroDurationCount > 0
      ? ` ${summary.blockedZeroDurationCount} zero-duration banner(s) were left disabled.`
      : ''
  const forcedTail =
    summary.forcedDisabledBecauseZeroCount > 0
      ? ` ${summary.forcedDisabledBecauseZeroCount} reread at zero duration and stayed disabled.`
      : ''

  if (summary.mode === 'apply') {
    return `Applied bulk ${action} across ${summary.targetScreenCount} screen(s); ${summary.matchedBannerCount} banner(s) matched, ${summary.changedBannerCount} changed, ${summary.alreadyDesiredCount} already in the desired state.${blockedTail}${forcedTail}`
  }

  return `Completed bulk ${action} dry-run across ${summary.targetScreenCount} screen(s); ${summary.matchedBannerCount} banner(s) matched and ${summary.changedBannerCount} would change.${blockedTail}`
}

async function writeArtifact(jobId: number, artifact: unknown): Promise<string> {
  const artifactDirectory = resolve(process.cwd(), 'runtime-artifacts/screens')
  await mkdir(artifactDirectory, { recursive: true })
  const artifactPath = resolve(
    artifactDirectory,
    `screens-banner-bulk-toggle-job-${jobId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  )
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8')
  return artifactPath
}
