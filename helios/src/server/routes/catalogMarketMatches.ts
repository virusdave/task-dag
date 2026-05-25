/**
 * REST surface for the Catalog → Market Data review workflow
 * (issue #18 phase 4).
 *
 * Three routes:
 *   GET  /api/catalog/market-matches              — paginated list of
 *                                                   catalog groups
 *                                                   eligible for
 *                                                   review.
 *   GET  /api/catalog/market-matches/:groupId     — full bundle for
 *                                                   one catalog
 *                                                   group: catalog
 *                                                   profile, live
 *                                                   verdicts, ranked
 *                                                   un-verdicted
 *                                                   candidates.
 *   POST /api/catalog/market-matches              — record a verdict
 *                                                   (exact / brand_
 *                                                   family / no_
 *                                                   match). Inserts
 *                                                   a new live row
 *                                                   and supersedes
 *                                                   any prior live
 *                                                   row for the
 *                                                   (group, fuzzy)
 *                                                   pair.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import {
  listGroupsForReview,
  loadGroupReview,
  recordVerdict,
} from '../db/queries/catalogMarketMatchQueries.js'

const VerdictRequestSchema = z.object({
  catalogGroupId: z.number().int().positive(),
  catalogProductId: z.number().int().positive().nullable().optional(),
  fuzzySkuId: z.number().int().positive(),
  verdict: z.enum(['exact', 'brand_family', 'no_match']),
  confidenceAtVerdict: z.number().min(0).max(1).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  brand: z.string().trim().min(1).optional(),
  unverdictedOnly: z.coerce.boolean().default(false),
})

export async function registerCatalogMarketMatchRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/catalog/market-matches', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return

    const query = ListQuerySchema.parse(request.query)
    const { rows, totalCount } = await listGroupsForReview(getPool(), {
      limit: query.limit,
      offset: query.offset,
      brandFilter: query.brand ?? null,
      unverdictedOnly: query.unverdictedOnly,
    })
    return reply.send({
      rows,
      pagination: {
        limit: query.limit,
        offset: query.offset,
        totalCount,
      },
    })
  })

  server.get<{ Params: { groupId: string } }>('/api/catalog/market-matches/:groupId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return

    const groupId = Number.parseInt(request.params.groupId, 10)
    if (!Number.isFinite(groupId) || groupId <= 0) {
      return reply.code(400).send({ error: 'invalid_group_id' })
    }
    const bundle = await loadGroupReview(getPool(), groupId)
    if (!bundle) return reply.code(404).send({ error: 'catalog_group_not_found' })
    return reply.send(bundle)
  })

  server.post('/api/catalog/market-matches', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return

    const body = VerdictRequestSchema.parse(request.body ?? {})
    const row = await recordVerdict(getPool(), {
      catalogGroupId: body.catalogGroupId,
      catalogProductId: body.catalogProductId ?? null,
      fuzzySkuId: body.fuzzySkuId,
      verdict: body.verdict,
      verdictSetByUserId: String(user.id),
      verdictSetVia: 'manual',
      confidenceAtVerdict: body.confidenceAtVerdict ?? null,
      notes: body.notes ?? null,
    })
    return reply.send({ row })
  })
}
