import type { FastifyInstance } from 'fastify'
import type { TradeSampleStageResult, TradeSampleZeroItem } from '../../shared/contracts/index.js'

import {
  CatalogInventoryStageTradeSamplesJobPayloadSchema,
  CatalogInventoryZeroTradeSamplesJobPayloadSchema,
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  TradeSampleStageResultSchema,
  TradeSampleRecentStageJobQuerySchema,
  TradeSampleRecentStageJobResponseSchema,
  TradeSampleZeroApplyRequestSchema,
  TradeSampleZeroApprovalRequestSchema,
  TradeSampleZeroEnqueueResponseSchema,
  TradeSampleZeroPreviewRequestSchema,
  TradeSampleZeroPreviewResponseSchema,
} from '../../shared/contracts/index.js'
import { withSweedSession } from '../../worker/sweed/session.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { requireSessionUser } from '../auth/requireSession.js'
import {
  assertTargetContents,
  previewTradeSampleZero,
  readLiveInventory,
  resolveTradeSampleDestination,
  TradeSampleTargetError,
  verifyTradeSampleZeroPreview,
} from '../catalog/tradeSampleZeroService.js'
import { getPool } from '../db/pool.js'
import { getJobStatus } from '../db/queries/jobQueries.js'
import { withTransaction } from '../db/tx.js'
import { enqueueJobExactOnce, JOB_PRIORITY_LIVE_REQUESTED } from '../jobs/enqueueJob.js'

export async function registerTradeSampleZeroRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/catalog/inventory/trade-samples/recent-stage-job', async (request, reply) => {
    if (!await requireSessionUser(request, reply, 'viewer')) return
    const parsed = TradeSampleRecentStageJobQuerySchema.safeParse(request.query)
    if (
      !parsed.success
      || !HELIOS_PENDING_PURCHASE_SITE_DEALERS.some((site) => site.dealerId === parsed.data.siteDealerId)
    ) {
      return reply.status(400).send({ error: 'A configured site is required.' })
    }
    const scopeEntityId = String(parsed.data.siteDealerId)
    const recent = await getPool().query<{ id: number }>(
      `select id
         from job_queue
        where job_type = 'catalog.inventory.stage_trade_samples'
          and scope_entity_type = 'trade_sample_site'
          and scope_entity_id = $1
        order by created_at desc, id desc
        limit 1`,
      [scopeEntityId],
    )
    const stageJob = recent.rows[0] ? await getJobStatus(getPool(), recent.rows[0].id) : null
    return reply.send(TradeSampleRecentStageJobResponseSchema.parse({ stageJob }))
  })

  server.post('/api/catalog/inventory/trade-samples/preview-zero', async (request, reply) => {
    if (!await requireSessionUser(request, reply, 'editor')) return
    const parsed = TradeSampleZeroPreviewRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.status(400).send({ error: 'A valid site is required.' })
    try {
      const preview = await withSweedSession(() => previewTradeSampleZero(parsed.data.siteDealerId))
      return reply.send(TradeSampleZeroPreviewResponseSchema.parse(preview))
    } catch (error) {
      request.log.error({ err: error, requestId: request.id }, 'trade sample preview failed')
      if (error instanceof TradeSampleTargetError) {
        return reply.status(409).send({ error: error.message })
      }
      return reply.status(409).send({ error: 'Trade sample preview could not be created safely.' })
    }
  })

  server.post('/api/catalog/inventory/trade-samples/apply-zero', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return
    const parsed = TradeSampleZeroApplyRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success || !verifyTradeSampleZeroPreview(parsed.data)) {
      return reply.status(409).send({ error: 'Invalid or expired staging preview.' })
    }
    const operationId = `catalog.inventory.stage_trade_samples:${parsed.data.siteDealerId}:${parsed.data.previewId}`
    const { previewToken: _previewToken, ...reviewed } = parsed.data
    const payload = CatalogInventoryStageTradeSamplesJobPayloadSchema.parse({
      ...reviewed,
      actorUserId: user.id,
      requestId: operationId,
    })
    const result = await withTransaction((db) => enqueueJobExactOnce(db, {
      jobType: 'catalog.inventory.stage_trade_samples',
      module: 'catalog',
      scope: { entityType: 'trade_sample_site', entityId: String(parsed.data.siteDealerId) },
      payload,
      priority: JOB_PRIORITY_LIVE_REQUESTED,
      concurrencyKey: `catalog.inventory.trade_samples:${parsed.data.siteDealerId}`,
      dedupeKey: operationId,
      requestedByUserId: user.id,
    }))
    if (!result.inserted && !result.exactPayload) {
      return reply.status(409).send({ error: 'This preview was already used differently.' })
    }
    return reply.send(TradeSampleZeroEnqueueResponseSchema.parse({ jobId: result.jobId }))
  })

  server.post('/api/catalog/inventory/trade-samples/stage-jobs/:jobId/approve-zero', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return
    const jobId = Number((request.params as { jobId?: string }).jobId)
    const approval = TradeSampleZeroApprovalRequestSchema.safeParse(request.body ?? {})
    if (!Number.isInteger(jobId) || jobId < 1 || !approval.success) {
      return reply.status(400).send({ error: 'Exact approval confirmation is required.' })
    }

    const query = await getPool().query<{ job_payload_json: unknown; result_payload_json: unknown; status: string }>(
      `select jq.payload_json as job_payload_json, ae.payload_json as result_payload_json, jq.status
         from job_queue jq
         join audit_events ae
           on ae.entity_type = 'trade_sample_stage_batch'
          and ae.entity_id = jq.id::text
          and ae.event_type = 'trade_sample.stage.batch_result'
        where jq.id = $1
          and jq.job_type = 'catalog.inventory.stage_trade_samples'
        order by ae.id desc
        limit 1`,
      [jobId],
    )
    const stage = TradeSampleStageResultSchema.safeParse(query.rows[0]?.result_payload_json)
    const stagedJob = CatalogInventoryStageTradeSamplesJobPayloadSchema.safeParse(query.rows[0]?.job_payload_json)
    if (
      !stage.success
      || !stage.data.complete
      || !stagedJob.success
      || query.rows[0]?.status !== 'succeeded'
      || stage.data.operationId !== stagedJob.data.requestId
      || stage.data.siteDealerId !== stagedJob.data.siteDealerId
      || JSON.stringify(stage.data.destination) !== JSON.stringify(stagedJob.data.destination)
      || !isTrustedStagedItemSet(stagedJob.data.items, stage.data.items, stage.data.destination)
    ) {
      return reply.status(409).send({ error: 'A complete successful stage result is required.' })
    }

    const requestId = `catalog.inventory.zero_trade_samples:stage:${jobId}`
    const payload = CatalogInventoryZeroTradeSamplesJobPayloadSchema.parse({
      siteDealerId: stage.data.siteDealerId,
      destination: stage.data.destination,
      items: stage.data.items,
      confirmation: approval.data.confirmation,
      stageJobId: jobId,
      actorUserId: user.id,
      requestId,
    })
    const existing = await getPool().query<{ exact_payload: boolean; id: number }>(
      `select id, payload_json = $2::jsonb as exact_payload
         from job_queue
        where dedupe_key = $1
          and status in ('queued', 'running', 'succeeded', 'failed', 'dead_letter')
        limit 1`,
      [requestId, JSON.stringify(payload)],
    )
    if (existing.rows[0]) {
      if (!existing.rows[0].exact_payload) {
        return reply.status(409).send({ error: 'This staged job was already approved differently.' })
      }
      return reply.send(TradeSampleZeroEnqueueResponseSchema.parse({ jobId: existing.rows[0].id }))
    }

    try {
      await withSweedSession(async () => {
        const destination = await resolveTradeSampleDestination(stage.data.siteDealerId)
        if (JSON.stringify(destination) !== JSON.stringify(stage.data.destination)) throw new Error('Destination changed.')
        assertTargetContents(await readLiveInventory(stage.data.siteDealerId, destination), destination, stage.data.items)
      })
    } catch {
      return reply.status(409).send({
        error: 'Dedicated location no longer exactly matches the staged trade samples. Zero was not queued.',
      })
    }

    const result = await withTransaction(async (db) => {
      const enqueued = await enqueueJobExactOnce(db, {
        jobType: 'catalog.inventory.zero_trade_samples',
        module: 'catalog',
        scope: null,
        payload,
        priority: JOB_PRIORITY_LIVE_REQUESTED,
        concurrencyKey: `catalog.inventory.trade_samples:${stage.data.siteDealerId}`,
        dedupeKey: requestId,
        requestedByUserId: user.id,
      })
      if (enqueued.inserted) {
        await appendAuditEvent(db, {
          actorType: 'user',
          actorUserId: user.id,
          module: 'catalog',
          scope: null,
          entityType: 'trade_sample_stage_batch',
          entityId: String(jobId),
          eventType: 'trade_sample.zero.approved',
          requestId,
          payload: {
            stageJobId: jobId,
            zeroJobId: enqueued.jobId,
            siteDealerId: stage.data.siteDealerId,
            destination: stage.data.destination,
            items: stage.data.items,
          },
          undoPayload: null,
        })
      }
      return enqueued
    })
    if (!result.inserted && !result.exactPayload) {
      return reply.status(409).send({ error: 'This staged job was already approved.' })
    }
    return reply.send(TradeSampleZeroEnqueueResponseSchema.parse({ jobId: result.jobId }))
  })
}

function isTrustedStagedItemSet(
  reviewed: TradeSampleZeroItem[],
  staged: TradeSampleZeroItem[],
  destination: TradeSampleStageResult['destination'],
): boolean {
  if (reviewed.length !== staged.length) return false
  const reviewedCounts = new Map<string, number>()
  for (const item of reviewed) {
    const key = trustedItemIdentity(item)
    reviewedCounts.set(key, (reviewedCounts.get(key) ?? 0) + 1)
  }
  const stagedIds = new Set(staged.map((item) => item.inventoryItemId))
  if (stagedIds.size !== staged.length) return false
  for (const item of staged) {
    const key = trustedItemIdentity(item)
    const remaining = reviewedCounts.get(key) ?? 0
    if (
      remaining === 0
      || item.sourceLocationId !== destination.id
      || item.sourceLocationName !== destination.name
      || item.sourceStockTypeId !== destination.stockTypeId
    ) return false
    if (remaining === 1) reviewedCounts.delete(key)
    else reviewedCounts.set(key, remaining - 1)
  }
  return reviewedCounts.size === 0
}

function trustedItemIdentity(item: TradeSampleZeroItem): string {
  return JSON.stringify([
    item.productId,
    item.externalTrackCode,
    item.currentQty,
    item.availableQty,
    item.packageLabel,
    item.productName,
    item.productSku,
  ])
}
