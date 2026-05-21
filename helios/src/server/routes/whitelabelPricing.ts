import type { FastifyInstance } from 'fastify'

import {
  CostBasisRefreshResponseSchema,
  PublicBulkFlowerResponseSchema,
  WhitelabelCurrentSnapshotResponseSchema,
  WhitelabelSnapshotSubmissionSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import {
  getCurrentWhitelabelSnapshot,
  insertWhitelabelSnapshot,
} from '../db/queries/whitelabelPricingQueries.js'
import { collectFlowerCostBasis } from '../whitelabel/collectFlowerCostBasis.js'
import { buildPublicProjection, buildSnapshotPayload } from '../whitelabel/computeSnapshot.js'

export async function registerWhitelabelPricingRoutes(server: FastifyInstance): Promise<void> {
  // Editor: collect a fresh cost-basis snapshot from Sweed. Synchronous
  // (≈30–60s); guarded behind an editor session. Not persisted — the
  // operator chooses when to bake it into a saved snapshot.
  server.post('/api/whitelabel/pricing/cost-basis/refresh', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return
    const response = await collectFlowerCostBasis()
    return reply.send(CostBasisRefreshResponseSchema.parse(response))
  })

  // Editor: current saved snapshot (or { snapshot: null } if never saved).
  server.get('/api/whitelabel/pricing/snapshot/current', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    const snapshot = await getCurrentWhitelabelSnapshot()
    return reply.send(WhitelabelCurrentSnapshotResponseSchema.parse({ snapshot }))
  })

  // Editor: persist a new snapshot, atomically marked is_current=true.
  server.post('/api/whitelabel/pricing/snapshot', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return
    const submission = WhitelabelSnapshotSubmissionSchema.parse(request.body)
    const payload = buildSnapshotPayload(submission)
    const saved = await insertWhitelabelSnapshot({
      createdBy: user.email,
      costBasisGeneratedAt: submission.costBasis.generatedAt,
      payload,
    })
    return reply.send(WhitelabelCurrentSnapshotResponseSchema.parse({ snapshot: saved }))
  })

  // PUBLIC, UNAUTHENTICATED. Returns the latest saved snapshot's
  // accepted-row projection. No cost/GM/provenance is included. Add
  // /api/whitelabel/public/bulk-flower to the auth gate's allowlist
  // (see authGate.ts).
  server.get('/api/whitelabel/public/bulk-flower', async (_request, reply) => {
    const snapshot = await getCurrentWhitelabelSnapshot()
    if (!snapshot) {
      return reply.status(503).send({ error: 'No published bulk-flower menu yet.' })
    }
    const projection = buildPublicProjection(snapshot)
    // No-store: the public site fetches per request and we want every
    // save to be reflected immediately.
    reply.header('cache-control', 'no-store')
    reply.header('access-control-allow-origin', '*')
    return reply.send(PublicBulkFlowerResponseSchema.parse(projection))
  })
}
