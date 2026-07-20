import type { FastifyInstance } from 'fastify'

import {
  CreateCapabilityOverlaySchema,
  createOverlay,
  revokeOverlay,
  setEmergencyDisabled,
} from '../auth/agentCapability.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getServerEnv } from '../config/env.js'

export async function registerAgentCapabilityOverlayRoutes(server: FastifyInstance): Promise<void> {
  server.post('/api/config/signed-agent-capability-overlays', async (request, reply) => {
    const actor = await requireSessionUser(request, reply, 'admin')
    if (!actor) return
    const envelope = createOverlay(getServerEnv().agentCapability, CreateCapabilityOverlaySchema.parse(request.body), actor, request.id)
    request.log.info({ event: 'agent_capability_overlay.created', actorUserId: actor.id, actorEmail: actor.email,
      grantId: envelope.shape.grant_id, shapeSha256: envelope.shape_sha256, requestId: request.id }, 'signed-agent capability overlay administration audit')
    return reply.status(201).send(envelope)
  })

  server.delete<{ Params: { grantId: string } }>('/api/config/signed-agent-capability-overlays/:grantId', async (request, reply) => {
    const actor = await requireSessionUser(request, reply, 'admin')
    if (!actor) return
    if (request.url.includes('?') || request.body !== undefined) return reply.status(400).send({ error: 'Body and query are not allowed.' })
    const config = getServerEnv().agentCapability
    revokeOverlay(config, request.params.grantId)
    request.log.info({ event: 'agent_capability_overlay.revoked', actorUserId: actor.id, actorEmail: actor.email,
      grantId: request.params.grantId, requestId: request.id }, 'signed-agent capability overlay administration audit')
    return reply.status(204).send()
  })

  for (const [path, disabled] of [['emergency-disable', true], ['emergency-enable', false]] as const) {
    server.post(`/api/config/signed-agent-capability-overlays/${path}`, async (request, reply) => {
      const actor = await requireSessionUser(request, reply, 'admin')
      if (!actor) return
      if (request.url.includes('?') || request.body !== undefined) return reply.status(400).send({ error: 'Body and query are not allowed.' })
      setEmergencyDisabled(getServerEnv().agentCapability, disabled)
      request.log.info({ event: disabled ? 'agent_capability_overlay.emergency_disabled' : 'agent_capability_overlay.emergency_enabled',
        actorUserId: actor.id, actorEmail: actor.email, requestId: request.id }, 'signed-agent capability overlay administration audit')
      return reply.status(204).send()
    })
  }
}
