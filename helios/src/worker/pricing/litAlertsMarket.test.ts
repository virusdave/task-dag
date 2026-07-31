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

// Tests must never reach a real database (canon: no prod serving
// resources in tests). Both the brand-override lookup
// (loadBrandOverrideForCatalogName) and the retailer nearest-store map
// (loadRetailerNearestStoreMap) go through getPool(); without this mock
// they hit the live DB, which "passes" only on the prod host and throws
// in CI. Returning an empty result set keeps brand resolution on its
// heuristic path and yields an empty distance map, which matches these
// fixtures' synthetic retailer ids (distanceBand=unknown).
//
// The retailer-distance rows are injectable (default empty) so the
// geographic-bounding tests below (T3) can place synthetic retailers in
// the near/mid/far/very-far bands. `vi.hoisted` is required because the
// `vi.mock` factory is hoisted above ordinary declarations, so a plain
// module-level `let` would be undefined at factory-eval time. The mock
// dispatches on the SQL text: the distance-map query selects from
// `litalerts_retailer_locations`; every other query (brand overrides,
// cache fallback) keeps the empty default, so all pre-existing tests are
// byte-for-byte unaffected.
const dbFixture = vi.hoisted(() => ({
  retailerDistanceRows: [] as Array<{
    miles: number
    nearest_store_key: string
    retailer_id: string
  }>,
}))

vi.mock('../../server/db/pool.js', () => ({
  getPool: () => ({
    query: async (sql: string): Promise<{ rows: unknown[] }> => {
      if (typeof sql === 'string' && sql.includes('litalerts_retailer_locations')) {
        return { rows: dbFixture.retailerDistanceRows }
      }
      return { rows: [] }
    },
  }),
}))

import type { NormalizedCatalogGroupLiveState } from '../catalog/liveState.js'
import { assessParseReasonableness } from '../llm/parseReasonableness.js'
import {
  hasPartnerApiToken,
  listBrandProducts,
  listBrandsForState,
  listRetailerProducts,
  listRetailers,
  type LitAlertsBrand,
  type LitAlertsProduct,
  type LitAlertsRetailer,
} from '../litalerts/partnerClient.js'
import { RetryableWorkerError } from '../runtime/errors.js'
import { pageDave } from '../runtime/pageDave.js'
import {
  PRICING_MID_DISTANCE_MAX_MILES,
  PRICING_MID_DISTANCE_WEIGHT,
  PRICING_NEAR_DISTANCE_WEIGHT,
  PRICING_POST_TAX_MULTIPLIER,
} from '../../shared/domain/pricingGeneration.js'
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
  selectNearbyRetailersForFanout,
  type RetailerDirectoryEntry,
} from './litAlertsMarket.js'

const pageDaveMock = vi.mocked(pageDave)
const hasPartnerApiTokenMock = vi.mocked(hasPartnerApiToken)
const listBrandProductsMock = vi.mocked(listBrandProducts)
const listBrandsForStateMock = vi.mocked(listBrandsForState)
const listRetailerProductsMock = vi.mocked(listRetailerProducts)
const listRetailersMock = vi.mocked(listRetailers)

/**
 * The live evidence path now fans out across the nearest retailers and pulls
 * each one's brand-filtered menu via `listRetailerProducts`. The test fixtures
 * use synthetic retailer ids (1001–1003) that aren't in the geocoded distance
 * table, so they all fall under the nearest-N cap and get queried. This helper
 * routes the full product set to the right retailer based on `retailerId`.
 */
function mockNearbyRetailerProducts(products: LitAlertsProduct[]): void {
  listRetailerProductsMock.mockImplementation(async (retailerId: number) =>
    products.filter((product) => product.retailerId === retailerId),
  )
}

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
  dbFixture.retailerDistanceRows = []
  pageDaveMock.mockReset()
  hasPartnerApiTokenMock.mockReset()
  hasPartnerApiTokenMock.mockReturnValue(true)
  listBrandProductsMock.mockReset()
  listBrandsForStateMock.mockReset()
  listBrandsForStateMock.mockResolvedValue([AYRLOOM_BRAND])
  listRetailerProductsMock.mockReset()
  listRetailerProductsMock.mockResolvedValue([])
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

  it('matches an infused-preroll catalog group (subcategory "Infused") against a bare listing lane', () => {
    // Regression: catalog groups carry a subcategory ("Infused") but
    // LitAlerts listings always come in with subcategory=null. The
    // preroll lane key must collapse to "infused" on both sides, or
    // every nearby Baby Jeeter comp gets stuck in the weak lane.
    const productProfile = {
      laneKey: __test__.inferComparableLaneKey({
        category: 'Pre-Rolls',
        subcategory: 'Infused',
        text: 'Jeeter Baby Jeeter Infused Acapulco Gold 5x 2.5g',
      }),
      size: { measure: 'g' as const, packCount: 5, totalValue: 2.5, unitValue: 0.5 },
    }

    expect(productProfile.laneKey).toBe('infused')

    const assessment = __test__.assessListingForProduct(productProfile, {
      availability: null,
      category: 'Pre-Rolls',
      distanceBand: 'near',
      distanceMiles: 1,
      dispensaryName: 'Herbwell Cannabis - Bronx',
      listingName: 'Skywalker OG Quad-Infused Baby Jeeter 5-pack | 2.5g',
      postTaxPrice: 54.24,
      preTaxPrice: 48,
      size: { measure: 'g', packCount: 5, totalValue: 2.5, unitValue: 0.5 },
      source: 'nearby',
      url: null,
    })

    expect(assessment.laneTier).toBe(3)
    expect(assessment.sizeTier).toBe(3)
    expect(assessment.matchTier).toBe('exact')
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

describe('catalog size profile (structured Sweed fields + brand convention)', () => {
  it('reads Jeeter "5x 2.5g" via packOfSize + sizeName as a package TOTAL', () => {
    // Real Sweed shape: sizeName="2.5g" (the TOTAL for Baby Jeeter), packOfSize=5.
    const ours = __test__.resolveCatalogSizeProfile({
      name: 'Jeeter Baby Jeeter Infused Acapulco Gold 5x 2.5g',
      tab: '5x 2.5g',
      sizeName: '2.5g',
      packOfSize: 5,
      brand: 'Jeeter',
    })
    expect(ours).toEqual({ measure: 'g', packCount: 5, totalValue: 2.5, unitValue: 0.5 })
  })

  it('treats sizeName as per-unit for default brands (real Sweed shape)', () => {
    // Real Sweed shape: "Dank ... 7x 0.5g" -> sizeName="0.5g" is per-stick, packOfSize=7.
    const dank = __test__.resolveCatalogSizeProfile({
      name: 'Dank Girl Scout Cookies 7x 0.5g',
      tab: '7x 0.5g',
      sizeName: '0.5g',
      packOfSize: 7,
      brand: 'Dank',
    })
    expect(dank).toEqual({ measure: 'g', packCount: 7, totalValue: 3.5, unitValue: 0.5 })
  })

  it('keeps default mg-edible semantics for Jeeter (grams-only convention guard)', () => {
    const jeeterEdible = __test__.resolveCatalogSizeProfile({
      name: 'Jeeter Gummies 10x 10mg',
      tab: '10x 10mg',
      sizeName: '10mg',
      packOfSize: 10,
      brand: 'Jeeter',
    })
    expect(jeeterEdible).toEqual({ measure: 'mg', packCount: 10, totalValue: 100, unitValue: 10 })
  })

  it('falls back to free-text name parsing when structured fields are missing', () => {
    const ours = __test__.resolveCatalogSizeProfile({
      name: 'Jeeter Baby Jeeter Acapulco Gold 5x 2.5g',
      tab: '',
      sizeName: null,
      packOfSize: null,
      brand: 'Jeeter',
    })
    expect(ours).toEqual({ measure: 'g', packCount: 5, totalValue: 2.5, unitValue: 0.5 })
  })
})

describe('listing size profile (structured LitAlerts amount/units)', () => {
  it('trusts LitAlerts amount as the package TOTAL and derives per-unit from the name', () => {
    // Real LitAlerts shape: name says ".5g" per-stick but amount=2.5g is the TOTAL.
    const comp = __test__.resolveListingSizeProfile({
      listingName: '*Limited Edition* American Pl (Baby) | .5g | Quad Infused | 5pk',
      amount: '2.5',
      units: 'g',
      brand: 'Jeeter',
    })
    expect(comp).toEqual({ measure: 'g', packCount: 5, totalValue: 2.5, unitValue: 0.5 })
  })

  it('converts oz totals to grams (e.g. 7-pack reported as 0.125 oz)', () => {
    const comp = __test__.resolveListingSizeProfile({
      listingName: 'Face Melters - Pre-Roll 7 Pack (3.5g)',
      amount: 0.125,
      units: 'oz',
      brand: 'Face Melters',
    })
    expect(comp.measure).toBe('g')
    expect(comp.packCount).toBe(7)
    expect(comp.totalValue).toBeCloseTo(3.54, 1)
    expect(comp.unitValue).toBeCloseTo(0.51, 1)
  })

  it('falls back to name parsing when units are junk (non-weight)', () => {
    // LitAlerts emits e.g. units="packtransdermalpatches" / "mg (pack of 40)".
    const comp = __test__.resolveListingSizeProfile({
      listingName: 'Acme Preroll 5pk 3.5g',
      amount: '3',
      units: 'packtransdermalpatches',
      brand: 'Acme',
    })
    // Default fallback: "5pk 3.5g" -> 3.5g total, 0.7g/unit.
    expect(comp).toEqual({ measure: 'g', packCount: 5, totalValue: 3.5, unitValue: 0.7 })
  })

  it('falls back to name + Jeeter convention when amount is missing', () => {
    const comp = __test__.resolveListingSizeProfile({
      listingName: 'Acapulco Gold Infused 5pk .5g',
      amount: null,
      units: null,
      brand: 'Jeeter',
    })
    expect(comp).toEqual({ measure: 'g', packCount: 5, totalValue: 2.5, unitValue: 0.5 })
  })
})

describe('per-brand size-labelling conventions', () => {
  it('makes the Jeeter SKU and competitor listing score as an exact size match', () => {
    const ours = __test__.resolveCatalogSizeProfile({
      name: 'Jeeter Baby Jeeter Acapulco Gold 5x 2.5g',
      tab: '5x 2.5g',
      sizeName: '2.5g',
      packOfSize: 5,
      brand: 'Jeeter',
    })
    const comp = __test__.resolveListingSizeProfile({
      listingName: '*Limited Edition* American Pl (Baby) | .5g | Quad Infused | 5pk',
      amount: '2.5',
      units: 'g',
      brand: 'Jeeter',
    })
    expect(__test__.classifySizeTier(ours, comp)).toBe(3)
  })

  it('only resolves a convention for known brands', () => {
    expect(__test__.resolveSizeConvention('Jeeter')).not.toBeNull()
    expect(__test__.resolveSizeConvention('Baby Jeeter')).not.toBeNull()
    expect(__test__.resolveSizeConvention('Stiiizy')).toBeNull()
    expect(__test__.resolveSizeConvention(null)).toBeNull()
  })
})

describe('distribution-aware size disambiguation', () => {
  // A fixture prior modelling the real catalog: pre-roll 5-packs are
  // overwhelmingly 0.5g/stick; an mg edible 10-pack is 10mg/piece.
  const prior = __test__.buildSizeDistributionPrior([
    { category: 'pre rolls', measure: 'g', packCount: 5, unitValue: 0.5, count: 147 },
    { category: 'pre rolls', measure: 'g', packCount: 7, unitValue: 0.5, count: 35 },
    { category: 'edibles', measure: 'mg', packCount: 10, unitValue: 10, count: 256 },
  ])

  it('reads "5x 2.5g" as a 2.5g total (0.5g/stick) WITHOUT any brand rule', () => {
    // No brand convention — the distribution alone rejects the
    // 12.5g-total reading because 5 x 2.5g/stick is never seen but
    // 5 x 0.5g (=2.5g total) is the most common cohort.
    const ours = __test__.resolveCatalogSizeProfile({
      name: 'Generic Brand Acapulco Gold 5x 2.5g',
      tab: '5x 2.5g',
      sizeName: '2.5g',
      packOfSize: 5,
      brand: 'Generic Brand',
      category: 'Pre-Rolls',
      prior,
    })
    expect(ours).toEqual({ measure: 'g', packCount: 5, totalValue: 2.5, unitValue: 0.5 })
  })

  it('keeps "7x 0.5g" as per-unit (3.5g total), the in-distribution reading', () => {
    const dank = __test__.resolveCatalogSizeProfile({
      name: 'Generic Brand GSC 7x 0.5g',
      tab: '7x 0.5g',
      sizeName: '0.5g',
      packOfSize: 7,
      brand: 'Generic Brand',
      category: 'Pre-Rolls',
      prior,
    })
    expect(dank).toEqual({ measure: 'g', packCount: 7, totalValue: 3.5, unitValue: 0.5 })
  })

  it('reads an edible "10x 10mg" as 10mg/piece, 100mg total', () => {
    const profile = __test__.disambiguateMultipackValue({
      packCount: 10,
      value: 10,
      measure: 'mg',
      context: { category: 'Edibles', prior, defaultInterpretation: 'unit' },
    })
    expect(profile).toEqual({ measure: 'mg', packCount: 10, totalValue: 100, unitValue: 10 })
  })

  it('falls back to the syntax default when the prior has no opinion', () => {
    // Unknown category -> no cohort match -> default interpretation wins.
    const profile = __test__.disambiguateMultipackValue({
      packCount: 5,
      value: 2.5,
      measure: 'g',
      context: { category: 'Mystery', prior, defaultInterpretation: 'unit' },
    })
    expect(profile).toEqual({ measure: 'g', packCount: 5, totalValue: 12.5, unitValue: 2.5 })
  })

  it('falls back to brand convention when distribution is silent', () => {
    const profile = __test__.disambiguateMultipackValue({
      packCount: 5,
      value: 2.5,
      measure: 'g',
      context: {
        category: 'Mystery',
        prior,
        conventionInterpretation: 'total',
        defaultInterpretation: 'unit',
      },
    })
    expect(profile).toEqual({ measure: 'g', packCount: 5, totalValue: 2.5, unitValue: 0.5 })
  })

  it('lets a manual override force a genuine out-of-distribution outlier', () => {
    // The "manual effort" escape hatch: force the rare 12.5g-total pack
    // even though the distribution would read it as 2.5g total.
    const profile = __test__.disambiguateMultipackValue({
      packCount: 5,
      value: 2.5,
      measure: 'g',
      context: { category: 'Pre-Rolls', prior, override: 'unit', defaultInterpretation: 'total' },
    })
    expect(profile).toEqual({ measure: 'g', packCount: 5, totalValue: 12.5, unitValue: 2.5 })
  })

  it('requires a decisive margin before distribution overrides the default', () => {
    // Two attested cohorts that are close in count -> keep the default.
    const closePrior = __test__.buildSizeDistributionPrior([
      { category: 'pre rolls', measure: 'g', packCount: 2, unitValue: 1, count: 7 },
      { category: 'pre rolls', measure: 'g', packCount: 2, unitValue: 0.5, count: 6 },
    ])
    const profile = __test__.disambiguateMultipackValue({
      packCount: 2,
      value: 1,
      measure: 'g',
      context: { category: 'Pre-Rolls', prior: closePrior, defaultInterpretation: 'unit' },
    })
    // 7 vs 6 is not a >=3x, >=5-count margin -> default 'unit' stands.
    expect(profile).toEqual({ measure: 'g', packCount: 2, totalValue: 2, unitValue: 1 })
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
    expect(listRetailerProductsMock).not.toHaveBeenCalled()
  })

  it('builds market evidence from exact partner-product matches', async () => {
    mockNearbyRetailerProducts([
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
    // Live evidence is pulled per-retailer with a brandIds filter, nearest-first.
    expect(listRetailerProductsMock).toHaveBeenCalledWith(1001, { stateCode: 'NY', brandIds: [42] })
    expect(listRetailerProductsMock).toHaveBeenCalledWith(1002, { stateCode: 'NY', brandIds: [42] })
    expect(listRetailersMock).toHaveBeenCalledWith('NY')
  })

  it('falls back to a parenthetical-stripped brand alias when the exact key fails', async () => {
    const liveState = { ...SAMPLE_LIVE_STATE, brand: 'Camino' }
    listBrandsForStateMock.mockResolvedValue([
      { id: 77, name: 'Camino Kiva', states: ['NY'] },
    ])
    mockNearbyRetailerProducts([
      buildBrandProduct({
        id: 6001,
        name: 'Camino Black Cherry 5mg',
        retailerId: 1001,
        configs: [{ amount: 5, units: 'mg', normalPrice: 30 }],
      }),
    ])

    const context = await buildPricingMarketContext(liveState)

    // Alias map resolves 'camino' -> 'camino kiva'; verify the resolved brand id
    // is passed through the per-retailer brandIds filter.
    expect(listRetailerProductsMock).toHaveBeenCalledWith(1001, { stateCode: 'NY', brandIds: [77] })
    expect(context.availability).not.toBe('unresolved_brand')
  })

  it('returns availability=no_family_matches when no partner products match any search term', async () => {
    mockNearbyRetailerProducts([
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
    mockNearbyRetailerProducts([
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

describe('geographic bounding of LitAlerts market pulls (issue #55 T3)', () => {
  // Geographic limiting in helios is done CLIENT-SIDE by nearest-retailer
  // selection, NOT by a request-level lat/lng/radius param (the partner
  // client exposes none). These tests lock in the two invariants the
  // operator's ask reduces to:
  //   1. The interactive pricing/market-evidence path NEVER issues the
  //      unbounded statewide `/v1/brands/:id/products` call
  //      (`listBrandProducts`) that "routinely times out"; it fans out
  //      over the geographically nearest retailers instead. (The statewide
  //      endpoint is used only by the separate batch cache ingest in
  //      `scripts/litalerts-structured-ingest.mts`, which is deliberately
  //      statewide and timeout-hardened; it is not on this path.)
  //   2. The proposed-price aggregate is bounded to the operator's
  //      (a) close-competitor = near band and (b) near-mid market =
  //      near+mid bands. Far / very-far / ungeocoded listings can appear on
  //      the pricing ladder as display-only context but never move the price.

  /**
   * Build a `litalerts_retailer_locations`-shaped distance row.
   * `loadRetailerNearestStoreMap` reads `retailer_id` as a `::text` string
   * and silently drops any row whose `miles` is not a finite JS number, so
   * both types must match the production query shape exactly.
   */
  function distanceRow(retailerId: number, miles: number): {
    miles: number
    nearest_store_key: string
    retailer_id: string
  } {
    return { miles, nearest_store_key: 'store-a', retailer_id: String(retailerId) }
  }

  const roundCurrency = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100

  it('never issues the unbounded statewide brand call; it fans out per nearest retailer', async () => {
    mockNearbyRetailerProducts([
      buildBrandProduct({
        id: 9001,
        name: 'Ayrloom Black Cherry 1:1 5mg',
        retailerId: 1001,
        configs: [{ amount: 5, units: 'mg', normalPrice: 30 }],
      }),
    ])

    await buildPricingMarketContext(SAMPLE_LIVE_STATE)

    expect(listBrandProductsMock).not.toHaveBeenCalled()
    expect(listRetailerProductsMock).toHaveBeenCalled()
  })

  it('confines the proposed-price aggregate to the near+mid bands and leaves far/very-far display-only', async () => {
    // One retailer per distance band, each carrying the same matching
    // Ayrloom listing at a distinct price + distinct dispensary name (so
    // `dedupeListingCandidates` cannot collapse any of them).
    listRetailersMock.mockResolvedValue([
      { id: 4001, name: 'Near Dispensary', address: '1 Near St', medical: false, recreational: true },
      { id: 4002, name: 'Mid Cannabis', address: '2 Mid Ave', medical: false, recreational: true },
      { id: 4003, name: 'Far Buds', address: '3 Far Rd', medical: false, recreational: true },
      { id: 4004, name: 'VeryFar Shop', address: '4 VeryFar Blvd', medical: false, recreational: true },
    ])
    dbFixture.retailerDistanceRows = [
      distanceRow(4001, 0.5), // near     (<= 1mi)
      distanceRow(4002, 2), //   mid      (<= 3mi)
      distanceRow(4003, 7), //   far      (<= 10mi)
      distanceRow(4004, 14), //  very_far (> 10mi)
    ]
    const nearPreTax = 30
    const midPreTax = 36
    const farPreTax = 50
    mockNearbyRetailerProducts([
      buildBrandProduct({ id: 4101, name: 'Ayrloom Black Cherry 1:1 5mg', retailerId: 4001, configs: [{ amount: 5, units: 'mg', normalPrice: nearPreTax }] }),
      buildBrandProduct({ id: 4102, name: 'Ayrloom Black Cherry 1:1 5mg', retailerId: 4002, configs: [{ amount: 5, units: 'mg', normalPrice: midPreTax }] }),
      buildBrandProduct({ id: 4103, name: 'Ayrloom Black Cherry 1:1 5mg', retailerId: 4003, configs: [{ amount: 5, units: 'mg', normalPrice: farPreTax }] }),
      buildBrandProduct({ id: 4104, name: 'Ayrloom Black Cherry 1:1 5mg', retailerId: 4004, configs: [{ amount: 5, units: 'mg', normalPrice: 60 }] }),
    ])

    const context = await buildPricingMarketContext(SAMPLE_LIVE_STATE)

    expect(listBrandProductsMock).not.toHaveBeenCalled()
    expect(context.availability).toBe('matched')
    const evidence = context.productEvidenceById[2001]
    expect(evidence).toBeDefined()

    const byBand = new Map(evidence!.matchedListings.map((listing) => [listing.distanceBand, listing]))
    // near + mid drive the price; far + very_far are excluded from it.
    expect(byBand.get('near')?.eligibleForPricing).toBe(true)
    expect(byBand.get('mid')?.eligibleForPricing).toBe(true)
    expect(byBand.get('far')?.eligibleForPricing).toBe(false)
    expect(byBand.get('very_far')?.eligibleForPricing).toBe(false)
    // The Ayrloom gummy resolves as a brand-family ("fallback") match;
    // assert it explicitly so a future lane-logic change fails loudly here
    // rather than silently flipping the eligibility assertions above.
    expect(byBand.get('near')?.matchTier).toBe('fallback')
    // Exactly the 2 near/mid comps are pricing-eligible.
    expect(evidence!.pricingEligibleListingCount).toBe(2)

    // The proposed-price aggregate is exactly the near/mid weighted average
    // (both comps are 'fallback', so the tier weight cancels), computed from
    // the shared distance weights — untouched by the far/very-far comps.
    const nearPost = roundCurrency(nearPreTax * PRICING_POST_TAX_MULTIPLIER)
    const midPost = roundCurrency(midPreTax * PRICING_POST_TAX_MULTIPLIER)
    const expectedPost = roundCurrency(
      (PRICING_NEAR_DISTANCE_WEIGHT * nearPost + PRICING_MID_DISTANCE_WEIGHT * midPost) /
        (PRICING_NEAR_DISTANCE_WEIGHT + PRICING_MID_DISTANCE_WEIGHT),
    )
    expect(evidence!.averagePostTaxPrice).toBe(expectedPost)
    // Median of the two eligible comps is their mean.
    expect(evidence!.medianPostTaxPrice).toBe(roundCurrency((nearPost + midPost) / 2))

    // The far-band comp is retained as display-only context, in its own
    // aggregate, never folded into the proposed price above.
    expect(evidence!.farListingCount).toBe(1)
    expect(evidence!.farAveragePostTaxPrice).toBe(roundCurrency(farPreTax * PRICING_POST_TAX_MULTIPLIER))
  })

  it('fans out over exactly the retailers chosen by the pure selector, excluding own stores', async () => {
    // End-to-end sanity: whatever `selectNearbyRetailersForFanout` returns is
    // exactly what gets queried (own stores excluded), and the statewide brand
    // call is never used. Detailed selection invariants are covered by the
    // dedicated unit tests in the `selectNearbyRetailersForFanout` block below.
    const geocoded = Array.from({ length: 6 }, (_, index) => ({
      id: 5000 + index,
      name: `Competitor ${index}`,
      address: `${index} Comp St`,
      medical: false,
      recreational: true,
    }))
    const ownStore = { id: 5900, name: 'Freshly Baked - Bronx', address: '1 Own St', medical: false, recreational: true }
    listRetailersMock.mockResolvedValue([ownStore, ...geocoded])
    dbFixture.retailerDistanceRows = [
      distanceRow(ownStore.id, 0.01), // nearest of all, yet excluded (our own store)
      ...geocoded.map((retailer, index) => distanceRow(retailer.id, 0.1 + index * 0.01)),
    ]
    mockNearbyRetailerProducts(
      geocoded.map((retailer) =>
        buildBrandProduct({
          id: 60000 + retailer.id,
          name: 'Ayrloom Black Cherry 1:1 5mg',
          retailerId: retailer.id,
          configs: [{ amount: 5, units: 'mg', normalPrice: 30 }],
        }),
      ),
    )

    await buildPricingMarketContext(SAMPLE_LIVE_STATE)

    expect(listBrandProductsMock).not.toHaveBeenCalled()
    const queriedIds = new Set(listRetailerProductsMock.mock.calls.map((call) => call[0]))
    // All 6 competitors are within the fan-out floor, so all are queried;
    // our own store is never queried regardless of being nearest.
    for (const retailer of geocoded) {
      expect(queriedIds.has(retailer.id)).toBe(true)
    }
    expect(queriedIds.has(ownStore.id)).toBe(false)
  })
})

describe('selectNearbyRetailersForFanout (issue #55 T3 geographic coverage)', () => {
  const MIN = __test__.PRICING_NEARBY_RETAILER_FETCH_MIN
  const HARD_CAP = __test__.PRICING_NEARBY_RETAILER_FETCH_HARD_CAP
  const MID_MAX_MILES = PRICING_MID_DISTANCE_MAX_MILES

  function entry(id: number, miles: number | null, name = `Competitor ${id}`): RetailerDirectoryEntry {
    return {
      address: `${id} Test St`,
      id,
      name,
      normalizedName: name.toLowerCase(),
      minDistanceMiles: miles,
      nearestStoreKey: miles === null ? null : 'store-a',
    }
  }

  it('always includes EVERY retailer within the mid band, even beyond the nearest-N floor', () => {
    // More near+mid competitors than the floor: all of them must still be
    // selected (this is the coverage bug the change fixes; the old fixed
    // 50-cap dropped mid-band competitors past the cap).
    const midBand = Array.from({ length: MIN + 25 }, (_, i) => entry(1000 + i, (i / (MIN + 25)) * MID_MAX_MILES))
    // Include one retailer sitting EXACTLY on the mid boundary to lock the
    // inclusive `<=` semantics (must match classifyPricingDistanceBand's `<=`).
    const onBoundary = entry(9999, MID_MAX_MILES)
    const selected = selectNearbyRetailersForFanout([...midBand, onBoundary])
    const selectedIds = new Set(selected.map((e) => e.id))
    for (const e of midBand) {
      expect(selectedIds.has(e.id)).toBe(true)
    }
    expect(selectedIds.has(onBoundary.id)).toBe(true)
    expect(selected.length).toBe(MIN + 26)
    expect(selected.length).toBeLessThanOrEqual(HARD_CAP)
  })

  it('pads up to the nearest-N floor with farther retailers for display-only context', () => {
    // Only a few near/mid comps, plenty of far ones: we still query up to the
    // floor so there is a far-band (weight-0) sample on the ladder.
    const near = [entry(1, 0.5), entry(2, 2.0)]
    const far = Array.from({ length: 200 }, (_, i) => entry(100 + i, 4 + i * 0.1))
    const selected = selectNearbyRetailersForFanout([...near, ...far])
    expect(selected.length).toBe(MIN)
    // The two near/mid comps are always present.
    expect(selected.some((e) => e.id === 1)).toBe(true)
    expect(selected.some((e) => e.id === 2)).toBe(true)
  })

  it('never exceeds the hard cap on request volume, even when the mid band is over-full', () => {
    // More competitors WITHIN the mid band than the hard cap: the cap binds
    // (and the selector warns) rather than issuing an unbounded fan-out.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const many = Array.from({ length: HARD_CAP + 50 }, (_, i) =>
      entry(2000 + i, (i / (HARD_CAP + 50)) * MID_MAX_MILES),
    )
    const selected = selectNearbyRetailersForFanout(many)
    expect(selected.length).toBe(HARD_CAP)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })

  it('excludes our own stores and sorts nearest-first', () => {
    const input = [
      entry(3, 2.0),
      entry(1, 0.5),
      entry(99, 0.01, 'Freshly Baked - Midtown'),
      entry(2, 1.0),
    ]
    const selected = selectNearbyRetailersForFanout(input)
    expect(selected.some((e) => /freshly baked/i.test(e.name))).toBe(false)
    expect(selected.map((e) => e.id)).toEqual([1, 2, 3])
  })

  it('sorts ungeocoded (null-distance) retailers last', () => {
    const input = [entry(10, null), entry(1, 0.5), entry(2, 2.0)]
    const selected = selectNearbyRetailersForFanout(input)
    expect(selected.map((e) => e.id)).toEqual([1, 2, 10])
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

describe('LLM parse-reasonableness escalation (catalog size)', () => {
  function buildPrerollGroup(opts: {
    brand: string
    sizeName: string | null
    packOfSize: number | null
    productName: string
    tab?: string
  }): NormalizedCatalogGroupLiveState {
    return {
      brand: opts.brand,
      category: 'Pre-Rolls',
      currentDescription: '',
      effects: [],
      flavorings: [],
      groupFullName: opts.productName,
      groupId: 900,
      groupName: opts.productName,
      imageUrl: null,
      productTabs: [opts.tab ?? ''],
      products: [
        {
          gmPercent: 60,
          imageUrl: null,
          name: opts.productName,
          packOfSize: opts.packOfSize,
          price: 50,
          productId: 9001,
          shortName: null,
          sizeName: opts.sizeName,
          sku: null,
          tab: opts.tab ?? '',
          wholesaleCost: 20,
        },
      ],
      scents: [],
      strain: null,
      subcategory: null,
      tags: [],
    }
  }

  // A genuinely ambiguous multipack: a generic brand (no convention), a
  // structured 5 x 2.5g, and an EMPTY prior so the distribution stays
  // silent and the LLM tie-break becomes eligible.
  const ambiguousGroup = buildPrerollGroup({
    brand: 'GenericCo',
    packOfSize: 5,
    productName: 'GenericCo Mystery Pack 5x 2.5g',
    sizeName: '2.5g',
  })
  const emptyPrior = __test__.buildSizeDistributionPrior([])

  it('flags an ambiguous multipack (no override, silent prior) for LLM review', () => {
    const ambiguity = __test__.inspectCatalogMultipackAmbiguity({
      name: ambiguousGroup.products[0]!.name,
      tab: ambiguousGroup.products[0]!.tab,
      sizeName: ambiguousGroup.products[0]!.sizeName,
      packOfSize: ambiguousGroup.products[0]!.packOfSize,
      brand: ambiguousGroup.brand,
      category: ambiguousGroup.category,
      prior: emptyPrior,
    })
    expect(ambiguity).not.toBeNull()
    expect(ambiguity?.candidateUnit).toMatchObject({ packCount: 5, totalValue: 12.5, unitValue: 2.5 })
    expect(ambiguity?.candidateTotal).toMatchObject({ packCount: 5, totalValue: 2.5, unitValue: 0.5 })
  })

  it('does NOT flag a SKU the distribution prior settles (real Jeeter-like 5x2.5g pre-roll)', () => {
    // Default prior has 147 rows of (pre rolls, 5-pack, 0.5g/stick) and 0
    // of 2.5g/stick, so distribution decides 'total' and no LLM is needed.
    const ambiguity = __test__.inspectCatalogMultipackAmbiguity({
      name: 'GenericCo Mystery Pack 5x 2.5g',
      tab: '',
      sizeName: '2.5g',
      packOfSize: 5,
      brand: 'GenericCo',
      category: 'Pre-Rolls',
    })
    expect(ambiguity).toBeNull()
  })

  it('never calls the LLM when the distribution prior decides', async () => {
    const assessor = vi.fn()
    const profiles = await __test__.buildCatalogComparableProfiles({
      liveState: buildPrerollGroup({
        brand: 'GenericCo',
        packOfSize: 5,
        productName: 'GenericCo Mystery Pack 5x 2.5g',
        sizeName: '2.5g',
      }),
      listingSamples: [],
      assessor: assessor as never,
    })
    expect(assessor).not.toHaveBeenCalled()
    // Deterministic distribution choice = 'total' => 2.5g total, 0.5g/stick.
    expect(profiles.get(9001)?.size).toMatchObject({ packCount: 5, totalValue: 2.5, unitValue: 0.5 })
  })

  it('accepts a high-confidence LLM pick on an ambiguous tie', async () => {
    const assessor = vi.fn().mockResolvedValue({
      chosenLabel: 'total',
      confidence: 0.92,
      note: 'Common 0.5g/stick pre-roll multipack.',
      candidate: null,
    })
    const profiles = await __test__.buildCatalogComparableProfiles({
      liveState: ambiguousGroup,
      listingSamples: [],
      prior: emptyPrior,
      assessor: assessor as never,
    })
    expect(assessor).toHaveBeenCalledTimes(1)
    expect(profiles.get(9001)?.size).toMatchObject({ packCount: 5, totalValue: 2.5, unitValue: 0.5 })
  })

  it('ignores a low-confidence LLM pick and keeps the deterministic default', async () => {
    const assessor = vi.fn().mockResolvedValue({
      chosenLabel: 'total',
      confidence: 0.4,
      note: 'Not sure.',
      candidate: null,
    })
    const profiles = await __test__.buildCatalogComparableProfiles({
      liveState: ambiguousGroup,
      listingSamples: [],
      prior: emptyPrior,
      assessor: assessor as never,
    })
    // Falls back to structured-syntax default 'unit' => 12.5g total, 2.5g/stick.
    expect(profiles.get(9001)?.size).toMatchObject({ packCount: 5, totalValue: 12.5, unitValue: 2.5 })
  })

  it('ignores an LLM pick with an unknown label', async () => {
    const assessor = vi.fn().mockResolvedValue({
      chosenLabel: 'bogus',
      confidence: 0.99,
      note: 'made up',
      candidate: null,
    })
    const profiles = await __test__.buildCatalogComparableProfiles({
      liveState: ambiguousGroup,
      listingSamples: [],
      prior: emptyPrior,
      assessor: assessor as never,
    })
    expect(profiles.get(9001)?.size).toMatchObject({ packCount: 5, totalValue: 12.5, unitValue: 2.5 })
  })

  it('stays deterministic when the assessor returns null (e.g. no Mantle token)', async () => {
    const assessor = vi.fn().mockResolvedValue(null)
    const profiles = await __test__.buildCatalogComparableProfiles({
      liveState: ambiguousGroup,
      listingSamples: [],
      prior: emptyPrior,
      assessor: assessor as never,
    })
    expect(profiles.get(9001)?.size).toMatchObject({ packCount: 5, totalValue: 12.5, unitValue: 2.5 })
  })

  it('stays deterministic when the assessor throws', async () => {
    const assessor = vi.fn().mockRejectedValue(new Error('mantle down'))
    const profiles = await __test__.buildCatalogComparableProfiles({
      liveState: ambiguousGroup,
      listingSamples: [],
      prior: emptyPrior,
      assessor: assessor as never,
    })
    expect(profiles.get(9001)?.size).toMatchObject({ packCount: 5, totalValue: 12.5, unitValue: 2.5 })
  })
})

describe('assessParseReasonableness (LLM helper)', () => {
  it('returns null when no Mantle token is configured', async () => {
    const result = await assessParseReasonableness({
      name: 'GenericCo Mystery Pack 5x 2.5g',
      candidates: [
        { label: 'unit', packCount: 5, unitValue: 2.5, totalValue: 12.5, measure: 'g' },
        { label: 'total', packCount: 5, unitValue: 0.5, totalValue: 2.5, measure: 'g' },
      ],
      context: 'test',
    })
    expect(result).toBeNull()
  })
})
