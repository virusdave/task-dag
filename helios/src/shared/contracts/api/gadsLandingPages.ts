import { z } from 'zod'

import { GADS_SCOPES, type GadsScope } from '../../domain/gadsSites.js'

// ---------------------------------------------------------------------------
// GAds → Landing pages analytics (V1)
//
// Backs the per-site `/metrics/gads-<site>/landing-pages` surface
// (parent epic virusdave/top-level#18, first sub-page of the holistic
// paid-acquisition / lead-gen measurement system).
//
// ONE consolidated endpoint — GET /api/gads/landing-pages — returns
// the KPI strip + funnel waterfall + variant table + freshness /
// attribution status in a single payload so the page makes ONE
// backend round-trip (no MetricChart fan-out).
//
// V1 is "observed performance" only, computed directly from the
// append-only `lp_events` sink (migration 070) with assignment-cohort
// semantics: we anchor on the `lp_assignment` event whose `event_ts`
// falls in [from, to), then observe whether that assignment later
// reached impression / redirect / conversion stages. All counts are
// assignment-level uniques, never raw event counts.
//
// Cost / revenue / ROAS / CPA are NOT wired in V1 (the operator's
// guidance: this is not an accounting system). The server returns
// them as `null` with `attributionStatus: 'not-wired'` and the UI
// renders explicit "pending" badges rather than misleading zeros.
// ---------------------------------------------------------------------------

// ============================ Request schema ===============================

const GadsScopeSchema = z.enum(
  GADS_SCOPES as readonly [GadsScope, ...GadsScope[]],
)

export const GadsLandingPagesRequestSchema = z.object({
  /** 'bronx' | 'midtown' | 'all'. Gates which grant the endpoint
   *  requires (see requiredGadsGrants). */
  site: GadsScopeSchema,
  /** ISO timestamps. Half-open window [from, to); the server clamps
   *  the span to a max and defaults to a recent window when omitted. */
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  /** Optional placement filter (page purpose). */
  family: z.string().trim().min(1).optional(),
  /** Optional experiment filter. */
  experimentId: z.string().trim().min(1).optional(),
})
export type GadsLandingPagesRequest = z.infer<typeof GadsLandingPagesRequestSchema>

// ============================ Attribution status ===========================

// Cost / revenue attribution is not wired in V1. Kept as an explicit
// enum (not a bare boolean) so the UI badge copy is stable as later
// states ('allocated', 'click-exact', 'incomplete') land.
export const GadsAttributionStatusSchema = z.enum([
  'not-wired',
  'allocated',
  'incomplete',
  'click-exact',
])
export type GadsAttributionStatus = z.infer<typeof GadsAttributionStatusSchema>

// ============================ KPI strip ====================================

/**
 * Top-line KPIs over the assignment cohort. Rate fields are 0..1
 * fractions; `null` means "not computable / not wired" and the UI
 * renders a pending badge, never a zero.
 */
export const GadsLandingPagesKpisSchema = z.object({
  assignments: z.number().int().nonnegative(),
  // Landing-page conversion rate = converted / assignments.
  conversionRate: z.number().nullable(),
  // Redirect rate = redirected / impressed (the metric the LP most
  // directly controls).
  redirectRate: z.number().nullable(),
  // Impression rate = impressed / assignments.
  impressionRate: z.number().nullable(),
  // Money KPIs — null in V1 (attribution not wired).
  adSpend: z.number().nullable(),
  attributedRevenue: z.number().nullable(),
  roas: z.number().nullable(),
  cpa: z.number().nullable(),
})
export type GadsLandingPagesKpis = z.infer<typeof GadsLandingPagesKpisSchema>

// ============================ Funnel waterfall =============================

export const GadsFunnelStageSchema = z.object({
  /** 'assigned' | 'impressed' | 'redirected' | 'converted'. */
  stage: z.enum(['assigned', 'impressed', 'redirected', 'converted']),
  label: z.string(),
  /** Assignment-level unique count reaching this stage. */
  count: z.number().int().nonnegative(),
  /** Fraction of the previous stage that reached this stage (null for
   *  the first stage). */
  stepRate: z.number().nullable(),
})
export type GadsFunnelStage = z.infer<typeof GadsFunnelStageSchema>

// ============================ Variant table ================================

/**
 * One row per (site, family, experiment_id, policy_rule_id,
 * branch_id) group over the cohort. Observed performance, NOT causal
 * lift. Rates are 0..1 fractions; money columns are null in V1.
 */
export const GadsVariantRowSchema = z.object({
  site: z.string(),
  family: z.string().nullable(),
  experimentId: z.string().nullable(),
  policyRuleId: z.string().nullable(),
  branchId: z.string().nullable(),

  assignments: z.number().int().nonnegative(),
  /** Share of cohort assignments (0..1). */
  trafficShare: z.number(),
  impressionRate: z.number().nullable(),
  redirectRate: z.number().nullable(),
  conversionRate: z.number().nullable(),

  // Diagnostic only: avg served probability (basis points / 10000).
  avgServedProbability: z.number().nullable(),

  // Money columns — null in V1.
  revenuePerAssignment: z.number().nullable(),
  roas: z.number().nullable(),
  cpa: z.number().nullable(),

  /** True when assignments < the low-sample threshold; the UI hides
   *  these by default behind a toggle and badges them. */
  lowSample: z.boolean(),
})
export type GadsVariantRow = z.infer<typeof GadsVariantRowSchema>

// ============================ Data quality =================================

export const GadsDataQualitySchema = z.object({
  /** lp_assignment events in window with a null assignment_id (dropped
   *  from the cohort — cannot be attributed). */
  assignmentsMissingId: z.number().int().nonnegative(),
  /** Later-stage events (impression/redirect/conversion) seen in
   *  window with a null assignment_id (unattributable). */
  unattributedStageEvents: z.number().int().nonnegative(),
  /** The low-sample assignment threshold applied to variant rows. */
  lowSampleThreshold: z.number().int().positive(),
})
export type GadsDataQuality = z.infer<typeof GadsDataQualitySchema>

// ============================ Response =====================================

export const GadsLandingPagesResponseSchema = z.object({
  scope: GadsScopeSchema,
  range: z.object({ from: z.string().datetime(), to: z.string().datetime() }),
  generatedAt: z.string().datetime(),
  /** The concrete sites covered (e.g. ['bronx'] or ['bronx','midtown']). */
  sites: z.array(z.string()),
  /** Cost / revenue attribution status — 'not-wired' in V1. */
  attributionStatus: GadsAttributionStatusSchema,
  kpis: GadsLandingPagesKpisSchema,
  funnel: z.array(GadsFunnelStageSchema),
  variants: z.array(GadsVariantRowSchema),
  dataQuality: GadsDataQualitySchema,
})
export type GadsLandingPagesResponse = z.infer<typeof GadsLandingPagesResponseSchema>
