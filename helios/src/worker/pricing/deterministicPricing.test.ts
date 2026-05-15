import { describe, expect, it } from 'vitest'

import { buildPricingPlan, type PricingMarketContext } from './deterministicPricing.js'
import type { PricingFamilyContext } from './familyPricing.js'
import type { NormalizedCatalogGroupLiveState } from '../catalog/liveState.js'

function buildLiveState(price: number | null): NormalizedCatalogGroupLiveState {
  return {
    brand: 'Pura',
    category: 'Vapes',
    currentDescription: '',
    effects: [],
    flavorings: [],
    groupFullName: 'Pura Roapz Live Rosin',
    groupId: 42,
    groupName: 'Roapz Live Rosin',
    imageUrl: null,
    productTabs: ['0.5g'],
    products: [
      {
        gmPercent: null,
        imageUrl: null,
        name: 'Pura Roapz Live Rosin 0.5g',
        price,
        productId: 501,
        shortName: 'Roapz Live Rosin 0.5g',
        sku: 'sku-1',
        tab: '0.5g',
        wholesaleCost: 18,
      },
    ],
    scents: [],
    strain: 'Roapz',
    subcategory: null,
    tags: [],
  }
}

describe('buildPricingPlan', () => {
  it('uses the 64.5% GM fallback target when no comparable market evidence exists', () => {
    const plan = buildPricingPlan(buildLiveState(null), null)

    expect(plan.generatedLineItems).toHaveLength(1)
    expect(plan.generatedLineItems[0]?.proposedPrice).toBe(57.25)
    expect(plan.generatedLineItems[0]?.priceReason).toContain('64.5% GM fallback target')
  })

  it('keeps in-band prices as explicit review rows instead of skipping them', () => {
    const plan = buildPricingPlan(buildLiveState(57.25), null)

    expect(plan.generatedLineItems).toHaveLength(1)
    expect(plan.generatedLineItems[0]?.action).toBe('keep-price')
    expect(plan.generatedLineItems[0]?.proposedPrice).toBe(57.25)
    expect(plan.skippedProducts).toHaveLength(0)
    expect(plan.generatedLineItems[0]?.priceReason).toContain('keeps the live price')
  })

  it('targets a few percent below market when Lit Alerts evidence fits the managed band', () => {
    const marketContext: PricingMarketContext = {
      availability: 'matched',
      note: 'matched',
      productEvidenceById: {
        501: {
          averagePostTaxPrice: 55,
          averagePreTaxPrice: 48.67,
          dispensaryCount: 4,
          farAveragePostTaxPrice: null,
          farAveragePreTaxPrice: null,
          farListingCount: 0,
          listingCount: 4,
          medianPostTaxPrice: 55,
          medianPreTaxPrice: 48.67,
          pricingEligibleDispensaryCount: 4,
          pricingEligibleListingCount: 4,
          matchedListings: [],
          searchTerm: 'Roapz',
          source: 'nearby',
        },
      },
      searchTerm: 'Roapz',
    }

    const plan = buildPricingPlan(buildLiveState(null), marketContext)
    expect(plan.generatedLineItems).toHaveLength(1)
    expect(plan.generatedLineItems[0]?.proposedPrice).toBe(53)
    expect(plan.generatedLineItems[0]?.priceReason).toContain('Near and mid public average')
  })

  it('uses far-only market pressure when near and mid comps are unavailable', () => {
    const marketContext: PricingMarketContext = {
      availability: 'display_only',
      note: 'display only',
      productEvidenceById: {
        501: {
          averagePostTaxPrice: null,
          averagePreTaxPrice: null,
          dispensaryCount: 2,
          farAveragePostTaxPrice: 61,
          farAveragePreTaxPrice: 53.98,
          farListingCount: 1,
          listingCount: 2,
          medianPostTaxPrice: null,
          medianPreTaxPrice: null,
          pricingEligibleDispensaryCount: 0,
          pricingEligibleListingCount: 0,
          matchedListings: [
            {
              category: 'Vapes',
              distanceBand: 'far',
              distanceMiles: 6.5,
              dispensaryName: 'Far Away Cannabis',
              eligibleForPricing: false,
              exclusionReason: 'Shown for context only because it sits outside the near/mid pricing radius.',
              listingName: 'Pura Roapz Live Rosin 0.5g',
              matchTier: 'exact',
              postTaxPrice: 61,
              preTaxPrice: 53.98,
              source: 'nearby',
              url: null,
            },
            {
              category: 'Vapes',
              distanceBand: 'very_far',
              distanceMiles: 29,
              dispensaryName: 'Albany Example',
              eligibleForPricing: false,
              exclusionReason: 'Shown for context only because it sits outside the near/mid pricing radius.',
              listingName: 'Pura Roapz Live Rosin 0.5g',
              matchTier: 'exact',
              postTaxPrice: 64,
              preTaxPrice: 56.64,
              source: 'statewide',
              url: null,
            },
          ],
          searchTerm: 'Roapz',
          source: 'mixed',
        },
      },
      searchTerm: 'Roapz',
    }

    const plan = buildPricingPlan(buildLiveState(null), marketContext)

    expect(plan.generatedLineItems).toHaveLength(1)
    expect(plan.generatedLineItems[0]?.proposedPrice).toBe(58)
    expect(plan.generatedLineItems[0]?.priceReason).toContain('far-only market pressure')
  })

  it('still falls back to the managed GM target when only very-far listings exist', () => {
    const marketContext: PricingMarketContext = {
      availability: 'display_only',
      note: 'display only',
      productEvidenceById: {
        501: {
          averagePostTaxPrice: null,
          averagePreTaxPrice: null,
          dispensaryCount: 1,
          farAveragePostTaxPrice: null,
          farAveragePreTaxPrice: null,
          farListingCount: 0,
          listingCount: 1,
          medianPostTaxPrice: null,
          medianPreTaxPrice: null,
          pricingEligibleDispensaryCount: 0,
          pricingEligibleListingCount: 0,
          matchedListings: [
            {
              category: 'Vapes',
              distanceBand: 'very_far',
              distanceMiles: 29,
              dispensaryName: 'Albany Example',
              eligibleForPricing: false,
              exclusionReason: 'Shown for context only because it sits outside the near/mid pricing radius.',
              listingName: 'Pura Roapz Live Rosin 0.5g',
              matchTier: 'exact',
              postTaxPrice: 64,
              preTaxPrice: 56.64,
              source: 'statewide',
              url: null,
            },
          ],
          searchTerm: 'Roapz',
          source: 'statewide',
        },
      },
      searchTerm: 'Roapz',
    }

    const plan = buildPricingPlan(buildLiveState(null), marketContext)

    expect(plan.generatedLineItems).toHaveLength(1)
    expect(plan.generatedLineItems[0]?.proposedPrice).toBe(57.25)
    expect(plan.generatedLineItems[0]?.priceReason).toContain('ignores those long-distance comps')
  })

  it('uses family pricing when market evidence is unavailable and the brand allows same-lane anchors', () => {
    const familyContext: PricingFamilyContext = {
      note: 'Family anchor inferred from live sibling pricing.',
      preference: 'allow',
      productEvidenceById: {
        501: {
          anchorPrice: 45.5,
          candidateCount: 3,
          laneLabel: 'cartridge live rosin · 0.5g',
          note: 'Three same-lane rows already sit at $45.50.',
          sourceGroupId: 44,
          sourceGroupName: 'Blue Burst Live Rosin',
          sourceProductId: 611,
          sourceProductName: 'Pura Blue Burst Live Rosin 0.5g',
          sourceTab: '0.5g',
        },
      },
    }

    const plan = buildPricingPlan(buildLiveState(null), null, familyContext)

    expect(plan.generatedLineItems).toHaveLength(1)
    expect(plan.generatedLineItems[0]?.proposedPrice).toBe(45.5)
    expect(plan.generatedLineItems[0]?.priceReason).toContain('reuses current live family pricing')
  })
})
