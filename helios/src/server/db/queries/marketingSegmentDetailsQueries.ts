// Read/write for the Helios segment details page
// (/config/marketing/segments/:segmentId, virusdave/top-level#12).
//
// Cache-only: getSegmentDetails() reads exclusively from local caches
// (sweed_marketing_segments, sweed_customer_segments, the
// sweed_segment_membership_refresh highwater, and geo_segment_rules +
// geo_segment_rule_applications). It never calls Sweed. Every query is a
// PK lookup or an index scan on sweed_customer_segments(segment_id, …)
// (migration 080), so page load stays well inside the interactive budget.
//
// The mark*…RefreshPending/Ok/Failed helpers are the per-segment analogue
// of the per-customer highwater writers in sweedCustomerSegmentsQueries.ts;
// only the per-segment refresh job + its enqueue endpoint write them.

import {
  HELIOS_PENDING_PURCHASE_SITE_DEALERS,
  LIVE_EVALUATED_TRIGGERS,
  type GeoSegmentTrigger,
  type SegmentDetailsResponse,
  type SegmentScopeLevel,
  type SegmentType,
} from '../../../shared/contracts/index.js'
import type { Queryable } from '../pool.js'
import { SITE_PINS } from './customersMapQueries.js'
import { sweedPrimeSegmentUrl } from './sweedCustomerSegmentsQueries.js'

const SITE_LABEL_BY_SLUG: Record<string, string> = Object.fromEntries(
  SITE_PINS.map((p) => [p.siteSlug, p.label]),
)

export function mapSegmentType(typeId: number | null): SegmentType {
  if (typeId === 1) return 'static'
  if (typeId === 2) return 'dynamic'
  return 'unknown'
}

function siteLabelForDealer(dealerId: number | null): string | null {
  const d = HELIOS_PENDING_PURCHASE_SITE_DEALERS.find((x) => x.dealerId === dealerId)
  return d ? d.siteLabel : null
}

function isSiteDealer(dealerId: number | null): boolean {
  if (dealerId === null) return false
  return HELIOS_PENDING_PURCHASE_SITE_DEALERS.some((d) => d.dealerId === dealerId)
}

// Scope of a (scope_dealer_id, scope_dealer_name) pair: a store dealer => the
// site; the state holder / unknown => state-wide. dealer 0 is our NOT-NULL
// "unknown owning dealer" sentinel.
export function scopeOf(
  scopeDealerId: number | null,
  scopeDealerName: string | null,
): { scopeLevel: SegmentScopeLevel; scopeLabel: string } {
  if (isSiteDealer(scopeDealerId)) {
    return { scopeLevel: 'site', scopeLabel: siteLabelForDealer(scopeDealerId) ?? 'Site' }
  }
  if (scopeDealerId !== null && scopeDealerId !== 0) {
    return { scopeLevel: 'state', scopeLabel: scopeDealerName?.trim() || 'All stores' }
  }
  return { scopeLevel: 'unknown', scopeLabel: scopeDealerName?.trim() || 'Unknown scope' }
}

function isoOrNull(v: Date | string | null): string | null {
  if (v === null) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

interface CatalogRow {
  segment_name: string | null
  segment_type_id: number | null
  enabled: boolean | null
  total_customers: number | null
  scope_dealer_id: string | number | null
  target_store_names: string[] | null
  catalog_refreshed_at: Date | null
}

/**
 * Assemble the full segment-details payload from local caches only. Returns
 * `null` only when the segment is entirely unknown (no catalog row, no cached
 * members, no geo rule) so the route can 404.
 */
export async function getSegmentDetails(
  db: Queryable,
  segmentId: number,
): Promise<SegmentDetailsResponse | null> {
  const catalogRes = await db.query<CatalogRow>(
    `select c.segment_name, c.segment_type_id, c.enabled, c.total_customers,
            c.scope_dealer_id, c.target_store_names,
            c.refreshed_at as catalog_refreshed_at
       from sweed_marketing_segments c
      where c.segment_id = $1`,
    [segmentId],
  )
  const catalog = catalogRes.rows[0] ?? null

  const memberRes = await db.query<{
    cached_member_count: number
    unknown_enter_count: number
    older_enter_count: number
    first_entered_at: Date | null
    last_entered_at: Date | null
  }>(
    `select
       count(*)::int as cached_member_count,
       count(*) filter (where date_on_enter is null)::int as unknown_enter_count,
       count(*) filter (
         where date_on_enter is not null and date_on_enter < now() - interval '52 weeks'
       )::int as older_enter_count,
       min(date_on_enter) as first_entered_at,
       max(date_on_enter) as last_entered_at
     from sweed_customer_segments
     where segment_id = $1`,
    [segmentId],
  )
  const member = memberRes.rows[0]
  const cachedMemberCount = member?.cached_member_count ?? 0

  const geoExistsRes = await db.query<{ has_geo: boolean }>(
    `select exists(select 1 from geo_segment_rules where segment_id = $1) as has_geo`,
    [segmentId],
  )
  const hasGeo = geoExistsRes.rows[0]?.has_geo === true

  // Unknown segment entirely -> let the caller 404.
  if (catalog === null && cachedMemberCount === 0 && !hasGeo) {
    return null
  }

  // Refresh highwater (PK lookup).
  const hwRes = await db.query<{
    status: 'pending' | 'ok' | 'failed'
    requested_at: Date | null
    refreshed_at: Date | null
    member_count: number | null
    last_error: string | null
  }>(
    `select status, requested_at, refreshed_at, member_count, last_error
       from sweed_segment_membership_refresh where segment_id = $1`,
    [segmentId],
  )
  const hw = hwRes.rows[0] ?? null

  // Entry histogram: weekly, NY-local, last 52 weeks.
  const entryRes = await db.query<{ week_start: string; member_count: number }>(
    `select to_char(
              date_trunc('week', date_on_enter at time zone 'America/New_York'), 'YYYY-MM-DD'
            ) as week_start,
            count(*)::int as member_count
       from sweed_customer_segments
      where segment_id = $1
        and date_on_enter is not null
        and date_on_enter >= now() - interval '52 weeks'
      group by 1
      order by 1`,
    [segmentId],
  )

  // Scope breakdown.
  const scopeRes = await db.query<{
    scope_dealer_id: string | number | null
    scope_dealer_name: string | null
    member_count: number
  }>(
    `select scope_dealer_id, nullif(scope_dealer_name, '') as scope_dealer_name,
            count(*)::int as member_count
       from sweed_customer_segments
      where segment_id = $1
      group by scope_dealer_id, scope_dealer_name
      order by member_count desc`,
    [segmentId],
  )

  // Geo rules + per-rule tallies.
  const rulesRes = hasGeo
    ? await db.query<{
        id: number
        site_slug: string
        trigger: GeoSegmentTrigger
        enabled: boolean
        radius_feet: number
        center_lat: number
        center_lng: number
        since: Date | null
        reactivation_days: number
        note: string | null
        updated_at: Date
        applied: number
        already_member: number
        pending: number
        failed: number
      }>(
        `with rules as (select * from geo_segment_rules where segment_id = $1),
              stats as (
                select rule_id,
                       count(*) filter (where status = 'applied')::int as applied,
                       count(*) filter (where status = 'already_member')::int as already_member,
                       count(*) filter (where status = 'pending')::int as pending,
                       count(*) filter (where status = 'failed')::int as failed
                  from geo_segment_rule_applications
                 where rule_id in (select id from rules)
                 group by rule_id
              )
         select r.id, r.site_slug, r.trigger, r.enabled, r.radius_feet,
                r.center_lat, r.center_lng, r.since, r.reactivation_days, r.note, r.updated_at,
                coalesce(s.applied, 0) as applied,
                coalesce(s.already_member, 0) as already_member,
                coalesce(s.pending, 0) as pending,
                coalesce(s.failed, 0) as failed
           from rules r
           left join stats s on s.rule_id = r.id
          order by r.enabled desc, r.site_slug, r.trigger, r.id`,
        [segmentId],
      )
    : { rows: [] as never[] }

  const failuresRes = hasGeo
    ? await db.query<{
        rule_id: number
        sweed_customer_id: string
        scan_id: string | null
        last_error: string | null
        updated_at: Date
      }>(
        `with rules as (select id from geo_segment_rules where segment_id = $1)
         select rule_id, sweed_customer_id::text, scan_id::text, last_error, updated_at
           from geo_segment_rule_applications
          where rule_id in (select id from rules)
            and status = 'failed'
          order by updated_at desc
          limit 10`,
        [segmentId],
      )
    : { rows: [] as never[] }

  // ---- assemble ----

  // Identity scope from the catalog row (fall back to the most-populated
  // membership scope when the catalog is cold).
  let identityScope = scopeOf(
    catalog ? (catalog.scope_dealer_id === null ? null : Number(catalog.scope_dealer_id)) : null,
    null,
  )
  if (catalog === null && scopeRes.rows.length > 0) {
    const top = scopeRes.rows[0]
    identityScope = scopeOf(
      top.scope_dealer_id === null ? null : Number(top.scope_dealer_id),
      top.scope_dealer_name,
    )
  }

  const refreshState = (() => {
    if (hw) {
      return {
        status: hw.status,
        requestedAt: isoOrNull(hw.requested_at),
        refreshedAt: isoOrNull(hw.refreshed_at),
        memberCount: hw.member_count,
        lastError: hw.last_error,
      } as const
    }
    if (cachedMemberCount > 0) {
      return {
        status: 'untracked' as const,
        requestedAt: null,
        refreshedAt: null,
        memberCount: cachedMemberCount,
        lastError: null,
      }
    }
    return {
      status: 'never' as const,
      requestedAt: null,
      refreshedAt: null,
      memberCount: null,
      lastError: null,
    }
  })()

  return {
    segment: {
      segmentId,
      name: (catalog?.segment_name ?? '').trim() || `Segment #${segmentId}`,
      type: mapSegmentType(catalog?.segment_type_id ?? null),
      enabled: catalog?.enabled ?? null,
      scopeLevel: identityScope.scopeLevel,
      scopeLabel: identityScope.scopeLabel,
      targetStoreNames: (catalog?.target_store_names ?? []).filter((n) => n.trim().length > 0),
      sweedTotalCustomers: catalog?.total_customers ?? null,
      catalogRefreshedAt: isoOrNull(catalog?.catalog_refreshed_at ?? null),
      inCatalog: catalog !== null,
      sweedPrimeUrl: sweedPrimeSegmentUrl(segmentId),
    },
    membership: {
      cachedMemberCount,
      firstEnteredAt: isoOrNull(member?.first_entered_at ?? null),
      lastEnteredAt: isoOrNull(member?.last_entered_at ?? null),
      unknownEnterCount: member?.unknown_enter_count ?? 0,
      olderEnterCount: member?.older_enter_count ?? 0,
    },
    refreshState,
    entryHistogram: entryRes.rows.map((r) => ({ weekStart: r.week_start, count: r.member_count })),
    scopeBreakdown: scopeRes.rows.map((r) => {
      const s = scopeOf(
        r.scope_dealer_id === null ? null : Number(r.scope_dealer_id),
        r.scope_dealer_name,
      )
      return { scopeLevel: s.scopeLevel, scopeLabel: s.scopeLabel, memberCount: r.member_count }
    }),
    geoRules: rulesRes.rows.map((r) => ({
      id: r.id,
      siteSlug: r.site_slug,
      siteLabel: SITE_LABEL_BY_SLUG[r.site_slug] ?? null,
      trigger: r.trigger,
      triggerLive: LIVE_EVALUATED_TRIGGERS.includes(r.trigger),
      enabled: r.enabled,
      radiusFeet: Number(r.radius_feet),
      centerLat: Number(r.center_lat),
      centerLng: Number(r.center_lng),
      since: isoOrNull(r.since),
      reactivationDays: r.reactivation_days,
      note: r.note,
      updatedAt: r.updated_at.toISOString(),
      applied: r.applied,
      alreadyMember: r.already_member,
      pending: r.pending,
      failed: r.failed,
    })),
    recentGeoFailures: failuresRes.rows.map((r) => ({
      ruleId: r.rule_id,
      sweedCustomerId: r.sweed_customer_id,
      scanId: r.scan_id,
      lastError: r.last_error,
      updatedAt: r.updated_at.toISOString(),
    })),
  }
}

// ---------------------------------------------------------------------
// Per-segment membership-refresh highwater writers (migration 081).
// ---------------------------------------------------------------------

export async function markSegmentMembershipRefreshPending(
  db: Queryable,
  segmentId: number,
): Promise<void> {
  await db.query(
    `insert into sweed_segment_membership_refresh
       (segment_id, status, requested_at, last_error, updated_at)
     values ($1, 'pending', now(), null, now())
     on conflict (segment_id) do update set
       status       = 'pending',
       requested_at = now(),
       last_error   = null,
       updated_at   = now()`,
    [segmentId],
  )
}

export async function markSegmentMembershipRefreshOk(
  db: Queryable,
  args: { segmentId: number; memberCount: number },
): Promise<void> {
  await db.query(
    `insert into sweed_segment_membership_refresh
       (segment_id, status, refreshed_at, member_count, last_error, updated_at)
     values ($1, 'ok', now(), $2, null, now())
     on conflict (segment_id) do update set
       status       = 'ok',
       refreshed_at = now(),
       member_count = excluded.member_count,
       last_error   = null,
       updated_at   = now()`,
    [args.segmentId, args.memberCount],
  )
}

export async function markSegmentMembershipRefreshFailed(
  db: Queryable,
  args: { segmentId: number; error: string },
): Promise<void> {
  await db.query(
    `insert into sweed_segment_membership_refresh
       (segment_id, status, last_error, updated_at)
     values ($1, 'failed', $2, now())
     on conflict (segment_id) do update set
       status     = 'failed',
       last_error = excluded.last_error,
       updated_at = now()`,
    [args.segmentId, args.error.slice(0, 1000)],
  )
}
