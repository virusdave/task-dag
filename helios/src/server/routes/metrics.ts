import type { FastifyInstance } from 'fastify'

import {
  MetricListResponseSchema,
  MetricQueryRequestSchema,
  MetricQueryResponseSchema,
  MetricRouteParamsSchema,
  type MetricCatalogFilterDimension,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getMetricById, listMetricSummaries } from '../metrics/registry.js'
import { toMetricSummary } from '../metrics/types.js'

export async function registerMetricsRoutes(server: FastifyInstance): Promise<void> {
  // List every registered metric (summary only — no `query`).
  server.get('/api/metrics', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) {
      return
    }
    return reply.send(
      MetricListResponseSchema.parse({ metrics: listMetricSummaries() }),
    )
  })

  // Run a metric's query and return the resulting time series.
  server.get('/api/metrics/:metricId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) {
      return
    }
    const params = MetricRouteParamsSchema.parse(request.params)
    const metric = getMetricById(params.metricId)
    if (!metric) {
      return reply.status(404).send({ error: `Unknown metric id ${JSON.stringify(params.metricId)}.` })
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

    const data = await metric.query({
      sites: queryArgs.sites,
      from,
      to,
      agg,
      categoryIds,
      subcategoryIds,
      brandIds,
      sizes,
      selection,
    })

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
