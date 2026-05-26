/**
 * REST surface for the Catalog → Brand Mapping page (issue #20).
 *
 *   GET    /api/catalog/brand-mapping                — list every catalog brand
 *                                                     with override + heuristic
 *                                                     candidate + full LitAlerts
 *                                                     brand directory for the
 *                                                     in-page combobox.
 *   PUT    /api/catalog/brand-mapping/:brandName     — upsert an override.
 *                                                     Pass {litalertsBrandId:null}
 *                                                     to record "no LitAlerts
 *                                                     equivalent exists".
 *   DELETE /api/catalog/brand-mapping/:brandName     — clear an override (returns
 *                                                     the brand to heuristic-only).
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import {
  deleteBrandOverride,
  loadCatalogBrandMappings,
  upsertBrandOverride,
} from '../db/queries/catalogLitalertsBrandOverridesQueries.js'

const UpsertBodySchema = z.object({
  litalertsBrandId: z.number().int().positive().nullable(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

export async function registerCatalogLitalertsBrandOverridesRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/catalog/brand-mapping', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    const data = await loadCatalogBrandMappings(getPool())
    return reply.send(data)
  })

  server.put<{ Params: { brandName: string } }>(
    '/api/catalog/brand-mapping/:brandName',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'editor')
      if (!user) return
      const brandName = decodeURIComponent(request.params.brandName).trim()
      if (brandName.length === 0) {
        return reply.code(400).send({ error: 'empty_brand_name' })
      }
      const body = UpsertBodySchema.parse(request.body ?? {})
      const row = await upsertBrandOverride(getPool(), {
        catalogBrandName: brandName,
        litalertsBrandId: body.litalertsBrandId,
        setByUserId: String(user.id),
        notes: body.notes ?? null,
      })
      return reply.send({ row })
    },
  )

  server.delete<{ Params: { brandName: string } }>(
    '/api/catalog/brand-mapping/:brandName',
    async (request, reply) => {
      const user = await requireSessionUser(request, reply, 'editor')
      if (!user) return
      const brandName = decodeURIComponent(request.params.brandName).trim()
      if (brandName.length === 0) {
        return reply.code(400).send({ error: 'empty_brand_name' })
      }
      await deleteBrandOverride(getPool(), brandName)
      return reply.send({ ok: true })
    },
  )
}
