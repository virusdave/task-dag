import type { FastifyInstance } from 'fastify'

import {
  ALL_METRIC_GRANT_KEYS,
  EssentialsDailySummaryResponseSchema,
  MetricListResponseSchema,
  MetricQueryRequestSchema,
  MetricQueryResponseSchema,
  MetricRouteParamsSchema,
  type MetricCatalogFilterDimension,
} from '../../shared/contracts/index.js'
import { metricGrantForGroup } from '../../shared/domain/metricGrants.js'
import { requireMetricsGrant } from '../auth/requireSession.js'
import { loadEssentialsDailySummary } from '../db/queries/essentialsDailySummary.js'
import { queryWithPartialBuckets } from '../metrics/partialBuckets.js'
import { getMetricById, listMetricSummaries } from '../metrics/registry.js'
import { toMetricSummary } from '../metrics/types.js'

export async function registerMetricsRoutes(server: FastifyInstance): Promise<void> {
  // List every registered metric (summary only — no `query`).
  //
  // The list endpoint is metadata-only (no actual data points) but
  // we still filter the returned summaries to ONLY the metrics whose
  // group→grant the caller is authorized for. That way a non-admin
  // user with only `reordering` doesn't see Sales / Margin / etc
  // metric definitions even in a "what metrics exist" listing — and
  // the SPA's tab rendering naturally collapses to just what the user
  // can actually load data for.
  server.get('/api/metrics', async (request, reply) => {
    const user = await requireMetricsGrant(request, reply, ...ALL_METRIC_GRANT_KEYS)
    if (!user) {
      return
    }
    const heldGrants = new Set(user.metricGrants)
    const visible = listMetricSummaries().filter((m) => {
      const required = metricGrantForGroup(m.group)
      return heldGrants.has(required)
    })
    return reply.send(MetricListResponseSchema.parse({ metrics: visible }))
  })

  // Essentials sticky-banner endpoint. Returns the current NY-day
  // per-site + totals summary. Same `explore` grant as the
  // Essentials tab itself; the banner only renders on that tab so
  // a viewer who already loads /metrics will have the grant.
  server.get('/api/metrics/essentials/today', async (request, reply) => {
    const user = await requireMetricsGrant(request, reply, 'explore')
    if (!user) {
      return
    }
    const summary = await loadEssentialsDailySummary()
    return reply.send(EssentialsDailySummaryResponseSchema.parse(summary))
  })

  // Run a metric's query and return the resulting time series.
  server.get('/api/metrics/:metricId', async (request, reply) => {
    const params = MetricRouteParamsSchema.parse(request.params)
    const metric = getMetricById(params.metricId)
    if (!metric) {
      // 401/403 are gated BEFORE 404 normally, but the metric-id
      // unknown branch genuinely doesn't reveal anything sensitive
      // (the operator typed a bad URL) and we want callers to see
      // the friendlier "unknown metric id" error even when grant
      // checks would otherwise have blocked them. Tighten if this
      // ever becomes a leakage concern.
      // Still require auth first via a generic grant gate before
      // resolving the id, to avoid pivoting anon callers into the
      // 404 path.
      const anonGuard = await requireMetricsGrant(
        request,
        reply,
        ...ALL_METRIC_GRANT_KEYS,
      )
      if (!anonGuard) return
      return reply
        .status(404)
        .send({ error: `Unknown metric id ${JSON.stringify(params.metricId)}.` })
    }
    // Gate by the metric's group → grant key mapping so a user with
    // only 'reordering' can query the inventory metrics but cannot
    // query (e.g.) the sales metrics that belong to 'explore'.
    const requiredGrant = metricGrantForGroup(metric.group)
    const user = await requireMetricsGrant(request, reply, requiredGrant)
    if (!user) {
      return
    }

    const queryArgs = MetricQueryRequestSchema.parse(request.query ?? {})
    const agg = queryArgs.agg ?? metric.defaultAggregation
    if (!metric.supportedAggregations.includes(agg)) {
      return reply.status(400).send({
        error:
          `Metric ${JSON.stringify(metric.id)} does not support aggregation ${JSON.stringify(agg)}. ` +
          `Supported: ${metric.supportedAggregations.join(', ')}.`,
      })
    }
    const from = queryArgs.from ? new Date(queryArgs.from) : null
    const to = queryArgs.to ? new Date(queryArgs.to) : null

    // Catalog-scope filter validation. We forward filter arrays ONLY
    // for dimensions the metric explicitly declares as supported. If
    // the caller passes filters for an unsupported dimension we 400
    // rather than silently no-op — silent ignored filters would be a
    // lie to the operator (and to whoever is debugging downstream).
    const supportedSet = new Set<MetricCatalogFilterDimension>(
      metric.supportedCatalogFilters ?? [],
    )
    const requested: ReadonlyArray<readonly [MetricCatalogFilterDimension, readonly string[]]> = [
      ['category', queryArgs.categoryIds],
      ['subcategory', queryArgs.subcategoryIds],
      ['brand', queryArgs.brandIds],
      ['size', queryArgs.sizes],
    ]
    const unsupported = requested
      .filter(([, list]) => list.length > 0)
      .map(([dim]) => dim)
      .filter((dim) => !supportedSet.has(dim))
    if (unsupported.length > 0) {
      return reply.status(400).send({
        error:
          `Metric ${JSON.stringify(metric.id)} does not support catalog filters: ` +
          `${unsupported.join(', ')}. ` +
          `Supported: ${[...supportedSet].join(', ') || '(none)'}.`,
      })
    }

    const categoryIds = supportedSet.has('category') ? queryArgs.categoryIds : []
    const subcategoryIds = supportedSet.has('subcategory') ? queryArgs.subcategoryIds : []
    const brandIds = supportedSet.has('brand') ? queryArgs.brandIds : []
    const sizes = supportedSet.has('size') ? queryArgs.sizes : []

    // v1.4 V4'4: drill-selection validation. We only forward the
    // selection to `metric.query` when (a) the caller actually passed
    // one and (b) the kind is in this metric's declared
    // `supports.drillSelection`. A caller passing a selection for a
    // metric that doesn't declare drillSelection gets a 400 — silently
    // dropping it would lie to the operator (they'd see an
    // un-narrowed dataset behind a URL that implies a drill is active).
    let selection = queryArgs.selection
    if (selection) {
      if (selection.metricId !== metric.id) {
        return reply.status(400).send({
          error:
            `selection.metricId ${JSON.stringify(selection.metricId)} does not match route metric ${JSON.stringify(metric.id)}.`,
        })
      }
      const supported = metric.supports?.drillSelection ?? []
      if (!supported.includes(selection.kind)) {
        return reply.status(400).send({
          error:
            `Metric ${JSON.stringify(metric.id)} does not support drillSelection kind ${JSON.stringify(selection.kind)}. ` +
            `Supported: ${supported.length === 0 ? '(none)' : supported.join(', ')}.`,
        })
      }
    }

    const baseQueryArgs = {
      sites: queryArgs.sites,
      from,
      to,
      agg,
      categoryIds,
      subcategoryIds,
      brandIds,
      sizes,
      selection,
    }
    // Opt-in: metrics that declare `supports.partialBuckets` get the
    // shared edge-aware wrapper which widens the SQL window to the
    // natural bucket boundaries, marks the edge rows partial, and
    // extrapolates the right-edge "current" bucket via prior-bucket
    // pace. See `partialBuckets.ts` for the full algorithm.
    const data = metric.supports?.partialBuckets === true
      ? await queryWithPartialBuckets({
          query: metric.query,
          args: baseQueryArgs,
          seriesIds: metric.series.map((s) => s.id),
          // Passed so the projection-curve sampler can opportunistically
          // sub-aggregate the prior bucket via ONE extra SQL query
          // (e.g. `hour` rows for a `date`-aggregated metric).
          supportedAggregations: metric.supportedAggregations,
        })
      : await metric.query(baseQueryArgs)

    return reply.send(
      MetricQueryResponseSchema.parse({
        metric: toMetricSummary(metric),
        resolved: {
          sites: queryArgs.sites,
          from: from ? from.toISOString() : null,
          to: to ? to.toISOString() : null,
          agg,
          categoryIds,
          subcategoryIds,
          brandIds,
          sizes,
        },
        data,
      }),
    )
  })
}
