/**
 * Read / write helpers for the shared `addresses` table introduced
 * by issue #25 (sweed-address-enrichment epic, task A1 schema).
 *
 * Schema reference (see migration 036_addresses.sql once A1 lands):
 *
 *   addresses (
 *     id               bigserial PK,
 *     raw_line1        text,
 *     raw_line2        text,
 *     raw_city         text,
 *     raw_state        text,
 *     raw_zip          text,
 *     normalized       text NOT NULL UNIQUE,
 *     latitude         double precision,
 *     longitude        double precision,
 *     zip5             text,
 *     city             text,
 *     county           text,
 *     state_code       text,
 *     geocode_status   text NOT NULL DEFAULT 'pending',
 *     geocoder_source  text,
 *     last_geocoded_at timestamptz,
 *     created_at       timestamptz NOT NULL DEFAULT now(),
 *     updated_at       timestamptz NOT NULL DEFAULT now()
 *   )
 *
 * These helpers are deliberately producer-agnostic: the delivery
 * enrichment job (A4) and the customer-of-record enrichment job (A5)
 * both upsert through `upsertAddress`, and a background geocoder
 * tick drains `queueGeocodePending` -> `applyGeocodeResult`.
 */

import type { QueryResultRow } from 'pg'

import type { Queryable } from '../../server/db/pool.js'
import { normaliseAddressParts, type RawAddressInput } from './addressParts.js'

export type GeocodeStatus = 'pending' | 'ok' | 'failed' | 'not_us'

export interface UpsertAddressResult {
  addressId: number
  isNew: boolean
  geocodeStatus: GeocodeStatus
}

interface UpsertAddressRow extends QueryResultRow {
  id: number
  geocode_status: GeocodeStatus
  is_new: boolean
}

/**
 * Insert-or-touch an address row keyed by the normalized one-liner.
 *
 *   - New row -> created with `geocode_status='pending'`, returns
 *     `isNew=true`. The caller (typically an enrichment job) is
 *     responsible for queueing a geocoder tick afterwards.
 *   - Existing row -> `updated_at` is bumped (so we know the address
 *     is still being observed) but `geocode_status`, lat/lng,
 *     geocoder_source etc. are left untouched. Returns
 *     `isNew=false` and the *current* geocode_status so the caller
 *     can short-circuit if it already has coords.
 *
 * Returns `null` when the input collapses to an empty normalized
 * string (every component blank). Callers should treat that as
 * "no usable address" and skip persistence entirely.
 */
export async function upsertAddress(
  db: Queryable,
  input: RawAddressInput,
): Promise<UpsertAddressResult | null> {
  const parts = normaliseAddressParts(input)
  if (parts.normalized.length === 0) {
    return null
  }

  const result = await db.query<UpsertAddressRow>(
    `
    insert into addresses
      (raw_line1, raw_line2, raw_city, raw_state, raw_zip, normalized)
    values ($1, $2, $3, $4, $5, $6)
    on conflict (normalized) do update set
      updated_at = now()
    returning
      id,
      geocode_status,
      (xmax = 0) as is_new
    `,
    [
      parts.rawLine1,
      parts.rawLine2,
      parts.rawCity,
      parts.rawState,
      parts.rawZip,
      parts.normalized,
    ],
  )

  const row = result.rows[0]
  if (!row) {
    // Should never happen for an upsert that returns; surface as
    // a programmer error rather than silently dropping.
    throw new Error('upsertAddress: ON CONFLICT upsert returned no row')
  }
  return {
    addressId: row.id,
    isNew: row.is_new,
    geocodeStatus: row.geocode_status,
  }
}

export interface PendingGeocodeAddress {
  addressId: number
  normalized: string
}

interface PendingGeocodeRow extends QueryResultRow {
  id: number
  normalized: string
}

/**
 * Pick up to `batchSize` addresses that still need geocoding.
 *
 * Uses `FOR UPDATE SKIP LOCKED` so that multiple geocoder ticks
 * (or multiple workers) can run concurrently without re-attempting
 * the same row. Callers MUST hold the surrounding transaction open
 * for the duration of the geocode work and call
 * `applyGeocodeResult` on the same connection, otherwise the row
 * lock is released without progress.
 *
 * Ordered by `id` so the queue drains oldest-first (matching the
 * order rows were observed, not the order Sweed assigned to them).
 */
export async function queueGeocodePending(
  db: Queryable,
  batchSize: number,
): Promise<PendingGeocodeAddress[]> {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`queueGeocodePending: batchSize must be a positive integer (got ${batchSize})`)
  }
  const result = await db.query<PendingGeocodeRow>(
    `
    select id, normalized
      from addresses
     where geocode_status = 'pending'
     order by id
     limit $1
       for update skip locked
    `,
    [batchSize],
  )
  return result.rows.map((row) => ({ addressId: row.id, normalized: row.normalized }))
}

export interface GeocodeResult {
  latitude: number | null
  longitude: number | null
  zip5: string | null
  city: string | null
  county: string | null
  stateCode: string | null
  status: GeocodeStatus
  /** Source label persisted into addresses.geocoder_source — defaults
   *  to 'census-onelineaddress' when omitted by the caller. */
  source?: string
}

/**
 * Persist a geocode attempt outcome. ALL columns the geocoder may
 * have populated are written in a single UPDATE so partial results
 * (e.g. a 'failed' attempt that nonetheless contains best-effort
 * city/state) are stored atomically.
 *
 * `geocode_status` MUST NOT be 'pending' on the way in — that's the
 * starting state, not an outcome. We assert rather than silently
 * skip so a mis-coded caller doesn't quietly leave the row stuck
 * in the queue.
 */
export async function applyGeocodeResult(
  db: Queryable,
  addressId: number,
  result: GeocodeResult,
): Promise<void> {
  if (result.status === 'pending') {
    throw new Error(
      `applyGeocodeResult: refusing to write 'pending' as an outcome for address ${addressId}`,
    )
  }
  await db.query(
    `
    update addresses
       set latitude          = $2,
           longitude         = $3,
           zip5              = $4,
           city              = $5,
           county            = $6,
           state_code        = $7,
           geocode_status    = $8,
           geocoder_source   = $9,
           last_geocoded_at  = now(),
           updated_at        = now()
     where id = $1
    `,
    [
      addressId,
      result.latitude,
      result.longitude,
      result.zip5,
      result.city,
      result.county,
      result.stateCode,
      result.status,
      result.source ?? 'census-onelineaddress',
    ],
  )
}
