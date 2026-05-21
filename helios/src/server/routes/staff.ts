import type { FastifyInstance } from 'fastify'

import {
  PublicTeamResponseSchema,
  StaffListResponseSchema,
  StaffRefreshResponseSchema,
  StaffStatusUpdateSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import {
  getStaffDirectoryFetchedAt,
  listApprovedTeamMembers,
  listStaffRowsWithInclusion,
  updateStaffInclusionStatus,
  upsertStaffDirectoryCache,
} from '../db/queries/staffQueries.js'
import { fetchStateStaffDirectory } from '../staff/fetchStateStaff.js'
import { buildStaffPhotoProxyToken } from '../staff/staffPhotoProxyToken.js'

function isMissingStaffTableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /relation .*staff_(directory_cache|inclusion).* does not exist/i.test(error.message)
}

async function buildStaffListPayload() {
  const pool = getPool()
  const items = await listStaffRowsWithInclusion(pool)
  const fetchedAt = await getStaffDirectoryFetchedAt(pool)
  const totalCount = items.length
  const withPhotoCount = items.filter((i) => Boolean(i.photoUrl)).length
  const approvedCount = items.filter((i) => i.inclusionStatus === 'approved').length
  return { items, fetchedAt, totalCount, withPhotoCount, approvedCount }
}

export async function registerStaffRoutes(server: FastifyInstance): Promise<void> {
  // Viewer: list current cached directory + inclusion decisions.
  server.get('/api/staff', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    try {
      const payload = await buildStaffListPayload()
      return reply.send(StaffListResponseSchema.parse(payload))
    } catch (error) {
      if (isMissingStaffTableError(error)) {
        return reply
          .status(503)
          .send({ error: 'Staff tables are missing. Apply migration 019_staff_inclusion.sql.' })
      }
      throw error
    }
  })

  // Editor: refresh upstream cache from Sweed user.compliance.list.
  server.post('/api/staff/refresh', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return
    try {
      const upstream = await fetchStateStaffDirectory()
      await upsertStaffDirectoryCache(getPool(), upstream)
      const payload = await buildStaffListPayload()
      return reply.send(
        StaffRefreshResponseSchema.parse({
          ...payload,
          refreshed: true,
          upstreamCount: upstream.length,
        }),
      )
    } catch (error) {
      if (isMissingStaffTableError(error)) {
        return reply
          .status(503)
          .send({ error: 'Staff tables are missing. Apply migration 019_staff_inclusion.sql.' })
      }
      throw error
    }
  })

  // Editor: update inclusion status for one staff member.
  server.patch<{ Params: { staffId: string } }>('/api/staff/:staffId', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return
    const body = StaffStatusUpdateSchema.parse(request.body)
    try {
      const updated = await updateStaffInclusionStatus(getPool(), {
        staffId: request.params.staffId,
        status: body.status,
        decidedBy: user.email,
        notes: body.notes,
      })
      if (!updated) {
        return reply.status(404).send({ error: `Unknown staff_id: ${request.params.staffId}` })
      }
      return reply.send(updated)
    } catch (error) {
      if (isMissingStaffTableError(error)) {
        return reply
          .status(503)
          .send({ error: 'Staff tables are missing. Apply migration 019_staff_inclusion.sql.' })
      }
      throw error
    }
  })

  // PUBLIC, UNAUTHENTICATED. Returns the approved team members
  // projection (firstName + photoUrl only). Consumed by the public
  // mostly-static-sites freshlybaked.nyc /about-us "Meet The Team"
  // surface. Must be allowlisted in authGate.ts.
  server.get('/api/staff/public/team', async (_request, reply) => {
    try {
      const rows = await listApprovedTeamMembers(getPool())
      // Project to the public contract: opaque proxy token instead of
      // the Sweed URL, plus the focal point (if cached) so the public
      // page can keep faces framed under object-fit: cover.
      const members = rows.map((row) => ({
        staffId: row.staffId,
        firstName: row.firstName,
        photoProxyToken: buildStaffPhotoProxyToken(row.photoUrl),
        ...(row.focalPoint
          ? {
              focalPoint: {
                x: row.focalPoint.x,
                y: row.focalPoint.y,
                confidence: row.focalPoint.confidence,
                model: row.focalPoint.model,
              },
            }
          : {}),
      }))
      reply.header('cache-control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600')
      reply.header('access-control-allow-origin', '*')
      return reply.send(
        PublicTeamResponseSchema.parse({
          members,
          generatedAt: new Date().toISOString(),
        }),
      )
    } catch (error) {
      if (isMissingStaffTableError(error)) {
        return reply.status(503).send({ error: 'Staff tables not yet migrated.' })
      }
      throw error
    }
  })
}
