// GAds → Landing pages analytics read path (V1).
//
// Backs GET /api/gads/landing-pages (helios/src/server/routes/
// gadsLandingPages.ts), the first sub-page of the GAds analytics
// surface (parent epic virusdave/top-level#18).
//
// Design (Oracle-reviewed — see issue #18 thread): V1 reads the
// append-only `lp_events` sink (migration 070) DIRECTLY — no rollup
// tables, no assignment-fact table, no background worker. The
// operator explicitly accepts slightly reduced precision / latency in
// exchange for minimal DB footprint (this is not an accounting
// system). Cost / revenue / ROAS are NOT wired yet.
//
// Semantics: ASSIGNMENT-COHORT, not raw event counts.
//   1. `anchors`: the set of assignments whose `lp_assignment` event
//      falls in the half-open window [from, to), with their placement
//      + provenance taken from the assignment row.
//   2. `assignment_flags`: per assignment, did it later reach the
//      impression / redirect / conversion stage (bool_or over
//      same-assignment events, outcomes observed through generatedAt).
//   3. Funnel + KPIs + per-variant table are all derived from those
//      one-row-per-assignment flags, so every count is an
//      assignment-level unique.
//
// Guardrails: half-open window, a default window when omitted, and a
// hard max span so a request can never seq-scan all of lp_events.
// Existing indexes (lp_events_type_ts_idx, lp_events_assignment_idx,
// lp_events_site_family_idx) cover this access pattern; no new index
// is required for V1.

import {
  GADS_SITES,
  type GadsScope,
  type GadsSiteKey,
} from '../../../shared/domain/gadsSites.js'
import type {
  GadsDataQuality,
  GadsFunnelStage,
  GadsLandingPagesKpis,
  GadsLandingPagesResponse,
  GadsVariantRow,
} from '../../../shared/contracts/index.js'
import { getPool, type Queryable } from '../pool.js'

const DAY_MS = 86_400_000

/** Default window when the caller omits from/to. */
export const GADS_LANDING_PAGES_DEFAULT_WINDOW_DAYS = 30
/** Hard cap on the requested span, so a request can never scan all of
 *  lp_events. The operator can widen later if needed. */
export const GADS_LANDING_PAGES_MAX_WINDOW_DAYS = 120
/** Variant rows with fewer assignments than this are flagged
 *  low-sample; the UI hides them by default behind a toggle. */
export const GADS_LANDING_PAGES_LOW_SAMPLE_THRESHOLD = 25
/** Cap on the number of variant rows returned (the UI bounds the
 *  table; full drilldown is V2). */
const VARIANT_ROW_LIMIT = 50

export interface GadsLandingPagesArgs {
  readonly scope: GadsScope
  readonly from?: Date
  readonly to?: Date
  readonly family?: string
  readonly experimentId?: string
  readonly db?: Queryable
}

/** The concrete lp_events.site values a scope covers. */
function sitesForScope(scope: GadsScope): GadsSiteKey[] {
  if (scope === 'all') return GADS_SITES.map((s) => s.key)
  return [scope]
}

function asNum(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
function asInt(v: unknown): number {
  const n = asNum(v)
  return n === null ? 0 : Math.round(n)
}

/** Safe division returning null on a zero/absent denominator. */
function rate(numer: number, denom: number): number | null {
  if (!denom) return null
  return numer / denom
}

interface AnchorRow {
  site: string
  family: string | null
  experiment_id: string | null
  policy_rule_id: string | null
  branch_id: string | null
  assignments: string
  impressions: string
  redirects: string
  conversions: string
  avg_served_probability_bps: string | null
}

export async function getGadsLandingPages(
  args: GadsLandingPagesArgs,
): Promise<GadsLandingPagesResponse> {
  const db = args.db ?? getPool()
  const now = new Date()

  // --- Resolve + clamp the window (half-open [from, to)). ---
  const to = args.to ?? now
  let from =
    args.from ?? new Date(to.getTime() - GADS_LANDING_PAGES_DEFAULT_WINDOW_DAYS * DAY_MS)
  if (from.getTime() >= to.getTime()) {
    // Defensive: a degenerate range collapses to the default window.
    from = new Date(to.getTime() - GADS_LANDING_PAGES_DEFAULT_WINDOW_DAYS * DAY_MS)
  }
  const maxSpanMs = GADS_LANDING_PAGES_MAX_WINDOW_DAYS * DAY_MS
  if (to.getTime() - from.getTime() > maxSpanMs) {
    from = new Date(to.getTime() - maxSpanMs)
  }

  const sites = sitesForScope(args.scope)

  // Bind params. `$1` from, `$2` to, `$3` site list. Optional family /
  // experiment filters appended afterwards.
  const params: unknown[] = [from.toISOString(), to.toISOString(), sites]
  const anchorFilters: string[] = []
  if (args.family) {
    params.push(args.family)
    anchorFilters.push(`and a.family = $${params.length}`)
  }
  if (args.experimentId) {
    params.push(args.experimentId)
    anchorFilters.push(`and a.experiment_id = $${params.length}`)
  }
  const anchorFilterSql = anchorFilters.join('\n        ')

  // One round-trip computes the per-variant aggregates. The funnel +
  // KPIs are summed from these rows in JS (the grain is small — bounded
  // by the number of (site, family, experiment, rule, branch) groups).
  // We deliberately DO NOT group by served_probability_bps (it can
  // drift over time and fragment rows); it is averaged as a diagnostic.
  const sql = `
    with anchors as materialized (
      select distinct on (assignment_id)
        assignment_id,
        site,
        family,
        experiment_id,
        policy_rule_id,
        branch_id,
        served_probability_bps
      from lp_events
      where event_type = 'lp_assignment'
        and assignment_id is not null
        and event_ts >= $1::timestamptz
        and event_ts <  $2::timestamptz
        and site = any($3::text[])
      order by assignment_id, event_ts asc
    ),
    assignment_flags as materialized (
      select
        a.site,
        a.family,
        a.experiment_id,
        a.policy_rule_id,
        a.branch_id,
        a.served_probability_bps,
        coalesce(bool_or(e.event_type = 'lp_impression'), false) as reached_impression,
        coalesce(bool_or(e.event_type = 'lp_redirect'), false)   as reached_redirect,
        coalesce(bool_or(e.event_type = 'lp_conversion'), false) as reached_conversion
      from anchors a
      left join lp_events e
        on e.assignment_id = a.assignment_id
       and e.event_type in ('lp_impression', 'lp_redirect', 'lp_conversion')
      where true
        ${anchorFilterSql}
      group by
        a.assignment_id,
        a.site,
        a.family,
        a.experiment_id,
        a.policy_rule_id,
        a.branch_id,
        a.served_probability_bps
    )
    select
      site,
      family,
      experiment_id,
      policy_rule_id,
      branch_id,
      count(*)::bigint                                              as assignments,
      count(*) filter (where reached_impression)::bigint           as impressions,
      count(*) filter (where reached_redirect)::bigint             as redirects,
      count(*) filter (where reached_conversion)::bigint           as conversions,
      avg(served_probability_bps)::float8                          as avg_served_probability_bps
    from assignment_flags
    group by site, family, experiment_id, policy_rule_id, branch_id
    order by assignments desc, site, family, experiment_id, branch_id
  `

  // Data-quality counters: assignment events with a null id (dropped),
  // and later-stage events with a null id (unattributable). Cheap,
  // time-bounded, same window + sites.
  const dqSql = `
    select
      count(*) filter (
        where event_type = 'lp_assignment' and assignment_id is null
      )::bigint as assignments_missing_id,
      count(*) filter (
        where event_type in ('lp_impression', 'lp_redirect', 'lp_conversion')
          and assignment_id is null
      )::bigint as unattributed_stage_events
    from lp_events
    where event_ts >= $1::timestamptz
      and event_ts <  $2::timestamptz
      and site = any($3::text[])
  `

  const [variantResult, dqResult] = await Promise.all([
    db.query<AnchorRow>(sql, params),
    db.query<{ assignments_missing_id: string; unattributed_stage_events: string }>(
      dqSql,
      [from.toISOString(), to.toISOString(), sites],
    ),
  ])

  // --- Aggregate funnel + KPI totals from the variant rows. ---
  let totalAssignments = 0
  let totalImpressions = 0
  let totalRedirects = 0
  let totalConversions = 0
  for (const r of variantResult.rows) {
    totalAssignments += asInt(r.assignments)
    totalImpressions += asInt(r.impressions)
    totalRedirects += asInt(r.redirects)
    totalConversions += asInt(r.conversions)
  }

  const funnel: GadsFunnelStage[] = [
    { stage: 'assigned', label: 'Assigned', count: totalAssignments, stepRate: null },
    {
      stage: 'impressed',
      label: 'Impressed',
      count: totalImpressions,
      stepRate: rate(totalImpressions, totalAssignments),
    },
    {
      stage: 'redirected',
      label: 'Redirected',
      count: totalRedirects,
      stepRate: rate(totalRedirects, totalImpressions),
    },
    {
      stage: 'converted',
      label: 'Converted',
      count: totalConversions,
      stepRate: rate(totalConversions, totalRedirects),
    },
  ]

  const kpis: GadsLandingPagesKpis = {
    assignments: totalAssignments,
    conversionRate: rate(totalConversions, totalAssignments),
    redirectRate: rate(totalRedirects, totalImpressions),
    impressionRate: rate(totalImpressions, totalAssignments),
    // Money KPIs are not wired in V1.
    adSpend: null,
    attributedRevenue: null,
    roas: null,
    cpa: null,
  }

  const variants: GadsVariantRow[] = variantResult.rows
    .slice(0, VARIANT_ROW_LIMIT)
    .map((r) => {
      const assignments = asInt(r.assignments)
      const impressions = asInt(r.impressions)
      const redirects = asInt(r.redirects)
      const conversions = asInt(r.conversions)
      const avgBps = asNum(r.avg_served_probability_bps)
      return {
        site: r.site,
        family: r.family,
        experimentId: r.experiment_id,
        policyRuleId: r.policy_rule_id,
        branchId: r.branch_id,
        assignments,
        trafficShare: rate(assignments, totalAssignments) ?? 0,
        impressionRate: rate(impressions, assignments),
        redirectRate: rate(redirects, impressions),
        conversionRate: rate(conversions, assignments),
        avgServedProbability: avgBps === null ? null : avgBps / 10000,
        revenuePerAssignment: null,
        roas: null,
        cpa: null,
        lowSample: assignments < GADS_LANDING_PAGES_LOW_SAMPLE_THRESHOLD,
      }
    })

  const dqRow = dqResult.rows[0]
  const dataQuality: GadsDataQuality = {
    assignmentsMissingId: asInt(dqRow?.assignments_missing_id),
    unattributedStageEvents: asInt(dqRow?.unattributed_stage_events),
    lowSampleThreshold: GADS_LANDING_PAGES_LOW_SAMPLE_THRESHOLD,
  }

  return {
    scope: args.scope,
    range: { from: from.toISOString(), to: to.toISOString() },
    generatedAt: now.toISOString(),
    sites,
    attributionStatus: 'not-wired',
    kpis,
    funnel,
    variants,
    dataQuality,
  }
}
