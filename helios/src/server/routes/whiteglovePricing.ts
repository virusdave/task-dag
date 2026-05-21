import type { FastifyInstance } from 'fastify'

import {
  CostBasisRefreshResponseSchema,
  PublicBulkFlowerResponseSchema,
  WhitegloveCurrentSnapshotResponseSchema,
  WhitegloveSnapshotSubmissionSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import {
  getCurrentWhitegloveSnapshot,
  insertWhitegloveSnapshot,
} from '../db/queries/whiteglovePricingQueries.js'
import { collectFlowerCostBasis } from '../whiteglove/collectFlowerCostBasis.js'
import { buildPublicProjection, buildSnapshotPayload } from '../whiteglove/computeSnapshot.js'

export async function registerWhiteglovePricingRoutes(server: FastifyInstance): Promise<void> {
  // Editor: collect a fresh cost-basis snapshot from Sweed. Synchronous
  // (≈30–60s); guarded behind an editor session. Not persisted — the
  // operator chooses when to bake it into a saved snapshot.
  server.post('/api/whiteglove/pricing/cost-basis/refresh', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return
    const response = await collectFlowerCostBasis()
    return reply.send(CostBasisRefreshResponseSchema.parse(response))
  })

  // Editor: current saved snapshot (or { snapshot: null } if never saved).
  server.get('/api/whiteglove/pricing/snapshot/current', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    const snapshot = await getCurrentWhitegloveSnapshot()
    return reply.send(WhitegloveCurrentSnapshotResponseSchema.parse({ snapshot }))
  })

  // Editor: persist a new snapshot, atomically marked is_current=true.
  server.post('/api/whiteglove/pricing/snapshot', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return
    const submission = WhitegloveSnapshotSubmissionSchema.parse(request.body)
    const payload = buildSnapshotPayload(submission)
    const saved = await insertWhitegloveSnapshot({
      createdBy: user.email,
      costBasisGeneratedAt: submission.costBasis.generatedAt,
      payload,
    })
    return reply.send(WhitegloveCurrentSnapshotResponseSchema.parse({ snapshot: saved }))
  })

  // PUBLIC, UNAUTHENTICATED. Returns the latest saved snapshot's
  // accepted-row projection. No cost/GM/provenance is included. Add
  // /api/whiteglove/public/bulk-flower to the auth gate's allowlist
  // (see authGate.ts).
  server.get('/api/whiteglove/public/bulk-flower', async (_request, reply) => {
    const snapshot = await getCurrentWhitegloveSnapshot()
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
