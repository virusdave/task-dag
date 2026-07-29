import type { CatalogInventoryStageTradeSamplesJobPayload, TradeSampleStageResult } from '../../shared/contracts/index.js'
import { TradeSampleStageResultSchema } from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { assertTargetContents, readExactItem, readLiveInventory, resolveTradeSampleDestination, tradeSampleZeroDigest } from '../../server/catalog/tradeSampleZeroService.js'
import { getPool } from '../../server/db/pool.js'
import type { Queryable } from '../../server/db/pool.js'
import { callSweedRpc } from '../sweed/rpc.js'
import type { JobHandlerContext } from '../runtime/jobRegistry.js'

export async function assertTradeSampleJobLease(context: JobHandlerContext): Promise<void> {
  if (!context.leaseToken) throw new Error('Destructive trade sample job has no mutation lease.')
  const r = await getPool().query(`update job_queue set leased_until=now()+interval '5 minutes',updated_at=now() where id=$1 and lease_token=$2 and status='running' returning id`, [context.id, context.leaseToken])
  if (r.rowCount !== 1) throw new Error('Destructive trade sample job lease was lost.')
}

export async function runCatalogInventoryStageTradeSamplesJob(context: JobHandlerContext, payload: CatalogInventoryStageTradeSamplesJobPayload,
  injected: {
    rpc?: typeof callSweedRpc
    audit?: typeof appendAuditEvent
    db?: Queryable
    assertLease?: () => Promise<void>
  } = {},
): Promise<void> {
  const rpc = injected.rpc ?? callSweedRpc
  const audit = injected.audit ?? appendAuditEvent
  const db = injected.db ?? getPool()
  const assertLease = injected.assertLease ?? (() => assertTradeSampleJobLease(context))
  const d = { rpc }
  const outcomes: TradeSampleStageResult['outcomes'] = []

  try {
    await assertLease()
    const destination = await resolveTradeSampleDestination(payload.siteDealerId, d)
    if (JSON.stringify(destination) !== JSON.stringify(payload.destination)) throw new Error('Dedicated destination changed.')
    const live = await readLiveInventory(payload.siteDealerId, d)
    assertTargetContents(live, destination)
    const samples = live.filter(x => x.isTradeSample).map(({ isTradeSample: _, ...x }) => x)
    if (tradeSampleZeroDigest(payload.siteDealerId, samples, destination) !== payload.digest) throw new Error('Preview inventory changed.')
  } catch (error) {
    outcomes.push(...payload.items.map((item) => ({ inventoryItemId: item.inventoryItemId, status: 'not_applied_stale' as const })))
    await persistStageResult(context, payload, outcomes, false, audit, db)
    throw error
  }

  for (let index = 0; index < payload.items.length; index += 1) {
    const item = payload.items[index]!
    try {
      await assertLease()
      const late = await readExactItem(payload.siteDealerId, item, d)
      if (!late.isTradeSample || late.currentQty !== item.currentQty || late.availableQty !== item.currentQty || late.stockLocation?.id !== item.sourceLocationId || late.stockLocation.name !== item.sourceLocationName || late.stockType?.id !== item.sourceStockTypeId) throw new Error('Package changed before transfer.')
    } catch (error) {
      appendTerminalOutcomes(payload, outcomes, index, 'not_applied_stale')
      await persistStageResult(context, payload, outcomes, false, audit, db)
      throw error
    }
    try {
      await audit(db, { actorType:'user',actorUserId:payload.actorUserId,module:'catalog',scope:null,entityType:'trade_sample_inventory_item',entityId:`${payload.siteDealerId}:${item.inventoryItemId}`,eventType:'trade_sample.stage.attempted',requestId:payload.requestId,payload:{ inventoryItemId:item.inventoryItemId },undoPayload:null })
    } catch (error) {
      appendTerminalOutcomes(payload, outcomes, index, 'not_applied_audit_failure')
      await persistStageResult(context, payload, outcomes, false, audit, db)
      throw error
    }
    try {
      await rpc(payload.siteDealerId, 'store.inventory.item.transfer', {
        stockTypeFrom: item.sourceStockTypeId,
        stockLocationFrom: item.sourceLocationId,
        stockTypeTo: payload.destination.stockTypeId,
        stockLocationTo: payload.destination.id,
        transferReservedItems: false,
        items: [{ id: item.inventoryItemId, qty: item.currentQty, externalTrackCode: item.externalTrackCode }],
      })
      const after = await readExactItem(payload.siteDealerId, item, d)
      if (!after.isTradeSample || after.currentQty !== item.currentQty || after.stockLocation?.id !== payload.destination.id || after.stockLocation?.name !== payload.destination.name || after.stockType?.id !== payload.destination.stockTypeId) throw new Error('Transfer outcome could not be verified.')
    } catch (error) {
      appendTerminalOutcomes(payload, outcomes, index, 'failed_unknown')
      await persistStageResult(context, payload, outcomes, false, audit, db)
      throw error
    }
    outcomes.push({ inventoryItemId: item.inventoryItemId, status: 'completed' })
    try {
      await audit(db, { actorType:'user',actorUserId:payload.actorUserId,module:'catalog',scope:null,entityType:'trade_sample_inventory_item',entityId:`${payload.siteDealerId}:${item.inventoryItemId}`,eventType:'trade_sample.stage.completed',requestId:payload.requestId,payload:{ inventoryItemId:item.inventoryItemId },undoPayload:null })
    } catch (error) {
      appendRemainingOutcomes(payload, outcomes, index)
      await persistStageResult(context, payload, outcomes, false, audit, db)
      throw error
    }
  }

  try {
    assertTargetContents(await readLiveInventory(payload.siteDealerId, d), payload.destination, payload.items)
  } catch (error) {
    await persistStageResult(context, payload, outcomes, false, audit, db)
    throw error
  }
  await persistStageResult(context, payload, outcomes, true, audit, db)
}

function appendTerminalOutcomes(
  payload: CatalogInventoryStageTradeSamplesJobPayload,
  outcomes: TradeSampleStageResult['outcomes'],
  index: number,
  status: TradeSampleStageResult['outcomes'][number]['status'],
): void {
  outcomes.push({ inventoryItemId: payload.items[index]!.inventoryItemId, status })
  appendRemainingOutcomes(payload, outcomes, index)
}

function appendRemainingOutcomes(
  payload: CatalogInventoryStageTradeSamplesJobPayload,
  outcomes: TradeSampleStageResult['outcomes'],
  index: number,
): void {
  outcomes.push(...payload.items.slice(index + 1).map((item) => ({ inventoryItemId: item.inventoryItemId, status: 'not_applied_stale' as const })))
}

async function persistStageResult(
  context: JobHandlerContext,
  payload: CatalogInventoryStageTradeSamplesJobPayload,
  outcomes: TradeSampleStageResult['outcomes'],
  complete: boolean,
  audit: typeof appendAuditEvent,
  db: Queryable,
): Promise<void> {
  const result = TradeSampleStageResultSchema.parse({
    operationId: payload.requestId,
    siteDealerId: payload.siteDealerId,
    destination: payload.destination,
    items: payload.items,
    complete,
    counts: countOutcomes(outcomes),
    outcomes,
    message: complete
      ? 'All reviewed trade samples were staged and verified.'
      : 'Staging stopped. Inspect every listed package in Sweed before continuing.',
  })
  await audit(db, { actorType:'user',actorUserId:payload.actorUserId,module:'catalog',scope:null,entityType:'trade_sample_stage_batch',entityId:String(context.id),eventType:'trade_sample.stage.batch_result',requestId:payload.requestId,payload:result,undoPayload:null })
}

function countOutcomes(outcomes: TradeSampleStageResult['outcomes']): TradeSampleStageResult['counts'] {
  return {
    completed: outcomes.filter((outcome) => outcome.status === 'completed').length,
    failedUnknown: outcomes.filter((outcome) => outcome.status === 'failed_unknown').length,
    notAppliedStale: outcomes.filter((outcome) => outcome.status === 'not_applied_stale').length,
    notAppliedAuditFailure: outcomes.filter((outcome) => outcome.status === 'not_applied_audit_failure').length,
  }
}
