// Customer-origin-map list query.
//
// FreshlyBakedNYC/automation#33, phase C4 v1.
//
// One row per visitor_scan that has a non-null document address
// lat/lng (those are the customer's home coordinates, persisted on
// the scan row by the ingestion epic — they don't require a
// geocoder pass). The map page is the primary user; the same
// helper is also used by the C5 timeline endpoint that lands in a
// follow-on slice.

import type { Queryable } from '../pool.js'
import { membershipSegmentVisibleSql } from './sweedCustomerSegmentsQueries.js'
import type {
  AgeBand,
  CoordSourceFilter,
  CustomersMapPoint,
  CustomersMapResponse,
  CustomersMapSitePin,
  HomeStateBucket,
  LinkStatus,
  VisitType,
} from '../../../shared/contracts/index.js'

export interface ListCustomersMapPointsFilter {
  siteSlugs: readonly string[] | null
  checkedInAfter: string | null
  checkedInBefore: string | null
  visitType: VisitType | null
  ageBand: AgeBand | null
  homeState: HomeStateBucket | null
  postalPrefix: string | null
  linkStatus: readonly LinkStatus[] | null
  coordSource: CoordSourceFilter | null
  // Marketing-segment lens: selected segment ids + what selection does.
  // Empty/null ids = lens off. Mode defaults to 'highlight'.
  marketingSegmentIds: readonly number[] | null
  marketingSegmentMode: 'highlight' | 'filter' | null
  maxPoints: number
}

// Age-band bounds in years, inclusive low / exclusive high.
// `unknown` is handled separately as `birth_date IS NULL`.
const AGE_BAND_BOUNDS: Readonly<Record<Exclude<AgeBand, 'unknown'>, [number, number]>> = {
  '21-24': [21, 25],
  '25-34': [25, 35],
  '35-44': [35, 45],
  '45-54': [45, 55],
  '55-plus': [55, 200],
}

// Static site-pin coordinates for our two retail locations. Kept
// here (rather than a DB lookup) because the map page wants them
// up-front and they don't change.
//
// Source of truth for Bronx is the Census-geocoded address that
// landed in migration 027_litalerts_retailer_geo.sql for
// '2375 Arthur Ave, The Bronx, NY 10458': (40.855074, -73.888066).
// The previous value (40.86494, -73.88488) was an early Google-
// Maps eyeball that landed ~1.1 km too far north and rendered
// the playback Bronx pin in the wrong neighborhood — operator
// 2026-06-03 fix.
//
// Midtown is the published address for the Sweed dealer 210705
// kiosk at 40 W 55th St; Sweed/VeriScan do supply per-scan
// kiosk lat/lng for midtown so the only consumer of the
// midtown pin is the cross-store map page.
//
// EXPORTED: other modules (visitor-scan webhook handler, per-
// scan details map) MUST import this constant instead of
// hard-coding their own coords — keep one source of truth.
export const SITE_PINS: readonly CustomersMapSitePin[] = [
  { siteSlug: 'bx', label: 'Bronx',   lat: 40.855074, lng: -73.888066 },
  { siteSlug: 'mh', label: 'Midtown', lat: 40.762160, lng: -73.976241 },
] as const

/** Indexed lookup helper for callers that key by site_slug. */
export const SITE_PIN_BY_SLUG: Readonly<Record<string, CustomersMapSitePin>> =
  Object.fromEntries(SITE_PINS.map((p) => [p.siteSlug, p]))

interface PointRow {
  scan_id: string | number
  site_slug: string
  checked_in_at: Date
  lat: string | number
  lng: string | number
  coord_source: 'document' | 'scan'
  first_name: string | null
  middle_name: string | null
  last_name: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  // Encoding-axis enrichment columns (see contract).
  visit_type: 'first' | 'returning' | 'unknown'
  age_years: string | number | null
  gender: string | null
  lifetime_visit_count: string | number
  lifetime_spend_dollars: string | number | null
  lifetime_order_count: string | number | null
  // Selected segment ids this point's customer matches; [] when the
  // lens is off or no match.
  segment_match_ids: string[] | null
}

function toIso(value: Date | null): string {
  if (value === null) return ''
  return value instanceof Date ? value.toISOString() : String(value)
}

function toNum(value: string | number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : NaN
}

function formatName(row: PointRow): string | null {
  const parts = [row.first_name, row.middle_name, row.last_name].filter(
    (p): p is string => p !== null && p.length > 0,
  )
  return parts.length === 0 ? null : parts.join(' ')
}

export async function listCustomersMapPoints(
  db: Queryable,
  filter: ListCustomersMapPointsFilter,
): Promise<CustomersMapResponse> {
  const conditions: string[] = []
  const params: unknown[] = []
  function add(sql: (placeholder: string) => string, value: unknown): void {
    params.push(value)
    conditions.push(sql(`$${params.length}`))
  }

  // Hard floor — we ONLY render scans whose document address has
  // been successfully geocoded via the shared `addresses` /
  // Census-geocoder pipeline. Per operator direction we deliberately
  // do NOT fall back to `visitor_scans.scan_latitude / scan_longitude`
  // (which is the SCANNER kiosk location) — falling back would
  // mass-pile dots on top of each store, which is misleading. Scans
  // without a usable home geocode are counted separately as
  // `unknownCount` and surfaced in the UI as a "Unknown: N" badge.
  //
  // `coordSource` is kept as a filter for backward compatibility:
  //   `document` / absent / `all` → home-geocoded points only
  //   `scan`                      → no rows (we no longer plot kiosks)
  if (filter.coordSource === 'scan') {
    // Plot nothing — explicit kiosk-only mode is now a no-op.
    conditions.push('false')
  } else {
    conditions.push('(addr.latitude is not null and addr.longitude is not null)')
  }

  if (filter.siteSlugs !== null && filter.siteSlugs.length > 0) {
    add((p) => `vs.site_slug = any(${p})`, filter.siteSlugs)
  }
  if (filter.checkedInAfter !== null) {
    add(
      (p) => `coalesce(vs.scanned_at, vs.ingested_at) >= ${p}`,
      filter.checkedInAfter,
    )
  }
  if (filter.checkedInBefore !== null) {
    add(
      (p) => `coalesce(vs.scanned_at, vs.ingested_at) < ${p}`,
      filter.checkedInBefore,
    )
  }

  // Home-state bucket.
  //   NY/NJ/CT → exact match on upper(trim(state))
  //   other    → non-null state not in (NY, NJ, CT)
  //   missing  → state is null OR blank
  if (filter.homeState === 'NY' || filter.homeState === 'NJ' || filter.homeState === 'CT') {
    add(
      (p) => `upper(nullif(trim(vs.state), '')) = ${p}`,
      filter.homeState,
    )
  } else if (filter.homeState === 'other') {
    conditions.push(
      "upper(nullif(trim(vs.state), '')) is not null" +
        " and upper(nullif(trim(vs.state), '')) not in ('NY', 'NJ', 'CT')",
    )
  } else if (filter.homeState === 'missing') {
    conditions.push("nullif(trim(coalesce(vs.state, '')), '') is null")
  }

  // ZIP prefix — match against postal_code as a string prefix. We
  // strip whitespace but otherwise pass digits straight through.
  if (filter.postalPrefix !== null && filter.postalPrefix.length > 0) {
    add(
      (p) => `vs.postal_code like ${p} || '%'`,
      filter.postalPrefix,
    )
  }

  // Age band. `unknown` matches birth_date is null; the numeric
  // bands compare against the age at scan time so a customer's
  // bucket reflects how old they were when they walked in, not
  // their age today. Out-of-bucket years (e.g. <21, which should
  // never appear here in practice) fall out.
  if (filter.ageBand === 'unknown') {
    conditions.push('vs.birth_date is null')
  } else if (filter.ageBand !== null) {
    const [lo, hi] = AGE_BAND_BOUNDS[filter.ageBand]
    params.push(lo)
    const loP = `$${params.length}`
    params.push(hi)
    const hiP = `$${params.length}`
    conditions.push(
      `vs.birth_date is not null` +
        ` and extract(year from age(coalesce(vs.scanned_at, vs.ingested_at), vs.birth_date)) >= ${loP}` +
        ` and extract(year from age(coalesce(vs.scanned_at, vs.ingested_at), vs.birth_date)) < ${hiP}`,
    )
  }

  // Visit type — first/returning is computed against the FULL
  // person_key history on visitor_scans (not just the date window),
  // so a returning visitor whose first appearance is 18 months ago
  // still counts as "returning" inside a 1-day slider window.
  // `unknown` covers rows with no person_key.
  if (filter.visitType === 'unknown') {
    conditions.push('vs.person_key is null')
  } else if (filter.visitType === 'first') {
    conditions.push(
      'vs.person_key is not null and not exists (' +
        'select 1 from visitor_scans prior' +
        ' where prior.provider = vs.provider' +
        ' and prior.person_key = vs.person_key' +
        ' and (coalesce(prior.scanned_at, prior.ingested_at), prior.id)' +
        ' < (coalesce(vs.scanned_at, vs.ingested_at), vs.id)' +
        ')',
    )
  } else if (filter.visitType === 'returning') {
    conditions.push(
      'vs.person_key is not null and exists (' +
        'select 1 from visitor_scans prior' +
        ' where prior.provider = vs.provider' +
        ' and prior.person_key = vs.person_key' +
        ' and (coalesce(prior.scanned_at, prior.ingested_at), prior.id)' +
        ' < (coalesce(vs.scanned_at, vs.ingested_at), vs.id)' +
        ')',
    )
  }

  // CRM-link status filter is the only one that requires a JOIN.
  // We left-join unconditionally only when this filter is set so
  // the base query doesn't pay for the join on every load.
  const needsLinkJoin =
    filter.linkStatus !== null && filter.linkStatus.length > 0
  if (needsLinkJoin) {
    add((p) => `vsl.link_status = any(${p})`, filter.linkStatus)
  }
  const joinSql = needsLinkJoin
    ? 'left join visitor_scan_links vsl on vsl.scan_id = vs.id'
    : ''

  // Marketing-segment lens. In 'filter' mode we restrict the base set
  // to scans whose linked customer is in any selected segment, via an
  // EXISTS (applied BEFORE the limit so totalMatching/clipped stay
  // truthful). In 'highlight' mode we leave the set alone and only
  // annotate matches (see the match lateral below).
  const segmentIds =
    filter.marketingSegmentIds !== null && filter.marketingSegmentIds.length > 0
      ? [...filter.marketingSegmentIds]
      : null
  const segmentMode = filter.marketingSegmentMode ?? 'highlight'
  if (segmentIds !== null && segmentMode === 'filter') {
    add(
      (p) =>
        'exists (select 1 from visitor_scan_links msl' +
        ' join sweed_customer_segments scs on scs.sweed_customer_id = msl.sweed_customer_id' +
        ` where msl.scan_id = vs.id and ${membershipSegmentVisibleSql('scs')} and scs.segment_id = any(${p}::bigint[]))`,
      segmentIds,
    )
  }

  const whereSql = `where ${conditions.join(' and ')}`

  // We over-fetch by one so we can detect the "clipped" case without
  // a second count query for the typical fits-under-budget request.
  // When the over-fetch trips we issue a single count query so the
  // operator sees the true total they'd need to filter down to.
  // Everything pushed so far is a WHERE-clause param; the count query
  // (clipped case) reuses exactly these and nothing after.
  const whereParamCount = params.length

  const fetchLimit = Math.max(1, filter.maxPoints) + 1
  params.push(fetchLimit)
  const limitPlaceholder = `$${params.length}`

  // Param + SQL for the per-point segment-match annotation. Computed
  // for the TRIMMED base set only (a lateral over base), so it costs
  // one indexed lookup per returned point, not per matching scan.
  // Present in both modes when a selection exists.
  let segMatchPlaceholder: string | null = null
  if (segmentIds !== null) {
    params.push(segmentIds)
    segMatchPlaceholder = `$${params.length}`
  }
  const segMatchSelect =
    segMatchPlaceholder !== null ? 'coalesce(seg.match_ids, array[]::text[])' : "array[]::text[]"
  const segMatchJoin =
    segMatchPlaceholder !== null
      ? `left join lateral (
           select array_agg(distinct scs.segment_id::text) as match_ids
             from visitor_scan_links msl
             join sweed_customer_segments scs on scs.sweed_customer_id = msl.sweed_customer_id
            where msl.scan_id = b.scan_id
              and ${membershipSegmentVisibleSql('scs')}
              and scs.segment_id = any(${segMatchPlaceholder}::bigint[])
         ) seg on true`
      : ''

  // Always include the addresses-LEFT-JOIN so the document/scan
  // coalesce works the same regardless of whether the link-status
  // join is also in play. addr.* is NULL for any scan whose
  // address_id is NULL or whose geocode hasn't completed yet.
  //
  // The query is structured as `with base as (... limit) select
  // ... from base left join lateral (...)` so the heavy enrichment
  // joins (lifetime visit-count over visitor_scans, lifetime spend
  // over sweed_orders) only fan out across the trimmed point set,
  // not across every matching scan in the time window.
  //
  // Encoding-axis enrichment (added with the colorBy/sizeBy
  // selectors on the SPA):
  //   * visit_type           — first / returning / unknown
  //   * age_years            — age at scan time (years, integer)
  //   * gender               — raw VeriScan marker (M / F / X / null)
  //   * lifetime_visit_count — total visitor_scans rows in the same
  //                            (provider, person_key) cohort
  //   * lifetime_spend_dollars / lifetime_order_count — from
  //                            sweed_orders, only when the scan is
  //                            CRM-linked
  const pointSql = `
    with base as (
      select
        vs.id                                     as scan_id,
        vs.site_slug,
        coalesce(vs.scanned_at, vs.ingested_at)   as checked_in_at,
        addr.latitude                             as lat,
        addr.longitude                            as lng,
        'document'::text                          as coord_source,
        vs.first_name,
        vs.middle_name,
        vs.last_name,
        vs.city,
        vs.state,
        vs.postal_code,
        vs.provider,
        vs.person_key,
        vs.birth_date,
        vs.gender
      from visitor_scans vs
      left join addresses addr on addr.id = vs.address_id
      ${joinSql}
      ${whereSql}
      order by coalesce(vs.scanned_at, vs.ingested_at) desc, vs.id desc
      limit ${limitPlaceholder}
    )
    select
      b.scan_id,
      b.site_slug,
      b.checked_in_at,
      b.lat,
      b.lng,
      b.coord_source,
      b.first_name,
      b.middle_name,
      b.last_name,
      b.city,
      b.state,
      b.postal_code,

      case
        when b.person_key is null then 'unknown'
        when coalesce(vh.prior_count, 0) = 0 then 'first'
        else 'returning'
      end                                          as visit_type,

      case
        when b.birth_date is null then null
        else extract(year from age(b.checked_in_at, b.birth_date))::int
      end                                          as age_years,

      nullif(trim(b.gender), '')                   as gender,

      case
        when b.person_key is null then 1
        else coalesce(vh.lifetime_visit_count, 1)
      end                                          as lifetime_visit_count,

      -- NULL when no Sweed link; 0 when linked but no mirrored orders.
      case
        when link.sweed_customer_id is null then null
        else coalesce(spend.lifetime_spend_dollars, 0)
      end                                          as lifetime_spend_dollars,
      case
        when link.sweed_customer_id is null then null
        else coalesce(spend.lifetime_order_count, 0)
      end                                          as lifetime_order_count,

      ${segMatchSelect}                            as segment_match_ids

    from base b

    -- Lifetime visits + prior-count for visit_type, scoped to
    -- (provider, person_key). The single LATERAL computes both
    -- counters with one index scan; visitor_scans_person_key_time_idx
    -- (provider, person_key, coalesce(...) desc) covers it.
    left join lateral (
      select
        count(*)::bigint                                          as lifetime_visit_count,
        count(*) filter (
          where (coalesce(hist.scanned_at, hist.ingested_at), hist.id)
              < (b.checked_in_at, b.scan_id)
        )::bigint                                                 as prior_count
      from visitor_scans hist
      where b.person_key is not null
        and hist.provider = b.provider
        and hist.person_key = b.person_key
    ) vh on true

    left join visitor_scan_links link on link.scan_id = b.scan_id

    -- Lifetime spend over sweed_orders, only fired when the scan has
    -- a Sweed CRM link. Uses sweed_orders_customer_pay_time_idx.
    left join lateral (
      select
        count(*)::bigint                                          as lifetime_order_count,
        coalesce(sum(so.grand_total_dollars), 0)::numeric         as lifetime_spend_dollars
      from sweed_orders so
      where link.sweed_customer_id is not null
        and so.dealer_id   = link.dealer_id
        and so.customer_id = link.sweed_customer_id
    ) spend on true

    ${segMatchJoin}

    order by b.checked_in_at desc, b.scan_id desc
  `

  const result = await db.query<PointRow>(pointSql, params)
  const rows = result.rows
  const clipped = rows.length > filter.maxPoints
  const trimmed = clipped ? rows.slice(0, filter.maxPoints) : rows

  const points: CustomersMapPoint[] = trimmed
    .map<CustomersMapPoint | null>((row) => {
      const lat = toNum(row.lat)
      const lng = toNum(row.lng)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
      const scanId = Number(row.scan_id)
      const ageYears =
        row.age_years === null
          ? null
          : Number.isFinite(toNum(row.age_years))
            ? Math.trunc(toNum(row.age_years))
            : null
      const lifetimeVisitCount = Math.max(
        1,
        Number.isFinite(toNum(row.lifetime_visit_count))
          ? Math.trunc(toNum(row.lifetime_visit_count))
          : 1,
      )
      const lifetimeSpendDollars =
        row.lifetime_spend_dollars === null
          ? null
          : Number.isFinite(toNum(row.lifetime_spend_dollars))
            ? toNum(row.lifetime_spend_dollars)
            : null
      const lifetimeOrderCount =
        row.lifetime_order_count === null
          ? null
          : Number.isFinite(toNum(row.lifetime_order_count))
            ? Math.trunc(toNum(row.lifetime_order_count))
            : null
      return {
        scanId,
        siteSlug: row.site_slug,
        checkedInAt: toIso(row.checked_in_at),
        lat,
        lng,
        coordSource: row.coord_source,
        displayName: formatName(row),
        city: row.city,
        state: row.state,
        postalCode: row.postal_code,
        customerUrl: `/admin/customers/visitors/${scanId}`,
        visitType: row.visit_type,
        ageYears,
        gender: row.gender,
        lifetimeVisitCount,
        lifetimeSpendDollars,
        lifetimeOrderCount,
        marketingSegmentMatchIds: Array.isArray(row.segment_match_ids)
          ? row.segment_match_ids
          : [],
      }
    })
    .filter((p): p is CustomersMapPoint => p !== null)

  // Total matching: only when clipped do we actually run the count;
  // the unclipped case is just `points.length`.
  let totalMatching = points.length
  if (clipped) {
    // Reuse the same WHERE clause with EXACTLY its params (everything
    // before the limit + segment-match params, which the count query
    // doesn't reference).
    const countParams = params.slice(0, whereParamCount)
    const countSql = `select count(*)::bigint as n from visitor_scans vs left join addresses addr on addr.id = vs.address_id ${joinSql} ${whereSql}`
    const countResult = await db.query<{ n: string | number }>(countSql, countParams)
    const n = countResult.rows[0]?.n
    totalMatching = typeof n === 'number' ? n : Number(n ?? 0)
  }

  // Unknown count = scans matching the same time-range / dimensional
  // filters (site, age, home state, ZIP, visit type, link status,
  // checkedInAfter/Before) but that have NO usable home geocode —
  // i.e. addr.latitude / addr.longitude is null. Surfaced in the
  // map UI as a small "Unknown: N" badge rather than plotted at the
  // store as a misleading fallback.
  //
  // We re-build a fresh params/conditions list because the geocode
  // floor in the main query is inverted here.
  const unknownCount = await countUnknown(db, filter)

  // Highwater mark — see CustomersMapResponseSchema.maxScanId.
  // Single MAX(id) against the visitor_scans primary key: Postgres
  // walks the right edge of the pkey b-tree and returns in
  // O(log n). Adds < 1ms to the page fetch; in exchange the SPA
  // gets a snapshot it can compare against future cheap polls
  // of /api/admin/customers/map/highwater instead of re-running
  // the full filtered query on a wall-clock timer.
  const maxScanId = await getVisitorScansMaxId(db)

  return {
    points,
    sitePins: [...SITE_PINS],
    totalMatching,
    unknownCount,
    clipped,
    maxScanId,
  }
}

/**
 * MAX(visitor_scans.id) across all rows. Drives the live-update
 * polling on the customer-origin map page. Cheap: indexed pkey
 * MAX, sub-millisecond on any realistic visitor_scans size.
 *
 * Exposed at module scope so the /highwater endpoint can call it
 * without paying for the full listCustomersMapPoints query.
 */
export async function getVisitorScansMaxId(db: Queryable): Promise<number | null> {
  const result = await db.query<{ max_id: string | number | null }>(
    `select max(id) as max_id from visitor_scans`,
  )
  const v = result.rows[0]?.max_id ?? null
  if (v === null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Earliest scan timestamp anywhere in `visitor_scans`. Drives the
 * SPA's replay slider so it can span all of history, not just a
 * hard-coded rolling 30-day window. Returns null if there are no
 * scans yet.
 */
export async function getEarliestScanTimestamp(
  db: Queryable,
): Promise<string | null> {
  const result = await db.query<{ earliest: Date | null }>(
    `select min(coalesce(scanned_at, ingested_at)) as earliest from visitor_scans`,
  )
  const v = result.rows[0]?.earliest ?? null
  if (v === null) return null
  return v instanceof Date ? v.toISOString() : String(v)
}

async function countUnknown(
  db: Queryable,
  filter: ListCustomersMapPointsFilter,
): Promise<number> {
  // Mirror every WHERE clause from listCustomersMapPoints EXCEPT
  // the geocode-present floor — here we want the count of scans
  // that the user is implicitly asking about (same filters) but
  // which the map can't render because no home geocode exists yet.
  //
  // Kiosk-only mode (coordSource === 'scan') returns 0 — there's no
  // notion of "unknown" in that mode since the page renders nothing.
  if (filter.coordSource === 'scan') return 0

  const conditions: string[] = []
  const params: unknown[] = []
  function add(sql: (placeholder: string) => string, value: unknown): void {
    params.push(value)
    conditions.push(sql(`$${params.length}`))
  }

  conditions.push('(addr.latitude is null or addr.longitude is null)')

  if (filter.siteSlugs !== null && filter.siteSlugs.length > 0) {
    add((p) => `vs.site_slug = any(${p})`, filter.siteSlugs)
  }
  if (filter.checkedInAfter !== null) {
    add(
      (p) => `coalesce(vs.scanned_at, vs.ingested_at) >= ${p}`,
      filter.checkedInAfter,
    )
  }
  if (filter.checkedInBefore !== null) {
    add(
      (p) => `coalesce(vs.scanned_at, vs.ingested_at) < ${p}`,
      filter.checkedInBefore,
    )
  }
  if (filter.homeState === 'NY' || filter.homeState === 'NJ' || filter.homeState === 'CT') {
    add((p) => `upper(nullif(trim(vs.state), '')) = ${p}`, filter.homeState)
  } else if (filter.homeState === 'other') {
    conditions.push(
      "upper(nullif(trim(vs.state), '')) is not null" +
        " and upper(nullif(trim(vs.state), '')) not in ('NY', 'NJ', 'CT')",
    )
  } else if (filter.homeState === 'missing') {
    conditions.push("nullif(trim(coalesce(vs.state, '')), '') is null")
  }
  if (filter.postalPrefix !== null && filter.postalPrefix.length > 0) {
    add((p) => `vs.postal_code like ${p} || '%'`, filter.postalPrefix)
  }
  if (filter.ageBand === 'unknown') {
    conditions.push('vs.birth_date is null')
  } else if (filter.ageBand !== null) {
    const [lo, hi] = AGE_BAND_BOUNDS[filter.ageBand]
    params.push(lo)
    const loP = `$${params.length}`
    params.push(hi)
    const hiP = `$${params.length}`
    conditions.push(
      `vs.birth_date is not null` +
        ` and extract(year from age(coalesce(vs.scanned_at, vs.ingested_at), vs.birth_date)) >= ${loP}` +
        ` and extract(year from age(coalesce(vs.scanned_at, vs.ingested_at), vs.birth_date)) < ${hiP}`,
    )
  }
  if (filter.visitType === 'unknown') {
    conditions.push('vs.person_key is null')
  } else if (filter.visitType === 'first') {
    conditions.push(
      'vs.person_key is not null and not exists (' +
        'select 1 from visitor_scans prior' +
        ' where prior.provider = vs.provider' +
        ' and prior.person_key = vs.person_key' +
        ' and (coalesce(prior.scanned_at, prior.ingested_at), prior.id)' +
        ' < (coalesce(vs.scanned_at, vs.ingested_at), vs.id)' +
        ')',
    )
  } else if (filter.visitType === 'returning') {
    conditions.push(
      'vs.person_key is not null and exists (' +
        'select 1 from visitor_scans prior' +
        ' where prior.provider = vs.provider' +
        ' and prior.person_key = vs.person_key' +
        ' and (coalesce(prior.scanned_at, prior.ingested_at), prior.id)' +
        ' < (coalesce(vs.scanned_at, vs.ingested_at), vs.id)' +
        ')',
    )
  }
  const needsLinkJoin =
    filter.linkStatus !== null && filter.linkStatus.length > 0
  if (needsLinkJoin) {
    add((p) => `vsl.link_status = any(${p})`, filter.linkStatus)
  }
  // Mirror the main query's segment FILTER so "Unknown: N" reflects the
  // same population in filter mode (highlight mode leaves the set whole).
  const segIds =
    filter.marketingSegmentIds !== null && filter.marketingSegmentIds.length > 0
      ? [...filter.marketingSegmentIds]
      : null
  if (segIds !== null && (filter.marketingSegmentMode ?? 'highlight') === 'filter') {
    add(
      (p) =>
        'exists (select 1 from visitor_scan_links msl' +
        ' join sweed_customer_segments scs on scs.sweed_customer_id = msl.sweed_customer_id' +
        ` where msl.scan_id = vs.id and ${membershipSegmentVisibleSql('scs')} and scs.segment_id = any(${p}::bigint[]))`,
      segIds,
    )
  }
  const joinSql = needsLinkJoin
    ? 'left join visitor_scan_links vsl on vsl.scan_id = vs.id'
    : ''
  const whereSql = `where ${conditions.join(' and ')}`
  const sql = `select count(*)::bigint as n from visitor_scans vs left join addresses addr on addr.id = vs.address_id ${joinSql} ${whereSql}`
  const result = await db.query<{ n: string | number }>(sql, params)
  const n = result.rows[0]?.n
  return typeof n === 'number' ? n : Number(n ?? 0)
}
