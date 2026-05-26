import { z } from 'zod'

import {
  MetricAnnotationRecordSchema,
  MetricAnnotationScopeSchema,
} from '../domain/metricAnnotations.js'

// ---------------------------------------------------------------------------
// MetricDef — the shape of every metric file under server/src/metrics/**.
// The registry auto-loads each module that exports a `metric: MetricDef`,
// groups them by `group` for the left-nav, and serves them through the
// HTTP API below. The `query` function is server-only (not transferred
// over the wire) so we split the contract into the public summary and the
// payload returned by `GET /api/metrics/<id>`.
// ---------------------------------------------------------------------------

export const MetricAggregationSchema = z.enum([
  'total',
  'month',
  'week',
  'date',
  'hour',
  'dow',
  'dom',
  'dofortnight',
])
export type MetricAggregation = z.infer<typeof MetricAggregationSchema>

export const MetricSeriesDefSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  // Optional CSS colour — the chart wrapper falls back to a deterministic
  // palette pick keyed on `id` when omitted.
  colour: z.string().min(1).optional(),
})
export type MetricSeriesDef = z.infer<typeof MetricSeriesDefSchema>

/**
 * Provenance flag for a metric:
 *
 *   - `real`    — backed by real ingest / SQL the operator should trust.
 *   - `pending` — registered as part of the spec but the data source
 *                 isn't wired up yet; the metric's `query` returns an
 *                 empty time series and the dashboard renders the
 *                 metric as an explicit "MISSING DATA" placeholder
 *                 card. **No synthetic data is ever generated.**
 *
 * Demo metrics used to be a third value here. They were deleted
 * entirely on operator directive (2026-05-26: "i never want demo data")
 * — see helios/src/server/metrics/registry.ts.
 */
export const MetricDataStatusSchema = z.enum(['real', 'pending'])
export type MetricDataStatus = z.infer<typeof MetricDataStatusSchema>

// Public summary of a metric — everything the SPA needs to render the
// nav + chart frame WITHOUT firing the data query. Crucially excludes
// the server-only `query` function.
export const MetricDefSummarySchema = z.object({
  id: z.string().min(1),
  group: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  series: z.array(MetricSeriesDefSchema).min(1),
  defaultAggregation: MetricAggregationSchema,
  supportedAggregations: z.array(MetricAggregationSchema).min(1),
  dataStatus: MetricDataStatusSchema.default('real'),
  /**
   * Optional URL to the issue / runbook unblocking a `pending` metric.
   * Rendered as a link on the "Data pending" placeholder card.
   */
  blockedByUrl: z.string().url().optional(),
})
export type MetricDefSummary = z.infer<typeof MetricDefSummarySchema>

export const MetricListResponseSchema = z.object({
  metrics: z.array(MetricDefSummarySchema),
})
export type MetricListResponse = z.infer<typeof MetricListResponseSchema>

// `GET /api/metrics/<id>` query params.
export const MetricQueryRequestSchema = z.object({
  // Comma-separated list of site ids (e.g. `?sites=midtown,bushwick`).
  // Empty / unset = all sites.
  sites: z
    .string()
    .optional()
    .transform((value) =>
      value && value.trim().length > 0
        ? value
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : [],
    ),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  agg: MetricAggregationSchema.optional(),
})
export type MetricQueryRequest = z.infer<typeof MetricQueryRequestSchema>

// One row of the time series the metric query returns.
//
// `t` is always an ISO-8601 timestamp — the bucket boundary chosen by
// the metric's `query` function based on the requested aggregation.
// The remaining keys are arbitrary numeric series; the chart wrapper
// looks them up by `series[i].id` in the metric summary.
export const MetricDatumSchema = z
  .object({ t: z.string() })
  .catchall(z.union([z.number(), z.null()]))
export type MetricDatum = z.infer<typeof MetricDatumSchema>

export const MetricQueryResponseSchema = z.object({
  metric: MetricDefSummarySchema,
  // Echo of the resolved query (after defaulting to the metric's
  // `defaultAggregation`, the registry-wide site list, etc.) so the
  // client knows exactly what was executed.
  resolved: z.object({
    sites: z.array(z.string()),
    from: z.string().nullable(),
    to: z.string().nullable(),
    agg: MetricAggregationSchema,
  }),
  data: z.array(MetricDatumSchema),
})
export type MetricQueryResponse = z.infer<typeof MetricQueryResponseSchema>

// ---------------------------------------------------------------------------
// metric_annotations CRUD
// ---------------------------------------------------------------------------

export const MetricAnnotationsListQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  scope: MetricAnnotationScopeSchema.optional(),
  includeDeleted: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value) => value === true || value === 'true'),
})
export type MetricAnnotationsListQuery = z.infer<typeof MetricAnnotationsListQuerySchema>

export const MetricAnnotationsListResponseSchema = z.object({
  annotations: z.array(MetricAnnotationRecordSchema),
})
export type MetricAnnotationsListResponse = z.infer<typeof MetricAnnotationsListResponseSchema>

export const MetricAnnotationsCreateBodySchema = z
  .object({
    tStart: z.string().datetime(),
    tEnd: z.string().datetime().nullable().optional(),
    title: z.string().trim().min(1).max(200),
    body: z.string().max(10_000).default(''),
    tag: z.string().trim().min(1).max(40).nullable().optional(),
    scope: MetricAnnotationScopeSchema,
  })
  .refine(
    (value) => value.tEnd == null || value.tEnd >= value.tStart,
    { message: 'tEnd must be at or after tStart', path: ['tEnd'] },
  )
export type MetricAnnotationsCreateBody = z.infer<typeof MetricAnnotationsCreateBodySchema>

export const MetricAnnotationsCreateResponseSchema = z.object({
  annotation: MetricAnnotationRecordSchema,
})
export type MetricAnnotationsCreateResponse = z.infer<
  typeof MetricAnnotationsCreateResponseSchema
>

export const MetricAnnotationsPatchBodySchema = z
  .object({
    tStart: z.string().datetime().optional(),
    tEnd: z.string().datetime().nullable().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(10_000).optional(),
    tag: z.string().trim().min(1).max(40).nullable().optional(),
    scope: MetricAnnotationScopeSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'patch body must update at least one field',
  })
export type MetricAnnotationsPatchBody = z.infer<typeof MetricAnnotationsPatchBodySchema>

export const MetricRouteParamsSchema = z.object({
  metricId: z.string().min(1),
})
export type MetricRouteParams = z.infer<typeof MetricRouteParamsSchema>

export const MetricAnnotationRouteParamsSchema = z.object({
  annotationId: z.string().uuid(),
})
export type MetricAnnotationRouteParams = z.infer<typeof MetricAnnotationRouteParamsSchema>
