import type { FastifyInstance } from 'fastify'

import {
  GadsLandingPagesRequestSchema,
  GadsLandingPagesResponseSchema,
} from '../../shared/contracts/index.js'
import { isGadsScope, requiredGadsGrants } from '../../shared/domain/gadsSites.js'
import { requireConfidentialMetricsGrant } from '../auth/requireSession.js'
import { getGadsLandingPages } from '../db/queries/gadsLandingPagesQueries.js'

export async function registerGadsLandingPagesRoutes(
  server: FastifyInstance,
): Promise<void> {
  // GET /api/gads/landing-pages?site=&from=&to=&family=&experimentId=
  //
  // One consolidated endpoint powering the per-site
  // /metrics/gads-<site>/landing-pages surface. Reads ONLY the
  // out-of-band gads_lp_rollup + refresh-state row (never raw
  // lp_events; see gadsLandingPagesQueries.ts) and returns KPI strip +
  // funnel + variant table + data-quality in one round-trip.
  //
  // Access: gated per-scope via requiredGadsGrants() — site=bronx
  // needs gads-bronx OR gads-all; site=all needs gads-all; admins
  // pass via the implicit-all-grants shortcut. The grant list is the
  // SAME source the client tab/sidebar visibility uses, so they never
  // drift. This surface exposes confidential evolution-engine
  // internals, so the payload is aggregate-only (no raw events,
  // gclid_hash, or assignment ids) and marked no-store.
  server.get('/api/gads/landing-pages', async (request, reply) => {
    const parsed = GadsLandingPagesRequestSchema.safeParse(request.query ?? {})
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid GAds landing-pages query.' })
    }
    const { site, from, to, family, experimentId } = parsed.data

    // Defensive: the schema already constrains site to the scope enum,
    // but validate again before deriving grants so an unknown scope can
    // never collapse to an empty/over-broad grant list.
    if (!isGadsScope(site)) {
      return reply.status(400).send({ error: `Unknown GAds site scope: ${site}.` })
    }

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
