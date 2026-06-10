import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  ALL_METRIC_GRANT_KEYS,
  MetricsDefaultsGetResponseSchema,
  MetricsDefaultsPutBodySchema,
  MetricsViewDefaultsSchema,
} from '../../shared/contracts/index.js'
import { requireMetricsGrant, requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import {
  deleteAppSetting,
  getAppSetting,
  upsertAppSetting,
} from '../db/queries/appSettingsQueries.js'

// Single global key — page-wide /metrics toolbar defaults.
const METRICS_VIEW_DEFAULTS_KEY = 'metrics_view_defaults'

const MIGRATION_MISSING_RE = /relation .*app_settings.* does not exist/i

function isMigrationMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return MIGRATION_MISSING_RE.test(message)
}

function sendMigrationMissing(reply: FastifyReply): void {
  reply
    .status(503)
    .send({ error: 'app_settings table is missing. Apply migration 069_app_settings.sql.' })
}

export async function registerMetricsDefaultsRoutes(server: FastifyInstance): Promise<void> {
  // Read: every metrics viewer needs the defaults to hydrate their
  // page, so gate it identically to GET /api/metrics (any grant).
  server.get('/api/metrics-defaults', async (request, reply) => {
    const user = await requireMetricsGrant(request, reply, ...ALL_METRIC_GRANT_KEYS)
    if (!user) return
    try {
      const row = await getAppSetting(getPool(), METRICS_VIEW_DEFAULTS_KEY)
      if (!row) {
        return reply.send(
          MetricsDefaultsGetResponseSchema.parse({
            defaults: null,
            updatedBy: null,
            updatedAt: null,
          }),
        )
      }
      // Tolerate a stored blob that predates the current contract: fall
      // back to "no defaults" rather than 500-ing the whole metrics page
      // so an admin can simply re-save / reset.
      const parsed = MetricsViewDefaultsSchema.safeParse(row.value)
      return reply.send(
        MetricsDefaultsGetResponseSchema.parse({
          defaults: parsed.success ? parsed.data : null,
          updatedBy: row.updatedBy,
          updatedAt: row.updatedAt,
        }),
      )
    } catch (error) {
      if (isMigrationMissing(error)) return sendMigrationMissing(reply)
      throw error
    }
  })

  // Write: admin only. Replaces the whole blob (the client always sends
  // the full merged defaults).
  server.put('/api/metrics-defaults', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return
    const body = MetricsDefaultsPutBodySchema.parse(request.body)
    try {
      const row = await upsertAppSetting(
        getPool(),
        METRICS_VIEW_DEFAULTS_KEY,
        body,
        user.email,
      )
      return reply.send(
        MetricsDefaultsGetResponseSchema.parse({
          defaults: body,
          updatedBy: row.updatedBy,
          updatedAt: row.updatedAt,
        }),
      )
    } catch (error) {
      if (isMigrationMissing(error)) return sendMigrationMissing(reply)
      throw error
    }
  })

  // Reset: admin only. Drop the row so defaults fall back to the code
  // baseline. Idempotent.
  server.delete('/api/metrics-defaults', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return
    try {
      await deleteAppSetting(getPool(), METRICS_VIEW_DEFAULTS_KEY)
      return reply.status(204).send()
    } catch (error) {
      if (isMigrationMissing(error)) return sendMigrationMissing(reply)
      throw error
    }
  })
}
