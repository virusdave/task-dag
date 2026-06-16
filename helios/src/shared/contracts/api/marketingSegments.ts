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
  // Helios-local retirement. A retired segment is hidden from every Helios
  // surface EXCEPT the segment directory/details config pages. A segment is
  // retired iff it is disabled in Sweed (disabledImpliedRetired) OR the
  // operator explicitly retired it in Helios (explicitlyRetired).
  isRetired: z.boolean(),
  explicitlyRetired: z.boolean(),
  disabledImpliedRetired: z.boolean(),
  retiredAt: z.iso.datetime().nullable(),
  retiredBy: z.string().nullable(),
  retirementNote: z.string().nullable(),
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

// Batch "Refresh all segment caches": fans the per-segment refresh job
// out across every enabled cached segment (deduped per segment). Returns
// how many segments were queued so the UI can confirm the action.
export const SegmentMembershipRefreshAllResponseSchema = z.object({
  enqueued: z.number().int().nonnegative(),
  segmentIds: z.array(z.number().int().positive()),
})
export type SegmentMembershipRefreshAllResponse = z.infer<
  typeof SegmentMembershipRefreshAllResponseSchema
>

// ---------------------------------------------------------------------
// Segment directory (/config/marketing/segments) — lists every cached
// segment so the operator can open a detail page or retire/unretire a
// segment. Cache-only (sweed_marketing_segments + sweed_customer_segments
// + sweed_marketing_segment_retirement); never calls Sweed.
// ---------------------------------------------------------------------

export const MarketingSegmentDirectoryRowSchema = z.object({
  segmentId: z.number().int().positive(),
  name: z.string(),
  type: SegmentTypeSchema,
  enabled: z.boolean().nullable(),
  scopeLevel: SegmentScopeLevelSchema,
  scopeLabel: z.string(),
  cachedMemberCount: z.number().int().nonnegative(),
  sweedTotalCustomers: z.number().int().nonnegative().nullable(),
  // Retirement state (see SegmentIdentitySchema).
  isRetired: z.boolean(),
  explicitlyRetired: z.boolean(),
  disabledImpliedRetired: z.boolean(),
  retiredAt: z.iso.datetime().nullable(),
  retiredBy: z.string().nullable(),
  retirementNote: z.string().nullable(),
})
export type MarketingSegmentDirectoryRow = z.infer<typeof MarketingSegmentDirectoryRowSchema>

export const MarketingSegmentDirectoryResponseSchema = z.object({
  segments: z.array(MarketingSegmentDirectoryRowSchema),
  catalogRefreshedAt: z.iso.datetime().nullable(),
})
export type MarketingSegmentDirectoryResponse = z.infer<
  typeof MarketingSegmentDirectoryResponseSchema
>

// Retire / unretire a segment in Helios. Idempotent; returns the
// resulting retirement state so the UI can update without a reload.
export const SegmentRetirementResponseSchema = z.object({
  segmentId: z.number().int().positive(),
  isRetired: z.boolean(),
  explicitlyRetired: z.boolean(),
  disabledImpliedRetired: z.boolean(),
  retiredAt: z.iso.datetime().nullable(),
  retiredBy: z.string().nullable(),
  retirementNote: z.string().nullable(),
})
export type SegmentRetirementResponse = z.infer<typeof SegmentRetirementResponseSchema>
