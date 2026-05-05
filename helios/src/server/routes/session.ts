import type { FastifyInstance } from 'fastify'

import { SessionEnvelopeSchema } from '../../shared/contracts/api/session.js'
import { buildSessionEnvelope } from '../auth/requireSession.js'
import { clearSessionCookie } from '../auth/sessionCookie.js'

export async function registerSessionRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/session', async (request, reply) => {
    const envelope = SessionEnvelopeSchema.parse(await buildSessionEnvelope(request))
    return reply.send(envelope)
  })

  server.post('/api/session/logout', async (_request, reply) => {
    clearSessionCookie(reply)
    return reply.status(204).send()
  })
}
