import type { QueryResultRow } from 'pg'

import {
  NormalizedCatalogGroupLiveStateSchema,
  type NormalizedCatalogGroupLiveState,
} from '../catalog/liveState.js'
import type { ConfigWorkersLitalertsRefreshVariantJobPayload } from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { withTransaction } from '../../server/db/tx.js'
import { getPool } from '../../server/db/pool.js'
import type { ProductPricingMarketEvidence } from '../pricing/deterministicPricing.js'
import { buildPricingMarketContext } from '../pricing/litAlertsMarket.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

interface QueueRow extends QueryResultRow {
  id: number
  product_id: number
  site_dealer_id: number | null
  source_snapshot_id: number | null
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}

interface CatalogGroupRow extends QueryResultRow {
  id: number
  group_name: string
  brand_name: string | null
  category_name: string | null
  live_state_json: unknown
}

export async function runConfigWorkersLitalertsRefreshVariantJob(
  context: JobHandlerContext,
  payload: ConfigWorkersLitalertsRefreshVariantJobPayload,
): Promise<void> {
  const queueRow = await loadQueueRow(payload.queueRowId)
  if (!queueRow) {
    // The row was cleaned up between enqueue and run; nothing to do.
    return
  }

  // Idempotent skip when the row was already drained by a prior attempt.
  if (queueRow.status === 'completed') {
    return
  }

  let observationId: number | null = null
  let groupRow: CatalogGroupRow | null = null
  let liveState: NormalizedCatalogGroupLiveState | null = null
  let evidence: ProductPricingMarketEvidence | null = null
  let availability: string | null = null
  let searchTermLabel: string | null = null
  let searchTerms: string[] = []
  let notes: string | null = null

  try {
    groupRow = await findCatalogGroupContainingProduct(payload.productId)
    if (groupRow) {
      liveState = NormalizedCatalogGroupLiveStateSchema.parse(groupRow.live_state_json)

      const marketContext = await buildPricingMarketContext(liveState)
      availability = marketContext.availability
      searchTermLabel = marketContext.searchTerm
      if (marketContext.searchTerm) {
        searchTerms = [marketContext.searchTerm]
      }
      evidence = marketContext.productEvidenceById[payload.productId] ?? null
      notes = marketContext.note ?? null
    } else {
      availability = 'no_catalog_group'
      notes = `No catalog group currently mirrors variant productId=${payload.productId}; cannot resolve brand for Lit Alerts refresh.`
    }

    observationId = await persistObservationAndCloseQueue({
      context,
      payload,
      groupRow,
      liveState,
      availability,
      searchTermLabel,
      searchTerms,
      evidence,
      notes,
      status: 'succeeded',
      error: null,
    })

    await withTransaction(async (db) => {
      await appendAuditEvent(db, {
        actorType: payload.requestedByUserId ? 'user' : 'system',
        actorUserId: payload.requestedByUserId ?? null,
        entityId: String(context.id),
        entityType: 'job',
        eventType: 'config.workers.litalerts_refresh.completed',
        module: 'config',
        payload: {
          availability,
          listingCount: evidence?.matchedListings.length ?? 0,
          observationId,
          productId: payload.productId,
          queueRowId: payload.queueRowId,
          searchTermLabel,
          status: 'succeeded',
          trigger: payload.trigger,
        },
        requestId: null,
        scope: null,
        undoPayload: null,
      })
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Lit Alerts refresh error.'
    await persistObservationAndCloseQueue({
      context,
      payload,
      groupRow,
      liveState,
      availability,
      searchTermLabel,
      searchTerms,
      evidence,
      notes,
      status: 'failed',
      error: message,
    })

    await withTransaction(async (db) => {
      await appendAuditEvent(db, {
        actorType: payload.requestedByUserId ? 'user' : 'system',
        actorUserId: payload.requestedByUserId ?? null,
        entityId: String(context.id),
        entityType: 'job',
        eventType: 'config.workers.litalerts_refresh.completed',
        module: 'config',
        payload: {
          availability,
          error: message,
          productId: payload.productId,
          queueRowId: payload.queueRowId,
          status: 'failed',
          trigger: payload.trigger,
        },
        requestId: null,
        scope: null,
        undoPayload: null,
      })
    })

    throw error
  }
}

async function loadQueueRow(queueRowId: number): Promise<QueueRow | null> {
  const result = await getPool().query<QueueRow>(
    `
      select id, product_id, site_dealer_id, source_snapshot_id, status
      from pending_litalerts_refresh_queue
      where id = $1
    `,
    [queueRowId],
  )
  return result.rows[0] ?? null
}

async function findCatalogGroupContainingProduct(productId: number): Promise<CatalogGroupRow | null> {
  const result = await getPool().query<CatalogGroupRow>(
    `
      select id, group_name, brand_name, category_name, live_state_json
      from catalog_groups
      where (live_state_json -> 'products') @> $1::jsonb
      limit 1
    `,
    [JSON.stringify([{ productId }])],
  )
  return result.rows[0] ?? null
}

interface PersistObservationInput {
  context: JobHandlerContext
  payload: ConfigWorkersLitalertsRefreshVariantJobPayload
  groupRow: CatalogGroupRow | null
  liveState: NormalizedCatalogGroupLiveState | null
  availability: string | null
  searchTermLabel: string | null
  searchTerms: string[]
  evidence: ProductPricingMarketEvidence | null
  notes: string | null
  status: 'succeeded' | 'failed'
  error: string | null
}

async function persistObservationAndCloseQueue(input: PersistObservationInput): Promise<number> {
  const { context, payload, groupRow, liveState, evidence } = input

  const matchedListings = evidence?.matchedListings ?? []
  const nearListings = matchedListings.filter((listing) => listing.distanceBand === 'near')
  const midListings = matchedListings.filter((listing) => listing.distanceBand === 'mid')
  const farListings = matchedListings.filter((listing) => listing.distanceBand === 'far')
  const pricingEligibleListings = matchedListings.filter((listing) => listing.eligibleForPricing)

  return withTransaction(async (db) => {
    const insertResult = await db.query<{ id: number }>(
      `
        insert into litalerts_competitor_observations (
          queue_row_id, product_id, site_dealer_id, source_snapshot_id, job_id,
          status, brand_id, brand_name, group_id, group_name, category_name,
          search_terms_json, search_term_label, availability,
          listing_count, pricing_eligible_listing_count,
          near_listing_count, mid_listing_count, far_listing_count,
          evidence_json, notes, error
        ) values (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10, $11,
          $12::jsonb, $13, $14,
          $15, $16,
          $17, $18, $19,
          $20::jsonb, $21, $22
        )
        returning id
      `,
      [
        payload.queueRowId,
        payload.productId,
        payload.siteDealerId ?? null,
        payload.sourceSnapshotId ?? null,
        context.id,
        input.status,
        null, // brand_id is internal Lit Alerts id; market context does not surface it directly
        liveState?.brand ?? null,
        groupRow?.id ?? liveState?.groupId ?? null,
        groupRow?.group_name ?? liveState?.groupName ?? null,
        groupRow?.category_name ?? liveState?.category ?? null,
        JSON.stringify(input.searchTerms),
        input.searchTermLabel,
        input.availability,
        matchedListings.length,
        pricingEligibleListings.length,
        nearListings.length,
        midListings.length,
        farListings.length,
        JSON.stringify(evidence ?? {}),
        input.notes,
        input.error,
      ],
    )

    const newObservationId = insertResult.rows[0].id

    const finalQueueStatus = input.status === 'succeeded' ? 'completed' : 'cancelled'
    await db.query(
      `
        update pending_litalerts_refresh_queue
        set status = $2,
            completed_at = now(),
            notes = coalesce($3, notes)
        where id = $1
      `,
      [
        payload.queueRowId,
        finalQueueStatus,
        input.error
          ? `Lit Alerts refresh failed: ${input.error}`
          : input.notes,
      ],
    )

    return newObservationId
  })
}
