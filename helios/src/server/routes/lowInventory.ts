import type { FastifyInstance } from 'fastify'

import {
  getHeliosPendingPurchaseSiteDealer,
  LOW_INVENTORY_DEFAULT_THRESHOLD,
  LOW_INVENTORY_STALE_AFTER_MINUTES,
  LowInventoryConfigPutBodySchema,
  LowInventoryConfigResponseSchema,
  LowInventoryRequestSchema,
  LowInventoryResponseSchema,
  type LowInventoryConfigResponse,
  type LowInventoryFreshness,
} from '../../shared/contracts/index.js'
import { requireMetricsGrant, requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { getAppSetting, upsertAppSetting } from '../db/queries/appSettingsQueries.js'
import { queryLowInventoryReadModel } from '../lowInventory/lowInventoryQueries.js'

const LOW_INVENTORY_CONFIG_KEY = 'low_inventory_config'

async function getLowInventoryConfig(): Promise<LowInventoryConfigResponse> {
  const row = await getAppSetting(getPool(), LOW_INVENTORY_CONFIG_KEY)
  if (row === null) {
    return { threshold: LOW_INVENTORY_DEFAULT_THRESHOLD, updatedAt: null, updatedBy: null }
  }
  const config = LowInventoryConfigPutBodySchema.parse(row.value)
  return { threshold: config.threshold, updatedAt: row.updatedAt, updatedBy: row.updatedBy }
}

export function getLowInventoryFreshness(
  snapshotObservedAt: string | null,
  now: Date = new Date(),
): LowInventoryFreshness {
  const staleAfterMs = LOW_INVENTORY_STALE_AFTER_MINUTES * 60_000
  return {
    isStale:
      snapshotObservedAt === null || now.getTime() - new Date(snapshotObservedAt).getTime() > staleAfterMs,
    staleAfterMinutes: LOW_INVENTORY_STALE_AFTER_MINUTES,
  }
}

export async function registerLowInventoryRoutes(server: FastifyInstance): Promise<void> {
  server.get('/api/low-inventory', async (request, reply) => {
    const user = await requireMetricsGrant(request, reply, 'reordering')
    if (!user) return
    const parsedRequest = LowInventoryRequestSchema.safeParse(request.query ?? {})
    if (!parsedRequest.success) {
      return reply.status(400).send({ error: 'A valid dealerId is required.' })
    }
    const site = getHeliosPendingPurchaseSiteDealer(parsedRequest.data.dealerId)
    if (site === null) {
      return reply.status(400).send({ error: `Unknown dealerId ${parsedRequest.data.dealerId}.` })
    }
    const config = await getLowInventoryConfig()
    const data = await queryLowInventoryReadModel({
      dealerId: site.dealerId,
      threshold: config.threshold,
    })
    return reply.send(
      LowInventoryResponseSchema.parse({
        data,
        freshness: getLowInventoryFreshness(data.snapshotObservedAt),
        site: {
          dealerId: site.dealerId,
          siteKey: site.siteKey,
          siteLabel: site.siteLabel,
        },
      }),
    )
  })

  server.get('/api/low-inventory/config', async (request, reply) => {
    const user = await requireMetricsGrant(request, reply, 'reordering')
    if (!user) return
    return reply.send(LowInventoryConfigResponseSchema.parse(await getLowInventoryConfig()))
  })

  server.put('/api/low-inventory/config', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return
    const parsedBody = LowInventoryConfigPutBodySchema.safeParse(request.body ?? {})
    if (!parsedBody.success) {
      return reply.status(400).send({ error: 'Threshold must be an integer from 1 through 100.' })
    }
    const row = await upsertAppSetting(
      getPool(),
      LOW_INVENTORY_CONFIG_KEY,
      parsedBody.data,
      user.email,
    )
    return reply.send(
      LowInventoryConfigResponseSchema.parse({
        threshold: parsedBody.data.threshold,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
      }),
    )
  })
}
