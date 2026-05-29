import type { FastifyInstance } from 'fastify'

import {
  CustomerValueAnalyticsRequestSchema,
  CustomerValueAnalyticsResponseSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import {
  CUSTOMER_VALUE_ANALYTICS_DEFAULT_MAX_N,
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
    const user = await requireSessionUser(request, reply, 'admin')
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
      maxPurchaseNumber: parsed.maxPurchaseNumber ?? CUSTOMER_VALUE_ANALYTICS_DEFAULT_MAX_N,
      cohortScope: parsed.cohortScope ?? 'all_as_of_end',
    })
    return reply.send(CustomerValueAnalyticsResponseSchema.parse(result))
  })
}
