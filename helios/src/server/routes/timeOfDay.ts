import type { FastifyInstance } from 'fastify'

import {
  TimeOfDayFulfillmentSliceSchema,
  TimeOfDayResponseSchema,
} from '../../shared/contracts/index.js'
import { requireSessionUser } from '../auth/requireSession.js'
import { queryTimeOfDayGrid } from '../timeOfDay/timeOfDayQueries.js'

const DEFAULT_WINDOW_DAYS = 90
const MAX_WINDOW_DAYS = 366

function parseSites(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
}

function parseDate(raw: unknown): Date | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

export async function registerTimeOfDayRoutes(server: FastifyInstance): Promise<void> {
  // ADMIN-ONLY: this surface is gated to admins for now (operator
  // directive). The companion tab is hidden from non-admin navigation.
  server.get('/api/time-of-day-analytics', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return

    const query = (request.query ?? {}) as Record<string, unknown>

    const sites = parseSites(query.sites)

    const to = parseDate(query.to) ?? new Date()
    let from = parseDate(query.from)
    if (!from) {
      from = new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000)
    }
    if (from.getTime() >= to.getTime()) {
      return reply.status(400).send({ error: '`from` must be before `to`.' })
    }
    if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 86_400_000) {
      return reply
        .status(400)
        .send({ error: `Window cannot exceed ${MAX_WINDOW_DAYS} days.` })
    }

    const fulfillmentParsed = TimeOfDayFulfillmentSliceSchema.safeParse(
      query.fulfillment ?? 'all',
    )
    if (!fulfillmentParsed.success) {
      return reply.status(400).send({ error: 'Invalid `fulfillment` slice.' })
    }

    const response = await queryTimeOfDayGrid({
      sites,
      from,
      to,
      fulfillment: fulfillmentParsed.data,
    })
    return reply.send(TimeOfDayResponseSchema.parse(response))
  })
}
