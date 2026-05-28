// Backend for the `/admin/customers/visitors/:scanId` details page.
//
// Loads a single visitor_scans row plus everything an operator needs
// to triage that customer:
//
//   - the full scan row (including PII fields the table-row item
//     doesn't carry);
//   - the Sweed CRM link state (visitor_scan_links) and a "best"
//     candidate row for display fields (name / phone / email);
//   - every other visitor_scans row matching this person by exact
//     id_num and/or person_key, each carrying its same-business-day
//     (America/New_York) sweed_orders rollup when the anchor is
//     linked to a Sweed customer;
//   - the full sweed_orders invoice header history for the linked
//     Sweed customer (capped at INVOICE_LIMIT + 1 so the page can
//     show a "truncated" warning);
//   - geocoded map points: the document address, the scan device
//     location, the linked Sweed customer's primary address(es),
//     and any seen-delivery destinations.
//
// All work runs in a single transactional read (`begin read only`)
// so the per-tab refetch sees a consistent snapshot.
//
// Line items: sweed_orders intentionally does NOT mirror invoice
// line items (see helios/src/server/db/schema/sweedOrders.sql), so
// the response's `limitations.lineItemsAvailable` is the literal
// `false` and the page surfaces a plain-language note. Wiring up
// full-item history requires net-new Sweed RPC ingest infra.

import type {
  CustomerVisitorAnchorScan,
  CustomerVisitorDetailsResponse,
  CustomerVisitorLinkedCustomer,
  CustomerVisitorMapPoint,
  CustomerVisitorPriorVisit,
  CustomerVisitorPurchaseInvoice,
  CustomerVisitorAddress,
  CustomerVisitorVisitPurchaseSummary,
  VisitorScanIdentity,
  VisitorScanLinkStatus,
  VisitorScanSweedPurchaseSummary,
} from '../../../shared/contracts/index.js'

import type { Queryable } from '../pool.js'

// Soft cap on purchase history. Anyone above this is rare enough we
// can return a truncated flag instead of blowing up the response.
const INVOICE_LIMIT = 500

const KNOWN_LINK_STATUSES: readonly VisitorScanLinkStatus[] = [
  'pending',
  'ambiguous',
  'linked',
  'no_match',
  'failed',
  'rejected',
  'insufficient_data',
]

const LINE_ITEMS_NOTE =
  'Helios mirrors Sweed invoice headers only — line items are not ' +
  'ingested into sweed_orders today (see ' +
  'helios/src/server/db/schema/sweedOrders.sql). Full per-item ' +
  'purchase history requires net-new Sweed RPC ingest infrastructure.'

// ---------------------------------------------------------------------
// Row shapes coming back from each SQL block.
// ---------------------------------------------------------------------

interface AnchorRow {
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
  country_code: string | null
  jurisdiction_code: string | null
  document_type: string | null
  authentication_status: string | null
  scan_status: string | null
  latitude: string | number | null
  longitude: string | number | null
  scan_latitude: string | number | null
  scan_longitude: string | number | null
  raw_envelope: unknown
  person_key: string | null
  id_num: string | null
  birth_date: Date | null
  exp_date: Date | null
  gender: string | null
  phone: string | null
  email: string | null
  document_is_valid: boolean | null
  device_id: string | number | null
  device_name: string | null
  device_login: string | null
  location_id: string | number | null
  location_name: string | null
  comments: string | null
  profile_comments: string | null
  tags: string | null
  user_agent: string | null
  image_link: string | null
  signature_link: string | null

  // Identity counters (other scans for the same person, anywhere
  // in time).
  prior_id_num_scan_count: string | number | null
  prior_local_scan_count: string | number | null
  first_local_scan_at: Date | null
  latest_local_scan_at: Date | null

  // visitor_scan_links join.
  link_dealer_id: string | number | null
  link_customer_id: string | number | null
  link_status: string | null
  link_method: string | null
  link_confidence: string | number | null
  link_linked_at: Date | null
  link_raw_match: unknown

  // Best candidate display fields (when present).
  cand_display_name: string | null
  cand_display_address: string | null
  cand_display_phone: string | null
  cand_display_email: string | null
}

interface PriorVisitRow {
  id: string | number
  site_slug: string
  ingest_source: string
  scanned_at: Date | null
  ingested_at: Date
  visit_at: Date
  match_kind: 'id_num' | 'person_key' | 'both'
  address: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  document_type: string | null
  scan_status: string | null
  authentication_status: string | null
  latitude: string | number | null
  longitude: string | number | null
  scan_latitude: string | number | null
  scan_longitude: string | number | null
  // Same-day purchase rollup (NULL when not linked).
  order_count: string | number | null
  grand_total_dollars: string | number | null
  first_pay_time: Date | null
  latest_pay_time: Date | null
}

interface InvoiceRow {
  dealer_id: string | number
  invoice_id: string
  pay_time: Date
  grand_total_dollars: string | number
  subtotal_dollars: string | number | null
  tax_dollars: string | number | null
  discount_dollars: string | number | null
  fulfillment_type: string | null
  payment_method: string | null
  delivery_zip: string | null
  delivery_address_id: string | number | null
  delivery_raw_line1: string | null
  delivery_raw_line2: string | null
  delivery_raw_city: string | null
  delivery_raw_state: string | null
  delivery_raw_zip: string | null
  delivery_normalized: string | null
  delivery_latitude: number | null
  delivery_longitude: number | null
  delivery_geocode_status: string | null
}

interface SweedAddressRow {
  kind: string
  first_seen_at: Date
  last_seen_at: Date
  address_id: string | number
  raw_line1: string | null
  raw_line2: string | null
  raw_city: string | null
  raw_state: string | null
  raw_zip: string | null
  normalized: string | null
  latitude: number | null
  longitude: number | null
  geocode_status: string | null
  order_count: string | number | null
  total_spend_dollars: string | number | null
}

// ---------------------------------------------------------------------
// Small helpers (mirrors the ones in visitorScansQueries.ts; kept
// local so this file is self-contained).
// ---------------------------------------------------------------------

function toIsoNullable(value: Date | null): string | null {
  return value === null ? null : value instanceof Date ? value.toISOString() : String(value)
}

function numOrNull(value: string | number | null): number | null {
  if (value === null) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function intOrZero(value: string | number | null): number {
  const n = numOrNull(value)
  return n === null ? 0 : Math.trunc(n)
}

function knownLinkStatus(value: string | null): VisitorScanLinkStatus {
  if (value !== null && (KNOWN_LINK_STATUSES as readonly string[]).includes(value)) {
    return value as VisitorScanLinkStatus
  }
  return 'pending'
}

function dateOnlyNullable(value: Date | null): string | null {
  if (value === null) return null
  if (!(value instanceof Date)) return String(value)
  // YYYY-MM-DD for date columns (birth_date, exp_date). UTC slice
  // is fine because Postgres `date` columns come back as midnight
  // UTC.
  return value.toISOString().slice(0, 10)
}

function makeAddress(row: {
  address_id: string | number | null
  raw_line1: string | null
  raw_line2: string | null
  raw_city: string | null
  raw_state: string | null
  raw_zip: string | null
  normalized: string | null
  latitude: number | null
  longitude: number | null
  geocode_status: string | null
}): CustomerVisitorAddress {
  return {
    addressId: numOrNull(row.address_id),
    line1: row.raw_line1,
    line2: row.raw_line2,
    city: row.raw_city,
    state: row.raw_state,
    zip: row.raw_zip,
    normalized: row.normalized,
    latitude: row.latitude,
    longitude: row.longitude,
    geocodeStatus: row.geocode_status,
  }
}

// ---------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------

/**
 * Returns the full details payload for one visitor_scans row, or
 * `null` when the scan does not exist. Caller maps `null` → 404.
 */
export async function getCustomerVisitorDetails(
  db: Queryable,
  scanId: number,
): Promise<CustomerVisitorDetailsResponse | null> {
  const anchorRow = await loadAnchor(db, scanId)
  if (anchorRow === null) return null

  const linkDealerId = numOrNull(anchorRow.link_dealer_id)
  const linkCustomerId = numOrNull(anchorRow.link_customer_id)
  const linkStatus = knownLinkStatus(anchorRow.link_status)
  const isLinkedToCustomer =
    linkDealerId !== null && linkCustomerId !== null && linkStatus === 'linked'

  // Prior visits (every other scan for the same person), with
  // optional same-day purchase rollup. Pass nulls for the purchase
  // join when we can't resolve a Sweed customer.
  const priorVisitRows = await loadPriorVisits(
    db,
    scanId,
    isLinkedToCustomer ? linkDealerId : null,
    isLinkedToCustomer ? linkCustomerId : null,
  )

  // Invoice history only when actually linked.
  const invoiceRows = isLinkedToCustomer
    ? await loadPurchaseInvoices(db, linkDealerId, linkCustomerId)
    : []

  // Sweed customer addresses only when actually linked.
  const sweedAddressRows = isLinkedToCustomer
    ? await loadSweedCustomerAddresses(db, linkDealerId, linkCustomerId)
    : []

  // ----- assemble -----
  const anchorScan = buildAnchorScan(anchorRow)
  const linkedCustomer = buildLinkedCustomer(
    anchorRow,
    linkDealerId,
    linkCustomerId,
    linkStatus,
  )
  const priorVisits = priorVisitRows.map((row) => buildPriorVisit(row, isLinkedToCustomer))

  const purchaseInvoices = invoiceRows
    .slice(0, INVOICE_LIMIT)
    .map(buildPurchaseInvoice)
  const purchaseInvoicesTruncated = invoiceRows.length > INVOICE_LIMIT

  const purchaseLifetime = buildPurchaseLifetime(
    invoiceRows,
    purchaseInvoicesTruncated,
    anchorScan.scannedAt ?? anchorScan.ingestedAt,
  )

  const mapPoints = buildMapPoints(anchorScan, sweedAddressRows)

  const identity: VisitorScanIdentity = anchorScan.identity

  return {
    anchorScan,
    linkedCustomer,
    priorVisits,
    purchaseInvoices,
    purchaseInvoicesTruncated,
    purchaseLifetime,
    mapPoints,
    identity,
    limitations: {
      lineItemsAvailable: false,
      lineItemsNote: LINE_ITEMS_NOTE,
    },
  }
}

// ---------------------------------------------------------------------
// Query 1: anchor scan + link + best candidate + identity counters.
// ---------------------------------------------------------------------

async function loadAnchor(db: Queryable, scanId: number): Promise<AnchorRow | null> {
  const sql = `
    select
      vs.id, vs.ingested_at, vs.ingest_source, vs.site_slug, vs.provider,
      vs.scanned_at, vs.created_at, vs.webhook_type,
      vs.hash_id,
      vs.first_name, vs.middle_name, vs.last_name,
      vs.state, vs.postal_code, vs.city, vs.address, vs.country,
      vs.country_code, vs.jurisdiction_code,
      vs.document_type, vs.authentication_status, vs.scan_status,
      vs.latitude, vs.longitude, vs.scan_latitude, vs.scan_longitude,
      vs.raw_envelope,
      vs.person_key,
      vs.id_num,
      vs.birth_date, vs.exp_date, vs.gender, vs.phone, vs.email,
      vs.document_is_valid,
      vs.device_id, vs.device_name, vs.device_login,
      vs.location_id, vs.location_name,
      vs.comments, vs.profile_comments, vs.tags, vs.user_agent,
      vs.image_link, vs.signature_link,

      coalesce(ident.prior_count, 0)::bigint        as prior_local_scan_count,
      ident.first_local_scan_at,
      ident.latest_local_scan_at,
      coalesce(id_num_ident.prior_count, 0)::bigint as prior_id_num_scan_count,

      l.dealer_id          as link_dealer_id,
      l.sweed_customer_id  as link_customer_id,
      l.link_status        as link_status,
      l.link_method        as link_method,
      l.confidence         as link_confidence,
      l.linked_at          as link_linked_at,
      l.raw_match          as link_raw_match,

      cand.display_name    as cand_display_name,
      cand.display_address as cand_display_address,
      cand.display_phone   as cand_display_phone,
      cand.display_email   as cand_display_email

    from visitor_scans vs
    left join visitor_scan_links l on l.scan_id = vs.id

    -- Other-rows person-key rollup (lifetime, both directions).
    left join lateral (
      select
        count(*)::bigint                                   as prior_count,
        min(coalesce(prior.scanned_at, prior.ingested_at)) as first_local_scan_at,
        max(coalesce(prior.scanned_at, prior.ingested_at)) as latest_local_scan_at
      from visitor_scans prior
      where vs.person_key is not null
        and prior.provider = vs.provider
        and prior.person_key = vs.person_key
        and prior.id <> vs.id
    ) ident on true

    -- Strict id_num "have we seen this exact ID before?" count.
    left join lateral (
      select count(*)::bigint as prior_count
      from visitor_scans prior_id
      where vs.id_num is not null
        and prior_id.provider = vs.provider
        and prior_id.id_num = vs.id_num
        and prior_id.id <> vs.id
    ) id_num_ident on true

    -- Best candidate row for display copy. Prefer confirmed > highest
    -- score > most recently seen.
    left join lateral (
      select
        c.display_name,
        c.display_address,
        c.display_phone,
        c.display_email
      from visitor_scan_link_candidates c
      where c.scan_id = vs.id
        and (
          l.sweed_customer_id is null
          or c.sweed_customer_id = l.sweed_customer_id
        )
      order by
        case when c.candidate_status = 'confirmed' then 0 else 1 end,
        c.score desc,
        c.last_seen_at desc
      limit 1
    ) cand on true

    where vs.id = $1
  `
  const result = await db.query<AnchorRow>(sql, [scanId])
  return result.rows.length === 0 ? null : result.rows[0]
}

// ---------------------------------------------------------------------
// Query 2: prior visits (other scans, possibly with same-day purchase
// rollups).
// ---------------------------------------------------------------------

async function loadPriorVisits(
  db: Queryable,
  scanId: number,
  dealerId: number | null,
  customerId: number | null,
): Promise<PriorVisitRow[]> {
  // The same-day purchase rollup needs the linked dealer/customer.
  // When we don't have them, we still want the prior-visits list,
  // just with NULL purchase columns. We pass NULL/NULL and the
  // lateral join short-circuits because `so.customer_id = null` is
  // never true.
  const sql = `
    with anchor as (
      select id, provider, id_num, person_key,
             coalesce(scanned_at, ingested_at) as visit_at
      from visitor_scans
      where id = $1
    )
    select
      vs.id,
      vs.site_slug,
      vs.ingest_source,
      vs.scanned_at,
      vs.ingested_at,
      coalesce(vs.scanned_at, vs.ingested_at) as visit_at,
      case
        when anchor.id_num is not null
         and vs.id_num is not null
         and vs.id_num = anchor.id_num
         and anchor.person_key is not null
         and vs.person_key is not null
         and vs.person_key = anchor.person_key
          then 'both'
        when anchor.id_num is not null
         and vs.id_num is not null
         and vs.id_num = anchor.id_num
          then 'id_num'
        else 'person_key'
      end as match_kind,
      vs.address, vs.city, vs.state, vs.postal_code,
      vs.document_type, vs.scan_status, vs.authentication_status,
      vs.latitude, vs.longitude, vs.scan_latitude, vs.scan_longitude,

      purchase_day.order_count,
      purchase_day.grand_total_dollars,
      purchase_day.first_pay_time,
      purchase_day.latest_pay_time

    from anchor
    join visitor_scans vs
      on vs.provider = anchor.provider
     and vs.id <> anchor.id
     and (
       (anchor.id_num is not null and vs.id_num = anchor.id_num)
       or
       (anchor.person_key is not null and vs.person_key = anchor.person_key)
     )

    left join lateral (
      select
        count(*)::int                                       as order_count,
        coalesce(sum(so.grand_total_dollars), 0)::numeric  as grand_total_dollars,
        min(so.pay_time)                                    as first_pay_time,
        max(so.pay_time)                                    as latest_pay_time
      from sweed_orders so
      where so.dealer_id = $2
        and so.customer_id = $3
        and (so.pay_time at time zone 'America/New_York')::date =
            (coalesce(vs.scanned_at, vs.ingested_at) at time zone 'America/New_York')::date
    ) purchase_day on $2 is not null and $3 is not null

    order by coalesce(vs.scanned_at, vs.ingested_at) desc, vs.id desc
    limit 500
  `
  const result = await db.query<PriorVisitRow>(sql, [scanId, dealerId, customerId])
  return result.rows
}

// ---------------------------------------------------------------------
// Query 3: invoice header history (linked customers only).
// ---------------------------------------------------------------------

async function loadPurchaseInvoices(
  db: Queryable,
  dealerId: number,
  customerId: number,
): Promise<InvoiceRow[]> {
  const sql = `
    select
      so.dealer_id,
      so.invoice_id,
      so.pay_time,
      so.grand_total_dollars,
      so.subtotal_dollars,
      so.tax_dollars,
      so.discount_dollars,
      so.fulfillment_type,
      so.payment_method,
      so.delivery_zip,
      so.delivery_address_id,
      a.raw_line1   as delivery_raw_line1,
      a.raw_line2   as delivery_raw_line2,
      a.raw_city    as delivery_raw_city,
      a.raw_state   as delivery_raw_state,
      a.raw_zip     as delivery_raw_zip,
      a.normalized  as delivery_normalized,
      a.latitude    as delivery_latitude,
      a.longitude   as delivery_longitude,
      a.geocode_status as delivery_geocode_status
    from sweed_orders so
    left join addresses a on a.id = so.delivery_address_id
    where so.dealer_id = $1
      and so.customer_id = $2
    order by so.pay_time desc, so.invoice_id desc
    limit ${INVOICE_LIMIT + 1}
  `
  const result = await db.query<InvoiceRow>(sql, [dealerId, customerId])
  return result.rows
}

// ---------------------------------------------------------------------
// Query 4: Sweed customer addresses (primary + seen deliveries).
// ---------------------------------------------------------------------

async function loadSweedCustomerAddresses(
  db: Queryable,
  dealerId: number,
  customerId: number,
): Promise<SweedAddressRow[]> {
  const sql = `
    select
      sca.kind,
      sca.first_seen_at,
      sca.last_seen_at,
      a.id          as address_id,
      a.raw_line1,
      a.raw_line2,
      a.raw_city,
      a.raw_state,
      a.raw_zip,
      a.normalized,
      a.latitude,
      a.longitude,
      a.geocode_status,
      count(so.invoice_id)::int                              as order_count,
      coalesce(sum(so.grand_total_dollars), 0)::numeric      as total_spend_dollars
    from sweed_customer_addresses sca
    join addresses a on a.id = sca.address_id
    left join sweed_orders so
      on so.dealer_id = sca.dealer_id
     and so.customer_id = sca.customer_id
     and so.delivery_address_id = sca.address_id
    where sca.dealer_id = $1
      and sca.customer_id = $2
    group by
      sca.kind,
      sca.first_seen_at,
      sca.last_seen_at,
      a.id,
      a.raw_line1,
      a.raw_line2,
      a.raw_city,
      a.raw_state,
      a.raw_zip,
      a.normalized,
      a.latitude,
      a.longitude,
      a.geocode_status
    order by
      case when sca.kind = 'primary' then 0 else 1 end,
      sca.last_seen_at desc
  `
  const result = await db.query<SweedAddressRow>(sql, [dealerId, customerId])
  return result.rows
}

// ---------------------------------------------------------------------
// Row → contract mappers.
// ---------------------------------------------------------------------

function buildAnchorScan(row: AnchorRow): CustomerVisitorAnchorScan {
  const latitude = numOrNull(row.latitude)
  const longitude = numOrNull(row.longitude)
  const scanLat = numOrNull(row.scan_latitude)
  const scanLng = numOrNull(row.scan_longitude)

  const priorIdNumScanCount = intOrZero(row.prior_id_num_scan_count)
  const priorLocalScanCount = intOrZero(row.prior_local_scan_count)

  const linkDealerId = numOrNull(row.link_dealer_id)
  const linkStatus = knownLinkStatus(row.link_status)
  const sweedLink =
    linkDealerId === null
      ? null
      : {
          dealerId: linkDealerId,
          customerId: numOrNull(row.link_customer_id),
          status: linkStatus,
          method: row.link_method,
          confidence: numOrNull(row.link_confidence),
          linkedAt: toIsoNullable(row.link_linked_at),
          // Anchor row doesn't carry probe schedule (it's not
          // operator-relevant on the details page) but the contract
          // schema requires the fields. Surface explicit nulls.
          lastProbedAt: null,
          nextProbeAt: null,
          candidateCount: 0,
        }

  // The list-view shape uses sweedPurchaseSummary; for the anchor we
  // intentionally leave it null and let the dedicated
  // `purchaseLifetime` (computed from real invoice rows) carry the
  // total. This keeps the anchor scan honest about what its source
  // query returned.
  let miniMarker: { lat: number; lng: number; source: 'document_address' | 'scan_location' } | null = null
  if (latitude !== null && longitude !== null) {
    miniMarker = { lat: latitude, lng: longitude, source: 'document_address' }
  } else if (scanLat !== null && scanLng !== null) {
    miniMarker = { lat: scanLat, lng: scanLng, source: 'scan_location' }
  }

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
    sweedPurchaseSummary: null,
    miniMarker,

    // Extra anchor-only fields.
    idNum: row.id_num,
    birthDate: dateOnlyNullable(row.birth_date),
    expDate: dateOnlyNullable(row.exp_date),
    gender: row.gender,
    phone: row.phone,
    email: row.email,
    countryCode: row.country_code,
    jurisdictionCode: row.jurisdiction_code,
    documentIsValid: row.document_is_valid,
    deviceId: numOrNull(row.device_id),
    deviceName: row.device_name,
    deviceLogin: row.device_login,
    locationId: numOrNull(row.location_id),
    locationName: row.location_name,
    comments: row.comments,
    profileComments: row.profile_comments,
    tags: row.tags,
    userAgent: row.user_agent,
    imageLink: row.image_link,
    signatureLink: row.signature_link,
  }
}

function buildLinkedCustomer(
  row: AnchorRow,
  dealerId: number | null,
  customerId: number | null,
  status: VisitorScanLinkStatus,
): CustomerVisitorLinkedCustomer | null {
  if (dealerId === null) return null
  return {
    dealerId,
    customerId,
    status,
    method: row.link_method,
    confidence: numOrNull(row.link_confidence),
    linkedAt: toIsoNullable(row.link_linked_at),
    displayName: row.cand_display_name,
    displayAddress: row.cand_display_address,
    displayPhone: row.cand_display_phone,
    displayEmail: row.cand_display_email,
    rawMatch: row.link_raw_match ?? null,
  }
}

function buildPriorVisit(
  row: PriorVisitRow,
  isLinkedToCustomer: boolean,
): CustomerVisitorPriorVisit {
  let purchaseSummary: CustomerVisitorVisitPurchaseSummary | null = null
  if (isLinkedToCustomer) {
    const orderCount = intOrZero(row.order_count)
    if (orderCount > 0) {
      purchaseSummary = {
        orderCount,
        grandTotalDollars: numOrNull(row.grand_total_dollars) ?? 0,
        firstPayTime: toIsoNullable(row.first_pay_time),
        latestPayTime: toIsoNullable(row.latest_pay_time),
      }
    }
  }
  return {
    id: Number(row.id),
    customerUrl: `/admin/customers/visitors/${Number(row.id)}`,
    siteSlug: row.site_slug,
    ingestSource: row.ingest_source,
    scannedAt: toIsoNullable(row.scanned_at),
    ingestedAt: toIsoNullable(row.ingested_at) ?? '',
    visitAt: toIsoNullable(row.visit_at) ?? '',
    matchKind: row.match_kind,
    address: row.address,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    documentType: row.document_type,
    scanStatus: row.scan_status,
    authenticationStatus: row.authentication_status,
    latitude: numOrNull(row.latitude),
    longitude: numOrNull(row.longitude),
    scanLatitude: numOrNull(row.scan_latitude),
    scanLongitude: numOrNull(row.scan_longitude),
    purchaseSummary,
  }
}

function buildPurchaseInvoice(row: InvoiceRow): CustomerVisitorPurchaseInvoice {
  const hasAddress =
    row.delivery_address_id !== null ||
    row.delivery_raw_line1 !== null ||
    row.delivery_normalized !== null
  const deliveryAddress: CustomerVisitorAddress | null = hasAddress
    ? makeAddress({
        address_id: row.delivery_address_id,
        raw_line1: row.delivery_raw_line1,
        raw_line2: row.delivery_raw_line2,
        raw_city: row.delivery_raw_city,
        raw_state: row.delivery_raw_state,
        raw_zip: row.delivery_raw_zip,
        normalized: row.delivery_normalized,
        latitude: row.delivery_latitude,
        longitude: row.delivery_longitude,
        geocode_status: row.delivery_geocode_status,
      })
    : null
  return {
    dealerId: Number(row.dealer_id),
    invoiceId: row.invoice_id,
    payTime: toIsoNullable(row.pay_time) ?? '',
    grandTotalDollars: numOrNull(row.grand_total_dollars) ?? 0,
    subtotalDollars: numOrNull(row.subtotal_dollars),
    taxDollars: numOrNull(row.tax_dollars),
    discountDollars: numOrNull(row.discount_dollars),
    fulfillmentType: row.fulfillment_type,
    paymentMethod: row.payment_method,
    deliveryZip: row.delivery_zip,
    deliveryAddress,
  }
}

function buildPurchaseLifetime(
  invoices: InvoiceRow[],
  truncated: boolean,
  anchorVisitAt: string,
): VisitorScanSweedPurchaseSummary | null {
  if (invoices.length === 0) return null
  // Because we cap at INVOICE_LIMIT+1, the truncated case undercounts
  // total purchases / lifetime spend slightly. Flag this honestly via
  // the response's `purchaseInvoicesTruncated` so the UI can show
  // "≥" instead of "=" in that rare case.
  const anchor = new Date(anchorVisitAt).getTime()
  let prior = 0
  let lifetime = 0
  let first: Date | null = null
  let firstTotal: number | null = null
  let latest: Date | null = null
  for (const row of invoices) {
    const payTime = row.pay_time
    const dollars = numOrNull(row.grand_total_dollars) ?? 0
    lifetime += dollars
    if (Number.isFinite(anchor) && payTime.getTime() < anchor) {
      prior += 1
    }
    if (first === null || payTime < first) {
      first = payTime
      firstTotal = dollars
    }
    if (latest === null || payTime > latest) {
      latest = payTime
    }
  }
  return {
    priorPurchaseCount: prior,
    totalPurchaseCount: truncated ? invoices.length - 1 : invoices.length,
    firstPurchaseAt: toIsoNullable(first),
    firstPurchaseTotalDollars: firstTotal,
    latestPurchaseAt: toIsoNullable(latest),
    lifetimeSpendDollars: lifetime,
    hasPriorPurchaseBeforeScan: prior > 0,
  }
}

function buildMapPoints(
  anchor: CustomerVisitorAnchorScan,
  sweedAddresses: SweedAddressRow[],
): CustomerVisitorMapPoint[] {
  const points: CustomerVisitorMapPoint[] = []

  // 1. Anchor document address.
  if (anchor.latitude !== null && anchor.longitude !== null) {
    points.push({
      id: 'document_address',
      kind: 'document_address',
      label: anchor.address ?? 'Document address',
      lat: anchor.latitude,
      lng: anchor.longitude,
      address: {
        addressId: null,
        line1: anchor.address,
        line2: null,
        city: anchor.city,
        state: anchor.state,
        zip: anchor.postalCode,
        normalized: null,
        latitude: anchor.latitude,
        longitude: anchor.longitude,
        geocodeStatus: null,
      },
      firstSeenAt: null,
      lastSeenAt: null,
      orderCount: null,
      totalSpendDollars: null,
    })
  }

  // 2. Anchor scan location.
  if (anchor.scanLatitude !== null && anchor.scanLongitude !== null) {
    points.push({
      id: 'scan_location',
      kind: 'scan_location',
      label: anchor.locationName ?? anchor.deviceName ?? 'Scan device',
      lat: anchor.scanLatitude,
      lng: anchor.scanLongitude,
      address: null,
      firstSeenAt: anchor.scannedAt,
      lastSeenAt: anchor.scannedAt,
      orderCount: null,
      totalSpendDollars: null,
    })
  }

  // 3. Sweed customer addresses (primary + seen deliveries).
  for (const row of sweedAddresses) {
    if (row.latitude === null || row.longitude === null) continue
    const isPrimary = row.kind === 'primary'
    points.push({
      id: `sweed_${row.kind}_${row.address_id}`,
      kind: isPrimary ? 'sweed_primary_address' : 'sweed_delivery_destination',
      label:
        row.raw_line1 ??
        row.normalized ??
        (isPrimary ? 'Sweed primary address' : 'Sweed delivery destination'),
      lat: Number(row.latitude),
      lng: Number(row.longitude),
      address: makeAddress(row),
      firstSeenAt: toIsoNullable(row.first_seen_at),
      lastSeenAt: toIsoNullable(row.last_seen_at),
      orderCount: intOrZero(row.order_count),
      totalSpendDollars: numOrNull(row.total_spend_dollars),
    })
  }

  return points
}
