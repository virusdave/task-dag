// Helios → Utilities → Promo Names — server side.
//
// Lets an editor set the `shortName` on a Sweed promo action
// without the length/character constraints the Sweed UI's
// "Discounts" form imposes. The underlying RPC
// (store.promo.action.edit) happily accepts longer / spaced
// strings; this just exposes that capability.
//
// All three endpoints lease ONE Sweed session per request via
// withSweedSession(), so callers don't have to wait on the worker
// loop and the auth-event audit trail still captures the action.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import {
  PromoNamesActionResponseSchema,
  PromoNamesActionSchema,
  PromoNamesDealerListResponseSchema,
  PromoNamesDealerSchema,
  PromoNamesShortNameUpdateSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { callSweedRpc, callSweedRpcRaw } from '../../worker/sweed/rpc.js'
import { withSweedSession } from '../../worker/sweed/session.js'

const SweedDealerListItemSchema = z
  .object({
    id: z.coerce.number().int(),
    name: z.string(),
    dealerTypeName: z.string().nullable().optional(),
  })
  .passthrough()

const SweedActionRecordSchema = z
  .object({
    id: z.coerce.string(),
    name: z.string(),
    shortName: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
    campaignId: z.coerce.string().nullable().optional(),
    campaignName: z.string().nullable().optional(),
  })
  .passthrough()

async function fetchAction(dealerId: number, actionId: string) {
  const raw = await callSweedRpc<unknown>(dealerId, 'store.promo.action.get', { id: actionId })
  const parsed = SweedActionRecordSchema.parse(raw)
  return PromoNamesActionSchema.parse({
    id: parsed.id,
    dealerId,
    name: parsed.name,
    shortName: parsed.shortName ?? null,
    enabled: parsed.enabled ?? false,
    campaignId: parsed.campaignId ?? null,
    campaignName: parsed.campaignName ?? null,
  })
}

function actionIdParam(value: string): string {
  const t = value.trim()
  if (!/^\d+$/.test(t)) {
    throw new Error(`Invalid action id: ${value}`)
  }
  return t
}

function dealerIdParam(value: string): number {
  const t = value.trim()
  if (!/^\d+$/.test(t)) {
    throw new Error(`Invalid dealer id: ${value}`)
  }
  return Number(t)
}

export async function registerUtilitiesPromoNamesRoutes(server: FastifyInstance): Promise<void> {
  // Dealer dropdown — every dealer the leased Sweed session can switch to.
  server.get('/api/utilities/promo-names/dealers', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    const dealers = await withSweedSession(async () => {
      const raw = await callSweedRpcRaw<unknown>('store.auth.dealer.list')
      return z.array(SweedDealerListItemSchema).parse(raw).map((d) =>
        PromoNamesDealerSchema.parse({
          id: d.id,
          name: d.name,
          dealerTypeName: d.dealerTypeName ?? null,
        }),
      )
    })
    return reply.send(PromoNamesDealerListResponseSchema.parse({ dealers }))
  })

  // Look up one promo action under a specific dealer.
  server.get<{ Params: { dealerId: string; actionId: string } }>(
    '/api/utilities/promo-names/actions/:dealerId/:actionId',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'viewer')
      if (!user) return
      let dealerId: number
      let actionId: string
      try {
        dealerId = dealerIdParam(request.params.dealerId)
        actionId = actionIdParam(request.params.actionId)
      } catch (err) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : 'bad request' })
      }
      try {
        const action = await withSweedSession(() => fetchAction(dealerId, actionId))
        return reply.send(PromoNamesActionResponseSchema.parse({ action }))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'lookup failed'
        const status = /does not exist|permission|allowed dealer/i.test(message) ? 404 : 502
        return reply.status(status).send({ error: message })
      }
    },
  )

  // Apply a new shortName.
  server.patch<{ Params: { dealerId: string; actionId: string } }>(
    '/api/utilities/promo-names/actions/:dealerId/:actionId',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'editor')
      if (!user) return
      let dealerId: number
      let actionId: string
      try {
        dealerId = dealerIdParam(request.params.dealerId)
        actionId = actionIdParam(request.params.actionId)
      } catch (err) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : 'bad request' })
      }
      const body = PromoNamesShortNameUpdateSchema.parse(request.body)
      try {
        const after = await withSweedSession(async () => {
          await callSweedRpc<unknown>(dealerId, 'store.promo.action.edit', {
            id: actionId,
            shortName: body.shortName,
          })
          return fetchAction(dealerId, actionId)
        })
        if (after.shortName !== body.shortName) {
          return reply.status(502).send({
            error: `Sweed accepted the edit but returned shortName ${JSON.stringify(after.shortName)} (expected ${JSON.stringify(body.shortName)})`,
          })
        }
        request.log.info(
          { dealerId, actionId, shortName: body.shortName, by: user.email },
          '[utilities/promo-names] shortName updated',
        )
        return reply.send(PromoNamesActionResponseSchema.parse({ action: after }))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'edit failed'
        const status = /does not exist|permission|allowed dealer/i.test(message) ? 404 : 502
        return reply.status(status).send({ error: message })
      }
    },
  )
}
