import type {
  CatalogInventoryZeroTradeSamplesJobPayload,
  TradeSampleZeroResult,
} from '../../shared/contracts/index.js'
import { TradeSampleZeroResultSchema } from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import {
  assertTargetContents,
  readExactItem,
  readLiveInventory,
  resolveTradeSampleDestination,
} from '../../server/catalog/tradeSampleZeroService.js'
import { getPool, type Queryable } from '../../server/db/pool.js'
import { callSweedRpc } from '../sweed/rpc.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'
import { assertTradeSampleJobLease } from './catalogInventoryStageTradeSamplesJob.js'

export interface ZeroTradeSampleDependencies {
  rpc?: typeof callSweedRpc
  audit?: typeof appendAuditEvent
  db?: Queryable
  assertLease?: () => Promise<void>
}

export async function runCatalogInventoryZeroTradeSamplesJob(
  context: JobHandlerContext,
  payload: CatalogInventoryZeroTradeSamplesJobPayload,
  injected: ZeroTradeSampleDependencies = {},
): Promise<void> {
  const rpc = injected.rpc ?? callSweedRpc
  const audit = injected.audit ?? appendAuditEvent
  const db = injected.db ?? getPool()
  const assertLease = injected.assertLease ?? (() => assertTradeSampleJobLease(context))
  const serviceDependencies = { rpc }
  const outcomes: TradeSampleZeroResult['outcomes'] = []

  try {
    const destination = await resolveTradeSampleDestination(payload.siteDealerId, serviceDependencies)
    if (JSON.stringify(destination) !== JSON.stringify(payload.destination)) {
      throw new Error('Dedicated destination changed.')
    }
    assertTargetContents(
      await readLiveInventory(payload.siteDealerId, destination, serviceDependencies),
      destination,
      payload.items,
    )
  } catch (error) {
    outcomes.push(...payload.items.map((item) => ({ inventoryItemId: item.inventoryItemId, status: 'not_applied_stale' as const })))
    await persistBatchResult(context, payload, outcomes, audit, db)
    throw error
  }

  for (let index = 0; index < payload.items.length; index += 1) {
    const item = payload.items[index]!
    try {
      await assertLease()
      const late = await readExactItem(payload.siteDealerId, item, serviceDependencies)
      if (
        !late.isTradeSample
        || late.currentQty !== item.currentQty
        || late.availableQty !== item.currentQty
        || late.stockLocation?.id !== payload.destination.id
        || late.stockLocation?.name?.trim() !== payload.destination.name
        || late.stockType?.id !== payload.destination.stockTypeId
      ) {
        throw new Error('Package is not the exact staged trade sample.')
      }
    } catch (error) {
      appendTerminalOutcomes(payload, outcomes, index, 'not_applied_stale')
      await persistBatchResult(context, payload, outcomes, audit, db)
      throw error
    }
    try {
      await audit(db, auditInput(payload, item.inventoryItemId, 'trade_sample.zero.attempted', {
        inventoryItemId: item.inventoryItemId,
        before: item.currentQty,
      }))
    } catch (error) {
      appendTerminalOutcomes(payload, outcomes, index, 'not_applied_audit_failure')
      await persistBatchResult(context, payload, outcomes, audit, db)
      throw error
    }
    try {
      await rpc(payload.siteDealerId, 'store.inventory.item.adjust', {
        reasonId: 20,
        integrationReasonId: 197,
        note: 'sample use',
        items: [{ qty: -item.currentQty, id: item.inventoryItemId, externalTrackCode: item.externalTrackCode }],
        isInternal: false,
      })
      const after = await readExactItem(payload.siteDealerId, item, serviceDependencies)
      if (after.currentQty !== 0) throw new Error('Post-adjustment quantity was not exactly zero.')
    } catch (error) {
      appendTerminalOutcomes(payload, outcomes, index, 'failed_unknown')
      await persistBatchResult(context, payload, outcomes, audit, db)
      throw error
    }
    outcomes.push({ inventoryItemId: item.inventoryItemId, status: 'completed' })
    try {
      await audit(db, auditInput(payload, item.inventoryItemId, 'trade_sample.zero.completed', {
        inventoryItemId: item.inventoryItemId,
        after: 0,
      }))
    } catch (error) {
      appendRemainingOutcomes(payload, outcomes, index)
      await persistBatchResult(context, payload, outcomes, audit, db)
      throw error
    }
  }

  await persistBatchResult(context, payload, outcomes, audit, db)
}

async function persistBatchResult(
  context: JobHandlerContext,
  payload: CatalogInventoryZeroTradeSamplesJobPayload,
  outcomes: TradeSampleZeroResult['outcomes'],
  audit: typeof appendAuditEvent,
  db: Queryable,
): Promise<void> {
  const result = TradeSampleZeroResultSchema.parse({
    operationId: payload.requestId,
    siteDealerId: payload.siteDealerId,
    destination: payload.destination,
    items: payload.items,
    stageJobId: payload.stageJobId,
    counts: {
      completed: outcomes.filter((outcome) => outcome.status === 'completed').length,
      failedUnknown: outcomes.filter((outcome) => outcome.status === 'failed_unknown').length,
      notAppliedStale: outcomes.filter((outcome) => outcome.status === 'not_applied_stale').length,
      notAppliedAuditFailure: outcomes.filter((outcome) => outcome.status === 'not_applied_audit_failure').length,
    },
    outcomes,
    message: outcomes.every((outcome) => outcome.status === 'completed')
      ? 'All staged trade samples were verified and zeroed.'
      : 'The operation stopped; inspect Sweed before taking further action.',
  })
  await audit(db, {
    actorType: 'user',
    actorUserId: payload.actorUserId,
    module: 'catalog',
    scope: null,
    entityType: 'trade_sample_zero_batch',
    entityId: String(context.id),
    eventType: 'trade_sample.zero.batch_result',
    requestId: payload.requestId,
    payload: result,
    undoPayload: null,
  })
}

function appendTerminalOutcomes(
  payload: CatalogInventoryZeroTradeSamplesJobPayload,
  outcomes: TradeSampleZeroResult['outcomes'],
  index: number,
  status: TradeSampleZeroResult['outcomes'][number]['status'],
): void {
  outcomes.push({ inventoryItemId: payload.items[index]!.inventoryItemId, status })
  appendRemainingOutcomes(payload, outcomes, index)
}

function appendRemainingOutcomes(
  payload: CatalogInventoryZeroTradeSamplesJobPayload,
  outcomes: TradeSampleZeroResult['outcomes'],
  index: number,
): void {
  outcomes.push(...payload.items.slice(index + 1).map((item) => ({ inventoryItemId: item.inventoryItemId, status: 'not_applied_stale' as const })))
}

function auditInput(
  payload: CatalogInventoryZeroTradeSamplesJobPayload,
  inventoryItemId: string,
  eventType: 'trade_sample.zero.attempted' | 'trade_sample.zero.completed',
  eventPayload: { inventoryItemId: string; before?: number; after?: number },
) {
  return {
    actorType: 'user' as const,
    actorUserId: payload.actorUserId,
    module: 'catalog' as const,
    scope: null,
    entityType: 'trade_sample_inventory_item' as const,
    entityId: `${payload.siteDealerId}:${inventoryItemId}`,
    eventType,
    requestId: payload.requestId,
    payload: eventPayload,
    undoPayload: null,
  }
}
