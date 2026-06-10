import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import {
  HELIOS_SCREENS_BRONX_SITE_DEALER_ID,
  HELIOS_SCREENS_BRONX_TO_MIDTOWN_IMAGE_FALLBACK_BANNER_NAMES,
  HELIOS_SCREENS_MIDTOWN_SITE_DEALER_ID,
  HELIOS_SCREENS_PRICED_TO_MOVE_PROMO_ACTIONS,
  QueueScreensBannerBulkToggleRequestSchema,
  QueueScreensBannerDuplicateRequestSchema,
  QueueScreensImageBannerSyncRequestSchema,
  SCREENS_BANNER_REFRESH_MAX_HOLD_SECONDS,
  ScreensBannerRefreshIntentSchema,
  ScreensInventoryResponseSchema,
  MutationAcceptedResponseSchema,
  getHeliosScreensSiteDealer,
  normalizeHeliosScreensSiteDealerIds,
  type HeliosModuleScope,
  type ScreensBannerBulkToggleTarget,
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

const ScreensScreenRefRequestSchema = z.object({
  dealerId: z.coerce.number().int().positive(),
  screenId: z.coerce.number().int().positive(),
})

const QueueScreensBannerRefreshRequestSchema = QueueScreensWorkflowRequestSchema.extend({
  siteDealerIds: z.array(z.coerce.number().int().positive()).default([]),
  targetScreens: z.array(ScreensScreenRefRequestSchema).default([]),
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

    const targetScreens = dedupeTargetScreens(body.targetScreens)
    const targetScreenDealerIds = [...new Set(targetScreens.map((target) => target.dealerId))]
    if (normalizeHeliosScreensSiteDealerIds(targetScreenDealerIds).length !== targetScreenDealerIds.length) {
      throw new Error('Screens banner refresh can only target screens on the configured Bronx and Midtown site dealers.')
    }

    const mode: ScreensRunMode = body.apply ? 'apply' : 'dry_run'
    const intent: ScreensBannerRefreshIntent = body.intent ?? 'refresh'
    const holdSeconds = body.holdSeconds ?? 0
    const requestId = randomUUID()
    const scope = targetScreens.length > 0
      ? buildScreensImageBannerSyncScope(targetScreens)
      : buildScreensScope(siteDealerIds)
    const targetScreensFingerprint = targetScreens.length > 0
      ? targetScreens.map((target) => `${target.dealerId}-${target.screenId}`).join(',')
      : 'all'

    const mutationResult = await withTransaction(async (db) => {
      const jobId = await enqueueJob(db, {
        concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
        dedupeKey: `screens.banner_refresh:${mode}:${siteDealerIds.join(',') || 'all'}:screens=${targetScreensFingerprint}:hold=${holdSeconds}:intent=${intent}`,
        jobType: 'screens.banner_refresh',
        module: 'screens',
        payload: {
          holdSeconds,
          intent,
          mode,
          requestedByUserId: user.id,
          siteDealerIds,
          targetScreens,
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
          summary: buildQueuedRefreshSummary(mode, siteDealerIds, intent, holdSeconds, targetScreens.length),
          targetScreens,
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

  server.post('/api/screens/banner-bulk-toggle', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const body = QueueScreensBannerBulkToggleRequestSchema.parse(request.body ?? {})

    // Validate every referenced dealer is a configured screens site.
    const referencedDealerIds = body.target.kind === 'explicit_banners'
      ? body.target.banners.map((banner) => banner.dealerId)
      : [
          ...body.target.predicate.siteDealerIds,
          ...body.target.predicate.screenRefs.map((ref) => ref.dealerId),
        ]
    const uniqueReferencedDealerIds = [...new Set(referencedDealerIds)]
    if (normalizeHeliosScreensSiteDealerIds(uniqueReferencedDealerIds).length !== uniqueReferencedDealerIds.length) {
      throw new Error('Bulk banner toggle can only target the configured Bronx and Midtown site dealers.')
    }

    const mode: ScreensRunMode = body.apply ? 'apply' : 'dry_run'
    const requestId = randomUUID()
    const scope = buildBulkToggleScope(body.target)
    const dedupeFingerprint = body.target.kind === 'explicit_banners'
      ? `explicit:${body.target.banners.map((banner) => `${banner.dealerId}-${banner.screenId}-${banner.bannerId}`).sort().join(',')}`
      : `predicate:${JSON.stringify(body.target.predicate)}`

    const mutationResult = await withTransaction(async (db) => {
      const jobId = await enqueueJob(db, {
        concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
        dedupeKey: `screens.banner_bulk_toggle:${mode}:enabled=${body.desiredEnabled}:${dedupeFingerprint}`,
        jobType: 'screens.banner_bulk_toggle',
        module: 'screens',
        payload: {
          desiredEnabled: body.desiredEnabled,
          mode,
          requestedByUserId: user.id,
          target: body.target,
        },
        requestedByUserId: user.id,
        scope,
      })

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(jobId),
        entityType: 'job',
        eventType: 'screens.banner_bulk_toggle.requested',
        module: 'screens',
        payload: {
          desiredEnabled: body.desiredEnabled,
          explicitBannerCount: body.target.kind === 'explicit_banners' ? body.target.banners.length : null,
          mode,
          queuedJobId: jobId,
          requestedReason: body.reason ?? null,
          summary: buildQueuedBulkToggleSummary(mode, body.desiredEnabled, body.target),
          targetKind: body.target.kind,
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

  server.post('/api/screens/banner-duplicate', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const body = QueueScreensBannerDuplicateRequestSchema.parse(request.body ?? {})
    if (!getHeliosScreensSiteDealer(body.sourceDealerId)) {
      throw new Error('Banner duplicate can only use configured screens dealers as the source.')
    }

    const targetDealerIds = normalizeHeliosScreensSiteDealerIds(body.targetScreens.map((target) => target.dealerId))
    if (targetDealerIds.length === 0 || targetDealerIds.length !== new Set(body.targetScreens.map((target) => target.dealerId)).size) {
      throw new Error('Banner duplicate can only target the configured Bronx and Midtown site dealers.')
    }

    const uniqueSourceBannerIds = [...new Set(body.sourceBannerIds)]
    const uniqueTargetScreens = dedupeTargetScreens(body.targetScreens).filter(
      (target) => !(target.dealerId === body.sourceDealerId && target.screenId === body.sourceScreenId),
    )
    if (uniqueTargetScreens.length === 0) {
      throw new Error('Banner duplicate needs at least one target screen beyond the source screen.')
    }

    const mode: ScreensRunMode = body.apply ? 'apply' : 'dry_run'
    const requestId = randomUUID()
    const scope = buildScreensImageBannerSyncScope(uniqueTargetScreens)

    const mutationResult = await withTransaction(async (db) => {
      const jobId = await enqueueJob(db, {
        concurrencyKey: getOptionalSweedSessionConcurrencyKey(true),
        dedupeKey: `screens.banner_duplicate:${mode}:${body.sourceDealerId}:${body.sourceScreenId}:${uniqueSourceBannerIds.join(',')}:${uniqueTargetScreens.map((target) => `${target.dealerId}-${target.screenId}`).join(',')}`,
        jobType: 'screens.banner_duplicate',
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
        eventType: 'screens.banner_duplicate.requested',
        module: 'screens',
        payload: {
          mode,
          queuedJobId: jobId,
          requestedReason: body.reason ?? null,
          sourceBannerIds: uniqueSourceBannerIds,
          sourceDealerId: body.sourceDealerId,
          sourceDealerName: readDealerName(body.sourceDealerId),
          sourceScreenId: body.sourceScreenId,
          summary: buildQueuedBannerDuplicateSummary(mode, body.sourceDealerId, body.sourceScreenId, uniqueSourceBannerIds.length, uniqueTargetScreens.length),
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

function buildQueuedBannerDuplicateSummary(
  mode: ScreensRunMode,
  sourceDealerId: number,
  sourceScreenId: number,
  sourceBannerCount: number,
  targetScreenCount: number,
): string {
  const sourceDealerLabel = readDealerName(sourceDealerId)
  return mode === 'apply'
    ? `Queued live banner duplicate for ${sourceBannerCount} banner(s) from ${sourceDealerLabel} screen ${sourceScreenId} to ${targetScreenCount} target screen(s).`
    : `Queued dry-run banner duplicate for ${sourceBannerCount} banner(s) from ${sourceDealerLabel} screen ${sourceScreenId} to ${targetScreenCount} target screen(s).`
}

function buildQueuedRefreshSummary(
  mode: ScreensRunMode,
  siteDealerIds: number[],
  intent: ScreensBannerRefreshIntent = 'refresh',
  holdSeconds = 0,
  targetScreenCount = 0,
): string {
  const scopeLabel = targetScreenCount > 0
    ? `${targetScreenCount} selected screen(s)`
    : describeDealerSelection(siteDealerIds)
  if (intent === 'bounce') {
    const holdLabel = holdSeconds > 0 ? `${holdSeconds}-second` : 'immediate'
    return mode === 'apply'
      ? `Queued live ${holdLabel} banner/screen bounce for ${scopeLabel}.`
      : `Queued dry-run ${holdLabel} banner/screen bounce for ${scopeLabel}.`
  }
  return mode === 'apply'
    ? `Queued live banner refresh for ${scopeLabel}.`
    : `Queued dry-run banner refresh for ${scopeLabel}.`
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

function buildBulkToggleScope(target: ScreensBannerBulkToggleTarget): HeliosModuleScope | null {
  if (target.kind === 'explicit_banners') {
    return buildScreensImageBannerSyncScope(
      target.banners.map((banner) => ({ dealerId: banner.dealerId, screenId: banner.screenId })),
    )
  }

  const predicate = target.predicate
  if (predicate.screenRefs.length > 0) {
    return buildScreensImageBannerSyncScope(predicate.screenRefs)
  }
  if (predicate.siteDealerIds.length === 1) {
    return buildDealerScope(predicate.siteDealerIds[0])
  }
  return null
}

function buildQueuedBulkToggleSummary(
  mode: ScreensRunMode,
  desiredEnabled: boolean,
  target: ScreensBannerBulkToggleTarget,
): string {
  const action = desiredEnabled ? 'enable' : 'disable'
  const modeLabel = mode === 'apply' ? 'live' : 'dry-run'
  if (target.kind === 'explicit_banners') {
    return `Queued ${modeLabel} bulk ${action} for ${target.banners.length} selected banner(s).`
  }
  const scopeLabel = describeDealerSelection(target.predicate.siteDealerIds)
  return `Queued ${modeLabel} bulk ${action} for matching banners across ${scopeLabel}.`
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
