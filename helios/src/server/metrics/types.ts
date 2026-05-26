import type {
  MetricAggregation,
  MetricDefSummary,
  MetricSeriesDef,
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
export interface MetricDef extends Omit<MetricDefSummary, 'dataStatus' | 'blockedByUrl'> {
  readonly series: MetricSeriesDef[]
  readonly query: MetricQueryFn
  /**
   * Optional in the source MetricDef — when omitted, the registry tags the
   * metric with the appropriate status (real/pending/demo) before it lands
   * in the public summary. See `registry.ts` for the tagging policy.
   */
  readonly dataStatus?: MetricDefSummary['dataStatus']
  readonly blockedByUrl?: MetricDefSummary['blockedByUrl']
}

export interface MetricQueryArgs {
  /** Empty array = no site filter (i.e. all sites). */
  readonly sites: readonly string[]
  /** Inclusive lower bound; null means the metric chooses a default. */
  readonly from: Date | null
  /** Exclusive upper bound; null means the metric chooses a default. */
  readonly to: Date | null
  readonly agg: MetricAggregation
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
  }
}
