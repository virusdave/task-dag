import type { FastifyInstance } from 'fastify'

import {
  CatalogPurchaseDetailResponseSchema,
  CatalogPurchaseLineDetailResponseSchema,
  CatalogPurchaseListRequestSchema,
  CatalogPurchaseListResponseSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import {
  getCatalogPurchaseDetail,
  getCatalogPurchaseLineDetail,
  getCatalogPurchaseList,
} from '../catalogPurchaseSellThrough/catalogPurchaseQueries.js'

export async function registerCatalogPurchaseSellThroughRoutes(
  server: FastifyInstance,
): Promise<void> {
  // GET /api/catalog/purchases?sites=&distributorNames=&deliveryFrom=&deliveryTo=&…
  server.get('/api/catalog/purchases', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    const parsed = CatalogPurchaseListRequestSchema.parse(request.query ?? {})
    const result = await getCatalogPurchaseList(parsed)
    return reply.send(CatalogPurchaseListResponseSchema.parse(result))
  })

  // GET /api/catalog/purchases/:poId?dealerId=...
  server.get<{
    Params: { poId: string }
    Querystring: { dealerId?: string }
  }>('/api/catalog/purchases/:poId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    const dealerIdRaw = request.query.dealerId
    const dealerId = dealerIdRaw ? Number(dealerIdRaw) : NaN
    if (!Number.isFinite(dealerId)) {
      return reply.code(400).send({ error: 'dealerId query param required' })
    }
    const result = await getCatalogPurchaseDetail({ dealerId, poId: request.params.poId })
    if (!result) return reply.code(404).send({ error: 'Purchase not found' })
    return reply.send(CatalogPurchaseDetailResponseSchema.parse(result))
  })

  // GET /api/catalog/purchases/:poId/items/:lineId?dealerId=...
  server.get<{
    Params: { poId: string; lineId: string }
    Querystring: { dealerId?: string }
  }>('/api/catalog/purchases/:poId/items/:lineId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    const dealerIdRaw = request.query.dealerId
    const dealerId = dealerIdRaw ? Number(dealerIdRaw) : NaN
    if (!Number.isFinite(dealerId)) {
      return reply.code(400).send({ error: 'dealerId query param required' })
    }
    const result = await getCatalogPurchaseLineDetail({
      dealerId,
      poId: request.params.poId,
      lineId: request.params.lineId,
    })
    if (!result) return reply.code(404).send({ error: 'Purchase line not found' })
    return reply.send(CatalogPurchaseLineDetailResponseSchema.parse(result))
  })
}
