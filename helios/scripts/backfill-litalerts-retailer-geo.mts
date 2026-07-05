/**
 * backfill-litalerts-retailer-geo
 *
 * One-shot manual runner for the same refresh the weekly
 * `config.workers.litalerts_retailer_geo_refresh` scheduled job performs
 * (issue #56). It:
 *   1. Pulls all retailers for a given US state from the LitAlerts
 *      partner API (`/v1/retailers?state=…`).
 *   2. Upserts each into `litalerts_retailer_locations` (refreshing
 *      `last_seen_at`).
 *   3. Geocodes any row whose `latitude`/`longitude` are NULL via the
 *      free US Census Geocoder.
 *
 * The upsert + geocode logic now lives in the shared, worker-importable
 * module `src/worker/litalerts/refreshRetailerLocations.ts`, and geocoding
 * goes through the shared 1-RPS Census client
 * (`src/worker/geocoder/census.ts`) — so this one-off and the scheduled
 * job can never drift apart. Safe to re-run: rows already geocoded are not
 * touched again unless the address text changed.
 *
 * Usage (from helios/):
 *   DATABASE_URL=postgres://... npx tsx scripts/backfill-litalerts-retailer-geo.mts NY
 *
 * Requires `~/.secret/litalerts/partner-api-token` or the
 * `LITALERTS_PARTNER_API_TOKEN` env var.
 */

import { Pool } from 'pg'

import { geocodeViaCensus } from '../src/worker/geocoder/census.js'
import { listRetailers } from '../src/worker/litalerts/partnerClient.js'
import { refreshLitalertsRetailerLocations } from '../src/worker/litalerts/refreshRetailerLocations.js'

async function main(): Promise<void> {
  const stateCode = (process.argv[2] ?? 'NY').toUpperCase()
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    process.stderr.write('DATABASE_URL is required\n')
    process.exit(2)
  }

  const pool = new Pool({ connectionString: databaseUrl })
  try {
    const totals = await refreshLitalertsRetailerLocations(stateCode, {
      db: pool,
      listRetailers,
      geocode: async (address) => {
        const result = await geocodeViaCensus(address)
        if (result.status !== 'ok' || result.latitude === null || result.longitude === null) {
          return null
        }
        return { latitude: result.latitude, longitude: result.longitude }
      },
      log: (line) => process.stdout.write(`${line}\n`),
    })
    process.stdout.write(
      `done. upserted=${totals.upserted}, newly_geocoded=${totals.newlyGeocoded}, ` +
        `already_geocoded=${totals.alreadyGeocoded}, missing_address=${totals.missingAddress}, ` +
        `geocode_failures=${totals.geocodeFailures}\n`,
    )
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
