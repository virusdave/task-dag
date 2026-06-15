import { z } from 'zod'

// Control-plane API contracts for the geographic (scan-location-based)
// segment assignment engine. Backed by the `geo_segment_rules` table
// (migration 079) and its `geo_segment_rule_applications` ledger.
//
// A rule says: "customers whose GEOCODED ID home address is within
// `radiusFeet` of (centerLat, centerLng), who satisfy `trigger`
// on/after `since`, get added to Sweed `segmentId` under `dealerId`."
//
// The live engine (config.workers.geo_segment_rule_eval) evaluates the
// `first_scan` trigger on-scan-callback. `first_purchase` is supported
// by the schema + the one-shot backfill but is NOT yet evaluated live,
// so the UI flags it as schema-only. See
// helios/src/worker/jobs/geoSegmentRuleEvalJob.ts.
//
// All write routes require role >= editor; reads require >= viewer
// (see routes/geoSegmentRules.ts).

// The qualifying event a rule fires on. Mirrors `TriggerKind` in
// helios/src/worker/sweed/geoSegment.ts and the CHECK constraint in
// migration 079. Kept as its own enum here so the shared contract does
// not import worker code.
export const GeoSegmentTriggerSchema = z.enum(['first_scan', 'first_purchase'])
export type GeoSegmentTrigger = z.infer<typeof GeoSegmentTriggerSchema>

// Triggers the live on-scan engine actually evaluates today. Anything
// not in this set is schema-only (backfill-only) and the UI says so.
export const LIVE_EVALUATED_TRIGGERS: readonly GeoSegmentTrigger[] = ['first_scan']

// ---------------------------------------------------------------------------
// Predicate AST (migration 080) — the composable, scan-safe rule language.
//
// A rule's `predicateJson` is a versioned AND-list of typed predicates.
// The AST is the source of truth; the legacy 079 columns
// (centerLat/Lng/radiusFeet/since/reactivationDays) are kept only as
// deprecated mirrors for the backfill CLI + existing geofence rules.
//
// Phase 1 = scan_event mode only (these 7 kinds). Stateful
// recency/spend/borough predicates arrive in phase 2 (customer_snapshot
// mode). See docs/helios/customer-segmentation/GEO_SEGMENT_RULES_DESIGN.md.
//
// Validation is strict HERE (zod) and shallow in the DB CHECK; the
// evaluator re-parses and fails closed on a malformed enabled rule.
// ---------------------------------------------------------------------------

export const GeoPredicateKindSchema = z.enum([
  'geofence',
  'zip5_in',
  'us_state_in',
  'scan_time_window',
  'first_scan_in_days',
  'age_range',
  'gender_in',
])
export type GeoPredicateKind = z.infer<typeof GeoPredicateKindSchema>

const predLat = z.number().min(-90).max(90)
const predLng = z.number().min(-180).max(180)
const zip5 = z.string().regex(/^\d{5}$/, 'ZIP must be 5 digits')
const usState = z.string().regex(/^[A-Z]{2}$/, 'State must be a 2-letter code')
export const GeoGenderSchema = z.enum(['M', 'F', 'X'])
export type GeoGender = z.infer<typeof GeoGenderSchema>

export const GeofencePredicateSchema = z
  .object({
    kind: z.literal('geofence'),
    centerLat: predLat,
    centerLng: predLng,
    radiusFeet: z.number().positive().max(5_280_000),
  })
  .strict()

export const Zip5InPredicateSchema = z
  .object({
    kind: z.literal('zip5_in'),
    zip5: z.array(zip5).min(1).max(1000),
  })
  .strict()

export const UsStateInPredicateSchema = z
  .object({
    kind: z.literal('us_state_in'),
    states: z.array(usState).min(1).max(60),
  })
  .strict()

// NOTE: discriminated-union members are kept as PLAIN `.strict()` objects
// (no `.superRefine`) so zod v4's discriminator extraction stays simple.
// Cross-field checks (since<until, minAge<=maxAge, at-least-one-bound)
// live in the AST-level refine below.
export const ScanTimeWindowPredicateSchema = z
  .object({
    kind: z.literal('scan_time_window'),
    since: z.iso.datetime().optional(),
    until: z.iso.datetime().optional(),
  })
  .strict()

export const FirstScanInDaysPredicateSchema = z
  .object({
    kind: z.literal('first_scan_in_days'),
    days: z.number().int().positive().max(36_500),
  })
  .strict()

export const AgeRangePredicateSchema = z
  .object({
    kind: z.literal('age_range'),
    minAge: z.number().int().min(0).max(130).optional(),
    maxAge: z.number().int().min(0).max(130).optional(),
  })
  .strict()

export const GenderInPredicateSchema = z
  .object({
    kind: z.literal('gender_in'),
    genders: z.array(GeoGenderSchema).min(1).max(3),
  })
  .strict()

export const GeoPredicateSchema = z.discriminatedUnion('kind', [
  GeofencePredicateSchema,
  Zip5InPredicateSchema,
  UsStateInPredicateSchema,
  ScanTimeWindowPredicateSchema,
  FirstScanInDaysPredicateSchema,
  AgeRangePredicateSchema,
  GenderInPredicateSchema,
])
export type GeoPredicate = z.infer<typeof GeoPredicateSchema>

export const GeoPredicateAstSchema = z
  .object({
    version: z.literal(1),
    op: z.literal('and'),
    predicates: z.array(GeoPredicateSchema).max(20),
  })
  .strict()
  .superRefine((ast, ctx) => {
    const seen = new Set<string>()
    ast.predicates.forEach((p, i) => {
      if (seen.has(p.kind)) {
        ctx.addIssue({
          code: 'custom',
          path: ['predicates', i],
          message: `Only one "${p.kind}" predicate is allowed per rule.`,
        })
      }
      seen.add(p.kind)
      if (p.kind === 'scan_time_window') {
        if (p.since === undefined && p.until === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['predicates', i],
            message: 'Scan-time window needs a "since" and/or "until" date.',
          })
        } else if (p.since !== undefined && p.until !== undefined && new Date(p.since) >= new Date(p.until)) {
          ctx.addIssue({ code: 'custom', path: ['predicates', i], message: '"since" must be before "until".' })
        }
      }
      if (p.kind === 'age_range') {
        if (p.minAge === undefined && p.maxAge === undefined) {
          ctx.addIssue({ code: 'custom', path: ['predicates', i], message: 'Age range needs a min and/or max age.' })
        } else if (p.minAge !== undefined && p.maxAge !== undefined && p.minAge > p.maxAge) {
          ctx.addIssue({ code: 'custom', path: ['predicates', i], message: 'min age must be ≤ max age.' })
        }
      }
    })
  })
export type GeoPredicateAst = z.infer<typeof GeoPredicateAstSchema>

export const EMPTY_GEO_PREDICATE_AST: GeoPredicateAst = { version: 1, op: 'and', predicates: [] }

// Per-rule application ledger tallies, shown inline so an operator can
// see a rule's live effect without leaving the page.
export const GeoSegmentRuleStatsSchema = z.object({
  applied: z.number().int().nonnegative(),
  alreadyMember: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
})
export type GeoSegmentRuleStats = z.infer<typeof GeoSegmentRuleStatsSchema>

export const GeoSegmentRuleRecordSchema = z.object({
  id: z.number().int().positive(),
  siteSlug: z.string().min(1),
  // Friendly site name resolved from SITE_PINS, when the slug is known.
  siteLabel: z.string().nullable(),
  dealerId: z.number().int().positive(),
  segmentId: z.number().int().positive(),
  // The composable rule definition (source of truth, migration 080).
  predicateJson: GeoPredicateAstSchema,
  // Legacy 079 mirror columns — null for non-geofence rules. Kept for
  // the backfill CLI and back-compat; new semantics live in predicateJson.
  centerLat: z.number().nullable(),
  centerLng: z.number().nullable(),
  radiusFeet: z.number().positive().nullable(),
  trigger: GeoSegmentTriggerSchema,
  // True when the live on-scan engine evaluates this rule's trigger.
  triggerLive: z.boolean(),
  reactivationDays: z.number().int().positive(),
  since: z.iso.datetime().nullable(),
  enabled: z.boolean(),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  stats: GeoSegmentRuleStatsSchema,
})
export type GeoSegmentRuleRecord = z.infer<typeof GeoSegmentRuleRecordSchema>

// A selectable retail site, surfaced so the create form can offer a
// dropdown and auto-fill the geofence centre from the store pin.
export const GeoSegmentSiteOptionSchema = z.object({
  siteSlug: z.string().min(1),
  label: z.string().min(1),
  lat: z.number(),
  lng: z.number(),
})
export type GeoSegmentSiteOption = z.infer<typeof GeoSegmentSiteOptionSchema>

export const GeoSegmentRulesListResponseSchema = z.object({
  rules: z.array(GeoSegmentRuleRecordSchema),
  siteOptions: z.array(GeoSegmentSiteOptionSchema),
})
export type GeoSegmentRulesListResponse = z.infer<typeof GeoSegmentRulesListResponseSchema>

const noteField = z.string().trim().max(500)

// An enabled rule must have at least one predicate; a disabled (draft)
// rule may be empty. Shared by create + update.
function enabledRuleHasPredicates(enabled: boolean | undefined, ast: GeoPredicateAst | undefined): boolean {
  if (enabled === false) return true
  if (ast === undefined) return true // update that doesn't touch predicates
  return ast.predicates.length > 0
}

export const GeoSegmentRuleCreateBodySchema = z
  .object({
    siteSlug: z.string().trim().min(1).max(32),
    dealerId: z.number().int().positive(),
    segmentId: z.number().int().positive(),
    trigger: GeoSegmentTriggerSchema,
    predicateJson: GeoPredicateAstSchema,
    enabled: z.boolean().default(true),
    note: noteField.optional(),
  })
  .refine((body) => enabledRuleHasPredicates(body.enabled, body.predicateJson), {
    message: 'An enabled rule needs at least one condition.',
    path: ['predicateJson'],
  })
export type GeoSegmentRuleCreateBody = z.infer<typeof GeoSegmentRuleCreateBodySchema>

export const GeoSegmentRuleUpdateBodySchema = z
  .object({
    // Target fields are accepted but the route rejects any real change
    // (immutable once a rule has a ledger). Kept optional for symmetry.
    siteSlug: z.string().trim().min(1).max(32).optional(),
    dealerId: z.number().int().positive().optional(),
    segmentId: z.number().int().positive().optional(),
    trigger: GeoSegmentTriggerSchema.optional(),
    predicateJson: GeoPredicateAstSchema.optional(),
    enabled: z.boolean().optional(),
    note: noteField.nullable().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'At least one field must be provided.',
  })
  .refine((body) => enabledRuleHasPredicates(body.enabled, body.predicateJson), {
    message: 'An enabled rule needs at least one condition.',
    path: ['predicateJson'],
  })
export type GeoSegmentRuleUpdateBody = z.infer<typeof GeoSegmentRuleUpdateBodySchema>

export const GeoSegmentRuleMutationResponseSchema = z.object({
  rule: GeoSegmentRuleRecordSchema,
})
export type GeoSegmentRuleMutationResponse = z.infer<typeof GeoSegmentRuleMutationResponseSchema>

export const GeoSegmentRuleDeleteResponseSchema = z.object({
  deletedId: z.number().int().positive(),
})
export type GeoSegmentRuleDeleteResponse = z.infer<typeof GeoSegmentRuleDeleteResponseSchema>

export const GeoSegmentRuleRouteParamsSchema = z.object({
  ruleId: z.coerce.number().int().positive(),
})
export type GeoSegmentRuleRouteParams = z.infer<typeof GeoSegmentRuleRouteParamsSchema>
