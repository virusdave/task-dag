// GAds → Landing pages analytics read path (V1, phase P3).
//
// Backs GET /api/gads/landing-pages (helios/src/server/routes/
// gadsLandingPages.ts), the first sub-page of the GAds analytics
// surface (parent epic virusdave/top-level#18, child automation#47).
//
// Design (authoritative: docs/epics/gads-landing-analytics/EPIC_PLAN.md
// §3 + child EPIC_PLAN P3; locked semantics: docs/helios/
// gads-landing-analytics/P0_AUDIT.md; second Oracle review). The serving
// path reads ONLY the day-grain `gads_lp_rollup` table + the singleton
// `gads_lp_rollup_refresh_state` row — NEVER raw lp_events. The rollup is
// recomputed out-of-band by config.workers.gads_lp_rollup_refresh
// (gadsLpRollupQueries.ts) on a ~60-min cadence. This keeps every
// dashboard load cheap (a tiny indexed scan of an aggregate table), per
// the operator's binding DB-cost steer (epic #11): this is observed
// performance for rapid hill-climbing, not an accounting system, so we
// accept day-grain bucketing and ~refresh-cadence staleness in exchange
// for minimal DB footprint. A unit test asserts no 'lp_events' appears in
// any SQL on this path.
//
// Semantics (all from the rollup, which already encodes them):
//   - Funnel counts are assignment-level-unique (the refresh dedupes via
//     distinct/bool_or). assignment_day is the assignment's NY-local date.
//   - "Converted" uses the 30-day assignment-time attribution window
//     (conversions_30d) to match the default analysis window; 7d/90d are
//     also in the rollup for a future contract extension.
//   - Cost / revenue / ROAS are not wired in V1 (no in-DB cost snapshot);
//     the rollup carries cost_attribution_status = 'unavailable', which we
//     surface honestly as null money KPIs (UI badge), never fake zeros.

import {
  GADS_SITES,
  type GadsScope,
  type GadsSiteKey,
} from '../../../shared/domain/gadsSites.js'
import type {
  GadsAttributionStatus,
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
/** Hard cap on the requested span. The rollup only retains a bounded
 *  horizon, so windows beyond it simply return fewer day rows. */
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

/** The concrete gads_lp_rollup.site values a scope covers. */
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

/** One variant grain, aggregated across day/policy_id/cluster within the
 *  requested window. */
interface VariantAggRow {
  site: string
  family: string | null
  experiment_id: string | null
  policy_rule_id: string | null
  branch_id: string | null
  assignments: string
  impressions: string
  redirects: string
  conversions_30d: string
  sum_served_prob_bps: string
  assignments_with_prob: string
  has_allocated: boolean
  has_unavailable: boolean
}

interface RefreshStateRow {
  assignments_missing_id: string | number | null
  unattributed_stage_events: string | number | null
}

/** Map the rollup's per-row cost_attribution_status aggregate to the
 *  response enum, honestly reflecting mixed states. */
function attributionStatusFrom(hasAllocated: boolean, hasUnavailable: boolean): GadsAttributionStatus {
  if (hasAllocated && !hasUnavailable) return 'allocated'
  if (hasAllocated && hasUnavailable) return 'incomplete'
  return 'not-wired'
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

  // Bind params. $1 from, $2 to, $3 site list. The window timestamps are
  // mapped to NY-local assignment_day dates (the rollup grain). Optional
  // family / experiment filters appended afterwards.
  const params: unknown[] = [from.toISOString(), to.toISOString(), sites]
  const filters: string[] = []
  if (args.family) {
    params.push(args.family)
    filters.push(`and family = $${params.length}`)
  }
  if (args.experimentId) {
    params.push(args.experimentId)
    filters.push(`and experiment_id = $${params.length}`)
  }
  const filterSql = filters.join('\n        ')

  // Aggregate the rollup to the variant grain over the window. The rollup
  // is small (one row per day x placement x provenance), so this is a
  // cheap indexed scan (gads_lp_rollup_site_day_idx) + group-by. We sum
  // across day / policy_id / cluster_slug, which the variant grain does
  // not distinguish.
  const variantSql = `
    select
      site,
      family,
      experiment_id,
      policy_rule_id,
      branch_id,
      sum(assignments)::bigint                                  as assignments,
      sum(impressions)::bigint                                  as impressions,
      sum(redirects)::bigint                                    as redirects,
      sum(conversions_30d)::bigint                              as conversions_30d,
      sum(sum_served_prob_bps)::bigint                          as sum_served_prob_bps,
      sum(assignments_with_prob)::bigint                        as assignments_with_prob,
      bool_or(cost_attribution_status = 'allocated')            as has_allocated,
      bool_or(cost_attribution_status = 'unavailable')          as has_unavailable
    from gads_lp_rollup
    where site = any($3::text[])
      and assignment_day >= ($1::timestamptz at time zone 'America/New_York')::date
      and assignment_day <  ($2::timestamptz at time zone 'America/New_York')::date
      ${filterSql}
    group by site, family, experiment_id, policy_rule_id, branch_id
    order by assignments desc, site, family, experiment_id, branch_id
  `

  // Data quality is recorded on the refresh-state row by the out-of-band
  // job (so the serving path never scans lp_events). It is an
  // as-of-last-refresh, horizon-bounded snapshot, not per-window.
  const stateSql = `
    select assignments_missing_id, unattributed_stage_events
      from gads_lp_rollup_refresh_state
     where id = 'singleton'
  `

  const [variantResult, stateResult] = await Promise.all([
    db.query<VariantAggRow>(variantSql, params),
    db.query<RefreshStateRow>(stateSql),
  ])

  // --- Aggregate funnel + KPI totals + attribution from variant rows. ---
  let totalAssignments = 0
  let totalImpressions = 0
  let totalRedirects = 0
  let totalConversions = 0
  let anyAllocated = false
  let anyUnavailable = false
  for (const r of variantResult.rows) {
    totalAssignments += asInt(r.assignments)
    totalImpressions += asInt(r.impressions)
    totalRedirects += asInt(r.redirects)
    totalConversions += asInt(r.conversions_30d)
    anyAllocated = anyAllocated || r.has_allocated === true
    anyUnavailable = anyUnavailable || r.has_unavailable === true
  }
  const attributionStatus = attributionStatusFrom(anyAllocated, anyUnavailable)

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
    // Money KPIs are not wired in V1 (no in-DB cost snapshot).
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
      const conversions = asInt(r.conversions_30d)
      const sumBps = asInt(r.sum_served_prob_bps)
      const withProb = asInt(r.assignments_with_prob)
      const avgBps = withProb > 0 ? sumBps / withProb : null
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

  const stateRow = stateResult.rows[0]
  const dataQuality: GadsDataQuality = {
    assignmentsMissingId: asInt(stateRow?.assignments_missing_id),
    unattributedStageEvents: asInt(stateRow?.unattributed_stage_events),
    lowSampleThreshold: GADS_LANDING_PAGES_LOW_SAMPLE_THRESHOLD,
  }

  return {
    scope: args.scope,
    range: { from: from.toISOString(), to: to.toISOString() },
    generatedAt: now.toISOString(),
    sites,
    attributionStatus,
    kpis,
    funnel,
    variants,
    dataQuality,
  }
}
