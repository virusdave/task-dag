import type { ConfigWorkersLitalertsRetailerGeoRefreshJobPayload } from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { getPool } from '../../server/db/pool.js'
import { withTransaction } from '../../server/db/tx.js'
import { geocodeViaCensus } from '../geocoder/census.js'
import { listRetailers } from '../litalerts/partnerClient.js'
import { refreshLitalertsRetailerLocations } from '../litalerts/refreshRetailerLocations.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

/**
 * Weekly refresh of the geocoded `litalerts_retailer_locations` table
 * (issue #56). Delegates to the shared `refreshLitalertsRetailerLocations`
 * helper so the retained one-shot script
 * (`scripts/backfill-litalerts-retailer-geo.mts`) and this scheduled job
 * share the same upsert + geocode semantics. Geocoding goes through the
 * shared 1-RPS Census client (`geocoder/census.ts`) rather than the
 * one-off's looser inline sleep.
 *
 * Read-only w.r.t. everything except `litalerts_retailer_locations`;
 * never touches `sales_reconciliation`.
 */
export async function runConfigWorkersLitalertsRetailerGeoRefreshJob(
  context: JobHandlerContext,
  payload: ConfigWorkersLitalertsRetailerGeoRefreshJobPayload,
): Promise<void> {
  const totals = await refreshLitalertsRetailerLocations(payload.stateCode, {
    db: getPool(),
    listRetailers,
    geocode: async (address) => {
      const result = await geocodeViaCensus(address)
      if (result.status !== 'ok' || result.latitude === null || result.longitude === null) {
        return null
      }
      return { latitude: result.latitude, longitude: result.longitude }
    },
    log: (line) => console.log(`[configWorkersLitalertsRetailerGeoRefreshJob] ${line}`),
  })

  await withTransaction(async (db) => {
    await appendAuditEvent(db, {
      actorType: payload.requestedByUserId ? 'user' : 'system',
      actorUserId: payload.requestedByUserId ?? null,
      entityId: String(context.id),
      entityType: 'job',
      eventType: 'config.workers.litalerts_retailer_geo_refresh.completed',
      module: 'config',
      payload: {
        stateCode: payload.stateCode,
        trigger: payload.trigger,
        retailersSeen: totals.retailersSeen,
        upserted: totals.upserted,
        newlyGeocoded: totals.newlyGeocoded,
        alreadyGeocoded: totals.alreadyGeocoded,
        missingAddress: totals.missingAddress,
        geocodeFailures: totals.geocodeFailures,
      },
      requestId: null,
      scope: null,
      undoPayload: null,
    })
  })
}
