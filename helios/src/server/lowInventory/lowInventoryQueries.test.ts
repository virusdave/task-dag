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
          category_name: 'Pre-Rolls',
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
          subcategory_name: 'Infused',
        },
        {
          available_qty: 1,
          category_name: 'Pre-Rolls',
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
          subcategory_name: 'Infused',
        },
      ],
    })

    expect(model.snapshotObservedAt).toBe('2026-07-10T14:00:00.000Z')
    expect(model.locationGroups).toHaveLength(2)
    expect(model.locationGroups[0]).toMatchObject({
      location: { kind: 'shelf', label: 'PRE-A-10' },
      skus: [{
        categoryName: 'Pre-Rolls',
        combinedAvailableQty: 2,
        productSku: 'SKU-LOW',
        subcategoryName: 'Infused',
      }],
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
      category_name: null,
      current_qty: 1,
      hold_qty: 0,
      inventory_barcode: null,
      inventory_item_id: 'pkg',
      metrc_tag: null,
      observed_at_max: '2026-07-10T14:00:00.000Z',
      product_name: 'Product',
      product_id: 100,
      stock_location: 'FOR SALE - Midtown',
      subcategory_name: null,
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
      category_name: null,
      current_qty: 1,
      hold_qty: 0,
      internal_track_code: 'PRE-A-1',
      inventory_barcode: null,
      metrc_tag: null,
      observed_at_max: '2026-07-10T14:00:00.000Z',
      product_name: 'Product',
      stock_location: 'FOR SALE - Midtown',
      subcategory_name: null,
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
    expect(sql).toContain("c.raw_json->>'isTradeSample'")
    expect(sql).toContain("c.raw_json->>'isNotForSale'")
    expect(sql).toContain("nullif(btrim(c.category_name), '') as category_name")
    expect(sql).toContain("nullif(btrim(c.subcategory_name), '') as subcategory_name")
    expect(sql).not.toContain('raw_json as')
  })

  it('normalizes catalog taxonomy in the existing product lookup', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          available_qty: 1,
          category_name: 'Snapshot category',
          current_qty: 1,
          hold_qty: 0,
          internal_track_code: 'PRE-A-1',
          inventory_item_id: 'package-1',
          metrc_tag: null,
          observed_at_max: '2026-07-10T14:00:00.000Z',
          product_id: 100,
          product_name: 'Product',
          product_sku: null,
          stock_location: 'FOR SALE - Midtown',
          subcategory_name: 'Snapshot subcategory',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          active: true,
          category_name: 'Flower',
          product_id: 100,
          product_name: 'Catalog product',
          product_sku: 'CATALOG',
          subcategory_name: 'Indica',
        }],
      })
    vi.spyOn(poolModule, 'getPool').mockReturnValue({ query } as unknown as ReturnType<
      typeof poolModule.getPool
    >)

    await expect(
      queryLowInventoryReadModel({ dealerId: 210705, threshold: 2 }),
    ).resolves.toMatchObject({
      locationGroups: [{
        skus: [{
          categoryName: 'Flower',
          productSku: 'CATALOG',
          subcategoryName: 'Indica',
        }],
      }],
    })

    expect(query).toHaveBeenCalledTimes(2)
    const catalogSql = String(query.mock.calls[1]?.[0])
    expect(catalogSql).toContain("nullif(btrim(cg.category_name), '') as category_name")
    expect(catalogSql).toContain("nullif(btrim(cg.subcategory_name), '') as subcategory_name")
  })

  it('fills missing snapshot SKUs from the catalog and skips inactive products', () => {
    const baseRow = {
      available_qty: 1,
      category_name: 'Snapshot category',
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
      subcategory_name: 'Snapshot subcategory',
    }
    const model = buildLowInventoryReadModel({
      catalogProducts: [
        {
          active: true,
          category_name: 'Flower',
          product_id: 100,
          product_name: 'Mapped product',
          product_sku: 'MAPPED',
          subcategory_name: 'Indica',
        },
        {
          active: false,
          category_name: 'Other',
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
        productName: 'Mapped product',
        productSku: 'MAPPED',
        subcategoryName: 'Indica',
      },
    ])
  })

  it('uses explicit catalog taxonomy values and falls back only for unmapped products', () => {
    const row = {
      available_qty: 1,
      category_name: 'Snapshot category',
      current_qty: 1,
      hold_qty: 0,
      internal_track_code: 'PRE-A-1',
      metrc_tag: null,
      observed_at_max: '2026-07-10T14:00:00.000Z',
      product_name: 'Product',
      product_sku: null,
      stock_location: 'FOR SALE - Midtown',
      subcategory_name: 'Snapshot subcategory',
    }
    const model = buildLowInventoryReadModel({
      catalogProducts: [{
        active: true,
        category_name: null,
        product_id: 100,
        product_name: 'Catalog product',
        product_sku: 'CATALOG',
        subcategory_name: null,
      }],
      dealerId: 210705,
      rows: [
        { ...row, inventory_item_id: 'catalog-package', product_id: 100 },
        { ...row, inventory_item_id: 'snapshot-package', product_id: 200 },
      ],
      threshold: 2,
    })

    expect(model.locationGroups[0]?.skus).toMatchObject([
      { categoryName: null, productSku: 'CATALOG', subcategoryName: null },
      {
        categoryName: 'Snapshot category',
        productSku: null,
        subcategoryName: 'Snapshot subcategory',
      },
    ])
  })

  it('keeps an unmapped product visible with a null SKU and stable product id', () => {
    const model = buildLowInventoryReadModel({
      dealerId: 210705,
      rows: [
        {
          available_qty: 1,
          category_name: null,
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
          subcategory_name: null,
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
})
