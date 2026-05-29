// Visitor-scan address enrichment worker.
//
// Two-phase per tick, runs at backfill priority:
//
//   1. Phase 1 (link). Walk up to `batchSize` (default 5000) rows in
//      `visitor_scans` that have at least one usable address-text
//      component AND `address_id IS NULL`, normalise via the shared
//      `upsertAddress` helper, and write the FK back. New addresses
//      land in `addresses` with `geocode_status='pending'`.
//
//   2. Phase 2 (drain). Pull up to `batchSize` rows from the Census
//      geocoder queue (`addresses.geocode_status='pending'`) via
//      `queueGeocodePending` and call the shared `geocodeViaCensus`
//      helper. Internal rate limit (~1 RPS) keeps this safe.
//
// Background: the `visitor_scans.{latitude,longitude}` columns are
// populated from the VeriScan envelope's `Data.Latitude/Longitude`,
// which empirically holds the SCANNER kiosk location, NOT a
// geocoded customer-home address. The customer-origin map page
// (/admin/customers/map) was therefore plotting every customer on
// top of the store; this job is what feeds it real home coordinates.
//
// Idempotent: re-running is a no-op for already-linked scans and
// skips already-geocoded addresses. Concurrent runs are safe — both
// the linker UPDATE filters on `address_id IS NULL` and the drainer
// uses `FOR UPDATE SKIP LOCKED`.

import type { ConfigWorkersEnrichVisitorScanAddressJobPayload } from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { getPool } from '../../server/db/pool.js'
import { withTransaction } from '../../server/db/tx.js'
import {
  applyGeocodeResult,
  geocodeViaCensus,
  normaliseAddressParts,
  queueGeocodePending,
  upsertAddress,
} from '../geocoder/index.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

interface UnlinkedScanRow {
  id: string
  address: string | null
  city: string | null
  state: string | null
  postal_code: string | null
}

// Cadence for the live `[enrich-visitor-scan-address]` progress
// beacons we emit during both phases. 30 seconds is the operator-
// chosen value: tight enough to see the queue actually draining,
// loose enough not to spam the worker log when a tick chews through
// thousands of rows.
const PROGRESS_LOG_INTERVAL_MS = 30_000

export async function runConfigWorkersEnrichVisitorScanAddressJob(
  context: JobHandlerContext,
  payload: ConfigWorkersEnrichVisitorScanAddressJobPayload,
): Promise<void> {
  const batchSize = Math.max(1, Math.min(payload.batchSize, 10_000))
  const pool = getPool()
  const jobStartedAt = Date.now()
  // eslint-disable-next-line no-console
  console.log(
    `[enrich-visitor-scan-address] job=${context.id} trigger=${payload.trigger} batch=${batchSize} starting`,
  )

  // ----- 1. Link -----
  let scanned = 0
  let linked = 0
  let noText = 0
  let alreadyLinked = 0
  let lastProgressLogAt = Date.now()
  function maybeLogProgress(phase: 'link' | 'geo', extra: string): void {
    const now = Date.now()
    if (now - lastProgressLogAt < PROGRESS_LOG_INTERVAL_MS) return
    lastProgressLogAt = now
    const elapsedSec = ((now - jobStartedAt) / 1000).toFixed(1)
    // eslint-disable-next-line no-console
    console.log(
      `[enrich-visitor-scan-address] job=${context.id} phase=${phase} elapsed=${elapsedSec}s ${extra}`,
    )
  }

  const rows = await pool.query<UnlinkedScanRow>(
    `
      select id, address, city, state, postal_code
        from visitor_scans
       where address_id is null
         and (
           nullif(trim(coalesce(address, '')), '') is not null
           or nullif(trim(coalesce(city, '')), '') is not null
           or nullif(trim(coalesce(state, '')), '') is not null
           or nullif(trim(coalesce(postal_code, '')), '') is not null
         )
       order by id
       limit $1
    `,
    [batchSize],
  )

  for (const row of rows.rows) {
    scanned += 1
    const parts = normaliseAddressParts({
      line1: row.address,
      line2: null,
      city: row.city,
      state: row.state,
      zip: row.postal_code,
    })
    if (parts.normalized.length === 0) {
      noText += 1
      continue
    }
    try {
      await withTransaction(async (db) => {
        const upserted = await upsertAddress(db, {
          line1: row.address,
          line2: null,
          city: row.city,
          state: row.state,
          zip: row.postal_code,
        })
        if (upserted === null) {
          noText += 1
          return
        }
        const upd = await db.query(
          `update visitor_scans
              set address_id = $1
            where id = $2
              and address_id is null`,
          [upserted.addressId, row.id],
        )
        if (upd.rowCount === 0) alreadyLinked += 1
        else linked += 1
      })
    } catch (cause) {
      // eslint-disable-next-line no-console
      console.warn('[enrich-visitor-scan-address] link failed', {
        scanId: row.id,
        cause: cause instanceof Error ? cause.message : String(cause),
      })
    }
    maybeLogProgress(
      'link',
      `scanned=${scanned}/${rows.rows.length} linked=${linked} no_text=${noText} already=${alreadyLinked}`,
    )
  }
  // eslint-disable-next-line no-console
  console.log(
    `[enrich-visitor-scan-address] job=${context.id} phase=link done scanned=${scanned} linked=${linked} no_text=${noText} already=${alreadyLinked}`,
  )

  // ----- 2. Geocode drain -----
  let geocodedOk = 0
  let geocodedFailed = 0
  let geocodedNotUs = 0
  // Reset the progress beacon clock for phase 2 so the first geo
  // beacon also fires after ~30s of geocode work, not whatever was
  // left over from phase 1.
  lastProgressLogAt = Date.now()
  for (let i = 0; i < batchSize; i++) {
    let status: 'ok' | 'failed' | 'not_us' | null = null
    try {
      status = await withTransaction(async (db) => {
        const pending = await queueGeocodePending(db, 1)
        if (pending.length === 0) return null
        const row = pending[0]!
        const result = await geocodeViaCensus(row.normalized)
        await applyGeocodeResult(db, row.addressId, result)
        return result.status as 'ok' | 'failed' | 'not_us'
      })
    } catch (cause) {
      // eslint-disable-next-line no-console
      console.warn('[enrich-visitor-scan-address] geocode failed', {
        cause: cause instanceof Error ? cause.message : String(cause),
      })
      geocodedFailed += 1
      continue
    }
    if (status === null) break
    if (status === 'ok') geocodedOk += 1
    else if (status === 'not_us') geocodedNotUs += 1
    else geocodedFailed += 1
    maybeLogProgress(
      'geo',
      `processed=${i + 1} ok=${geocodedOk} failed=${geocodedFailed} not_us=${geocodedNotUs}`,
    )
  }
  // eslint-disable-next-line no-console
  console.log(
    `[enrich-visitor-scan-address] job=${context.id} phase=geo done ok=${geocodedOk} failed=${geocodedFailed} not_us=${geocodedNotUs} total_elapsed=${(
      (Date.now() - jobStartedAt) /
      1000
    ).toFixed(1)}s`,
  )

  // ----- 3. Audit -----
  await withTransaction(async (db) => {
    await appendAuditEvent(db, {
      actorType: 'system',
      actorUserId: null,
      entityId: String(context.id),
      entityType: 'job',
      eventType: 'config.workers.enrich_visitor_scan_address.completed',
      module: 'config',
      payload: {
        jobId: context.id,
        trigger: payload.trigger,
        batchSize,
        scanned,
        linked,
        noText,
        alreadyLinked,
        geocodedOk,
        geocodedFailed,
        geocodedNotUs,
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}
