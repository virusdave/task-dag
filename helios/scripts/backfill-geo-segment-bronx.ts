// One-shot backfill: add "first-time scan" or "first-time purchase"
// Bronx customers whose geocoded ID home address sits within a radius
// of the Bronx store (and whose qualifying event is on/after a cutoff)
// to a static Sweed marketing segment.
//
// Defaults reproduce the operator's request:
//   * segment 10282 (Bronx static segment)
//   * radius 3750 ft of the Bronx store
//   * cutoff 2026-05-21 (America/New_York midnight)
//   * "first scan" = no scan by the same person in the prior 365 days
//   * "first purchase" = first-ever attributed Sweed purchase, at Bronx,
//     on/after the cutoff (guest/walk-in POS sales are excluded because
//     they carry no customer_id).
//
// SAFE BY DEFAULT: runs as a DRY RUN and writes nothing to Sweed.
// Pass `--commit` to actually add the non-member customers to the
// segment via the operator-verified `store.marketing.segment.result.add`
// RPC, in batches, under the Bronx dealer context.
//
// Operator usage (from the prod helios host, where DATABASE_URL +
// SWEED_API_URL are set and the sweed_session_tokens pool is live):
//
//   DATABASE_URL=postgres://...  SWEED_API_URL=https://prime.sweedpos.com/api/ \
//   /opt/helios/node_modules/.bin/tsx scripts/backfill-geo-segment-bronx.ts
//   # review the printed candidate list, then:
//   DATABASE_URL=...  SWEED_API_URL=... \
//   /opt/helios/node_modules/.bin/tsx scripts/backfill-geo-segment-bronx.ts --commit
//
// Flags:
//   --commit                 actually write to Sweed (default: dry run)
//   --segment-id=N           target segment (default 10282)
//   --site=bx                site slug (default bx)
//   --dealer-id=N            segment-owning dealer (default 210249, Bronx)
//   --radius-feet=N          radius in feet (default 3750)
//   --since=YYYY-MM-DD       ET cutoff date, inclusive (default 2026-05-21)
//   --reactivation-days=N    "first scan in N days" window (default 365)
//   --batch=N                Sweed add batch size (default 50)
//   --skip-membership-check  don't read each customer's current segments
//                            (adds everyone; relies on server-side dedup)

import { closePool, getPool } from '../src/server/db/pool.js'
import { SITE_PIN_BY_SLUG } from '../src/server/db/queries/customersMapQueries.js'
import {
  ensureDealerContext,
} from '../src/worker/sweed/rpc.js'
import { withSweedSession } from '../src/worker/sweed/session.js'
import {
  addSegmentMembers,
  findSweedCustomerByDocumentNumber,
  listSweedCustomerSegments,
} from '../src/worker/sweed/customers.js'
import {
  chunk,
  feetToMeters,
  loadPurchaseTriggerCandidates,
  loadScanTriggerCandidates,
  mergeCandidates,
  metersToFeet,
  type GeoSegmentSelectionParams,
} from '../src/worker/sweed/geoSegment.js'

interface CliFlags {
  commit: boolean
  segmentId: number
  siteSlug: string
  dealerId: number
  radiusFeet: number
  since: Date
  reactivationDays: number
  batch: number
  skipMembershipCheck: boolean
}

function parseEtMidnight(dateStr: string): Date {
  // Interpret YYYY-MM-DD as midnight America/New_York. NY is UTC-4
  // (EDT) on 2026-05-21; we encode the offset explicitly so the cutoff
  // is unambiguous regardless of the host clock.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`--since must be YYYY-MM-DD (got ${dateStr})`)
  }
  const d = new Date(`${dateStr}T00:00:00-04:00`)
  if (Number.isNaN(d.getTime())) throw new Error(`invalid --since date: ${dateStr}`)
  return d
}

function parseFlags(argv: readonly string[]): CliFlags {
  const flags: CliFlags = {
    commit: false,
    segmentId: 10282,
    siteSlug: 'bx',
    dealerId: 210249,
    radiusFeet: 3750,
    since: parseEtMidnight('2026-05-21'),
    reactivationDays: 365,
    batch: 50,
    skipMembershipCheck: false,
  }
  const num = (arg: string, label: string, min = 1): number => {
    const v = Number(arg.split('=')[1])
    if (!Number.isFinite(v) || v < min) throw new Error(`${label} must be a number >= ${min} (got ${arg})`)
    return v
  }
  for (const arg of argv) {
    if (arg === '--commit') flags.commit = true
    else if (arg === '--skip-membership-check') flags.skipMembershipCheck = true
    else if (arg.startsWith('--segment-id=')) flags.segmentId = Math.floor(num(arg, '--segment-id'))
    else if (arg.startsWith('--site=')) flags.siteSlug = arg.split('=')[1] ?? ''
    else if (arg.startsWith('--dealer-id=')) flags.dealerId = Math.floor(num(arg, '--dealer-id'))
    else if (arg.startsWith('--radius-feet=')) flags.radiusFeet = num(arg, '--radius-feet')
    else if (arg.startsWith('--since=')) flags.since = parseEtMidnight(arg.split('=')[1] ?? '')
    else if (arg.startsWith('--reactivation-days=')) flags.reactivationDays = Math.floor(num(arg, '--reactivation-days'))
    else if (arg.startsWith('--batch=')) flags.batch = Math.floor(num(arg, '--batch'))
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('see header comment for flags\n')
      process.exit(0)
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`)
    }
  }
  if (!flags.siteSlug) throw new Error('--site must not be empty')
  return flags
}

function log(msg: string): void {
  process.stdout.write(`[geo-segment-backfill] ${msg}\n`)
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))
  const pin = SITE_PIN_BY_SLUG[flags.siteSlug]
  if (pin === undefined) {
    throw new Error(`no store pin for site slug '${flags.siteSlug}'`)
  }
  const radiusMeters = feetToMeters(flags.radiusFeet)
  const params: GeoSegmentSelectionParams = {
    siteSlug: flags.siteSlug,
    dealerId: flags.dealerId,
    storeLat: pin.lat,
    storeLng: pin.lng,
    radiusMeters,
    since: flags.since,
    reactivationDays: flags.reactivationDays,
  }

  log(
    `mode=${flags.commit ? 'COMMIT' : 'DRY-RUN'} segment=${flags.segmentId} site=${flags.siteSlug} ` +
      `dealer=${flags.dealerId} store=(${pin.lat},${pin.lng}) radius=${flags.radiusFeet}ft ` +
      `since=${flags.since.toISOString()} reactivationDays=${flags.reactivationDays}`,
  )

  const pool = getPool()

  const [scanRows, purchaseRows] = await Promise.all([
    loadScanTriggerCandidates(pool, params),
    loadPurchaseTriggerCandidates(pool, params),
  ])
  log(`scan-trigger scans in range: ${scanRows.length}`)
  log(`purchase-trigger customers in range: ${purchaseRows.length}`)

  const summary = await withSweedSession(async () => {
    // Pin the session to the segment-owning dealer up front. All RPCs
    // (documentNumber lookup, segment list, segment add) run here.
    await ensureDealerContext(flags.dealerId)

    // Resolve scan candidates that have no existing `linked` row to a
    // Sweed customer id via the operator-verified documentNumber RPC.
    const scanResolved: Array<{
      sweedCustomerId: number
      distanceMeters: number
      firstName: string | null
      lastName: string | null
    }> = []
    let resolvedViaRpc = 0
    let unresolvable = 0
    for (const s of scanRows) {
      let customerId = s.sweedCustomerId
      if (customerId === null) {
        if (s.idNum === null || s.idNum.trim() === '') {
          unresolvable++
          continue
        }
        const found = await findSweedCustomerByDocumentNumber({
          dealerId: flags.dealerId,
          documentNumber: s.idNum.trim(),
        })
        if (found.customerId === null) {
          unresolvable++
          continue
        }
        customerId = found.customerId
        resolvedViaRpc++
      }
      scanResolved.push({
        sweedCustomerId: customerId,
        distanceMeters: s.distanceMeters,
        firstName: s.firstName,
        lastName: s.lastName,
      })
    }
    log(`scan candidates resolved via documentNumber RPC: ${resolvedViaRpc}`)
    if (unresolvable > 0) {
      log(`scan candidates with no resolvable Sweed customer (skipped): ${unresolvable}`)
    }

    const merged = mergeCandidates(scanResolved, purchaseRows)
    log(`distinct candidate Sweed customers: ${merged.length}`)

    // Determine who is already in the segment (read-only) so we only
    // add true non-members.
    const toAdd: typeof merged = []
    let alreadyMember = 0
    if (flags.skipMembershipCheck) {
      toAdd.push(...merged)
    } else {
      for (const c of merged) {
        const segs = await listSweedCustomerSegments({
          dealerId: flags.dealerId,
          customerId: c.sweedCustomerId,
        })
        const isMember = segs.some((row) => row.id === String(flags.segmentId))
        if (isMember) alreadyMember++
        else toAdd.push(c)
      }
    }

    // Print the candidate table.
    process.stdout.write('\n  customerId | dist(ft) | triggers                 | member? | name\n')
    process.stdout.write('  -----------+----------+--------------------------+---------+---------------------\n')
    const memberSet = new Set(toAdd.map((c) => c.sweedCustomerId))
    for (const c of merged) {
      const ft = Math.round(metersToFeet(c.distanceMeters))
      const member = flags.skipMembershipCheck ? '?' : memberSet.has(c.sweedCustomerId) ? 'no' : 'YES'
      process.stdout.write(
        `  ${String(c.sweedCustomerId).padStart(10)} | ${String(ft).padStart(8)} | ` +
          `${c.triggers.join('+').padEnd(24)} | ${member.padStart(7)} | ${c.name}\n`,
      )
    }
    process.stdout.write('\n')

    let added = 0
    if (flags.commit) {
      const batches = chunk(
        toAdd.map((c) => c.sweedCustomerId),
        flags.batch,
      )
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i]
        await addSegmentMembers({
          dealerId: flags.dealerId,
          segmentId: flags.segmentId,
          customerIds: batch,
        })
        added += batch.length
        log(`committed batch ${i + 1}/${batches.length} (+${batch.length}, total ${added})`)
      }
    }

    return {
      scanInRange: scanRows.length,
      purchaseInRange: purchaseRows.length,
      resolvedViaRpc,
      unresolvable,
      distinctCandidates: merged.length,
      alreadyMember,
      toAdd: toAdd.length,
      added,
    }
  })

  log(`session released back to pool.`)
  log(
    `SUMMARY: distinctCandidates=${summary.distinctCandidates} alreadyMember=${summary.alreadyMember} ` +
      `toAdd=${summary.toAdd} added=${summary.added}` +
      (flags.commit ? '' : '  (DRY-RUN — nothing written; re-run with --commit to apply)'),
  )
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (error: unknown) => {
    console.error('[geo-segment-backfill] FAIL:', error instanceof Error ? error.stack ?? error.message : error)
    await closePool().catch(() => {})
    process.exit(1)
  })
