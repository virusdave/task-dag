// Shared insert + list helpers for the `visitor_scans` table.
//
// Both the live webhook handler
// (helios/src/server/routes/visitorScans.ts) and the operator-run
// backfill CLI (helios/scripts/visitor-scans-backfill.ts) go through
// this single insert function — which is the only place the
// `ON CONFLICT (provider, hash_id) DO NOTHING` idempotency lives.
//
// Returning `inserted` from the insert lets the backfill CLI count
// `inserted=` vs. `skipped_duplicate=` without a second query.

import type { Queryable } from '../pool.js'
import type { VisitorScanRowInput } from '../../visitorScans/envelope.js'

export interface InsertVisitorScanResult {
  inserted: boolean
}

/**
 * Insert a single visitor_scans row. Returns `{ inserted: false }`
 * when the `(provider, hash_id)` unique constraint already had the
 * row (re-delivered webhook or repeated backfill) and `{ inserted:
 * true }` when this call wrote a new row.
 *
 * The full mapping from VeriScan wire envelope → these column values
 * lives in helios/src/server/visitorScans/envelope.ts. Keep the two
 * in lock-step.
 */
export async function insertVisitorScan(
  db: Queryable,
  row: VisitorScanRowInput,
): Promise<InsertVisitorScanResult> {
  const result = await db.query<{ id: string | number }>(
    `
      insert into visitor_scans (
        ingest_source, site_slug, provider, raw_envelope,
        event_id, webhook_id, webhook_type, webhook_type_id, created_at, sent_at,
        hash_id, history_log_id, scanned_at,
        id_num, first_name, middle_name, last_name, birth_date, exp_date,
        gender, phone, email,
        address, city, state, postal_code, country, country_code, jurisdiction_code,
        latitude, longitude, scan_latitude, scan_longitude,
        device_id, device_name, device_login,
        location_id, location_name,
        group_id, group_name, group_comment,
        document_type, document_is_valid,
        authentication_status, scan_status,
        comments, profile_comments, tags, user_agent,
        image_link, signature_link, attachment_links
      )
      values (
        $1, $2, $3, $4::jsonb,
        $5, $6, $7, $8, $9, $10,
        $11::uuid, $12, $13,
        $14, $15, $16, $17, $18, $19,
        $20, $21, $22,
        $23, $24, $25, $26, $27, $28, $29,
        $30, $31, $32, $33,
        $34, $35, $36,
        $37, $38,
        $39, $40, $41,
        $42, $43,
        $44, $45,
        $46, $47, $48, $49,
        $50, $51, $52::jsonb
      )
      on conflict (provider, hash_id) do nothing
      returning id
    `,
    [
      row.ingestSource,
      row.siteSlug,
      row.provider,
      JSON.stringify(row.rawEnvelope),

      row.eventId === null ? null : row.eventId.toString(),
      row.webhookId === null ? null : row.webhookId.toString(),
      row.webhookType,
      row.webhookTypeId,
      row.createdAt,
      row.sentAt,

      row.hashId,
      row.historyLogId === null ? null : row.historyLogId.toString(),
      row.scannedAt,

      row.idNum,
      row.firstName,
      row.middleName,
      row.lastName,
      row.birthDate,
      row.expDate,

      row.gender,
      row.phone,
      row.email,

      row.address,
      row.city,
      row.state,
      row.postalCode,
      row.country,
      row.countryCode,
      row.jurisdictionCode,

      row.latitude,
      row.longitude,
      row.scanLatitude,
      row.scanLongitude,

      row.deviceId === null ? null : row.deviceId.toString(),
      row.deviceName,
      row.deviceLogin,

      row.locationId === null ? null : row.locationId.toString(),
      row.locationName,

      row.groupId === null ? null : row.groupId.toString(),
      row.groupName,
      row.groupComment,

      row.documentType,
      row.documentIsValid,

      row.authenticationStatus,
      row.scanStatus,

      row.comments,
      row.profileComments,
      row.tags,
      row.userAgent,

      row.imageLink,
      row.signatureLink,
      row.attachmentLinks === null ? null : JSON.stringify(row.attachmentLinks),
    ],
  )
  return { inserted: result.rows.length > 0 }
}

// ---------------------------------------------------------------------
// Listing / drawer fetch for the /admin/visitors/scans page.
// ---------------------------------------------------------------------

export interface VisitorScanListItem {
  id: number
  ingestedAt: string
  ingestSource: string
  siteSlug: string
  provider: string
  scannedAt: string | null
  createdAt: string | null
  webhookType: string | null
  hashId: string
  firstName: string | null
  middleName: string | null
  lastName: string | null
  state: string | null
  postalCode: string | null
  city: string | null
  address: string | null
  country: string | null
  documentType: string | null
  authenticationStatus: string | null
  scanStatus: string | null
  latitude: number | null
  longitude: number | null
  scanLatitude: number | null
  scanLongitude: number | null
  rawEnvelope: unknown
}

interface VisitorScanRow {
  id: string | number
  ingested_at: Date
  ingest_source: string
  site_slug: string
  provider: string
  scanned_at: Date | null
  created_at: Date | null
  webhook_type: string | null
  hash_id: string
  first_name: string | null
  middle_name: string | null
  last_name: string | null
  state: string | null
  postal_code: string | null
  city: string | null
  address: string | null
  country: string | null
  document_type: string | null
  authentication_status: string | null
  scan_status: string | null
  latitude: string | number | null
  longitude: string | number | null
  scan_latitude: string | number | null
  scan_longitude: string | number | null
  raw_envelope: unknown
}

function rowToItem(row: VisitorScanRow): VisitorScanListItem {
  function toIso(value: Date | null): string | null {
    return value === null ? null : value instanceof Date ? value.toISOString() : String(value)
  }
  function numOrNull(value: string | number | null): number | null {
    if (value === null) return null
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) ? n : null
  }
  return {
    id: Number(row.id),
    ingestedAt: toIso(row.ingested_at) ?? '',
    ingestSource: row.ingest_source,
    siteSlug: row.site_slug,
    provider: row.provider,
    scannedAt: toIso(row.scanned_at),
    createdAt: toIso(row.created_at),
    webhookType: row.webhook_type,
    hashId: row.hash_id,
    firstName: row.first_name,
    middleName: row.middle_name,
    lastName: row.last_name,
    state: row.state,
    postalCode: row.postal_code,
    city: row.city,
    address: row.address,
    country: row.country,
    documentType: row.document_type,
    authenticationStatus: row.authentication_status,
    scanStatus: row.scan_status,
    latitude: numOrNull(row.latitude),
    longitude: numOrNull(row.longitude),
    scanLatitude: numOrNull(row.scan_latitude),
    scanLongitude: numOrNull(row.scan_longitude),
    rawEnvelope: row.raw_envelope,
  }
}

export interface ListVisitorScansFilter {
  siteSlugs: readonly string[] | null
  ingestSources: readonly string[] | null
  states: readonly string[] | null
  postalPrefix: string | null
  documentType: string | null
  authenticationStatus: string | null
  scanStatus: string | null
  scannedAfter: string | null
  scannedBefore: string | null
  // Forward-only cursor + limit; we over-fetch by one so the caller
  // can tell if there's a next page without a count query.
  beforeId: number | null
  limit: number
}

export async function listVisitorScans(
  db: Queryable,
  filter: ListVisitorScansFilter,
): Promise<{ items: VisitorScanListItem[]; hasMore: boolean }> {
  const conditions: string[] = []
  const params: unknown[] = []

  function add(sql: (placeholder: string) => string, value: unknown): void {
    params.push(value)
    conditions.push(sql(`$${params.length}`))
  }

  if (filter.siteSlugs !== null && filter.siteSlugs.length > 0) {
    add((p) => `site_slug = any(${p})`, filter.siteSlugs)
  }
  if (filter.ingestSources !== null && filter.ingestSources.length > 0) {
    add((p) => `ingest_source = any(${p})`, filter.ingestSources)
  }
  if (filter.states !== null && filter.states.length > 0) {
    add((p) => `state = any(${p})`, filter.states)
  }
  if (filter.postalPrefix !== null && filter.postalPrefix.length > 0) {
    add((p) => `postal_code like ${p}`, `${filter.postalPrefix}%`)
  }
  if (filter.documentType !== null && filter.documentType.length > 0) {
    add((p) => `document_type = ${p}`, filter.documentType)
  }
  if (filter.authenticationStatus !== null && filter.authenticationStatus.length > 0) {
    add((p) => `authentication_status = ${p}`, filter.authenticationStatus)
  }
  if (filter.scanStatus !== null && filter.scanStatus.length > 0) {
    add((p) => `scan_status = ${p}`, filter.scanStatus)
  }
  if (filter.scannedAfter !== null) {
    add((p) => `(scanned_at is not null and scanned_at >= ${p})`, filter.scannedAfter)
  }
  if (filter.scannedBefore !== null) {
    add((p) => `(scanned_at is not null and scanned_at < ${p})`, filter.scannedBefore)
  }
  if (filter.beforeId !== null) {
    add((p) => `id < ${p}`, filter.beforeId)
  }

  const whereSql = conditions.length > 0 ? `where ${conditions.join(' and ')}` : ''

  const fetchLimit = Math.max(1, filter.limit) + 1
  params.push(fetchLimit)
  const limitPlaceholder = `$${params.length}`

  const sql = `
    select
      id, ingested_at, ingest_source, site_slug, provider,
      scanned_at, created_at, webhook_type,
      hash_id,
      first_name, middle_name, last_name,
      state, postal_code, city, address, country,
      document_type, authentication_status, scan_status,
      latitude, longitude, scan_latitude, scan_longitude,
      raw_envelope
    from visitor_scans
    ${whereSql}
    order by coalesce(scanned_at, ingested_at) desc, id desc
    limit ${limitPlaceholder}
  `

  const result = await db.query<VisitorScanRow>(sql, params)
  const rows = result.rows.map(rowToItem)
  const hasMore = rows.length > filter.limit
  return { items: hasMore ? rows.slice(0, filter.limit) : rows, hasMore }
}
