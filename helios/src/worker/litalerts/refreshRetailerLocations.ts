/**
 * Refresh `litalerts_retailer_locations` from the Lit Alerts partner
 * directory + the US Census geocoder (issue #56).
 *
 * This is the worker-importable lift of the historical one-off
 * `scripts/backfill-litalerts-retailer-geo.mts`. Both the (retained)
 * one-off and the weekly `config.workers.litalerts_retailer_geo_refresh`
 * scheduled job call this so the upsert + geocode semantics live in one
 * place. For every retailer in `/v1/retailers?state=<state>` it:
 *
 *   1. Upserts the row (name / address / flags / `last_seen_at`),
 *      invalidating a stale geocode when the address text changed so a
 *      moved dispensary gets re-resolved.
 *   2. Geocodes any row whose `latitude`/`longitude` are NULL (new rows
 *      and address-changed rows) and persists the coordinates.
 *
 * Idempotent + safe to re-run: rows already geocoded are not touched
 * again unless their address text changed. Writes are confined to
 * `litalerts_retailer_locations`; nothing else (and never
 * `sales_reconciliation`) is mutated.
 *
 * Dependencies are injected so the unit test can drive the whole flow
 * deterministically without a real partner API, Census service, or
 * database:
 *   - `db`            — a `Queryable` (prod: the shared pool).
 *   - `listRetailers` — prod: `partnerClient.listRetailers`.
 *   - `geocode`       — prod: a wrapper over `geocoder/census.ts`'s
 *                       shared 1-RPS `geocodeViaCensus`, which already
 *                       centralises the Census rate limit (the one-off's
 *                       loose 200ms sleep is replaced by that limiter).
 */

import type { Queryable } from '../../server/db/pool.js'
import type { LitAlertsRetailer } from './partnerClient.js'

export interface RetailerGeocodeCoordinates {
  latitude: number
  longitude: number
}

export interface RefreshRetailerLocationsDeps {
  db: Queryable
  listRetailers: (stateCode: string) => Promise<LitAlertsRetailer[]>
  /** Resolve a one-line address to coordinates, or null when it cannot be geocoded. */
  geocode: (address: string) => Promise<RetailerGeocodeCoordinates | null>
  log?: (line: string) => void
}

export interface RefreshRetailerLocationsTotals {
  retailersSeen: number
  upserted: number
  newlyGeocoded: number
  alreadyGeocoded: number
  missingAddress: number
  geocodeFailures: number
}

const GEOCODER_SOURCE = 'census-onelineaddress'

interface UpsertNeedsGeocodeRow {
  needs_geocode: boolean
}

export async function refreshLitalertsRetailerLocations(
  stateCode: string,
  deps: RefreshRetailerLocationsDeps,
): Promise<RefreshRetailerLocationsTotals> {
  const normalizedState = stateCode.trim().toUpperCase()
  const log = deps.log ?? (() => undefined)

  const retailers = await deps.listRetailers(normalizedState)
  log(`fetched ${retailers.length} retailers for ${normalizedState}`)

  const totals: RefreshRetailerLocationsTotals = {
    retailersSeen: retailers.length,
    upserted: 0,
    newlyGeocoded: 0,
    alreadyGeocoded: 0,
    missingAddress: 0,
    geocodeFailures: 0,
  }

  for (const retailer of retailers) {
    const address = retailer.address?.trim() ?? null
    const upsertResult = await deps.db.query<UpsertNeedsGeocodeRow>(
      `
      insert into litalerts_retailer_locations
        (retailer_id, name, address, state_code, recreational, medical, last_seen_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, now(), now())
      on conflict (retailer_id) do update set
        name = excluded.name,
        address = excluded.address,
        state_code = excluded.state_code,
        recreational = excluded.recreational,
        medical = excluded.medical,
        last_seen_at = now(),
        updated_at = case
          when litalerts_retailer_locations.address is distinct from excluded.address
            or litalerts_retailer_locations.name is distinct from excluded.name
          then now()
          else litalerts_retailer_locations.updated_at
        end,
        -- invalidate stale geocode when address changed
        latitude = case
          when litalerts_retailer_locations.address is distinct from excluded.address
          then null
          else litalerts_retailer_locations.latitude
        end,
        longitude = case
          when litalerts_retailer_locations.address is distinct from excluded.address
          then null
          else litalerts_retailer_locations.longitude
        end,
        geocoded_at = case
          when litalerts_retailer_locations.address is distinct from excluded.address
          then null
          else litalerts_retailer_locations.geocoded_at
        end,
        geocoder_source = case
          when litalerts_retailer_locations.address is distinct from excluded.address
          then null
          else litalerts_retailer_locations.geocoder_source
        end
      returning (latitude is null or longitude is null) as needs_geocode
      `,
      [
        retailer.id,
        retailer.name.trim(),
        address,
        normalizedState,
        retailer.recreational ?? null,
        retailer.medical ?? null,
      ],
    )
    totals.upserted++

    const needsGeocode = upsertResult.rows[0]?.needs_geocode ?? false
    if (!needsGeocode) {
      totals.alreadyGeocoded++
      continue
    }

    if (!address) {
      totals.missingAddress++
      continue
    }

    const coords = await deps.geocode(address)
    if (!coords) {
      totals.geocodeFailures++
      continue
    }

    await deps.db.query(
      `update litalerts_retailer_locations
         set latitude = $2, longitude = $3, geocoded_at = now(),
             geocoder_source = $4
       where retailer_id = $1`,
      [retailer.id, coords.latitude, coords.longitude, GEOCODER_SOURCE],
    )
    totals.newlyGeocoded++
  }

  log(
    `done. upserted=${totals.upserted}, newlyGeocoded=${totals.newlyGeocoded}, ` +
      `alreadyGeocoded=${totals.alreadyGeocoded}, missingAddress=${totals.missingAddress}, ` +
      `geocodeFailures=${totals.geocodeFailures}`,
  )
  return totals
}
