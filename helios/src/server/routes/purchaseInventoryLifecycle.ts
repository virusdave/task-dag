import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  PurchaseLifecycleActionRequestSchema,
  PurchaseLifecycleStartRequestSchema,
  PurchaseLifecycleStatusResponseSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import {
  getLifecycleStatus,
  LifecycleBadRequestError,
  LifecycleConflictError,
  LifecycleMigrationPendingError,
  marketRefresh,
  reprice,
  startLifecycle,
  verifyQuarantine,
} from '../catalogPurchaseSellThrough/purchaseInventoryLifecycleService.js'

// ---------------------------------------------------------------------------
// Catalog → Purchase inventory pricing-safety lifecycle (L1) routes.
//
//   GET  /api/catalog/purchases/:poId/lifecycle?dealerId=…
//   POST /api/catalog/purchases/:poId/lifecycle/start
//   POST /api/catalog/purchases/:poId/lifecycle/verify-quarantine
//   POST /api/catalog/purchases/:poId/lifecycle/market-refresh
//   POST /api/catalog/purchases/:poId/lifecycle/reprice
//
// NO release/reverse-move route — that is L2.
// ---------------------------------------------------------------------------

function handleLifecycleError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof LifecycleMigrationPendingError) {
    return reply.code(409).send({ error: error.message, migrationPending: true })
  }
  if (error instanceof LifecycleConflictError) {
    return reply.code(409).send({ error: error.message })
  }
  if (error instanceof LifecycleBadRequestError) {
    return reply.code(400).send({ error: error.message })
  }
  throw error
}

export async function registerPurchaseInventoryLifecycleRoutes(
  server: FastifyInstance,
): Promise<void> {
  server.get<{ Params: { poId: string }; Querystring: { dealerId?: string } }>(
    '/api/catalog/purchases/:poId/lifecycle',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'viewer')
      if (!user) return
      const dealerId = Number(request.query.dealerId)
      if (!Number.isFinite(dealerId)) {
        return reply.code(400).send({ error: 'dealerId query param required' })
      }
      const status = await getLifecycleStatus(dealerId, request.params.poId)
      return reply.send(PurchaseLifecycleStatusResponseSchema.parse(status))
    },
  )

  server.post<{ Params: { poId: string } }>(
    '/api/catalog/purchases/:poId/lifecycle/start',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'editor')
      if (!user) return
      const body = PurchaseLifecycleStartRequestSchema.parse(request.body ?? {})
      try {
        const status = await startLifecycle({
          dealerId: body.dealerId,
          poId: request.params.poId,
          path: body.path,
          notes: body.notes ?? null,
          userId: user.id,
        })
        return reply.send(PurchaseLifecycleStatusResponseSchema.parse(status))
      } catch (error) {
        return handleLifecycleError(reply, error)
      }
    },
  )

  server.post<{ Params: { poId: string } }>(
    '/api/catalog/purchases/:poId/lifecycle/verify-quarantine',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'editor')
      if (!user) return
      const body = PurchaseLifecycleActionRequestSchema.parse(request.body ?? {})
      try {
        const status = await verifyQuarantine({
          dealerId: body.dealerId,
          poId: request.params.poId,
          expectedVersion: body.expectedVersion,
          userId: user.id,
        })
        return reply.send(PurchaseLifecycleStatusResponseSchema.parse(status))
      } catch (error) {
        return handleLifecycleError(reply, error)
      }
    },
  )

  server.post<{ Params: { poId: string } }>(
    '/api/catalog/purchases/:poId/lifecycle/market-refresh',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'editor')
      if (!user) return
      const body = PurchaseLifecycleActionRequestSchema.parse(request.body ?? {})
      try {
        const status = await marketRefresh({
          dealerId: body.dealerId,
          poId: request.params.poId,
          expectedVersion: body.expectedVersion,
          userId: user.id,
        })
        return reply.send(PurchaseLifecycleStatusResponseSchema.parse(status))
      } catch (error) {
        return handleLifecycleError(reply, error)
      }
    },
  )

  server.post<{ Params: { poId: string } }>(
    '/api/catalog/purchases/:poId/lifecycle/reprice',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'editor')
      if (!user) return
      const body = PurchaseLifecycleActionRequestSchema.parse(request.body ?? {})
      try {
        const status = await reprice({
          dealerId: body.dealerId,
          poId: request.params.poId,
          expectedVersion: body.expectedVersion,
          userId: user.id,
        })
        return reply.send(PurchaseLifecycleStatusResponseSchema.parse(status))
      } catch (error) {
        return handleLifecycleError(reply, error)
      }
    },
  )
}
