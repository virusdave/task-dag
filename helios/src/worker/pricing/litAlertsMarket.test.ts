import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../config/env.js', () => ({
  getWorkerEnv: () => ({
    bedrockMantleBaseUrl: 'https://mantle.example.test/v1',
    bedrockMantleBearerToken: null,
    databaseUrl: 'postgres://example',
    llmRequestTimeoutMs: 500,
    litAlertsApiUrl: 'https://litalerts.example.test',
    litAlertsBearerToken: 'lit-token',
    litAlertsMidtownDispensaryIds: [],
    litAlertsRequestTimeoutMs: 500,
    litAlertsStateCode: 'NY',
    litAlertsStateId: 265,
    pollIntervalMs: 1000,
    sweedApiUrl: 'https://sweed.example.test/api/',
    sweedAuthToken: 'sweed-token',
    sweedRequestTimeoutMs: 500,
    sweedStateDealerId: 210248,
    workerMaxAttempts: 5,
    workerMaxConcurrentJobs: 1,
    workerRetryBaseDelayMs: 1000,
  }),
}))

vi.mock('../runtime/pageDave.js', () => ({
  pageDave: vi.fn(),
}))

vi.mock('../litalerts/partnerClient.js', () => ({
  hasPartnerApiToken: vi.fn(() => true),
  listBrandsForState: vi.fn(),
  listBrandProducts: vi.fn(),
  listRetailers: vi.fn(),
  listRetailerProducts: vi.fn(),
}))

import type { NormalizedCatalogGroupLiveState } from '../catalog/liveState.js'
import {
  hasPartnerApiToken,
  listBrandProducts,
  listBrandsForState,
  listRetailers,
  type LitAlertsBrand,
  type LitAlertsProduct,
  type LitAlertsRetailer,
} from '../litalerts/partnerClient.js'
import { RetryableWorkerError } from '../runtime/errors.js'
import { pageDave } from '../runtime/pageDave.js'
import {
  __test__,
  buildAveragePrice,
  buildMedianPrice,
  buildPricingMarketContext,
  buildPricingMarketContextWithFailureHandling,
  buildWeightedAveragePrice,
  classifyPricingDistanceBand,
  deriveSearchTerms,
  resetPricingMarketCachesForTest,
} from './litAlertsMarket.js'

const pageDaveMock = vi.mocked(pageDave)
const hasPartnerApiTokenMock = vi.mocked(hasPartnerApiToken)
const listBrandsForStateMock = vi.mocked(listBrandsForState)
const listBrandProductsMock = vi.mocked(listBrandProducts)
const listRetailersMock = vi.mocked(listRetailers)

const SAMPLE_LIVE_STATE: NormalizedCatalogGroupLiveState = {
  brand: 'Ayrloom',
  category: 'Edibles',
  currentDescription: '',
  effects: [],
  flavorings: [],
  groupFullName: 'Ayrloom Black Cherry 1:1 (5mg THC : 5mg CBD) 5mg',
  groupId: 101,
  groupName: 'Ayrloom Black Cherry 1:1 (5mg THC : 5mg CBD) 5mg',
  imageUrl: null,
  productTabs: ['5mg'],
  products: [
    {
      gmPercent: 60,
      imageUrl: null,
      name: 'Ayrloom Black Cherry 1:1 (5mg THC : 5mg CBD) 5mg',
      price: 30,
      productId: 2001,
      shortName: null,
      sku: null,
      tab: '5mg',
      wholesaleCost: 10,
    },
  ],
  scents: [],
  strain: null,
  subcategory: 'Gummies',
  tags: [],
}

const AYRLOOM_BRAND: LitAlertsBrand = {
  id: 42,
  name: 'Ayrloom',
  states: ['NY'],
}

const RETAILERS: LitAlertsRetailer[] = [
  { id: 1001, name: 'Downtown Dispensary', address: '1 Main St', medical: false, recreational: true },
  { id: 1002, name: 'Uptown Cannabis', address: '2 Park Ave', medical: false, recreational: true },
  { id: 1003, name: 'Borough Buds', address: '3 Bridge Rd', medical: false, recreational: true },
]

function buildBrandProduct(input: {
  configs?: Array<{ amount?: number | string | null; normalPrice?: number | string | null; salePrice?: number | string | null; units?: string | null }>
  id: number
  name: string
  retailerId: number
}): LitAlertsProduct {
  return {
    id: input.id,
    name: input.name,
    brand: 'Ayrloom',
    brandId: 42,
    retailerId: input.retailerId,
    medicalURL: null,
    recreationalURL: `https://example.com/listing/${input.id}`,
    category: 'Edibles',
    configs: (input.configs ?? [{ amount: 5, units: 'mg', normalPrice: 30, salePrice: null }]).map((config) => ({
      amount: config.amount ?? null,
      units: config.units ?? null,
      recreational: true,
      medical: false,
      normalPrice: config.normalPrice ?? null,
      salePrice: config.salePrice ?? null,
      currentStock: 10,
    })),
  }
}

beforeEach(() => {
  resetPricingMarketCachesForTest()
  pageDaveMock.mockReset()
  hasPartnerApiTokenMock.mockReset()
  hasPartnerApiTokenMock.mockReturnValue(true)
  listBrandsForStateMock.mockReset()
  listBrandsForStateMock.mockResolvedValue([AYRLOOM_BRAND])
  listBrandProductsMock.mockReset()
  listBrandProductsMock.mockResolvedValue([])
  listRetailersMock.mockReset()
  listRetailersMock.mockResolvedValue(RETAILERS)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('classifyPricingDistanceBand', () => {
  it('uses the near, mid, far, and very-far buckets requested for pricing', () => {
    expect(classifyPricingDistanceBand(0.8)).toBe('near')
    expect(classifyPricingDistanceBand(2.2)).toBe('mid')
    expect(classifyPricingDistanceBand(7.4)).toBe('far')
    expect(classifyPricingDistanceBand(14.2)).toBe('very_far')
    expect(classifyPricingDistanceBand(null)).toBe('unknown')
  })
})

describe('buildWeightedAveragePrice', () => {
  it('weights near listings much more heavily than mid listings and ignores farther bands', () => {
    const weightedAverage = buildWeightedAveragePrice([
      {
        distanceBand: 'near',
        postTaxPrice: 40,
        preTaxPrice: 35.4,
      },
      {
        distanceBand: 'mid',
        postTaxPrice: 60,
        preTaxPrice: 53.1,
      },
      {
        distanceBand: 'far',
        postTaxPrice: 90,
        preTaxPrice: 79.65,
      },
    ])

    expect(weightedAverage).toEqual({ postTaxPrice: 43.33, preTaxPrice: 38.35 })
  })
})

describe('buildAveragePrice', () => {
  it('averages simple far-only market pressure rows', () => {
    expect(buildAveragePrice([
      { postTaxPrice: 48, preTaxPrice: 42.48 },
      { postTaxPrice: 54, preTaxPrice: 47.79 },
      { postTaxPrice: 60, preTaxPrice: 53.1 },
    ])).toEqual({ postTaxPrice: 54, preTaxPrice: 47.79 })
  })
})

describe('buildMedianPrice', () => {
  it('returns the near/mid median across pricing-eligible comps', () => {
    expect(buildMedianPrice([
      { postTaxPrice: 42, preTaxPrice: 37.17 },
      { postTaxPrice: 48, preTaxPrice: 42.48 },
      { postTaxPrice: 64, preTaxPrice: 56.64 },
      { postTaxPrice: 70, preTaxPrice: 61.95 },
    ])).toEqual({ postTaxPrice: 56, preTaxPrice: 49.56 })
  })
})

describe('deriveSearchTerms', () => {
  it('prioritizes stripped family variants when names contain bespoke potency annotations', () => {
    const searchTerms = deriveSearchTerms(SAMPLE_LIVE_STATE)

    expect(searchTerms.slice(0, 4)).toEqual([
      'Black Cherry 5mg',
      'Black Cherry',
      'Black',
      'Cherry',
    ])
    expect(searchTerms).toContain('Black Cherry 1:1 (5mg THC : 5mg CBD) 5mg')
  })
})

describe('pricing comp match prioritization', () => {
  it('prefers exact concentrate-format matches over weaker cross-format listings', () => {
    const productProfile = {
      laneKey: __test__.inferComparableLaneKey({
        category: 'Concentrates',
        subcategory: 'Diamonds',
        text: 'MFNY Diamond Jetpack 1g',
      }),
      size: { measure: 'g' as const, packCount: 1, totalValue: 1, unitValue: 1 },
    }

    const exactAssessment = __test__.assessListingForProduct(productProfile, {
      availability: null,
      category: 'Concentrates',
      distanceBand: 'unknown',
      distanceMiles: null,
      dispensaryName: 'Exact Shop',
      listingName: 'MFNY Diamond Jetpack 1g',
      postTaxPrice: 45,
      preTaxPrice: 39.82,
      size: { measure: 'g', packCount: 1, totalValue: 1, unitValue: 1 },
      source: 'statewide',
      url: null,
    })
    const weakAssessment = __test__.assessListingForProduct(productProfile, {
      availability: null,
      category: 'Concentrates',
      distanceBand: 'unknown',
      distanceMiles: null,
      dispensaryName: 'Weak Shop',
      listingName: 'MFNY Badder 1g',
      postTaxPrice: 38,
      preTaxPrice: 33.63,
      size: { measure: 'g', packCount: 1, totalValue: 1, unitValue: 1 },
      source: 'statewide',
      url: null,
    })

    expect(exactAssessment.laneTier).toBe(3)
    expect(exactAssessment.matchTier).toBe('exact')
    expect(weakAssessment.laneTier).toBe(1)
    expect(weakAssessment.matchTier).toBe('weak')
  })

  it('treats exact size matches as stronger than mismatched multipacks', () => {
    const exactSizeTier = __test__.classifySizeTier(
      { measure: 'g', packCount: 1, totalValue: 1, unitValue: 1 },
      { measure: 'g', packCount: 1, totalValue: 1, unitValue: 1 },
    )
    const mismatchedPackTier = __test__.classifySizeTier(
      { measure: 'g', packCount: 1, totalValue: 1, unitValue: 1 },
      { measure: 'g', packCount: 2, totalValue: 1, unitValue: 0.5 },
    )

    expect(exactSizeTier).toBe(3)
    expect(mismatchedPackTier).toBe(0)
  })
})

describe('buildPricingMarketContext (partner API integration)', () => {
  it('returns availability=disabled when no partner API token is configured', async () => {
    hasPartnerApiTokenMock.mockReturnValue(false)

    const context = await buildPricingMarketContext(SAMPLE_LIVE_STATE)

    expect(context.availability).toBe('disabled')
    expect(listBrandsForStateMock).not.toHaveBeenCalled()
  })

  it('returns availability=no_brand when the live group has no brand', async () => {
    const liveState = { ...SAMPLE_LIVE_STATE, brand: null }

    const context = await buildPricingMarketContext(liveState)

    expect(context.availability).toBe('no_brand')
    expect(listBrandsForStateMock).not.toHaveBeenCalled()
  })

  it('returns availability=unresolved_brand when no partner brand matches', async () => {
    listBrandsForStateMock.mockResolvedValue([
      { id: 9, name: 'Totally Different Brand', states: ['NY'] },
    ])

    const context = await buildPricingMarketContext(SAMPLE_LIVE_STATE)

    expect(context.availability).toBe('unresolved_brand')
    expect(listBrandProductsMock).not.toHaveBeenCalled()
  })

  it('builds market evidence from exact partner-product matches', async () => {
    listBrandProductsMock.mockResolvedValue([
      buildBrandProduct({
        id: 5001,
        name: 'Ayrloom Black Cherry 1:1 5mg',
        retailerId: 1001,
        configs: [{ amount: 5, units: 'mg', normalPrice: 30 }],
      }),
      buildBrandProduct({
        id: 5002,
        name: 'Ayrloom Black Cherry 1:1 5mg',
        retailerId: 1002,
        configs: [{ amount: 5, units: 'mg', normalPrice: 32, salePrice: 28 }],
      }),
      buildBrandProduct({
        id: 5003,
        name: 'Ayrloom Sour Apple 1:1 5mg',
        retailerId: 1003,
        configs: [{ amount: 5, units: 'mg', normalPrice: 31 }],
      }),
    ])

    const context = await buildPricingMarketContext(SAMPLE_LIVE_STATE)

    expect(context.availability).toBe('display_only')
    expect(context.searchTerm).toContain('Black Cherry')
    const evidence = context.productEvidenceById[2001]
    expect(evidence).toBeDefined()
    expect(evidence?.listingCount).toBeGreaterThanOrEqual(2)
    expect(evidence?.matchedListings.some((l) => l.listingName.includes('Black Cherry'))).toBe(true)
    expect(evidence?.matchedListings.some((l) => l.listingName.includes('Sour Apple'))).toBe(false)
    expect(listBrandProductsMock).toHaveBeenCalledWith(42, 'NY')
    expect(listRetailersMock).toHaveBeenCalledWith('NY')
  })

  it('falls back to a parenthetical-stripped brand alias when the exact key fails', async () => {
    const liveState = { ...SAMPLE_LIVE_STATE, brand: 'Camino' }
    listBrandsForStateMock.mockResolvedValue([
      { id: 77, name: 'Camino Kiva', states: ['NY'] },
    ])
    listBrandProductsMock.mockResolvedValue([
      buildBrandProduct({
        id: 6001,
        name: 'Camino Black Cherry 5mg',
        retailerId: 1001,
        configs: [{ amount: 5, units: 'mg', normalPrice: 30 }],
      }),
    ])

    const context = await buildPricingMarketContext(liveState)

    // Alias map resolves 'camino' -> 'camino kiva'; verify products were fetched
    expect(listBrandProductsMock).toHaveBeenCalledWith(77, 'NY')
    expect(context.availability).not.toBe('unresolved_brand')
  })

  it('returns availability=no_family_matches when no partner products match any search term', async () => {
    listBrandProductsMock.mockResolvedValue([
      buildBrandProduct({
        id: 7001,
        name: 'Ayrloom Sour Apple 1:1 5mg',
        retailerId: 1001,
        configs: [{ amount: 5, units: 'mg', normalPrice: 30 }],
      }),
    ])

    const context = await buildPricingMarketContext(SAMPLE_LIVE_STATE)

    expect(context.availability).toBe('no_family_matches')
    expect(context.productEvidenceById).toEqual({})
  })

  it('marks every partner-API listing with distanceBand=unknown and distanceMiles=null', async () => {
    listBrandProductsMock.mockResolvedValue([
      buildBrandProduct({
        id: 8001,
        name: 'Ayrloom Black Cherry 5mg',
        retailerId: 1001,
        configs: [{ amount: 5, units: 'mg', normalPrice: 30 }],
      }),
      buildBrandProduct({
        id: 8002,
        name: 'Ayrloom Black Cherry 5mg',
        retailerId: 1002,
        configs: [{ amount: 5, units: 'mg', normalPrice: 32 }],
      }),
    ])

    const context = await buildPricingMarketContext(SAMPLE_LIVE_STATE)

    const evidence = context.productEvidenceById[2001]
    expect(evidence?.matchedListings.length).toBeGreaterThan(0)
    for (const listing of evidence?.matchedListings ?? []) {
      expect(listing.distanceBand).toBe('unknown')
      expect(listing.distanceMiles).toBeNull()
    }
    // Because no listing lands inside the near/mid radius, all matches are
    // surfaced as display-only evidence — never as pricing-eligible comps.
    expect(evidence?.pricingEligibleListingCount).toBe(0)
    expect(context.availability).toBe('display_only')
  })
})

describe('buildPricingMarketContextWithFailureHandling', () => {
  it('pages Dave and rethrows when the partner client raises a RetryableWorkerError', async () => {
    listBrandsForStateMock.mockRejectedValue(new RetryableWorkerError('partner API exploded'))

    await expect(
      buildPricingMarketContextWithFailureHandling({
        failureContext: 'Packet generation failed',
        liveState: SAMPLE_LIVE_STATE,
        shouldPageOnFailure: () => true,
      }),
    ).rejects.toThrow(/partner API exploded/)

    expect(pageDaveMock).toHaveBeenCalledTimes(1)
    expect(pageDaveMock.mock.calls[0]?.[0]).toContain('Packet generation failed: pricing market research failed for Ayrloom')
  })
})
