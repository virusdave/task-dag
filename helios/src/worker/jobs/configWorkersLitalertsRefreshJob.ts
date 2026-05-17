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
import { rollingRefreshJitterSecondsForProduct } from '../litalerts/enqueueMarketRefresh.js'

/**
 * Lit Alerts evidence is considered authoritative for this many days
 * post-capture **unless** a brand_expiry_overrides row narrows or
 * widens the window for the captured brand (see migration 012/013 +
 * loadBrandExpiryDays() below).
 */
const DEFAULT_OBSERVATION_EXPIRY_DAYS = 4
/** Base rolling cadence: 24h between successful captures (before jitter). */
const OBSERVATION_BASE_REFRESH_MS = 24 * 60 * 60 * 1000
/** On failure, expire-soon hint: scan again in 30 minutes. */
const OBSERVATION_FAILURE_FAST_RETRY_MS = 30 * 60 * 1000
/** Treat "expires_at within next 12h" as the trigger for the faster retry. */
const OBSERVATION_EXPIRY_FAST_RETRY_WINDOW_MS = 12 * 60 * 60 * 1000

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

/**
 * Look up the operator-managed per-brand expiry window in days.
 * Returns DEFAULT_OBSERVATION_EXPIRY_DAYS when no override is
 * configured, when the brand name is null, or when the
 * brand_expiry_overrides table is not yet present (migration 012
 * unapplied — we don't want to wedge the worker on an unmigrated env).
 */
async function loadBrandExpiryDays(brandName: string | null): Promise<number> {
  if (!brandName) return DEFAULT_OBSERVATION_EXPIRY_DAYS
  try {
    const result = await getPool().query<{ expiry_days: number }>(
      `select expiry_days
         from brand_expiry_overrides
        where lower(brand_name) = lower($1)
        limit 1`,
      [brandName],
    )
    const row = result.rows[0]
    if (!row) return DEFAULT_OBSERVATION_EXPIRY_DAYS
    const days = Number(row.expiry_days)
    if (!Number.isFinite(days) || days < 1) return DEFAULT_OBSERVATION_EXPIRY_DAYS
    return Math.min(30, Math.floor(days))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/relation .*brand_expiry_overrides.* does not exist/i.test(message)) {
      return DEFAULT_OBSERVATION_EXPIRY_DAYS
    }
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

  // Honor brand_expiry_overrides — the operator-managed per-brand
  // expiry window from migration 012 — when computing expires_at on
  // a successful capture. Defaults to 4 days when no row exists or
  // when the brand is not resolvable from this observation. Cheap
  // one-row lookup keyed by lower(brand_name).
  const candidateBrandName = liveState?.brand ?? groupRow?.brand_name ?? null
  const expiryDays = await loadBrandExpiryDays(candidateBrandName)
  const observationExpiryMs = expiryDays * 24 * 60 * 60 * 1000

  return withTransaction(async (db) => {
    // For successful captures we set expires_at = captured_at + 4 days
    // (matching the freshness-view bucket boundary) and
    // next_refresh_at = captured_at + 24h + deterministic ± 2h jitter so
    // the rolling scheduler does not pick up the same product right away.
    // For failed captures we leave next_refresh_at NULL — the rolling
    // scheduler will retry on its normal cadence — unless the prior
    // observation's expires_at is within the next 12 hours, in which
    // case we push a faster retry through.
    const succeeded = input.status === 'succeeded'
    const jitterSeconds = rollingRefreshJitterSecondsForProduct(payload.productId)

    let nextRefreshAtClause = 'null'
    let failureNextRefreshAt: Date | null = null
    if (succeeded) {
      nextRefreshAtClause = `now() + interval '${OBSERVATION_BASE_REFRESH_MS / 1000} seconds' + (${jitterSeconds}::int * interval '1 second')`
    } else {
      // Look up the previous successful observation's expires_at and
      // decide whether a fast retry is needed.
      const previous = await db.query<{ expires_at: Date | null }>(
        `
          select expires_at
          from litalerts_competitor_observations
          where product_id = $1
            and status = 'succeeded'
          order by captured_at desc, id desc
          limit 1
        `,
        [payload.productId],
      )
      const previousExpiresAt = previous.rows[0]?.expires_at ?? null
      if (
        previousExpiresAt !== null
        && previousExpiresAt.getTime() - Date.now() < OBSERVATION_EXPIRY_FAST_RETRY_WINDOW_MS
      ) {
        failureNextRefreshAt = new Date(Date.now() + OBSERVATION_FAILURE_FAST_RETRY_MS)
      }
    }

    const insertResult = await db.query<{ id: number }>(
      `
        insert into litalerts_competitor_observations (
          queue_row_id, product_id, site_dealer_id, source_snapshot_id, job_id,
          status, brand_id, brand_name, group_id, group_name, category_name,
          search_terms_json, search_term_label, availability,
          listing_count, pricing_eligible_listing_count,
          near_listing_count, mid_listing_count, far_listing_count,
          evidence_json, notes, error,
          expires_at, next_refresh_at
        ) values (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10, $11,
          $12::jsonb, $13, $14,
          $15, $16,
          $17, $18, $19,
          $20::jsonb, $21, $22,
          now() + interval '${observationExpiryMs / 1000} seconds',
          ${succeeded ? nextRefreshAtClause : '$23'}
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
        ...(succeeded ? [] : [failureNextRefreshAt]),
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
