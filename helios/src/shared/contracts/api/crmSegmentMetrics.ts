import { z } from 'zod'

import {
  SegmentIdentitySchema,
  SegmentMembershipSummarySchema,
} from './marketingSegments.js'

// API contracts for the CRM "Segments" metrics tab
// (/metrics/crm-segments, virusdave/top-level#12).
//
// This is the "about the segment" page: who is in it, how it's grown, how
// active/valuable its members are, how recently they've shopped, and how
// they fulfil. Everything here is computed for the SEGMENT alone — the
// segment-vs-rest / segment-vs-everyone comparison lives on the companion
// "CRM Segment Analysis" tab.
//
// Phase 1 reads header-grain facts straight off `sweed_orders` (joined to
// the cached `sweed_customer_segments` membership) within the interactive
// budget at current volume. Margin / category-mix metrics arrive in a later
// phase once the per-customer daily fact rollups land (see
// docs/helios/customer-segmentation/EPIC_PLAN.md). See
// server/crmSegmentMetrics/crmSegmentMetricsQueries.ts for the SQL.

// ---------------------------------------------------------------------------
// Segment picker list
// ---------------------------------------------------------------------------

export const CrmSegmentListItemSchema = z.object({
  segmentId: z.number().int().positive(),
  name: z.string(),
  type: z.enum(['static', 'dynamic', 'unknown']),
  enabled: z.boolean().nullable(),
  scopeLevel: z.enum(['state', 'site', 'unknown']),
  scopeLabel: z.string(),
  // Local membership-cache count (what we can actually analyse).
  cachedMemberCount: z.number().int().nonnegative(),
  // Sweed's own reported segment size (catalog cache); may exceed the
  // cached count when membership hasn't been pulled yet.
  sweedTotalCustomers: z.number().int().nonnegative().nullable(),
})
export type CrmSegmentListItem = z.infer<typeof CrmSegmentListItemSchema>

export const CrmSegmentListResponseSchema = z.object({
  segments: z.array(CrmSegmentListItemSchema),
})
export type CrmSegmentListResponse = z.infer<typeof CrmSegmentListResponseSchema>

// ---------------------------------------------------------------------------
// Per-segment metrics
// ---------------------------------------------------------------------------

export const CrmSegmentMetricsRequestSchema = z.object({
  segmentId: z.coerce.number().int().positive(),
  // Site scope for the behavioural window (which dealers' orders to count).
  // Empty ⇒ all known store dealers. Mirrors the `?sites=` convention used
  // across the metrics surface.
  sites: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v): string[] =>
      v === undefined ? [] : Array.isArray(v) ? v : v.split(',').map((s) => s.trim()).filter(Boolean),
    ),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
})
export type CrmSegmentMetricsRequest = z.infer<typeof CrmSegmentMetricsRequestSchema>

// Days-since-last-purchase buckets. `never` = a cached member with no
// non-cancelled order in scope at all (in the selected site scope).
export const CrmRecencyBucketKeySchema = z.enum([
  '0_30',
  '31_60',
  '61_90',
  '91_180',
  '181_plus',
  'never',
])
export type CrmRecencyBucketKey = z.infer<typeof CrmRecencyBucketKeySchema>

export const CrmRecencyBucketSchema = z.object({
  bucket: CrmRecencyBucketKeySchema,
  memberCount: z.number().int().nonnegative(),
})

export const CrmFulfillmentMixRowSchema = z.object({
  channel: z.string(),
  orders: z.number().int().nonnegative(),
  netSalesDollars: z.number(),
})

export const CrmSegmentActivitySchema = z.object({
  // Members with ≥1 non-cancelled order in the window & site scope.
  activeMembers: z.number().int().nonnegative(),
  // activeMembers / cachedMemberCount (null when no cached members).
  activeRate: z.number().nullable(),
  orders: z.number().int().nonnegative(),
  // Per-member denominators are explicit so the UI can't conflate them.
  ordersPerMember: z.number().nullable(),
  ordersPerActiveMember: z.number().nullable(),
  grossSalesDollars: z.number(),
  netSalesDollars: z.number(),
  grossReceiptsDollars: z.number(),
  discountDollars: z.number(),
  avgOrderValueDollars: z.number().nullable(),
  netSalesPerMember: z.number().nullable(),
  netSalesPerActiveMember: z.number().nullable(),
})
export type CrmSegmentActivity = z.infer<typeof CrmSegmentActivitySchema>

export const CrmSegmentMetricsResponseSchema = z.object({
  segment: SegmentIdentitySchema,
  membership: SegmentMembershipSummarySchema,
  window: z.object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  }),
  scope: z.object({
    siteKeys: z.array(z.string()),
    dealerIds: z.array(z.number().int()),
  }),
  activity: CrmSegmentActivitySchema,
  recencyBuckets: z.array(CrmRecencyBucketSchema),
  fulfillmentMix: z.array(CrmFulfillmentMixRowSchema),
  entryHistogram: z.array(
    z.object({ weekStart: z.string(), count: z.number().int().nonnegative() }),
  ),
  // Operator-facing caveats (stale membership, low coverage, small sample).
  dataQuality: z.array(z.string()),
})
export type CrmSegmentMetricsResponse = z.infer<typeof CrmSegmentMetricsResponseSchema>
