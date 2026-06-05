// Operator-triggered refresh of one customer's cached Sweed
// marketing-segment membership (virusdave/top-level#12).
//
// Enqueued by the "Refresh segments" button on the customer-details
// page (deduped per customer). Runs in the Sweed pool inside its own
// withSweedSession (declared in SWEED_BACKED_JOB_TYPES). Reuses the
// shared refresh helpers so the fetch→snapshot logic matches the link
// worker's inline refresh exactly.
//
// Cost: one Sweed RPC for membership + a bounded snapshot write, plus
// at most one catalog refresh per 6h (highwater-gated).

import type { ConfigWorkersRefreshSweedCustomerSegmentsJobPayload } from '../../shared/contracts/index.js'
import { getPool } from '../../server/db/pool.js'
import { getWorkerEnv } from '../config/env.js'
import {
  markCustomerSegmentsRefreshFailed,
  markCustomerSegmentsRefreshPending,
} from '../../server/db/queries/sweedCustomerSegmentsQueries.js'
import {
  refreshCustomerSegmentMembership,
  refreshMarketingCatalogIfStale,
} from '../sweed/segmentRefresh.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

export async function runConfigWorkersRefreshSweedCustomerSegmentsJob(
  context: JobHandlerContext,
  payload: ConfigWorkersRefreshSweedCustomerSegmentsJobPayload,
): Promise<void> {
  const pool = getPool()
  const sweedCustomerId = payload.sweedCustomerId

  await markCustomerSegmentsRefreshPending(pool, sweedCustomerId)

  try {
    const count = await refreshCustomerSegmentMembership({
      sweedCustomerId,
      dealerId: getWorkerEnv().sweedStateDealerId,
    })
    // Best-effort catalog refresh (gated by its own highwater); never
    // fail the membership refresh if the catalog pull hiccups.
    try {
      await refreshMarketingCatalogIfStale({ stateDealerId: getWorkerEnv().sweedStateDealerId })
    } catch (catalogError) {
      // eslint-disable-next-line no-console
      console.warn(
        `[refresh-sweed-customer-segments] job=${context.id} customer=${sweedCustomerId} catalog refresh failed (non-fatal): ${
          catalogError instanceof Error ? catalogError.message : String(catalogError)
        }`,
      )
    }
    // eslint-disable-next-line no-console
    console.log(
      `[refresh-sweed-customer-segments] job=${context.id} customer=${sweedCustomerId} cached ${count} segments (trigger=${payload.trigger})`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markCustomerSegmentsRefreshFailed(pool, { sweedCustomerId, error: message })
    // eslint-disable-next-line no-console
    console.error(
      `[refresh-sweed-customer-segments] job=${context.id} customer=${sweedCustomerId} failed: ${message}`,
    )
    throw error
  }
}
