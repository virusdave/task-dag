import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import {
  GadsIterationRunDetailRequestSchema,
  GadsIterationRunDetailResponseSchema,
  GadsIterationRunsRequestSchema,
  GadsIterationRunsResponseSchema,
} from '../../shared/contracts/index.js'
import { isGadsScope, requiredGadsGrants } from '../../shared/domain/gadsSites.js'
import { requireMetricsGrant } from '../auth/requireSession.js'
import {
  getGadsIterationRunDetail,
  getGadsIterationRuns,
} from '../db/queries/gadsIterationsQueries.js'

/** The :runId path param: opaque but bounded; always parameterised in SQL. */
const RunIdParamSchema = z.object({
  runId: z.string().trim().min(1).max(128),
})

export async function registerGadsIterationsRoutes(
  server: FastifyInstance,
): Promise<void> {
  // GET /api/gads/iterations?site=&limit=
  //
  // Bounded per-run timeline for the per-site
  // /metrics/gads-<site>/iteration page (parent epic
  // virusdave/top-level#24, child automation#51 P3). Reads ONLY
  // gads_ad_attempts (DB-derived). Same per-scope grant gate +
  // server-derived site predicate as the Evolution surface.
  server.get('/api/gads/iterations', async (request, reply) => {
    const parsed = GadsIterationRunsRequestSchema.safeParse(request.query ?? {})
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid GAds iterations query.' })
    }
    const { site, limit } = parsed.data

    if (!isGadsScope(site)) {
      return reply.status(400).send({ error: `Unknown GAds site scope: ${site}.` })
    }

    const grants = requiredGadsGrants(site)
    const user = await requireMetricsGrant(request, reply, ...grants)
    if (!user) return

    const result = await getGadsIterationRuns({ scope: site, limit })

    reply.header('Cache-Control', 'no-store')
    return reply.send(GadsIterationRunsResponseSchema.parse(result))
  })

  // GET /api/gads/iterations/:runId?site=
  //
  // Per-run drilldown: scoped summary + bounded attempt rows. The site
  // predicate is server-derived, so a per-site caller sees only that
  // site's rows of a (possibly cross-site) run. A run with no rows
  // visible under the scope returns 404 — never a hint that cross-scope
  // rows exist.
  server.get('/api/gads/iterations/:runId', async (request, reply) => {
    const paramsParsed = RunIdParamSchema.safeParse(request.params ?? {})
    if (!paramsParsed.success) {
      return reply.status(400).send({ error: 'Invalid GAds run id.' })
    }
    const queryParsed = GadsIterationRunDetailRequestSchema.safeParse(request.query ?? {})
    if (!queryParsed.success) {
      return reply.status(400).send({ error: 'Invalid GAds iteration detail query.' })
    }
    const { site } = queryParsed.data

    if (!isGadsScope(site)) {
      return reply.status(400).send({ error: `Unknown GAds site scope: ${site}.` })
    }

    const grants = requiredGadsGrants(site)
    const user = await requireMetricsGrant(request, reply, ...grants)
    if (!user) return

    const result = await getGadsIterationRunDetail({
      scope: site,
      runId: paramsParsed.data.runId,
    })
    reply.header('Cache-Control', 'no-store')
    if (!result) {
      return reply.status(404).send({ error: 'Run not found.' })
    }

    return reply.send(GadsIterationRunDetailResponseSchema.parse(result))
  })
}
