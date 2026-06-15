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
  centerLat: z.number(),
  centerLng: z.number(),
  radiusFeet: z.number().positive(),
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

const latitude = z.number().min(-90).max(90)
const longitude = z.number().min(-180).max(180)
const noteField = z.string().trim().max(500)

export const GeoSegmentRuleCreateBodySchema = z.object({
  siteSlug: z.string().trim().min(1).max(32),
  dealerId: z.number().int().positive(),
  segmentId: z.number().int().positive(),
  centerLat: latitude,
  centerLng: longitude,
  radiusFeet: z.number().positive().max(5_280_000),
  trigger: GeoSegmentTriggerSchema,
  reactivationDays: z.number().int().positive().max(36_500).default(365),
  since: z.iso.datetime().nullable().optional(),
  enabled: z.boolean().default(true),
  note: noteField.optional(),
})
export type GeoSegmentRuleCreateBody = z.infer<typeof GeoSegmentRuleCreateBodySchema>

export const GeoSegmentRuleUpdateBodySchema = z
  .object({
    siteSlug: z.string().trim().min(1).max(32).optional(),
    dealerId: z.number().int().positive().optional(),
    segmentId: z.number().int().positive().optional(),
    centerLat: latitude.optional(),
    centerLng: longitude.optional(),
    radiusFeet: z.number().positive().max(5_280_000).optional(),
    trigger: GeoSegmentTriggerSchema.optional(),
    reactivationDays: z.number().int().positive().max(36_500).optional(),
    since: z.iso.datetime().nullable().optional(),
    enabled: z.boolean().optional(),
    note: noteField.nullable().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'At least one field must be provided.',
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
