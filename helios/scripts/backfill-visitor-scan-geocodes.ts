// Backfill: link every `visitor_scans` row to a row in the shared
// `addresses` table, then drain the Census geocoder until the
// queue is empty.
//
// Background: visitor_scans.{latitude,longitude} are populated
// from the VeriScan envelope's Data.Latitude/Data.Longitude, but
// empirically those fields contain the kiosk-scanner location, not
// a geocoded customer-home address. The customer-origin map was
// therefore plotting almost every customer on top of the store.
//
// To get real customer-home lat/lng, this script:
//
//   1. Iterates every visitor_scan with non-empty address text and
//      `address_id IS NULL`, normalises via the shared
//      `normaliseAddressParts` + `upsertAddress` helpers (so a
//      household that comes in 50 times collapses to one row in
//      `addresses`), and writes the FK back to
//      `visitor_scans.address_id`.
//
//   2. Drains the addresses-table geocode queue
//      (`geocode_status = 'pending'`) via the same
//      `queueGeocodePending` / `geocodeViaCensus` /
//      `applyGeocodeResult` helpers the production
//      enrichDeliveryAddressJob uses. The Census geocoder enforces
//      its own process-wide 1-RPS rate limit so this is safe to
//      run inline.
//
// Idempotent: re-running the script is a no-op for already-linked
// scans and skips already-geocoded addresses (they're not
// `'pending'`). Re-running while the regular enrichment job is
// also draining the queue is safe — both sides use FOR UPDATE
// SKIP LOCKED.
//
// Operator usage (typically from the prod helios host):
//
//   DATABASE_URL=$(grep "Service URL:" \
//     /home/amp-local/.secret/tigerdata/tiger-cloud-db-94793-credentials.txt \
//     | sed -E 's/.*Service URL:\s*//') \
//   /opt/helios/node_modules/.bin/tsx scripts/backfill-visitor-scan-geocodes.ts
//
// Flags:
//   --link-only         skip the geocode-drain phase (just queue
//                       rows; let the regular job drain them).
//   --max-geocodes=N    stop the drain after N successful Census
//                       calls (default: unbounded; runs until the
//                       queue is empty or the process is killed).
//   --link-batch=N      page size for the linker (default 500).

import { Pool, type PoolClient } from 'pg'

import {
  applyGeocodeResult,
  geocodeViaCensus,
  normaliseAddressParts,
  queueGeocodePending,
  upsertAddress,
} from '../src/worker/geocoder/index.js'

interface CliFlags {
  linkOnly: boolean
  maxGeocodes: number | null
  linkBatch: number
}

function parseFlags(argv: readonly string[]): CliFlags {
  let linkOnly = false
  let maxGeocodes: number | null = null
  let linkBatch = 500
  for (const arg of argv) {
    if (arg === '--link-only') linkOnly = true
    else if (arg.startsWith('--max-geocodes=')) {
      const v = Number(arg.split('=')[1])
      if (!Number.isFinite(v) || v <= 0) {
        throw new Error(`--max-geocodes must be a positive integer (got ${arg})`)
      }
      maxGeocodes = Math.floor(v)
    } else if (arg.startsWith('--link-batch=')) {
      const v = Number(arg.split('=')[1])
      if (!Number.isFinite(v) || v <= 0 || v > 10_000) {
        throw new Error(`--link-batch must be 1..10000 (got ${arg})`)
      }
      linkBatch = Math.floor(v)
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: backfill-visitor-scan-geocodes [--link-only] [--max-geocodes=N] [--link-batch=N]\n',
      )
      process.exit(0)
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`)
    }
  }
  return { linkOnly, maxGeocodes, linkBatch }
}

interface ScanRow {
  id: string
  address: string | null
  city: string | null
  state: string | null
  postal_code: string | null
}

async function linkScansToAddresses(pool: Pool, linkBatch: number): Promise<{
  scanned: number
  linked: number
  noAddressText: number
  alreadyLinked: number
}> {
  let scanned = 0
  let linked = 0
  let noAddressText = 0
  let alreadyLinked = 0
  let lastId = '0'
  const stats = { scanned, linked, noAddressText, alreadyLinked }
  while (true) {
    // Page strictly by id so we don't re-scan rows we've already
    // visited in this pass. Filter to "missing address_id" so a
    // re-run skips most of the table; the (address_id is null)
    // condition is satisfied by the existing rows on first run
    // and an empty set on subsequent re-runs.
    const result = await pool.query<ScanRow>(
      `
      select id, address, city, state, postal_code
        from visitor_scans
       where id > $1
         and address_id is null
       order by id
       limit $2
      `,
      [lastId, linkBatch],
    )
    if (result.rows.length === 0) break
    for (const row of result.rows) {
      stats.scanned += 1
      lastId = row.id
      // postal_code on its own is enough to geocode at zip5
      // granularity, so we accept any row with at least one
      // non-empty address component. The shared `upsertAddress`
      // helper returns null when everything normalises away.
      const parts = normaliseAddressParts({
        line1: row.address,
        line2: null,
        city: row.city,
        state: row.state,
        zip: row.postal_code,
      })
      if (parts.normalized.length === 0) {
        stats.noAddressText += 1
        continue
      }
      const client: PoolClient = await pool.connect()
      try {
        await client.query('begin')
        const upserted = await upsertAddress(client, {
          line1: row.address,
          line2: null,
          city: row.city,
          state: row.state,
          zip: row.postal_code,
        })
        if (upserted === null) {
          stats.noAddressText += 1
          await client.query('commit')
          continue
        }
        const upd = await client.query(
          `update visitor_scans
              set address_id = $1
            where id = $2
              and address_id is null`,
          [upserted.addressId, row.id],
        )
        if (upd.rowCount === 0) stats.alreadyLinked += 1
        else stats.linked += 1
        await client.query('commit')
      } catch (e) {
        await client.query('rollback').catch(() => {})
        throw e
      } finally {
        client.release()
      }
    }
    // Progress beacon every page so a long backfill is visible.
    process.stdout.write(
      `[link] scanned=${stats.scanned} linked=${stats.linked} ` +
        `no_address=${stats.noAddressText} already=${stats.alreadyLinked} ` +
        `last_id=${lastId}\n`,
    )
  }
  return stats
}

async function drainGeocoder(
  pool: Pool,
  maxGeocodes: number | null,
): Promise<{ ok: number; failed: number; notUs: number; processed: number }> {
  let ok = 0
  let failed = 0
  let notUs = 0
  let processed = 0
  // Drain one row at a time inside its own transaction so the
  // FOR UPDATE SKIP LOCKED lock is released promptly between
  // calls (mirroring enrichDeliveryAddressJob's pattern). Loop
  // ends naturally when the queue is empty.
  while (maxGeocodes === null || processed < maxGeocodes) {
    const client = await pool.connect()
    let status: 'ok' | 'failed' | 'not_us' | 'empty' = 'empty'
    try {
      await client.query('begin')
      const rows = await queueGeocodePending(client, 1)
      if (rows.length === 0) {
        await client.query('commit')
        break
      }
      const row = rows[0]!
      const result = await geocodeViaCensus(row.normalized)
      await applyGeocodeResult(client, row.addressId, result)
      await client.query('commit')
      status = result.status === 'pending' ? 'failed' : result.status
    } catch (e) {
      await client.query('rollback').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    processed += 1
    if (status === 'ok') ok += 1
    else if (status === 'not_us') notUs += 1
    else failed += 1
    if (processed % 25 === 0) {
      process.stdout.write(
        `[geo] processed=${processed} ok=${ok} failed=${failed} not_us=${notUs}\n`,
      )
    }
  }
  return { ok, failed, notUs, processed }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL must be set')
  }
  const pool = new Pool({ connectionString, max: 4 })
  try {
    process.stdout.write(
      `[start] link-only=${flags.linkOnly} max-geocodes=${flags.maxGeocodes ?? '∞'} ` +
        `link-batch=${flags.linkBatch}\n`,
    )
    const linkStats = await linkScansToAddresses(pool, flags.linkBatch)
    process.stdout.write(
      `[link.done] scanned=${linkStats.scanned} linked=${linkStats.linked} ` +
        `no_address=${linkStats.noAddressText} already=${linkStats.alreadyLinked}\n`,
    )
    if (flags.linkOnly) {
      process.stdout.write('[skip] geocode drain skipped (--link-only)\n')
      return
    }
    const queueCheck = await pool.query<{ n: string }>(
      `select count(*)::text as n from addresses where geocode_status = 'pending'`,
    )
    process.stdout.write(`[geo.queue] pending=${queueCheck.rows[0]?.n ?? '0'}\n`)
    const drained = await drainGeocoder(pool, flags.maxGeocodes)
    process.stdout.write(
      `[geo.done] processed=${drained.processed} ok=${drained.ok} ` +
        `failed=${drained.failed} not_us=${drained.notUs}\n`,
    )
    const remaining = await pool.query<{ n: string }>(
      `select count(*)::text as n from addresses where geocode_status = 'pending'`,
    )
    process.stdout.write(`[geo.remaining] pending=${remaining.rows[0]?.n ?? '0'}\n`)
  } finally {
    await pool.end()
  }
}

main().catch((e) => {
  process.stderr.write(`backfill-visitor-scan-geocodes FAILED: ${e?.stack ?? e}\n`)
  process.exit(1)
})
