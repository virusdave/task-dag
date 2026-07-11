import { afterEach, describe, expect, it, vi } from 'vitest'

import * as poolModule from '../db/pool.js'
import {
  buildLowInventoryReadModel,
  getLowInventoryPackageSnapshot,
  listLowInventoryCountAudits,
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
          inventory_barcode: 'barcode-2',
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
          inventory_barcode: null,
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
      inventory_barcode: null,
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
      inventory_barcode: null,
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
    expect(model.snapshotObservedAt).toBe('2026-07-10T14:00:00.000Z')
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
    expect(sql).not.toContain("c.observed_at_max >= now() - interval '15 minutes'")
    expect(sql).toContain("c.raw_json->>'isTradeSample'")
    expect(sql).toContain("c.raw_json->>'isNotForSale'")
    expect(sql).not.toContain('raw_json as')
  })

  it('suppresses a whole SKU when one contributing package is stale', () => {
    const baseRow = {
      available_qty: 1, current_qty: 1, hold_qty: 0, internal_track_code: 'PRE-A-1',
      metrc_tag: null, product_id: 100, product_name: 'Mapped product', product_sku: 'MAPPED',
      stock_location: 'FOR SALE - Midtown',
    }
    const model = buildLowInventoryReadModel({
      dealerId: 210705,
      now: new Date('2026-07-10T14:20:01.000Z'),
      rows: [
        { ...baseRow, inventory_item_id: 'fresh', observed_at_max: '2026-07-10T14:20:00.000Z' },
        { ...baseRow, inventory_item_id: 'stale', observed_at_max: '2026-07-10T14:00:00.000Z' },
      ],
      threshold: 2,
    })
    expect(model.locationGroups).toEqual([])
    expect(model.snapshotObservedAt).toBe('2026-07-10T14:20:00.000Z')
  })

  it('fences count snapshots against transfers after the package shape began', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    await getLowInventoryPackageSnapshot({
      db: { query }, dealerId: 210705, inventoryItemId: 'pkg-1', productId: 123,
      snapshotObservedAt: '2026-07-10T14:20:00.000Z',
    })
    const sql = String(query.mock.calls[0]?.[0])
    expect(sql).toContain('te.created_at >= c.observed_at_min')
    expect(sql).toContain("te.payload_json->>'inventoryItemId' = c.inventory_item_id")
  })

  it('fills missing snapshot SKUs from the catalog and skips inactive products', () => {
    const baseRow = {
      available_qty: 1,
      current_qty: 1,
      hold_qty: 0,
      internal_track_code: 'PRE-A-1',
      inventory_barcode: null,
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
          category_name: 'Flower',
          product_id: 100,
          product_name: 'Mapped product',
          product_sku: 'MAPPED',
          subcategory_name: 'Indoor',
        },
        {
          active: false,
          category_name: 'Accessories',
          product_id: 200,
          product_name: 'Disabled product',
          product_sku: 'DISABLED',
          subcategory_name: null,
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
      {
        categoryName: 'Flower',
        isCannabis: true,
        productName: 'Mapped product',
        productSku: 'MAPPED',
        subcategoryName: 'Indoor',
      },
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
          inventory_barcode: null,
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
    ).rejects.toThrow('Low-inventory threshold must be an integer from 1 through 100.')
    await expect(
      queryLowInventoryReadModel({ dealerId: 210705, threshold: 101 }),
    ).rejects.toThrow('Low-inventory threshold must be an integer from 1 through 100.')
    expect(query).not.toHaveBeenCalled()
  })

  it('maps bounded count audits to pending and resolved transfer status', async () => {
    const payload = {
      dealerId: 210705, productId: 100, inventoryItemId: 'pkg-1', metrcTag: 'TAG-1',
      sourceLocation: 'FOR SALE', snapshotCurrentQty: 1, snapshotAvailableQty: 1,
      snapshotHoldQty: 0, snapshotObservedAt: '2026-07-10T14:00:00.000Z',
      physicalCount: 0, classification: 'zero',
    }
    const query = vi.fn().mockResolvedValue({ rows: [
      { id: 10, created_at: new Date('2026-07-10T15:00:00.000Z'), payload_json: payload,
        actor_label: 'Editor', transfer_audit_id: null },
      { id: 9, created_at: new Date('2026-07-10T14:00:00.000Z'), payload_json: payload,
        actor_label: 'Editor', transfer_audit_id: 11 },
    ] })
    const items = await listLowInventoryCountAudits({ query }, 210705, 20)
    expect(query).toHaveBeenCalledWith(expect.stringContaining('limit $2'), [210705, 20])
    expect(items.map((item) => item.transferStatus)).toEqual(['pending', 'resolved'])
  })
})
