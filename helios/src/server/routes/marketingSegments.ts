import type { FastifyInstance } from 'fastify'

import {
  SegmentDetailsResponseSchema,
  SegmentMembershipRefreshResponseSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { withTransaction } from '../db/tx.js'
import { enqueueJob, JOB_PRIORITY_URGENT } from '../jobs/enqueueJob.js'
import {
  getSegmentDetails,
  markSegmentMembershipRefreshPending,
} from '../db/queries/marketingSegmentDetailsQueries.js'

// Read-only Helios "segment details" page + its membership-refresh
// trigger (/config/marketing/segments/:segmentId, virusdave/top-level#12).
//
// GET assembles the whole page from local caches only (no Sweed call) so
// it stays inside the interactive budget. POST .../refresh-membership
// enqueues the deduped per-segment bulk refresh job
// (config.workers.refresh_sweed_segment_members), which is the only thing
// that pulls from Sweed. Reads require role >= viewer; the refresh
// trigger requires role >= editor.

function parseSegmentId(raw: unknown): number | null {
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null
  return n
}

export async function registerMarketingSegmentsRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/config/marketing/segments/:segmentId', async (request, reply) => {
    const actor = await requireSessionUser(request, reply, 'viewer')
    if (!actor) return

    const segmentId = parseSegmentId((request.params as { segmentId?: string }).segmentId)
    if (segmentId === null) {
      return reply.status(400).send({ error: 'Invalid segmentId.' })
    }

    try {
      const details = await getSegmentDetails(getPool(), segmentId)
      if (details === null) {
        return reply.status(404).send({ error: `No segment ${segmentId} is known to Helios.` })
      }
      return reply.send(SegmentDetailsResponseSchema.parse(details))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/relation .*sweed_segment_membership_refresh.* does not exist/i.test(message)) {
        return reply.status(503).send({
          error:
            'sweed_segment_membership_refresh table missing. Apply migration 081_sweed_segment_membership_refresh.sql.',
        })
      }
      throw error
    }
  })

  server.post(
    '/api/config/marketing/segments/:segmentId/refresh-membership',
    async (request, reply) => {
      const actor = await requireSessionUser(request, reply, 'editor')
      if (!actor) return

      const segmentId = parseSegmentId((request.params as { segmentId?: string }).segmentId)
      if (segmentId === null) {
        return reply.status(400).send({ error: 'Invalid segmentId.' })
      }

      try {
        // Mark pending and enqueue in ONE transaction so we can never
        // leave the highwater stuck 'pending' with no job queued.
        await withTransaction(async (db) => {
          await markSegmentMembershipRefreshPending(db, segmentId)
          await enqueueJob(db, {
            jobType: 'config.workers.refresh_sweed_segment_members',
            module: 'config',
            payload: { segmentId, trigger: 'manual_refresh' },
            priority: JOB_PRIORITY_URGENT,
            // One pending refresh per segment; duplicate clicks collapse.
            dedupeKey: `config.workers.refresh_sweed_segment_members:${segmentId}`,
            requestedByUserId: actor.id,
            runAt: new Date(),
            scope: null,
          })
        })
        return reply.send(
          SegmentMembershipRefreshResponseSchema.parse({
            enqueued: true,
            segmentId,
            status: 'pending' as const,
          }),
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/relation .*sweed_segment_membership_refresh.* does not exist/i.test(message)) {
          return reply.status(503).send({
            error:
              'sweed_segment_membership_refresh table missing. Apply migration 081_sweed_segment_membership_refresh.sql.',
          })
        }
        throw error
      }
    },
  )
}
