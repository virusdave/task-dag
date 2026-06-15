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
  CustomersMapHighwaterResponseSchema,
  CustomersMapQuerySchema,
  CustomersMapResponseSchema,
  CustomersMapSegmentsResponseSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import {
  getEarliestScanTimestamp,
  getVisitorScansMaxId,
  listCustomersMapPoints,
} from '../db/queries/customersMapQueries.js'
import { readMapSegmentOptions } from '../db/queries/sweedCustomerSegmentsQueries.js'

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
        marketingSegmentIds: query.marketingSegmentIds ?? null,
        marketingSegmentMode: query.marketingSegmentMode ?? null,
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

  // Live-update highwater probe — see
  // CustomersMapHighwaterResponseSchema. The SPA polls this every
  // few seconds while the map page is visible; when the returned
  // maxScanId exceeds the value stored from the last full fetch,
  // the SPA triggers ONE full refetch. Cost per call is a single
  // indexed pkey MAX (Postgres walks the right edge of the
  // visitor_scans pkey b-tree) — effectively free even at high
  // poll concurrency. No filter parameters: the watermark is
  // global, false-positive refetches are bounded by the real
  // scan-arrival rate which is very low in steady state.
  server.get('/api/admin/customers/map/highwater', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return
    try {
      const maxScanId = await getVisitorScansMaxId(getPool())
      return reply.send(CustomersMapHighwaterResponseSchema.parse({ maxScanId }))
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

  // Picker options for the marketing-segment lens. Cached catalog +
  // member counts; never calls Sweed. Loaded once when the operator
  // opens the lens, not on every map fetch.
  server.get('/api/admin/customers/map/segments', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return
    try {
      const segments = await readMapSegmentOptions(getPool())
      return reply.send(CustomersMapSegmentsResponseSchema.parse({ segments }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/relation .*sweed_(customer_segments|marketing_segments).* does not exist/i.test(message)) {
        // Lens unavailable until the segment cache migrations land;
        // degrade to an empty picker rather than 500ing the map.
        return reply.send(CustomersMapSegmentsResponseSchema.parse({ segments: [] }))
      }
      throw error
    }
  })
}
