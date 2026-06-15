import type { FastifyInstance } from 'fastify'

import {
  CrmSegmentListResponseSchema,
  CrmSegmentMetricsRequestSchema,
  CrmSegmentMetricsResponseSchema,
} from '../../shared/contracts/index.js'
import { requireMetricsGrant } from '../auth/requireSession.js'
import {
  defaultCrmWindow,
  getCrmSegmentList,
  getCrmSegmentMetrics,
} from '../crmSegmentMetrics/crmSegmentMetricsQueries.js'
import { getPool } from '../db/pool.js'

// CRM "Segments" metrics tab (/metrics/crm-segments, virusdave/top-level#12).
//
//   GET /api/crm/segments              — picker list (cache-only)
//   GET /api/crm/segment-metrics?...   — per-segment "about the segment" page
//
// Both gate on the 'explore' metric grant, mirroring the other /metrics
// tabs. Cache-only reads (no Sweed calls).
export async function registerCrmSegmentMetricsRoutes(
  server: FastifyInstance,
): Promise<void> {
  server.get('/api/crm/segments', async (request, reply) => {
    const user = await requireMetricsGrant(request, reply, 'explore')
    if (!user) return
    const result = await getCrmSegmentList(getPool())
    return reply.send(CrmSegmentListResponseSchema.parse(result))
  })

  server.get('/api/crm/segment-metrics', async (request, reply) => {
    const user = await requireMetricsGrant(request, reply, 'explore')
    if (!user) return
    const parsed = CrmSegmentMetricsRequestSchema.parse(request.query ?? {})
    const { from, to } = defaultCrmWindow(parsed.to, parsed.from)
    const result = await getCrmSegmentMetrics(getPool(), {
      segmentId: parsed.segmentId,
      sites: parsed.sites,
      from,
      to,
    })
    if (result === null) {
      return reply.status(404).send({ error: `No segment ${parsed.segmentId} is known to Helios.` })
    }
    return reply.send(CrmSegmentMetricsResponseSchema.parse(result))
  })
}
