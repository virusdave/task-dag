// Probe `store.marketing.segment.get { id }` to verify the BULK
// segment-member response shape before we trust the fail-closed parser
// in src/worker/sweed/customers.ts (getSweedMarketingSegmentMembers).
//
// The operator gave us the call shape but the segment was empty at
// authoring time, so we don't yet know:
//   1. Under what key the member array lives (customers / clients /
//      members / data / segment.customers / bare array …).
//   2. The per-member customer-id field name (id / customerId /
//      clientId / customer.id …).
//   3. Whether members carry `enabled` / `dateOnEnter`.
//   4. Whether the call must be pinned to the segment's owning dealer.
//
// Run (against a POPULATED segment):
//   cd helios && npx tsx scripts/probe-sweed-segment-members.ts <segmentId> [dealerId]
//
// Dumps the redacted envelope + first few members so we can tighten the
// parser. REDACTS PII aggressively — segment member rows may contain
// names / phones / emails / addresses / DOB.

import { withSweedSession } from '../src/worker/sweed/session.js'
import { callSweedRpc } from '../src/worker/sweed/rpc.js'
import { HELIOS_PENDING_PURCHASE_SITE_DEALERS } from '../src/shared/contracts/domain/pendingPurchases.js'

const MAX_MEMBERS = 3
const PII_KEY = /name|phone|email|mail|address|birth|dob|ssn|license|document|zip|postal|street|city/i

function redactValue(key: string, value: unknown): unknown {
  if (PII_KEY.test(key)) return '«redacted»'
  if (value !== null && typeof value === 'object') return '«object»'
  return value
}

function summariseMember(m: unknown): Record<string, unknown> {
  if (m === null || typeof m !== 'object') return { __scalar: m }
  const o = m as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(o)) out[k] = redactValue(k, o[k])
  return out
}

function findArrays(root: unknown): string[] {
  if (root === null || typeof root !== 'object') return []
  const o = root as Record<string, unknown>
  const paths: string[] = []
  for (const k of Object.keys(o)) {
    if (Array.isArray(o[k])) paths.push(`${k} (len=${(o[k] as unknown[]).length})`)
    else if (o[k] !== null && typeof o[k] === 'object') {
      const inner = o[k] as Record<string, unknown>
      for (const k2 of Object.keys(inner)) {
        if (Array.isArray(inner[k2])) paths.push(`${k}.${k2} (len=${(inner[k2] as unknown[]).length})`)
      }
    }
  }
  return paths
}

async function probeSegment(segmentId: string, dealerId: number, dealerName: string): Promise<void> {
  console.log(`\n=== segment ${segmentId} @ dealer ${dealerId} (${dealerName}) ===`)
  let raw: unknown
  try {
    raw = await callSweedRpc<unknown>(dealerId, 'store.marketing.segment.get', { id: segmentId })
  } catch (err) {
    console.error(`  call failed: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  if (Array.isArray(raw)) {
    console.log(`  response is a BARE ARRAY, length=${raw.length}`)
    console.log(`  first ${MAX_MEMBERS} members:`)
    for (const m of raw.slice(0, MAX_MEMBERS)) console.log('   ', JSON.stringify(summariseMember(m)))
    return
  }
  if (raw === null || typeof raw !== 'object') {
    console.log(`  response is a scalar: ${JSON.stringify(raw)}`)
    return
  }
  const o = raw as Record<string, unknown>
  console.log(`  top-level keys: ${Object.keys(o).join(', ')}`)
  console.log(`  scalar header (redacted):`)
  for (const k of Object.keys(o)) {
    if (o[k] === null || typeof o[k] !== 'object') console.log(`    ${k} = ${JSON.stringify(redactValue(k, o[k]))}`)
  }
  const arrayPaths = findArrays(o)
  console.log(`  array-valued paths (member-list candidates): ${arrayPaths.length ? arrayPaths.join(' | ') : '(none found!)'}`)

  // Dump first few rows of the largest array path.
  let bestKey: string | null = null
  let bestArr: unknown[] = []
  for (const k of Object.keys(o)) {
    if (Array.isArray(o[k]) && (o[k] as unknown[]).length >= bestArr.length) {
      bestKey = k
      bestArr = o[k] as unknown[]
    }
  }
  if (bestKey && bestArr.length > 0) {
    console.log(`  sample members from "${bestKey}" (first ${MAX_MEMBERS}, redacted):`)
    for (const m of bestArr.slice(0, MAX_MEMBERS)) console.log('   ', JSON.stringify(summariseMember(m)))
  }
}

async function main(): Promise<void> {
  const segmentId = process.argv[2]
  if (!segmentId) {
    console.error('usage: npx tsx scripts/probe-sweed-segment-members.ts <segmentId> [dealerId]')
    process.exit(2)
  }
  const dealerArg = process.argv[3] ? Number(process.argv[3]) : null
  await withSweedSession(async () => {
    if (dealerArg) {
      await probeSegment(segmentId, dealerArg, 'explicit')
      return
    }
    // No dealer given — try each site dealer so we learn whether the
    // segment is visible from a specific store context.
    for (const dealer of HELIOS_PENDING_PURCHASE_SITE_DEALERS) {
      try {
        await probeSegment(segmentId, dealer.dealerId, dealer.dealerName)
      } catch (err) {
        console.error(`[probe] dealer ${dealer.dealerId} failed:`, err)
      }
    }
  })
}

main().catch((e) => {
  console.error('[probe-sweed-segment-members] FAIL:', e)
  process.exit(1)
})
