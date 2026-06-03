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
 * the per-job CTE prefetch below).
 */
const DEFAULT_OBSERVATION_EXPIRY_DAYS = 4
/** Base rolling cadence: 24h between successful captures (before jitter). */
const OBSERVATION_BASE_REFRESH_MS = 24 * 60 * 60 * 1000
/** On failure, expire-soon hint: scan again in 30 minutes. */
const OBSERVATION_FAILURE_FAST_RETRY_MS = 30 * 60 * 1000
/** Treat "expires_at within next 12h" as the trigger for the faster retry. */
const OBSERVATION_EXPIRY_FAST_RETRY_WINDOW_MS = 12 * 60 * 60 * 1000
/** Clamp on operator-tunable brand expiry overrides (matches loadBrandExpiryDays). */
const MAX_OBSERVATION_EXPIRY_DAYS = 30

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

/**
 * Combined per-job prefetch row. The CTE in `loadJobContext` returns
 * at most one row joining `pending_litalerts_refresh_queue` with the
 * catalog_groups containment match. When the queue row is missing
 * the CTE returns zero rows; when the queue row exists but no
 * catalog group currently mirrors this productId, the group_* /
 * live_state_json columns are NULL.
 */
interface JobContextRow extends QueryResultRow {
  queue_id: number
  queue_product_id: number
  queue_site_dealer_id: number | null
  queue_source_snapshot_id: number | null
  queue_status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  group_id: number | null
  group_name: string | null
  group_brand_name: string | null
  group_category_name: string | null
  group_live_state_json: unknown
}

interface JobContext {
  queueRow: QueueRow
  groupRow: CatalogGroupRow | null
}

export async function runConfigWorkersLitalertsRefreshVariantJob(
  context: JobHandlerContext,
  payload: ConfigWorkersLitalertsRefreshVariantJobPayload,
): Promise<void> {
  const loaded = await loadJobContext(payload.queueRowId, payload.productId)
  if (!loaded) {
    // The row was cleaned up between enqueue and run; nothing to do.
    return
  }

  // Idempotent skip when the row was already drained by a prior attempt.
  if (loaded.queueRow.status === 'completed') {
    return
  }

  const { groupRow } = loaded

  let liveState: NormalizedCatalogGroupLiveState | null = null
  let evidence: ProductPricingMarketEvidence | null = null
  let availability: string | null = null
  let searchTermLabel: string | null = null
  let searchTerms: string[] = []
  let notes: string | null = null

  try {
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

    await persistAndAudit({
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
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Lit Alerts refresh error.'
    await persistAndAudit({
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

    throw error
  }
}

/**
 * Combined prefetch CTE — replaces the prior trio of round-trips
 * (loadQueueRow + findCatalogGroupContainingProduct +
 * loadBrandExpiryDays) with a single SELECT. Phase A5 of the
 * Helios DB-cost epic (virusdave/top-level#11).
 *
 * Why a CTE rather than three parallel SELECTs:
 *   - The catalog-group containment search uses the existing
 *     `catalog_groups_live_state_products_gin` GIN(jsonb_path_ops)
 *     index already present in production (see
 *     `select indexdef from pg_indexes where tablename =
 *     'catalog_groups'`); EXPLAIN shows the planner pick a
 *     Bitmap Index Scan on it for this exact predicate, so the
 *     pre-existing seq-scan worry in the original A5 design has
 *     turned out to be a non-issue. A redundant migration 049
 *     was drafted to add this index and then reverted once the
 *     production index was discovered.
 *   - The brand_expiry_overrides lookup is intentionally NOT in
 *     this prefetch: brand resolution prefers
 *     `liveState.brand` (parsed by the JS Zod schema) over the
 *     raw `catalog_groups.brand_name` column, and we don't want to
 *     replicate that normalization in SQL. It's folded into the
 *     persist transaction instead so it still avoids a separate
 *     round-trip on the hot path.
 *
 * Returns null when the queue row no longer exists (cleanup raced
 * the worker).
 */
async function loadJobContext(
  queueRowId: number,
  productId: number,
): Promise<JobContext | null> {
  const result = await getPool().query<JobContextRow>(
    `
      with q as (
        select id, product_id, site_dealer_id, source_snapshot_id, status
          from pending_litalerts_refresh_queue
         where id = $1
      ),
      g as (
        select id, group_name, brand_name, category_name, live_state_json
          from catalog_groups
         where (live_state_json -> 'products') @> $2::jsonb
         limit 1
      )
      select
        q.id                  as queue_id,
        q.product_id          as queue_product_id,
        q.site_dealer_id      as queue_site_dealer_id,
        q.source_snapshot_id  as queue_source_snapshot_id,
        q.status              as queue_status,
        g.id                  as group_id,
        g.group_name          as group_name,
        g.brand_name          as group_brand_name,
        g.category_name       as group_category_name,
        g.live_state_json     as group_live_state_json
        from q
        left join g on true
    `,
    [queueRowId, JSON.stringify([{ productId }])],
  )
  const row = result.rows[0]
  if (!row) return null
  const queueRow: QueueRow = {
    id: row.queue_id,
    product_id: row.queue_product_id,
    site_dealer_id: row.queue_site_dealer_id,
    source_snapshot_id: row.queue_source_snapshot_id,
    status: row.queue_status,
  }
  const groupRow: CatalogGroupRow | null =
    row.group_id === null
      ? null
      : {
          id: row.group_id,
          group_name: row.group_name as string,
          brand_name: row.group_brand_name,
          category_name: row.group_category_name,
          live_state_json: row.group_live_state_json,
        }
  return { queueRow, groupRow }
}

interface PersistInput {
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

/**
 * Persist the observation, close the queue row, and append the
 * audit event — all inside a single transaction.
 *
 * Phase A5 changes vs the prior `persistObservationAndCloseQueue` +
 * separate audit-event transaction:
 *   - Audit event now appends inside the same transaction (was a
 *     separate withTransaction call that issued its own
 *     BEGIN/COMMIT round-trips per job).
 *   - Brand-expiry lookup folded into a single combined-context
 *     query at the top of the transaction (was a separate
 *     pre-transaction `getPool().query` round-trip).
 *   - Failure-branch prior-observation lookup folded into the same
 *     combined-context query (was a second pre-INSERT round-trip).
 * Net: 3 sequential pre-INSERT round-trips collapse to 1, and the
 * audit event no longer needs its own transaction.
 */
async function persistAndAudit(input: PersistInput): Promise<number> {
  const { context, payload, groupRow, liveState, evidence } = input

  const matchedListings = evidence?.matchedListings ?? []
  const nearListings = matchedListings.filter((listing) => listing.distanceBand === 'near')
  const midListings = matchedListings.filter((listing) => listing.distanceBand === 'mid')
  const farListings = matchedListings.filter((listing) => listing.distanceBand === 'far')
  const pricingEligibleListings = matchedListings.filter((listing) => listing.eligibleForPricing)

  // Same `liveState.brand ?? groupRow.brand_name` preference as the
  // prior implementation. Resolved here in JS because the live-state
  // normalization happens in Zod; replicating it in SQL would be
  // brittle.
  const candidateBrandName = liveState?.brand ?? groupRow?.brand_name ?? null
  const succeeded = input.status === 'succeeded'
  const jitterSeconds = rollingRefreshJitterSecondsForProduct(payload.productId)

  return withTransaction(async (db) => {
    // Combined context fetch: brand-expiry override (always) +
    // prior-observation expires_at (failure path only). Returns
    // exactly one row regardless of whether either side matches.
    // The query exits gracefully (defaulting expiry_days /
    // previous_expires_at to NULL) when:
    //   - the brand name is null or has no override row;
    //   - the brand_expiry_overrides table doesn't exist yet
    //     (migration 012 unapplied — see the catch below);
    //   - there is no prior succeeded observation for this product.
    let expiryDays = DEFAULT_OBSERVATION_EXPIRY_DAYS
    let previousExpiresAt: Date | null = null
    try {
      const contextResult = await db.query<{
        expiry_days: number | null
        previous_expires_at: Date | null
      }>(
        `
          with be as (
            select expiry_days
              from brand_expiry_overrides
             where $1::text is not null
               and lower(brand_name) = lower($1)
             limit 1
          ),
          po as (
            select expires_at
              from litalerts_competitor_observations
             where $2::boolean = true
               and product_id = $3
               and status = 'succeeded'
             order by captured_at desc, id desc
             limit 1
          )
          select
            (select expiry_days  from be) as expiry_days,
            (select expires_at  from po) as previous_expires_at
        `,
        [candidateBrandName, !succeeded, payload.productId],
      )
      const row = contextResult.rows[0]
      if (row) {
        const days = Number(row.expiry_days)
        if (Number.isFinite(days) && days >= 1) {
          expiryDays = Math.min(MAX_OBSERVATION_EXPIRY_DAYS, Math.floor(days))
        }
        previousExpiresAt = row.previous_expires_at
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/relation .*brand_expiry_overrides.* does not exist/i.test(message)) {
        throw error
      }
      // Pre-migration-012 environments: brand_expiry_overrides
      // doesn't exist yet. Defaults already initialised above; on
      // the failure path we lose the prior-observation lookup
      // until the operator applies migration 012, which is
      // acceptable (the rolling scheduler will still retry on its
      // normal cadence — just without the 30-minute fast-retry
      // boost when an observation is about to expire).
    }

    const observationExpiryMs = expiryDays * 24 * 60 * 60 * 1000

    // For successful captures we set expires_at = captured_at + N days
    // (matching the freshness-view bucket boundary) and
    // next_refresh_at = captured_at + 24h + deterministic ± 2h jitter
    // so the rolling scheduler does not pick up the same product
    // right away. For failed captures we leave next_refresh_at NULL
    // — the rolling scheduler will retry on its normal cadence —
    // unless the prior observation's expires_at is within the next
    // 12 hours, in which case we push a faster retry through.
    let nextRefreshAtClause = 'null'
    let failureNextRefreshAt: Date | null = null
    if (succeeded) {
      nextRefreshAtClause = `now() + interval '${OBSERVATION_BASE_REFRESH_MS / 1000} seconds' + (${jitterSeconds}::int * interval '1 second')`
    } else if (
      previousExpiresAt !== null
      && previousExpiresAt.getTime() - Date.now() < OBSERVATION_EXPIRY_FAST_RETRY_WINDOW_MS
    ) {
      failureNextRefreshAt = new Date(Date.now() + OBSERVATION_FAILURE_FAST_RETRY_MS)
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

    const finalQueueStatus = succeeded ? 'completed' : 'cancelled'
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

    await appendAuditEvent(db, {
      actorType: payload.requestedByUserId ? 'user' : 'system',
      actorUserId: payload.requestedByUserId ?? null,
      entityId: String(context.id),
      entityType: 'job',
      eventType: 'config.workers.litalerts_refresh.completed',
      module: 'config',
      payload: succeeded
        ? {
            availability: input.availability,
            listingCount: matchedListings.length,
            observationId: newObservationId,
            productId: payload.productId,
            queueRowId: payload.queueRowId,
            searchTermLabel: input.searchTermLabel,
            status: 'succeeded',
            trigger: payload.trigger,
          }
        : {
            availability: input.availability,
            error: input.error,
            productId: payload.productId,
            queueRowId: payload.queueRowId,
            status: 'failed',
            trigger: payload.trigger,
          },
      requestId: null,
      scope: null,
      undoPayload: null,
    })

    return newObservationId
  })
}
