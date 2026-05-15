import { describe, expect, it } from 'vitest'

import type { NormalizedCatalogGroupLiveState } from '../catalog/liveState.js'
import { filterScopedProductsFromLiveState } from './generatePricingBatchJob.js'

function buildLiveState(): NormalizedCatalogGroupLiveState {
  return {
    brand: 'MFNY',
    category: 'Vapes',
    currentDescription: '',
    effects: [],
    flavorings: [],
    groupFullName: 'MFNY Resin AIO',
    groupId: 42,
    groupName: 'Resin AIO',
    imageUrl: null,
    productTabs: ['0.5g', '1g', '2g'],
    products: [
      {
        gmPercent: 55,
        imageUrl: null,
        name: 'MFNY Resin AIO 0.5g',
        price: 40,
        productId: 501,
        shortName: 'Resin AIO 0.5g',
        sku: 'sku-501',
        tab: '0.5g',
        wholesaleCost: 16,
      },
      {
        gmPercent: 60,
        imageUrl: null,
        name: 'MFNY Resin AIO 1g',
        price: 65,
        productId: 502,
        shortName: 'Resin AIO 1g',
        sku: 'sku-502',
        tab: '1g',
        wholesaleCost: 23,
      },
      {
        gmPercent: 62,
        imageUrl: null,
        name: 'MFNY Resin AIO 2g',
        price: 95,
        productId: 503,
        shortName: 'Resin AIO 2g',
        sku: 'sku-503',
        tab: '2g',
        wholesaleCost: 31,
      },
    ],
    scents: [],
    strain: null,
    subcategory: 'All In One / Disposable',
    tags: [],
  }
}

describe('filterScopedProductsFromLiveState', () => {
  it('keeps only the scoped products and matching tabs for pricing generation', () => {
    const liveState = buildLiveState()

    const filtered = filterScopedProductsFromLiveState(liveState, [502, 999999])

    expect(filtered.products.map((product) => product.productId)).toEqual([502])
    expect(filtered.productTabs).toEqual(['1g'])
    expect(filtered.groupFullName).toBe(liveState.groupFullName)
  })

  it('leaves the live state untouched when there is no scoped product filter', () => {
    const liveState = buildLiveState()

    expect(filterScopedProductsFromLiveState(liveState)).toBe(liveState)
    expect(filterScopedProductsFromLiveState(liveState, [])).toBe(liveState)
  })
})
