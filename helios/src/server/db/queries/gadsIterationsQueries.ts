// GAds evolver introspection — Iteration read path (V1, phase P3).
//
// Backs GET /api/gads/iterations and /api/gads/iterations/:runId
// (helios/src/server/routes/gadsIterations.ts), the per-run timeline +
// drilldown of the /metrics/gads-<site>/iteration page (parent epic
// virusdave/top-level#24, child automation#51).
//
// V1 reads ONLY `gads_ad_attempts` (DB-derived). The on-disk L2 JSON /
// morning-bundle decision summary (snapshot age, prompt/config versions,
// L1 rule proposals, bundle download) is deferred to P5. The serving path
// is bounded aggregate queries + a capped attempt-row read.
//
// Access: the per-site `site` predicate is derived SERVER-SIDE from the
// validated route scope via appendGadsSitePredicate (a per-site scope sees
// only that site's rows of a possibly-cross-site run; unknown-scope rows
// hidden per-site, visible only under gads-all). The :runId path param is
// opaque, validated by the route, and ALWAYS parameterised. A run with no
// rows visible under the scope returns null (route -> 404) so the response
// never reveals the existence of cross-scope rows.

import type {
  GadsActionCount,
  GadsActionType,
  GadsIterationAttempt,
  GadsIterationRunDetailResponse,
  GadsIterationRunSummary,
  GadsIterationRunsResponse,
  GadsOutcome,
  GadsRunOutcomeCounts,
} from '../../../shared/contracts/index.js'
import { GadsActionTypeSchema } from '../../../shared/contracts/index.js'
import type { GadsScope } from '../../../shared/domain/gadsSites.js'
import { getPool, type Queryable } from '../pool.js'
import { appendGadsSitePredicate, sitesForScope } from './gadsAttemptScope.js'
import { GADS_EVOLUTION_STALE_AFTER_DAYS } from './gadsEvolutionQueries.js'

const DAY_MS = 86_400_000

/** Default runs returned when the caller omits ?limit. */
export const GADS_ITERATION_RUNS_DEFAULT_LIMIT = 25
/** Hard cap on the runs list. */
export const GADS_ITERATION_RUNS_MAX_LIMIT = 100
/** Cap on attempt rows in a run drilldown. */
export const GADS_ITERATION_ATTEMPT_LIMIT = 250
/** Stale-open threshold shared with the Evolution surface. */
export const GADS_ITERATION_STALE_AFTER_DAYS = GADS_EVOLUTION_STALE_AFTER_DAYS

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

function asInt(v: unknown): number {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.round(n) : 0
}
function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

interface RunCountDbRow {
  run_id?: string
  first_attempt_at: Date | string | null
  last_attempt_at: Date | string | null
  attempts: string
  ads: string
  observed: string
  open: string
  stale_open: string
  a_repair: string
  a_replace: string
  a_pause: string
  a_monitor: string
  a_trial_control: string
  a_trial_variant: string
  o_success: string
  o_partial: string
  o_no_change: string
  o_worse: string
  o_superseded: string
  o_ad_disappeared: string
}

/** The per-run aggregate select columns, shared by the runs list and the
 *  run-detail summary. `staleParam` is the positional placeholder
 *  ($N::timestamptz) for the stale-open cutoff. */
function runCountColumns(staleParam: string): string {
  return `
    min(created_at)                                                             as first_attempt_at,
    max(created_at)                                                             as last_attempt_at,
    count(*)::bigint                                                            as attempts,
    count(distinct ad_id)::bigint                                              as ads,
    count(*) filter (where outcome_observed_at is not null
                       and outcome is not null
                       and outcome <> 'unobserved')::bigint                     as observed,
    count(*) filter (where outcome_observed_at is null
                       or outcome is null
                       or outcome = 'unobserved')::bigint                       as open,
    count(*) filter (where (outcome_observed_at is null
                             or outcome is null
                             or outcome = 'unobserved')
                       and created_at < ${staleParam}::timestamptz)::bigint     as stale_open,
    count(*) filter (where action_type = 'repair')::bigint                      as a_repair,
    count(*) filter (where action_type = 'replace')::bigint                     as a_replace,
    count(*) filter (where action_type = 'pause')::bigint                       as a_pause,
    count(*) filter (where action_type = 'monitor'
                       or action_type not in
                          ('repair','replace','pause','trial_control','trial_variant'))::bigint as a_monitor,
    count(*) filter (where action_type = 'trial_control')::bigint              as a_trial_control,
    count(*) filter (where action_type = 'trial_variant')::bigint              as a_trial_variant,
    count(*) filter (where outcome = 'success')::bigint                         as o_success,
    count(*) filter (where outcome = 'partial')::bigint                         as o_partial,
    count(*) filter (where outcome = 'no_change')::bigint                       as o_no_change,
    count(*) filter (where outcome = 'worse')::bigint                           as o_worse,
    count(*) filter (where outcome = 'superseded')::bigint                      as o_superseded,
    count(*) filter (where outcome = 'ad_disappeared')::bigint                  as o_ad_disappeared
  `
}

function actionCountsFrom(r: RunCountDbRow): GadsActionCount[] {
  const byType: Record<GadsActionType, number> = {
    repair: asInt(r.a_repair),
    replace: asInt(r.a_replace),
    pause: asInt(r.a_pause),
    monitor: asInt(r.a_monitor),
    trial_control: asInt(r.a_trial_control),
    trial_variant: asInt(r.a_trial_variant),
  }
  return ACTION_TYPES.map((actionType) => ({ actionType, count: byType[actionType] }))
}

function outcomeCountsFrom(r: RunCountDbRow): GadsRunOutcomeCounts {
  return {
    success: asInt(r.o_success),
    partial: asInt(r.o_partial),
    noChange: asInt(r.o_no_change),
    worse: asInt(r.o_worse),
    superseded: asInt(r.o_superseded),
    adDisappeared: asInt(r.o_ad_disappeared),
    open: asInt(r.open),
  }
}

function rowToRunSummary(runId: string, r: RunCountDbRow, now: Date): GadsIterationRunSummary {
  return {
    runId,
    firstAttemptAt: toIso(r.first_attempt_at) ?? now.toISOString(),
    lastAttemptAt: toIso(r.last_attempt_at) ?? now.toISOString(),
    attempts: asInt(r.attempts),
    ads: asInt(r.ads),
    observed: asInt(r.observed),
    open: asInt(r.open),
    staleOpen: asInt(r.stale_open),
    actionCounts: actionCountsFrom(r),
    outcomeCounts: outcomeCountsFrom(r),
  }
}

// ============================ Runs list ====================================

export interface GadsIterationRunsArgs {
  readonly scope: GadsScope
  readonly limit?: number
  readonly db?: Queryable
}

export async function getGadsIterationRuns(
  args: GadsIterationRunsArgs,
): Promise<GadsIterationRunsResponse> {
  const db = args.db ?? getPool()
  const now = new Date()
  const staleCutoff = new Date(now.getTime() - GADS_ITERATION_STALE_AFTER_DAYS * DAY_MS)

  const limit = Math.min(
    Math.max(1, Math.trunc(args.limit ?? GADS_ITERATION_RUNS_DEFAULT_LIMIT)),
    GADS_ITERATION_RUNS_MAX_LIMIT,
  )

  const params: unknown[] = []
  const sitePred = appendGadsSitePredicate(params, args.scope)
  params.push(staleCutoff.toISOString())
  const staleParam = `$${params.length}`
  params.push(limit + 1) // +1 probe for truncation
  const limitParam = `$${params.length}`

  const sql = `
    select
      run_id,
      ${runCountColumns(staleParam)}
    from gads_ad_attempts
    where true
      ${sitePred}
    group by run_id
    order by max(created_at) desc
    limit ${limitParam}
  `

  const res = await db.query<RunCountDbRow>(sql, params)
  const truncated = res.rows.length > limit
  const runs = res.rows
    .slice(0, limit)
    .map((r) => rowToRunSummary(String(r.run_id), r, now))

  return {
    scope: args.scope,
    generatedAt: now.toISOString(),
    sites: sitesForScope(args.scope),
    staleAfterDays: GADS_ITERATION_STALE_AFTER_DAYS,
    runs,
    truncated,
    limit,
  }
}

// ============================ Run detail ===================================

const ATTEMPT_COLUMNS = `
  id,
  created_at,
  ad_id,
  campaign_name,
  ad_group_name,
  site,
  action_type,
  rationale,
  before_serving_status,
  before_policy_status,
  before_headlines,
  before_descriptions,
  before_final_url,
  proposed_headlines,
  proposed_descriptions,
  proposed_final_url,
  outcome_observed_at,
  outcome_serving_status,
  outcome_policy_status,
  outcome,
  outcome_notes
`

interface AttemptDbRow {
  id: string | number
  created_at: Date | string
  ad_id: string
  campaign_name: string | null
  ad_group_name: string | null
  site: string | null
  action_type: string
  rationale: string | null
  before_serving_status: string | null
  before_policy_status: string | null
  before_headlines: string[] | null
  before_descriptions: string[] | null
  before_final_url: string | null
  proposed_headlines: string[] | null
  proposed_descriptions: string[] | null
  proposed_final_url: string | null
  outcome_observed_at: Date | string | null
  outcome_serving_status: string | null
  outcome_policy_status: string | null
  outcome: string | null
  outcome_notes: string | null
}

function normalizeSite(site: string | null): string | null {
  return site === 'bronx' || site === 'midtown' ? site : null
}
function normalizeActionType(v: string): GadsActionType {
  return (ACTION_TYPES as readonly string[]).includes(v) ? (v as GadsActionType) : 'monitor'
}

function rowToAttempt(r: AttemptDbRow): GadsIterationAttempt {
  return {
    id: Number(r.id),
    createdAt: toIso(r.created_at) ?? new Date(0).toISOString(),
    adId: r.ad_id,
    campaignName: r.campaign_name,
    adGroupName: r.ad_group_name,
    site: normalizeSite(r.site),
    actionType: normalizeActionType(r.action_type),
    rationale: r.rationale,
    beforeServingStatus: r.before_serving_status,
    beforePolicyStatus: r.before_policy_status,
    beforeHeadlines: r.before_headlines,
    beforeDescriptions: r.before_descriptions,
    beforeFinalUrl: r.before_final_url,
    proposedHeadlines: r.proposed_headlines,
    proposedDescriptions: r.proposed_descriptions,
    proposedFinalUrl: r.proposed_final_url,
    outcomeObservedAt: toIso(r.outcome_observed_at),
    outcomeServingStatus: r.outcome_serving_status,
    outcomePolicyStatus: r.outcome_policy_status,
    outcome:
      r.outcome && VALID_OUTCOMES.has(r.outcome as GadsOutcome)
        ? (r.outcome as GadsOutcome)
        : null,
    outcomeNotes: r.outcome_notes,
  }
}

export interface GadsIterationRunDetailArgs {
  readonly scope: GadsScope
  readonly runId: string
  readonly db?: Queryable
}

/**
 * Returns the run detail scoped to `scope`, or `null` when the run has no
 * rows visible under the scope (the route maps null -> 404, so a per-site
 * caller can never tell a cross-site run exists).
 */
export async function getGadsIterationRunDetail(
  args: GadsIterationRunDetailArgs,
): Promise<GadsIterationRunDetailResponse | null> {
  const db = args.db ?? getPool()
  const now = new Date()
  const staleCutoff = new Date(now.getTime() - GADS_ITERATION_STALE_AFTER_DAYS * DAY_MS)

  // --- Summary aggregate over ALL scoped rows of the run. ---
  const summaryParams: unknown[] = [args.runId]
  const summarySitePred = appendGadsSitePredicate(summaryParams, args.scope)
  summaryParams.push(staleCutoff.toISOString())
  const staleParam = `$${summaryParams.length}`
  const summarySql = `
    select
      ${runCountColumns(staleParam)}
    from gads_ad_attempts
    where run_id = $1
      ${summarySitePred}
  `

  // --- Bounded attempt rows for the run (fetch +1 to detect truncation). ---
  const attemptParams: unknown[] = [args.runId]
  const attemptSitePred = appendGadsSitePredicate(attemptParams, args.scope)
  attemptParams.push(GADS_ITERATION_ATTEMPT_LIMIT + 1)
  const attemptLimitParam = `$${attemptParams.length}`
  const attemptsSql = `
    select ${ATTEMPT_COLUMNS}
    from gads_ad_attempts
    where run_id = $1
      ${attemptSitePred}
    order by created_at asc, id asc
    limit ${attemptLimitParam}
  `

  const [summaryRes, attemptsRes] = await Promise.all([
    db.query<RunCountDbRow>(summarySql, summaryParams),
    db.query<AttemptDbRow>(attemptsSql, attemptParams),
  ])

  const summaryRow = summaryRes.rows[0]
  const totalAttempts = asInt(summaryRow?.attempts)
  // No rows visible under this scope -> treat as not found (no side channel).
  if (!summaryRow || totalAttempts === 0) return null

  const attemptRows = attemptsRes.rows
  const attemptsTruncated = attemptRows.length > GADS_ITERATION_ATTEMPT_LIMIT
  const attempts = attemptRows.slice(0, GADS_ITERATION_ATTEMPT_LIMIT).map(rowToAttempt)

  return {
    scope: args.scope,
    generatedAt: now.toISOString(),
    sites: sitesForScope(args.scope),
    runId: args.runId,
    summary: rowToRunSummary(args.runId, summaryRow, now),
    attempts,
    totalAttempts,
    returnedAttempts: attempts.length,
    attemptLimit: GADS_ITERATION_ATTEMPT_LIMIT,
    attemptsTruncated,
  }
}
