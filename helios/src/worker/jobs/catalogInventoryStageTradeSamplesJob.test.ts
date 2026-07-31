import { describe, expect, it, vi } from 'vitest'

import { tradeSampleZeroDigest } from '../../server/catalog/tradeSampleZeroService.js'
import type { CatalogInventoryStageTradeSamplesJobPayload } from '../../shared/contracts/index.js'
import { runCatalogInventoryStageTradeSamplesJob } from './catalogInventoryStageTradeSamplesJob.js'

const destination = { id: 88, name: 'NOT FOR SALE - Samples' as const, stockTypeId: 7 }
const item = { availableQty: 2, currentQty: 2, externalTrackCode: 'TAG', inventoryItemId: '44', packageLabel: null,
  productId: 9, productName: 'Sample', productSku: null, sourceLocationId: 12, sourceLocationName: 'Back Stock', sourceStockTypeId: 3 }
const payload: CatalogInventoryStageTradeSamplesJobPayload = { siteDealerId: 210249, destination, items: [item],
  digest: tradeSampleZeroDigest(210249, [item], destination), previewId: '123e4567-e89b-42d3-a456-426614174000',
  confirmation: 'STAGE TRADE SAMPLES', actorUserId: 17, requestId: 'stage-1' }
const context = { id: 8, leaseToken: 'lease', jobType: 'catalog.inventory.stage_trade_samples' as const, module: 'catalog' as const, payload, scope: null }
const locations = { data: [{ id: 88, name: destination.name, enabled: true, stockType: { id: 7 } }] }
const grouped = (atTarget = false, sample = true, targetName = destination.name) => ({ data: [{ product: { id: 9, name: 'Sample', sku: null }, items: [{
  id: '44', currentQty: 2, availableQty: 2, externalTrackCode: 'TAG', isTradeSample: sample,
  stockLocation: atTarget ? { id: 88, name: targetName } : { id: 12, name: 'Back Stock' },
  stockType: { id: atTarget ? 7 : 3 },
}] }], totalCount: 1 })
const detail = (atTarget = false, sample = true, targetName = destination.name) => ({ id: '44', currentQty: 2, availableQty: 2, externalTrackCode: 'TAG', isTradeSample: sample,
  stockLocation: atTarget ? { id: 88, name: targetName } : { id: 12, name: 'Back Stock' }, stockType: { id: atTarget ? 7 : 3 } })

function dependencies(responses: unknown[], audit = vi.fn().mockResolvedValue(1)) {
  return { rpc: vi.fn(async () => responses.shift()), audit, db: { query: vi.fn() }, assertLease: vi.fn().mockResolvedValue(undefined) }
}

describe('stage trade sample worker', () => {
  it('transfers with the canonical payload, post-validates, and durably records the exact result', async () => {
    const deps = dependencies([locations, grouped(), detail(), {}, detail(true), grouped(true)])
    await runCatalogInventoryStageTradeSamplesJob(context, payload, deps)
    expect(deps.rpc).toHaveBeenCalledWith(210249, 'store.inventory.item.transfer', {
      stockTypeFrom: 3, stockLocationFrom: 12, stockTypeTo: 7, stockLocationTo: 88,
      transferReservedItems: false, items: [{ id: '44', qty: 2, externalTrackCode: 'TAG' }],
    })
    expect(deps.audit.mock.calls.at(-1)?.[1].eventType).toBe('trade_sample.stage.batch_result')
    expect(deps.audit.mock.calls.at(-1)?.[1].payload).toMatchObject({ complete: true, counts: { completed: 1 } })
  })

  it('accepts Sweed padding around the destination name during post-transfer verification', async () => {
    const padded = ` ${destination.name}`
    const paddedLocations = { data: [{ id: 88, name: padded, enabled: true, stockType: { id: 7 } }] }
    const deps = dependencies([paddedLocations, grouped(), detail(), {}, detail(true, true, padded), grouped(true, true, padded)])

    await runCatalogInventoryStageTradeSamplesJob(context, payload, deps)

    expect(deps.audit.mock.calls.at(-1)?.[1].payload).toMatchObject({ complete: true, counts: { completed: 1 } })
  })

  it('aborts before transfer when target is occupied or the package is no longer a trade sample', async () => {
    const occupied = grouped(true)
    for (const responses of [[locations, occupied], [locations, grouped(), detail(false, false)]]) {
      const deps = dependencies(responses)
      await expect(runCatalogInventoryStageTradeSamplesJob(context, payload, deps)).rejects.toThrow()
      expect(deps.rpc.mock.calls.some((call) => call[1] === 'store.inventory.item.transfer')).toBe(false)
    }
  })

  it('records an unknown terminal package outcome when transfer verification fails', async () => {
    const deps = dependencies([locations, grouped(), detail(), {}, detail(false)])
    await expect(runCatalogInventoryStageTradeSamplesJob(context, payload, deps)).rejects.toThrow()
    expect(deps.audit.mock.calls.at(-1)?.[1].payload).toMatchObject({
      complete: false,
      outcomes: [{ inventoryItemId: '44', status: 'failed_unknown' }],
    })
  })

  it('stops later transfers when terminal audit fails', async () => {
    const audit = vi.fn().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('audit failed'))
    const deps = dependencies([locations, grouped(), detail(), {}, detail(true)], audit)
    await expect(runCatalogInventoryStageTradeSamplesJob(context, payload, deps)).rejects.toThrow('audit failed')
    expect(deps.rpc.mock.calls.filter((call) => call[1] === 'store.inventory.item.transfer')).toHaveLength(1)
    expect(deps.audit.mock.calls.at(-1)?.[1].payload.outcomes).toEqual([{ inventoryItemId: '44', status: 'completed' }])
  })
})
