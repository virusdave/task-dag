import type {
  MetricAggregation,
  MetricCatalogFilterDimension,
  MetricDefSummary,
  MetricSelection,
  MetricSeriesDef,
  MetricSupports,
} from '../../shared/contracts/index.js'

/**
 * One row produced by a metric's `query` function. The `t` field is
 * always an ISO-8601 bucket-start timestamp; every other key is the
 * id of one of the metric's declared `series` and carries a numeric
 * value (or null when the bucket has no observation).
 *
 * We use a permissive structural type here rather than the strict
 * Zod-derived `MetricDatum` (which collapses the t/series split into
 * an index signature that TypeScript can't reconcile with concrete
 * literal-keyed objects). The HTTP route still validates outgoing
 * rows against the strict schema, so the wire shape is unchanged.
 */
export interface MetricRow {
  readonly t: string
  readonly [seriesId: string]: string | number | null | undefined
}

/**
 * Allowed extra-column value types when echoing a query row to the
 * wire. The strict Zod schema (MetricDatumSchema) admits number, null,
 * and (since the scatter work) string. Helios route code projects
 * MetricRow → MetricDatum 1:1 — every non-`t` key is forwarded as-is.
 */
export type MetricRowValue = string | number | null

/**
 * Server-side MetricDef. Each metric file under
 * `server/src/metrics/<group>/<id>.ts` exports a `metric: MetricDef`
 * that the registry picks up.
 *
 * The `query` function is server-only — it is NEVER serialized to the
 * client. `GET /api/metrics` returns the public summary (everything
 * except `query`); `GET /api/metrics/<id>` invokes the query and
 * returns the resulting time series.
 *
 * Implementations should be careful with the `sites` argument: do
 * NOT splice site identifiers directly into SQL — bind them as
 * parameters and let `ANY($1::text[])` filter, or whitelist them
 * against the in-process site registry first. The registry does not
 * sanitise them for you.
 */
export interface MetricDef
  extends Omit<
    MetricDefSummary,
    | 'dataStatus'
    | 'blockedByUrl'
    | 'chartType'
    | 'supportedCatalogFilters'
    | 'supports'
  > {
  readonly series: MetricSeriesDef[]
  readonly query: MetricQueryFn
  /**
   * Optional in the source MetricDef — when omitted, the registry tags the
   * metric with the appropriate status (real/pending/demo) before it lands
   * in the public summary. See `registry.ts` for the tagging policy.
   */
  readonly dataStatus?: MetricDefSummary['dataStatus']
  readonly blockedByUrl?: MetricDefSummary['blockedByUrl']
  /**
   * Optional renderer hint. Defaults to `'line'` (time-series) when
   * omitted. Set to `'scatter'` for metrics whose two series should
   * be plotted as X / Y of a scatter chart (e.g. weather correlation).
   */
  readonly chartType?: MetricDefSummary['chartType']
  /**
   * Optional — declare which catalog filter dimensions the query
   * actually honors. Empty / unset means the metric is NOT a
   * candidate for the shared filter chips (the SPA will badge such
   * cards as "filters not applied" when filters are active, and the
   * route rejects filtered requests for unsupported dimensions).
   */
  readonly supportedCatalogFilters?: readonly MetricCatalogFilterDimension[]
  /**
   * Optional capability bag (v1.4 V4'0). Today only `drillSelection`
   * is defined; future capability flags will be added here without
   * breaking existing MetricDef sources. Omit ⇒ default behaviour
   * (no click-to-drill, etc.). See
   * [`shared/contracts/api/metrics.ts`](../../shared/contracts/api/metrics.ts)
   * `MetricSupports` for the canonical definition.
   */
  readonly supports?: MetricSupports
}

export interface MetricQueryArgs {
  /** Empty array = no site filter (i.e. all sites). */
  readonly sites: readonly string[]
  /** Inclusive lower bound; null means the metric chooses a default. */
  readonly from: Date | null
  /** Exclusive upper bound; null means the metric chooses a default. */
  readonly to: Date | null
  readonly agg: MetricAggregation
  /**
   * Catalog-scope filters. Each is an array of label values that the
   * metric query should narrow the universe to. Empty / undefined =
   * no filter on that dimension. The HTTP route only forwards
   * filters for dimensions the metric declares as supported; other
   * dimensions arrive here as empty arrays. These fields are marked
   * optional so test fixtures (and back-compat callers) can omit
   * them — queries that consume them should coerce undefined → [].
   */
  readonly categoryIds?: readonly string[]
  readonly subcategoryIds?: readonly string[]
  readonly brandIds?: readonly string[]
  readonly sizes?: readonly string[]
  /**
   * v1.4 V4'4: optional drill-selection forwarded by the route
   * handler when the caller passes a `?selection=…` query param AND
   * the kind is in this metric's `supports.drillSelection`. Queries
   * may use it to narrow their row set; queries that don't honour
   * selection can safely ignore the field.
   */
  readonly selection?: MetricSelection
}

export type MetricQueryFn = (args: MetricQueryArgs) => Promise<MetricRow[]>

/**
 * Convenience: project a full `MetricDef` to the public summary the
 * SPA receives. Drops the server-only `query` function and any other
 * non-serializable handles a future MetricDef may attach.
 */
export function toMetricSummary(metric: MetricDef): MetricDefSummary {
  return {
    id: metric.id,
    group: metric.group,
    title: metric.title,
    description: metric.description ?? '',
    series: metric.series,
    defaultAggregation: metric.defaultAggregation,
    supportedAggregations: metric.supportedAggregations,
    dataStatus: metric.dataStatus ?? 'real',
    blockedByUrl: metric.blockedByUrl,
    chartType: metric.chartType ?? 'line',
    supportedCatalogFilters: [...(metric.supportedCatalogFilters ?? [])],
    // v1.4 V4'0: opt-in capability bag. Defaults to `{}` so metrics
    // that don't declare any new affordances behave exactly as before.
    supports: metric.supports
      ? {
          ...(metric.supports.drillSelection !== undefined
            ? { drillSelection: [...metric.supports.drillSelection] }
            : {}),
          ...(metric.supports.partialBuckets !== undefined
            ? { partialBuckets: metric.supports.partialBuckets }
            : {}),
        }
      : {},
  }
}
