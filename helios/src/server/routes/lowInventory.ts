import type { FastifyInstance } from 'fastify'

import {
  getHeliosPendingPurchaseSiteDealer,
  LOW_INVENTORY_DEFAULT_THRESHOLD,
  LOW_INVENTORY_STALE_AFTER_MINUTES,
  LowInventoryConfigPutBodySchema,
  LowInventoryConfigResponseSchema,
  LowInventoryRequestSchema,
  LowInventoryResponseSchema,
  LOW_INVENTORY_DEFAULT_DESTINATION,
  LOW_INVENTORY_TRANSFERS_ENABLED_BY_DEFAULT,
  LowInventoryAuditListRequestSchema,
  LowInventoryAuditListResponseSchema,
  LowInventoryCountRequestSchema,
  LowInventoryCountResponseSchema,
  LowInventoryTransferBodySchema,
  LowInventoryTransferConfigBodySchema,
  LowInventoryTransferConfigResponseSchema,
  LowInventoryTransferResponseSchema,
  type LowInventoryCountBody,
  type LowInventoryClassification,
  type LowInventoryConfigResponse,
  type LowInventoryFreshness,
  type LowInventoryTransferConfigResponse,
  type SessionUser,
} from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import { requireMetricsGrant, requireSessionUser } from '../auth/requireSession.js'
import { getPool } from '../db/pool.js'
import { getAppSetting, upsertAppSetting } from '../db/queries/appSettingsQueries.js'
import { withTransaction } from '../db/tx.js'
import {
  listLowInventoryCountAudits,
  getLowInventoryPackageSnapshot,
  queryLowInventoryReadModel,
} from '../lowInventory/lowInventoryQueries.js'
import {
  confirmLowInventoryTransfer,
  LowInventoryTransferConflictError,
} from '../lowInventory/lowInventoryTransferService.js'
import { notifyLowInventoryAudit } from '../lowInventory/lowInventoryNotifications.js'

const LOW_INVENTORY_CONFIG_KEY = 'low_inventory_config'
const transferConfigKey = (siteKey: string): string => `low_inventory_transfer_config:${siteKey}`

function hasLowInventoryGrant(user: SessionUser): boolean {
  return user.role === 'admin' || user.metricGrants.includes('reordering')
}

async function getLowInventoryConfig(): Promise<LowInventoryConfigResponse> {
  const row = await getAppSetting(getPool(), LOW_INVENTORY_CONFIG_KEY)
  if (row === null) {
    return { threshold: LOW_INVENTORY_DEFAULT_THRESHOLD, updatedAt: null, updatedBy: null }
  }
  const config = LowInventoryConfigPutBodySchema.parse(row.value)
  return { threshold: config.threshold, updatedAt: row.updatedAt, updatedBy: row.updatedBy }
}

async function getTransferConfig(dealerId: number): Promise<LowInventoryTransferConfigResponse> {
  const site = getHeliosPendingPurchaseSiteDealer(dealerId)
  if (site === null) throw new Error(`Unknown dealerId ${dealerId}.`)
  const row = await getAppSetting(getPool(), transferConfigKey(site.siteKey))
  if (row === null) {
    return {
      dealerId,
      destinationName: LOW_INVENTORY_DEFAULT_DESTINATION,
      transferEnabled: LOW_INVENTORY_TRANSFERS_ENABLED_BY_DEFAULT,
      updatedAt: null,
      updatedBy: null,
    }
  }
  const parsed = LowInventoryTransferConfigBodySchema.parse(row.value)
  return { ...parsed, updatedAt: row.updatedAt, updatedBy: row.updatedBy }
}

function classifyCount(currentQty: number, holdQty: number | null, physicalCount: number): LowInventoryClassification {
  if (physicalCount === 0 && holdQty !== null && holdQty > 0) return 'held'
  if (physicalCount === 0) return 'zero'
  if (physicalCount < currentQty) return 'short'
  if (physicalCount === currentQty) return 'equal'
  return 'over'
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

  server.post('/api/low-inventory/counts', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return
    if (!hasLowInventoryGrant(user)) return reply.status(403).send({ error: 'Reordering access is required.' })
    const parsed = LowInventoryCountRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Package identity, snapshot time, and physical count are required.' })
    }
    if (getHeliosPendingPurchaseSiteDealer(parsed.data.dealerId) === null) {
      return reply.status(400).send({ error: `Unknown dealerId ${parsed.data.dealerId}.` })
    }
    const recorded = await withTransaction(async (db) => {
      await db.query('select pg_advisory_xact_lock(hashtext($1))', [
        `low-inventory:${parsed.data.dealerId}:${parsed.data.inventoryItemId}`,
      ])
      const snapshot = await getLowInventoryPackageSnapshot({
        db,
        dealerId: parsed.data.dealerId,
        inventoryItemId: parsed.data.inventoryItemId,
        productId: parsed.data.productId,
        snapshotObservedAt: parsed.data.snapshotObservedAt,
      })
      if (snapshot === null || snapshot.currentQty === null || getLowInventoryFreshness(snapshot.observedAt).isStale) {
        return null
      }
      const count: LowInventoryCountBody = {
        ...parsed.data,
        metrcTag: snapshot.metrcTag?.trim() || null,
        sourceLocation: snapshot.stockLocation,
        snapshotAvailableQty: snapshot.availableQty,
        snapshotCurrentQty: snapshot.currentQty,
        snapshotHoldQty: snapshot.holdQty,
        classification: classifyCount(snapshot.currentQty, snapshot.holdQty, parsed.data.physicalCount),
      }
      const auditId = await appendAuditEvent(db, {
        actorType: 'user', actorUserId: user.id,
        entityId: `${parsed.data.dealerId}:${parsed.data.inventoryItemId}`,
        entityType: 'low_inventory_package_count',
        eventType: 'low_inventory.package_count.recorded', module: 'catalog',
        payload: count, undoPayload: null, requestId: request.id ?? null,
      })
      return { auditId, count }
    })
    if (recorded === null) {
      return reply.status(409).send({ error: 'The package snapshot is stale or no longer eligible. Reload before recording the count.' })
    }
    const { auditId, count } = recorded
    let notificationStatus: 'failed' | 'not_requested' | 'sent' = 'not_requested'
    if (count.classification === 'held' || count.classification === 'over') {
      try {
        await notifyLowInventoryAudit({
          auditId,
          count,
          siteLabel: getHeliosPendingPurchaseSiteDealer(parsed.data.dealerId)!.siteLabel,
        })
        notificationStatus = 'sent'
      } catch (error) {
        notificationStatus = 'failed'
        console.error('low-inventory: count recorded but notification failed', error)
      }
    }
    return reply.send(LowInventoryCountResponseSchema.parse({ auditId, notificationStatus }))
  })

  server.get('/api/low-inventory/audits', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    if (!hasLowInventoryGrant(user)) return reply.status(403).send({ error: 'Reordering access is required.' })
    const parsed = LowInventoryAuditListRequestSchema.safeParse(request.query ?? {})
    if (!parsed.success || getHeliosPendingPurchaseSiteDealer(parsed.data.dealerId) === null) {
      return reply.status(400).send({ error: 'A valid dealerId and limit from 1 through 100 are required.' })
    }
    const items = await listLowInventoryCountAudits(getPool(), parsed.data.dealerId, parsed.data.limit)
    return reply.send(LowInventoryAuditListResponseSchema.parse({ items }))
  })

  server.get('/api/low-inventory/transfer-config', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'viewer')
    if (!user) return
    if (!hasLowInventoryGrant(user)) return reply.status(403).send({ error: 'Reordering access is required.' })
    const parsed = LowInventoryRequestSchema.safeParse(request.query ?? {})
    if (!parsed.success || getHeliosPendingPurchaseSiteDealer(parsed.data.dealerId) === null) {
      return reply.status(400).send({ error: 'A valid dealerId is required.' })
    }
    return reply.send(LowInventoryTransferConfigResponseSchema.parse(await getTransferConfig(parsed.data.dealerId)))
  })

  server.put('/api/low-inventory/transfer-config', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'admin')
    if (!user) return
    const parsed = LowInventoryTransferConfigBodySchema.safeParse(request.body ?? {})
    const site = parsed.success ? getHeliosPendingPurchaseSiteDealer(parsed.data.dealerId) : null
    if (!parsed.success || site === null) {
      return reply.status(400).send({ error: 'A valid site transfer configuration is required.' })
    }
    const key = transferConfigKey(site.siteKey)
    const row = await withTransaction(async (db) => {
      await db.query('select pg_advisory_xact_lock(hashtext($1))', [`low-inventory-config:${key}`])
      return upsertAppSetting(db, key, parsed.data, user.email)
    })
    return reply.send(LowInventoryTransferConfigResponseSchema.parse({
      ...parsed.data, updatedAt: row.updatedAt, updatedBy: row.updatedBy,
    }))
  })

  server.post('/api/low-inventory/transfers', async (request, reply) => {
    const user = await requireSessionUser(request, reply, 'editor')
    if (!user) return
    if (!hasLowInventoryGrant(user)) return reply.status(403).send({ error: 'Reordering access is required.' })
    const parsed = LowInventoryTransferBodySchema.safeParse(request.body ?? {})
    if (!parsed.success || getHeliosPendingPurchaseSiteDealer(parsed.data.dealerId) === null) {
      return reply.status(400).send({ error: 'A valid dealerId and countAuditId are required.' })
    }
    try {
      const config = await getTransferConfig(parsed.data.dealerId)
      if (
        config.destinationName !== parsed.data.confirmedDestinationName ||
        config.updatedAt !== parsed.data.confirmedConfigUpdatedAt
      ) {
        return reply.status(409).send({ error: 'Transfer settings changed after review. Reload and confirm the destination again.' })
      }
      const result = await confirmLowInventoryTransfer({
        actorUserId: user.id, config,
        countAuditId: parsed.data.countAuditId, db: getPool(), dealerId: parsed.data.dealerId,
        requestId: request.id ?? null,
      })
      return reply.send(LowInventoryTransferResponseSchema.parse(result))
    } catch (error) {
      if (error instanceof LowInventoryTransferConflictError) {
        return reply.status(409).send({ error: error.message })
      }
      throw error
    }
  })
}
