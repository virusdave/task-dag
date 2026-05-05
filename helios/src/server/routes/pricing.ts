import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'

import {
  PricingReviewQuerySchema,
  PricingReviewResponseSchema,
  PricingRunDetailResponseSchema,
  PricingRunListQuerySchema,
  PricingRunListResponseSchema,
  PricingRunRouteParamsSchema,
  PricingScopePreviewQuerySchema,
  PricingScopePreviewResponseSchema,
  QueuePricingRunAcceptedResponseSchema,
  type PricingScopePreviewQuery,
  type QueuePricingRunRequest,
  QueuePricingRunRequestSchema,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import {
  getPricingRunDetail,
  listPricingReviewItems,
  listPricingRuns,
  previewPricingRunScope,
  resolvePricingRunScope,
} from '../db/queries/pricingQueries.js'
import { getOptionalSweedSessionConcurrencyKey } from '../jobs/concurrency.js'
import { enqueueJob } from '../jobs/enqueueJob.js'
import { withTransaction } from '../db/tx.js'
import { loadLiveInStockProductIds, loadMidtownReceivedProductIds } from '../../worker/pricing/productScope.js'

export async function registerPricingRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/pricing/scope-preview', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const query = PricingScopePreviewQuerySchema.parse(request.query)
    const scopedProductIds = await resolveScopedProductIds(query)
    const preview = await previewPricingRunScope(getPool(), query, {
      scopedProductIds,
    })
    return reply.send(PricingScopePreviewResponseSchema.parse(preview))
  })

  server.get('/api/pricing/runs', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const query = PricingRunListQuerySchema.parse(request.query)
    const response = await listPricingRuns(getPool(), query)
    return reply.send(PricingRunListResponseSchema.parse(response))
  })

  server.post('/api/pricing/runs', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) {
      return
    }

    const body = QueuePricingRunRequestSchema.parse(request.body ?? {})
    if (
      body.scopeKind === 'filtered_catalog'
      && !body.search
      && !body.brand
      && !body.category
      && !body.subcategory
      && !body.liveBronxInventory
      && !body.liveMidtownInventory
      && !body.midtownEverReceived
    ) {
      throw new Error('Filtered repricing runs must include at least one catalog filter.')
    }

    const requestId = randomUUID()
    const scopedProductIds = await resolveScopedProductIds(body, { forceRefresh: body.forceLiveRefresh })
    const scopeFilters = {
      brand: body.brand,
      category: body.category,
      liveBronxInventory: body.liveBronxInventory,
      liveMidtownInventory: body.liveMidtownInventory,
      midtownEverReceived: body.midtownEverReceived,
      scopeKind: body.scopeKind,
      search: body.search,
      subcategory: body.subcategory,
    }
    const resolvedScope = await resolvePricingRunScope(getPool(), scopeFilters, { scopedProductIds })
    if (resolvedScope.catalogGroupIds.length === 0) {
      throw new Error(scopedProductIds && scopedProductIds.length === 0
        ? 'The selected repricing scope does not match any mirrored catalog groups after applying the live and historical product-scope filters.'
        : 'The selected repricing scope does not match any mirrored catalog groups.')
    }

    const scopeLabel = body.scopeLabel?.trim() || buildScopeLabel(body)

    const mutationResult = await withTransaction(async (db) => {
      const proposalBatchInsert = await db.query<{ id: number }>(
        `
          insert into proposal_batches (
            type,
            source,
            trigger_mode,
            status,
            prompt_version,
            model,
            summary_json,
            config_json,
            created_by_user_id
          )
          values (
            'pricing',
            'generated',
            'ui',
            'draft',
            $1,
            $2,
            $3::jsonb,
            $4::jsonb,
            $5
          )
          returning id
        `,
        [
          'pricing-deterministic-v2-market-evidence',
          'deterministic-margin-band',
          JSON.stringify({
            generatedGroupCount: 0,
            generatedLineItemCount: 0,
            requestedGroupCount: resolvedScope.catalogGroupIds.length,
            skippedProductCount: 0,
          }),
          JSON.stringify({
            catalogGroupIds: resolvedScope.catalogGroupIds,
            forceLiveRefresh: body.forceLiveRefresh,
            resolvedCatalogGroupCount: resolvedScope.catalogGroupIds.length,
            resolvedProductCount: resolvedScope.matchedProductCount,
            scopedProductIds,
            scopeKind: body.scopeKind,
            scopeLabel,
            selectionFilters: {
              brand: body.brand ?? null,
              category: body.category ?? null,
              liveBronxInventory: body.liveBronxInventory,
              liveMidtownInventory: body.liveMidtownInventory,
              midtownEverReceived: body.midtownEverReceived,
              search: body.search ?? null,
              subcategory: body.subcategory ?? null,
            },
            triggerSource: 'manual',
          }),
          user.id,
        ],
      )

      const proposalBatchId = proposalBatchInsert.rows[0].id
      const jobId = await enqueueJob(db, {
        concurrencyKey: getOptionalSweedSessionConcurrencyKey(body.forceLiveRefresh),
        dedupeKey: `proposal.generate.pricing_batch:${proposalBatchId}`,
        jobType: 'proposal.generate.pricing_batch',
        module: 'pricing',
        payload: {
          forceLiveRefresh: body.forceLiveRefresh,
          proposalBatchId,
          requestedByUserId: user.id,
          trigger: 'ui_generate',
        },
        requestedByUserId: user.id,
      })

      await db.query('update proposal_batches set job_id = $2 where id = $1', [proposalBatchId, jobId])

      const auditEventId = await appendAuditEvent(db, {
        actorType: 'user',
        actorUserId: user.id,
        entityId: String(proposalBatchId),
        entityType: 'proposal_batch',
        eventType: 'proposal.batch.generation_requested',
        module: 'pricing',
        payload: {
          forceLiveRefresh: body.forceLiveRefresh,
          proposalBatchId,
          queuedJobId: jobId,
          requestedReason: body.reason ?? null,
          resolvedCatalogGroupCount: resolvedScope.catalogGroupIds.length,
          resolvedProductCount: resolvedScope.matchedProductCount,
          scopeKind: body.scopeKind,
          scopeLabel,
          selectionFilters: {
            brand: body.brand ?? null,
            category: body.category ?? null,
            liveBronxInventory: body.liveBronxInventory,
            liveMidtownInventory: body.liveMidtownInventory,
            midtownEverReceived: body.midtownEverReceived,
            search: body.search ?? null,
            subcategory: body.subcategory ?? null,
          },
        },
        requestId,
        undoPayload: null,
      })

      return { auditEventId, jobId, proposalBatchId }
    })

    return reply.send(QueuePricingRunAcceptedResponseSchema.parse({
      auditEventId: mutationResult.auditEventId,
      jobId: mutationResult.jobId,
      proposalBatchId: mutationResult.proposalBatchId,
      requestId,
    }))
  })

  server.get('/api/pricing/runs/:proposalBatchId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const params = PricingRunRouteParamsSchema.parse(request.params)
    const detail = await getPricingRunDetail(getPool(), params.proposalBatchId)
    if (!detail) {
      return reply.status(404).send({ error: 'Pricing run not found.' })
    }

    return reply.send(PricingRunDetailResponseSchema.parse(detail))
  })

  server.get('/api/pricing/review', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const query = PricingReviewQuerySchema.parse(request.query)
    const response = await listPricingReviewItems(getPool(), query)
    return reply.send(PricingReviewResponseSchema.parse(response))
  })
}

function buildScopeLabel(body: QueuePricingRunRequest): string {
  if (body.scopeKind === 'full_catalog') {
    return buildCatalogScopeLabel(body)
  }

  const parts = [body.brand, body.category, body.subcategory, body.search].filter((value): value is string => Boolean(value))
  const productScopeLabels = buildProductScopeLabels(body)
  if (productScopeLabels.length > 0) {
    parts.push(...productScopeLabels)
  }
  return parts.length > 0 ? parts.join(' · ') : 'Filtered catalog'
}

async function resolveScopedProductIds(
  filters: Pick<QueuePricingRunRequest, 'liveBronxInventory' | 'liveMidtownInventory' | 'midtownEverReceived'>,
  options?: { forceRefresh?: boolean },
): Promise<number[] | undefined> {
  const scopedSets: number[][] = []
  const liveInventoryDealerIds: number[] = []
  if (filters.liveBronxInventory) {
    liveInventoryDealerIds.push(210249)
  }
  if (filters.liveMidtownInventory) {
    liveInventoryDealerIds.push(210705)
  }
  if (liveInventoryDealerIds.length > 0) {
    scopedSets.push(await loadLiveInStockProductIds(liveInventoryDealerIds))
  }
  if (filters.midtownEverReceived) {
    scopedSets.push(await loadMidtownReceivedProductIds({ forceRefresh: options?.forceRefresh }))
  }
  if (scopedSets.length === 0) {
    return undefined
  }

  let intersection = new Set(scopedSets[0] ?? [])
  for (const scopedProductIds of scopedSets.slice(1)) {
    const nextSet = new Set(scopedProductIds)
    intersection = new Set([...intersection].filter((productId) => nextSet.has(productId)))
  }

  return [...intersection].sort((left, right) => left - right)
}

function buildCatalogScopeLabel(filters: Pick<QueuePricingRunRequest, 'liveBronxInventory' | 'liveMidtownInventory' | 'midtownEverReceived'>): string {
  const productScopeLabel = buildProductScopeLabels(filters).join(' · ')
  return productScopeLabel ? `${productScopeLabel} catalog` : 'Full catalog'
}

function buildProductScopeLabels(
  filters: Pick<PricingScopePreviewQuery, 'liveBronxInventory' | 'liveMidtownInventory' | 'midtownEverReceived'>,
): string[] {
  const labels: string[] = []
  if (filters.midtownEverReceived) {
    labels.push('Midtown ever received')
  }
  if (filters.liveBronxInventory && filters.liveMidtownInventory) {
    labels.push('Bronx + Midtown live inventory')
    return labels
  }
  if (filters.liveBronxInventory) {
    labels.push('Bronx live inventory')
  }
  if (filters.liveMidtownInventory) {
    labels.push('Midtown live inventory')
  }
  return labels
}
