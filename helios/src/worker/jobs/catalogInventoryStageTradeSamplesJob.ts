import type { CatalogInventoryStageTradeSamplesJobPayload, TradeSampleStageResult, TradeSampleZeroItem } from '../../shared/contracts/index.js'
import { TradeSampleStageResultSchema } from '../../shared/contracts/index.js'
import { appendAuditEvent } from '../../server/audit/appendAuditEvent.js'
import { assertTargetContents, readExactItem, readLiveInventory, resolveTradeSampleDestination, tradeSampleZeroDigest } from '../../server/catalog/tradeSampleZeroService.js'
import { listLiveLotsForProduct } from '../../server/catalog/stockTransferService.js'
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
  const stagedItems: TradeSampleZeroItem[] = []

  try {
    await assertLease()
    const destination = await resolveTradeSampleDestination(payload.siteDealerId, d)
    if (JSON.stringify(destination) !== JSON.stringify(payload.destination)) throw new Error('Dedicated destination changed.')
    const live = await readLiveInventory(payload.siteDealerId, destination, d)
    assertTargetContents(live, destination)
    const samples = live.filter(x => x.isTradeSample).map(({ isTradeSample: _, ...x }) => x)
    if (tradeSampleZeroDigest(payload.siteDealerId, samples, destination) !== payload.digest) throw new Error('Preview inventory changed.')
  } catch (error) {
    outcomes.push(...payload.items.map((item) => ({ inventoryItemId: item.inventoryItemId, status: 'not_applied_stale' as const })))
    const failure = stageFailure('preflight validation', error)
    console.error(`[trade-sample-stage][job ${context.id}] ${failure}`)
    await persistStageResult(context, payload, outcomes, false, audit, db, failure)
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
      const failure = stageFailure('pre-transfer validation', error, item.inventoryItemId)
      console.error(`[trade-sample-stage][job ${context.id}] ${failure}`)
      await persistStageResult(context, payload, outcomes, false, audit, db, failure)
      throw error
    }
    try {
      await audit(db, { actorType:'user',actorUserId:payload.actorUserId,module:'catalog',scope:null,entityType:'trade_sample_inventory_item',entityId:`${payload.siteDealerId}:${item.inventoryItemId}`,eventType:'trade_sample.stage.attempted',requestId:payload.requestId,payload:{ inventoryItemId:item.inventoryItemId },undoPayload:null })
    } catch (error) {
      appendTerminalOutcomes(payload, outcomes, index, 'not_applied_audit_failure')
      const failure = stageFailure('attempt audit', error, item.inventoryItemId)
      console.error(`[trade-sample-stage][job ${context.id}] ${failure}`)
      await persistStageResult(context, payload, outcomes, false, audit, db, failure)
      throw error
    }
    let transferPhase = 'transfer RPC'
    try {
      await rpc(payload.siteDealerId, 'store.inventory.item.transfer', {
        stockTypeFrom: item.sourceStockTypeId,
        stockLocationFrom: item.sourceLocationId,
        stockTypeTo: payload.destination.stockTypeId,
        stockLocationTo: payload.destination.id,
        transferReservedItems: false,
        items: [{ id: item.inventoryItemId, qty: item.currentQty, externalTrackCode: item.externalTrackCode }],
      })
      transferPhase = 'post-transfer verification'
      const matchingLots = (await listLiveLotsForProduct(payload.siteDealerId, item.productId, rpc))
        .filter((lot) => lot.externalTrackCode?.trim() === item.externalTrackCode)
      const after = matchingLots.length === 1 ? matchingLots[0] : undefined
      if (!after || !after.isTradeSample || after.currentQty !== item.currentQty || after.availableQty !== item.currentQty || after.stockLocationId !== payload.destination.id || after.stockLocationName?.trim() !== payload.destination.name || after.stockTypeId !== payload.destination.stockTypeId) throw new Error('Transfer outcome could not be verified by package tag at the destination.')
      stagedItems.push({
        ...item,
        inventoryItemId: after.inventoryItemId,
        sourceLocationId: payload.destination.id,
        sourceLocationName: payload.destination.name,
        sourceStockTypeId: payload.destination.stockTypeId,
      })
    } catch (error) {
      appendTerminalOutcomes(payload, outcomes, index, 'failed_unknown')
      const failure = stageFailure(transferPhase, error, item.inventoryItemId)
      console.error(`[trade-sample-stage][job ${context.id}] ${failure}`)
      await persistStageResult(context, payload, outcomes, false, audit, db, failure)
      throw error
    }
    outcomes.push({ inventoryItemId: item.inventoryItemId, status: 'completed' })
    try {
      await audit(db, { actorType:'user',actorUserId:payload.actorUserId,module:'catalog',scope:null,entityType:'trade_sample_inventory_item',entityId:`${payload.siteDealerId}:${item.inventoryItemId}`,eventType:'trade_sample.stage.completed',requestId:payload.requestId,payload:{ inventoryItemId:item.inventoryItemId },undoPayload:null })
    } catch (error) {
      appendRemainingOutcomes(payload, outcomes, index)
      const failure = stageFailure('completion audit', error, item.inventoryItemId)
      console.error(`[trade-sample-stage][job ${context.id}] ${failure}`)
      await persistStageResult(context, payload, outcomes, false, audit, db, failure)
      throw error
    }
  }

  try {
    assertTargetContents(await readLiveInventory(payload.siteDealerId, payload.destination, d), payload.destination, stagedItems)
  } catch (error) {
    const failure = stageFailure('final destination validation', error)
    console.error(`[trade-sample-stage][job ${context.id}] ${failure}`)
    await persistStageResult(context, payload, outcomes, false, audit, db, failure)
    throw error
  }
  await persistStageResult(context, payload, outcomes, true, audit, db, undefined, stagedItems)
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
  failure?: string,
  resultItems: TradeSampleZeroItem[] = payload.items,
): Promise<void> {
  const result = TradeSampleStageResultSchema.parse({
    operationId: payload.requestId,
    siteDealerId: payload.siteDealerId,
    destination: payload.destination,
    items: resultItems,
    complete,
    counts: countOutcomes(outcomes),
    outcomes,
    message: complete
      ? 'All reviewed trade samples were staged and verified.'
      : `${failure ?? 'Staging stopped for an unknown reason.'} No later packages were attempted. Inspect every listed package in Sweed before continuing.`,
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

function stageFailure(phase: string, error: unknown, inventoryItemId?: string): string {
  const detail = error instanceof Error ? error.message : 'Unknown worker error.'
  const packageContext = inventoryItemId ? ` for package ${inventoryItemId}` : ''
  return `Staging stopped during ${phase}${packageContext}: ${detail}`
}
