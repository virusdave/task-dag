import { z } from 'zod'

/**
 * Schemas for the GLOBAL page-wide /metrics view defaults.
 *
 * Backs:
 *   GET    /api/metrics-defaults   (any metrics grant — every viewer
 *                                   needs the defaults to hydrate)
 *   PUT    /api/metrics-defaults   (admin) — replace the whole blob
 *   DELETE /api/metrics-defaults   (admin) — reset to code defaults
 *
 * The blob captures only stable, page-wide toolbar defaults — NOT
 * per-chart temporary overrides, zoom/lock state, selected sites, date
 * range, catalog filters, or highlight queries. The server validates
 * the STRUCTURE (so a malformed write is rejected) but treats the
 * individual enum-ish values as opaque short strings: the client owns
 * the authoritative enum sets (aggregations, stack modes, y-baselines,
 * scatter encodings) and normalises unknown values away on read. This
 * keeps the shared contract from having to track the large, client-only
 * scatter colour/size/opacity unions.
 */

// Per-tab toolbar defaults. All optional so a partial capture only
// overrides the fields it knows about.
export const MetricsTabDefaultsSchema = z
  .object({
    agg: z.string().min(1).max(32).optional(),
    stackMode: z.string().min(1).max(32).optional(),
    yBaseline: z.string().min(1).max(32).optional(),
  })
  .strict()
export type MetricsTabDefaults = z.infer<typeof MetricsTabDefaultsSchema>

// Page-wide scatter encoding defaults (shared by the Catalog analytics
// tab and the brand / distributor detail scatters). Each value is an
// encoding key OR the literal 'per-chart'.
export const MetricsScatterDefaultsSchema = z
  .object({
    colourBy: z.string().min(1).max(64).optional(),
    sizeBy: z.string().min(1).max(64).optional(),
    opacityBy: z.string().min(1).max(64).optional(),
  })
  .strict()
export type MetricsScatterDefaults = z.infer<typeof MetricsScatterDefaultsSchema>

export const MetricsViewDefaultsSchema = z
  .object({
    version: z.literal(1),
    // keyed by metrics tab id (e.g. 'essentials', 'sales', …).
    tabs: z.record(z.string().min(1).max(64), MetricsTabDefaultsSchema).optional(),
    scatter: MetricsScatterDefaultsSchema.optional(),
  })
  .strict()
export type MetricsViewDefaults = z.infer<typeof MetricsViewDefaultsSchema>

export const MetricsDefaultsGetResponseSchema = z.object({
  defaults: MetricsViewDefaultsSchema.nullable(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
})
export type MetricsDefaultsGetResponse = z.infer<typeof MetricsDefaultsGetResponseSchema>

export const MetricsDefaultsPutBodySchema = MetricsViewDefaultsSchema
export type MetricsDefaultsPutBody = z.infer<typeof MetricsDefaultsPutBodySchema>
