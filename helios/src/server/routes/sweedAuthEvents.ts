import type { FastifyInstance } from 'fastify'

import {
  SweedAuthEventsQuerySchema,
  SweedAuthEventsResponseSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { listSweedAuthEvents } from '../db/queries/sweedAuthEventsQueries.js'

export async function registerSweedAuthEventsRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/sweed/auth-events', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) {
      return
    }

    const query = SweedAuthEventsQuerySchema.parse(request.query)
    try {
      const response = await listSweedAuthEvents(getPool(), query)
      return reply.send(SweedAuthEventsResponseSchema.parse(response))
    } catch (error) {
      // The most common failure here is "relation sweed_auth_events
      // does not exist" because migration 011 hasn't been applied
      // yet. Surface a 503 so the UI page can render a clear
      // "migration not applied" empty-state, instead of looking like
      // a generic 500.
      const message = error instanceof Error ? error.message : String(error)
      if (/relation .*sweed_auth_events.* does not exist/i.test(message)) {
        return reply
          .status(503)
          .send({ error: 'Sweed auth event log table is missing. Apply migration 011_sweed_auth_events.sql.' })
      }
      throw error
    }
  })
}
