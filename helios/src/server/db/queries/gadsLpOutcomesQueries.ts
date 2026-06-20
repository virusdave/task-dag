// GAds evolver introspection — LP-evolver reaction read path (V1, phase P6).
//
// Backs the LP section of GET /api/gads/enrichment
// (helios/src/server/routes/gadsEnrichment.ts), the "LP-evolver reaction"
// panel of the per-site /metrics/gads-<site>/evolution page (parent epic
// virusdave/top-level#24, child automation#51, EPIC_PLAN §6 item 6).
//
// Reads ONLY `landingpage_ad_outcomes` with a handful of bounded aggregate
// queries (the table is ~63 rows in prod — a single historical ingest, no
// confirmed live writer — so this is cheap; per the operator's DB-cost
// steer there is no per-event fact table / rollup / hypertable / CAGG /
// HLL). The UI badges the "single historical ingest" / empty states
// honestly.
//
// Access: the per-site `site` predicate is derived SERVER-SIDE from the
// validated route scope via appendGadsSitePredicate — a per-site scope
// filters `site = $key` (unknown-scope `site is null` rows hidden), and
// only the gads-all grant sees the cross-site superset incl. NULL rows.
// `site` was added to this table by migration 093 (P2) with the same
// mapGeoToGadsSite derivation as gads_ad_attempts.
//
// "observed vs pending" is derived from `outcome_observed_at` (not the
// free-text `outcome_status`, which migration 044 does not constrain).

import type { GadsLpSection } from '../../../shared/contracts/index.js'
import type { GadsScope } from '../../../shared/domain/gadsSites.js'
import { getPool, type Queryable } from '../pool.js'
import { appendGadsSitePredicate } from './gadsAttemptScope.js'

/** Max {signal × action × status} groups returned (fetch +1 to detect
 *  truncation). The real cardinality is tiny, but bound it anyway. */
export const GADS_LP_GROUP_LIMIT = 50
/** Max landing-page buckets returned (fetch +1 to detect truncation). */
export const GADS_LP_TOP_PAGES_LIMIT = 10

export interface GadsLpOutcomesArgs {
  readonly scope: GadsScope
  readonly db?: Queryable
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
function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

interface TotalsRow {
  total_rows: string | null
  observed_rows: string | null
  avg_confidence: string | number | null
  first_created_at: Date | string | null
  last_created_at: Date | string | null
  first_observed_at: Date | string | null
  last_observed_at: Date | string | null
  distinct_created_days: string | null
}

interface GroupRow {
  signal_type: string | null
  planned_action: string | null
  outcome_status: string | null
  count: string
  avg_confidence: string | number | null
}

interface PageRow {
  landing_page_key: string | null
  count: string
  observed: string
  pending: string
}

export async function getGadsLpOutcomes(
  args: GadsLpOutcomesArgs,
): Promise<GadsLpSection> {
  const db = args.db ?? getPool()

  // 1) Window totals: rows, observed/pending split, avg confidence,
  //    first/last created + observed timestamps, and the count of distinct
  //    NY-local created days (to flag a single-ingest historical dump).
  const totalsParams: unknown[] = []
  const totalsSql = `
    select
      count(*)::bigint                                                          as total_rows,
      count(*) filter (where outcome_observed_at is not null)::bigint           as observed_rows,
      avg(signal_confidence)                                                    as avg_confidence,
      min(created_at)                                                           as first_created_at,
      max(created_at)                                                           as last_created_at,
      min(outcome_observed_at)                                                  as first_observed_at,
      max(outcome_observed_at)                                                  as last_observed_at,
      count(distinct (created_at at time zone 'America/New_York')::date)::bigint as distinct_created_days
    from landingpage_ad_outcomes
    where true
      ${appendGadsSitePredicate(totalsParams, args.scope)}
  `

  // 2) signal_type × planned_action × outcome_status groups (bounded).
  const groupParams: unknown[] = []
  const groupSitePred = appendGadsSitePredicate(groupParams, args.scope)
  groupParams.push(GADS_LP_GROUP_LIMIT + 1)
  const groupLimitParam = `$${groupParams.length}`
  const groupSql = `
    select
      signal_type,
      planned_action,
      outcome_status,
      count(*)::bigint as count,
      avg(signal_confidence) as avg_confidence
    from landingpage_ad_outcomes
    where true
      ${groupSitePred}
    group by signal_type, planned_action, outcome_status
    order by count desc, signal_type asc, planned_action asc, outcome_status asc
    limit ${groupLimitParam}
  `

  // 3) Top landing pages by row count (by landing_page_key — never the raw
  //    final_url). Fetch +1 to detect truncation.
  const pageParams: unknown[] = []
  const pageSitePred = appendGadsSitePredicate(pageParams, args.scope)
  pageParams.push(GADS_LP_TOP_PAGES_LIMIT + 1)
  const pageLimitParam = `$${pageParams.length}`
  const pageSql = `
    select
      landing_page_key,
      count(*)::bigint                                                as count,
      count(*) filter (where outcome_observed_at is not null)::bigint as observed,
      count(*) filter (where outcome_observed_at is null)::bigint     as pending
    from landingpage_ad_outcomes
    where true
      ${pageSitePred}
    group by landing_page_key
    order by count desc, landing_page_key asc
    limit ${pageLimitParam}
  `

  const [totalsRes, groupRes, pageRes] = await Promise.all([
    db.query<TotalsRow>(totalsSql, totalsParams),
    db.query<GroupRow>(groupSql, groupParams),
    db.query<PageRow>(pageSql, pageParams),
  ])

  const totals = totalsRes.rows[0]
  const totalRows = asInt(totals?.total_rows)
  const observedRows = asInt(totals?.observed_rows)
  const pendingRows = Math.max(0, totalRows - observedRows)
  const distinctDays = asInt(totals?.distinct_created_days)

  const groupRows = groupRes.rows
  const byGroupTruncated = groupRows.length > GADS_LP_GROUP_LIMIT
  const byGroup = groupRows.slice(0, GADS_LP_GROUP_LIMIT).map((g) => ({
    signalType: g.signal_type ?? 'unknown',
    plannedAction: g.planned_action ?? 'unknown',
    outcomeStatus: g.outcome_status ?? 'unknown',
    count: asInt(g.count),
    avgConfidence: asNum(g.avg_confidence),
  }))

  const pageRows = pageRes.rows
  const topLandingPagesTruncated = pageRows.length > GADS_LP_TOP_PAGES_LIMIT
  const topLandingPages = pageRows
    .slice(0, GADS_LP_TOP_PAGES_LIMIT)
    .map((p) => ({
      landingPageKey: p.landing_page_key ?? 'unknown',
      count: asInt(p.count),
      observed: asInt(p.observed),
      pending: asInt(p.pending),
    }))

  return {
    available: totalRows > 0,
    totalRows,
    observedRows,
    pendingRows,
    avgConfidence: asNum(totals?.avg_confidence),
    firstCreatedAt: toIso(totals?.first_created_at),
    lastCreatedAt: toIso(totals?.last_created_at),
    firstOutcomeObservedAt: toIso(totals?.first_observed_at),
    lastOutcomeObservedAt: toIso(totals?.last_observed_at),
    // One distinct created-day over a non-empty table = a single ingest.
    singleIngest: totalRows > 0 && distinctDays <= 1,
    byGroup,
    byGroupTruncated,
    topLandingPages,
    topLandingPagesTruncated,
  }
}
