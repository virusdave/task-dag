// GAds evolver introspection — Evolution read path (V1, phase P3).
//
// Backs GET /api/gads/evolution (helios/src/server/routes/gadsEvolution.ts),
// the aggregate loop-health surface of the per-site /metrics/gads-<site>/
// evolution page (parent epic virusdave/top-level#24, child automation#51).
//
// Design (authoritative: virusdave/top-level:docs/epics/
// gads-evolver-introspection/EPIC_PLAN.md §6; locked semantics: docs/
// helios/gads-evolver-introspection/P1_DATA_AUDIT_AND_SITE_SCOPE.md). This
// is an introspection surface for HOW HELIOS REACTED — observed
// policy-state movement over the evolver's own L2 attempts, NOT causal ad
// lift. The serving path reads ONLY `gads_ad_attempts` with a handful of
// bounded aggregate queries (the table is small + purpose-built; per the
// operator's DB-cost steer there is no per-event fact table, rollup,
// hypertable, CAGG, or HLL). L3 + landingpage_ad_outcomes enrichment is
// deferred to P6.
//
// Access: the per-site `site` predicate is derived SERVER-SIDE from the
// validated route scope via appendGadsSitePredicate — a per-site scope
// filters `site = $key` (unknown-scope `site is null` rows hidden), and
// only the gads-all grant sees the cross-site superset incl. NULL rows.
//
// Outcome vocabulary used below (gads_ad_attempts.outcome):
//   open       = outcome_observed_at is null OR outcome is null OR
//                outcome = 'unobserved'   (no terminal outcome yet)
//   terminal   = NOT open                 (an outcome was observed)
//   gradeable  = outcome in (success, partial, no_change, worse)
//                (superseded / ad_disappeared are terminal but NOT
//                 gradeable — they reflect race/deletion, not quality)

import type {
  GadsActionCount,
  GadsActionOutcomeRow,
  GadsActionType,
  GadsEvolutionResponse,
  GadsHotspot,
  GadsOutcome,
} from '../../../shared/contracts/index.js'
import { GadsActionTypeSchema } from '../../../shared/contracts/index.js'
import type { GadsScope } from '../../../shared/domain/gadsSites.js'
import { getPool, type Queryable } from '../pool.js'
import { appendGadsSitePredicate, sitesForScope } from './gadsAttemptScope.js'

const DAY_MS = 86_400_000

/** Default window when the caller omits from/to. The attempt feed can be
 *  a static historical window (P1), so the default is generous enough to
 *  still render the historical data rather than an empty 30d view. */
export const GADS_EVOLUTION_DEFAULT_WINDOW_DAYS = 90
/** Hard cap on the requested span. */
export const GADS_EVOLUTION_MAX_WINDOW_DAYS = 180
/** Gradeable-observed count below which the learning score is flagged
 *  low-sample (the UI warns the score is noisy). */
export const GADS_EVOLUTION_LOW_SAMPLE_THRESHOLD = 25
/** Open attempts older than this are "stale-open" (loop looks unhealthy). */
export const GADS_EVOLUTION_STALE_AFTER_DAYS = 7
/** Failed repair/replace attempts on one ad at/above this = do-not-retry. */
export const GADS_EVOLUTION_STUCK_THRESHOLD = 3
/** Max hotspot rows returned. */
export const GADS_EVOLUTION_HOTSPOT_LIMIT = 10

/** Canonical action-type order (stable UI shape; zero-filled). */
const ACTION_TYPES = GadsActionTypeSchema.options as readonly GadsActionType[]
const VALID_OUTCOMES = new Set<GadsOutcome>([
  'success',
  'partial',
  'no_change',
  'worse',
  'superseded',
  'ad_disappeared',
  'unobserved',
])

export interface GadsEvolutionArgs {
  readonly scope: GadsScope
  readonly from?: Date
  readonly to?: Date
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

/** ((success + 0.5*partial) - worse) / gradeable, or null when gradeable=0. */
function learningScore(
  success: number,
  partial: number,
  worse: number,
  gradeable: number,
): number | null {
  if (gradeable <= 0) return null
  return (success + 0.5 * partial - worse) / gradeable
}

function rate(numer: number, denom: number): number | null {
  if (!denom) return null
  return numer / denom
}

interface MatrixDbRow {
  action_type: string
  proposed: string
  observed: string
  success: string
  partial: string
  no_change: string
  worse: string
  superseded: string
  ad_disappeared: string
  open: string
}

interface ExtrasDbRow {
  stale_open: string | null
  median_latency_hours: string | number | null
  first_attempt_at: Date | string | null
  last_attempt_at: Date | string | null
}

interface PriorDbRow {
  success: string | null
  partial: string | null
  worse: string | null
  gradeable: string | null
}

interface WeeklyDbRow {
  week_start: string
  success: string
  partial: string
  worse: string
  gradeable: string
}

interface HotspotDbRow {
  ad_id: string
  campaign_name: string | null
  ad_group_name: string | null
  site: string | null
  attempts: string
  failed_repairs: string
  success: string
  open: string
  last_attempt_at: Date | string
  last_outcome: string | null
}

export async function getGadsEvolution(
  args: GadsEvolutionArgs,
): Promise<GadsEvolutionResponse> {
  const db = args.db ?? getPool()
  const now = new Date()

  // --- Resolve + clamp the half-open window [from, to). ---
  const to = args.to ?? now
  let from =
    args.from ?? new Date(to.getTime() - GADS_EVOLUTION_DEFAULT_WINDOW_DAYS * DAY_MS)
  if (from.getTime() >= to.getTime()) {
    from = new Date(to.getTime() - GADS_EVOLUTION_DEFAULT_WINDOW_DAYS * DAY_MS)
  }
  const maxSpanMs = GADS_EVOLUTION_MAX_WINDOW_DAYS * DAY_MS
  if (to.getTime() - from.getTime() > maxSpanMs) {
    from = new Date(to.getTime() - maxSpanMs)
  }
  // Prior window = the equal-length span immediately before `from`.
  const durationMs = to.getTime() - from.getTime()
  const priorFrom = new Date(from.getTime() - durationMs)
  const staleCutoff = new Date(now.getTime() - GADS_EVOLUTION_STALE_AFTER_DAYS * DAY_MS)

  const sites = sitesForScope(args.scope)
  const fromIso = from.toISOString()
  const toIso2 = to.toISOString()

  // Each query binds $1=from, $2=to (+ optional $3=site) so the shared
  // appendGadsSitePredicate helper always lands on $3.
  const baseParams = (): unknown[] => [fromIso, toIso2]
  const sitePred = (params: unknown[]): string => appendGadsSitePredicate(params, args.scope)

  // 1) Action/outcome matrix (one row per action_type present).
  const matrixParams = baseParams()
  const matrixSql = `
    select
      case
        when action_type in ('repair','replace','pause','monitor','trial_control','trial_variant')
          then action_type
        else 'monitor'
      end                                                                       as action_type,
      count(*)::bigint                                                          as proposed,
      count(*) filter (where outcome_observed_at is not null
                         and outcome is not null
                         and outcome <> 'unobserved')::bigint                   as observed,
      count(*) filter (where outcome = 'success')::bigint                       as success,
      count(*) filter (where outcome = 'partial')::bigint                       as partial,
      count(*) filter (where outcome = 'no_change')::bigint                     as no_change,
      count(*) filter (where outcome = 'worse')::bigint                         as worse,
      count(*) filter (where outcome = 'superseded')::bigint                    as superseded,
      count(*) filter (where outcome = 'ad_disappeared')::bigint                as ad_disappeared,
      count(*) filter (where outcome_observed_at is null
                         or outcome is null
                         or outcome = 'unobserved')::bigint                     as open
    from gads_ad_attempts
    where created_at >= $1 and created_at < $2
      ${sitePred(matrixParams)}
    group by 1
  `

  // 2) Window extras: stale-open count, median proposal->outcome latency,
  //    and freshness (min/max created_at).
  const extrasParams = baseParams()
  const extrasSitePred = sitePred(extrasParams)
  extrasParams.push(staleCutoff.toISOString())
  const staleParam = `$${extrasParams.length}`
  const extrasSql = `
    select
      count(*) filter (where (outcome_observed_at is null
                               or outcome is null
                               or outcome = 'unobserved')
                         and created_at < ${staleParam}::timestamptz)::bigint   as stale_open,
      percentile_cont(0.5) within group (
        order by (extract(epoch from (outcome_observed_at - created_at)) / 3600.0)::double precision
      ) filter (where outcome_observed_at is not null
                  and outcome is not null
                  and outcome <> 'unobserved'
                  and outcome_observed_at >= created_at)                        as median_latency_hours,
      min(created_at)                                                           as first_attempt_at,
      max(created_at)                                                           as last_attempt_at
    from gads_ad_attempts
    where created_at >= $1 and created_at < $2
      ${extrasSitePred}
  `

  // 3) Do-not-retry pressure: ads with >= threshold failed repair/replace.
  const stuckParams = baseParams()
  const stuckSitePred = sitePred(stuckParams)
  stuckParams.push(GADS_EVOLUTION_STUCK_THRESHOLD)
  const stuckThresholdParam = `$${stuckParams.length}`
  const stuckSql = `
    select count(*)::bigint as stuck_ads
    from (
      select ad_id
      from gads_ad_attempts
      where created_at >= $1 and created_at < $2
        and action_type in ('repair', 'replace')
        and outcome in ('no_change', 'worse', 'partial')
        ${stuckSitePred}
      group by ad_id
      having count(*) >= ${stuckThresholdParam}
    ) s
  `

  // 4) Prior-window heartbeat inputs (equal-length window before `from`).
  const priorParams: unknown[] = [priorFrom.toISOString(), fromIso]
  const priorSql = `
    select
      count(*) filter (where outcome = 'success')::bigint                       as success,
      count(*) filter (where outcome = 'partial')::bigint                       as partial,
      count(*) filter (where outcome = 'worse')::bigint                         as worse,
      count(*) filter (where outcome in ('success','partial','no_change','worse'))::bigint as gradeable
    from gads_ad_attempts
    where created_at >= $1 and created_at < $2
      ${appendGadsSitePredicate(priorParams, args.scope)}
  `

  // 5) Weekly heartbeat sparkline (NY-local week buckets).
  const weeklyParams = baseParams()
  const weeklySql = `
    select
      to_char(date_trunc('week', (created_at at time zone 'America/New_York')), 'YYYY-MM-DD') as week_start,
      count(*) filter (where outcome = 'success')::bigint                       as success,
      count(*) filter (where outcome = 'partial')::bigint                       as partial,
      count(*) filter (where outcome = 'worse')::bigint                         as worse,
      count(*) filter (where outcome in ('success','partial','no_change','worse'))::bigint as gradeable
    from gads_ad_attempts
    where created_at >= $1 and created_at < $2
      ${sitePred(weeklyParams)}
    group by week_start
    order by week_start asc
  `

  // 6) Hotspots — where Helios keeps failing (bounded; fetch limit+1 to
  //    detect truncation).
  const hotspotParams = baseParams()
  const hotspotSitePred = sitePred(hotspotParams)
  hotspotParams.push(GADS_EVOLUTION_HOTSPOT_LIMIT + 1)
  const hotspotLimitParam = `$${hotspotParams.length}`
  const hotspotSql = `
    select
      ad_id,
      max(campaign_name)                                                        as campaign_name,
      max(ad_group_name)                                                        as ad_group_name,
      max(site)                                                                 as site,
      count(*)::bigint                                                          as attempts,
      count(*) filter (where action_type in ('repair','replace')
                         and outcome in ('no_change','worse','partial'))::bigint as failed_repairs,
      count(*) filter (where outcome = 'success')::bigint                       as success,
      count(*) filter (where outcome_observed_at is null
                         or outcome is null
                         or outcome = 'unobserved')::bigint                     as open,
      max(created_at)                                                           as last_attempt_at,
      (array_agg(outcome order by created_at desc))[1]                          as last_outcome
    from gads_ad_attempts
    where created_at >= $1 and created_at < $2
      ${hotspotSitePred}
    group by ad_id
    having count(*) filter (where action_type in ('repair','replace')
                              and outcome in ('no_change','worse','partial')) >= 1
        or count(*) filter (where outcome = 'worse') >= 1
    order by failed_repairs desc, attempts desc, last_attempt_at desc
    limit ${hotspotLimitParam}
  `

  const [matrixRes, extrasRes, stuckRes, priorRes, weeklyRes, hotspotRes] =
    await Promise.all([
      db.query<MatrixDbRow>(matrixSql, matrixParams),
      db.query<ExtrasDbRow>(extrasSql, extrasParams),
      db.query<{ stuck_ads: string }>(stuckSql, stuckParams),
      db.query<PriorDbRow>(priorSql, priorParams),
      db.query<WeeklyDbRow>(weeklySql, weeklyParams),
      db.query<HotspotDbRow>(hotspotSql, hotspotParams),
    ])

  // --- Matrix -> per-action map + window totals (zero-filled, stable order). ---
  const byAction = new Map<string, MatrixDbRow>()
  for (const r of matrixRes.rows) byAction.set(r.action_type, r)

  let totProposed = 0
  let totObserved = 0
  let totSuccess = 0
  let totPartial = 0
  let totNoChange = 0
  let totWorse = 0
  let totSuperseded = 0
  let totAdDisappeared = 0
  let totOpen = 0

  const actionOutcomeMatrix: GadsActionOutcomeRow[] = []
  const proposedByActionType: GadsActionCount[] = []
  for (const actionType of ACTION_TYPES) {
    const r = byAction.get(actionType)
    const proposed = asInt(r?.proposed)
    const observed = asInt(r?.observed)
    const success = asInt(r?.success)
    const partial = asInt(r?.partial)
    const noChange = asInt(r?.no_change)
    const worse = asInt(r?.worse)
    const superseded = asInt(r?.superseded)
    const adDisappeared = asInt(r?.ad_disappeared)
    const open = asInt(r?.open)

    totProposed += proposed
    totObserved += observed
    totSuccess += success
    totPartial += partial
    totNoChange += noChange
    totWorse += worse
    totSuperseded += superseded
    totAdDisappeared += adDisappeared
    totOpen += open

    actionOutcomeMatrix.push({
      actionType,
      proposed,
      observed,
      success,
      partial,
      noChange,
      worse,
      superseded,
      adDisappeared,
      open,
    })
    proposedByActionType.push({ actionType, count: proposed })
  }

  const gradeableObserved = totSuccess + totPartial + totNoChange + totWorse
  const score = learningScore(totSuccess, totPartial, totWorse, gradeableObserved)

  const prior = priorRes.rows[0]
  const priorGradeable = asInt(prior?.gradeable)
  const priorScore = learningScore(
    asInt(prior?.success),
    asInt(prior?.partial),
    asInt(prior?.worse),
    priorGradeable,
  )
  const delta = score !== null && priorScore !== null ? score - priorScore : null

  const weekly = weeklyRes.rows.map((w) => {
    const g = asInt(w.gradeable)
    return {
      weekStart: w.week_start,
      score: learningScore(asInt(w.success), asInt(w.partial), asInt(w.worse), g),
      gradeableObserved: g,
    }
  })

  const extras = extrasRes.rows[0]
  const medianLatencyHours = asNum(extras?.median_latency_hours)
  const staleOpen = asInt(extras?.stale_open)
  const stuckAds = asInt(stuckRes.rows[0]?.stuck_ads)

  // --- Hotspots (slice off the +1 truncation probe). ---
  const hotspotRows = hotspotRes.rows
  const hotspotsTruncated = hotspotRows.length > GADS_EVOLUTION_HOTSPOT_LIMIT
  const hotspots: GadsHotspot[] = hotspotRows
    .slice(0, GADS_EVOLUTION_HOTSPOT_LIMIT)
    .map((h) => ({
      adId: h.ad_id,
      campaignName: h.campaign_name,
      adGroupName: h.ad_group_name,
      site: h.site === 'bronx' || h.site === 'midtown' ? h.site : null,
      attempts: asInt(h.attempts),
      failedRepairs: asInt(h.failed_repairs),
      success: asInt(h.success),
      open: asInt(h.open),
      lastAttemptAt: toIso(h.last_attempt_at) ?? now.toISOString(),
      lastOutcome:
        h.last_outcome && VALID_OUTCOMES.has(h.last_outcome as GadsOutcome)
          ? (h.last_outcome as GadsOutcome)
          : null,
    }))

  const lastAttemptAt = toIso(extras?.last_attempt_at)
  const isStale =
    lastAttemptAt !== null &&
    new Date(lastAttemptAt).getTime() < staleCutoff.getTime()

  return {
    scope: args.scope,
    range: { from: fromIso, to: toIso2 },
    generatedAt: now.toISOString(),
    sites,
    freshness: {
      firstAttemptAt: toIso(extras?.first_attempt_at),
      lastAttemptAt,
      isStale,
      staleAfterDays: GADS_EVOLUTION_STALE_AFTER_DAYS,
    },
    heartbeat: {
      score,
      priorScore,
      delta,
      gradeableObserved,
      proposed: totProposed,
      terminalObserved: totObserved,
      coverage: rate(totObserved, totProposed),
      lowSample: gradeableObserved < GADS_EVOLUTION_LOW_SAMPLE_THRESHOLD,
      lowSampleThreshold: GADS_EVOLUTION_LOW_SAMPLE_THRESHOLD,
      weekly,
    },
    loopHealth: {
      proposed: totProposed,
      proposedByActionType,
      observed: totObserved,
      open: totOpen,
      staleOpen,
      netImprovementRate: rate(totSuccess + totPartial, totObserved),
      wasteShare: rate(totNoChange + totWorse + totSuperseded, totObserved),
      medianLatencyHours,
      stuckAds,
      stuckThreshold: GADS_EVOLUTION_STUCK_THRESHOLD,
    },
    actionOutcomeMatrix,
    hotspots,
    hotspotsTruncated,
    hotspotLimit: GADS_EVOLUTION_HOTSPOT_LIMIT,
  }
}
