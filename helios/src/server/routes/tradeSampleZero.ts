import type { FastifyInstance } from 'fastify'

import { TradeSampleZeroApplyRequestSchema, TradeSampleZeroApplyResponseSchema, TradeSampleZeroPreviewRequestSchema, TradeSampleZeroPreviewResponseSchema } from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import {
  applyTradeSampleZero,
  previewTradeSampleZero,
  TradeSampleZeroBusyError,
  TradeSampleZeroCandidateLimitError,
  TradeSampleZeroStaleError,
} from '../catalog/tradeSampleZeroService.js'
import { withSweedSession } from '../../worker/sweed/session.js'

export async function registerTradeSampleZeroRoutes(server: FastifyInstance): Promise<void> {
  server.post('/api/catalog/inventory/trade-samples/preview-zero', async (request, reply) => {
    if (!await requireSessionUser(request, reply, 'editor')) return
    const parsed = TradeSampleZeroPreviewRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.status(400).send({ error: 'A valid siteDealerId is required.' })
    try {
      const result = await withSweedSession(() => previewTradeSampleZero(parsed.data.siteDealerId))
      return reply.send(TradeSampleZeroPreviewResponseSchema.parse(result))
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unknown siteDealerId')) return reply.status(400).send({ error: error.message })
      if (error instanceof TradeSampleZeroCandidateLimitError) return reply.status(409).send({ error: error.message })
      request.log.error({ err: error, requestId: request.id }, 'trade-sample zero preview failed')
      return reply.status(503).send({ error: 'Trade sample inventory is temporarily unavailable.' })
    }
  })

  server.post('/api/catalog/inventory/trade-samples/apply-zero', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return
    const parsed = TradeSampleZeroApplyRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success || parsed.data.confirmation !== 'ZERO TRADE SAMPLES') {
      return reply.status(400).send({ error: 'Valid preview data and exact confirmation ZERO TRADE SAMPLES are required.' })
    }
    try {
      const result = await withSweedSession(() => applyTradeSampleZero({ ...parsed.data, actorUserId: user.id, requestId: request.id ?? null }))
      return reply.send(TradeSampleZeroApplyResponseSchema.parse(result))
    } catch (error) {
      if (error instanceof TradeSampleZeroStaleError || error instanceof TradeSampleZeroBusyError) {
        return reply.status(409).send({ error: error.message })
      }
      if (error instanceof Error && error.message.startsWith('Unknown siteDealerId')) return reply.status(400).send({ error: error.message })
      request.log.error({ err: error, requestId: request.id }, 'trade-sample zero apply failed')
      return reply.status(502).send({ error: 'Trade sample adjustment could not be completed.' })
    }
  })
}
