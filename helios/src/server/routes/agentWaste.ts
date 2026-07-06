/**
 * Agent-waste review-queue API routes (Fastify) — issue #57.
 *
 * ADMIN-GATED. The observations here are an internal operator surface; the
 * navbar entry is hidden for non-admins client-side, but THIS route is the
 * access control (hiding a nav entry is not access control). Admin ==
 * `canManageUsers`, which maps to role `admin` (see
 * shared/domain/permissions.ts) — enforced server-side via
 * requireSessionUser(..., 'admin').
 *
 * The endpoint degrades gracefully: when the backlog source is unavailable
 * it returns a structured 503 (`agent_waste_unavailable`) with the source
 * status instead of a raw 500, mirroring routes/taskDag.ts.
 */

import type { FastifyInstance, FastifyReply } from 'fastify'

import { requireSessionUser } from '../auth/requireSession.js'
import {
  AgentWasteUnavailableError,
  getBacklog,
  getBacklogSourceStatus,
} from '../agentWasteRepo.js'
import type { AgentWasteBacklogResponse } from '../../shared/contracts/api/agentWaste.js'

export function handleAgentWasteError(
  server: FastifyInstance,
  reply: FastifyReply,
  error: unknown,
  context: string,
): FastifyReply {
  if (error instanceof AgentWasteUnavailableError) {
    return reply.status(503).send({
      error: 'agent_waste_unavailable',
      message: 'Agent-waste backlog data is temporarily unavailable.',
      source: error.status,
    })
  }
  server.log.error(error, context)
  return reply.status(500).send({ error: context })
}

export async function registerAgentWasteRoutes(server: FastifyInstance): Promise<void> {
  // GET /api/agent-waste/backlog - observations awaiting human review.
  server.get('/api/agent-waste/backlog', async (request, reply) => {
    const actor = await requireSessionUser(request, reply, 'admin')
    if (!actor) {
      return
    }
    try {
      const observations = await getBacklog()
      const body: AgentWasteBacklogResponse = {
        source: getBacklogSourceStatus(),
        observations,
      }
      return reply.send(body)
    } catch (error) {
      return handleAgentWasteError(server, reply, error, 'Failed to fetch agent-waste backlog')
    }
  })
}
