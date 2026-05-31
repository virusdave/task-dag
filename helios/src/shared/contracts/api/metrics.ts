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
 * How the SPA should render a metric.
 *
 *   - `line`    — default. X axis = time bucket (`t`); each series is
 *                 drawn as a polyline over time.
 *   - `scatter` — X axis = `series[0]` value; Y axis = `series[1]` value.
 *                 Each row in the response is plotted as a single dot at
 *                 (series[0], series[1]). `t` is still required on the
 *                 wire (kept for date provenance / hover tooltips and
 *                 for window-based filtering on the server) but does NOT
 *                 drive horizontal position. Scatter metrics MUST declare
 *                 exactly two numeric series.
 */
export const MetricChartTypeSchema = z.enum(['line', 'scatter'])
export type MetricChartType = z.infer<typeof MetricChartTypeSchema>

/**
 * Which catalog-scope filter dimensions a metric actually honors. The
 * registry exposes this on the public summary so the SPA knows which
 * cards to send catalog filters to (and which to badge as "filters not
 * applied"). The HTTP route REJECTS filter params for dimensions a
 * metric doesn't declare — silent no-op filters would be a lie.
 *
 * Values match the columns produced by the catalog-analytics filters
 * endpoint (`category_label` / `subcategory_label` / `brand_label` /
 * `size_label` — i.e. coalesced labels, not numeric ids).
 */
export const MetricCatalogFilterDimensionSchema = z.enum([
  'category',
  'subcategory',
  'brand',
  'size',
])
export type MetricCatalogFilterDimension = z.infer<typeof MetricCatalogFilterDimensionSchema>

/**
 * Kinds of "drill selection" a chart element on this metric may produce.
 *
 * v1.4 V4'0 introduces this as the type vehicle for the click-to-drill
 * feature landing in V4'4. Today (V4'0) no metric declares it; V4'4 will
 * opt-in every histogram + scatter in scope by declaring the matching
 * kinds on its MetricDef.
 *
 *   - `histogramBucket` — every bar in a histogram becomes click-to-drill.
 *     The click navigates to the routable detail route with
 *     `?selection={ kind: 'histogramBucket', metricId, bucketKey }` in the
 *     URL; the detail route's Table tab populates with the rows
 *     contributing to that bucket (rows-endpoint extension also lands
 *     in V4'4).
 *
 *   - `scatterDot` — every dot in a scatter becomes click-to-drill. The
 *     click navigates to the routable detail route with
 *     `?selection={ kind: 'scatterDot', cashierId }` (or other per-metric
 *     id) in the URL; the detail route's Table tab populates with the
 *     dot's underlying per-day rows.
 */
export const MetricDrillSelectionKindSchema = z.enum(['histogramBucket', 'scatterDot'])
export type MetricDrillSelectionKind = z.infer<typeof MetricDrillSelectionKindSchema>

/**
 * Optional capability bag a metric may declare to opt in to additional
 * dashboard behaviour. Kept additive — every field is optional and
 * absent ⇒ unchanged behaviour (so existing metrics get no new
 * affordances until they explicitly opt in).
 *
 * v1.4 V4'0 introduces the bag with one field (`drillSelection`); future
 * iterations may add more capability flags here (e.g. `download`,
 * `share`, `annotation`) without breaking existing MetricDef sources.
 */
export const MetricSupportsSchema = z
  .object({
    /**
     * Drill-selection kinds this metric's chart elements emit when
     * clicked. v1.4 V4'4 will opt-in every histogram + scatter in
     * scope; V4'0 lands the type vehicle only (no metric declares it
     * yet, so no behavioural change).
     */
    drillSelection: z.array(MetricDrillSelectionKindSchema).optional(),
  })
  .strict()
export type MetricSupports = z.infer<typeof MetricSupportsSchema>

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
  /**
   * How the SPA should render this metric. Defaults to `line` (time
   * series). When set to `scatter`, the SPA plots each row as a dot
   * with X = `series[0]` value and Y = `series[1]` value.
   */
  chartType: MetricChartTypeSchema.default('line'),
  /**
   * Which catalog-scope filter dimensions this metric honors. Empty
   * (the default) means the metric is NOT a candidate for the shared
   * category / subcategory / brand / size filter chips on inventory /
   * sales / catalog tabs — the SPA will badge such cards as "filters
   * not applied" when those chips are active, and the HTTP route will
   * reject filtered requests for the unsupported dimensions with 400.
   */
  supportedCatalogFilters: z.array(MetricCatalogFilterDimensionSchema).default([]),
  /**
   * Optional opt-in capability bag — see `MetricSupportsSchema`.
   * Defaults to an empty object so existing metrics behave unchanged.
   *
   * v1.4 V4'0 introduces this with one field (`drillSelection`); V4'4
   * will opt-in every histogram + scatter in scope to click-to-drill.
   */
  supports: MetricSupportsSchema.default({}),
})
export type MetricDefSummary = z.infer<typeof MetricDefSummarySchema>

export const MetricListResponseSchema = z.object({
  metrics: z.array(MetricDefSummarySchema),
})
export type MetricListResponse = z.infer<typeof MetricListResponseSchema>

const csvList = z
  .string()
  .optional()
  .transform((value) =>
    value && value.trim().length > 0
      ? value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [],
  )

// `GET /api/metrics/<id>` query params.
export const MetricQueryRequestSchema = z.object({
  // Comma-separated list of site ids (e.g. `?sites=midtown,bushwick`).
  // Empty / unset = all sites.
  sites: csvList,
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  agg: MetricAggregationSchema.optional(),
  // Catalog-scope filters — comma-separated label lists matching the
  // ids returned by /api/catalog-analytics/filters. Empty / unset =
  // no filter on that dimension. The route rejects any non-empty list
  // for a dimension the metric does not declare in
  // supportedCatalogFilters.
  categoryIds: csvList,
  subcategoryIds: csvList,
  brandIds: csvList,
  sizes: csvList,
})
export type MetricQueryRequest = z.infer<typeof MetricQueryRequestSchema>

// One row of the time series the metric query returns.
//
// `t` is always an ISO-8601 timestamp — the bucket boundary chosen by
// the metric's `query` function based on the requested aggregation.
// Most remaining keys are numeric series the chart wrapper looks up
// by `series[i].id` in the metric summary; scatter metrics may also
// carry an optional string dimension column (e.g. `site_zip`) which
// the renderer uses for per-dot grouping / colour.
export const MetricDatumSchema = z
  .object({ t: z.string() })
  .catchall(z.union([z.number(), z.string(), z.null()]))
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
    // Echo the catalog-scope filters that were actually applied. The
    // route only forwards filters for dimensions the metric declares
    // as supported; other dimensions surface here as empty arrays.
    categoryIds: z.array(z.string()).default([]),
    subcategoryIds: z.array(z.string()).default([]),
    brandIds: z.array(z.string()).default([]),
    sizes: z.array(z.string()).default([]),
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
