import { z } from 'zod'

import { GADS_SCOPES, type GadsScope } from '../../domain/gadsSites.js'
import {
  GadsActionCountSchema,
  GadsActionTypeSchema,
  GadsOutcomeSchema,
} from './gadsEvolution.js'

// ---------------------------------------------------------------------------
// GAds evolver introspection — Iteration page (V1, phase P3)
//
// Backs the per-site, grant-gated `/metrics/gads-<site>/iteration` surface
// (parent epic virusdave/top-level#24, Helios child automation#51): a
// bounded per-run timeline plus a per-run drilldown of the L2-proposed
// actions and their observed outcomes.
//
// V1 reads ONLY `gads_ad_attempts` (DB-derived). The richer per-run
// decision summary that lives in the on-disk L2 JSON / morning-bundle
// artifacts (snapshot age, prompt/config versions, L1 rule-update
// proposals, bundle download) is deferred to P5; this contract carries
// only what the DB reliably has, with honest "from DB" semantics.
//
// Access: the same server-derived per-site `site` predicate as the
// Evolution surface — a per-site scope sees only that site's rows of a
// (possibly cross-site) run, unknown-scope `site is null` rows are hidden
// per-site and appear only under the gads-all grant. The :runId path
// param is opaque, validated, and parameterised (never interpolated).
// ---------------------------------------------------------------------------

const GadsScopeSchema = z.enum(
  GADS_SCOPES as readonly [GadsScope, ...GadsScope[]],
)

/** Per-run outcome tallies (DB-derived from gads_ad_attempts). */
export const GadsRunOutcomeCountsSchema = z.object({
  success: z.number().int().nonnegative(),
  partial: z.number().int().nonnegative(),
  noChange: z.number().int().nonnegative(),
  worse: z.number().int().nonnegative(),
  superseded: z.number().int().nonnegative(),
  adDisappeared: z.number().int().nonnegative(),
  /** Still-open (outcome_observed_at null / unobserved). */
  open: z.number().int().nonnegative(),
})
export type GadsRunOutcomeCounts = z.infer<typeof GadsRunOutcomeCountsSchema>

// ============================ Runs list ====================================

export const GadsIterationRunsRequestSchema = z.object({
  site: GadsScopeSchema,
  /** Max runs to return (server clamps to a hard cap). */
  limit: z.coerce.number().int().positive().optional(),
})
export type GadsIterationRunsRequest = z.infer<
  typeof GadsIterationRunsRequestSchema
>

/** One row of the run timeline (DB-derived from gads_ad_attempts). */
export const GadsIterationRunSummarySchema = z.object({
  runId: z.string(),
  /** Min/max attempt created_at for the run within the scoped slice. */
  firstAttemptAt: z.string().datetime(),
  lastAttemptAt: z.string().datetime(),
  /** Attempt rows for this run visible under the scope. */
  attempts: z.number().int().nonnegative(),
  /** Distinct ads touched. */
  ads: z.number().int().nonnegative(),
  /** Terminal (outcome observed) count. */
  observed: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  staleOpen: z.number().int().nonnegative(),
  actionCounts: z.array(GadsActionCountSchema),
  outcomeCounts: GadsRunOutcomeCountsSchema,
})
export type GadsIterationRunSummary = z.infer<
  typeof GadsIterationRunSummarySchema
>

export const GadsIterationRunsResponseSchema = z.object({
  scope: GadsScopeSchema,
  generatedAt: z.string().datetime(),
  sites: z.array(z.string()),
  /** Stale-open threshold (days) used for the per-run staleOpen count. */
  staleAfterDays: z.number().int().positive(),
  runs: z.array(GadsIterationRunSummarySchema),
  /** True when the runs list was truncated to the limit. */
  truncated: z.boolean(),
  limit: z.number().int().positive(),
})
export type GadsIterationRunsResponse = z.infer<
  typeof GadsIterationRunsResponseSchema
>

// ============================ Run detail ===================================

export const GadsIterationRunDetailRequestSchema = z.object({
  site: GadsScopeSchema,
})
export type GadsIterationRunDetailRequest = z.infer<
  typeof GadsIterationRunDetailRequestSchema
>

/** One attempt row in a run drilldown. before/proposed creative is the
 *  observed delta; the full proposed_changes_json audit blob is NOT
 *  returned (kept lean; deferred to a P5 drilldown if needed). */
export const GadsIterationAttemptSchema = z.object({
  id: z.number().int(),
  createdAt: z.string().datetime(),
  adId: z.string(),
  campaignName: z.string().nullable(),
  adGroupName: z.string().nullable(),
  site: z.string().nullable(),
  actionType: GadsActionTypeSchema,
  rationale: z.string().nullable(),
  beforeServingStatus: z.string().nullable(),
  beforePolicyStatus: z.string().nullable(),
  beforeHeadlines: z.array(z.string()).nullable(),
  beforeDescriptions: z.array(z.string()).nullable(),
  beforeFinalUrl: z.string().nullable(),
  proposedHeadlines: z.array(z.string()).nullable(),
  proposedDescriptions: z.array(z.string()).nullable(),
  proposedFinalUrl: z.string().nullable(),
  outcomeObservedAt: z.string().datetime().nullable(),
  outcomeServingStatus: z.string().nullable(),
  outcomePolicyStatus: z.string().nullable(),
  outcome: GadsOutcomeSchema.nullable(),
  outcomeNotes: z.string().nullable(),
})
export type GadsIterationAttempt = z.infer<typeof GadsIterationAttemptSchema>

export const GadsIterationRunDetailResponseSchema = z.object({
  scope: GadsScopeSchema,
  generatedAt: z.string().datetime(),
  sites: z.array(z.string()),
  runId: z.string(),
  /** Aggregate summary for the run within the scope (computed over ALL
   *  scoped rows, not just the returned/bounded attempt rows). */
  summary: GadsIterationRunSummarySchema,
  attempts: z.array(GadsIterationAttemptSchema),
  /** Total scoped attempt rows for the run (may exceed `attempts.length`). */
  totalAttempts: z.number().int().nonnegative(),
  returnedAttempts: z.number().int().nonnegative(),
  attemptLimit: z.number().int().positive(),
  attemptsTruncated: z.boolean(),
})
export type GadsIterationRunDetailResponse = z.infer<
  typeof GadsIterationRunDetailResponseSchema
>
