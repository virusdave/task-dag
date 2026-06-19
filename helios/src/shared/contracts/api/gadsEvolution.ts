import { z } from 'zod'

import { GADS_SCOPES, type GadsScope } from '../../domain/gadsSites.js'

// ---------------------------------------------------------------------------
// GAds evolver introspection — Evolution page (V1, phase P3)
//
// Backs the per-site, grant-gated `/metrics/gads-<site>/evolution` surface
// (parent epic virusdave/top-level#24, Helios child FreshlyBakedNYC/
// automation#51). This is an observability surface for HOW HELIOS REACTED
// — the L2 hill-climbing loop's own proposed actions and the outcomes we
// later observed — NOT a re-implementation of Google's ad dashboards and
// NOT causal ad lift. Every rate here is "observed policy-state movement"
// over the evolver's own attempts; the UI badges it as such.
//
// V1 reads ONLY `gads_ad_attempts` with bounded aggregate queries (the
// table is small + purpose-built; per the operator's DB-cost steer there
// is no per-event fact table, no rollup/hypertable/CAGG/HLL). The L3 +
// `landingpage_ad_outcomes` enrichment panels are explicitly deferred to
// P6, so they are NOT in this contract.
//
// Access: the per-site `site` predicate is derived SERVER-SIDE from the
// validated route scope (gadsSites.requiredGadsGrants); a per-site scope
// filters `site = $key` (so unknown-scope `site is null` rows are hidden),
// and only the `gads-all` grant sees the cross-site superset incl. those
// NULL rows (badged "site unknown"). There is no client-supplied widening
// param.
// ---------------------------------------------------------------------------

// ============================ Shared enums =================================

const GadsScopeSchema = z.enum(
  GADS_SCOPES as readonly [GadsScope, ...GadsScope[]],
)

/** The six L2-proposed action types (mirrors gads_ad_attempts.action_type
 *  / server gadsAdAttemptsQueries.GadsActionType). */
export const GadsActionTypeSchema = z.enum([
  'repair',
  'replace',
  'pause',
  'monitor',
  'trial_control',
  'trial_variant',
])
export type GadsActionType = z.infer<typeof GadsActionTypeSchema>

/** The observed-outcome grades (mirrors gads_ad_attempts.outcome /
 *  server gadsAdAttemptsQueries.GadsOutcome). `unobserved` (and a null
 *  outcome) means the attempt is still OPEN — no terminal outcome yet. */
export const GadsOutcomeSchema = z.enum([
  'success',
  'partial',
  'no_change',
  'worse',
  'superseded',
  'ad_disappeared',
  'unobserved',
])
export type GadsOutcome = z.infer<typeof GadsOutcomeSchema>

// ============================ Request ======================================

export const GadsEvolutionRequestSchema = z.object({
  /** 'bronx' | 'midtown' | 'all'. Gates the required grant AND the
   *  server-derived site predicate (see requiredGadsGrants). */
  site: GadsScopeSchema,
  /** ISO timestamps. Half-open window [from, to); the server defaults to a
   *  recent window and clamps the span to a max (see the constants). */
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
})
export type GadsEvolutionRequest = z.infer<typeof GadsEvolutionRequestSchema>

// ============================ Building blocks ==============================

/** Data freshness for honest empty/stale states. The attempt feed can go
 *  static (P1 found it stopped writing after 2026-05-31); the UI must not
 *  imply the loop is currently running when it is not. */
export const GadsDataFreshnessSchema = z.object({
  /** Min/max created_at of attempts in the scoped window (null if none). */
  firstAttemptAt: z.string().datetime().nullable(),
  lastAttemptAt: z.string().datetime().nullable(),
  /** True when the newest attempt in the window is older than
   *  staleAfterDays (the loop appears to have stopped writing). */
  isStale: z.boolean(),
  staleAfterDays: z.number().int().positive(),
})
export type GadsDataFreshness = z.infer<typeof GadsDataFreshnessSchema>

/**
 * The hero "learning heartbeat": outcome-weighted action yield over the
 * GRADEABLE observed attempts. NOT causal ad lift — observed policy-state
 * movement only. `score` / `priorScore` / `delta` are null when there are
 * no gradeable observations (never a fabricated 0).
 */
export const GadsLearningHeartbeatSchema = z.object({
  /** ((success + 0.5*partial) - worse) / gradeableObserved, or null. */
  score: z.number().nullable(),
  /** Same metric over the immediately-prior equal-length window, or null. */
  priorScore: z.number().nullable(),
  /** score - priorScore, or null if either side is null. */
  delta: z.number().nullable(),
  /** Denominator: success+partial+no_change+worse in the window. */
  gradeableObserved: z.number().int().nonnegative(),
  /** All attempts proposed in the window (every row). */
  proposed: z.number().int().nonnegative(),
  /** Attempts with a terminal outcome (outcome_observed_at not null AND
   *  outcome not in {unobserved}). Includes superseded/ad_disappeared. */
  terminalObserved: z.number().int().nonnegative(),
  /** terminalObserved / proposed, or null when proposed=0. */
  coverage: z.number().nullable(),
  /** True when gradeableObserved is below the low-sample threshold — the
   *  UI warns the score is noisy. */
  lowSample: z.boolean(),
  lowSampleThreshold: z.number().int().positive(),
  /** Per-NY-week score sparkline over the window (oldest→newest). */
  weekly: z.array(
    z.object({
      /** NY-local week start (Monday), ISO date (YYYY-MM-DD). */
      weekStart: z.string(),
      score: z.number().nullable(),
      gradeableObserved: z.number().int().nonnegative(),
    }),
  ),
})
export type GadsLearningHeartbeat = z.infer<typeof GadsLearningHeartbeatSchema>

/** One {actionType -> count} entry, returned as a stable-ordered array. */
export const GadsActionCountSchema = z.object({
  actionType: GadsActionTypeSchema,
  count: z.number().int().nonnegative(),
})
export type GadsActionCount = z.infer<typeof GadsActionCountSchema>

/** The loop-health KPI strip. Rates are 0..1 fractions or null (no
 *  denominator); never a fabricated 0. */
export const GadsLoopHealthSchema = z.object({
  proposed: z.number().int().nonnegative(),
  proposedByActionType: z.array(GadsActionCountSchema),
  /** Terminal (outcome observed) count. */
  observed: z.number().int().nonnegative(),
  /** Still-open count (outcome_observed_at is null / unobserved). */
  open: z.number().int().nonnegative(),
  /** Open AND older than staleAfterDays — the ingest-loop-unhealthy flag. */
  staleOpen: z.number().int().nonnegative(),
  /** (success+partial) / terminalObserved, or null. */
  netImprovementRate: z.number().nullable(),
  /** (no_change+worse+superseded) / terminalObserved — the waste signal. */
  wasteShare: z.number().nullable(),
  /** Median proposal→outcome latency in hours over terminal attempts. */
  medianLatencyHours: z.number().nullable(),
  /** Ads with >= stuckThreshold failed (no_change/worse/partial)
   *  repair/replace attempts in the window — the do-not-retry pressure. */
  stuckAds: z.number().int().nonnegative(),
  stuckThreshold: z.number().int().positive(),
})
export type GadsLoopHealth = z.infer<typeof GadsLoopHealthSchema>

/** One row of the action / outcome matrix (per action type). */
export const GadsActionOutcomeRowSchema = z.object({
  actionType: GadsActionTypeSchema,
  proposed: z.number().int().nonnegative(),
  observed: z.number().int().nonnegative(),
  success: z.number().int().nonnegative(),
  partial: z.number().int().nonnegative(),
  noChange: z.number().int().nonnegative(),
  worse: z.number().int().nonnegative(),
  superseded: z.number().int().nonnegative(),
  adDisappeared: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
})
export type GadsActionOutcomeRow = z.infer<typeof GadsActionOutcomeRowSchema>

/** A "where Helios keeps failing" hotspot, grouped by ad. Bounded list. */
export const GadsHotspotSchema = z.object({
  adId: z.string(),
  campaignName: z.string().nullable(),
  adGroupName: z.string().nullable(),
  /** Site scope of the ad ('bronx'|'midtown' or null = unknown-scope;
   *  null only ever surfaces under the gads-all grant). */
  site: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  /** repair/replace attempts that graded no_change/worse/partial. */
  failedRepairs: z.number().int().nonnegative(),
  success: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  lastAttemptAt: z.string().datetime(),
  lastOutcome: GadsOutcomeSchema.nullable(),
})
export type GadsHotspot = z.infer<typeof GadsHotspotSchema>

// ============================ Response =====================================

export const GadsEvolutionResponseSchema = z.object({
  scope: GadsScopeSchema,
  range: z.object({ from: z.string().datetime(), to: z.string().datetime() }),
  generatedAt: z.string().datetime(),
  /** Concrete sites the scope covers (e.g. ['bronx'] or ['bronx','midtown']). */
  sites: z.array(z.string()),
  freshness: GadsDataFreshnessSchema,
  heartbeat: GadsLearningHeartbeatSchema,
  loopHealth: GadsLoopHealthSchema,
  actionOutcomeMatrix: z.array(GadsActionOutcomeRowSchema),
  hotspots: z.array(GadsHotspotSchema),
  /** True when the hotspots list was truncated to its cap. */
  hotspotsTruncated: z.boolean(),
  hotspotLimit: z.number().int().positive(),
})
export type GadsEvolutionResponse = z.infer<typeof GadsEvolutionResponseSchema>
