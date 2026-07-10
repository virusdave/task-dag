import type { FastifyInstance } from 'fastify'

import {
  GadsLandingPagesParamsSchema,
  GadsLandingPagesQuerySchema,
  GadsLandingPagesResponseSchema,
} from '../../shared/contracts/index.js'
import { GADS_METRIC_SCOPE_BY_TAB_ID, requiredGadsGrants } from '../../shared/domain/gadsSites.js'
import { requireConfidentialMetricsGrant } from '../auth/requireSession.js'
import { getGadsLandingPages } from '../db/queries/gadsLandingPagesQueries.js'

export async function registerGadsLandingPagesRoutes(
  server: FastifyInstance,
): Promise<void> {
  // GET /api/gads/<site-scope>/landing-pages?from=&to=&family=&experimentId=
  //
  // One consolidated endpoint powering the per-site
  // /metrics/gads-<site>/landing-pages surface. Reads ONLY the
  // out-of-band gads_lp_rollup + refresh-state row (never raw
  // lp_events; see gadsLandingPagesQueries.ts) and returns KPI strip +
  // funnel + variant table + per-site breakdown + freshness/data-quality
  // in one round-trip.
  //
  // Access: the path segment is validated against the shared IA registry
  // (`gads-bronx`, `gads-midtown`, `gads-all`), then the SERVER derives
  // BOTH the grant list and DB scope from that same registry entry. A
  // client cannot widen the site predicate via query string. This surface
  // exposes confidential evolution-engine internals, so the payload is
  // aggregate-only (no raw events, gclid_hash, or assignment ids) and
  // marked no-store.
  server.get('/api/gads/:siteScope/landing-pages', async (request, reply) => {
    const parsedParams = GadsLandingPagesParamsSchema.safeParse(request.params ?? {})
    const parsedQuery = GadsLandingPagesQuerySchema.safeParse(request.query ?? {})
    if (!parsedParams.success || !parsedQuery.success) {
      return reply.status(400).send({ error: 'Invalid GAds landing-pages query.' })
    }
    const metricScope = GADS_METRIC_SCOPE_BY_TAB_ID[parsedParams.data.siteScope]
    const { from, to, family, experimentId } = parsedQuery.data
    const site = metricScope.scope

    const grants = requiredGadsGrants(site)
    const user = await requireConfidentialMetricsGrant(request, reply, grants)
    if (!user) return

    const result = await getGadsLandingPages({
      scope: site,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      family,
      experimentId,
    })

    reply.header('Cache-Control', 'no-store')
    return reply.send(GadsLandingPagesResponseSchema.parse(result))
  })
}
