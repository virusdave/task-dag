import { z } from 'zod'

import { GADS_SCOPES, type GadsScope } from '../../domain/gadsSites.js'

// ---------------------------------------------------------------------------
// GAds evolver introspection — L3 + LP enrichment (V1, phase P6)
//
// Backs the per-site, grant-gated `GET /api/gads/enrichment?site=` surface
// (parent epic virusdave/top-level#24, Helios child automation#51). This is
// the data behind two Evolution-page panels (EPIC_PLAN §6 items 5 & 6),
// which the Evolution UI (P4) mounts:
//
//   * L3 feedback-adoption panel — latest L3 meta-analysis evaluation
//     summary, `l3-addenda.md` freshness/hash, and whether a later L2 run
//     looks to have consumed the addenda. This is HOW HELIOS TUNES ITS OWN
//     prompts/rules, NOT site ad data and NOT human-approved.
//   * LP-evolver reaction panel — a bounded summary of
//     `landingpage_ad_outcomes` (the GAds→landing-page signal/action/outcome
//     surface), honestly badged "single historical ingest" / empty until a
//     live writer is confirmed.
//
// Access model (P1/P2/P3 invariants):
//   * LP section is SITE-SCOPED. The `site` predicate is derived
//     SERVER-SIDE from the validated route scope via the shared
//     appendGadsSitePredicate helper — a per-site scope filters
//     `site = $key` (so unknown-scope `site is null` rows are hidden), and
//     only the gads-all grant sees the cross-site superset incl. NULL rows.
//   * L3 section is GLOBAL loop-level meta-analysis (not site-attributable).
//     Its free text (addenda bullets, proposal rationale) can quote
//     cross-site campaigns/families, so on a per-site VIEW (site=bronx /
//     site=midtown) the response is REDACTED to non-identifying metadata
//     only (counts, freshness, hash, confidence/approval flags). The free
//     text is shown ONLY on the cross-site `all` view (site=all, which
//     requires the gads-all grant). The redaction is keyed off the
//     validated route scope, so it holds even for a gads-all user who opens
//     a specific site's page. `l3.scope` is always 'global' and
//     `l3.visibility` says whether free text was included.
//
// There is no client-supplied widening param and no client-supplied file
// name: the endpoint accepts only `site`; the L3 artifact paths are fixed,
// server-resolved, bounded reads that degrade to honest empty states.
// ---------------------------------------------------------------------------

const GadsScopeSchema = z.enum(
  GADS_SCOPES as readonly [GadsScope, ...GadsScope[]],
)

// ============================ Request ======================================

export const GadsEnrichmentRequestSchema = z.object({
  /** 'bronx' | 'midtown' | 'all'. Gates the required grant, the LP
   *  server-derived site predicate, AND the L3 free-text redaction. */
  site: GadsScopeSchema,
})
export type GadsEnrichmentRequest = z.infer<typeof GadsEnrichmentRequestSchema>

// ============================ L3 section ===================================

/** One bounded L3 proposal summary (free text — gads-all only). */
export const GadsL3ProposalSchema = z.object({
  updateType: z.string(),
  component: z.string(),
  rationale: z.string(),
  expectedImpact: z.string(),
  confidence: z.number().nullable(),
})
export type GadsL3Proposal = z.infer<typeof GadsL3ProposalSchema>

/** Summary of the newest `*-l3-evaluation.json` on disk. */
export const GadsL3LatestEvaluationSchema = z.object({
  evaluationId: z.string(),
  /** generated_at from the evaluation JSON (ISO), or null if unparsable. */
  generatedAt: z.string().datetime().nullable(),
  /** Number of L2 runs the evaluation analysed. */
  l2RunsAnalyzedCount: z.number().int().nonnegative(),
  trialsAnalyzed: z.number().int().nonnegative(),
  promptUpdateCount: z.number().int().nonnegative(),
  ruleUpdateCount: z.number().int().nonnegative(),
  requiresHumanApproval: z.boolean(),
  /** Bounded top proposals by confidence. EMPTY for a redacted (per-site)
   *  response — it carries free text. */
  topProposals: z.array(GadsL3ProposalSchema),
  topProposalsTruncated: z.boolean(),
})
export type GadsL3LatestEvaluation = z.infer<
  typeof GadsL3LatestEvaluationSchema
>

/** `l3-addenda.md` freshness/hash + parsed header + (gads-all) top bullets. */
export const GadsL3AddendaSchema = z.object({
  exists: z.boolean(),
  /** sha256 of the file contents (hex), or null if missing/too large. */
  sha256: z.string().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  /** File mtime (ISO), or null if missing. */
  modifiedAt: z.string().datetime().nullable(),
  /** Parsed from the generated-by header comment (null for the seed file
   *  / a hand-written file with no header). */
  generatedAt: z.string().datetime().nullable(),
  generatedByEvaluationId: z.string().nullable(),
  l2RunsReferencedCount: z.number().int().nonnegative().nullable(),
  /** Top bullets (max 3). EMPTY for a redacted (per-site) response. */
  topBullets: z.array(z.string()),
})
export type GadsL3Addenda = z.infer<typeof GadsL3AddendaSchema>

/** Whether a later L2 run appears to have consumed the current addenda.
 *  This is a best-effort heuristic (no addenda-hash is persisted into the
 *  L2 output), hence `likelyConsumed` not `consumed`. */
export const GadsL3ConsumptionSchema = z.object({
  status: z.enum(['likely_consumed', 'not_yet_consumed', 'unknown']),
  /** Which addenda timestamp the comparison used. */
  basis: z.enum(['addenda_header_generated_at', 'addenda_mtime', 'none']),
  /** Newest L2 run id found under outputs/prod/json, or null. */
  newestL2RunId: z.string().nullable(),
  /** Its generated_at (ISO), or null. */
  newestL2RunAt: z.string().datetime().nullable(),
})
export type GadsL3Consumption = z.infer<typeof GadsL3ConsumptionSchema>

export const GadsL3SectionSchema = z.object({
  /** Always 'global' — L3 is loop-level meta-analysis, not per-site. */
  scope: z.literal('global'),
  /** 'full' when free text is included (gads-all only); 'redacted' for a
   *  per-site grant (metadata only). */
  visibility: z.enum(['full', 'redacted']),
  /** True when at least one L3 evaluation artifact was found. */
  available: z.boolean(),
  /** Count of `*-l3-evaluation.json` files found in the L3 outputs dir. */
  evaluationsIndexed: z.number().int().nonnegative(),
  /** Files that failed to parse (skipped, not fatal). */
  evaluationParseErrors: z.number().int().nonnegative(),
  /** Summary of the newest valid evaluation, or null when none. */
  latest: GadsL3LatestEvaluationSchema.nullable(),
  addenda: GadsL3AddendaSchema,
  consumption: GadsL3ConsumptionSchema,
})
export type GadsL3Section = z.infer<typeof GadsL3SectionSchema>

// ============================ LP section ===================================

/** One {signalType × plannedAction × outcomeStatus} group. `outcomeStatus`
 *  is a bounded free string — migration 044 does NOT constrain the column,
 *  so it is NOT modelled as a strict enum. */
export const GadsLpOutcomeGroupSchema = z.object({
  signalType: z.string(),
  plannedAction: z.string(),
  outcomeStatus: z.string(),
  count: z.number().int().nonnegative(),
  /** Mean signal_confidence (0..1) over the group, or null. */
  avgConfidence: z.number().nullable(),
})
export type GadsLpOutcomeGroup = z.infer<typeof GadsLpOutcomeGroupSchema>

/** One landing-page bucket (by landing_page_key — never the raw final_url). */
export const GadsLpLandingPageSchema = z.object({
  landingPageKey: z.string(),
  count: z.number().int().nonnegative(),
  observed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
})
export type GadsLpLandingPage = z.infer<typeof GadsLpLandingPageSchema>

export const GadsLpSectionSchema = z.object({
  /** True when any scoped rows exist. */
  available: z.boolean(),
  totalRows: z.number().int().nonnegative(),
  /** outcome_observed_at not null vs null. */
  observedRows: z.number().int().nonnegative(),
  pendingRows: z.number().int().nonnegative(),
  /** Mean signal_confidence over all scoped rows, or null. */
  avgConfidence: z.number().nullable(),
  firstCreatedAt: z.string().datetime().nullable(),
  lastCreatedAt: z.string().datetime().nullable(),
  firstOutcomeObservedAt: z.string().datetime().nullable(),
  lastOutcomeObservedAt: z.string().datetime().nullable(),
  /** True when every scoped row shares one created_at day (a single
   *  historical ingest, not a live feed) — the UI badges it. */
  singleIngest: z.boolean(),
  byGroup: z.array(GadsLpOutcomeGroupSchema),
  byGroupTruncated: z.boolean(),
  topLandingPages: z.array(GadsLpLandingPageSchema),
  topLandingPagesTruncated: z.boolean(),
})
export type GadsLpSection = z.infer<typeof GadsLpSectionSchema>

// ============================ Response =====================================

export const GadsEnrichmentResponseSchema = z.object({
  scope: GadsScopeSchema,
  generatedAt: z.string().datetime(),
  /** Concrete sites the scope covers (e.g. ['bronx'] or ['bronx','midtown']). */
  sites: z.array(z.string()),
  l3: GadsL3SectionSchema,
  lp: GadsLpSectionSchema,
})
export type GadsEnrichmentResponse = z.infer<
  typeof GadsEnrichmentResponseSchema
>
