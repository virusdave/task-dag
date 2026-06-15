// Operator-triggered bulk refresh of ONE Sweed marketing segment's
// cached membership (virusdave/top-level#12).
//
// Enqueued by the "Refresh membership cache" button on the Helios
// segment details page (/config/marketing/segments/:segmentId), deduped
// per segment. Runs in the Sweed pool inside its own withSweedSession
// (declared in SWEED_BACKED_JOB_TYPES). Reuses refreshOneSegmentMembership
// so the fetch->snapshot logic matches the bulk path exactly, and records
// the per-segment refresh highwater so the details page can show a
// truthful "last refreshed" line (membership snapshots are write-on-change,
// so the rows' own timestamps are not a refresh signal).
//
// Cost: one paginated Sweed RPC for the member list + one bounded
// write-on-change snapshot, plus at most one catalog refresh per 6h
// (highwater-gated).

import type { ConfigWorkersRefreshSweedSegmentMembersJobPayload } from '../../shared/contracts/index.js'
import { getPool } from '../../server/db/pool.js'
import { getWorkerEnv } from '../config/env.js'
import {
  markSegmentMembershipRefreshFailed,
  markSegmentMembershipRefreshOk,
  markSegmentMembershipRefreshPending,
} from '../../server/db/queries/marketingSegmentDetailsQueries.js'
import { refreshOneSegmentMembership } from '../sweed/segmentRefresh.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

export async function runConfigWorkersRefreshSweedSegmentMembersJob(
  context: JobHandlerContext,
  payload: ConfigWorkersRefreshSweedSegmentMembersJobPayload,
): Promise<void> {
  const pool = getPool()
  const segmentId = payload.segmentId

  await markSegmentMembershipRefreshPending(pool, segmentId)

  try {
    const count = await refreshOneSegmentMembership({
      segmentId,
      stateDealerId: getWorkerEnv().sweedStateDealerId,
    })
    await markSegmentMembershipRefreshOk(pool, { segmentId, memberCount: count })
    // eslint-disable-next-line no-console
    console.log(
      `[refresh-sweed-segment-members] job=${context.id} segment=${segmentId} cached ${count} members (trigger=${payload.trigger})`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markSegmentMembershipRefreshFailed(pool, { segmentId, error: message })
    // eslint-disable-next-line no-console
    console.error(
      `[refresh-sweed-segment-members] job=${context.id} segment=${segmentId} failed: ${message}`,
    )
    throw error
  }
}
