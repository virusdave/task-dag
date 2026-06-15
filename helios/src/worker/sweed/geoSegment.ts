// Geographic (scan-location-based) marketing-segment selection.
//
// Shared by:
//   * the one-shot backfill CLI
//     (helios/scripts/backfill-geo-segment-bronx.ts), and
//   * the (follow-on) on-scan rule engine that evaluates
//     `geo_segment_rules` after a scan links to a Sweed customer.
//
// The headline use case: "add first-time-scan or first-time-purchase
// customers whose GEOCODED ID HOME ADDRESS sits within R feet of a
// store, where the qualifying event happened on/after a cutoff date".
//
// Distance is measured against the geocoded document-address
// (`addresses.latitude/longitude`, linked via `visitor_scans.address_id`)
// — NOT `visitor_scans.latitude/longitude`, which empirically holds the
// scanner-kiosk coordinates (see migration 042). This matches what
// `/admin/customers/map` plots.
//
// DB-cost discipline (docs/canon/AGENTS_CANON.md §3):
//   * Both selection queries are bounded by the `since` cutoff and the
//     small hyperlocal radius; they ride the existing indexes
//     (`visitor_scans_site_idx`, `visitor_scans_person_key_time_idx`,
//     `visitor_scan_links_sweed_customer_idx`,
//     `sweed_orders` PK / pay_time scans). They are intended for a
//     one-shot backfill and for per-customer evaluation in the engine,
//     never for high-frequency polling.

import type { Pool } from 'pg'

export const FEET_PER_METER = 0.3048

export function feetToMeters(feet: number): number {
  return feet * FEET_PER_METER
}

export function metersToFeet(meters: number): number {
  return meters / FEET_PER_METER
}

/**
 * Equirectangular-approximation distance in meters. Identical formula
 * to `haversineMeters` in helios/src/server/routes/visitorScans.ts —
 * plenty accurate at the sub-mile scale of these checks and cheap.
 * Exported so the selection SQL and any node-side double-check agree.
 */
export function approxMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const meanLat = ((lat1 + lat2) * Math.PI) / 360
  const x = dLng * Math.cos(meanLat)
  const y = dLat
  return Math.sqrt(x * x + y * y) * R
}

// SQL fragment mirroring `approxMeters`. `$latCol`/`$lngCol` are the
// candidate's geocoded coordinate columns; `:slat`/`:slng` are the
// store coordinates bound as parameters. Kept as a builder so the two
// selection queries cannot drift apart.
function distanceMetersSql(latCol: string, lngCol: string, slatParam: string, slngParam: string): string {
  return `(6371000 * sqrt(
    power(radians(${latCol}) - radians(${slatParam}), 2) +
    power(
      (radians(${lngCol}) - radians(${slngParam})) *
      cos(radians((${latCol} + ${slatParam}) / 2)),
      2
    )
  ))`
}

export interface GeoSegmentSelectionParams {
  /** visitor_scans.site_slug of the qualifying scan (e.g. 'bx'). */
  readonly siteSlug: string
  /** Sweed dealer that owns the target segment (e.g. 210249 = Bronx). */
  readonly dealerId: number
  readonly storeLat: number
  readonly storeLng: number
  readonly radiusMeters: number
  /** Inclusive lower bound on the qualifying event (UTC instant). */
  readonly since: Date
  /**
   * "First scan in N days or more": a scan qualifies only when the same
   * person_key has NO earlier scan within this many days before it.
   */
  readonly reactivationDays: number
}

export interface ScanTriggerCandidate {
  readonly scanId: number
  readonly idNum: string | null
  /** Resolved Sweed customer id from an existing `linked` row, else null. */
  readonly sweedCustomerId: number | null
  readonly distanceMeters: number
  readonly firstName: string | null
  readonly lastName: string | null
}

export interface PurchaseTriggerCandidate {
  readonly sweedCustomerId: number
  readonly distanceMeters: number
  readonly firstName: string | null
  readonly lastName: string | null
}

/**
 * Scan-trigger candidates: scans at `siteSlug` on/after `since` whose
 * person had no scan in the prior `reactivationDays` days, AND whose
 * geocoded home address is within `radiusMeters` of the store.
 */
export async function loadScanTriggerCandidates(
  pool: Pool,
  params: GeoSegmentSelectionParams,
): Promise<ScanTriggerCandidate[]> {
  // `scored` only sees `qual`'s projected columns, so the distance is
  // computed off the projected lat/lng (q.lat/q.lng), not `addresses`.
  const dist = distanceMetersSql('q.lat', 'q.lng', '$2', '$3')
  const sql = `
    with qual as (
      select
        vs.id            as scan_id,
        vs.id_num        as id_num,
        vs.first_name    as first_name,
        vs.last_name     as last_name,
        a.latitude       as lat,
        a.longitude      as lng,
        vsl.sweed_customer_id as sweed_customer_id
      from visitor_scans vs
      join addresses a on a.id = vs.address_id
      left join visitor_scan_links vsl
        on vsl.scan_id = vs.id and vsl.link_status = 'linked'
      where vs.site_slug = $1
        and vs.provider = 'veriscan'
        and coalesce(vs.scanned_at, vs.ingested_at) >= $4
        and vs.person_key is not null
        and a.geocode_status = 'ok'
        and a.latitude is not null
        and a.longitude is not null
        -- "first scan in >= N days": disqualify only if the SAME person
        -- has a STRICTLY-earlier scan whose gap is LESS than N days
        -- (strict '>' lower bound, so an exactly-N-day gap still
        -- qualifies as "N days or more").
        and not exists (
          select 1 from visitor_scans p
          where p.provider = vs.provider
            and p.person_key = vs.person_key
            and coalesce(p.scanned_at, p.ingested_at)
                  < coalesce(vs.scanned_at, vs.ingested_at)
            and coalesce(p.scanned_at, p.ingested_at)
                  > coalesce(vs.scanned_at, vs.ingested_at)
                      - make_interval(days => $5::int)
        )
    ),
    scored as (
      select q.*, ${dist} as distance_m
      from qual q
    )
    select scan_id, id_num, first_name, last_name, sweed_customer_id, distance_m
    from scored
    where distance_m <= $6
    order by distance_m asc
  `
  const res = await pool.query(sql, [
    params.siteSlug,
    params.storeLat,
    params.storeLng,
    params.since.toISOString(),
    params.reactivationDays,
    params.radiusMeters,
  ])
  return res.rows.map((r) => ({
    scanId: Number(r.scan_id),
    idNum: r.id_num ?? null,
    sweedCustomerId: r.sweed_customer_id === null || r.sweed_customer_id === undefined
      ? null
      : Number(r.sweed_customer_id),
    distanceMeters: Number(r.distance_m),
    firstName: r.first_name ?? null,
    lastName: r.last_name ?? null,
  }))
}

/**
 * Purchase-trigger candidates: customers whose first-ever attributed
 * Sweed purchase (`first_time_for_customer = true`, computed globally
 * at ingest — guest/walk-in POS sales have a null customer_id and are
 * excluded) happened at `dealerId` on/after `since`, AND who have at
 * least one linked scan whose geocoded home address is within
 * `radiusMeters` of the store. `distanceMeters` is the nearest such
 * scan's distance.
 */
export async function loadPurchaseTriggerCandidates(
  pool: Pool,
  params: GeoSegmentSelectionParams,
): Promise<PurchaseTriggerCandidate[]> {
  const dist = distanceMetersSql('a.latitude', 'a.longitude', '$1', '$2')
  // We do NOT trust the ingest-time `first_time_for_customer` flag here:
  // it was computed over ALL `sweed_orders` rows (including cancelled
  // ones), so a customer whose only prior order was cancelled would be
  // wrongly disqualified, and a cancelled order could be wrongly flagged
  // first. Instead we compute the first NON-CANCELLED attributed order
  // per customer and require it to be at this dealer on/after the cutoff.
  const sql = `
    with orders as (
      select o.customer_id, o.dealer_id, o.pay_time
      from sweed_orders o
      where o.customer_id is not null
        and lower(coalesce(o.raw_json->'invoiceStatus'->>'name', '')) <> 'cancelled'
    ),
    first_order as (
      select customer_id, min(pay_time) as first_pay_time
      from orders
      group by customer_id
    ),
    purch as (
      select distinct fo.customer_id as sweed_customer_id
      from first_order fo
      join orders o2
        on o2.customer_id = fo.customer_id
       and o2.pay_time = fo.first_pay_time
       and o2.dealer_id = $5
      where fo.first_pay_time >= $3
    ),
    cust_addr as (
      select
        p.sweed_customer_id as sweed_customer_id,
        vs.first_name       as first_name,
        vs.last_name        as last_name,
        ${dist}             as distance_m
      from purch p
      join visitor_scan_links vsl
        on vsl.sweed_customer_id = p.sweed_customer_id
       and vsl.dealer_id = $5
       and vsl.link_status = 'linked'
      join visitor_scans vs on vs.id = vsl.scan_id and vs.provider = 'veriscan'
      join addresses a on a.id = vs.address_id
      where a.geocode_status = 'ok'
        and a.latitude is not null
        and a.longitude is not null
    )
    select
      sweed_customer_id,
      min(distance_m) as distance_m,
      (array_agg(first_name order by distance_m))[1] as first_name,
      (array_agg(last_name  order by distance_m))[1] as last_name
    from cust_addr
    group by sweed_customer_id
    having min(distance_m) <= $4
    order by distance_m asc
  `
  const res = await pool.query(sql, [
    params.storeLat, // $1
    params.storeLng, // $2
    params.since.toISOString(), // $3
    params.radiusMeters, // $4
    params.dealerId, // $5
  ])
  return res.rows.map((r) => ({
    sweedCustomerId: Number(r.sweed_customer_id),
    distanceMeters: Number(r.distance_m),
    firstName: r.first_name ?? null,
    lastName: r.last_name ?? null,
  }))
}

/**
 * A persisted geographic segment-assignment rule
 * (`geo_segment_rules`). The on-scan engine loads the enabled rules
 * for a scan's site + trigger and applies any that match. Mirrors the
 * migration-079 columns (camelCased).
 */
export interface GeoSegmentRule {
  readonly id: number
  readonly siteSlug: string
  readonly dealerId: number
  readonly segmentId: number
  readonly centerLat: number
  readonly centerLng: number
  readonly radiusFeet: number
  readonly trigger: TriggerKind
  readonly reactivationDays: number
  /** Inclusive lower bound on the qualifying event, or null. */
  readonly since: Date | null
  readonly enabled: boolean
}

/**
 * Does a geocoded point fall inside a rule's geofence? Uses the same
 * equirectangular `approxMeters` as the selection SQL so the live
 * engine and the backfill agree to the foot. Pure — unit tested.
 */
export function ruleGeoMatches(rule: GeoSegmentRule, lat: number, lng: number): boolean {
  const d = approxMeters(rule.centerLat, rule.centerLng, lat, lng)
  return d <= feetToMeters(rule.radiusFeet)
}

/**
 * Is the qualifying-event instant on/after the rule's `since` bound?
 * A null bound means "no lower bound". Pure — unit tested.
 */
export function ruleSinceSatisfied(rule: GeoSegmentRule, eventTime: Date): boolean {
  if (rule.since === null) return true
  return eventTime.getTime() >= rule.since.getTime()
}

export type TriggerKind = 'first_scan' | 'first_purchase'

export interface MergedCandidate {
  readonly sweedCustomerId: number
  readonly triggers: ReadonlyArray<TriggerKind>
  readonly distanceMeters: number
  readonly name: string
}

/**
 * Merge scan- and purchase-trigger candidates (already resolved to a
 * Sweed customer id) into one per-customer record. A customer that
 * qualifies under both triggers carries both labels; `distanceMeters`
 * is the minimum across all qualifying events. Pure — unit tested.
 */
export function mergeCandidates(
  scanResolved: ReadonlyArray<{
    sweedCustomerId: number
    distanceMeters: number
    firstName: string | null
    lastName: string | null
  }>,
  purchase: ReadonlyArray<PurchaseTriggerCandidate>,
): MergedCandidate[] {
  const byId = new Map<
    number,
    { triggers: Set<TriggerKind>; distanceMeters: number; name: string }
  >()

  const ingest = (
    id: number,
    trigger: TriggerKind,
    distanceMeters: number,
    firstName: string | null,
    lastName: string | null,
  ): void => {
    const name = [firstName ?? '', lastName ?? ''].join(' ').trim()
    const existing = byId.get(id)
    if (existing === undefined) {
      byId.set(id, {
        triggers: new Set([trigger]),
        distanceMeters,
        name,
      })
      return
    }
    existing.triggers.add(trigger)
    existing.distanceMeters = Math.min(existing.distanceMeters, distanceMeters)
    if (existing.name === '' && name !== '') existing.name = name
  }

  for (const c of scanResolved) {
    ingest(c.sweedCustomerId, 'first_scan', c.distanceMeters, c.firstName, c.lastName)
  }
  for (const c of purchase) {
    ingest(c.sweedCustomerId, 'first_purchase', c.distanceMeters, c.firstName, c.lastName)
  }

  return [...byId.entries()]
    .map(([sweedCustomerId, v]) => ({
      sweedCustomerId,
      triggers: [...v.triggers].sort(),
      distanceMeters: v.distanceMeters,
      name: v.name,
    }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
}

/** Split an array into fixed-size chunks. Pure — unit tested. */
export function chunk<T>(items: ReadonlyArray<T>, size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be positive')
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}
