import { describe, expect, it, vi } from 'vitest'

import { tradeSampleZeroDigest } from '../../server/catalog/tradeSampleZeroService.js'
import type { CatalogInventoryStageTradeSamplesJobPayload } from '../../shared/contracts/index.js'
import { runCatalogInventoryStageTradeSamplesJob } from './catalogInventoryStageTradeSamplesJob.js'

const destination = { id: 88, name: 'NOT FOR SALE - Samples' as const, stockTypeId: 7 }
const item = { availableQty: 2, currentQty: 2, externalTrackCode: 'TAG', inventoryItemId: '44', packageLabel: null,
  productId: 9, productName: 'Sample', productSku: null, sourceLocationId: 12, sourceLocationName: 'Back Stock', sourceStockTypeId: 3 }
const secondItem = { ...item, externalTrackCode: 'TAG-2', inventoryItemId: '45', productId: 10, productName: 'Second sample' }
const payload: CatalogInventoryStageTradeSamplesJobPayload = { siteDealerId: 210249, destination, items: [item],
  digest: tradeSampleZeroDigest(210249, [item], destination), previewId: '123e4567-e89b-42d3-a456-426614174000',
  confirmation: 'STAGE TRADE SAMPLES', actorUserId: 17, requestId: 'stage-1' }
const context = { id: 8, leaseToken: 'lease', jobType: 'catalog.inventory.stage_trade_samples' as const, module: 'catalog' as const, payload, scope: null }
const locations = { data: [{ id: 88, name: destination.name, enabled: true, stockType: { id: 7 } }] }
const grouped = (atTarget = false, sample = true, targetName = destination.name) => ({ data: [{ product: { id: 9, name: 'Sample', sku: null }, items: [{
  id: atTarget ? '99' : '44', currentQty: 2, availableQty: 2, externalTrackCode: 'TAG', isTradeSample: sample,
  stockLocation: atTarget ? { id: 88, name: targetName } : { id: 12, name: 'Back Stock' },
  stockType: { id: atTarget ? 7 : 3 },
}] }], totalCount: 1 })
const detail = (atTarget = false, sample = true, targetName = destination.name) => ({ id: '44', currentQty: 2, availableQty: 2, externalTrackCode: 'TAG', isTradeSample: sample,
  stockLocation: atTarget ? { id: 88, name: targetName } : { id: 12, name: 'Back Stock' }, stockType: { id: atTarget ? 7 : 3 } })
const productLots = (atTarget = true, sample = true, targetName = destination.name) => ({ data: [{
  id: atTarget ? '99' : '44', currentQty: 2, availableQty: 2, externalTrackCode: 'TAG', isTradeSample: sample,
  stockLocation: atTarget ? { id: 88, name: targetName } : { id: 12, name: 'Back Stock' },
  stockType: { id: atTarget ? 7 : 3 },
}], totalCount: 1 })
const exactDetail = (value: typeof item) => ({ ...detail(), id: value.inventoryItemId, currentQty: value.currentQty, availableQty: value.availableQty, externalTrackCode: value.externalTrackCode })
const transferredLot = (value: typeof item) => ({ data: [{ ...productLots().data[0], id: `new-${value.inventoryItemId}`, currentQty: value.currentQty, availableQty: value.availableQty, externalTrackCode: value.externalTrackCode }], totalCount: 1 })
const groupedItems = (values: Array<typeof item>, atTarget = false) => ({
  data: values.map((value) => ({ product: { id: value.productId, name: value.productName, sku: null }, items: [{
    ...exactDetail(value), id: atTarget ? `new-${value.inventoryItemId}` : value.inventoryItemId,
    stockLocation: atTarget ? { id: 88, name: destination.name } : { id: 12, name: 'Back Stock' },
    stockType: { id: atTarget ? 7 : 3 },
  }] })),
  totalCount: values.length,
})

function dependencies(responses: unknown[], audit = vi.fn().mockResolvedValue(1)) {
  return {
    rpc: vi.fn(async () => {
      const response = responses.shift()
      if (response instanceof Error) throw response
      return response
    }),
    audit,
    db: { query: vi.fn() },
    assertLease: vi.fn().mockResolvedValue(undefined),
    delay: vi.fn().mockResolvedValue(undefined),
  }
}

describe('stage trade sample worker', () => {
  it('transfers with the canonical payload, post-validates, and durably records the exact result', async () => {
    const deps = dependencies([locations, grouped(), detail(), {}, productLots(), grouped(true)])
    await runCatalogInventoryStageTradeSamplesJob(context, payload, deps)
    expect(deps.rpc).toHaveBeenCalledWith(210249, 'store.inventory.item.transfer', {
      stockTypeFrom: 3, stockLocationFrom: 12, stockTypeTo: 7, stockLocationTo: 88,
      transferReservedItems: false, items: [{ id: '44', qty: 2, externalTrackCode: 'TAG' }],
    })
    expect(deps.audit.mock.calls.at(-1)?.[1].eventType).toBe('trade_sample.stage.batch_result')
    expect(deps.audit.mock.calls.at(-1)?.[1].payload).toMatchObject({
      complete: true,
      counts: { completed: 1 },
      items: [{ inventoryItemId: '99', sourceLocationId: 88, sourceStockTypeId: 7 }],
    })
    expect(deps.rpc).toHaveBeenCalledWith(210249, 'store.inventory.product.item.list', {
      productId: '9', page: 1, pageSize: 100, isOnStock: true,
    })
  })

  it('continues after Sweed replaces each transferred inventory item ID', async () => {
    const items = [item, secondItem]
    const twoItemPayload = { ...payload, items, digest: tradeSampleZeroDigest(210249, items, destination) }
    const deps = dependencies([
      locations, groupedItems(items),
      exactDetail(item), {}, transferredLot(item),
      exactDetail(secondItem), {}, transferredLot(secondItem),
      groupedItems(items, true),
    ])

    await runCatalogInventoryStageTradeSamplesJob(context, twoItemPayload, deps)

    expect(deps.rpc.mock.calls.filter((call) => call[1] === 'store.inventory.item.transfer')).toHaveLength(2)
    expect(deps.audit.mock.calls.at(-1)?.[1].payload).toMatchObject({
      complete: true,
      counts: { completed: 2 },
      items: [
        { inventoryItemId: 'new-44', externalTrackCode: 'TAG', sourceLocationId: 88 },
        { inventoryItemId: 'new-45', externalTrackCode: 'TAG-2', sourceLocationId: 88 },
      ],
      outcomes: [
        { inventoryItemId: '44', status: 'completed' },
        { inventoryItemId: '45', status: 'completed' },
      ],
    })
  })

  it('allows an unprocessed same-tag source sibling while verifying each destination lot', async () => {
    const first = { ...item, currentQty: 1, availableQty: 1 }
    const sibling = { ...item, currentQty: 4, availableQty: 4, inventoryItemId: '45' }
    const items = [first, sibling]
    const sameTagPayload = { ...payload, items, digest: tradeSampleZeroDigest(210249, items, destination) }
    const firstDestination = transferredLot(first).data[0]
    const siblingSource = { ...transferredLot(sibling).data[0], id: sibling.inventoryItemId, stockLocation: { id: 12, name: 'Back Stock' }, stockType: { id: 3 } }
    const siblingDestination = transferredLot(sibling).data[0]
    const deps = dependencies([
      locations, groupedItems(items),
      exactDetail(first), {}, { data: [firstDestination, siblingSource], totalCount: 2 },
      exactDetail(sibling), {}, { data: [firstDestination, siblingDestination], totalCount: 2 },
      groupedItems(items, true),
    ])

    await runCatalogInventoryStageTradeSamplesJob(context, sameTagPayload, deps)

    expect(deps.rpc.mock.calls.filter((call) => call[1] === 'store.inventory.item.transfer')).toEqual([
      [210249, 'store.inventory.item.transfer', expect.objectContaining({ items: [expect.objectContaining({ id: '44', qty: 1 })] })],
      [210249, 'store.inventory.item.transfer', expect.objectContaining({ items: [expect.objectContaining({ id: '45', qty: 4 })] })],
    ])
    expect(deps.audit.mock.calls.at(-1)?.[1].payload).toMatchObject({ complete: true, counts: { completed: 2 } })
  })

  it('accepts Sweed merging same-tag source packages into one destination lot', async () => {
    const first = { ...item, currentQty: 1, availableQty: 1 }
    const sibling = { ...item, currentQty: 4, availableQty: 4, inventoryItemId: '45' }
    const items = [first, sibling]
    const sameTagPayload = { ...payload, items, digest: tradeSampleZeroDigest(210249, items, destination) }
    const firstDestination = transferredLot(first).data[0]
    const siblingSource = { ...transferredLot(sibling).data[0], id: sibling.inventoryItemId, stockLocation: { id: 12, name: 'Back Stock' }, stockType: { id: 3 } }
    const mergedDestination = { ...firstDestination, id: 'merged-live', currentQty: 5, availableQty: 5 }
    const finalGrouped = {
      data: [{ product: { id: 9, name: 'Sample', sku: null }, items: [mergedDestination] }],
      totalCount: 1,
    }
    const deps = dependencies([
      locations, groupedItems(items),
      exactDetail(first), {}, { data: [firstDestination, siblingSource], totalCount: 2 },
      exactDetail(sibling), {}, { data: [mergedDestination], totalCount: 1 },
      finalGrouped,
    ])

    await runCatalogInventoryStageTradeSamplesJob(context, sameTagPayload, deps)

    expect(deps.audit.mock.calls.at(-1)?.[1].payload).toMatchObject({
      complete: true,
      items: [{ inventoryItemId: 'merged-live', currentQty: 5 }],
    })
  })

  it('accepts Sweed splitting one source package into multiple destination lots', async () => {
    const firstSplit = { ...productLots().data[0], id: 'split-1', currentQty: 1, availableQty: 1 }
    const secondSplit = { ...productLots().data[0], id: 'split-2', currentQty: 1, availableQty: 1 }
    const finalGrouped = {
      data: [{ product: { id: 9, name: 'Sample', sku: null }, items: [firstSplit, secondSplit] }],
      totalCount: 1,
    }
    const deps = dependencies([
      locations, grouped(), detail(), {},
      { data: [firstSplit, secondSplit], totalCount: 2 },
      finalGrouped,
    ])

    await runCatalogInventoryStageTradeSamplesJob(context, payload, deps)

    expect(deps.audit.mock.calls.at(-1)?.[1].payload).toMatchObject({
      complete: true,
      items: [
        { inventoryItemId: 'split-1', currentQty: 1 },
        { inventoryItemId: 'split-2', currentQty: 1 },
      ],
    })
  })

  it('waits one second and retries read-only verification without replaying the transfer', async () => {
    const deps = dependencies([
      locations, grouped(), detail(), {},
      productLots(false), productLots(false), productLots(),
      grouped(true),
    ])

    await runCatalogInventoryStageTradeSamplesJob(context, payload, deps)

    expect(deps.rpc.mock.calls.filter((call) => call[1] === 'store.inventory.item.transfer')).toHaveLength(1)
    expect(deps.rpc.mock.calls.filter((call) => call[1] === 'store.inventory.product.item.list')).toHaveLength(3)
    expect(deps.delay).toHaveBeenCalledTimes(2)
    expect(deps.delay).toHaveBeenNthCalledWith(1, 1_000)
    expect(deps.delay).toHaveBeenNthCalledWith(2, 1_000)
  })

  it('accepts Sweed padding around the destination name during post-transfer verification', async () => {
    const padded = ` ${destination.name}`
    const paddedLocations = { data: [{ id: 88, name: padded, enabled: true, stockType: { id: 7 } }] }
    const deps = dependencies([paddedLocations, grouped(), detail(), {}, productLots(true, true, padded), grouped(true, true, padded)])

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
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const deps = dependencies([locations, grouped(), detail(), {}, ...Array.from({ length: 10 }, () => productLots(false))])
    await expect(runCatalogInventoryStageTradeSamplesJob(context, payload, deps)).rejects.toThrow()
    expect(deps.audit.mock.calls.at(-1)?.[1].payload).toMatchObject({
      complete: false,
      outcomes: [{ inventoryItemId: '44', status: 'failed_unknown' }],
    })
    expect(deps.audit.mock.calls.at(-1)?.[1].payload.message).toContain(
      'Staging stopped during post-transfer verification for package 44: Transfer outcome was not visible after read 10 of 10; 1 live lot(s) matched: id=44,qty=2,available=2,location=12,stockType=3,tradeSample=true.',
    )
    expect(log).toHaveBeenCalledWith(
      '[trade-sample-stage][job 8] Staging stopped during post-transfer verification for package 44: Transfer outcome was not visible after read 10 of 10; 1 live lot(s) matched: id=44,qty=2,available=2,location=12,stockType=3,tradeSample=true.',
    )
    expect(deps.rpc.mock.calls.filter((call) => call[1] === 'store.inventory.item.transfer')).toHaveLength(1)
    expect(deps.rpc.mock.calls.filter((call) => call[1] === 'store.inventory.product.item.list')).toHaveLength(10)
    expect(deps.delay).toHaveBeenCalledTimes(9)
    log.mockRestore()
  })

  it('fails closed when paginated verification finds two exact destination lots for the package tag', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ...productLots().data[0],
      id: String(1000 + index),
      externalTrackCode: index === 0 ? item.externalTrackCode : `OTHER-${index}`,
    }))
    const duplicateTag = { ...productLots().data[0], id: '2000' }
    const duplicatePages = Array.from({ length: 10 }, () => [
      { data: firstPage, totalCount: 101 },
      { data: [duplicateTag], totalCount: 101 },
    ]).flat()
    const deps = dependencies([locations, grouped(), detail(), {}, ...duplicatePages])

    await expect(runCatalogInventoryStageTradeSamplesJob(context, payload, deps)).rejects.toThrow(
      'Transfer outcome was not visible after read 10 of 10',
    )

    expect(deps.rpc.mock.calls.filter((call) => call[1] === 'store.inventory.product.item.list')).toHaveLength(20)
    expect(deps.audit.mock.calls.at(-1)?.[1].payload).toMatchObject({
      complete: false,
      outcomes: [{ inventoryItemId: '44', status: 'failed_unknown' }],
    })
  })

  it('fails closed when Sweed reports an incomplete product-lot page', async () => {
    const deps = dependencies([
      locations, grouped(), detail(), {},
      { data: productLots().data, totalCount: 2 },
    ])

    await expect(runCatalogInventoryStageTradeSamplesJob(context, payload, deps)).rejects.toThrow(
      'Sweed returned an incomplete live-lot list for product 9.',
    )
    expect(deps.audit.mock.calls.at(-1)?.[1].payload.message).toContain(
      'Staging stopped during post-transfer verification for package 44: An unexpected internal error occurred.',
    )
    expect(deps.delay).not.toHaveBeenCalled()
  })

  it('keeps arbitrary Sweed failure details out of durable and console diagnostics', async () => {
    const secret = 'rpc failed with bearer SECRET-VALUE'
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const deps = dependencies([locations, grouped(), detail(), new Error(secret)])

    await expect(runCatalogInventoryStageTradeSamplesJob(context, payload, deps)).rejects.toThrow(secret)

    const message = deps.audit.mock.calls.at(-1)?.[1].payload.message
    expect(message).toContain('Staging stopped during transfer RPC for package 44: An unexpected internal error occurred.')
    expect(message).not.toContain('SECRET-VALUE')
    expect(log).toHaveBeenCalledWith(
      '[trade-sample-stage][job 8] Staging stopped during transfer RPC for package 44: An unexpected internal error occurred.',
    )
    expect(deps.rpc.mock.calls.filter((call) => call[1] === 'store.inventory.item.transfer')).toHaveLength(1)
    expect(deps.delay).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('stops later transfers when terminal audit fails', async () => {
    const audit = vi.fn().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('audit failed'))
    const deps = dependencies([locations, grouped(), detail(), {}, productLots()], audit)
    await expect(runCatalogInventoryStageTradeSamplesJob(context, payload, deps)).rejects.toThrow('audit failed')
    expect(deps.rpc.mock.calls.filter((call) => call[1] === 'store.inventory.item.transfer')).toHaveLength(1)
    expect(deps.audit.mock.calls.at(-1)?.[1].payload.outcomes).toEqual([{ inventoryItemId: '44', status: 'completed' }])
  })
})
