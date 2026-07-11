import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { LowInventoryResponse } from '../../../shared/contracts/index.js'
import {
  findLowInventoryPackagesForScan,
  isLowInventoryPackageCountable,
  LowInventoryView,
  type LowInventoryViewState,
} from './LowInventoryView.js'

function response(overrides?: Partial<LowInventoryResponse>): LowInventoryResponse {
  return {
    data: {
      dealerId: 210705,
      snapshotObservedAt: '2026-07-10T14:30:00.000Z',
      threshold: 2,
      locationGroups: [
        {
          location: { kind: 'shelf', label: 'FLOWER-A-03' },
          skus: [
            {
              categoryName: 'Flower',
              combinedAvailableQty: 2,
              packages: [
                {
                  availableQty: 1,
                  currentQty: 1,
                  holdQty: 0,
                  internalTrackCode: 'FLOWER-A-03',
                  inventoryBarcode: '012345678905',
                  inventoryItemId: 'inventory-1',
                  metrcTag: '1A400000000000000001',
                  observedAt: '2026-07-10T14:30:00.000Z',
                  productId: 101,
                  productName: 'A deliberately long product name that must wrap cleanly on a narrow phone screen',
                  stockLocation: 'FOR SALE - Main Floor',
                },
                {
                  availableQty: 0,
                  currentQty: 2,
                  holdQty: 1,
                  internalTrackCode: null,
                  inventoryBarcode: null,
                  inventoryItemId: 'inventory-item-with-a-long-identifier-that-must-wrap',
                  metrcTag: null,
                  observedAt: '2026-07-10T14:30:00.000Z',
                  productId: 101,
                  productName: null,
                  stockLocation: 'FOR SALE - Main Floor',
                },
              ],
              productIds: [101],
              productName: 'A deliberately long product name that must wrap cleanly on a narrow phone screen',
              productSku: 'VERY-LONG-SKU-THAT-MUST-WRAP-ON-MOBILE',
              subcategoryName: 'Indica',
            },
          ],
        },
        {
          location: { kind: 'stock-room', label: 'FOR SALE - Vault Overflow With A Long Location Name' },
          skus: [
            {
              categoryName: 'Flower',
              combinedAvailableQty: 2,
              packages: [{
                availableQty: 1,
                currentQty: null,
                holdQty: null,
                internalTrackCode: null,
                inventoryBarcode: null,
                inventoryItemId: 'inventory-2',
                metrcTag: '   ',
                observedAt: '2026-07-10T14:30:00.000Z',
                productId: 101,
                productName: null,
                stockLocation: 'FOR SALE - Vault Overflow With A Long Location Name',
              }],
              productIds: [101],
              productName: 'A deliberately long product name that must wrap cleanly on a narrow phone screen',
              productSku: 'VERY-LONG-SKU-THAT-MUST-WRAP-ON-MOBILE',
              subcategoryName: 'Indica',
            },
          ],
        },
      ],
    },
    freshness: { isStale: false, staleAfterMinutes: 15 },
    site: { dealerId: 210705, siteKey: 'midtown', siteLabel: 'Midtown' },
    ...overrides,
  }
}

function render(state: LowInventoryViewState, cannabisOnly = false): string {
  return renderToStaticMarkup(
    <LowInventoryView
      cannabisOnly={cannabisOnly}
      onCannabisOnlyChange={() => undefined}
      siteLabel="Midtown"
      state={state}
      onRetry={() => undefined}
    />,
  )
}

describe('LowInventoryView', () => {
  it('renders location-first groups, long names, and every package without controls that write inventory', () => {
    const html = render({ kind: 'ready', response: response() })
    expect(html).toContain('FLOWER-A-03')
    expect(html).toContain('Stock room')
    expect(html).toContain('A deliberately long product name')
    expect(html).toContain('inventory-item-with-a-long-identifier')
    expect(html).toContain('inventory-2')
    expect(html).toContain('3 packages')
    expect(html).toContain('1 SKU')
    expect(html).toContain('Flower · Indica')
    expect(html).toContain('at this location')
    expect(html.match(/<small>2 site-wide<\/small>/g)).toHaveLength(2)
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('Cannabis only')
    expect(html).not.toContain('<form')
  })

  it('filters non-cannabis cards, prunes empty locations, and updates visible counts', () => {
    const base = response()
    const cannabisSku = base.data.locationGroups[0]!.skus[0]!
    const accessorySku = {
      ...cannabisSku,
      categoryName: 'Accessories',
      packages: [{ ...cannabisSku.packages[0]!, inventoryItemId: 'accessory-package' }],
      productIds: [202],
      productName: 'Rolling tray',
      productSku: 'ACCESSORY-SKU',
      subcategoryName: null,
    }
    const unknownSku = {
      ...accessorySku,
      categoryName: null,
      packages: [{ ...accessorySku.packages[0]!, inventoryItemId: 'unknown-package' }],
      productIds: [303],
      productName: 'Uncategorised item',
      productSku: 'UNKNOWN-SKU',
    }
    const filteredResponse = response({
      data: {
        ...base.data,
        locationGroups: [
          { ...base.data.locationGroups[0]!, skus: [cannabisSku, accessorySku, unknownSku] },
          { ...base.data.locationGroups[1]!, skus: [accessorySku] },
        ],
      },
    })

    const unfilteredHtml = render({ kind: 'ready', response: filteredResponse })
    expect(unfilteredHtml).toContain('3 SKUs')
    expect(unfilteredHtml).toContain('5 packages')
    expect(unfilteredHtml).toContain('Rolling tray')
    expect(unfilteredHtml).toContain('Category not reported')

    const filteredHtml = render({ kind: 'ready', response: filteredResponse }, true)
    expect(filteredHtml).toContain('2 SKUs')
    expect(filteredHtml).toContain('3 packages')
    expect(filteredHtml).toContain('Uncategorised item')
    expect(filteredHtml).not.toContain('Rolling tray')
    expect(filteredHtml).not.toContain('Vault Overflow With A Long Location Name')
    expect(filteredHtml).toContain('checked=""')
  })

  it.each([
    [{ kind: 'loading' } as const, 'Loading Midtown inventory'],
    [{ kind: 'error', message: 'Request failed safely.' } as const, 'Request failed safely.'],
  ])('renders the %s state accessibly', (state, expected) => {
    const html = render(state)
    expect(html).toContain(expected)
    expect(html).toMatch(/role="(status|alert)"/)
  })

  it('renders a stale warning with the snapshot time in New York', () => {
    const stale = response({ freshness: { isStale: true, staleAfterMinutes: 15 } })
    const html = render({ kind: 'ready', response: stale })
    expect(html).toContain('Stock snapshot is stale')
    expect(html).toContain('2026-07-10 10:30 New York time')
    expect(html).toContain('Do not use this list for a floor check')
  })

  it('renders an honest empty state', () => {
    const empty = response({ data: { ...response().data, locationGroups: [] } })
    const html = render({ kind: 'ready', response: empty })
    expect(html).toContain('No low-inventory items')
    expect(html).toContain('between 1 and 2 available')
  })

  it('renders labeled camera, photo, manual, and per-package count controls for editors', () => {
    const html = renderToStaticMarkup(
      <LowInventoryView
        cannabisOnly={false}
        canCaptureCounts
        onCannabisOnlyChange={() => undefined}
        siteLabel="Midtown"
        state={{ kind: 'ready', response: response() }}
      />,
    )
    expect(html).toContain('Count only')
    expect(html).toContain('Scan package')
    expect(html).toContain('From photo')
    expect(html).toContain('Barcode or METRC tag')
    expect(html).toContain('Record physical count')
    expect(html).toContain('Current quantity unavailable')
  })

  it('matches scans case-insensitively by package barcode or METRC tag and preserves ambiguity', () => {
    const packages = response().data.locationGroups.flatMap((group) =>
      group.skus.flatMap((sku) => sku.packages),
    )
    expect(findLowInventoryPackagesForScan(packages, ' 012345678905 ')).toMatchObject([
      { inventoryItemId: 'inventory-1' },
    ])
    expect(findLowInventoryPackagesForScan(packages, '1a400000000000000001')).toMatchObject([
      { inventoryItemId: 'inventory-1' },
    ])
    expect(findLowInventoryPackagesForScan(packages, 'unknown')).toEqual([])
    expect(findLowInventoryPackagesForScan([
      packages[0]!,
      { ...packages[0]!, inventoryItemId: 'inventory-duplicate' },
    ], '012345678905')).toHaveLength(2)
    expect(isLowInventoryPackageCountable(packages[0]!)).toBe(true)
    expect(isLowInventoryPackageCountable(packages[2]!)).toBe(false)
    expect(findLowInventoryPackagesForScan([
      { ...packages[2]!, inventoryBarcode: 'unavailable-package' },
    ], 'unavailable-package')).toMatchObject([{ currentQty: null }])
  })

  it('distinguishes a cannabis filter with no matches from an empty source', () => {
    const base = response()
    const accessorySku = {
      ...base.data.locationGroups[0]!.skus[0]!,
      categoryName: 'Other',
      subcategoryName: null,
    }
    const accessoriesOnly = response({
      data: {
        ...base.data,
        locationGroups: [{ ...base.data.locationGroups[0]!, skus: [accessorySku] }],
      },
    })
    const html = render({ kind: 'ready', response: accessoriesOnly }, true)
    expect(html).toContain('No cannabis low-inventory items')
    expect(html).toContain('Turn off Cannabis only to show Accessories and Other.')
    expect(html).not.toContain('No low-inventory items')
  })
})
