import { describe, expect, it } from 'vitest'

import {
  CreateParseFeedbackBodySchema,
  type BrandFamilyMarketMatchResponse,
  type BrandFamilyMatchCandidate,
} from '../../../shared/contracts/index.js'
import {
  buildConventionProposalDetails,
  buildCreateBody,
  buildListingCorrectionDetails,
  canSave,
  conventionReady,
  conventionRefiners,
  conventionScopeOptions,
  defaultConventionScope,
  emptyConventionDraft,
  emptyCorrectionDraft,
  feedbackFetchIds,
  structuredChipHasValue,
  type ConventionDraft,
  type CorrectionDraft,
} from './parseCorrectionDraft.js'

function candidate(overrides: Partial<BrandFamilyMatchCandidate> = {}): BrandFamilyMatchCandidate {
  return {
    fuzzySkuId: 1,
    sourceListingId: 'src-1',
    listingName: 'Acme OG Kush 3.5g',
    brandRaw: 'Acme',
    brandNorm: 'acme',
    categoryNorm: 'flower',
    subcategoryNorm: null,
    parsedSizeLabel: '3.5 g',
    matchedSizeGroupLabel: '3.5 g',
    retailer: 'Green Store',
    retailerId: 42,
    url: 'https://example.com/1',
    preTaxPrice: 40,
    postTaxPrice: 45.2,
    currentStock: 5,
    sourceCapturedAt: null,
    distanceBand: 'near',
    distanceMiles: 2,
    score: 0.9,
    factors: { brand: 1, category: 1, subcategory: 1, size: 1, pack: 1, strain: 1, nameOverlap: 1 },
    aboveThreshold: true,
    matchedCatalogProductId: 777,
    priceOutlier: null,
    ...overrides,
  }
}

function response(overrides: Partial<BrandFamilyMarketMatchResponse> = {}): BrandFamilyMarketMatchResponse {
  return {
    familyKey: 'fam-1',
    brandKey: 'acme',
    brandName: 'Acme',
    categoryName: 'Flower',
    subcategoryName: 'Indica',
    sizeGroupLabel: '3.5 g',
    packCount: 1,
    memberVariantCount: 3,
    effectiveBrandNorms: ['acme'],
    mappingStates: [],
    mappingSummary: 'mapped',
    threshold: 0.7,
    rawRowCount: 10,
    dedupedListingCount: 8,
    fetchLimit: 500,
    fetchTruncated: false,
    scoredCandidateCount: 8,
    aboveThresholdCount: 5,
    belowThresholdCount: 3,
    packNotMatchable: false,
    subcategoryNotMatchable: true,
    snapshotCapturedAtMin: null,
    snapshotCapturedAtMax: null,
    candidates: [],
    priceOutlierSummary: {
      method: 'iqr',
      basis: 5,
      median: 40,
      lowFence: 30,
      highFence: 50,
      lowCount: 0,
      highCount: 0,
      flaggedCount: 0,
    },
    reviewCandidates: [],
    reviewCandidatesLimit: 25,
    reviewCandidatesOverflow: false,
    ...overrides,
  }
}

function draft(overrides: Partial<CorrectionDraft> = {}): CorrectionDraft {
  return { ...emptyCorrectionDraft(), ...overrides }
}

describe('canSave', () => {
  it('blocks with no issue chip selected', () => {
    expect(canSave(draft(), emptyConventionDraft(42))).toBe(false)
  })

  it('allows a disposition chip alone (price_genuine)', () => {
    expect(canSave(draft({ issueTypes: ['price_genuine'] }), emptyConventionDraft(42))).toBe(true)
  })

  it('allows a disposition chip alone (no_match)', () => {
    expect(canSave(draft({ issueTypes: ['no_match'] }), emptyConventionDraft(42))).toBe(true)
  })

  it('blocks a structured chip with no valid field (junk row)', () => {
    expect(canSave(draft({ issueTypes: ['size'] }), emptyConventionDraft(42))).toBe(false)
    expect(canSave(draft({ issueTypes: ['pack_qty'] }), emptyConventionDraft(42))).toBe(false)
  })

  it('allows a structured chip once its field is valid', () => {
    expect(canSave(draft({ issueTypes: ['pack_qty'], packCount: '2' }), emptyConventionDraft(42))).toBe(true)
  })

  it('requires EVERY selected structured chip to have a value', () => {
    const d = draft({ issueTypes: ['pack_qty', 'brand'], packCount: '2' }) // brand empty
    expect(canSave(d, emptyConventionDraft(42))).toBe(false)
  })

  it('blocks when an enabled convention has neither note nor pattern', () => {
    const c: ConventionDraft = { ...emptyConventionDraft(42), enabled: true }
    expect(canSave(draft({ issueTypes: ['price_genuine'] }), c)).toBe(false)
  })

  it('allows when an enabled convention has a note', () => {
    const c: ConventionDraft = { ...emptyConventionDraft(42), enabled: true, note: 'size at end' }
    expect(canSave(draft({ issueTypes: ['price_genuine'] }), c)).toBe(true)
  })
})

describe('structuredChipHasValue', () => {
  it('size needs a full value+unit pair', () => {
    expect(structuredChipHasValue('size', draft({ unitSizeValue: '3.5' }))).toBe(false)
    expect(structuredChipHasValue('size', draft({ unitSizeValue: '3.5', unitSizeUnit: 'g' }))).toBe(true)
    expect(structuredChipHasValue('size', draft({ totalSizeValue: '7', totalSizeUnit: 'g' }))).toBe(true)
  })

  it('pack_qty needs a positive integer', () => {
    expect(structuredChipHasValue('pack_qty', draft({ packCount: '0' }))).toBe(false)
    expect(structuredChipHasValue('pack_qty', draft({ packCount: '1.5' }))).toBe(false)
    expect(structuredChipHasValue('pack_qty', draft({ packCount: '2' }))).toBe(true)
  })

  it('dispositions never contribute a structured field', () => {
    expect(structuredChipHasValue('price_genuine', draft())).toBe(false)
    expect(structuredChipHasValue('no_match', draft())).toBe(false)
  })
})

describe('buildListingCorrectionDetails', () => {
  it('nulls every field whose chip is not selected (no stale-prefill leak)', () => {
    // All fields filled, but only pack_qty selected → only packCount survives.
    const d = draft({
      issueTypes: ['pack_qty'],
      packCount: '2',
      unitSizeValue: '3.5',
      unitSizeUnit: 'g',
      category: 'Flower',
      brand: 'Acme',
      strain: 'OG Kush',
    })
    const details = buildListingCorrectionDetails(d)
    expect(details.packCount).toBe(2)
    expect(details.unitSizeValue).toBeNull()
    expect(details.unitSizeUnit).toBeNull()
    expect(details.category).toBeNull()
    expect(details.brand).toBeNull()
    expect(details.strain).toBeNull()
    expect(details.issueTypes).toEqual(['pack_qty'])
  })

  it('only sends a size pair when BOTH value and unit are valid', () => {
    const d = draft({ issueTypes: ['size'], unitSizeValue: '3.5', unitSizeUnit: '' })
    const details = buildListingCorrectionDetails(d)
    expect(details.unitSizeValue).toBeNull()
    expect(details.unitSizeUnit).toBeNull()
  })

  it('keeps the note regardless of chips', () => {
    const d = draft({ issueTypes: ['no_match'], note: '  not the same product  ' })
    expect(buildListingCorrectionDetails(d).note).toBe('not the same product')
  })

  it('produces a body that satisfies the create contract', () => {
    const d = draft({ issueTypes: ['size'], unitSizeValue: '3.5', unitSizeUnit: 'g' })
    const body = buildCreateBody(candidate(), response(), d, emptyConventionDraft(42))
    expect(() => CreateParseFeedbackBodySchema.parse(body)).not.toThrow()
    expect(body.conventionProposal).toBeUndefined()
    expect(body.listingCorrection.fuzzySkuId).toBe(1)
    expect(body.listingCorrection.matchedCatalogProductId).toBe(777)
  })
})

describe('convention proposal', () => {
  it('defaults to listing_only when there is no stable retailer id', () => {
    expect(defaultConventionScope(null)).toBe('listing_only')
    expect(defaultConventionScope(42)).toBe('retailer_category')
  })

  it('disables retailer-scoped options without a retailer id', () => {
    const noId = conventionScopeOptions(null)
    expect(noId.find((o) => o.value === 'retailer_category')?.disabled).toBe(true)
    expect(noId.find((o) => o.value === 'listing_only')?.disabled).toBe(false)
    const withId = conventionScopeOptions(42)
    expect(withId.every((o) => !o.disabled)).toBe(true)
  })

  it('returns null when not enabled', () => {
    expect(buildConventionProposalDetails(emptyConventionDraft(42), candidate(), response())).toBeNull()
  })

  it('returns null when enabled but empty', () => {
    const c: ConventionDraft = { ...emptyConventionDraft(42), enabled: true }
    expect(conventionReady(c)).toBe(false)
    expect(buildConventionProposalDetails(c, candidate(), response())).toBeNull()
  })

  it('carries the listing name as an auto example and scope-implied refiners', () => {
    const c: ConventionDraft = {
      enabled: true,
      scope: 'retailer_category',
      note: 'size at end',
      patternChips: ['size_at_end'],
    }
    const details = buildConventionProposalDetails(c, candidate(), response())
    expect(details).not.toBeNull()
    expect(details?.examples).toEqual(['Acme OG Kush 3.5g'])
    expect(details?.category).toBe('Flower')
    expect(details?.subcategory).toBe('Indica')
    expect(details?.brand).toBeNull()
  })

  it('scope refiners follow the scope', () => {
    const data = response()
    expect(conventionRefiners('retailer_wide', data)).toEqual({ category: null, subcategory: null, brand: null })
    expect(conventionRefiners('retailer_brand', data)).toEqual({ category: null, subcategory: null, brand: 'Acme' })
    expect(conventionRefiners('retailer_category', data)).toEqual({
      category: 'Flower',
      subcategory: 'Indica',
      brand: null,
    })
  })

  it('attaches a valid convention to the create body', () => {
    const c: ConventionDraft = {
      enabled: true,
      scope: 'retailer_category',
      note: 'brand first, size at end',
      patternChips: ['brand_first', 'size_at_end'],
    }
    const d = draft({ issueTypes: ['brand'], brand: 'Acme Farms' })
    const body = buildCreateBody(candidate(), response(), d, c)
    expect(() => CreateParseFeedbackBodySchema.parse(body)).not.toThrow()
    expect(body.conventionProposal?.details.patternChips).toEqual(['brand_first', 'size_at_end'])
  })
})

describe('feedbackFetchIds', () => {
  it('unions candidates + review candidates, dedupes, and caps', () => {
    const data = response({
      candidates: [candidate({ fuzzySkuId: 1 }), candidate({ fuzzySkuId: 2 })],
      reviewCandidates: [
        { ...candidate({ fuzzySkuId: 2 }), priceOutlier: { kind: 'high', delta: 5, fence: 50, median: 40, basis: 5 } },
        { ...candidate({ fuzzySkuId: 3 }), priceOutlier: { kind: 'low', delta: -5, fence: 30, median: 40, basis: 5 } },
      ],
    })
    expect(feedbackFetchIds(data, 500).sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  it('respects the id cap', () => {
    const cands = Array.from({ length: 10 }, (_, i) => candidate({ fuzzySkuId: i + 1 }))
    const data = response({ candidates: cands })
    expect(feedbackFetchIds(data, 4)).toHaveLength(4)
  })
})
