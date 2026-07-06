import type { FastifyInstance } from 'fastify'

import { CatalogFamilyExplorerResponseSchema } from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { listAllCatalogVariants } from '../db/queries/catalogFamilyExplorerQueries.js'

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
}
