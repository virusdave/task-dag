// /api/admin/customers/map — JSON feed for the customer-origin map.
//
// FreshlyBakedNYC/automation#33, phase C4.
//
// Admin-only: per operator direction, all customer scan / map / metric
// surfaces are restricted to role=admin (viewers + approvers are
// blocked). Per-user whitelisting may come later.

import type { FastifyInstance } from 'fastify'

import {
  CustomersMapEarliestResponseSchema,
  CustomersMapQuerySchema,
  CustomersMapResponseSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import {
  getEarliestScanTimestamp,
  listCustomersMapPoints,
} from '../db/queries/customersMapQueries.js'

export async function registerCustomersMapRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/admin/customers/map', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return

    const query = CustomersMapQuerySchema.parse(request.query)
    try {
      const result = await listCustomersMapPoints(getPool(), {
        siteSlugs: query.siteSlugs ?? null,
        checkedInAfter: query.checkedInAfter ?? null,
        checkedInBefore: query.checkedInBefore ?? null,
        visitType: query.visitType ?? null,
        ageBand: query.ageBand ?? null,
        homeState: query.homeState ?? null,
        postalPrefix: query.postalPrefix ?? null,
        linkStatus: query.linkStatus ?? null,
        coordSource: query.coordSource ?? null,
        maxPoints: query.maxPoints,
      })
      return reply.send(CustomersMapResponseSchema.parse(result))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/relation .*visitor_scans.* does not exist/i.test(message)) {
        return reply
          .status(503)
          .send({ error: 'visitor_scans table missing. Apply migration 039_visitor_scans.sql.' })
      }
      throw error
    }
  })

  // Meta: earliest scan timestamp anywhere. Drives the SPA's replay
  // time-range slider so it can span all of history, not just a
  // hard-coded rolling 30-day window.
  server.get('/api/admin/customers/map/earliest', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return
    try {
      const earliest = await getEarliestScanTimestamp(getPool())
      return reply.send(
        CustomersMapEarliestResponseSchema.parse({ earliestCheckedInAt: earliest }),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/relation .*visitor_scans.* does not exist/i.test(message)) {
        return reply
          .status(503)
          .send({ error: 'visitor_scans table missing. Apply migration 039_visitor_scans.sql.' })
      }
      throw error
    }
  })
}
