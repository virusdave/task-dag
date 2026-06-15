// Control-plane (admin CRUD) data access for the geo-segment rule
// engine. Read/write of `geo_segment_rules` plus per-rule tallies from
// `geo_segment_rule_applications`. Pairs with routes/geoSegmentRules.ts
// and the live evaluator's data access in geoSegmentRulesQueries.ts.
//
// DB-cost discipline (docs/canon/AGENTS_CANON.md §3): this is a
// LOW-FREQUENCY admin surface (a handful of operators, opened
// occasionally), not a hot or background path.
//   * list   -> one seq scan of `geo_segment_rules` (single-/double-
//               digit rows) LEFT JOINed to a single grouped aggregate
//               over `geo_segment_rule_applications` keyed by its PK
//               leading column (rule_id). At today's ledger size
//               (tens-to-low-thousands of rows) this is sub-millisecond.
//   * get/create/update/delete -> PK point operations on a tiny table.
// No new index is required; the table is small enough that the planner
// uses a seq scan regardless.

import type { Queryable } from '../pool.js'
import {
  EMPTY_GEO_PREDICATE_AST,
  LIVE_EVALUATED_TRIGGERS,
  type GeoPredicateAst,
  type GeoSegmentRuleCreateBody,
  type GeoSegmentRuleRecord,
  type GeoSegmentRuleUpdateBody,
  type GeoSegmentTrigger,
} from '../../../shared/contracts/index.js'
import { SITE_PIN_BY_SLUG } from './customersMapQueries.js'

interface RuleStatsRow {
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
  note: string | null
  created_at: Date | string
  updated_at: Date | string
  applied: string | number
  already_member: string | number
  failed: string | number
  pending: string | number
}

const LIVE_TRIGGER_SET = new Set<GeoSegmentTrigger>(LIVE_EVALUATED_TRIGGERS)
const DEFAULT_REACTIVATION_DAYS = 365

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/**
 * Project the legacy 079 mirror columns out of the AST so the backfill
 * CLI + any 079-era reader still see a consistent geofence/since/
 * reactivation. The AST is the source of truth; these are derived.
 */
function deriveLegacyMirror(ast: GeoPredicateAst): {
  centerLat: number | null
  centerLng: number | null
  radiusFeet: number | null
  since: string | null
  reactivationDays: number
} {
  let centerLat: number | null = null
  let centerLng: number | null = null
  let radiusFeet: number | null = null
  let since: string | null = null
  let reactivationDays = DEFAULT_REACTIVATION_DAYS
  for (const p of ast.predicates) {
    if (p.kind === 'geofence') {
      centerLat = p.centerLat
      centerLng = p.centerLng
      radiusFeet = p.radiusFeet
    } else if (p.kind === 'scan_time_window' && p.since !== undefined) {
      since = p.since
    } else if (p.kind === 'first_scan_in_days') {
      reactivationDays = p.days
    }
  }
  return { centerLat, centerLng, radiusFeet, since, reactivationDays }
}

function mapRow(r: RuleStatsRow): GeoSegmentRuleRecord {
  const trigger = r.trigger as GeoSegmentTrigger
  const siteLabel = SITE_PIN_BY_SLUG[r.site_slug]?.label ?? null
  return {
    id: Number(r.id),
    siteSlug: r.site_slug,
    siteLabel,
    dealerId: Number(r.dealer_id),
    segmentId: Number(r.segment_id),
    predicateJson: r.predicate_json ?? EMPTY_GEO_PREDICATE_AST,
    centerLat: r.center_lat === null ? null : Number(r.center_lat),
    centerLng: r.center_lng === null ? null : Number(r.center_lng),
    radiusFeet: r.radius_feet === null ? null : Number(r.radius_feet),
    trigger,
    triggerLive: LIVE_TRIGGER_SET.has(trigger),
    reactivationDays: Number(r.reactivation_days),
    since: r.since === null ? null : toIso(r.since),
    enabled: r.enabled,
    note: r.note,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
    stats: {
      applied: Number(r.applied),
      alreadyMember: Number(r.already_member),
      failed: Number(r.failed),
      pending: Number(r.pending),
    },
  }
}

// Column list + ledger aggregate join shared by list and single-row
// reads so every read returns the identical record shape.
const SELECT_WITH_STATS = `
  select
    r.id, r.site_slug, r.dealer_id, r.segment_id, r.predicate_json,
    r.center_lat, r.center_lng, r.radius_feet,
    r.trigger, r.reactivation_days, r.since, r.enabled, r.note,
    r.created_at, r.updated_at,
    coalesce(s.applied, 0)        as applied,
    coalesce(s.already_member, 0) as already_member,
    coalesce(s.failed, 0)         as failed,
    coalesce(s.pending, 0)        as pending
  from geo_segment_rules r
  left join (
    select
      rule_id,
      count(*) filter (where status = 'applied')        as applied,
      count(*) filter (where status = 'already_member') as already_member,
      count(*) filter (where status = 'failed')         as failed,
      count(*) filter (where status = 'pending')        as pending
    from geo_segment_rule_applications
    group by rule_id
  ) s on s.rule_id = r.id
`

export async function listGeoSegmentRules(db: Queryable): Promise<GeoSegmentRuleRecord[]> {
  const res = await db.query<RuleStatsRow>(
    `${SELECT_WITH_STATS} order by r.enabled desc, r.site_slug, r.trigger, r.id`,
  )
  return res.rows.map(mapRow)
}

export async function getGeoSegmentRuleById(
  db: Queryable,
  id: number,
): Promise<GeoSegmentRuleRecord | null> {
  // Single-row read scopes the ledger aggregate to this rule_id (PK
  // leading column) instead of grouping the whole table, so reload after
  // create/update stays a point lookup.
  const res = await db.query<RuleStatsRow>(
    `
      select
        r.id, r.site_slug, r.dealer_id, r.segment_id, r.predicate_json,
        r.center_lat, r.center_lng, r.radius_feet,
        r.trigger, r.reactivation_days, r.since, r.enabled, r.note,
        r.created_at, r.updated_at,
        coalesce(s.applied, 0)        as applied,
        coalesce(s.already_member, 0) as already_member,
        coalesce(s.failed, 0)         as failed,
        coalesce(s.pending, 0)        as pending
      from geo_segment_rules r
      left join (
        select
          count(*) filter (where status = 'applied')        as applied,
          count(*) filter (where status = 'already_member') as already_member,
          count(*) filter (where status = 'failed')         as failed,
          count(*) filter (where status = 'pending')        as pending
        from geo_segment_rule_applications
        where rule_id = $1
      ) s on true
      where r.id = $1
    `,
    [id],
  )
  const row = res.rows[0]
  return row === undefined ? null : mapRow(row)
}

export async function createGeoSegmentRule(
  db: Queryable,
  input: GeoSegmentRuleCreateBody,
): Promise<number> {
  const mirror = deriveLegacyMirror(input.predicateJson)
  const res = await db.query<{ id: string | number }>(
    `
      insert into geo_segment_rules
        (site_slug, dealer_id, segment_id, predicate_json,
         center_lat, center_lng, radius_feet,
         trigger, reactivation_days, since, enabled, note)
      values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12)
      returning id
    `,
    [
      input.siteSlug,
      input.dealerId,
      input.segmentId,
      JSON.stringify(input.predicateJson),
      mirror.centerLat,
      mirror.centerLng,
      mirror.radiusFeet,
      input.trigger,
      mirror.reactivationDays,
      mirror.since,
      input.enabled,
      input.note ?? null,
    ],
  )
  return Number(res.rows[0].id)
}

export async function updateGeoSegmentRule(
  db: Queryable,
  id: number,
  patch: GeoSegmentRuleUpdateBody,
): Promise<boolean> {
  // Build the SET clause only from fields the caller actually sent, so a
  // partial PATCH never clobbers an unrelated column. `updated_at` is
  // bumped on every real edit (this is an explicit operator action, not
  // a recurring rewrite, so write-on-change polling guards do not apply).
  const sets: string[] = []
  const values: unknown[] = []
  let i = 1
  const set = (column: string, value: unknown, cast = ''): void => {
    sets.push(`${column} = $${i}${cast}`)
    values.push(value)
    i += 1
  }

  // Target/identity fields (site/dealer/segment/trigger) are immutable
  // once a rule exists — the route rejects any real change, so we never
  // write them here. Editable: the predicate AST, enabled, note.
  if (patch.predicateJson !== undefined) {
    set('predicate_json', JSON.stringify(patch.predicateJson), '::jsonb')
    // Re-derive the legacy mirror columns from the new AST so they stay
    // consistent for the backfill CLI / 079-era readers.
    const mirror = deriveLegacyMirror(patch.predicateJson)
    set('center_lat', mirror.centerLat)
    set('center_lng', mirror.centerLng)
    set('radius_feet', mirror.radiusFeet)
    set('reactivation_days', mirror.reactivationDays)
    set('since', mirror.since)
  }
  if (patch.enabled !== undefined) set('enabled', patch.enabled)
  if (patch.note !== undefined) set('note', patch.note)

  if (sets.length === 0) {
    // Nothing to change; treat as a successful no-op if the row exists.
    const exists = await db.query(`select 1 from geo_segment_rules where id = $1`, [id])
    return (exists.rowCount ?? 0) > 0
  }

  sets.push('updated_at = now()')
  values.push(id)
  const res = await db.query(
    `update geo_segment_rules set ${sets.join(', ')} where id = $${i}`,
    values,
  )
  return (res.rowCount ?? 0) > 0
}

export async function deleteGeoSegmentRule(db: Queryable, id: number): Promise<boolean> {
  // ON DELETE CASCADE removes the rule's application ledger rows too.
  const res = await db.query(`delete from geo_segment_rules where id = $1`, [id])
  return (res.rowCount ?? 0) > 0
}
