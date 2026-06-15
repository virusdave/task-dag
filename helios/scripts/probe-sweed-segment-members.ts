// Dump one page of a marketing segment's member list via the verified
// `store.marketing.segment.result.list` RPC (the "result" family —
// sibling of the verified `store.marketing.segment.result.add`). Use to
// spot-check membership / re-confirm the response shape the parser in
// src/worker/sweed/customers.ts (parseSegmentResultPage) depends on.
//
// NOTE: `store.marketing.segment.get { id }` is NOT the member list — it
// returns the segment DEFINITION (rule `ruleData`, type, totalCustomers).
//
// Run:
//   cd helios && npx tsx scripts/probe-sweed-segment-members.ts <segmentId> [dealerId]
// State (NY) segments are visible from the state dealer 210248 (default).
//
// REDACTS PII aggressively — member rows carry name / DOB / contact.

import { withSweedSession } from '../src/worker/sweed/session.js'
import { callSweedRpc } from '../src/worker/sweed/rpc.js'

const STATE_DEALER = 210248
const PAGE_SIZE = 5
const PII_KEY = /name|phone|email|mail|address|birth|dob|ssn|license|document|zip|postal|street|city/i

function redact(o: unknown): unknown {
  if (Array.isArray(o)) return o.slice(0, 3).map(redact)
  if (o !== null && typeof o === 'object') {
    const r: Record<string, unknown> = {}
    for (const k of Object.keys(o as Record<string, unknown>)) {
      const v = (o as Record<string, unknown>)[k]
      r[k] = PII_KEY.test(k) ? '«redacted»' : v !== null && typeof v === 'object' ? redact(v) : v
    }
    return r
  }
  return o
}

async function main(): Promise<void> {
  const segmentId = process.argv[2]
  if (!segmentId) {
    console.error('usage: npx tsx scripts/probe-sweed-segment-members.ts <segmentId> [dealerId]')
    process.exit(2)
  }
  const dealerId = process.argv[3] ? Number(process.argv[3]) : STATE_DEALER

  await withSweedSession(async () => {
    console.log(`\n=== segment ${segmentId} members @ dealer ${dealerId} (page 1, pageSize ${PAGE_SIZE}) ===`)
    const raw = await callSweedRpc<unknown>(dealerId, 'store.marketing.segment.result.list', {
      id: segmentId,
      page: 1,
      pageSize: PAGE_SIZE,
    })
    const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
    console.log(`  top-level keys: ${o ? Object.keys(o).join(', ') : typeof raw}`)
    const customers = o?.customers as Record<string, unknown> | undefined
    console.log(`  total=${o?.total}  customers.totalCount=${customers?.totalCount}`)
    const data = Array.isArray(customers?.data) ? (customers!.data as unknown[]) : []
    console.log(`  customers.data length (this page): ${data.length}`)
    console.log(`  sample members (redacted):`)
    for (const m of data.slice(0, 3)) console.log('   ', JSON.stringify(redact(m)))
  })
}

main().catch((e) => {
  console.error('[probe-sweed-segment-members] FAIL:', e)
  process.exit(1)
})
