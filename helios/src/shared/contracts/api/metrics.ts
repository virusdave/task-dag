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
 * Drill-selection payload that a metric / panel emits when one of its
 * chart elements is clicked (v1.4 V4'4). Travels in the URL as a
 * JSON-encoded `?selection=…` query param so share-links reproduce
 * the drilled state, and (when applicable) gets forwarded to
 * `/api/metrics/<id>` so the metric query can narrow the row set.
 *
 * Discriminated union — the `kind` field selects the meta shape:
 *
 *   - `histogramBucket` → `{ kind, metricId, bucketKey }`
 *     `bucketKey` is the histogram's own bucket identifier (the
 *     stringified `purchaseNumber` / `totalPurchases` for the
 *     customer-value histograms, with `'overflow'` for the long-tail
 *     `N+` bucket).
 *
 *   - `scatterDot` → `{ kind, metricId, dotId }`
 *     `dotId` is the scatter's natural dot identifier (cashierId for
 *     the budtender scatter, product/listing id for catalog
 *     analytics, ISO date for the weather scatters).
 *
 * The route handler rejects any `selection` whose `kind` is not in
 * the target metric's `supports.drillSelection`. Metrics that don't
 * declare `drillSelection` are not drillable and reject *all*
 * `selection` payloads with HTTP 400.
 */
export const MetricSelectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('histogramBucket'),
    metricId: z.string().min(1),
    bucketKey: z.string().min(1),
  }),
  z.object({
    kind: z.literal('scatterDot'),
    metricId: z.string().min(1),
    dotId: z.string().min(1),
  }),
])
export type MetricSelection = z.infer<typeof MetricSelectionSchema>

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
/**
 * Partial-bucket side marker. When the displayed `[from, to)` window
 * doesn't align with a metric's natural aggregation boundary, the
 * leftmost and/or rightmost data row represents only part of a real
 * bucket. Server marks those edge rows so the chart renderer can
 * render them visually distinct (e.g. dashed connector + outlined
 * endpoint marker) from the solid line through the fully-contained
 * interior buckets.
 *
 *   - `left`  — first row covers `[from, firstBucketEnd)` only.
 *   - `right` — last row covers `[lastBucketStart, to_or_now)` only.
 *   - `both`  — a zoom window narrow enough that the same single
 *               bucket is both the first and last edge.
 */
export const MetricPartialSideSchema = z.enum(['left', 'right', 'both'])
export type MetricPartialSide = z.infer<typeof MetricPartialSideSchema>

/**
 * Whether an edge-bucket value is real (the full natural bucket
 * happens to be observable — e.g. a historical edge where we have
 * the whole bucket on disk, just clipped by the displayed window)
 * or extrapolated (typically the current right-edge where the
 * natural bucket hasn't completed yet).
 *
 *   - `truncated`   — full natural-bucket value is available; the
 *                     "partial" label only means "displayed window
 *                     doesn't include the whole bucket".
 *   - `extrapolated` — full natural-bucket value isn't yet observable
 *                     (e.g. the bucket includes "now"), so the server
 *                     projected the bucket total from the prior
 *                     bucket's intra-bucket pace.
 */
export const MetricPartialKindSchema = z.enum(['truncated', 'extrapolated'])
export type MetricPartialKind = z.infer<typeof MetricPartialKindSchema>

export const MetricSupportsSchema = z
  .object({
    /**
     * Drill-selection kinds this metric's chart elements emit when
     * clicked. v1.4 V4'4 will opt-in every histogram + scatter in
     * scope; V4'0 lands the type vehicle only (no metric declares it
     * yet, so no behavioural change).
     */
    drillSelection: z.array(MetricDrillSelectionKindSchema).optional(),
    /**
     * Opt-in: the metric's query is safe to wrap in the partial-bucket
     * helper that widens the SQL window to the natural bucket
     * boundaries, marks edge rows with `partial`/`partialKind`/
     * `partialCoverage` metadata, and extrapolates the right-edge
     * "current" bucket via prior-bucket-pace.
     *
     * Only safe for **additive** time-series metrics (sums, counts) on
     * line aggregations (hour/date/week/month). NOT safe for ratios,
     * averages, percent stacks, scatter metrics, or snapshot/as-of
     * metrics — those would produce nonsense extrapolations and are
     * intentionally not wrapped.
     */
    partialBuckets: z.boolean().optional(),
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
  /**
   * v1.4 V4'4: optional drill-selection. Travels as a JSON-encoded
   * string in the URL (`?selection={"kind":"scatterDot",…}`); the
   * route handler validates it against the target metric's
   * `supports.drillSelection` and forwards the parsed object to
   * `metric.query` so the query can narrow the row set.
   *
   * Empty / unset = no selection (the default — every existing
   * caller stays on the unfiltered code path).
   */
  selection: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw === '') return undefined
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `selection must be JSON: ${(err as Error).message}`,
        })
        return z.NEVER
      }
      const result = MetricSelectionSchema.safeParse(parsed)
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `selection does not match MetricSelectionSchema: ${result.error.message}`,
        })
        return z.NEVER
      }
      return result.data
    }),
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
  .object({
    t: z.string(),
    /**
     * ISO timestamp of the row's natural bucket END (= the next
     * bucket's start). Server-supplied for every time-bucket
     * aggregation (`hour` / `date` / `week` / `month`); absent for
     * categorical aggregations (`total` / `dow` / `dom` /
     * `dofortnight`) where bucket arithmetic doesn't apply, and
     * absent for scatter metrics (whose `t` is provenance-only,
     * never an x position).
     *
     * The line-chart renderer plots every bucket-aggregate marker
     * at `tEnd ?? t`, so the marker for "Jun 3" lands at end-of-
     * Jun-3 (= start-of-Jun-4). That keeps the spline's spacing
     * linear in time even when the right-edge partial bucket's
     * extrapolated endpoint (also at `lastEnd`, see
     * `partialProjectedT`) is the rightmost knot — without this,
     * the extrapolated endpoint sits one whole bucket-width to
     * the right of every other interior marker, visually
     * stretching the x-axis.
     *
     * Within-bucket instant values (the floating-actual dot at
     * `partialActualT`, sub-aggregated projection curve sample
     * points in `partialProjectionCurve`) carry their own explicit
     * timestamps and ignore this convention.
     */
    tEnd: z.string().optional(),
    /**
     * Edge-bucket marker. Absent for normal fully-contained interior
     * buckets. The chart renderer treats marked rows as separate from
     * the solid line through the interior — they're rendered with a
     * dashed connector + outlined endpoint marker. See
     * `MetricPartialSideSchema`.
     */
    partial: MetricPartialSideSchema.optional(),
    /** See `MetricPartialKindSchema`. Required when `partial` is set. */
    partialKind: MetricPartialKindSchema.optional(),
    /**
     * Fraction of the natural bucket that's covered by the displayed
     * window (or, for `extrapolated`, the fraction observed at the
     * time of the snapshot). 0..1. Useful for the chart tooltip's
     * "37% of bucket observed" caption.
     */
    partialCoverage: z.number().min(0).max(1).optional(),
    /**
     * Per-series projected (full-natural-bucket) value for the RIGHT
     * partial edge row. For `truncated` rows this is the full-bucket
     * SQL aggregate; for `extrapolated` rows it's the pace-projected
     * value `measured / x`. The right-edge row's regular series fields
     * still carry the ACTUAL measured value within the observed
     * sub-window (the floating disconnected dot); the spline's right
     * knot is plotted at `(partialProjectedT, partialProjected[sid])`.
     *
     * For LEFT partial rows the row's regular series fields now carry
     * the projected (= full-completion of the left bucket) value
     * directly, so the spline's left knot reads them straight off the
     * row and `partialProjected` is NOT emitted on left rows. See
     * `partialTangentPrev` for the hidden tangent neighbour the
     * client uses to compute the spline's slope at that knot.
     */
    partialProjected: z.record(z.string(), z.number()).optional(),
    /**
     * ISO timestamp where the projected (right-edge) spline knot is
     * plotted. Always the natural bucket end (= next bucket start)
     * for the RIGHT partial; never set on LEFT partial rows.
     *
     * The renderer treats the segment from the previous interior
     * point to (partialProjectedT, partialProjected[sid]) as the
     * last spline segment and draws it DASHED.
     */
    partialProjectedT: z.string().optional(),
    /**
     * Per-series value of the natural full bucket preceding a LEFT
     * partial edge (`T1'` in the partial-bucket spec). Plotted
     * **invisibly** by the client — used only as the spline's tangent
     * neighbour when computing the slope at the leftmost drawn knot
     * (`T2'`, the full-completion of the left partial bucket). Only
     * emitted on LEFT partial rows.
     */
    partialTangentPrev: z.record(z.string(), z.number()).optional(),
    /**
     * ISO timestamp for `partialTangentPrev` — the start of the
     * preceding natural bucket. Only emitted alongside
     * `partialTangentPrev` (i.e. only on LEFT partial rows).
     */
    partialTangentPrevT: z.string().optional(),
    /**
     * ISO timestamp of the x position where the RIGHT partial bucket's
     * actual measured value (carried on the row's regular series
     * fields) should be plotted as a disconnected floating dot. This
     * is the moment of observation (`asOf` / observedRightThrough),
     * NOT the bucket boundary — so the floating actual is placed
     * proportionally inside the in-progress bucket.
     *
     * Only emitted on RIGHT partial rows. The floating dot is NOT
     * connected to the spline; the spline's right knot is the
     * projected endpoint at `partialProjectedT` instead.
     */
    partialActualT: z.string().optional(),
    /**
     * Optional dotted-curve trajectory linking the right-edge
     * floating-actual dot to the projected endpoint at
     * `partialProjectedT`. Each entry carries `t` (ISO timestamp
     * inside `[lastStart, lastEnd)`) plus one numeric value per
     * `seriesId` representing the predicted cumulative-at-that-fraction
     * value.
     *
     * Only populated when (a) the metric declares a smaller
     * sub-aggregation in `supportedAggregations` (so the server can
     * sample the prior bucket's progression with ONE extra SQL
     * query) and (b) the right edge is `extrapolated` or
     * `truncated`. When the curve is unavailable the client falls
     * back to a simple straight dotted line.
     */
    partialProjectionCurve: z
      .array(
        z
          .object({ t: z.string() })
          .catchall(z.union([z.number(), z.string(), z.null()])),
      )
      .optional(),
  })
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

// ============================================================================
// Essentials daily summary (top-of-Essentials sticky banner).
//
// "Today" is the current LOGICAL BUSINESS DAY in NY time — the day
// rolls over at 04:00 America/New_York, not at calendar midnight
// (canon: use NY time for all aggregate / display unless explicitly
// told otherwise). Between 00:00 and 03:59:59 NY the banner still
// shows the previous calendar day's sales. The server clamps the
// upper bound to "now" so partial days don't ghost.
// ============================================================================

export const EssentialsDailySummaryRowSchema = z.object({
  /** Stable site identifier. Per-site rows: 'bronx' | 'midtown'.
   *  Totals row: 'totals'. */
  siteKey: z.string().min(1),
  /** Display label ('Bronx', 'Midtown', 'Totals'). */
  siteLabel: z.string().min(1),
  /** Scans today on this site where the person had no prior scan. */
  newScans: z.number().int().min(0),
  /** Scans today on this site where the person had a prior scan
   *  (or scan lacked a person_key — treated as returning to keep the
   *  curve conservative; mirrors acquisition.first_vs_returning). */
  returningScans: z.number().int().min(0),
  /** Purchases (paid orders) today on this site whose customer had no
   *  prior order. Guest checkouts (customer_id null) count as
   *  returning, same convention as the metrics tab. */
  newPurchases: z.number().int().min(0),
  /** Purchases (paid orders) today on this site whose customer had a
   *  prior order. */
  returningPurchases: z.number().int().min(0),
  /** sum(grand_total) — includes tax. */
  grossReceiptsDollars: z.number().finite(),
  /** sum(subtotal + discount) — pre-tax, pre-discount. */
  grossSalesDollars: z.number().finite(),
  /** sum(subtotal) — pre-tax, post-discount. */
  netSalesDollars: z.number().finite(),
  /** sum(line revenue − line cogs) across line items with a known
   *  wholesale cost. Line items without a known cost contribute
   *  revenue toward `grossSales/netSales` (those are order-grain)
   *  but are excluded from this aggregate (it's an item-grain
   *  derived metric — same exclusion rule as margins.effective_gm_pct). */
  marginDollars: z.number().finite(),
  /** Effective GM% = (priced_item_revenue − priced_item_cogs) /
   *  priced_item_revenue, expressed as a 0..1 fraction. Null when
   *  no line item today has a known cost (denominator is 0). */
  gmPct: z.number().finite().nullable(),
  /** Subtotal across line items whose cost is known. Useful for
   *  showing "X of $Y net sales are cost-priced" in the tooltip. */
  marginCoverageDollars: z.number().finite(),
})
export type EssentialsDailySummaryRow = z.infer<typeof EssentialsDailySummaryRowSchema>

export const EssentialsDailySummaryResponseSchema = z.object({
  /** ISO timestamp when the server produced this snapshot. */
  asOf: z.string().datetime(),
  /** Business-day boundary used for "today". `startIso` is the start
   *  of the logical business day (04:00 NY local, as UTC ISO);
   *  `endIso` is the moment the snapshot was produced (clamped to
   *  now() so a partial day isn't extrapolated). `nyDate` is the
   *  business day's calendar date in NY, e.g. `2026-06-04` is still
   *  the label at 02:30 NY on `2026-06-05` (because the business day
   *  hasn't rolled to 04:00 yet). */
  today: z.object({
    startIso: z.string().datetime(),
    endIso: z.string().datetime(),
    nyDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  /** One row per known site, in stable order. */
  sites: z.array(EssentialsDailySummaryRowSchema),
  /** Aggregate row across the same sites. Sum-of-counts /
   *  sum-of-dollars; GM% is the aggregate ratio, not the average. */
  totals: EssentialsDailySummaryRowSchema,
})
export type EssentialsDailySummaryResponse = z.infer<typeof EssentialsDailySummaryResponseSchema>
