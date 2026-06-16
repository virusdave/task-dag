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
import { computePersonKey } from '../../visitorScans/personKey.js'
import { seedVisitorScanLink } from './visitorScanLinkQueries.js'
import { upsertAddress } from '../../../worker/geocoder/index.js'
import {
  readMarketingSegmentChipsForCustomers,
  type VisitorScanMarketingSegmentsSummary,
} from './sweedCustomerSegmentsQueries.js'

export interface InsertVisitorScanResult {
  inserted: boolean
  /**
   * Numeric id of the row. Populated whether or not this call wrote
   * the row — for duplicates we re-SELECT the id so callers (e.g.
   * the webhook handler enqueuing a Sweed-link probe) can still
   * reference the canonical scan row. Null only when we couldn't
   * resolve an id at all (should be impossible in practice; the
   * column is `bigint primary key`).
   */
  scanId: number | null
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
  const personKey = computePersonKey({
    firstName: row.firstName,
    lastName: row.lastName,
    birthDate: row.birthDate,
    state: row.state,
    postalCode: row.postalCode,
  })
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
        image_link, signature_link, attachment_links,
        person_key
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
        $50, $51, $52::jsonb,
        $53
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
      personKey,
    ],
  )
  const inserted = result.rows.length > 0
  if (inserted) {
    // Seed the Sweed-link row so the background worker can probe it.
    // Best-effort: a failure here must not break the webhook path.
    try {
      await seedVisitorScanLink(db, {
        scanId: Number(result.rows[0].id),
        siteSlug: row.siteSlug,
        idNum: row.idNum,
        firstName: row.firstName,
        lastName: row.lastName,
      })
    } catch (cause) {
      // Swallow — the migration's backfill query also covers historic
      // rows, and the worker can retry on its own. We still log loudly
      // so a repeated failure is visible in the server logs.
      // eslint-disable-next-line no-console
      console.warn('[visitor-scans] seedVisitorScanLink failed', {
        scanId: Number(result.rows[0].id),
        cause: cause instanceof Error ? cause.message : String(cause),
      })
    }
    // Forward-flow address link: feed the shared `addresses` /
    // Census-geocoder pipeline so the customer-origin map can plot
    // the customer's real home coords (NOT vs.latitude, which is
    // actually the scanner-kiosk location per the VeriScan
    // envelope). Best-effort: the backfill script
    // helios/scripts/backfill-visitor-scan-geocodes.ts catches any
    // gaps and a re-run is a no-op.
    try {
      const scanId = Number(result.rows[0].id)
      const upserted = await upsertAddress(db, {
        line1: row.address,
        line2: null,
        city: row.city,
        state: row.state,
        zip: row.postalCode,
      })
      if (upserted !== null) {
        await db.query(
          `update visitor_scans
              set address_id = $1
            where id = $2
              and address_id is null`,
          [upserted.addressId, scanId],
        )
      }
    } catch (cause) {
      // eslint-disable-next-line no-console
      console.warn('[visitor-scans] address linking failed', {
        scanId: Number(result.rows[0].id),
        cause: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }
  let scanId: number | null = inserted ? Number(result.rows[0].id) : null
  if (!inserted) {
    // Duplicate delivery — look up the canonical id. Single-row
    // lookup on a (provider, hash_id) unique index, so this is a
    // single fast index lookup.
    const dup = await db.query<{ id: string | number }>(
      `select id from visitor_scans where provider = $1 and hash_id = $2::uuid`,
      [row.provider, row.hashId],
    )
    scanId = dup.rows.length > 0 ? Number(dup.rows[0].id) : null
  }
  return { inserted, scanId }
}

// ---------------------------------------------------------------------
// Listing / drawer fetch for the /admin/visitors/scans page.
// ---------------------------------------------------------------------

export interface VisitorScanListIdentity {
  personKey: string | null
  // Strong id_num-based "have we scanned this specific ID before?"
  // The /admin/visitors/scans pill called "First scan" reads from
  // `isFirstScanByIdNum`. Computed with a NOT EXISTS-equivalent
  // lateral join scoped on (provider, id_num).
  priorIdNumScanCount: number
  isFirstScanByIdNum: boolean
  // Looser person_key-based grouping (name+DOB+state+zip5). Surfaced
  // on the details page so an operator can spot returning visitors
  // even when an id_num was missing or mistyped. NOT used for the
  // primary list pill anymore.
  priorLocalScanCount: number
  firstLocalScanAt: string | null
  latestLocalScanAt: string | null
  isFirstLocalScan: boolean
}

export type VisitorScanLinkStatusListItem =
  | 'pending'
  | 'ambiguous'
  | 'linked'
  | 'no_match'
  | 'failed'
  | 'rejected'
  | 'insufficient_data'

export interface VisitorScanListSweedLink {
  dealerId: number
  customerId: number | null
  status: VisitorScanLinkStatusListItem
  method: string | null
  confidence: number | null
  linkedAt: string | null
  lastProbedAt: string | null
  nextProbeAt: string | null
  candidateCount: number
}

export interface VisitorScanListSweedSummary {
  priorPurchaseCount: number
  totalPurchaseCount: number
  firstPurchaseAt: string | null
  firstPurchaseTotalDollars: number | null
  latestPurchaseAt: string | null
  lifetimeSpendDollars: number
  hasPriorPurchaseBeforeScan: boolean
  // ---- D2 enrichment (virusdave/top-level#12) ----
  averagePurchaseDollars: number | null
  favoriteCategoryName: string | null
  favoriteProductName: string | null
}

/**
 * Shared SQL fragment computing a customer's "favorite category" /
 * "favorite product" — the category and product (resolved from the
 * latest `sweed_package_snapshots` row per inventory_item_id) that
 * appear in the most distinct invoices for this customer.
 *
 * Returns NULLs for both when no category / product clears the
 * 3-distinct-invoices threshold (per the operator's "≥3 repeats to
 * qualify" rule). Two correlated subqueries — one per axis — kept
 * deliberately simple so the planner can choose the obvious index
 * paths (sweed_orders_customer_pay_time_idx,
 * sweed_order_items_flat_invoice_idx,
 * sweed_package_snapshots_inventory_item_idx) without hinting.
 *
 * The substitutions `:dealer` and `:customer` are intentionally
 * left as text placeholders; the caller string-interpolates them
 * with the actual SQL parameter aliases (e.g. `l.dealer_id` and
 * `l.sweed_customer_id`) so we don't need to wire extra positional
 * parameters per row. Both inputs are column references on the
 * outer query, NOT user input, so no injection risk.
 *
 * Cost guard: the entire block evaluates to NULL when `:customer
 * IS NULL`, so unlinked rows pay zero per-row aggregation cost.
 */
function favoriteCategoryProductSubqueriesSql(
  dealer: string,
  customer: string,
): {
  selectColumns: string
  ctes: string
} {
  // We compute both axes in a single CTE-like LATERAL so the
  // customer's items are scanned once. Postgres' planner inlines
  // the LATERAL aggregate.
  return {
    selectColumns: `
      fav.favorite_category_name as sweed_favorite_category_name,
      fav.favorite_product_name  as sweed_favorite_product_name
    `,
    ctes: `
      left join lateral (
        with customer_items as (
          select
            so.invoice_id,
            snap.category_name,
            snap.product_name
          from sweed_orders so
          join sweed_order_items_flat soi
            on soi.dealer_id = so.dealer_id
           and soi.invoice_id = so.invoice_id
          left join lateral (
            select category_name, product_name
            from sweed_package_snapshots
            where dealer_id = soi.dealer_id
              and inventory_item_id = soi.inventory_item_id
            order by observed_at_max desc
            limit 1
          ) snap on true
          where ${customer} is not null
            and so.dealer_id = ${dealer}
            and so.customer_id = ${customer}
        ),
        category_counts as (
          select category_name, count(distinct invoice_id) as invoice_count
          from customer_items
          where category_name is not null
          group by category_name
          having count(distinct invoice_id) >= 3
          order by invoice_count desc, category_name asc
          limit 1
        ),
        product_counts as (
          select product_name, count(distinct invoice_id) as invoice_count
          from customer_items
          where product_name is not null
          group by product_name
          having count(distinct invoice_id) >= 3
          order by invoice_count desc, product_name asc
          limit 1
        )
        select
          (select category_name from category_counts) as favorite_category_name,
          (select product_name  from product_counts)  as favorite_product_name
      ) fav on ${customer} is not null
    `,
  }
}

export interface VisitorScanListMiniMarker {
  lat: number
  lng: number
  source: 'document_address' | 'scan_location'
}

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

  // ---- enrichment from A4 (FreshlyBakedNYC/automation#31) ----
  customerUrl: string
  identity: VisitorScanListIdentity
  sweedLink: VisitorScanListSweedLink | null
  sweedPurchaseSummary: VisitorScanListSweedSummary | null
  miniMarker: VisitorScanListMiniMarker | null
  // Bounded cached marketing-segment membership for the linked
  // customer; populated by a single batch query per page (see
  // listVisitorScans). null when not linked or no enabled memberships.
  marketingSegments: VisitorScanMarketingSegmentsSummary | null
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

  person_key: string | null
  prior_id_num_scan_count: string | number | null
  prior_local_scan_count: string | number | null
  first_local_scan_at: Date | null
  latest_local_scan_at: Date | null

  link_dealer_id: string | number | null
  link_customer_id: string | number | null
  link_status: string | null
  link_method: string | null
  link_confidence: string | number | null
  link_linked_at: Date | null
  link_last_probed_at: Date | null
  link_next_probe_at: Date | null
  link_candidate_count: string | number | null

  sweed_total_purchase_count: string | number | null
  sweed_prior_purchase_count: string | number | null
  sweed_first_purchase_at: Date | null
  sweed_first_purchase_total: string | number | null
  sweed_latest_purchase_at: Date | null
  sweed_lifetime_spend: string | number | null
  sweed_favorite_category_name: string | null
  sweed_favorite_product_name: string | null
}

function toIsoNullable(value: Date | null): string | null {
  return value === null ? null : value instanceof Date ? value.toISOString() : String(value)
}

function numOrNullValue(value: string | number | null): number | null {
  if (value === null) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function intOrZero(value: string | number | null): number {
  const n = numOrNullValue(value)
  return n === null ? 0 : Math.trunc(n)
}

const KNOWN_LINK_STATUSES: ReadonlySet<VisitorScanLinkStatusListItem> = new Set([
  'pending',
  'ambiguous',
  'linked',
  'no_match',
  'failed',
  'rejected',
  'insufficient_data',
])

function rowToItem(row: VisitorScanRow): VisitorScanListItem {
  const latitude = numOrNullValue(row.latitude)
  const longitude = numOrNullValue(row.longitude)
  const scanLat = numOrNullValue(row.scan_latitude)
  const scanLng = numOrNullValue(row.scan_longitude)

  let miniMarker: VisitorScanListMiniMarker | null = null
  if (latitude !== null && longitude !== null) {
    miniMarker = { lat: latitude, lng: longitude, source: 'document_address' }
  } else if (scanLat !== null && scanLng !== null) {
    miniMarker = { lat: scanLat, lng: scanLng, source: 'scan_location' }
  }

  const linkDealerId = numOrNullValue(row.link_dealer_id)
  let sweedLink: VisitorScanListSweedLink | null = null
  if (linkDealerId !== null && row.link_status !== null) {
    const status = KNOWN_LINK_STATUSES.has(row.link_status as VisitorScanLinkStatusListItem)
      ? (row.link_status as VisitorScanLinkStatusListItem)
      : 'pending'
    sweedLink = {
      dealerId: linkDealerId,
      customerId: numOrNullValue(row.link_customer_id),
      status,
      method: row.link_method,
      confidence: numOrNullValue(row.link_confidence),
      linkedAt: toIsoNullable(row.link_linked_at),
      lastProbedAt: toIsoNullable(row.link_last_probed_at),
      nextProbeAt: toIsoNullable(row.link_next_probe_at),
      candidateCount: intOrZero(row.link_candidate_count),
    }
  }

  let sweedPurchaseSummary: VisitorScanListSweedSummary | null = null
  if (sweedLink !== null && sweedLink.customerId !== null) {
    const totalPurchaseCount = intOrZero(row.sweed_total_purchase_count)
    const priorPurchaseCount = intOrZero(row.sweed_prior_purchase_count)
    const lifetimeSpend = numOrNullValue(row.sweed_lifetime_spend) ?? 0
    const averagePurchase =
      totalPurchaseCount > 0
        ? Number((lifetimeSpend / totalPurchaseCount).toFixed(2))
        : null
    sweedPurchaseSummary = {
      totalPurchaseCount,
      priorPurchaseCount,
      firstPurchaseAt: toIsoNullable(row.sweed_first_purchase_at),
      firstPurchaseTotalDollars: numOrNullValue(row.sweed_first_purchase_total),
      latestPurchaseAt: toIsoNullable(row.sweed_latest_purchase_at),
      lifetimeSpendDollars: lifetimeSpend,
      hasPriorPurchaseBeforeScan: priorPurchaseCount > 0,
      averagePurchaseDollars: averagePurchase,
      favoriteCategoryName:
        typeof row.sweed_favorite_category_name === 'string' &&
        row.sweed_favorite_category_name.trim().length > 0
          ? row.sweed_favorite_category_name
          : null,
      favoriteProductName:
        typeof row.sweed_favorite_product_name === 'string' &&
        row.sweed_favorite_product_name.trim().length > 0
          ? row.sweed_favorite_product_name
          : null,
    }
  }

  const priorLocalScanCount = intOrZero(row.prior_local_scan_count)
  const priorIdNumScanCount = intOrZero(row.prior_id_num_scan_count)

  return {
    id: Number(row.id),
    ingestedAt: toIsoNullable(row.ingested_at) ?? '',
    ingestSource: row.ingest_source,
    siteSlug: row.site_slug,
    provider: row.provider,
    scannedAt: toIsoNullable(row.scanned_at),
    createdAt: toIsoNullable(row.created_at),
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
    latitude,
    longitude,
    scanLatitude: scanLat,
    scanLongitude: scanLng,
    rawEnvelope: row.raw_envelope,
    customerUrl: `/admin/customers/visitors/${Number(row.id)}`,
    identity: {
      personKey: row.person_key,
      priorIdNumScanCount,
      isFirstScanByIdNum: priorIdNumScanCount === 0,
      priorLocalScanCount,
      firstLocalScanAt: toIsoNullable(row.first_local_scan_at),
      latestLocalScanAt: toIsoNullable(row.latest_local_scan_at),
      isFirstLocalScan: priorLocalScanCount === 0,
    },
    sweedLink,
    sweedPurchaseSummary,
    miniMarker,
    // Filled in by listVisitorScans' per-page batch query; rows that
    // aren't linked or have no cached membership stay null.
    marketingSegments: null,
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
    add((p) => `vs.site_slug = any(${p})`, filter.siteSlugs)
  }
  if (filter.ingestSources !== null && filter.ingestSources.length > 0) {
    add((p) => `vs.ingest_source = any(${p})`, filter.ingestSources)
  }
  if (filter.states !== null && filter.states.length > 0) {
    add((p) => `vs.state = any(${p})`, filter.states)
  }
  if (filter.postalPrefix !== null && filter.postalPrefix.length > 0) {
    add((p) => `vs.postal_code like ${p}`, `${filter.postalPrefix}%`)
  }
  if (filter.documentType !== null && filter.documentType.length > 0) {
    add((p) => `vs.document_type = ${p}`, filter.documentType)
  }
  if (filter.authenticationStatus !== null && filter.authenticationStatus.length > 0) {
    add((p) => `vs.authentication_status = ${p}`, filter.authenticationStatus)
  }
  if (filter.scanStatus !== null && filter.scanStatus.length > 0) {
    add((p) => `vs.scan_status = ${p}`, filter.scanStatus)
  }
  if (filter.scannedAfter !== null) {
    add((p) => `(vs.scanned_at is not null and vs.scanned_at >= ${p})`, filter.scannedAfter)
  }
  if (filter.scannedBefore !== null) {
    add((p) => `(vs.scanned_at is not null and vs.scanned_at < ${p})`, filter.scannedBefore)
  }
  if (filter.beforeId !== null) {
    add((p) => `vs.id < ${p}`, filter.beforeId)
  }

  const whereSql = conditions.length > 0 ? `where ${conditions.join(' and ')}` : ''

  const fetchLimit = Math.max(1, filter.limit) + 1
  params.push(fetchLimit)
  const limitPlaceholder = `$${params.length}`

  // The lateral joins below are scoped to a tiny set of rows (one
  // per item being returned, capped at limit+1) so the per-row cost
  // stays modest. The two key inputs (`person_key`,
  // `(dealer_id, sweed_customer_id)`) are indexed.
  const fav = favoriteCategoryProductSubqueriesSql(
    'l.dealer_id',
    'l.sweed_customer_id',
  )
  // Pick the page of scan ids FIRST, sorting only narrow rows
  // (id + sort key), then join the wide columns (incl. raw_envelope)
  // and the per-row laterals for just those <=limit+1 ids. Sorting the
  // full visitor_scans set while carrying raw_envelope previously forced
  // a multi-hundred-MB external-merge sort to disk on every call (the
  // single largest source of temp-file I/O on the database); deferring
  // the wide payload keeps the sort a tiny in-memory top-N. The filters
  // are all on vs columns, so applying them inside the page CTE selects
  // exactly the same rows the outer query used to.
  const sql = `
    with paged_scans as (
      select vs.id, coalesce(vs.scanned_at, vs.ingested_at) as sort_at
      from visitor_scans vs
      ${whereSql}
      order by coalesce(vs.scanned_at, vs.ingested_at) desc, vs.id desc
      limit ${limitPlaceholder}
    )
    select
      vs.id, vs.ingested_at, vs.ingest_source, vs.site_slug, vs.provider,
      vs.scanned_at, vs.created_at, vs.webhook_type,
      vs.hash_id,
      vs.first_name, vs.middle_name, vs.last_name,
      vs.state, vs.postal_code, vs.city, vs.address, vs.country,
      vs.document_type, vs.authentication_status, vs.scan_status,
      vs.latitude, vs.longitude, vs.scan_latitude, vs.scan_longitude,
      vs.raw_envelope,
      vs.person_key,

      coalesce(ident.prior_count, 0)        as prior_local_scan_count,
      ident.first_local_scan_at,
      ident.latest_local_scan_at,
      coalesce(id_num_ident.prior_count, 0) as prior_id_num_scan_count,

      l.dealer_id                            as link_dealer_id,
      l.sweed_customer_id                    as link_customer_id,
      l.link_status                          as link_status,
      l.link_method                          as link_method,
      l.confidence                           as link_confidence,
      l.linked_at                            as link_linked_at,
      l.last_probed_at                       as link_last_probed_at,
      l.next_probe_at                        as link_next_probe_at,
      coalesce(candidate_counts.candidate_count, 0) as link_candidate_count,

      sweed_summary.total_count              as sweed_total_purchase_count,
      sweed_summary.prior_count              as sweed_prior_purchase_count,
      sweed_summary.first_purchase_at        as sweed_first_purchase_at,
      sweed_summary.first_purchase_total     as sweed_first_purchase_total,
      sweed_summary.latest_purchase_at       as sweed_latest_purchase_at,
      sweed_summary.lifetime_spend           as sweed_lifetime_spend,
      ${fav.selectColumns}

    from paged_scans ps
    join visitor_scans vs on vs.id = ps.id

    left join visitor_scan_links l on l.scan_id = vs.id

    left join lateral (
      select
        count(*)::bigint                                as prior_count,
        min(coalesce(prior.scanned_at, prior.ingested_at)) as first_local_scan_at,
        max(coalesce(prior.scanned_at, prior.ingested_at)) as latest_local_scan_at
      from visitor_scans prior
      where vs.person_key is not null
        and prior.provider = vs.provider
        and prior.person_key = vs.person_key
        and prior.id <> vs.id
        and coalesce(prior.scanned_at, prior.ingested_at)
              < coalesce(vs.scanned_at, vs.ingested_at)
    ) ident on true

    -- Strict "First scan" indicator: is this the first time this exact
    -- id_num shows up under this provider? Cheap because of the
    -- visitor_scans_id_num_idx partial index added in migration 040.
    left join lateral (
      select count(*)::bigint as prior_count
      from visitor_scans prior_id
      where vs.id_num is not null
        and prior_id.provider = vs.provider
        and prior_id.id_num = vs.id_num
        and prior_id.id <> vs.id
        and coalesce(prior_id.scanned_at, prior_id.ingested_at)
              < coalesce(vs.scanned_at, vs.ingested_at)
    ) id_num_ident on true

    left join lateral (
      select count(*)::bigint as candidate_count
      from visitor_scan_link_candidates c
      where c.scan_id = vs.id and c.candidate_status = 'open'
    ) candidate_counts on true

    left join lateral (
      select
        count(*)::bigint                              as total_count,
        count(*) filter (
          where so.pay_time < coalesce(vs.scanned_at, vs.ingested_at)
        )::bigint                                     as prior_count,
        min(so.pay_time)                              as first_purchase_at,
        (
          select so2.grand_total_dollars
          from sweed_orders so2
          where so2.dealer_id = l.dealer_id
            and so2.customer_id = l.sweed_customer_id
          order by so2.pay_time asc
          limit 1
        )                                             as first_purchase_total,
        max(so.pay_time)                              as latest_purchase_at,
        coalesce(sum(so.grand_total_dollars), 0)      as lifetime_spend
      from sweed_orders so
      where l.sweed_customer_id is not null
        and so.dealer_id = l.dealer_id
        and so.customer_id = l.sweed_customer_id
    ) sweed_summary on l.sweed_customer_id is not null

    ${fav.ctes}

    -- Filtering + limit happen in paged_scans above; here we only need to
    -- restore the page's order after the 1:1 enrichment join.
    order by coalesce(vs.scanned_at, vs.ingested_at) desc, vs.id desc
  `

  const result = await db.query<VisitorScanRow>(sql, params)
  const rows = result.rows.map(rowToItem)
  const hasMore = rows.length > filter.limit
  const items = hasMore ? rows.slice(0, filter.limit) : rows

  // One batch query attaches cached marketing-segment chips to the
  // page's linked rows (vs a per-row lateral join in the main query).
  const linkedCustomerIds = items
    .map((it) => it.sweedLink?.customerId ?? null)
    .filter((id): id is number => id !== null)
  if (linkedCustomerIds.length > 0) {
    const chipsByCustomer = await readMarketingSegmentChipsForCustomers(db, linkedCustomerIds)
    for (const it of items) {
      const customerId = it.sweedLink?.customerId ?? null
      if (customerId === null) continue
      it.marketingSegments = chipsByCustomer.get(customerId) ?? null
    }
  }

  return { items, hasMore }
}

// ---------------------------------------------------------------------
// Cashier-tablet live check-ins query
// (virusdave/top-level#12 / FreshlyBakedNYC/automation#40, phase D1).
//
// Returns the most recent N visitor_scans as a privacy-redacted row
// shape: name is collapsed to "First L." server-side, and no
// state/postal/city/address/coords/document fields are emitted.
// The same data the operator page uses for the New/Returning pill
// and the Sweed purchase summary is included, since the cashier
// needs it to greet the customer appropriately.
//
// DB cost: one indexed top-N read on `visitor_scans` (ordered by
// id desc), plus three small lateral subqueries per row (last visit
// by id_num; CRM link join; sweed_orders aggregate when linked).
// Capped at limit=50 — sufficient for the at-counter rolling feed
// without bloating the per-poll payload.
// ---------------------------------------------------------------------

export interface CashierVisitorScanItem {
  id: number
  scannedAt: string | null
  ingestedAt: string
  siteSlug: string
  displayName: string
  isFirstVisit: boolean
  totalScans: number
  lastVisitAt: string | null
  isCrmLinked: boolean
  sweedSummary: {
    purchaseCount: number
    lifetimeSpendDollars: number
    averagePurchaseDollars: number | null
    latestPurchaseAt: string | null
    favoriteCategoryName: string | null
    favoriteProductName: string | null
  } | null
}

interface CashierVisitorScanRow {
  id: string | number
  ingested_at: Date
  scanned_at: Date | null
  site_slug: string
  first_name: string | null
  last_name: string | null
  id_num: string | null

  prior_id_num_scan_count: string | number
  prior_id_num_latest_at: Date | null

  link_status: string | null
  link_customer_id: string | number | null
  link_dealer_id: string | number | null

  sweed_purchase_count: string | number | null
  sweed_lifetime_spend: string | number | null
  sweed_latest_purchase_at: Date | null
  sweed_favorite_category_name: string | null
  sweed_favorite_product_name: string | null
}

function redactName(firstName: string | null, lastName: string | null): string {
  const f = firstName === null ? '' : firstName.trim()
  const l = lastName === null ? '' : lastName.trim()
  if (f.length === 0 && l.length === 0) return '—'
  const initial = l.length > 0 ? `${l.charAt(0).toUpperCase()}.` : ''
  if (f.length === 0) return initial
  if (initial.length === 0) return f
  return `${f} ${initial}`
}

function nullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function nullableInt(value: string | number | null | undefined): number {
  const n = nullableNumber(value)
  return n === null ? 0 : Math.trunc(n)
}

function rowToCashierItem(row: CashierVisitorScanRow): CashierVisitorScanItem {
  const priorCount = nullableInt(row.prior_id_num_scan_count)
  const total = priorCount + 1
  const isCrmLinked =
    row.link_status === 'linked' && row.link_customer_id !== null
  const purchaseCount = nullableInt(row.sweed_purchase_count)
  const lifetimeSpend = nullableNumber(row.sweed_lifetime_spend) ?? 0
  const averagePurchase =
    purchaseCount > 0 ? Number((lifetimeSpend / purchaseCount).toFixed(2)) : null

  let sweedSummary: CashierVisitorScanItem['sweedSummary'] = null
  if (isCrmLinked && purchaseCount > 0) {
    sweedSummary = {
      purchaseCount,
      lifetimeSpendDollars: Number(lifetimeSpend.toFixed(2)),
      averagePurchaseDollars: averagePurchase,
      latestPurchaseAt: row.sweed_latest_purchase_at
        ? row.sweed_latest_purchase_at.toISOString()
        : null,
      favoriteCategoryName:
        typeof row.sweed_favorite_category_name === 'string' &&
        row.sweed_favorite_category_name.trim().length > 0
          ? row.sweed_favorite_category_name
          : null,
      favoriteProductName:
        typeof row.sweed_favorite_product_name === 'string' &&
        row.sweed_favorite_product_name.trim().length > 0
          ? row.sweed_favorite_product_name
          : null,
    }
  }

  return {
    id: Number(row.id),
    scannedAt: row.scanned_at ? row.scanned_at.toISOString() : null,
    ingestedAt: row.ingested_at.toISOString(),
    siteSlug: row.site_slug,
    displayName: redactName(row.first_name, row.last_name),
    isFirstVisit: priorCount === 0,
    totalScans: total,
    lastVisitAt: row.prior_id_num_latest_at
      ? row.prior_id_num_latest_at.toISOString()
      : null,
    isCrmLinked,
    sweedSummary,
  }
}

/**
 * Return the latest `limit` visitor_scans rows in the cashier-tablet
 * shape. Bounded set (default 50, max 100). Per-row laterals stay
 * cheap because the limit is small and every join input is indexed.
 */
export async function listCashierVisitorScans(
  db: Queryable,
  args: { limit?: number; siteSlugs?: string[] | null },
): Promise<{ items: CashierVisitorScanItem[]; maxScanId: number | null }> {
  const limit = Math.max(1, Math.min(args.limit ?? 50, 100))
  const params: unknown[] = []
  const conditions: string[] = []

  if (args.siteSlugs && args.siteSlugs.length > 0) {
    params.push(args.siteSlugs)
    conditions.push(`vs.site_slug = any($${params.length})`)
  }
  const whereSql = conditions.length > 0 ? `where ${conditions.join(' and ')}` : ''
  params.push(limit)
  const limitPlaceholder = `$${params.length}`

  const fav = favoriteCategoryProductSubqueriesSql(
    'l.dealer_id',
    'l.sweed_customer_id',
  )
  const sql = `
    select
      vs.id,
      vs.ingested_at,
      vs.scanned_at,
      vs.site_slug,
      vs.first_name,
      vs.last_name,
      vs.id_num,

      coalesce(id_num_ident.prior_count, 0) as prior_id_num_scan_count,
      id_num_ident.latest_prior_at          as prior_id_num_latest_at,

      l.link_status                          as link_status,
      l.sweed_customer_id                    as link_customer_id,
      l.dealer_id                            as link_dealer_id,

      sweed_summary.total_count              as sweed_purchase_count,
      sweed_summary.lifetime_spend           as sweed_lifetime_spend,
      sweed_summary.latest_purchase_at       as sweed_latest_purchase_at,
      ${fav.selectColumns}

    from visitor_scans vs

    left join visitor_scan_links l on l.scan_id = vs.id

    left join lateral (
      select
        count(*)::bigint                                            as prior_count,
        max(coalesce(prior_id.scanned_at, prior_id.ingested_at))    as latest_prior_at
      from visitor_scans prior_id
      where vs.id_num is not null
        and prior_id.provider = vs.provider
        and prior_id.id_num = vs.id_num
        and prior_id.id <> vs.id
        and coalesce(prior_id.scanned_at, prior_id.ingested_at)
              < coalesce(vs.scanned_at, vs.ingested_at)
    ) id_num_ident on true

    left join lateral (
      select
        count(*)::bigint                              as total_count,
        coalesce(sum(so.grand_total_dollars), 0)      as lifetime_spend,
        max(so.pay_time)                              as latest_purchase_at
      from sweed_orders so
      where l.sweed_customer_id is not null
        and so.dealer_id = l.dealer_id
        and so.customer_id = l.sweed_customer_id
    ) sweed_summary on l.sweed_customer_id is not null

    ${fav.ctes}

    ${whereSql}
    order by vs.id desc
    limit ${limitPlaceholder}
  `

  const result = await db.query<CashierVisitorScanRow>(sql, params)
  const items = result.rows.map(rowToCashierItem)
  const maxScanId = items.length > 0 ? items[0].id : null
  return { items, maxScanId }
}
