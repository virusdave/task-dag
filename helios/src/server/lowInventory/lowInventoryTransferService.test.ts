import { beforeEach, describe, expect, it, vi } from 'vitest'

const appendAuditEventMock = vi.hoisted(() => vi.fn())
const getPendingMock = vi.hoisted(() => vi.fn())
const listLocationsMock = vi.hoisted(() => vi.fn())
const listLotsMock = vi.hoisted(() => vi.fn())
const transferLotMock = vi.hoisted(() => vi.fn())
const notifyMock = vi.hoisted(() => vi.fn())
const getAppSettingMock = vi.hoisted(() => vi.fn())

vi.mock('../audit/appendAuditEvent.js', () => ({ appendAuditEvent: appendAuditEventMock }))
vi.mock('./lowInventoryQueries.js', () => ({ getPendingLowInventoryCountAudit: getPendingMock }))
vi.mock('../catalog/stockTransferService.js', () => ({
  isUsableLocation: (location: { enabled: boolean; stockTypeId: number | null }) =>
    location.enabled && location.stockTypeId !== null,
  listStockLocations: listLocationsMock,
  listLiveLotsForProduct: listLotsMock,
  transferLot: transferLotMock,
}))
vi.mock('../../worker/sweed/session.js', () => ({
  withSweedSession: (run: () => Promise<unknown>) => run(),
}))
vi.mock('../db/tx.js', () => ({
  withTransaction: (run: (db: unknown) => Promise<unknown>) => run(db),
}))
vi.mock('../db/queries/appSettingsQueries.js', () => ({ getAppSetting: getAppSettingMock }))
vi.mock('./lowInventoryNotifications.js', () => ({ notifyLowInventoryAudit: notifyMock }))

import {
  confirmLowInventoryTransfer,
  LowInventoryTransferConflictError,
} from './lowInventoryTransferService.js'

const config = {
  dealerId: 210705,
  destinationName: 'NOT FOR SALE - Quantity Audit',
  transferEnabled: true,
  updatedAt: '2026-07-10T15:00:00.000Z',
  updatedBy: 'admin@example.com',
}
const count = {
  dealerId: 210705, productId: 123, inventoryItemId: 'pkg-1', metrcTag: 'TAG-1',
  sourceLocation: 'FOR SALE - Midtown', snapshotCurrentQty: 1, snapshotAvailableQty: 1,
  snapshotHoldQty: 0, snapshotObservedAt: '2026-07-10T14:00:00.000Z',
  physicalCount: 0, classification: 'zero' as const,
}
const db = { query: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  db.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('as unresolved') ? [{ unresolved: false }] : [{ locked: true }],
  }))
  getPendingMock.mockResolvedValue(count)
  getAppSettingMock.mockResolvedValue({
    key: 'low_inventory_transfer_config:midtown', updatedAt: config.updatedAt,
    updatedBy: 'admin@example.com', value: {
      dealerId: config.dealerId,
      destinationName: config.destinationName,
      transferEnabled: config.transferEnabled,
    },
  })
  listLocationsMock.mockResolvedValue([
    { id: 8, name: 'NOT FOR SALE - Quantity Audit', enabled: true, stockTypeId: 80 },
  ])
  listLotsMock.mockResolvedValue([{
    inventoryItemId: 'pkg-1', externalTrackCode: 'TAG-1', availableQty: 1, currentQty: 1,
    stockLocationId: 7, stockLocationName: 'FOR SALE - Midtown', stockTypeId: 70,
    isTradeSample: false,
  }])
  transferLotMock.mockResolvedValue({
    itemId: 'pkg-1', externalTrackCode: 'TAG-1', movedQty: 1,
    fromStockLocationId: 7, fromStockLocationName: 'FOR SALE - Midtown', fromStockTypeId: 70,
    toStockLocationId: 8, toStockTypeId: 80, reservedHeldBack: false,
  })
  appendAuditEventMock.mockResolvedValue(52)
  notifyMock.mockResolvedValue(undefined)
})

describe('low-inventory transfer service', () => {
  it('fails closed before Sweed when transfer is disabled', async () => {
    await expect(confirmLowInventoryTransfer({
      actorUserId: 2, config: { ...config, transferEnabled: false }, countAuditId: 51,
      db, dealerId: 210705, requestId: null,
    })).rejects.toBeInstanceOf(LowInventoryTransferConflictError)
    expect(listLocationsMock).not.toHaveBeenCalled()
  })

  it('accepts the reviewed enabled default when no site override exists', async () => {
    getAppSettingMock.mockResolvedValue(null)
    listLotsMock
      .mockResolvedValueOnce([{
        inventoryItemId: 'pkg-1', externalTrackCode: 'TAG-1', availableQty: 1, currentQty: 1,
        stockLocationId: 7, stockLocationName: 'FOR SALE - Midtown', stockTypeId: 70,
        isTradeSample: false,
      }])
      .mockResolvedValueOnce([{
        inventoryItemId: 'pkg-1', externalTrackCode: 'TAG-1', availableQty: 1, currentQty: 1,
        stockLocationId: 8, stockLocationName: 'NOT FOR SALE - Quantity Audit', stockTypeId: 80,
        isTradeSample: false,
      }])

    await expect(confirmLowInventoryTransfer({
      actorUserId: 2, config: { ...config, updatedAt: null, updatedBy: null }, countAuditId: 51,
      db, dealerId: 210705, requestId: null,
    })).resolves.toMatchObject({ countAuditId: 51, movedQty: 1 })
    expect(transferLotMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      name: 'an admin override appears after reviewing the default',
      reviewed: { ...config, updatedAt: null, updatedBy: null },
      current: {
        key: 'low_inventory_transfer_config:midtown',
        updatedAt: '2026-07-10T16:00:00.000Z',
        updatedBy: 'admin@example.com',
        value: { dealerId: 210705, destinationName: config.destinationName, transferEnabled: false },
      },
    },
    { name: 'the reviewed override is deleted', reviewed: config, current: null },
    {
      name: 'the persisted override is malformed', reviewed: config,
      current: { key: 'low_inventory_transfer_config:midtown', updatedAt: config.updatedAt, updatedBy: 'admin@example.com', value: {} },
    },
    {
      name: 'the destination changes', reviewed: config,
      current: { key: 'low_inventory_transfer_config:midtown', updatedAt: config.updatedAt, updatedBy: 'admin@example.com', value: { dealerId: 210705, destinationName: 'NOT FOR SALE - Other', transferEnabled: true } },
    },
    {
      name: 'the override timestamp changes', reviewed: config,
      current: { key: 'low_inventory_transfer_config:midtown', updatedAt: '2026-07-10T16:00:00.000Z', updatedBy: 'admin@example.com', value: { dealerId: 210705, destinationName: config.destinationName, transferEnabled: true } },
    },
    {
      name: 'the reviewed default destination is altered',
      reviewed: { ...config, destinationName: 'NOT FOR SALE - Other', updatedAt: null, updatedBy: null },
      current: null,
    },
    {
      name: 'the reviewed default metadata is not empty',
      reviewed: { ...config, updatedAt: null },
      current: null,
    },
  ])('fails closed before Sweed when $name', async ({ reviewed, current }) => {
    getAppSettingMock.mockResolvedValue(current)

    await expect(confirmLowInventoryTransfer({
      actorUserId: 2, config: reviewed, countAuditId: 51,
      db, dealerId: 210705, requestId: null,
    })).rejects.toThrow('Transfer settings changed after review')
    expect(listLocationsMock).not.toHaveBeenCalled()
    expect(transferLotMock).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'is absent', locations: [] },
    {
      name: 'is ambiguous',
      locations: [
        { id: 8, name: config.destinationName, enabled: true, stockTypeId: 80 },
        { id: 9, name: config.destinationName, enabled: true, stockTypeId: 90 },
      ],
    },
    {
      name: 'is disabled',
      locations: [{ id: 8, name: config.destinationName, enabled: false, stockTypeId: 80 }],
    },
    {
      name: 'has no stock type',
      locations: [{ id: 8, name: config.destinationName, enabled: true, stockTypeId: null }],
    },
  ])('fails closed when the exact destination $name', async ({ locations }) => {
    listLocationsMock.mockResolvedValue(locations)

    await expect(confirmLowInventoryTransfer({
      actorUserId: 2, config, countAuditId: 51,
      db, dealerId: 210705, requestId: null,
    })).rejects.toThrow('does not resolve to exactly one enabled location')
    expect(transferLotMock).not.toHaveBeenCalled()
  })

  it('validates one exact live lot, transfers it, and records reversible from/to data', async () => {
    listLotsMock
      .mockResolvedValueOnce([{
        inventoryItemId: 'pkg-1', externalTrackCode: 'TAG-1', availableQty: 1, currentQty: 1,
        stockLocationId: 7, stockLocationName: 'FOR SALE - Midtown', stockTypeId: 70,
        isTradeSample: false,
      }])
      .mockResolvedValueOnce([{
        inventoryItemId: 'pkg-1', externalTrackCode: 'TAG-1', availableQty: 1, currentQty: 1,
        stockLocationId: 8, stockLocationName: 'NOT FOR SALE - Quantity Audit', stockTypeId: 80,
        isTradeSample: false,
      }])
    const result = await confirmLowInventoryTransfer({
      actorUserId: 2, config, countAuditId: 51, db, dealerId: 210705, requestId: 'req-1',
    })
    expect(listLotsMock).toHaveBeenCalledWith(210705, 123)
    expect(transferLotMock).toHaveBeenCalledTimes(1)
    expect(appendAuditEventMock).toHaveBeenCalledWith(db, expect.objectContaining({
      eventType: 'low_inventory.package_transfer.completed',
      payload: expect.objectContaining({ countAuditId: 51, movedQty: 1 }),
      undoPayload: expect.objectContaining({
        from: expect.objectContaining({ locationId: 8 }),
        to: expect.objectContaining({ locationId: 7 }),
      }),
    }))
    expect(result).toEqual({
      transferAuditId: 52, countAuditId: 51, movedQty: 1, notificationStatus: 'sent',
    })
  })

  it('rejects stale quantity or METRC identity without transferring', async () => {
    listLotsMock.mockResolvedValue([{
      inventoryItemId: 'pkg-1', externalTrackCode: 'CHANGED', availableQty: 2, currentQty: 2,
      stockLocationId: 7, stockLocationName: 'FOR SALE - Midtown', stockTypeId: 70,
      isTradeSample: false,
    }])
    await expect(confirmLowInventoryTransfer({
      actorUserId: 2, config, countAuditId: 51, db, dealerId: 210705, requestId: null,
    })).rejects.toThrow('no longer matches')
    expect(transferLotMock).not.toHaveBeenCalled()
  })

  it('rejects a package that became a trade sample', async () => {
    listLotsMock.mockResolvedValue([{
      inventoryItemId: 'pkg-1', externalTrackCode: 'TAG-1', availableQty: 1, currentQty: 1,
      stockLocationId: 7, stockLocationName: 'FOR SALE - Midtown', stockTypeId: 70,
      isTradeSample: true,
    }])
    await expect(confirmLowInventoryTransfer({
      actorUserId: 2, config, countAuditId: 51, db, dealerId: 210705, requestId: null,
    })).rejects.toThrow('no longer matches')
    expect(transferLotMock).not.toHaveBeenCalled()
  })
})
