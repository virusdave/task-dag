// SEO metrics dashboard routes (P5 — the GA4/GSC feedback loop).
//
// Read-only views over the imported Search Console daily facts (migration
// 076): top queries, top pages, and recent import provenance for a site +
// date window. Every query is bounded by site + window + LIMIT (canon §3).
//
// child FreshlyBakedNYC/automation#44 (P5) · Satisfies: virusdave/top-level#15

import type { FastifyInstance } from 'fastify'

import { SeoMetricsOverviewResponseSchema } from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import {
  getTopGscPages,
  getTopGscQueries,
  listImportBatches,
} from '../db/queries/seoMetricsQueries.js'

const DASHBOARD_ROW_LIMIT = 50
const IMPORTS_LIMIT = 10

function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
}

export async function registerSeoMetricsRoutes(server: FastifyInstance): Promise<void> {
  // Dashboard overview for a site + date window (endDate exclusive).
  server.get('/api/seo/metrics/overview', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }
    const q = request.query as Record<string, string | undefined>
    const site = q.site ?? 'all'
    if (!isIsoDate(q.startDate) || !isIsoDate(q.endDate)) {
      return reply
        .status(400)
        .send({ error: 'startDate and endDate (YYYY-MM-DD) are required.' })
    }
    if (q.startDate >= q.endDate) {
      return reply.status(400).send({ error: 'startDate must be before endDate.' })
    }
    const window = { site, startDate: q.startDate, endDate: q.endDate, limit: DASHBOARD_ROW_LIMIT }
    const db = getPool()
    const [topQueries, topPages, recentImports] = await Promise.all([
      getTopGscQueries(db, window),
      getTopGscPages(db, window),
      listImportBatches(db, { limit: IMPORTS_LIMIT }),
    ])
    return reply.send(
      SeoMetricsOverviewResponseSchema.parse({
        site,
        startDate: q.startDate,
        endDate: q.endDate,
        topQueries,
        topPages,
        recentImports,
      }),
    )
  })
}
