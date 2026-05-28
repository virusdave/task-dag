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
import type {
  CustomersMapPoint,
  CustomersMapResponse,
  CustomersMapSitePin,
} from '../../../shared/contracts/index.js'

export interface ListCustomersMapPointsFilter {
  siteSlugs: readonly string[] | null
  checkedInAfter: string | null
  checkedInBefore: string | null
  maxPoints: number
}

// Static site-pin coordinates for our two retail locations. Kept
// here (rather than a DB lookup) because the map page wants them
// up-front and they don't change. Source: Google Maps lookup of
// the published shop addresses.
const SITE_PINS: readonly CustomersMapSitePin[] = [
  { siteSlug: 'bx', label: 'Bronx',   lat: 40.86494, lng: -73.88488 },
  { siteSlug: 'mh', label: 'Midtown', lat: 40.76232, lng: -73.97661 },
] as const

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

  // Hard floor — we only render points that have *some* usable
  // coordinate. We prefer the customer's document-address coords
  // (where they live), but fall back to the kiosk scan coords
  // (where they scanned) so a thin stream of doc-coord-less rows
  // still produces visible dots. `coord_source` flags which path
  // each row used.
  conditions.push(
    '((vs.latitude is not null and vs.longitude is not null)' +
      ' or (vs.scan_latitude is not null and vs.scan_longitude is not null))',
  )

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

  const whereSql = `where ${conditions.join(' and ')}`

  // We over-fetch by one so we can detect the "clipped" case without
  // a second count query for the typical fits-under-budget request.
  // When the over-fetch trips we issue a single count query so the
  // operator sees the true total they'd need to filter down to.
  const fetchLimit = Math.max(1, filter.maxPoints) + 1
  params.push(fetchLimit)
  const limitPlaceholder = `$${params.length}`

  const pointSql = `
    select
      vs.id                                    as scan_id,
      vs.site_slug,
      coalesce(vs.scanned_at, vs.ingested_at)  as checked_in_at,
      coalesce(vs.latitude, vs.scan_latitude)  as lat,
      coalesce(vs.longitude, vs.scan_longitude) as lng,
      case
        when vs.latitude is not null and vs.longitude is not null then 'document'
        else 'scan'
      end                                      as coord_source,
      vs.first_name,
      vs.middle_name,
      vs.last_name,
      vs.city,
      vs.state,
      vs.postal_code
    from visitor_scans vs
    ${whereSql}
    order by coalesce(vs.scanned_at, vs.ingested_at) desc, vs.id desc
    limit ${limitPlaceholder}
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
      }
    })
    .filter((p): p is CustomersMapPoint => p !== null)

  // Total matching: only when clipped do we actually run the count;
  // the unclipped case is just `points.length`.
  let totalMatching = points.length
  if (clipped) {
    // Reuse the same WHERE clause but drop the LIMIT param (the last
    // one we pushed). pg ignores extras only when placeholders match,
    // so re-build the params array without it.
    const countParams = params.slice(0, params.length - 1)
    const countSql = `select count(*)::bigint as n from visitor_scans vs ${whereSql}`
    const countResult = await db.query<{ n: string | number }>(countSql, countParams)
    const n = countResult.rows[0]?.n
    totalMatching = typeof n === 'number' ? n : Number(n ?? 0)
  }

  return {
    points,
    sitePins: [...SITE_PINS],
    totalMatching,
    clipped,
  }
}
