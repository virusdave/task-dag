import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  PricingFacetsQuerySchema,
  PricingFacetsResponseSchema,
  PricingReviewQuerySchema,
  PricingReviewResponseSchema,
  PricingRunDetailResponseSchema,
  PricingRunListQuerySchema,
  PricingRunListResponseSchema,
  PricingRunRouteParamsSchema,
  PricingScopePreviewQuerySchema,
  PricingScopePreviewResponseSchema,
  QueuePricingRunAcceptedResponseSchema,
  type PricingFacetsQuery,
  type PricingScopePreviewQuery,
  type PricingSelectionFilters,
  type PricingSiteKey,
  type QueuePricingRunRequest,
  QueuePricingRunRequestSchema,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import {
  getPricingRunDetail,
  listPricingFacetOptions,
  listPricingReviewItems,
  listPricingRuns,
  previewPricingRunScope,
  resolvePricingRunScope,
} from '../db/queries/pricingQueries.js'
import { getOptionalSweedSessionConcurrencyKey } from '../jobs/concurrency.js'
import { enqueueJob } from '../jobs/enqueueJob.js'
import { withTransaction } from '../db/tx.js'
import { loadLiveInStockProductIds } from '../../worker/pricing/productScope.js'
import { withSweedSession } from '../../worker/sweed/session.js'
import type { Queryable } from '../db/pool.js'

export async function registerPricingRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/pricing/scope-preview', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const query = PricingScopePreviewQuerySchema.parse(request.query)
    validateScopeFilters(query)
    const seedProductIds = await resolveSeedProductIds(getPool(), query)
    const preview = await previewPricingRunScope(getPool(), query, { seedProductIds })
    return reply.send(PricingScopePreviewResponseSchema.parse(preview))
  })

  server.get('/api/pricing/facets', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const query = PricingFacetsQuerySchema.parse(request.query)
    validateScopeFilters(query)
    const seedProductIds = await resolveSeedProductIds(getPool(), query)
    const response = await listPricingFacetOptions(getPool(), query, { seedProductIds })
    return reply.send(PricingFacetsResponseSchema.parse(response))
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
    validateScopeFilters(body)

    if (
      body.scopeKind === 'filtered_catalog'
      && !body.search
      && body.brands.length === 0
      && body.categories.length === 0
      && body.distributorNames.length === 0
      && body.subcategories.length === 0
      && body.unitSizes.length === 0
      && body.packSizes.length === 0
      && !body.stockOnly
      && !body.includePending
    ) {
      throw new Error('Filtered repricing runs must include at least one catalog filter or stock/pending source.')
    }

    const requestId = randomUUID()
    const seedProductIds = await resolveSeedProductIds(getPool(), body, { forceRefresh: body.forceLiveRefresh })
    const resolvedScope = await resolvePricingRunScope(getPool(), body, { seedProductIds })
    if (resolvedScope.catalogGroupIds.length === 0) {
      throw new Error(seedProductIds !== undefined && seedProductIds.length === 0
        ? 'The selected repricing scope does not match any mirrored catalog groups after applying the stock/pending source filters.'
        : 'The selected repricing scope does not match any mirrored catalog groups.')
    }

    const scopeLabel = body.scopeLabel?.trim() || buildScopeLabel(body)

    // Defensive: never queue a job with `scopedProductIds: []` — the
    // worker treats an empty/undefined value as "no product filter"
    // and would silently re-price the whole catalog. We checked the
    // resolved group count above so an empty array here means the SQL
    // intersection returned nothing meaningful.
    const scopedProductIds = resolvedScope.scopedProductIds === undefined
      ? undefined
      : resolvedScope.scopedProductIds.length === 0
        ? null
        : resolvedScope.scopedProductIds
    if (scopedProductIds === null) {
      throw new Error('The selected repricing scope resolved to zero products; refine your filters and try again.')
    }

    const selectionFiltersJson = selectionFiltersForPersistence(body)

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
            scopedProductIds: scopedProductIds ?? null,
            scopeKind: body.scopeKind,
            scopeLabel,
            selectionFilters: selectionFiltersJson,
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
          selectionFilters: selectionFiltersJson,
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

function validateScopeFilters(filters: { scopeKind: string; sites: PricingSiteKey[]; stockOnly: boolean; includePending: boolean }): void {
  if (filters.scopeKind === 'family_expansion_from_stock_or_pending') {
    if (!filters.stockOnly && !filters.includePending) {
      throw new Error('Family expansion requires the stock-only or include-pending source toggle to be on.')
    }
    if (filters.sites.length === 0) {
      throw new Error('Family expansion requires at least one selected site.')
    }
  }
}

function selectionFiltersForPersistence(body: QueuePricingRunRequest): PricingSelectionFilters {
  return {
    brands: body.brands,
    categories: body.categories,
    distributorNames: body.distributorNames,
    includePending: body.includePending,
    packSizes: body.packSizes,
    search: body.search,
    sites: body.sites,
    stockOnly: body.stockOnly,
    strict: body.strict,
    subcategories: body.subcategories,
    unitSizes: body.unitSizes,
  }
}

function buildScopeLabel(body: QueuePricingRunRequest): string {
  const parts: string[] = []
  if (body.scopeKind === 'family_expansion_from_stock_or_pending') {
    parts.push(body.strict ? 'Stock+pending (strict)' : 'Family expansion')
  }
  if (body.brands.length > 0) parts.push(body.brands.join(', '))
  if (body.distributorNames.length > 0) parts.push(body.distributorNames.join(', '))
  if (body.categories.length > 0) parts.push(body.categories.join(', '))
  if (body.subcategories.length > 0) parts.push(body.subcategories.join(', '))
  if (body.unitSizes.length > 0) parts.push(body.unitSizes.join(', '))
  if (body.packSizes.length > 0) parts.push(body.packSizes.map(formatPackSizeLabel).join(', '))
  if (body.search) parts.push(body.search)
  const productScopeLabels = buildProductScopeLabels(body)
  if (productScopeLabels.length > 0) {
    parts.push(...productScopeLabels)
  }
  if (parts.length === 0) {
    if (body.scopeKind === 'full_catalog') return 'Full catalog'
    if (body.scopeKind === 'family_expansion_from_stock_or_pending') return 'Family expansion'
    return 'Filtered catalog'
  }
  return parts.join(' · ')
}

function buildProductScopeLabels(filters: { sites: PricingSiteKey[]; stockOnly: boolean; includePending: boolean }): string[] {
  const siteLabels = filters.sites.map((siteKey) => (siteKey === 'bronx' ? 'Bronx' : 'Midtown'))
  const siteSummary = siteLabels.length > 0 ? siteLabels.join('+') : null
  const labels: string[] = []
  if (filters.stockOnly) {
    labels.push(siteSummary ? `${siteSummary} in stock` : 'In stock')
  }
  if (filters.includePending) {
    labels.push(siteSummary ? `${siteSummary} pending purchases` : 'Pending purchases')
  }
  return labels
}

function formatPackSizeLabel(value: string): string {
  const numeric = Number(value)
  if (Number.isInteger(numeric) && numeric > 0) {
    return numeric === 1 ? '1 per pkg' : `${numeric}-pack`
  }
  return value
}

async function resolveSeedProductIds(
  db: Queryable,
  filters: PricingScopePreviewQuery | QueuePricingRunRequest | PricingFacetsQuery,
  options?: { forceRefresh?: boolean },
): Promise<number[] | undefined> {
  const needsSeed = filters.scopeKind === 'family_expansion_from_stock_or_pending'
    || filters.stockOnly
    || filters.includePending
  if (!needsSeed) {
    return undefined
  }

  const selectedDealerIds = HELIOS_PENDING_PURCHASE_SITE_DEALERS
    .filter((site) => filters.sites.includes(site.siteKey as PricingSiteKey))
    .map((site) => site.dealerId)
  const selectedSiteKeys = filters.sites.slice()

  const merged = new Set<number>()

  if (filters.stockOnly && selectedDealerIds.length > 0) {
    // `loadLiveInStockProductIds` calls Sweed RPC, which requires an
    // active pool-claimed session (the legacy SWEED_AUTH_TOKEN fallback
    // is permanently dead — see AGENTS.md "Sweed auth"). The route is
    // running on the server (not inside a worker job that already
    // wraps in `withSweedSession`), so we open a session here.
    //
    // `loadLiveInStockProductIds` has its own short TTL cache, so
    // scope-preview page loads within the cache window short-circuit
    // before ever touching the pool. `options.forceRefresh` (set by
    // queue-run with `forceLiveRefresh`) bypasses the cache.
    const liveIds = await withSweedSession(() =>
      loadLiveInStockProductIds(selectedDealerIds, { forceRefresh: options?.forceRefresh ?? false }),
    )
    for (const id of liveIds) merged.add(id)
  }

  if (filters.includePending && selectedSiteKeys.length > 0) {
    const pendingIds = await loadPendingPurchaseProductIds(db, selectedSiteKeys)
    for (const id of pendingIds) merged.add(id)
  }

  return [...merged].sort((left, right) => left - right)
}

async function loadPendingPurchaseProductIds(db: Queryable, siteKeys: PricingSiteKey[]): Promise<number[]> {
  if (siteKeys.length === 0) {
    return []
  }
  // Pending purchases that are still "live" — i.e. on a packet that
  // hasn't been superseded — and that have already been mapped to an
  // existing catalog product. Rows creating new catalog entries can't
  // contribute to a pricing run because the product doesn't exist yet.
  //
  // Effective product id resolution (mirrors mapPendingPurchaseRow()
  // in pendingPurchaseQueries.ts AND loadPendingPurchaseRow() in
  // applyPendingPurchaseRequestJob.ts):
  //   - If `edited_structured_fields` has the key `targetReuseProductId`,
  //     that value wins (positive int = reviewer's forced link;
  //     explicit null = reviewer cleared the parser-proposed reuse,
  //     so the row contributes nothing here).
  //   - Otherwise fall back to `raw_row_json.reuseProductId`.
  //
  // Schema notes (the .sql files in db/schema are out of date — read
  // information_schema for ground truth):
  //   - pending_purchase_packets PK is `id` (not `packet_id`)
  //   - pending_purchase_rows.packet_id → pending_purchase_packets.id
  //   - There is no `matched_product_id` column.
  const result = await db.query<{ product_id: number }>(
    `
      with resolved as (
        select
          case
            when ppr.edited_structured_fields ? 'targetReuseProductId'
              then nullif(ppr.edited_structured_fields ->> 'targetReuseProductId', '')
            else ppr.raw_row_json ->> 'reuseProductId'
          end as raw_id
        from pending_purchase_rows ppr
        inner join pending_purchase_packets ppp on ppp.id = ppr.packet_id
        where ppp.status = 'ready'
          and ppr.site_key = any($1::text[])
      )
      select distinct raw_id::int as product_id
      from resolved
      where raw_id is not null
        and raw_id ~ '^[0-9]+$'
        and raw_id::int > 0
      order by product_id asc
    `,
    [siteKeys],
  )
  return result.rows.map((row) => row.product_id)
}
