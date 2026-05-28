// /api/admin/customers/map — JSON feed for the customer-origin map.
//
// FreshlyBakedNYC/automation#33, phase C4.

import type { FastifyInstance } from 'fastify'

import {
  CustomersMapQuerySchema,
  CustomersMapResponseSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { listCustomersMapPoints } from '../db/queries/customersMapQueries.js'

export async function registerCustomersMapRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/admin/customers/map', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return

    const query = CustomersMapQuerySchema.parse(request.query)
    try {
      const result = await listCustomersMapPoints(getPool(), {
        siteSlugs: query.siteSlugs ?? null,
        checkedInAfter: query.checkedInAfter ?? null,
        checkedInBefore: query.checkedInBefore ?? null,
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
}
