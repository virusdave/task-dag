import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import {
  BrandFamilyMarketMatchResponseSchema,
  CatalogFamilyExplorerResponseSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { loadBrandFamilyMarketMatch } from '../db/queries/catalogFamilyMarketMatchQueries.js'
import { listAllCatalogVariants } from '../db/queries/catalogFamilyExplorerQueries.js'

const BrandFamilyMatchQuerySchema = z.object({
  familyKey: z.string().min(1),
  // Empty string = the no-brand sub-family; anything else is a brand key.
  brandKey: z.string().optional().default(''),
})

/**
 * Temporary Categorical Family Explorer (issue #55, task T1).
 *
 * Ships the WHOLE variant catalog (raw, ungrouped) so the client can group it
 * into categorical families and toggle nonbrand/brand mode without a refetch.
 * Read-only, viewer-gated.
 */
export async function registerCatalogFamilyExplorerRoutes(
  server: FastifyInstance,
): Promise<void> {
  // GET /api/catalog/family-explorer/variants
  server.get('/api/catalog/family-explorer/variants', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    const variants = await listAllCatalogVariants(getPool())
    return reply.send(
      CatalogFamilyExplorerResponseSchema.parse({
        generatedAt: new Date().toISOString(),
        variants,
      }),
    )
  })

  // GET /api/catalog/family-explorer/market-match?familyKey=...&brandKey=...
  //
  // Lazily fetch, for ONE brand-categorical-family, the LitAlerts partner
  // listings the REAL matcher associates with it + the per-candidate scores /
  // factor breakdown + mapping-state / dedup / staleness caveats (issue #58 T2).
  server.get('/api/catalog/family-explorer/market-match', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    const parsed = BrandFamilyMatchQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query', details: parsed.error.flatten() })
    }
    // Empty brandKey means the no-brand sub-family; pass null downstream.
    const brandKey = parsed.data.brandKey.length > 0 ? parsed.data.brandKey : null
    const result = await loadBrandFamilyMarketMatch(getPool(), parsed.data.familyKey, brandKey)
    if (!result) {
      return reply
        .code(404)
        .send({ error: 'Family not found in current catalog — refresh the page.' })
    }
    return reply.send(BrandFamilyMarketMatchResponseSchema.parse(result))
  })
}
