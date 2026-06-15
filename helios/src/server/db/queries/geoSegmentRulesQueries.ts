// Data access for the geographic (scan-location-based) segment
// assignment engine — migration 079 (`geo_segment_rules` +
// `geo_segment_rule_applications`). Phase 2 of the Bronx geo-segment
// work; pairs with helios/src/worker/jobs/geoSegmentRuleEvalJob.ts.
//
// DB-cost discipline (docs/canon/AGENTS_CANON.md §3): every query here
// is point-lookup / tiny-table shaped and rides an index:
//   * loadEnabledRules    -> geo_segment_rules_active_idx (partial)
//   * loadScanEvalContext -> visitor_scans PK + indexed link/address joins
//   * personHasPriorScan  -> visitor_scans_person_key_time_idx
//   * claim/mark*         -> geo_segment_rule_applications PK

import type { Queryable } from '../pool.js'
import type { GeoSegmentRule, TriggerKind } from '../../../worker/sweed/geoSegment.js'
import { EMPTY_GEO_PREDICATE_AST, type GeoPredicateAst } from '../../../shared/contracts/index.js'

interface GeoSegmentRuleRow {
  id: string | number
  site_slug: string
  dealer_id: string | number
  segment_id: string | number
  predicate_json: GeoPredicateAst | null
  center_lat: string | number | null
  center_lng: string | number | null
  radius_feet: string | number | null
  trigger: string
  reactivation_days: string | number
  since: Date | string | null
  enabled: boolean
}

/** Load the enabled rules for a site + trigger (usually 0–2 rows). */
export async function loadEnabledRules(
  db: Queryable,
  siteSlug: string,
  trigger: TriggerKind,
): Promise<GeoSegmentRule[]> {
  const res = await db.query<GeoSegmentRuleRow>(
    `
      select id, site_slug, dealer_id, segment_id, predicate_json,
             center_lat, center_lng, radius_feet,
             trigger, reactivation_days, since, enabled
        from geo_segment_rules
       where enabled
         and site_slug = $1
         and trigger = $2
    `,
    [siteSlug, trigger],
  )
  return res.rows.map(mapRuleRow)
}

function mapRuleRow(r: GeoSegmentRuleRow): GeoSegmentRule {
  return {
    id: Number(r.id),
    siteSlug: r.site_slug,
    dealerId: Number(r.dealer_id),
    segmentId: Number(r.segment_id),
    // The raw jsonb arrives as a parsed object; the evaluator re-validates
    // with zod and fails closed on a malformed enabled rule.
    predicateJson: r.predicate_json ?? EMPTY_GEO_PREDICATE_AST,
    centerLat: r.center_lat === null ? null : Number(r.center_lat),
    centerLng: r.center_lng === null ? null : Number(r.center_lng),
    radiusFeet: r.radius_feet === null ? null : Number(r.radius_feet),
    trigger: r.trigger as TriggerKind,
    reactivationDays: Number(r.reactivation_days),
    since: r.since === null ? null : new Date(r.since),
    enabled: r.enabled,
  }
}

export interface ScanEvalContext {
  readonly scanId: number
  readonly siteSlug: string
  readonly provider: string
  readonly personKey: string | null
  /** coalesce(scanned_at, ingested_at) — the qualifying-event instant. */
  readonly eventTime: Date
  /** Resolved Sweed customer id from a `linked` link row, else null. */
  readonly sweedCustomerId: number | null
  /** Geocoded home-address coordinates (only when geocode_status='ok'). */
  readonly addressLat: number | null
  readonly addressLng: number | null
  readonly geocodeStatus: string | null
  /** Geocoded ZIP5 of the home address, falling back to the raw ID ZIP. */
  readonly zip5: string | null
  /** Geocoded 2-letter state of the home address, falling back to raw ID state. */
  readonly stateCode: string | null
  /** ID date of birth (for age predicates), or null. */
  readonly birthDate: Date | null
  /** Raw ID gender marker (normalised in the evaluator), or null. */
  readonly gender: string | null
}

/**
 * Load everything the eval job needs about one scan in a single
 * indexed read: its site/person/event-time, its resolved Sweed
 * customer (if linked), and its geocoded home coordinates (if the
 * address has reached geocode `ok`).
 */
export async function loadScanEvalContext(
  db: Queryable,
  scanId: number,
): Promise<ScanEvalContext | null> {
  const res = await db.query(
    `
      select
        vs.id          as scan_id,
        vs.site_slug   as site_slug,
        vs.provider    as provider,
        vs.person_key  as person_key,
        coalesce(vs.scanned_at, vs.ingested_at) as event_time,
        vsl.sweed_customer_id as sweed_customer_id,
        a.geocode_status as geocode_status,
        a.latitude     as address_lat,
        a.longitude    as address_lng,
        -- Prefer the canonical geocoded ZIP5/state; fall back to the raw
        -- values parsed off the ID itself so zip/state predicates still
        -- evaluate even if the Census geocode only resolved coarsely.
        coalesce(a.zip5, vs.postal_code) as zip5,
        coalesce(a.state_code, vs.state) as state_code,
        vs.birth_date  as birth_date,
        vs.gender      as gender
      from visitor_scans vs
      left join visitor_scan_links vsl
        on vsl.scan_id = vs.id and vsl.link_status = 'linked'
      left join addresses a
        on a.id = vs.address_id
      where vs.id = $1
    `,
    [scanId],
  )
  const row = res.rows[0]
  if (row === undefined) return null
  return {
    scanId: Number(row.scan_id),
    siteSlug: row.site_slug,
    provider: row.provider,
    personKey: row.person_key ?? null,
    eventTime: new Date(row.event_time),
    sweedCustomerId:
      row.sweed_customer_id === null || row.sweed_customer_id === undefined
        ? null
        : Number(row.sweed_customer_id),
    addressLat: row.address_lat === null || row.address_lat === undefined ? null : Number(row.address_lat),
    addressLng: row.address_lng === null || row.address_lng === undefined ? null : Number(row.address_lng),
    geocodeStatus: row.geocode_status ?? null,
    zip5: row.zip5 ?? null,
    stateCode: row.state_code ?? null,
    birthDate: row.birth_date === null || row.birth_date === undefined ? null : new Date(row.birth_date),
    gender: row.gender ?? null,
  }
}

/**
 * The most-recent scan strictly earlier than `eventTime` for this
 * person, or null. Feeds every `first_scan_in_days` predicate from one
 * indexed read (the most-recent prior dominates all day-windows). Rides
 * `visitor_scans_person_key_time_idx`.
 */
export async function loadLatestPriorScanAt(
  db: Queryable,
  args: { provider: string; personKey: string; eventTime: Date },
): Promise<Date | null> {
  const res = await db.query<{ latest: Date | string | null }>(
    `
      select max(coalesce(p.scanned_at, p.ingested_at)) as latest
        from visitor_scans p
       where p.provider = $1
         and p.person_key = $2
         and coalesce(p.scanned_at, p.ingested_at) < $3
    `,
    [args.provider, args.personKey, args.eventTime.toISOString()],
  )
  const latest = res.rows[0]?.latest
  return latest === null || latest === undefined ? null : new Date(latest)
}

export type ApplicationClaim = 'claimed' | 'skip_done' | 'skip_inflight' | 'reattempt'

// How long a 'pending' claim may sit before we treat it as abandoned
// (the claiming job crashed between claim and resolve) and allow a
// re-attempt. Comfortably longer than a single eval's Sweed round-trip.
const STALE_PENDING_RECOVERY_INTERVAL = '15 minutes'

/**
 * Atomically claim the (rule, customer) application slot. The ledger
 * row is BOTH the idempotency key and the exclusion lease, so a
 * customer is added to a rule's segment at most once even when two
 * jobs (different scans / racing edges) evaluate the same customer
 * concurrently.
 *
 * Returns:
 *   - 'claimed'       : we inserted a fresh pending row; proceed to Sweed.
 *   - 'reattempt'     : we atomically reclaimed a previously 'failed'
 *                       (or abandoned-stale-'pending') row; proceed.
 *   - 'skip_done'     : already 'applied'/'already_member'; do nothing.
 *   - 'skip_inflight' : another job holds a fresh 'pending' claim; let
 *                       it finish (this caller must NOT also write).
 *
 * IMPORTANT: only 'claimed' and 'reattempt' grant the right to call
 * Sweed. 'skip_inflight' is the exclusion that prevents the double-add.
 */
export async function claimRuleApplication(
  db: Queryable,
  args: { ruleId: number; sweedCustomerId: number; scanId: number },
): Promise<ApplicationClaim> {
  const ins = await db.query(
    `
      insert into geo_segment_rule_applications
        (rule_id, sweed_customer_id, scan_id, status)
      values ($1, $2, $3, 'pending')
      on conflict (rule_id, sweed_customer_id) do nothing
      returning rule_id
    `,
    [args.ruleId, args.sweedCustomerId, args.scanId],
  )
  if ((ins.rowCount ?? 0) > 0) return 'claimed'

  // Conflict: try to atomically reclaim a 'failed' row, or a 'pending'
  // row abandoned by a crashed prior attempt. The row-level lock taken
  // by this UPDATE is what serialises two concurrent reclaimers — only
  // one can flip it.
  const reclaim = await db.query(
    `
      update geo_segment_rule_applications
         set status = 'pending', scan_id = coalesce(scan_id, $3),
             last_error = null, updated_at = now()
       where rule_id = $1 and sweed_customer_id = $2
         and (
           status = 'failed'
           or (status = 'pending' and updated_at < now() - interval '${STALE_PENDING_RECOVERY_INTERVAL}')
         )
      returning rule_id
    `,
    [args.ruleId, args.sweedCustomerId, args.scanId],
  )
  if ((reclaim.rowCount ?? 0) > 0) return 'reattempt'

  const existing = await db.query<{ status: string }>(
    `select status from geo_segment_rule_applications where rule_id = $1 and sweed_customer_id = $2`,
    [args.ruleId, args.sweedCustomerId],
  )
  const status = existing.rows[0]?.status
  if (status === 'applied' || status === 'already_member') return 'skip_done'
  // Fresh 'pending' held by another in-flight job — do not double-write.
  return 'skip_inflight'
}

/**
 * Read which of `ruleIds` are already terminally resolved
 * ('applied'/'already_member') for this customer — used to skip opening
 * a Sweed session when there is nothing left to do. One indexed read.
 */
export async function loadResolvedRuleIds(
  db: Queryable,
  args: { ruleIds: number[]; sweedCustomerId: number },
): Promise<Set<number>> {
  if (args.ruleIds.length === 0) return new Set()
  const res = await db.query<{ rule_id: string | number }>(
    `
      select rule_id from geo_segment_rule_applications
       where sweed_customer_id = $1
         and rule_id = any($2::bigint[])
         and status in ('applied', 'already_member')
    `,
    [args.sweedCustomerId, args.ruleIds],
  )
  return new Set(res.rows.map((r) => Number(r.rule_id)))
}

export type AppliedStatus = 'applied' | 'already_member'

/**
 * Mark a claimed slot resolved after a successful Sweed write. Guarded
 * on `status = 'pending'` so only the holder of the current claim can
 * resolve it (never regress a row another path already settled).
 */
export async function markRuleApplicationApplied(
  db: Queryable,
  args: { ruleId: number; sweedCustomerId: number; scanId: number; status: AppliedStatus },
): Promise<void> {
  await db.query(
    `
      update geo_segment_rule_applications
         set status = $3, scan_id = coalesce(scan_id, $4),
             last_error = null, applied_at = now(), updated_at = now()
       where rule_id = $1 and sweed_customer_id = $2 and status = 'pending'
    `,
    [args.ruleId, args.sweedCustomerId, args.status, args.scanId],
  )
}

/**
 * Mark a claimed slot failed (retryable on the next trigger / after the
 * stale-pending window). Guarded on `status = 'pending'` so a late
 * failing job can never regress an 'applied'/'already_member' row.
 */
export async function markRuleApplicationFailed(
  db: Queryable,
  args: { ruleId: number; sweedCustomerId: number; error: string },
): Promise<void> {
  await db.query(
    `
      update geo_segment_rule_applications
         set status = 'failed', last_error = $3, updated_at = now()
       where rule_id = $1 and sweed_customer_id = $2 and status = 'pending'
    `,
    [args.ruleId, args.sweedCustomerId, args.error.slice(0, 2000)],
  )
}
