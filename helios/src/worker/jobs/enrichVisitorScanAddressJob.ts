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
import { enqueueJobs, JOB_PRIORITY_BACKFILL } from '../../server/jobs/enqueueJob.js'
import type { EnqueueJobInput } from '../../server/jobs/enqueueJob.js'
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

// Build the geo-segment eval enqueue input for one scan + trigger edge.
// Per-edge dedupe key (so distinct edges never suppress each other) +
// shared per-scan concurrencyKey (so the edges still serialise and we
// never run two Sweed sessions for the same scan at once).
function geoEvalEnqueueInput(
  scanId: number,
  trigger: 'address_geocoded' | 'address_attached',
): EnqueueJobInput {
  const key = `config.workers.geo_segment_rule_eval:${scanId}`
  return {
    jobType: 'config.workers.geo_segment_rule_eval',
    module: 'config',
    payload: { scanId, trigger },
    priority: JOB_PRIORITY_BACKFILL,
    dedupeKey: `${key}:${trigger}`,
    concurrencyKey: key,
    requestedByUserId: null,
  }
}

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
  // Scans we just attached to an address that was ALREADY geocoded `ok`
  // (no fresh geocode event will fire for them in phase 2), so we must
  // kick the geo-segment engine for them explicitly. See the
  // `address_attached` enqueue after this phase.
  const addressReadyScanIds: number[] = []
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
        else {
          linked += 1
          // We just attached this scan to an address that is ALREADY
          // geocoded — phase 2 won't re-geocode it, so remember it for
          // an explicit geo-segment kick below.
          if (upserted.geocodeStatus === 'ok') addressReadyScanIds.push(Number(row.id))
        }
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

  // ----- 1b. Geo-segment kick for already-geocoded attachments -----
  // Scans attached this tick to an address that was already geocoded
  // `ok` get no phase-2 geocode event, so trigger the engine directly
  // for the LINKED ones whose site has an enabled, in-window first_scan
  // rule. (Not-yet-linked scans are covered later by the link worker.)
  if (addressReadyScanIds.length > 0) {
    try {
      const scanRows = await pool.query<{ id: string }>(
        `
          select vs.id
            from visitor_scans vs
            join visitor_scan_links vsl
              on vsl.scan_id = vs.id and vsl.link_status = 'linked'
           where vs.id = any($1::bigint[])
             and exists (
               select 1 from geo_segment_rules r
                where r.enabled
                  and r.site_slug = vs.site_slug
                  and r.trigger = 'first_scan'
                  and (r.since is null or coalesce(vs.scanned_at, vs.ingested_at) >= r.since)
             )
        `,
        [addressReadyScanIds],
      )
      const inputs = scanRows.rows.map((r) => geoEvalEnqueueInput(Number(r.id), 'address_attached'))
      if (inputs.length > 0) {
        await withTransaction(async (db) => {
          await enqueueJobs(db, inputs)
        })
        // eslint-disable-next-line no-console
        console.log(
          `[enrich-visitor-scan-address] job=${context.id} enqueued geo-segment eval (address_attached) for ${inputs.length} linked scan(s)`,
        )
      }
    } catch (cause) {
      // eslint-disable-next-line no-console
      console.warn(
        `[enrich-visitor-scan-address] job=${context.id} geo-segment address_attached enqueue failed (non-fatal): ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      )
    }
  }

  // ----- 2. Geocode drain -----
  let geocodedOk = 0
  let geocodedFailed = 0
  let geocodedNotUs = 0
  // Address ids that reached geocode `ok` this tick — used to kick the
  // geographic segment-rule engine for the scans on those addresses
  // (the geocode half of the dual scan-link/geocode trigger).
  const geocodedOkAddressIds: number[] = []
  // Reset the progress beacon clock for phase 2 so the first geo
  // beacon also fires after ~30s of geocode work, not whatever was
  // left over from phase 1.
  lastProgressLogAt = Date.now()
  for (let i = 0; i < batchSize; i++) {
    let status: 'ok' | 'failed' | 'not_us' | null = null
    try {
      const outcome = await withTransaction(async (db) => {
        const pending = await queueGeocodePending(db, 1)
        if (pending.length === 0) return null
        const row = pending[0]!
        const result = await geocodeViaCensus(row.normalized)
        await applyGeocodeResult(db, row.addressId, result)
        return { status: result.status as 'ok' | 'failed' | 'not_us', addressId: Number(row.addressId) }
      })
      status = outcome === null ? null : outcome.status
      if (outcome !== null && outcome.status === 'ok') {
        geocodedOkAddressIds.push(outcome.addressId)
      }
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

  // ----- 2b. Geographic segment-rule engine kick -----
  // For each address that just reached geocode `ok`, enqueue the
  // geo-segment eval job for its LINKED scans whose site has at least
  // one enabled rule. This is the geocode half of the dual trigger
  // (the link worker covers the case where the link lands last).
  // Deduped per scan, best-effort, DB-only unless a rule matches.
  if (geocodedOkAddressIds.length > 0) {
    try {
      const scanRows = await pool.query<{ id: string }>(
        `
          select vs.id
            from visitor_scans vs
            join visitor_scan_links vsl
              on vsl.scan_id = vs.id and vsl.link_status = 'linked'
           where vs.address_id = any($1::bigint[])
             and exists (
               select 1 from geo_segment_rules r
                where r.enabled
                  and r.site_slug = vs.site_slug
                  and r.trigger = 'first_scan'
                  and (r.since is null or coalesce(vs.scanned_at, vs.ingested_at) >= r.since)
             )
        `,
        [geocodedOkAddressIds],
      )
      const inputs = scanRows.rows.map((r) => geoEvalEnqueueInput(Number(r.id), 'address_geocoded'))
      if (inputs.length > 0) {
        await withTransaction(async (db) => {
          await enqueueJobs(db, inputs)
        })
        // eslint-disable-next-line no-console
        console.log(
          `[enrich-visitor-scan-address] job=${context.id} enqueued geo-segment eval for ${inputs.length} linked scan(s) across ${geocodedOkAddressIds.length} newly-geocoded address(es)`,
        )
      }
    } catch (cause) {
      // eslint-disable-next-line no-console
      console.warn(
        `[enrich-visitor-scan-address] job=${context.id} geo-segment eval enqueue failed (non-fatal): ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      )
    }
  }

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
