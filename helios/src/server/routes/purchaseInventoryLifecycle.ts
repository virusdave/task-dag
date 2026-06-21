import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  PurchaseLifecycleActionRequestSchema,
  PurchaseLifecycleReleaseRequestSchema,
  PurchaseLifecycleReleaseTargetsResponseSchema,
  PurchaseLifecycleStartRequestSchema,
  PurchaseLifecycleStatusResponseSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import {
  continueRelease,
  getLifecycleStatus,
  LifecycleBadRequestError,
  LifecycleConflictError,
  LifecycleMigrationPendingError,
  LifecycleReleaseMigrationPendingError,
  listReleaseTargets,
  marketRefresh,
  release,
  repairQuarantine,
  reprice,
  rollbackRelease,
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
// L2 — bulk quarantine repair + gated release:
//   GET  /api/catalog/purchases/:poId/lifecycle/release-targets?dealerId=…
//   POST /api/catalog/purchases/:poId/lifecycle/repair-quarantine
//   POST /api/catalog/purchases/:poId/lifecycle/release
//   POST /api/catalog/purchases/:poId/lifecycle/continue-release
//   POST /api/catalog/purchases/:poId/lifecycle/rollback-release
// ---------------------------------------------------------------------------

function handleLifecycleError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof LifecycleReleaseMigrationPendingError) {
    return reply
      .code(409)
      .send({ error: error.message, migrationPending: true, releaseMigrationPending: true })
  }
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

  // ----------------------------- L2 routes -------------------------------

  // The FOR SALE rooms the operator can release into. Resolved live from
  // Sweed so the panel's dropdown can never offer a retired/disabled room.
  server.get<{ Params: { poId: string }; Querystring: { dealerId?: string } }>(
    '/api/catalog/purchases/:poId/lifecycle/release-targets',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'viewer')
      if (!user) return
      const dealerId = Number(request.query.dealerId)
      if (!Number.isFinite(dealerId)) {
        return reply.code(400).send({ error: 'dealerId query param required' })
      }
      try {
        const targets = await listReleaseTargets(dealerId, request.params.poId)
        return reply.send(PurchaseLifecycleReleaseTargetsResponseSchema.parse(targets))
      } catch (error) {
        return handleLifecycleError(reply, error)
      }
    },
  )

  server.post<{ Params: { poId: string } }>(
    '/api/catalog/purchases/:poId/lifecycle/repair-quarantine',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'editor')
      if (!user) return
      const body = PurchaseLifecycleActionRequestSchema.parse(request.body ?? {})
      try {
        const status = await repairQuarantine({
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
    '/api/catalog/purchases/:poId/lifecycle/release',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'editor')
      if (!user) return
      const body = PurchaseLifecycleReleaseRequestSchema.parse(request.body ?? {})
      try {
        const status = await release({
          dealerId: body.dealerId,
          poId: request.params.poId,
          expectedVersion: body.expectedVersion,
          targetLocationId: body.targetLocationId,
          userId: user.id,
        })
        return reply.send(PurchaseLifecycleStatusResponseSchema.parse(status))
      } catch (error) {
        return handleLifecycleError(reply, error)
      }
    },
  )

  server.post<{ Params: { poId: string } }>(
    '/api/catalog/purchases/:poId/lifecycle/continue-release',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'editor')
      if (!user) return
      const body = PurchaseLifecycleActionRequestSchema.parse(request.body ?? {})
      try {
        const status = await continueRelease({
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
    '/api/catalog/purchases/:poId/lifecycle/rollback-release',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'editor')
      if (!user) return
      const body = PurchaseLifecycleActionRequestSchema.parse(request.body ?? {})
      try {
        const status = await rollbackRelease({
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
