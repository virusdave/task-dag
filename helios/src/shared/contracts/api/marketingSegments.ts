import { z } from 'zod'

// API contracts for the Helios "segment details" page
// (/config/marketing/segments/:segmentId, virusdave/top-level#12).
//
// A read-only, cache-only view of one Sweed marketing segment: identity +
// membership summary from the local caches (sweed_marketing_segments +
// sweed_customer_segments), the per-segment refresh highwater
// (sweed_segment_membership_refresh), and — when the segment is driven by a
// geographic assignment rule — the geo rule(s) and their application tallies.
// GET never calls Sweed; the "Refresh membership cache" button enqueues a
// background Sweed pull. See routes/marketingSegments.ts.

export const SegmentTypeSchema = z.enum(['static', 'dynamic', 'unknown'])
export type SegmentType = z.infer<typeof SegmentTypeSchema>

export const SegmentScopeLevelSchema = z.enum(['state', 'site', 'unknown'])
export type SegmentScopeLevel = z.infer<typeof SegmentScopeLevelSchema>

export const SegmentRefreshStatusSchema = z.enum([
  'never', // no membership ever cached
  'untracked', // members cached before the highwater existed
  'pending',
  'ok',
  'failed',
])
export type SegmentRefreshStatus = z.infer<typeof SegmentRefreshStatusSchema>

export const SegmentIdentitySchema = z.object({
  segmentId: z.number().int().positive(),
  name: z.string(),
  type: SegmentTypeSchema,
  enabled: z.boolean().nullable(),
  scopeLevel: SegmentScopeLevelSchema,
  scopeLabel: z.string(),
  targetStoreNames: z.array(z.string()),
  // Sweed's own reported customer count for the segment (catalog cache).
  sweedTotalCustomers: z.number().int().nonnegative().nullable(),
  catalogRefreshedAt: z.iso.datetime().nullable(),
  // True when sweed_marketing_segments has a row for this id. When false the
  // page is rendered from membership/geo data alone (cold catalog).
  inCatalog: z.boolean(),
  sweedPrimeUrl: z.string().url(),
})

export const SegmentMembershipSummarySchema = z.object({
  cachedMemberCount: z.number().int().nonnegative(),
  firstEnteredAt: z.iso.datetime().nullable(),
  lastEnteredAt: z.iso.datetime().nullable(),
  unknownEnterCount: z.number().int().nonnegative(),
  // Members whose date_on_enter is older than the 52-week chart window.
  olderEnterCount: z.number().int().nonnegative(),
})

export const SegmentRefreshStateSchema = z.object({
  status: SegmentRefreshStatusSchema,
  requestedAt: z.iso.datetime().nullable(),
  refreshedAt: z.iso.datetime().nullable(),
  memberCount: z.number().int().nonnegative().nullable(),
  lastError: z.string().nullable(),
})

export const SegmentEntryBucketSchema = z.object({
  weekStart: z.string(), // NY-local ISO date (YYYY-MM-DD)
  count: z.number().int().nonnegative(),
})

export const SegmentScopeBreakdownRowSchema = z.object({
  scopeLevel: SegmentScopeLevelSchema,
  scopeLabel: z.string(),
  memberCount: z.number().int().nonnegative(),
})

export const SegmentGeoRuleSchema = z.object({
  id: z.number().int().positive(),
  siteSlug: z.string(),
  siteLabel: z.string().nullable(),
  trigger: z.string(),
  triggerLive: z.boolean(),
  enabled: z.boolean(),
  radiusFeet: z.number(),
  centerLat: z.number(),
  centerLng: z.number(),
  since: z.iso.datetime().nullable(),
  reactivationDays: z.number().int().positive(),
  note: z.string().nullable(),
  updatedAt: z.iso.datetime(),
  applied: z.number().int().nonnegative(),
  alreadyMember: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
})

export const SegmentGeoFailureSchema = z.object({
  ruleId: z.number().int().positive(),
  sweedCustomerId: z.string(),
  scanId: z.string().nullable(),
  lastError: z.string().nullable(),
  updatedAt: z.iso.datetime(),
})

export const SegmentDetailsResponseSchema = z.object({
  segment: SegmentIdentitySchema,
  membership: SegmentMembershipSummarySchema,
  refreshState: SegmentRefreshStateSchema,
  entryHistogram: z.array(SegmentEntryBucketSchema),
  scopeBreakdown: z.array(SegmentScopeBreakdownRowSchema),
  geoRules: z.array(SegmentGeoRuleSchema),
  recentGeoFailures: z.array(SegmentGeoFailureSchema),
})
export type SegmentDetailsResponse = z.infer<typeof SegmentDetailsResponseSchema>

export const SegmentMembershipRefreshResponseSchema = z.object({
  enqueued: z.boolean(),
  segmentId: z.number().int().positive(),
  status: z.literal('pending'),
})
export type SegmentMembershipRefreshResponse = z.infer<
  typeof SegmentMembershipRefreshResponseSchema
>
