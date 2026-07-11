import type {
  LowInventoryTransferConfigResponse,
  LowInventoryTransferResponse,
} from '../../shared/contracts/index.js'
import { getHeliosPendingPurchaseSiteDealer } from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../audit/appendAuditEvent.js'
import {
  isUsableLocation,
  listLiveLotsForProduct,
  listStockLocations,
  transferLot,
} from '../catalog/stockTransferService.js'
import type { Queryable } from '../db/pool.js'
import { getAppSetting } from '../db/queries/appSettingsQueries.js'
import { withTransaction } from '../db/tx.js'
import { withSweedSession } from '../../worker/sweed/session.js'
import { getPendingLowInventoryCountAudit } from './lowInventoryQueries.js'
import { notifyLowInventoryAudit } from './lowInventoryNotifications.js'

export class LowInventoryTransferConflictError extends Error {}

const transferConfigKey = (siteKey: string): string => `low_inventory_transfer_config:${siteKey}`

export async function confirmLowInventoryTransfer(args: {
  actorUserId: number
  config: LowInventoryTransferConfigResponse
  countAuditId: number
  db: Queryable
  dealerId: number
  requestId: string | null
}): Promise<LowInventoryTransferResponse> {
  if (!args.config.transferEnabled) {
    throw new LowInventoryTransferConflictError('Package transfers are disabled for this site.')
  }
  const completed = await withTransaction(async (db) => {
    const lock = await db.query<{ locked: boolean }>('select pg_try_advisory_xact_lock($1) as locked', [args.countAuditId])
    if (lock.rows[0]?.locked !== true) {
      throw new LowInventoryTransferConflictError('Another transfer request is already handling this count.')
    }
    const count = await getPendingLowInventoryCountAudit(db, args.countAuditId, args.dealerId)
    if (count === null) {
      throw new LowInventoryTransferConflictError('The count is not pending or cannot be transferred.')
    }
    await db.query('select pg_advisory_xact_lock(hashtext($1))', [
      `low-inventory:${args.dealerId}:${count.inventoryItemId}`,
    ])
    const currentCount = await getPendingLowInventoryCountAudit(db, args.countAuditId, args.dealerId)
    if (currentCount === null) {
      throw new LowInventoryTransferConflictError('A newer count replaced this transfer request.')
    }
    const site = getHeliosPendingPurchaseSiteDealer(args.dealerId)
    if (site === null) throw new LowInventoryTransferConflictError('The transfer site is invalid.')
    const configKey = transferConfigKey(site.siteKey)
    await db.query('select pg_advisory_xact_lock(hashtext($1))', [`low-inventory-config:${configKey}`])
    const currentConfig = await getAppSetting(db, configKey)
    if (
      currentConfig === null ||
      currentConfig.updatedAt !== args.config.updatedAt ||
      currentConfig.value === null ||
      typeof currentConfig.value !== 'object' ||
      !('transferEnabled' in currentConfig.value) ||
      currentConfig.value.transferEnabled !== true ||
      !('destinationName' in currentConfig.value) ||
      currentConfig.value.destinationName !== args.config.destinationName
    ) {
      throw new LowInventoryTransferConflictError('Transfer settings changed after review. Reload and confirm again.')
    }
    if (count.snapshotHoldQty !== 0) {
      throw new LowInventoryTransferConflictError('Held quantity is unknown or nonzero; this package cannot be fully moved.')
    }

    const moved = await withSweedSession(async () => {
    const [locations, lots] = await Promise.all([
      listStockLocations(args.dealerId),
      listLiveLotsForProduct(args.dealerId, count.productId),
    ])
    const destinationName = args.config.destinationName.trim().toLowerCase()
    const destinations = locations.filter(
      (location) =>
        isUsableLocation(location) &&
        location.name.trim().toLowerCase() === destinationName,
    )
    if (destinations.length !== 1) {
      throw new LowInventoryTransferConflictError(
        'The configured destination does not resolve to exactly one enabled location.',
      )
    }
    const destination = destinations[0]
    if (!destination.name.trim().toLowerCase().startsWith('not for sale')) {
      throw new LowInventoryTransferConflictError('The configured destination is not a NOT FOR SALE room.')
    }
    const lot = lots.find((candidate) => candidate.inventoryItemId === count.inventoryItemId)
    if (
      lot === undefined ||
      lot.isTradeSample ||
      (count.metrcTag !== null && lot.externalTrackCode !== count.metrcTag) ||
      lot.currentQty !== count.snapshotCurrentQty ||
      lot.availableQty !== count.snapshotAvailableQty ||
      lot.availableQty !== lot.currentQty
    ) {
      throw new LowInventoryTransferConflictError(
        'Live package identity, METRC tag, source, or quantity no longer matches the count snapshot.',
      )
    }
    if (lot.stockLocationName !== count.sourceLocation) {
      throw new LowInventoryTransferConflictError('The live package is no longer in the reviewed source room.')
    }
    const unresolved = await db.query<{ unresolved: boolean }>(
      `select exists (
         select 1 from audit_events attempted
          where attempted.entity_type = 'low_inventory_package_transfer'
            and attempted.entity_id = $1
            and attempted.event_type = 'low_inventory.package_transfer.attempted'
            and not exists (
              select 1 from audit_events outcome
               where outcome.entity_type = attempted.entity_type
                 and outcome.entity_id = attempted.entity_id
                 and outcome.event_type = 'low_inventory.package_transfer.completed'
                 and outcome.id > attempted.id
            )
       ) as unresolved`,
      [String(args.countAuditId)],
    )
    if (unresolved.rows[0]?.unresolved === true) {
      throw new LowInventoryTransferConflictError(
        'A previous transfer attempt has an unknown outcome. Inspect Sweed before taking further action.',
      )
    }
    await appendAuditEvent(args.db, {
      actorType: 'user', actorUserId: args.actorUserId,
      entityId: String(args.countAuditId), entityType: 'low_inventory_package_transfer',
      eventType: 'low_inventory.package_transfer.attempted', module: 'catalog',
      payload: {
        countAuditId: args.countAuditId, dealerId: args.dealerId,
        inventoryItemId: count.inventoryItemId, destinationName: destination.name,
        configUpdatedAt: args.config.updatedAt,
      },
      undoPayload: null, requestId: args.requestId,
    })
    const result = await transferLot({
      dealerId: args.dealerId,
      lot,
      targetLocationId: destination.id,
      targetStockTypeId: destination.stockTypeId!,
    })
    if (result === null) {
      throw new LowInventoryTransferConflictError('The audited package has no transferable quantity.')
    }
    if (result.reservedHeldBack) {
      throw new LowInventoryTransferConflictError('Reserved units remained in FOR SALE; the transfer was not completed.')
    }
    const verifiedLots = await listLiveLotsForProduct(args.dealerId, count.productId)
    const verified = verifiedLots.find((candidate) => candidate.inventoryItemId === count.inventoryItemId)
    if (
      verified === undefined ||
      verified.stockLocationId !== destination.id ||
      verified.stockTypeId !== destination.stockTypeId ||
      verified.currentQty !== count.snapshotCurrentQty ||
      verified.availableQty !== count.snapshotAvailableQty
    ) {
      throw new LowInventoryTransferConflictError(
        'Sweed did not confirm the exact transfer outcome. Inspect the package before retrying.',
      )
    }
    return { result, destinationName: destination.name }
    })

    const transferAuditId = await appendAuditEvent(db, {
    actorType: 'user',
    actorUserId: args.actorUserId,
    entityId: String(args.countAuditId),
    entityType: 'low_inventory_package_transfer',
    eventType: 'low_inventory.package_transfer.completed',
    module: 'catalog',
    payload: {
      countAuditId: args.countAuditId,
      dealerId: args.dealerId,
      productId: count.productId,
      inventoryItemId: count.inventoryItemId,
      metrcTag: count.metrcTag,
      movedQty: moved.result.movedQty,
      from: {
        locationId: moved.result.fromStockLocationId,
        locationName: moved.result.fromStockLocationName,
        stockTypeId: moved.result.fromStockTypeId,
      },
      to: {
        locationId: moved.result.toStockLocationId,
        locationName: moved.destinationName,
        stockTypeId: moved.result.toStockTypeId,
      },
    },
    undoPayload: {
      dealerId: args.dealerId,
      productId: count.productId,
      inventoryItemId: count.inventoryItemId,
      metrcTag: count.metrcTag,
      quantity: moved.result.movedQty,
      from: {
        locationId: moved.result.toStockLocationId,
        locationName: moved.destinationName,
        stockTypeId: moved.result.toStockTypeId,
      },
      to: {
        locationId: moved.result.fromStockLocationId,
        locationName: moved.result.fromStockLocationName,
        stockTypeId: moved.result.fromStockTypeId,
      },
    },
    requestId: args.requestId,
    })
    return { count, moved, transferAuditId }
  })
  let notificationStatus: LowInventoryTransferResponse['notificationStatus'] = 'sent'
  try {
    await notifyLowInventoryAudit({
      auditId: completed.transferAuditId,
      count: completed.count,
      destinationName: completed.moved.destinationName,
      movedQty: completed.moved.result.movedQty,
      siteLabel: getHeliosPendingPurchaseSiteDealer(args.dealerId)?.siteLabel ?? String(args.dealerId),
    })
  } catch (error) {
    notificationStatus = 'failed'
    console.error('low-inventory: transfer completed but notification failed', error)
  }
  return {
    transferAuditId: completed.transferAuditId,
    countAuditId: args.countAuditId,
    movedQty: completed.moved.result.movedQty,
    notificationStatus,
  }
}
