import type { FastifyInstance } from 'fastify'

import {
  JobQueueMetricsResponseSchema,
  JobRouteParamsSchema,
  JobsQuerySchema,
  JobsResponseSchema,
  JobStatusResponseSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { getJobQueueMetrics, getJobStatus, listJobs } from '../db/queries/jobQueries.js'

export async function registerJobRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/jobs', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const query = JobsQuerySchema.parse(request.query)
    const response = await listJobs(getPool(), query)
    return reply.send(JobsResponseSchema.parse(response))
  })

  // Live queue-depth + queueing-delay snapshot. Polled by the
  // Jobs page every ~10s. Cheap (single connection, 3 small
  // aggregate queries) so we don't gate it behind admin.
  server.get('/api/jobs/queue-metrics', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const response = await getJobQueueMetrics(getPool())
    return reply.send(JobQueueMetricsResponseSchema.parse(response))
  })

  server.get('/api/jobs/:jobId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const params = JobRouteParamsSchema.parse(request.params)
    const response = await getJobStatus(getPool(), params.jobId)
    if (!response) {
      return reply.status(404).send({ error: 'Job not found.' })
    }
    return reply.send(JobStatusResponseSchema.parse(response))
  })
}
