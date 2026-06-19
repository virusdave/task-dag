import type { FastifyInstance } from 'fastify'

import {
  GadsEvolutionRequestSchema,
  GadsEvolutionResponseSchema,
} from '../../shared/contracts/index.js'
import { isGadsScope, requiredGadsGrants } from '../../shared/domain/gadsSites.js'
import { requireMetricsGrant } from '../auth/requireSession.js'
import { getGadsEvolution } from '../db/queries/gadsEvolutionQueries.js'

export async function registerGadsEvolutionRoutes(
  server: FastifyInstance,
): Promise<void> {
  // GET /api/gads/evolution?site=&from=&to=
  //
  // Aggregate loop-health for the per-site /metrics/gads-<site>/evolution
  // page (parent epic virusdave/top-level#24, child automation#51 P3).
  // Reads ONLY gads_ad_attempts with bounded aggregate queries; this is
  // observed policy-state movement over the evolver's own attempts, NOT
  // causal ad lift. L3 + landingpage_ad_outcomes enrichment is P6.
  //
  // Access: gated per-scope via requiredGadsGrants() — site=bronx needs
  // gads-bronx OR gads-all; site=all needs gads-all. The SAME validated
  // scope drives BOTH the grant gate and the server-derived site
  // predicate (no client-supplied widening). Payload is aggregate-only
  // and marked no-store (confidential evolution-engine internals).
  server.get('/api/gads/evolution', async (request, reply) => {
    const parsed = GadsEvolutionRequestSchema.safeParse(request.query ?? {})
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid GAds evolution query.' })
    }
    const { site, from, to } = parsed.data

    // Defensive revalidation before deriving grants / the predicate so an
    // unknown scope can never collapse to an empty/over-broad grant list.
    if (!isGadsScope(site)) {
      return reply.status(400).send({ error: `Unknown GAds site scope: ${site}.` })
    }

    const grants = requiredGadsGrants(site)
    const user = await requireMetricsGrant(request, reply, ...grants)
    if (!user) return

    const result = await getGadsEvolution({
      scope: site,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    })

    reply.header('Cache-Control', 'no-store')
    return reply.send(GadsEvolutionResponseSchema.parse(result))
  })
}
