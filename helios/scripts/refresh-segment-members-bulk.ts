// Operator-run BULK population of the customer→segment membership cache
// (`sweed_customer_segments`) from each segment's full member list via
// `store.marketing.segment.get`. One Sweed RPC per enabled segment
// (O(#segments)) instead of one per customer (O(#customers)) — the only
// affordable way to make membership coverage COMPLETE.
//
// SAFETY: dry-run by DEFAULT (fetch + parse + report counts, NO writes)
// because the segment.get response shape is not yet operator-verified.
// Verify the shape first with:
//   npx tsx scripts/probe-sweed-segment-members.ts <segmentId>
// then, once getSweedMarketingSegmentMembers parses it correctly:
//   npx tsx scripts/refresh-segment-members-bulk.ts            # dry run
//   npx tsx scripts/refresh-segment-members-bulk.ts --commit   # write
//
// Flags:
//   --commit            actually write snapshots (default: dry run)
//   --include-disabled  also pull disabled segments
//
// NOTE on the write model (see sweedCustomerSegmentsQueries.ts): this
// bulk path deletes/replaces by segment_id and is the AUTHORITATIVE
// coverage writer. The per-customer details-page refresh is a targeted
// overlay; don't run both continuously against the same customers until
// the per-customer path is made positive-only.

import { withSweedSession } from '../src/worker/sweed/session.js'
import { refreshSegmentMembershipBulk } from '../src/worker/sweed/segmentRefresh.js'
import { getWorkerEnv } from '../src/worker/config/env.js'

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit')
  const includeDisabled = process.argv.includes('--include-disabled')
  console.log(
    `[refresh-segment-members-bulk] mode=${commit ? 'COMMIT (writes)' : 'DRY RUN (no writes)'} ` +
      `includeDisabled=${includeDisabled}`,
  )
  await withSweedSession(async () => {
    const res = await refreshSegmentMembershipBulk({
      stateDealerId: getWorkerEnv().sweedStateDealerId,
      dryRun: !commit,
      includeDisabled,
    })
    console.log(
      `[refresh-segment-members-bulk] segments=${res.segmentsSnapshotted}/${res.segmentsTotal} ` +
        `membersCached=${res.membersCached} failures=${res.failures.length} dryRun=${res.dryRun}`,
    )
    for (const f of res.failures) {
      console.error(`  FAIL segment ${f.segmentId} (${f.segmentName}): ${f.error}`)
    }
  })
}

main().catch((e) => {
  console.error('[refresh-segment-members-bulk] FAIL:', e)
  process.exit(1)
})
