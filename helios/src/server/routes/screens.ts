import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import {
  HELIOS_SCREENS_FRESH_AND_INTENSE_ACTION_ID,
  HELIOS_SCREENS_FRESH_AND_INTENSE_ACTION_NAME,
  HELIOS_SCREENS_FRESH_AND_INTENSE_BANNER_NAME,
  HELIOS_SCREENS_FRESH_AND_INTENSE_CAMPAIGN_ID,
  HELIOS_SCREENS_FRESH_AND_INTENSE_CAMPAIGN_NAME,
  HELIOS_SCREENS_BRONX_SITE_DEALER_ID,
  HELIOS_SCREENS_BRONX_TO_MIDTOWN_IMAGE_FALLBACK_BANNER_NAMES,
  HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID,
  HELIOS_SCREENS_PRICED_TO_MOVE_PROMO_ACTIONS,
  QueueScreensImageBannerSyncRequestSchema,
  SCREENS_BANNER_REFRESH_MAX_HOLD_SECONDS,
  ScreensBannerRefreshIntentSchema,
  ScreensInventoryResponseSchema,
  MutationAcceptedResponseSchema,
  getHeliosScreensSiteDealer,
  normalizeHeliosScreensSiteDealerIds,
  type HeliosModuleScope,
  type ScreensBannerRefreshIntent,
  type ScreensRunMode,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { loadScreensInventory } from '../screens/inventory.js'
import { withTransaction } from '../db/tx.js'
import { getOptionalSweedSessionConcurrencyKey } from '../jobs/concurrency.js'
import { enqueueJob } from '../jobs/enqueueJob.js'

const QueueScreensWorkflowRequestSchema = z.object({
  apply: z.boolean().default(false),
  reason: z.string().trim().max(500).nullable().optional(),
})

const QueueScreensBannerRefreshRequestSchema = QueueScreensWorkflowRequestSchema.extend({
  siteDealerIds: z.array(z.coerce.number().int().positive()).default([]),
  holdSeconds: z.coerce.number().nonnegative().max(SCREENS_BANNER_REFRESH_MAX_HOLD_SECONDS).optional(),
  intent: ScreensBannerRefreshIntentSchema.optional(),
})

export async function registerScreensRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/screens/inventory', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const response = await loadScreensInventory()
    return reply.send(ScreensInventoryResponseSchema.parse(response))
  })

  server.post('/api/screens/banner-refresh', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const body = QueueScreensBannerRefreshRequestSchema.parse(request.body ?? {})
    const requestedSiteDealerIds = [...new Set(body.siteDealerIds)]
    const siteDealerIds = normalizeHeliosScreensSiteDealerIds(requestedSiteDealerIds)
    if (siteDealerIds.length !== requestedSiteDealerIds.length) {
      throw new Error('Screens banner refresh can only target the configured Bronx and Midtown site dealers.')
    }

    const mode: ScreensRunMode = body.apply ? 'apply' : 'dry_run'
    const intent: ScreensBannerRefreshIntent = body.intent ?? 'refresh'
    const holdSeconds = body.holdSeconds ?? 0
    const requestId = randomUUID()
    const scope = buildScreensScope(siteDealerIds)

    const mutationResult = await withTransaction(async (db) => {
      const jobId = await enqueueJob(db, {
        concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
        dedupeKey: `screens.banner_refresh:${mode}:${siteDealerIds.join(',') || 'all'}:hold=${holdSeconds}:intent=${intent}`,
        jobType: 'screens.banner_refresh',
        module: 'screens',
        payload: {
          holdSeconds,
          intent,
          mode,
          requestedByUserId: user.id,
          siteDealerIds,
        },
        requestedByUserId: user.id,
        scope,
      })

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(jobId),
        entityType: 'job',
        eventType: 'screens.banner_refresh.requested',
        module: 'screens',
        payload: {
          holdSeconds,
          intent,
          mode,
          queuedJobId: jobId,
          requestedReason: body.reason ?? null,
          siteDealerIds,
          siteDealerNames: siteDealerIds
            .map((dealerId) => getHeliosScreensSiteDealer(dealerId)?.dealerName ?? null)
            .filter((dealerName): dealerName is string => dealerName !== null),
          summary: buildQueuedRefreshSummary(mode, siteDealerIds, intent, holdSeconds),
        },
        requestId,
        scope,
        undoPayload: null,
      })

      return { auditEventId, jobId }
    })

    return reply.send(
      MutationAcceptedResponseSchema.parse({
        auditEventId: mutationResult.auditEventId,
        jobId: mutationResult.jobId,
        requestId,
      }),
    )
  })

  server.post('/api/screens/banner-health-maintenance', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const body = QueueScreensBannerRefreshRequestSchema.parse(request.body ?? {})
    const requestedSiteDealerIds = [...new Set(body.siteDealerIds)]
    const siteDealerIds = normalizeHeliosScreensSiteDealerIds(requestedSiteDealerIds)
    if (siteDealerIds.length !== requestedSiteDealerIds.length) {
      throw new Error('Screens banner-health maintenance can only target the configured Bronx and Midtown site dealers.')
    }

    const mode: ScreensRunMode = body.apply ? 'apply' : 'dry_run'
    const requestId = randomUUID()
    const scope = buildScreensScope(siteDealerIds)

    const mutationResult = await withTransaction(async (db) => {
      const jobId = await enqueueJob(db, {
        concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
        dedupeKey: `screens.banner_health_maintenance:${mode}:${siteDealerIds.join(',') || 'all'}`,
        jobType: 'screens.banner_health_maintenance',
        module: 'screens',
        payload: {
          mode,
          requestedByUserId: user.id,
          siteDealerIds,
          trigger: 'manual_queue',
        },
        requestedByUserId: user.id,
        scope,
      })

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(jobId),
        entityType: 'job',
        eventType: 'screens.banner_health_maintenance.requested',
        module: 'screens',
        payload: {
          mode,
          queuedJobId: jobId,
          requestedReason: body.reason ?? null,
          siteDealerIds,
          siteDealerNames: siteDealerIds
            .map((dealerId) => getHeliosScreensSiteDealer(dealerId)?.dealerName ?? null)
            .filter((dealerName): dealerName is string => dealerName !== null),
          summary: buildQueuedBannerHealthMaintenanceSummary(mode, siteDealerIds),
          trigger: 'manual_queue',
        },
        requestId,
        scope,
        undoPayload: null,
      })

      return { auditEventId, jobId }
    })

    return reply.send(
      MutationAcceptedResponseSchema.parse({
        auditEventId: mutationResult.auditEventId,
        jobId: mutationResult.jobId,
        requestId,
      }),
    )
  })

  server.post('/api/screens/enable-healthy-banners', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const body = QueueScreensBannerRefreshRequestSchema.parse(request.body ?? {})
    const requestedSiteDealerIds = [...new Set(body.siteDealerIds)]
    const siteDealerIds = normalizeHeliosScreensSiteDealerIds(requestedSiteDealerIds)
    if (siteDealerIds.length !== requestedSiteDealerIds.length) {
      throw new Error('Healthy-banner enable sweeps can only target the configured Bronx and Midtown site dealers.')
    }

    const mode: ScreensRunMode = body.apply ? 'apply' : 'dry_run'
    const requestId = randomUUID()
    const scope = buildScreensScope(siteDealerIds)

    const mutationResult = await withTransaction(async (db) => {
      const jobId = await enqueueJob(db, {
        concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
        dedupeKey: `screens.enable_healthy_banners:${mode}:${siteDealerIds.join(',') || 'all'}`,
        jobType: 'screens.enable_healthy_banners',
        module: 'screens',
        payload: {
          mode,
          requestedByUserId: user.id,
          siteDealerIds,
        },
        requestedByUserId: user.id,
        scope,
      })

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(jobId),
        entityType: 'job',
        eventType: 'screens.enable_healthy_banners.requested',
        module: 'screens',
        payload: {
          mode,
          queuedJobId: jobId,
          requestedReason: body.reason ?? null,
          siteDealerIds,
          siteDealerNames: siteDealerIds
            .map((dealerId) => getHeliosScreensSiteDealer(dealerId)?.dealerName ?? null)
            .filter((dealerName): dealerName is string => dealerName !== null),
          summary: buildQueuedHealthyBannerEnableSummary(mode, siteDealerIds),
        },
        requestId,
        scope,
        undoPayload: null,
      })

      return { auditEventId, jobId }
    })

    return reply.send(
      MutationAcceptedResponseSchema.parse({
        auditEventId: mutationResult.auditEventId,
        jobId: mutationResult.jobId,
        requestId,
      }),
    )
  })

  server.post('/api/screens/bronx-midtown-image-clone', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const body = QueueScreensWorkflowRequestSchema.parse(request.body ?? {})
    const mode: ScreensRunMode = body.apply ? 'apply' : 'dry_run'
    const requestId = randomUUID()
    const scope = buildDealerScope(HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID)

    const mutationResult = await withTransaction(async (db) => {
      const jobId = await enqueueJob(db, {
        concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
        dedupeKey: `screens.bronx_midtown_image_clone:${mode}`,
        jobType: 'screens.bronx_midtown_image_clone',
        module: 'screens',
        payload: {
          mode,
          requestedByUserId: user.id,
        },
        requestedByUserId: user.id,
        scope,
      })

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(jobId),
        entityType: 'job',
        eventType: 'screens.bronx_midtown_image_clone.requested',
        module: 'screens',
        payload: {
          bannerNames: [...HELIOS_SCREENS_BRONX_TO_MIDTOWN_IMAGE_FALLBACK_BANNER_NAMES],
          mode,
          queuedJobId: jobId,
          requestedReason: body.reason ?? null,
          sourceDealerId: HELIOS_SCREENS_BRONX_SITE_DEALER_ID,
          sourceDealerName: readDealerName(HELIOS_SCREENS_BRONX_SITE_DEALER_ID),
          summary: buildQueuedBronxMidtownImageCloneSummary(mode),
          targetDealerId: HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID,
          targetDealerName: readDealerName(HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID),
        },
        requestId,
        scope,
        undoPayload: null,
      })

      return { auditEventId, jobId }
    })

    return reply.send(
      MutationAcceptedResponseSchema.parse({
        auditEventId: mutationResult.auditEventId,
        jobId: mutationResult.jobId,
        requestId,
      }),
    )
  })

  server.post('/api/screens/midtown-priced-to-move-promo-rebind', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const body = QueueScreensWorkflowRequestSchema.parse(request.body ?? {})
    const mode: ScreensRunMode = body.apply ? 'apply' : 'dry_run'
    const requestId = randomUUID()
    const scope = buildDealerScope(HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID)

    const mutationResult = await withTransaction(async (db) => {
      const jobId = await enqueueJob(db, {
        concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
        dedupeKey: `screens.midtown_priced_to_move_promo_rebind:${mode}`,
        jobType: 'screens.midtown_priced_to_move_promo_rebind',
        module: 'screens',
        payload: {
          mode,
          requestedByUserId: user.id,
        },
        requestedByUserId: user.id,
        scope,
      })

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(jobId),
        entityType: 'job',
        eventType: 'screens.midtown_priced_to_move_promo_rebind.requested',
        module: 'screens',
        payload: {
          actionIds: HELIOS_SCREENS_PRICED_TO_MOVE_PROMO_ACTIONS.map((action) => action.actionId),
          actionNames: HELIOS_SCREENS_PRICED_TO_MOVE_PROMO_ACTIONS.map((action) => action.actionName),
          bannerNames: HELIOS_SCREENS_PRICED_TO_MOVE_PROMO_ACTIONS.map((action) => action.bannerName),
          mode,
          queuedJobId: jobId,
          requestedReason: body.reason ?? null,
          summary: buildQueuedMidtownPricedToMovePromoRebindSummary(mode),
          targetDealerId: HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID,
          targetDealerName: readDealerName(HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID),
        },
        requestId,
        scope,
        undoPayload: null,
      })

      return { auditEventId, jobId }
    })

    return reply.send(
      MutationAcceptedResponseSchema.parse({
        auditEventId: mutationResult.auditEventId,
        jobId: mutationResult.jobId,
        requestId,
      }),
    )
  })

  server.post('/api/screens/midtown-fresh-and-intense-promo-rebind', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const body = QueueScreensWorkflowRequestSchema.parse(request.body ?? {})
    const mode: ScreensRunMode = body.apply ? 'apply' : 'dry_run'
    const requestId = randomUUID()
    const scope = buildDealerScope(HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID)

    const mutationResult = await withTransaction(async (db) => {
      const jobId = await enqueueJob(db, {
        concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
        dedupeKey: `screens.midtown_fresh_and_intense_promo_rebind:${mode}`,
        jobType: 'screens.midtown_fresh_and_intense_promo_rebind',
        module: 'screens',
        payload: {
          mode,
          requestedByUserId: user.id,
        },
        requestedByUserId: user.id,
        scope,
      })

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(jobId),
        entityType: 'job',
        eventType: 'screens.midtown_fresh_and_intense_promo_rebind.requested',
        module: 'screens',
        payload: {
          actionId: HELIOS_SCREENS_FRESH_AND_INTENSE_ACTION_ID,
          actionName: HELIOS_SCREENS_FRESH_AND_INTENSE_ACTION_NAME,
          bannerName: HELIOS_SCREENS_FRESH_AND_INTENSE_BANNER_NAME,
          campaignId: HELIOS_SCREENS_FRESH_AND_INTENSE_CAMPAIGN_ID,
          campaignName: HELIOS_SCREENS_FRESH_AND_INTENSE_CAMPAIGN_NAME,
          mode,
          queuedJobId: jobId,
          requestedReason: body.reason ?? null,
          summary: buildQueuedMidtownFreshAndIntensePromoRebindSummary(mode),
          targetDealerId: HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID,
          targetDealerName: readDealerName(HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID),
        },
        requestId,
        scope,
        undoPayload: null,
      })

      return { auditEventId, jobId }
    })

    return reply.send(
      MutationAcceptedResponseSchema.parse({
        auditEventId: mutationResult.auditEventId,
        jobId: mutationResult.jobId,
        requestId,
      }),
    )
  })

  server.post('/api/screens/image-banner-sync', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const body = QueueScreensImageBannerSyncRequestSchema.parse(request.body ?? {})
    if (!getHeliosScreensSiteDealer(body.sourceDealerId)) {
      throw new Error('Image-banner sync can only use configured screens dealers as the source.')
    }

    const targetDealerIds = normalizeHeliosScreensSiteDealerIds(body.targetScreens.map((target) => target.dealerId))
    if (targetDealerIds.length === 0 || targetDealerIds.length !== new Set(body.targetScreens.map((target) => target.dealerId)).size) {
      throw new Error('Image-banner sync can only target the configured Bronx and Midtown site dealers.')
    }

    const uniqueSourceBannerIds = [...new Set(body.sourceBannerIds)]
    const uniqueTargetScreens = dedupeTargetScreens(body.targetScreens).filter(
      (target) => !(target.dealerId === body.sourceDealerId && target.screenId === body.sourceScreenId),
    )
    if (uniqueTargetScreens.length === 0) {
      throw new Error('Image-banner sync needs at least one target screen beyond the source screen.')
    }

    const mode: ScreensRunMode = body.apply ? 'apply' : 'dry_run'
    const requestId = randomUUID()
    const scope = buildScreensImageBannerSyncScope(uniqueTargetScreens)

    const mutationResult = await withTransaction(async (db) => {
      const jobId = await enqueueJob(db, {
        concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
        dedupeKey: `screens.image_banner_sync:${mode}:${body.sourceDealerId}:${body.sourceScreenId}:${uniqueSourceBannerIds.join(',')}:${uniqueTargetScreens.map((target) => `${target.dealerId}-${target.screenId}`).join(',')}`,
        jobType: 'screens.image_banner_sync',
        module: 'screens',
        payload: {
          mode,
          requestedByUserId: user.id,
          sourceBannerIds: uniqueSourceBannerIds,
          sourceDealerId: body.sourceDealerId,
          sourceScreenId: body.sourceScreenId,
          targetScreens: uniqueTargetScreens,
        },
        requestedByUserId: user.id,
        scope,
      })

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(jobId),
        entityType: 'job',
        eventType: 'screens.image_banner_sync.requested',
        module: 'screens',
        payload: {
          mode,
          queuedJobId: jobId,
          requestedReason: body.reason ?? null,
          sourceBannerIds: uniqueSourceBannerIds,
          sourceDealerId: body.sourceDealerId,
          sourceDealerName: readDealerName(body.sourceDealerId),
          sourceScreenId: body.sourceScreenId,
          summary: buildQueuedImageBannerSyncSummary(mode, body.sourceDealerId, body.sourceScreenId, uniqueSourceBannerIds.length, uniqueTargetScreens.length),
          targetScreens: uniqueTargetScreens,
        },
        requestId,
        scope,
        undoPayload: null,
      })

      return { auditEventId, jobId }
    })

    return reply.send(
      MutationAcceptedResponseSchema.parse({
        auditEventId: mutationResult.auditEventId,
        jobId: mutationResult.jobId,
        requestId,
      }),
    )
  })
}

function buildQueuedRefreshSummary(
  mode: ScreensRunMode,
  siteDealerIds: number[],
  intent: ScreensBannerRefreshIntent = 'refresh',
  holdSeconds = 0,
): string {
  const dealerLabel = describeDealerSelection(siteDealerIds)
  if (intent === 'bounce') {
    const holdLabel = holdSeconds > 0 ? `${holdSeconds}-second` : 'immediate'
    return mode === 'apply'
      ? `Queued live ${holdLabel} banner/screen bounce for ${dealerLabel}.`
      : `Queued dry-run ${holdLabel} banner/screen bounce for ${dealerLabel}.`
  }
  return mode === 'apply'
    ? `Queued live banner refresh for ${dealerLabel}.`
    : `Queued dry-run banner refresh for ${dealerLabel}.`
}

function buildQueuedHealthyBannerEnableSummary(mode: ScreensRunMode, siteDealerIds: number[]): string {
  const dealerLabel = describeDealerSelection(siteDealerIds)
  return mode === 'apply'
    ? `Queued live healthy-banner enable sweep for ${dealerLabel}.`
    : `Queued dry-run healthy-banner enable sweep for ${dealerLabel}.`
}

function buildQueuedBannerHealthMaintenanceSummary(mode: ScreensRunMode, siteDealerIds: number[]): string {
  const dealerLabel = describeDealerSelection(siteDealerIds)
  return mode === 'apply'
    ? `Queued live banner-health maintenance for ${dealerLabel}. The refresh and healthy-banner enable sweeps will run in sequence.`
    : `Queued dry-run banner-health maintenance for ${dealerLabel}. The refresh and healthy-banner enable sweeps will run in sequence.`
}

function buildQueuedBronxMidtownImageCloneSummary(mode: ScreensRunMode): string {
  return mode === 'apply'
    ? 'Queued live Bronx-to-Midtown image fallback clone across all Midtown screens.'
    : 'Queued dry-run Bronx-to-Midtown image fallback clone across all Midtown screens.'
}

function buildQueuedMidtownPricedToMovePromoRebindSummary(mode: ScreensRunMode): string {
  return mode === 'apply'
    ? 'Queued live Midtown Priced to MOVE promo rebinding across all Midtown screens.'
    : 'Queued dry-run Midtown Priced to MOVE promo rebinding across all Midtown screens.'
}

function buildQueuedMidtownFreshAndIntensePromoRebindSummary(mode: ScreensRunMode): string {
  return mode === 'apply'
    ? 'Queued live Midtown Fresh & INTENSE promo rebinding across all Midtown screens.'
    : 'Queued dry-run Midtown Fresh & INTENSE promo rebinding across all Midtown screens.'
}

function buildQueuedImageBannerSyncSummary(
  mode: ScreensRunMode,
  sourceDealerId: number,
  sourceScreenId: number,
  sourceBannerCount: number,
  targetScreenCount: number,
): string {
  const sourceDealerLabel = readDealerName(sourceDealerId)
  return mode === 'apply'
    ? `Queued live image-banner sync for ${sourceBannerCount} banner(s) from ${sourceDealerLabel} screen ${sourceScreenId} to ${targetScreenCount} target screen(s).`
    : `Queued dry-run image-banner sync for ${sourceBannerCount} banner(s) from ${sourceDealerLabel} screen ${sourceScreenId} to ${targetScreenCount} target screen(s).`
}

function describeDealerSelection(siteDealerIds: number[]): string {
  if (siteDealerIds.length === 0) {
    return 'all configured screens sites'
  }

  return siteDealerIds
    .map((dealerId) => readDealerName(dealerId))
    .join(', ')
}

function readDealerName(dealerId: number): string {
  return getHeliosScreensSiteDealer(dealerId)?.dealerName ?? `dealer ${dealerId}`
}

function buildScreensScope(siteDealerIds: number[]): HeliosModuleScope | null {
  if (siteDealerIds.length !== 1) {
    return null
  }

  return buildDealerScope(siteDealerIds[0])
}

function buildDealerScope(dealerId: number): HeliosModuleScope {
  return {
    entityId: String(dealerId),
    entityType: 'dealer',
  }
}

function buildScreensImageBannerSyncScope(
  targetScreens: Array<{ dealerId: number; screenId: number }>,
): HeliosModuleScope | null {
  if (targetScreens.length === 1) {
    return {
      entityId: `${targetScreens[0].dealerId}:${targetScreens[0].screenId}`,
      entityType: 'screen',
    }
  }

  const dealerIds = [...new Set(targetScreens.map((target) => target.dealerId))]
  if (dealerIds.length === 1) {
    return buildDealerScope(dealerIds[0])
  }

  return null
}

function dedupeTargetScreens(
  targetScreens: Array<{ dealerId: number; screenId: number }>,
): Array<{ dealerId: number; screenId: number }> {
  const seen = new Set<string>()
  const deduped: Array<{ dealerId: number; screenId: number }> = []

  for (const target of targetScreens) {
    const key = `${target.dealerId}:${target.screenId}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push(target)
  }

  return deduped
}
