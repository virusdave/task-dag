import type { FastifyInstance } from 'fastify'

import {
  MetricListResponseSchema,
  MetricQueryRequestSchema,
  MetricQueryResponseSchema,
  MetricRouteParamsSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getMetricById, listMetricSummaries } from '../metrics/registry.js'
import { toMetricSummary } from '../metrics/types.js'

export async function registerMetricsRoutes(server: FastifyInstance): Promise<void> {
  // List every registered metric (summary only — no `query`).
  server.get('/api/metrics', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    return reply.send(
      MetricListResponseSchema.parse({ metrics: listMetricSummaries() }),
    )
  })

  // Run a metric's query and return the resulting time series.
  server.get('/api/metrics/:metricId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
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

    const data = await metric.query({ sites: queryArgs.sites, from, to, agg })

    return reply.send(
      MetricQueryResponseSchema.parse({
        metric: toMetricSummary(metric),
        resolved: {
          sites: queryArgs.sites,
          from: from ? from.toISOString() : null,
          to: to ? to.toISOString() : null,
          agg,
        },
        data,
      }),
    )
  })
}
