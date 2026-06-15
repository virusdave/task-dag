import type { FastifyInstance } from 'fastify'

import {
  CustomerValueAnalyticsRequestSchema,
  CustomerValueAnalyticsResponseSchema,
} from '../../shared/contracts/index.js'
import { requireMetricsGrant } from '../auth/requireSession.js'
import {
  CUSTOMER_VALUE_ANALYTICS_DEFAULT_WINDOW_DAYS,
  getCustomerValueAnalytics,
} from '../customerValueAnalytics/customerValueAnalyticsQueries.js'

const DAY_MS = 86_400_000

export async function registerCustomerValueAnalyticsRoutes(
  server: FastifyInstance,
): Promise<void> {
  // GET /api/customer-value-analytics?from=&to=&sites=&maxPurchaseNumber=&cohortScope=
  // Single consolidated endpoint that powers the /metrics →
  // "Customer value" tab. See customerValueAnalyticsQueries.ts for
  // the SQL strategy.
  server.get('/api/customer-value-analytics', async (request, reply) => {
    // Customer value lives as a tab inside Explore today — 'explore'
    // grant is what users need. If we ever split it into its own
    // nav child, introduce a 'customer-value' MetricGrantKey and
    // update this check (plus the client tab visibility).
    const user = await requireMetricsGrant(request, reply, 'explore')
    if (!user) return
    const parsed = CustomerValueAnalyticsRequestSchema.parse(request.query ?? {})
    const to = parsed.to ? new Date(parsed.to) : new Date()
    const from = parsed.from
      ? new Date(parsed.from)
      : new Date(to.getTime() - CUSTOMER_VALUE_ANALYTICS_DEFAULT_WINDOW_DAYS * DAY_MS)
    const result = await getCustomerValueAnalytics({
      from,
      to,
      sites: parsed.sites,
      // Default is 'auto' — server picks the long-tail cliff, capped
      // at the visual hard-cap. Operator can override with a number.
      maxPurchaseNumber: parsed.maxPurchaseNumber ?? 'auto',
      cohortScope: parsed.cohortScope ?? 'all_as_of_end',
      // v1.4 V4'3: opt-in retention sections via `?include=retention`
      // (V4'0 decision — retention lives on the consolidated endpoint).
      // Default granularity is `week`.
      includeRetention: parsed.include.includes('retention'),
      cohortGranularity: parsed.cohortGranularity ?? 'week',
      // Already normalized to exactly five values in [50, 99] by the
      // request schema's `percentiles` transform.
      percentiles: parsed.percentiles,
      // v1.4 V4'6: marketing-segment lens. Empty => no filter. The
      // query layer sanitizes ids to positive integers.
      marketingSegmentIds: parsed.marketingSegmentIds,
    })
    return reply.send(CustomerValueAnalyticsResponseSchema.parse(result))
  })
}
