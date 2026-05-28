import type { FastifyInstance } from 'fastify'

import {
  BudtenderAnalyticsRequestSchema,
  BudtenderAnalyticsResponseSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import {
  BUDTENDER_ANALYTICS_DEFAULT_WINDOW_DAYS,
  getBudtenderAnalytics,
} from '../budtenderAnalytics/budtenderAnalyticsQueries.js'

const DAY_MS = 86_400_000

export async function registerBudtenderAnalyticsRoutes(
  server: FastifyInstance,
): Promise<void> {
  // GET /api/budtender-analytics?from=&to=&sites=
  // Single consolidated endpoint that powers the /metrics → Budtender
  // performance tab. See budtenderAnalyticsQueries.ts for the SQL
  // strategy. The response is small (one row per cashier + a daily
  // series) so we hand the whole thing to the SPA in one round-trip.
  server.get('/api/budtender-analytics', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    const parsed = BudtenderAnalyticsRequestSchema.parse(request.query ?? {})
    const to = parsed.to ? new Date(parsed.to) : new Date()
    const from = parsed.from
      ? new Date(parsed.from)
      : new Date(to.getTime() - BUDTENDER_ANALYTICS_DEFAULT_WINDOW_DAYS * DAY_MS)
    const result = await getBudtenderAnalytics({
      from,
      to,
      sites: parsed.sites,
    })
    return reply.send(BudtenderAnalyticsResponseSchema.parse(result))
  })
}
