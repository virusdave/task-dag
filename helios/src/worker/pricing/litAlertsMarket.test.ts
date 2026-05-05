import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../config/env.js', () => ({
  getWorkerEnv: () => ({
    bedrockMantleBaseUrl: 'https://mantle.example.test/v1',
    bedrockMantleBearerToken: 'mantle-token',
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

import type { NormalizedCatalogGroupLiveState } from '../catalog/liveState.js'
import { pageDave } from '../runtime/pageDave.js'
import {
  __test__,
  buildAveragePrice,
  buildMedianPrice,
  buildPricingMarketContextWithFailureHandling,
  buildWeightedAveragePrice,
  classifyPricingDistanceBand,
  deriveSearchTerms,
  parseMenuListingsResponse,
  resetPricingMarketCachesForTest,
} from './litAlertsMarket.js'

const pageDaveMock = vi.mocked(pageDave)

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

beforeEach(() => {
  resetPricingMarketCachesForTest()
  pageDaveMock.mockReset()
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
        availability: 'Rec',
        category: 'Vapes',
        distanceBand: 'near',
        distanceMiles: 0.6,
        dispensaryName: 'Near Shop',
        listingName: 'Example 0.5g',
        postTaxPrice: 40,
        preTaxPrice: 35.4,
        size: { measure: 'g', packCount: 1, totalValue: 0.5, unitValue: 0.5 },
        source: 'nearby',
        url: null,
      },
      {
        availability: 'Rec',
        category: 'Vapes',
        distanceBand: 'mid',
        distanceMiles: 2.6,
        dispensaryName: 'Mid Shop',
        listingName: 'Example 0.5g',
        postTaxPrice: 60,
        preTaxPrice: 53.1,
        size: { measure: 'g', packCount: 1, totalValue: 0.5, unitValue: 0.5 },
        source: 'nearby',
        url: null,
      },
      {
        availability: 'Rec',
        category: 'Vapes',
        distanceBand: 'far',
        distanceMiles: 8.1,
        dispensaryName: 'Far Shop',
        listingName: 'Example 0.5g',
        postTaxPrice: 90,
        preTaxPrice: 79.65,
        size: { measure: 'g', packCount: 1, totalValue: 0.5, unitValue: 0.5 },
        source: 'nearby',
        url: null,
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

describe('parseMenuListingsResponse', () => {
  it('accepts numeric availability values from live Lit Alerts menu listings', () => {
    const parsed = parseMenuListingsResponse({
      listings: [
        {
          availability: 1,
          brand: 'Fernway',
          category: 'Vaporizers',
          configs: [
            {
              price: 35,
              weight: '0.5g (500mg)',
            },
          ],
          dispensaryName: 'Example Shop',
          name: 'Fernway Stylus Pod 0.5g',
          url: 'https://example.com/listing',
        },
      ],
    })

    expect(parsed.listings).toHaveLength(1)
    expect(parsed.listings[0]?.availability).toBe(1)
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
      availability: 'Rec',
      category: 'Concentrates',
      distanceBand: 'near',
      distanceMiles: 0.7,
      dispensaryName: 'Exact Shop',
      listingName: 'MFNY Diamond Jetpack 1g',
      postTaxPrice: 45,
      preTaxPrice: 39.82,
      size: { measure: 'g', packCount: 1, totalValue: 1, unitValue: 1 },
      source: 'nearby',
      url: null,
    })
    const weakAssessment = __test__.assessListingForProduct(productProfile, {
      availability: 'Rec',
      category: 'Concentrates',
      distanceBand: 'near',
      distanceMiles: 0.9,
      dispensaryName: 'Weak Shop',
      listingName: 'MFNY Badder 1g',
      postTaxPrice: 38,
      preTaxPrice: 33.63,
      size: { measure: 'g', packCount: 1, totalValue: 1, unitValue: 1 },
      source: 'nearby',
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

describe('buildPricingMarketContextWithFailureHandling', () => {
  it('retries retryable Lit Alerts failures, pages, and rethrows', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('The operation was aborted due to timeout'))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: Parameters<typeof setTimeout>[0]) => {
      if (typeof handler === 'function') {
        handler()
      }
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)

    await expect(
      buildPricingMarketContextWithFailureHandling({
        failureContext: 'Packet generation failed',
        liveState: SAMPLE_LIVE_STATE,
        shouldPageOnFailure: () => true,
      }),
    ).rejects.toThrow(/Lit Alerts \/Manufacturers\/real\?page=0&pagesize=2000&state=NY transport failed: The operation was aborted due to timeout/)

    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(pageDaveMock).toHaveBeenCalledTimes(1)
    expect(pageDaveMock.mock.calls[0]?.[0]).toContain('Packet generation failed: pricing market research failed for Ayrloom')
  })
})
