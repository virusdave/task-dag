import type { FastifyInstance } from 'fastify'

import {
  BudtenderAnalyticsRequestSchema,
  BudtenderAnalyticsResponseSchema,
} from '../../shared/contracts/index.js'
import { requireMetricsGrant } from '../auth/requireSession.js'
import {
  BUDTENDER_ANALYTICS_DEFAULT_WINDOW_DAYS,
  getBudtenderAnalyticsWithStaffCacheState,
} from '../budtenderAnalytics/budtenderAnalyticsQueries.js'
import { getPool } from '../db/pool.js'
import { enqueueJob, JOB_PRIORITY_BEST_EFFORT } from '../jobs/enqueueJob.js'

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
    // 'staff' grant gates the Budtender performance surface
    // (replaces the prior admin-only check; admins still pass via
    // the implicit-all-grants shortcut inside requireMetricsGrant).
    const user = await requireMetricsGrant(request, reply, 'staff')
    if (!user) return
    const parsed = BudtenderAnalyticsRequestSchema.parse(request.query ?? {})
    const to = parsed.to ? new Date(parsed.to) : new Date()
    const from = parsed.from
      ? new Date(parsed.from)
      : new Date(to.getTime() - BUDTENDER_ANALYTICS_DEFAULT_WINDOW_DAYS * DAY_MS)
    const result = await getBudtenderAnalyticsWithStaffCacheState({
      from,
      to,
      sites: parsed.sites,
    })
    if (result.staffRefreshTrigger !== null) {
      try {
        await enqueueJob(getPool(), {
          jobType: 'config.workers.refresh_staff_directory',
          module: 'utilities',
          payload: { trigger: result.staffRefreshTrigger },
          priority: JOB_PRIORITY_BEST_EFFORT,
          dedupeKey: 'config.workers.refresh_staff_directory',
          concurrencyKey: null,
          requestedByUserId: user.id,
          scope: null,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : null
        const signal = code === '42501' ? 'read-only database denied optional enqueue; ' : ''
        console.warn(
          `[budtender-analytics] ${signal}could not queue staff-directory refresh: ${message}`,
        )
      }
    }
    return reply.send(BudtenderAnalyticsResponseSchema.parse(result.analytics))
  })
}
