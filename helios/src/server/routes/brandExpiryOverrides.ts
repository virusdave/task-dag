import type { FastifyInstance } from 'fastify'

import {
  BrandExpiryOverrideResponseSchema,
  BrandExpiryOverrideUpsertRequestSchema,
  BrandExpiryOverridesListResponseSchema,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import {
  deleteBrandExpiryOverride,
  getBrandExpiryOverride,
  listBrandExpiryOverrides,
  upsertBrandExpiryOverride,
} from '../db/queries/brandExpiryOverridesQueries.js'
import { withTransaction } from '../db/tx.js'

export async function registerBrandExpiryOverridesRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/config/brand-expiry-overrides', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return
    try {
      const items = await listBrandExpiryOverrides(getPool())
      return reply.send(BrandExpiryOverridesListResponseSchema.parse({ items }))
    } catch (error) {
      return surface503IfTableMissing(error, reply) ?? Promise.reject(error)
    }
  })

  server.put<{ Params: { brandName: string } }>(
    '/api/config/brand-expiry-overrides/:brandName',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'admin')
      if (!user) return

      const brandName = decodeURIComponent(request.params.brandName).trim()
      if (!brandName) {
        return reply.status(400).send({ error: 'brandName path segment is required.' })
      }

      const body = BrandExpiryOverrideUpsertRequestSchema.parse(request.body ?? {})

      try {
        const item = await withTransaction(async (db) => {
          const previous = await getBrandExpiryOverride(db, brandName)
          const upserted = await upsertBrandExpiryOverride(db, {
            brandName,
            expiryDays: body.expiryDays,
            brandId: body.brandId ?? null,
            notes: body.notes ?? null,
            updatedByUserId: user.id,
          })
          await appendAuditEvent(db, {
            actorType: 'user',
            actorUserId: user.id,
            entityId: upserted.brandName,
            entityType: 'brand_expiry_override',
            eventType: 'config.brand_expiry_override.upserted',
            module: 'config',
            payload: {
              brandName: upserted.brandName,
              brandId: upserted.brandId,
              expiryDays: upserted.expiryDays,
              notes: upserted.notes,
              previousExpiryDays: previous?.expiryDays ?? null,
              previousNotes: previous?.notes ?? null,
            },
            requestId: null,
            scope: null,
            undoPayload: null,
          })
          return upserted
        })
        return reply.send(BrandExpiryOverrideResponseSchema.parse({ item }))
      } catch (error) {
        return surface503IfTableMissing(error, reply) ?? Promise.reject(error)
      }
    },
  )

  server.delete<{ Params: { brandName: string } }>(
    '/api/config/brand-expiry-overrides/:brandName',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'admin')
      if (!user) return

      const brandName = decodeURIComponent(request.params.brandName).trim()
      if (!brandName) {
        return reply.status(400).send({ error: 'brandName path segment is required.' })
      }

      try {
        const result = await withTransaction(async (db) => {
          const previous = await getBrandExpiryOverride(db, brandName)
          if (!previous) {
            return { found: false as const }
          }
          await deleteBrandExpiryOverride(db, brandName)
          await appendAuditEvent(db, {
            actorType: 'user',
            actorUserId: user.id,
            entityId: previous.brandName,
            entityType: 'brand_expiry_override',
            eventType: 'config.brand_expiry_override.deleted',
            module: 'config',
            payload: {
              brandName: previous.brandName,
              brandId: previous.brandId,
              previousExpiryDays: previous.expiryDays,
              previousNotes: previous.notes,
            },
            requestId: null,
            scope: null,
            undoPayload: null,
          })
          return { found: true as const, previous }
        })
        if (!result.found) {
          return reply.status(404).send({ error: `No brand expiry override exists for "${brandName}".` })
        }
        return reply.status(204).send()
      } catch (error) {
        return surface503IfTableMissing(error, reply) ?? Promise.reject(error)
      }
    },
  )
}

/**
 * Mirrors the sweed-auth-events 503 pattern: when migration 012 has
 * not been applied yet the table won't exist, and we'd rather surface
 * an actionable "apply the migration" error than a generic 500.
 */
function surface503IfTableMissing(error: unknown, reply: import('fastify').FastifyReply) {
  const message = error instanceof Error ? error.message : String(error)
  if (/relation .*brand_expiry_overrides.* does not exist/i.test(message)) {
    return reply.status(503).send({
      error:
        'Brand expiry overrides table is missing. Apply migration 012_market_data_brand_expiry_overrides.sql.',
    })
  }
  return null
}
