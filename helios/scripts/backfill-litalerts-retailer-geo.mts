/**
 * backfill-litalerts-retailer-geo
 *
 * One-shot script that:
 *   1. Pulls all retailers for a given US state from the LitAlerts
 *      partner API (`/v1/retailers?state=…`).
 *   2. Upserts each into `litalerts_retailer_locations` (refreshing
 *      `last_seen_at`).
 *   3. Geocodes any row whose `latitude`/`longitude` are NULL via the
 *      free US Census Geocoder (no API key needed; US-only;
 *      rate-limit-friendly ~1 RPS).
 *
 * Designed to be safe to re-run: rows already geocoded are not
 * touched again unless the address text changed.
 *
 * Usage (from helios/):
 *   DATABASE_URL=postgres://... npx tsx scripts/backfill-litalerts-retailer-geo.mts NY
 *
 * Requires `~/.secret/litalerts/partner-api-token` or the
 * `LITALERTS_PARTNER_API_TOKEN` env var.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { Pool } from 'pg'

const CENSUS_GEOCODER_URL =
  'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress'
const PARTNER_API_BASE_URL = 'https://partnerapi.litalerts.com'
const PARTNER_API_TOKEN_FILE = join(homedir(), '.secret', 'litalerts', 'partner-api-token')

interface LARetailer {
  id: number
  name: string
  address: string | null
  medical?: boolean
  recreational?: boolean
}

interface CensusCoordinates {
  latitude: number
  longitude: number
}

function loadPartnerToken(): string {
  const env = process.env.LITALERTS_PARTNER_API_TOKEN?.trim()
  if (env) return env
  try {
    return readFileSync(PARTNER_API_TOKEN_FILE, 'utf8').trim()
  } catch {
    throw new Error(
      `LitAlerts partner token missing: set LITALERTS_PARTNER_API_TOKEN or populate ${PARTNER_API_TOKEN_FILE}`,
    )
  }
}

async function listRetailers(stateCode: string): Promise<LARetailer[]> {
  const token = loadPartnerToken()
  const url = `${PARTNER_API_BASE_URL}/v1/retailers?state=${encodeURIComponent(stateCode)}`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    throw new Error(`LitAlerts /v1/retailers returned ${response.status} ${response.statusText}`)
  }
  const payload = (await response.json()) as { data: LARetailer[] }
  return payload.data
}

async function geocode(address: string): Promise<CensusCoordinates | null> {
  const url = new URL(CENSUS_GEOCODER_URL)
  url.searchParams.set('address', address)
  url.searchParams.set('benchmark', 'Public_AR_Current')
  url.searchParams.set('format', 'json')
  let response: Response
  try {
    response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    process.stderr.write(`  geocode timeout / network: ${(err as Error).message}\n`)
    return null
  }
  if (!response.ok) {
    process.stderr.write(`  geocode returned ${response.status}\n`)
    return null
  }
  const payload = (await response.json()) as {
    result?: { addressMatches?: Array<{ coordinates?: { x: number; y: number } }> }
  }
  const match = payload.result?.addressMatches?.[0]
  if (!match?.coordinates) return null
  return { latitude: match.coordinates.y, longitude: match.coordinates.x }
}

async function main(): Promise<void> {
  const stateCode = (process.argv[2] ?? 'NY').toUpperCase()
  if (!process.env.DATABASE_URL) {
    process.stderr.write('DATABASE_URL is required\n')
    process.exit(2)
  }

  process.stdout.write(`fetching retailers for ${stateCode}…\n`)
  const retailers = await listRetailers(stateCode)
  process.stdout.write(`  got ${retailers.length} retailers\n`)

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  let upserted = 0
  let geocoded = 0
  let skippedGeocoded = 0
  let geocodeFailed = 0

  try {
    for (const retailer of retailers) {
      const upsertResult = await pool.query<{ needs_geocode: boolean }>(
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
          end
        returning (latitude is null or longitude is null) as needs_geocode
        `,
        [
          retailer.id,
          retailer.name.trim(),
          retailer.address?.trim() ?? null,
          stateCode,
          retailer.recreational ?? null,
          retailer.medical ?? null,
        ],
      )
      upserted++

      const needsGeocode = upsertResult.rows[0]?.needs_geocode ?? false
      if (!needsGeocode) {
        skippedGeocoded++
        continue
      }

      if (!retailer.address) {
        geocodeFailed++
        continue
      }

      const coords = await geocode(retailer.address)
      if (!coords) {
        geocodeFailed++
        continue
      }
      await pool.query(
        `update litalerts_retailer_locations
           set latitude = $2, longitude = $3, geocoded_at = now(),
               geocoder_source = 'census-onelineaddress'
         where retailer_id = $1`,
        [retailer.id, coords.latitude, coords.longitude],
      )
      geocoded++
      // Mild rate-limit: Census Geocoder allows bursts but be nice.
      await new Promise((r) => setTimeout(r, 200))
    }
  } finally {
    await pool.end()
  }

  process.stdout.write(
    `done. upserted=${upserted}, newly_geocoded=${geocoded}, already_geocoded=${skippedGeocoded}, geocode_failures=${geocodeFailed}\n`,
  )
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
