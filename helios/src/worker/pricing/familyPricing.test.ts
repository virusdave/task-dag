import { describe, expect, it } from 'vitest'

import type { NormalizedCatalogGroupLiveState } from '../catalog/liveState.js'
import { derivePricingFamilyContext } from './familyPricing.js'

function buildLiveState(input: {
  brand?: string
  category?: string
  groupFullName?: string
  groupName?: string
  prices: Array<{ name: string; price: number | null; productId: number; tab: string; wholesaleCost?: number | null }>
  subcategory?: string | null
}): NormalizedCatalogGroupLiveState {
  return {
    brand: input.brand ?? 'Pura',
    category: input.category ?? 'Vapes',
    currentDescription: '',
    effects: [],
    flavorings: [],
    groupFullName: input.groupFullName ?? 'Pura Roapz Live Rosin',
    groupId: 42,
    groupName: input.groupName ?? 'Roapz Live Rosin',
    imageUrl: null,
    productTabs: input.prices.map((price) => price.tab),
    products: input.prices.map((price) => ({
      gmPercent: null,
      imageUrl: null,
      name: price.name,
      price: price.price,
      productId: price.productId,
      shortName: price.name,
      sku: `sku-${price.productId}`,
      tab: price.tab,
      wholesaleCost: price.wholesaleCost ?? 18,
    })),
    scents: [],
    strain: 'Roapz',
    subcategory: input.subcategory ?? 'Cartridge',
    tags: [],
  }
}

describe('derivePricingFamilyContext', () => {
  it('infers a reusable same-brand family anchor from aligned live pricing', () => {
    const liveState = buildLiveState({
      prices: [{ name: 'Pura Roapz Live Rosin 0.5g', price: null, productId: 501, tab: '0.5g' }],
    })

    const familyContext = derivePricingFamilyContext(liveState, [
      {
        groupId: 101,
        groupName: 'Blue Burst Live Rosin',
        liveState: buildLiveState({
          groupFullName: 'Pura Blue Burst Live Rosin',
          groupName: 'Blue Burst Live Rosin',
          prices: [{ name: 'Pura Blue Burst Live Rosin 0.5g', price: 45.5, productId: 601, tab: '0.5g' }],
        }),
      },
      {
        groupId: 102,
        groupName: 'Cherry Haze Live Rosin',
        liveState: buildLiveState({
          groupFullName: 'Pura Cherry Haze Live Rosin',
          groupName: 'Cherry Haze Live Rosin',
          prices: [{ name: 'Pura Cherry Haze Live Rosin 0.5g', price: 45.5, productId: 602, tab: '0.5g' }],
        }),
      },
    ])

    expect(familyContext.preference).toBe('allow')
    expect(familyContext.productEvidenceById[501]?.anchorPrice).toBe(45.5)
    expect(familyContext.productEvidenceById[501]?.candidateCount).toBe(2)
  })

  it('respects explicit non-family brands even when live lanes are aligned', () => {
    const liveState = buildLiveState({
      brand: 'Dank',
      groupFullName: 'Dank Sour Tangie',
      groupName: 'Sour Tangie',
      prices: [{ name: 'Dank Sour Tangie 0.6g', price: null, productId: 701, tab: '0.6g' }],
      subcategory: 'Infused Pre-Roll',
    })

    const familyContext = derivePricingFamilyContext(liveState, [
      {
        groupId: 103,
        groupName: 'White Widow',
        liveState: buildLiveState({
          brand: 'Dank',
          category: 'Pre-Rolls',
          groupFullName: 'Dank White Widow',
          groupName: 'White Widow',
          prices: [{ name: 'Dank White Widow 0.6g', price: 14, productId: 702, tab: '0.6g' }],
          subcategory: 'Infused Pre-Roll',
        }),
      },
      {
        groupId: 104,
        groupName: 'Pina Colada',
        liveState: buildLiveState({
          brand: 'Dank',
          category: 'Pre-Rolls',
          groupFullName: 'Dank Pina Colada',
          groupName: 'Pina Colada',
          prices: [{ name: 'Dank Pina Colada 0.6g', price: 14, productId: 703, tab: '0.6g' }],
          subcategory: 'Infused Pre-Roll',
        }),
      },
    ])

    expect(familyContext.preference).toBe('deny')
    expect(familyContext.productEvidenceById[701]).toBeUndefined()
    expect(familyContext.note).toContain('explicitly excluded')
  })
})
