import { describe, expect, it, vi } from 'vitest'

import type { TradeSampleZeroItem } from '../../shared/contracts/index.js'
import {
  previewTradeSampleZero,
  readLiveInventory,
  reconcileTargetContents,
  verifyTradeSampleZeroPreview,
  type TradeSampleZeroDeps,
} from './tradeSampleZeroService.js'

const dealerId = 210249
const location = {
  data: [{ id: 88, name: 'NOT FOR SALE - Samples', enabled: true, stockType: { id: 7 } }],
}
const destination = { id: 88, name: 'NOT FOR SALE - Samples', stockTypeId: 7 }
const source = { id: 12, name: 'Sales Floor' }
const stockType = { id: 3 }

function packageItem(overrides: Record<string, unknown> = {}) {
  return {
    id: '44',
    currentQty: 3.5,
    availableQty: 3.5,
    externalTrackCode: 'TAG-1',
    isTradeSample: true,
    stockLocation: source,
    stockType,
    ...overrides,
  }
}

function row(items = [packageItem()], productId = 9) {
  return { product: { id: productId, name: 'Sample Flower', sku: 'SF' }, items }
}

function page(data: unknown[], totalCount = data.length) {
  return { data, totalCount }
}

function dependencies(responses: unknown[]): TradeSampleZeroDeps {
  return {
    previewSecret: 'preview-secret',
    rpc: vi.fn(async () => responses.shift()),
  }
}

const expectedItem: TradeSampleZeroItem = {
  availableQty: 3.5,
  currentQty: 3.5,
  externalTrackCode: 'TAG-1',
  inventoryItemId: '44',
  packageLabel: null,
  productId: 9,
  productName: 'Sample Flower',
  productSku: 'SF',
  sourceLocationId: 12,
  sourceLocationName: 'Sales Floor',
  sourceStockTypeId: 3,
}

describe('trade sample preview', () => {
  it('lists the canonical destination first, then fully paginates grouped live inventory', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => row(index === 0 ? [packageItem()] : [], index === 0 ? 9 : index + 1))
    const dependenciesUnderTest = dependencies([location, page(firstPage, 101), page([row([], 101)], 101)])

    const preview = await previewTradeSampleZero(dealerId, dependenciesUnderTest)

    expect(preview.items).toEqual([expectedItem])
    expect(verifyTradeSampleZeroPreview(preview, 'preview-secret')).toBe(true)
    expect(dependenciesUnderTest.rpc).toHaveBeenNthCalledWith(1, dealerId, 'store.stock.location.list', {})
    expect(dependenciesUnderTest.rpc).toHaveBeenNthCalledWith(
      2,
      dealerId,
      'store.inventory.item.list.grouped',
      { page: 1, pageSize: 100, isOnStock: true },
    )
    expect(dependenciesUnderTest.rpc).toHaveBeenNthCalledWith(
      3,
      dealerId,
      'store.inventory.item.list.grouped',
      { page: 2, pageSize: 100, isOnStock: true },
    )
  })

  it.each([null, '', false])('rejects malformed current quantity %j', async (currentQty) => {
    await expect(readLiveInventory(dealerId, destination, dependencies([page([row([packageItem({ currentQty })])])]))).rejects.toThrow()
  })

  it.each([null, '', false])('rejects malformed available quantity %j', async (availableQty) => {
    await expect(readLiveInventory(dealerId, destination, dependencies([page([row([packageItem({ availableQty })])])]))).rejects.toThrow()
  })

  it('rejects inconsistent totals and incomplete pagination', async () => {
    const full = Array.from({ length: 100 }, (_, index) => row([], index + 1))
    await expect(readLiveInventory(dealerId, destination, dependencies([page(full, 101), page([], 102)]))).rejects.toThrow('changed during pagination')
    await expect(readLiveInventory(dealerId, destination, dependencies([page([row()], 2)]))).rejects.toThrow('incomplete')
  })

  it('rejects conflicting duplicate package IDs', async () => {
    await expect(readLiveInventory(dealerId, destination, dependencies([
      page([row([packageItem(), packageItem({ currentQty: 4, availableQty: 4 })])]),
    ]))).rejects.toThrow('Conflicting duplicate')
  })

  it('ignores incomplete non-sample metadata outside the dedicated destination', async () => {
    const unrelated = packageItem({ externalTrackCode: null, id: 'unrelated', isTradeSample: false })
    const preview = await previewTradeSampleZero(dealerId, dependencies([
      location,
      page([row([packageItem(), unrelated])]),
    ]))

    expect(preview.items).toEqual([expectedItem])
  })

  it.each([null, undefined])('rejects unknown trade-sample classification %j outside the destination', async (isTradeSample) => {
    const unknown = packageItem({ externalTrackCode: null, id: 'unknown', isTradeSample })
    await expect(previewTradeSampleZero(dealerId, dependencies([
      location,
      page([row([packageItem(), unknown])]),
    ]))).rejects.toThrow('unknown trade-sample classification')
  })

  it('does not treat missing quantity as zero for a package in the destination', async () => {
    const occupant = packageItem({
      currentQty: undefined,
      id: 'occupant',
      isTradeSample: false,
      stockLocation: { id: 88, name: 'NOT FOR SALE - Samples' },
      stockType: { id: 7 },
    })
    await expect(previewTradeSampleZero(dealerId, dependencies([
      location,
      page([row([packageItem(), occupant])]),
    ]))).rejects.toThrow('invalid package quantity metadata')
  })

  it('treats every positive package in the destination as occupied, including non-samples', async () => {
    const destinationPackage = packageItem({
      id: 'other',
      externalTrackCode: 'OTHER',
      isTradeSample: false,
      stockLocation: { id: 88, name: 'NOT FOR SALE - Samples' },
      stockType: { id: 7 },
    })
    await expect(previewTradeSampleZero(dealerId, dependencies([
      location,
      page([row([packageItem(), destinationPackage])]),
    ]))).rejects.toThrow('occupied')
  })

  it('requires exactly one enabled, non-retired, exact-name destination', async () => {
    await expect(previewTradeSampleZero(dealerId, dependencies([
      { data: [{ id: 88, name: 'not for sale - samples', enabled: true, stockType: { id: 7 } }] },
    ]))).rejects.toThrow('exactly one')
  })

  it('accepts insignificant whitespace around the live Sweed location name', async () => {
    const preview = await previewTradeSampleZero(dealerId, dependencies([
      { data: [{ id: 5708, name: ' NOT FOR SALE - Samples', enabled: true, stockType: { id: 1 } }] },
      page([row([packageItem()])]),
    ]))

    expect(preview.destination).toEqual({
      id: 5708,
      name: 'NOT FOR SALE - Samples',
      stockTypeId: 1,
    })
  })

  it('reconciles destination lot splits and merges by trusted aggregate quantity', () => {
    const reviewed = [
      expectedItem,
      { ...expectedItem, inventoryItemId: '45', currentQty: 1.5, availableQty: 1.5 },
    ]
    const merged = {
      ...expectedItem,
      inventoryItemId: 'destination-1',
      currentQty: 5,
      availableQty: 5,
      sourceLocationId: destination.id,
      sourceLocationName: destination.name,
      sourceStockTypeId: destination.stockTypeId,
      isTradeSample: true,
    }

    expect(reconcileTargetContents([merged], destination, reviewed)).toEqual([
      expect.objectContaining({ inventoryItemId: 'destination-1', currentQty: 5 }),
    ])
    expect(() => reconcileTargetContents([{ ...merged, currentQty: 4, availableQty: 4 }], destination, reviewed))
      .toThrow('different aggregate quantity')
    expect(() => reconcileTargetContents([{ ...merged, isTradeSample: false }], destination, reviewed))
      .toThrow('non-sample')
  })

  it('reconciles decimal quantities as exact integer units', () => {
    const reviewed = [
      { ...expectedItem, currentQty: 0.1, availableQty: 0.1 },
      { ...expectedItem, inventoryItemId: '45', currentQty: 0.2, availableQty: 0.2 },
    ]
    const merged = {
      ...expectedItem,
      inventoryItemId: 'destination-decimal',
      currentQty: 0.3,
      availableQty: 0.3,
      sourceLocationId: destination.id,
      sourceLocationName: destination.name,
      sourceStockTypeId: destination.stockTypeId,
      isTradeSample: true,
    }
    expect(reconcileTargetContents([merged], destination, reviewed)).toHaveLength(1)
    expect(() => reconcileTargetContents([{ ...merged, currentQty: 0.300001, availableQty: 0.300001 }], destination, reviewed))
      .toThrow('different aggregate quantity')
  })
})
