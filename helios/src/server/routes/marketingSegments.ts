import type { FastifyInstance } from 'fastify'

import {
  MarketingSegmentDirectoryResponseSchema,
  SegmentDetailsResponseSchema,
  SegmentMembershipRefreshAllResponseSchema,
  SegmentMembershipRefreshResponseSchema,
  SegmentRetirementResponseSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { withTransaction } from '../db/tx.js'
import { enqueueJob, JOB_PRIORITY_URGENT } from '../jobs/enqueueJob.js'
import {
  getSegmentDetails,
  markSegmentMembershipRefreshPending,
} from '../db/queries/marketingSegmentDetailsQueries.js'
import {
  readMarketingCatalogSegments,
  readMarketingSegmentsDirectory,
  readSegmentRetirementState,
  retireSegment,
  unretireSegment,
} from '../db/queries/sweedCustomerSegmentsQueries.js'

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

const RETIREMENT_TABLE_MISSING =
  'sweed_marketing_segment_retirement table missing. Apply migration 089_sweed_marketing_segment_retirement.sql.'

function isRetirementTableMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /relation .*sweed_marketing_segment_retirement.* does not exist/i.test(message)
}

export async function registerMarketingSegmentsRoutes(server: FastifyInstance): Promise<void> {
  // Segment directory: every cached segment + its retirement state. Lists
  // active segments first; retired ones (disabled in Sweed or explicitly
  // retired in Helios) are returned too so the directory can show and
  // un-retire them. Cache-only.
  server.get('/api/config/marketing/segments', async (request, reply) => {
    const actor = await requireSessionUser(request, reply, 'viewer')
    if (!actor) return
    try {
      const result = await readMarketingSegmentsDirectory(getPool())
      return reply.send(MarketingSegmentDirectoryResponseSchema.parse(result))
    } catch (error) {
      if (isRetirementTableMissing(error)) {
        return reply.status(503).send({ error: RETIREMENT_TABLE_MISSING })
      }
      throw error
    }
  })

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

  // Batch refresh: fan the per-segment refresh job out across every
  // enabled cached segment. Each leg is the SAME deduped job the
  // single-segment button enqueues, so this is just "click refresh on
  // every segment at once" — O(#segments) Sweed RPCs, one per segment,
  // and duplicate batch clicks collapse on the per-segment dedupe key.
  // Enumerates from the local catalog cache (no Sweed call here); a
  // segment created since the last catalog refresh is included on the
  // next batch once the catalog (6h highwater) catches up.
  //
  // Declared before the ':segmentId' route below for clarity; the paths
  // have different arities so Fastify never confuses the two.
  server.post(
    '/api/config/marketing/segments/refresh-all-membership',
    async (request, reply) => {
      const actor = await requireSessionUser(request, reply, 'editor')
      if (!actor) return

      try {
        const segments = await readMarketingCatalogSegments(getPool(), {
          includeDisabled: false,
        })
        const segmentIds = segments.map((s) => s.segmentId)

        // One transaction so a partial fan-out can't leave some segments
        // stuck 'pending' with no job queued.
        await withTransaction(async (db) => {
          for (const segmentId of segmentIds) {
            await markSegmentMembershipRefreshPending(db, segmentId)
            await enqueueJob(db, {
              jobType: 'config.workers.refresh_sweed_segment_members',
              module: 'config',
              payload: { segmentId, trigger: 'manual_refresh_all' },
              priority: JOB_PRIORITY_URGENT,
              dedupeKey: `config.workers.refresh_sweed_segment_members:${segmentId}`,
              requestedByUserId: actor.id,
              runAt: new Date(),
              scope: null,
            })
          }
        })

        return reply.send(
          SegmentMembershipRefreshAllResponseSchema.parse({
            enqueued: segmentIds.length,
            segmentIds,
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

  // Retire a segment in Helios: semi-permanently hide it from every
  // Helios surface except the segment directory/details config pages.
  // Idempotent. An optional note records why.
  server.post('/api/config/marketing/segments/:segmentId/retire', async (request, reply) => {
    const actor = await requireSessionUser(request, reply, 'editor')
    if (!actor) return

    const segmentId = parseSegmentId((request.params as { segmentId?: string }).segmentId)
    if (segmentId === null) {
      return reply.status(400).send({ error: 'Invalid segmentId.' })
    }

    const rawNote = (request.body as { note?: unknown } | undefined)?.note
    const note = typeof rawNote === 'string' && rawNote.trim().length > 0 ? rawNote.trim().slice(0, 1000) : null

    try {
      const pool = getPool()
      await retireSegment(pool, { segmentId, userId: actor.id, note })
      const state = await readSegmentRetirementState(pool, segmentId)
      return reply.send(SegmentRetirementResponseSchema.parse(state))
    } catch (error) {
      if (isRetirementTableMissing(error)) {
        return reply.status(503).send({ error: RETIREMENT_TABLE_MISSING })
      }
      throw error
    }
  })

  // Un-retire a segment in Helios: removes the explicit retirement.
  // Idempotent. Note: a segment that is disabled in Sweed stays hidden
  // until it is re-enabled in Sweed (Helios cannot re-enable it).
  server.post('/api/config/marketing/segments/:segmentId/unretire', async (request, reply) => {
    const actor = await requireSessionUser(request, reply, 'editor')
    if (!actor) return

    const segmentId = parseSegmentId((request.params as { segmentId?: string }).segmentId)
    if (segmentId === null) {
      return reply.status(400).send({ error: 'Invalid segmentId.' })
    }

    try {
      const pool = getPool()
      await unretireSegment(pool, segmentId)
      const state = await readSegmentRetirementState(pool, segmentId)
      return reply.send(SegmentRetirementResponseSchema.parse(state))
    } catch (error) {
      if (isRetirementTableMissing(error)) {
        return reply.status(503).send({ error: RETIREMENT_TABLE_MISSING })
      }
      throw error
    }
  })
}
