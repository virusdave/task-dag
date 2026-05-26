import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  type ConfigWorkersEnrichCustomerAddressJobPayload,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { getPool } from '../../server/db/pool.js'
import { withTransaction } from '../../server/db/tx.js'
import { upsertAddress } from '../geocoder/addressesQueries.js'
import { getSweedCustomer, type SweedCustomerAddressDetail } from '../sweed/customers.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

// ============================================================================
// Customer-of-record address enrichment worker (A5 of
// FreshlyBakedNYC/automation#25).
//
// One job per scheduler tick. For each candidate (dealer, customer) pair
// observed on `sweed_orders` but not yet recorded as a 'primary' join row
// in `sweed_customer_addresses`, we:
//
//   1. Call `store.customer.get(id)` under the Sweed pool session.
//   2. If Sweed returned an address sub-object, upsert it through the
//      shared `addresses` helper and INSERT a `(dealer, customer,
//      address_id, kind='primary')` join row.
//   3. If Sweed returned the customer but no address, write a join row
//      pointing at the shared "no-address" sentinel address row so the
//      same customer is not re-polled forever.
//   4. If Sweed throws (transport / auth / 5xx), log + skip; the row
//      stays eligible for the next tick.
//
// The job runs inside `withSweedSession` (the registry wraps every
// SWEED_BACKED job in one). Per-customer rate limiting beyond the
// `batchSize` cap is intentionally not added here — at the default
// 60 RPCs / 5 min cadence we are far under the Sweed RPC budget that
// the orders ingest / package snapshot workers already exercise.
// ============================================================================

/** Deterministic dedup key for the "we polled and Sweed had no address" sentinel.
 *
 * Stored once in `addresses` with `geocode_status='not_us'` (so the
 * geocoder skips it entirely) and `geocoder_source='sentinel'`. All
 * customers Sweed responds with-but-without-address point at this same
 * row via a `kind='primary'` join. The string is intentionally not a
 * plausible postal address so a real address can never collide with it.
 */
const NO_ADDRESS_SENTINEL_NORMALIZED = '__sentinel:no_address__'

interface CandidatePair {
  dealerId: number
  customerId: number
}

export async function runEnrichCustomerAddressJob(
  context: JobHandlerContext,
  payload: ConfigWorkersEnrichCustomerAddressJobPayload,
): Promise<void> {
  const dealerCandidates =
    payload.siteDealerIds.length > 0
      ? payload.siteDealerIds
      : HELIOS_PENDING_PURCHASE_SITE_DEALERS.map((d) => d.dealerId)
  const dealerIds = [...new Set(dealerCandidates)]

  // The sentinel row is shared across every dealer, so materialise it
  // once at the top of the tick. Subsequent ticks short-circuit on the
  // `on conflict do update` no-op.
  const noAddressSentinelAddressId = await ensureNoAddressSentinelAddress()

  // Inline object type rather than a named interface so the audit
  // payload structurally matches `JsonValue`'s string-index signature.
  const perDealer: Array<{
    dealerId: number
    candidates: number
    addressesUpserted: number
    primaryLinksInserted: number
    noAddressSentinels: number
    rpcErrors: number
    error: string | null
  }> = []
  for (const dealerId of dealerIds) {
    try {
      const result = await enrichOneDealer(
        dealerId,
        payload.batchSize,
        noAddressSentinelAddressId,
      )
      perDealer.push({ dealerId, error: null, ...result })
    } catch (e) {
      perDealer.push({
        dealerId,
        candidates: 0,
        addressesUpserted: 0,
        primaryLinksInserted: 0,
        noAddressSentinels: 0,
        rpcErrors: 0,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  await withTransaction(async (db) => {
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(context.id),
      entityType: 'job',
      eventType: 'config.workers.enrich_customer_address.completed',
      module: 'config',
      payload: {
        jobId: context.id,
        trigger: payload.trigger,
        batchSize: payload.batchSize,
        perDealer,
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}

interface EnrichOneDealerResult {
  candidates: number
  addressesUpserted: number
  primaryLinksInserted: number
  noAddressSentinels: number
  rpcErrors: number
}

async function enrichOneDealer(
  dealerId: number,
  batchSize: number,
  noAddressSentinelAddressId: number,
): Promise<EnrichOneDealerResult> {
  const candidates = await selectCandidatePairs(dealerId, batchSize)
  let addressesUpserted = 0
  let primaryLinksInserted = 0
  let noAddressSentinels = 0
  let rpcErrors = 0

  for (const candidate of candidates) {
    let detailAddress: SweedCustomerAddressDetail | null
    try {
      const detail = await getSweedCustomer({
        dealerId: candidate.dealerId,
        customerId: candidate.customerId,
      })
      detailAddress = detail.address
    } catch (e) {
      rpcErrors++
      // eslint-disable-next-line no-console
      console.warn(
        `[enrich-customer-address] store.customer.get failed for dealer=${candidate.dealerId} customer=${candidate.customerId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
      continue
    }

    if (detailAddress === null) {
      const inserted = await insertCustomerAddressLink(
        candidate,
        noAddressSentinelAddressId,
      )
      if (inserted) {
        noAddressSentinels++
        primaryLinksInserted++
      }
      continue
    }

    const upsertResult = await withTransaction((db) =>
      upsertAddress(db, {
        line1: detailAddress.line1,
        line2: detailAddress.line2,
        city: detailAddress.city,
        state: detailAddress.state,
        zip: detailAddress.zip,
      }),
    )
    if (upsertResult === null) {
      // Address parts collapsed to an empty normalized string — Sweed
      // technically returned an address sub-object but every field was
      // blank. Treat as "no address" so we don't keep re-polling.
      const inserted = await insertCustomerAddressLink(
        candidate,
        noAddressSentinelAddressId,
      )
      if (inserted) {
        noAddressSentinels++
        primaryLinksInserted++
      }
      continue
    }
    if (upsertResult.isNew) addressesUpserted++

    const inserted = await insertCustomerAddressLink(
      candidate,
      upsertResult.addressId,
    )
    if (inserted) primaryLinksInserted++
  }

  return {
    candidates: candidates.length,
    addressesUpserted,
    primaryLinksInserted,
    noAddressSentinels,
    rpcErrors,
  }
}

async function selectCandidatePairs(
  dealerId: number,
  batchSize: number,
): Promise<CandidatePair[]> {
  const result = await getPool().query<{
    dealer_id: string | number
    customer_id: string | number
  }>(
    `
      select o.dealer_id, o.customer_id
        from sweed_orders o
       where o.dealer_id = $1
         and o.customer_id is not null
         and not exists (
               select 1
                 from sweed_customer_addresses sca
                where sca.dealer_id = o.dealer_id
                  and sca.customer_id = o.customer_id
                  and sca.kind = 'primary'
             )
       group by o.dealer_id, o.customer_id
       order by max(o.pay_time) desc
       limit $2
    `,
    [dealerId, batchSize],
  )
  return result.rows.map((row) => ({
    dealerId: Number(row.dealer_id),
    customerId: Number(row.customer_id),
  }))
}

/**
 * INSERT the (dealer, customer, address, 'primary') join row. On
 * conflict bumps `last_seen_at` so we have a freshness signal for
 * downstream queries.
 *
 * Returns whether a NEW row was inserted (vs. conflict-bumped).
 */
async function insertCustomerAddressLink(
  candidate: CandidatePair,
  addressId: number,
): Promise<boolean> {
  const result = await getPool().query(
    `
      insert into sweed_customer_addresses
        (dealer_id, customer_id, address_id, kind)
      values ($1, $2, $3, 'primary')
      on conflict (dealer_id, customer_id, address_id, kind) do update
        set last_seen_at = now()
      returning (xmax = 0) as is_new
    `,
    [candidate.dealerId, candidate.customerId, addressId],
  )
  const row = result.rows[0] as { is_new: boolean } | undefined
  return row?.is_new ?? false
}

/**
 * Idempotent upsert of the shared "Sweed returned no address" sentinel
 * row in `addresses`. The first tick that ever runs after the table
 * migration creates the row; every subsequent caller no-ops.
 *
 * `geocode_status='not_us'` keeps the geocoder drain from picking it
 * up; `geocoder_source='sentinel'` is the marker downstream join
 * queries use to recognise + filter out the sentinel row when
 * aggregating customer-origin map data.
 */
async function ensureNoAddressSentinelAddress(): Promise<number> {
  const result = await getPool().query<{ id: number }>(
    `
      insert into addresses
        (normalized, geocode_status, geocoder_source, last_geocoded_at)
      values ($1, 'not_us', 'sentinel', now())
      on conflict (normalized) do update set updated_at = now()
      returning id
    `,
    [NO_ADDRESS_SENTINEL_NORMALIZED],
  )
  const row = result.rows[0]
  if (!row) {
    throw new Error('enrichCustomerAddressJob: sentinel upsert returned no row')
  }
  return row.id
}
