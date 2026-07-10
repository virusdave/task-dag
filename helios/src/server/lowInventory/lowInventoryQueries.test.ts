import { afterEach, describe, expect, it, vi } from 'vitest'

import * as poolModule from '../db/pool.js'
import {
  buildLowInventoryReadModel,
  queryLowInventoryReadModel,
} from './lowInventoryQueries.js'

describe('low-inventory read model', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('groups qualifying package rows by valid shelf code with stock-room fallback', () => {
    const model = buildLowInventoryReadModel({
      dealerId: 210705,
      threshold: 2,
      rows: [
        {
          available_qty: '1',
          current_qty: '2',
          hold_qty: '1',
          internal_track_code: 'PRE-A-10',
          inventory_item_id: 'pkg-2',
          metrc_tag: 'ABC0002',
          observed_at_max: '2026-07-10T14:00:00.000Z',
          product_id: 100,
          product_name: 'Long Walk Pre-roll',
          product_sku: 'SKU-LOW',
          stock_location: 'FOR SALE - Midtown',
        },
        {
          available_qty: 1,
          current_qty: 1,
          hold_qty: 0,
          internal_track_code: 'not-a-shelf',
          inventory_item_id: 'pkg-1',
          metrc_tag: null,
          observed_at_max: new Date('2026-07-10T13:00:00.000Z'),
          product_id: 100,
          product_name: 'Long Walk Pre-roll',
          product_sku: 'SKU-LOW',
          stock_location: 'FOR SALE - Midtown',
        },
      ],
    })

    expect(model.snapshotObservedAt).toBe('2026-07-10T14:00:00.000Z')
    expect(model.locationGroups).toHaveLength(2)
    expect(model.locationGroups[0]).toMatchObject({
      location: { kind: 'shelf', label: 'PRE-A-10' },
      skus: [{ combinedAvailableQty: 2, productSku: 'SKU-LOW' }],
    })
    expect(model.locationGroups[1]).toMatchObject({
      location: { kind: 'stock-room', label: 'FOR SALE - Midtown' },
      skus: [
        {
          packages: [
            {
              availableQty: 1,
              currentQty: 1,
              holdQty: 0,
              inventoryItemId: 'pkg-1',
            },
          ],
        },
      ],
    })
  })

  it('sorts shelf groups in walking order before stock-room fallbacks', () => {
    const row = {
      available_qty: 1,
      current_qty: 1,
      hold_qty: 0,
      inventory_item_id: 'pkg',
      metrc_tag: null,
      observed_at_max: '2026-07-10T14:00:00.000Z',
      product_name: 'Product',
      product_id: 100,
      stock_location: 'FOR SALE - Midtown',
    }
    const model = buildLowInventoryReadModel({
      dealerId: 210705,
      threshold: 2,
      rows: [
        { ...row, internal_track_code: null, product_sku: 'ROOM' },
        { ...row, internal_track_code: 'PRE-A-10', product_sku: 'TEN' },
        { ...row, internal_track_code: 'PRE-A-2', product_sku: 'TWO' },
      ],
    })

    expect(model.locationGroups.map((group) => group.location.label)).toEqual([
      'PRE-A-2',
      'PRE-A-10',
      'FOR SALE - Midtown',
    ])
  })

  it('combines shared SKUs across product ids and excludes totals outside 1..N', () => {
    const baseRow = {
      current_qty: 1,
      hold_qty: 0,
      internal_track_code: 'PRE-A-1',
      metrc_tag: null,
      observed_at_max: '2026-07-10T14:00:00.000Z',
      product_name: 'Product',
      stock_location: 'FOR SALE - Midtown',
    }
    const model = buildLowInventoryReadModel({
      dealerId: 210705,
      threshold: 2,
      rows: [
        {
          ...baseRow,
          available_qty: 1,
          inventory_item_id: 'pkg-1',
          product_id: 100,
          product_sku: 'SHARED',
        },
        {
          ...baseRow,
          available_qty: 1,
          inventory_item_id: 'pkg-2',
          product_id: 200,
          product_sku: 'SHARED',
        },
        {
          ...baseRow,
          available_qty: 3,
          inventory_item_id: 'pkg-3',
          product_id: 300,
          product_sku: 'TOO-HIGH',
        },
        {
          ...baseRow,
          available_qty: 0,
          inventory_item_id: 'pkg-4',
          product_id: 400,
          product_sku: 'ZERO',
        },
      ],
    })

    expect(model.locationGroups[0]?.skus).toMatchObject([
      {
        combinedAvailableQty: 2,
        packages: [{ inventoryItemId: 'pkg-1' }, { inventoryItemId: 'pkg-2' }],
        productIds: [100, 200],
        productSku: 'SHARED',
      },
    ])
  })

  it('queries the current mirror with the canonical sellable filters', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    vi.spyOn(poolModule, 'getPool').mockReturnValue({ query } as unknown as ReturnType<
      typeof poolModule.getPool
    >)

    await expect(
      queryLowInventoryReadModel({ dealerId: 210249, threshold: 2 }),
    ).resolves.toEqual({
      dealerId: 210249,
      locationGroups: [],
      snapshotObservedAt: null,
      threshold: 2,
    })

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('from sweed_package_current c'),
      [210249],
    )
    const sql = String(query.mock.calls[0]?.[0])
    expect(sql).toContain("c.stock_location ilike 'FOR SALE%'")
    expect(sql).toContain("c.raw_json->>'isTradeSample'")
    expect(sql).toContain("c.raw_json->>'isNotForSale'")
    expect(sql).not.toContain('raw_json as')
  })

  it('fills missing snapshot SKUs from the catalog and skips inactive products', () => {
    const baseRow = {
      available_qty: 1,
      current_qty: 1,
      hold_qty: 0,
      internal_track_code: 'PRE-A-1',
      inventory_item_id: 'pkg-1',
      metrc_tag: null,
      observed_at_max: '2026-07-10T14:00:00.000Z',
      product_name: null,
      product_sku: null,
      stock_location: 'FOR SALE - Midtown',
    }
    const model = buildLowInventoryReadModel({
      catalogProducts: [
        {
          active: true,
          product_id: 100,
          product_name: 'Mapped product',
          product_sku: 'MAPPED',
        },
        {
          active: false,
          product_id: 200,
          product_name: 'Disabled product',
          product_sku: 'DISABLED',
        },
      ],
      dealerId: 210705,
      rows: [
        { ...baseRow, product_id: 100 },
        { ...baseRow, inventory_item_id: 'pkg-2', product_id: 200 },
      ],
      threshold: 2,
    })

    expect(model.locationGroups).toHaveLength(1)
    expect(model.locationGroups[0]?.skus).toMatchObject([
      { productName: 'Mapped product', productSku: 'MAPPED' },
    ])
  })

  it('keeps an unmapped product visible with a null SKU and stable product id', () => {
    const model = buildLowInventoryReadModel({
      dealerId: 210705,
      rows: [
        {
          available_qty: 1,
          current_qty: 1,
          hold_qty: 0,
          internal_track_code: null,
          inventory_item_id: 'pkg-unmapped',
          metrc_tag: null,
          observed_at_max: '2026-07-10T14:00:00.000Z',
          product_id: 516281,
          product_name: 'Unmapped product',
          product_sku: null,
          stock_location: 'FOR SALE - Midtown',
        },
      ],
      threshold: 2,
    })

    expect(model.locationGroups[0]?.skus).toMatchObject([
      { combinedAvailableQty: 1, productIds: [516281], productSku: null },
    ])
  })

  it('rejects unknown sites and invalid thresholds before querying', async () => {
    const query = vi.fn()
    vi.spyOn(poolModule, 'getPool').mockReturnValue({ query } as unknown as ReturnType<
      typeof poolModule.getPool
    >)

    await expect(
      queryLowInventoryReadModel({ dealerId: 999999, threshold: 2 }),
    ).rejects.toThrow('Unknown Helios dealer id 999999.')
    await expect(
      queryLowInventoryReadModel({ dealerId: 210705, threshold: 0 }),
    ).rejects.toThrow('Low-inventory threshold must be a positive integer.')
    expect(query).not.toHaveBeenCalled()
  })
})
