import type { FastifyInstance } from 'fastify'
import type { TradeSampleZeroItem } from '../../shared/contracts/index.js'

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
  previewTradeSampleZero,
  readLiveInventory,
  reconcileTargetContents,
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
      confirmed: parsed.data.confirmed,
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
      return reply.status(400).send({ error: 'Confirmation is required.' })
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
    ) {
      return reply.status(409).send({ error: 'A complete successful stage result is required.' })
    }

    try {
      if (stage.data.items.some((item) =>
        item.sourceLocationId !== stage.data.destination.id
        || item.sourceLocationName.trim() !== stage.data.destination.name
        || item.sourceStockTypeId !== stage.data.destination.stockTypeId
      )) {
        throw new TradeSampleTargetError('A recorded staged package is outside the dedicated destination.')
      }
      reconcileTargetContents(
        stage.data.items.map((item) => ({ ...item, isTradeSample: true })),
        stage.data.destination,
        stagedJob.data.items,
      )
    } catch (error) {
      request.log.error({ err: error, jobId, requestId: request.id }, 'trade sample stage result did not reconcile')
      return reply.status(409).send({ error: 'The recorded stage result does not match the reviewed package totals.' })
    }

    const requestId = `catalog.inventory.zero_trade_samples:stage:${jobId}`
    const existing = await getPool().query<{ exact_payload: boolean; id: number }>(
      `select id, true as exact_payload
         from job_queue
        where dedupe_key = $1
          and status in ('queued', 'running', 'succeeded', 'failed', 'dead_letter')
        limit 1`,
      [requestId],
    )
    if (existing.rows[0]) {
      if (!existing.rows[0].exact_payload) {
        return reply.status(409).send({ error: 'This staged job was already approved differently.' })
      }
      return reply.send(TradeSampleZeroEnqueueResponseSchema.parse({ jobId: existing.rows[0].id }))
    }

    let liveItems: TradeSampleZeroItem[]
    try {
      liveItems = await withSweedSession(async () => {
        const destination = await resolveTradeSampleDestination(stage.data.siteDealerId)
        if (JSON.stringify(destination) !== JSON.stringify(stage.data.destination)) throw new Error('Destination changed.')
        return reconcileTargetContents(
          await readLiveInventory(stage.data.siteDealerId, destination),
          destination,
          stagedJob.data.items,
        )
      })
    } catch (error) {
      request.log.error({ err: error, jobId, requestId: request.id }, 'trade sample approval live reconciliation failed')
      return reply.status(409).send({
        error: error instanceof TradeSampleTargetError
          ? `${error.message} Zero was not queued.`
          : 'The dedicated location could not be verified safely. Zero was not queued.',
      })
    }

    const payload = CatalogInventoryZeroTradeSamplesJobPayloadSchema.parse({
      siteDealerId: stage.data.siteDealerId,
      destination: stage.data.destination,
      items: liveItems,
      confirmed: approval.data.confirmed,
      stageJobId: jobId,
      actorUserId: user.id,
      requestId,
    })

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
            items: liveItems,
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
