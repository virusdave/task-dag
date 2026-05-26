import { describe, expect, it } from 'vitest'

import {
  applyVerdictPostFilter,
  brandFactor,
  categoryFactor,
  nameOverlapFactor,
  NAME_OVERLAP_FLOOR,
  packFactor,
  scoreCatalogFuzzy,
  scoreCatalogFuzzyFactors,
  sizeFactor,
  strainFactor,
  subcategoryFactor,
  type CatalogProfile,
  type FuzzyProfile,
} from './confidence.js'

function profile(overrides: Partial<CatalogProfile> = {}): CatalogProfile {
  return {
    brandNorm: 'Herb',
    categoryNorm: 'Flower',
    subcategoryNorm: 'Indica',
    sizeGNorm: 3.5,
    sizeMgNorm: null,
    packCountNorm: 1,
    strainNorm: 'Obama Runtz',
    nameTokens: null,
    ...overrides,
  }
}

describe('brandFactor', () => {
  it('returns 1.0 on case-insensitive match', () => {
    expect(brandFactor('Herb', 'herb', false)).toBe(1.0)
  })
  it('returns 0.85 on alias match', () => {
    expect(brandFactor('Camino', 'Camino Kiva', true)).toBe(0.85)
  })
  it('returns 0 on mismatch with no alias', () => {
    expect(brandFactor('Herb', 'Curaleaf', false)).toBe(0)
  })
})

describe('categoryFactor', () => {
  it('returns 1.0 on match', () => {
    expect(categoryFactor('Flower', 'flower', false)).toBe(1.0)
  })
  it('returns 0.70 on alias-compatible match', () => {
    expect(categoryFactor('Edible', 'Gummy', true)).toBe(0.70)
  })
  it('returns 0 on incompatible mismatch', () => {
    expect(categoryFactor('Flower', 'Concentrate', false)).toBe(0)
  })
})

describe('subcategoryFactor', () => {
  it('returns 1.0 on exact match', () => {
    expect(subcategoryFactor('Indica', 'INDICA')).toBe(1.0)
  })
  it('returns 0.90 when one side is null (subcategory is often missing)', () => {
    expect(subcategoryFactor(null, 'Indica')).toBe(0.90)
    expect(subcategoryFactor('Indica', null)).toBe(0.90)
  })
  it('returns 0.70 on mismatch', () => {
    expect(subcategoryFactor('Indica', 'Sativa')).toBe(0.70)
  })
})

describe('sizeFactor', () => {
  it('returns 1.0 when both sides match in grams', () => {
    expect(sizeFactor(profile({ sizeGNorm: 3.5 }), profile({ sizeGNorm: 3.5 }))).toBe(1.0)
  })
  it('falls off smoothly with deviation', () => {
    const exact = sizeFactor(profile({ sizeGNorm: 3.5 }), profile({ sizeGNorm: 3.5 }))
    const small = sizeFactor(profile({ sizeGNorm: 3.5 }), profile({ sizeGNorm: 4.0 }))
    const medium = sizeFactor(profile({ sizeGNorm: 3.5 }), profile({ sizeGNorm: 7.0 }))
    expect(exact).toBeGreaterThan(small)
    expect(small).toBeGreaterThan(medium)
    expect(medium).toBeGreaterThan(0)
  })
  it('returns 0.50 when only one side has a size', () => {
    expect(sizeFactor(profile({ sizeGNorm: 3.5 }), profile({ sizeGNorm: null, sizeMgNorm: null }))).toBe(0.50)
  })
  it('uses mg when both sides are mg-only', () => {
    expect(
      sizeFactor(
        profile({ sizeGNorm: null, sizeMgNorm: 100 }),
        profile({ sizeGNorm: null, sizeMgNorm: 100 }),
      ),
    ).toBe(1.0)
  })
})

describe('packFactor', () => {
  it('returns 1.0 on equal pack count', () => {
    expect(packFactor(10, 10)).toBe(1.0)
  })
  it('returns 0.30 on differing pack count', () => {
    expect(packFactor(10, 5)).toBe(0.30)
  })
  it('returns 0.85 when either side is null', () => {
    expect(packFactor(null, 10)).toBe(0.85)
    expect(packFactor(10, null)).toBe(0.85)
  })
})

describe('strainFactor', () => {
  it('returns 1.0 on match', () => {
    expect(strainFactor('Obama Runtz', 'obama runtz')).toBe(1.0)
  })
  it('returns 0.95 when either side is null', () => {
    expect(strainFactor(null, 'Obama Runtz')).toBe(0.95)
  })
  it('returns 0.70 on mismatch', () => {
    expect(strainFactor('Obama Runtz', 'Sour Diesel')).toBe(0.70)
  })
})

describe('applyVerdictPostFilter', () => {
  it('clamps no_match to 0', () => {
    expect(applyVerdictPostFilter(0.95, 'no_match')).toBe(0)
  })
  it('floors exact at 0.99', () => {
    expect(applyVerdictPostFilter(0.50, 'exact')).toBe(0.99)
    expect(applyVerdictPostFilter(1.00, 'exact')).toBe(1.00)
  })
  it('clamps brand_family into [0.50, 0.85]', () => {
    expect(applyVerdictPostFilter(0.10, 'brand_family')).toBe(0.50)
    expect(applyVerdictPostFilter(0.95, 'brand_family')).toBe(0.85)
    expect(applyVerdictPostFilter(0.70, 'brand_family')).toBe(0.70)
  })
  it('passes through when there is no verdict', () => {
    expect(applyVerdictPostFilter(0.65, null)).toBe(0.65)
    expect(applyVerdictPostFilter(0.65, undefined)).toBe(0.65)
  })
})

describe('scoreCatalogFuzzy end-to-end', () => {
  it('returns ~1.0 for a perfect match', () => {
    const score = scoreCatalogFuzzy(profile(), profile())
    expect(score).toBeCloseTo(1.0, 3)
  })
  it('returns 0 on a fatal brand mismatch', () => {
    const score = scoreCatalogFuzzy(profile({ brandNorm: 'Herb' }), profile({ brandNorm: 'Curaleaf' }))
    expect(score).toBe(0)
  })
  it('per-field monotonicity: improving subcategory does not lower the score', () => {
    const fuzzy: FuzzyProfile = { ...profile(), subcategoryNorm: 'Sativa' }
    const worse = scoreCatalogFuzzy(profile(), fuzzy)
    const better = scoreCatalogFuzzy(profile(), { ...fuzzy, subcategoryNorm: 'Indica' })
    expect(better).toBeGreaterThanOrEqual(worse)
  })
  it('per-field monotonicity: improving strain does not lower the score', () => {
    const fuzzy: FuzzyProfile = { ...profile(), strainNorm: 'Sour Diesel' }
    const worse = scoreCatalogFuzzy(profile(), fuzzy)
    const better = scoreCatalogFuzzy(profile(), { ...fuzzy, strainNorm: 'Obama Runtz' })
    expect(better).toBeGreaterThanOrEqual(worse)
  })
  it('factors are individually inspectable', () => {
    const factors = scoreCatalogFuzzyFactors(profile(), profile({ subcategoryNorm: 'Sativa' }))
    expect(factors.brand).toBe(1.0)
    expect(factors.category).toBe(1.0)
    expect(factors.subcategory).toBe(0.70)
    expect(factors.size).toBe(1.0)
    expect(factors.pack).toBe(1.0)
    expect(factors.strain).toBe(1.0)
    expect(factors.nameOverlap).toBe(1.0)
  })
})

describe('nameOverlapFactor', () => {
  it('returns 1.0 when both sides are null (back-compat no-op)', () => {
    expect(nameOverlapFactor(null, null)).toBe(1.0)
    expect(nameOverlapFactor(null, ['lemonade'])).toBe(1.0)
    expect(nameOverlapFactor(['lemonade'], null)).toBe(1.0)
  })
  it('returns 1.0 when both sides are empty arrays', () => {
    expect(nameOverlapFactor([], [])).toBe(1.0)
  })
  it('returns 0.85 when one side has tokens and the other is empty', () => {
    expect(nameOverlapFactor(['lemonade'], [])).toBe(0.85)
    expect(nameOverlapFactor([], ['honeycrisp'])).toBe(0.85)
  })
  it('returns 1.0 on identical token sets', () => {
    expect(nameOverlapFactor(['lemonade', 'up'], ['up', 'lemonade'])).toBe(1.0)
  })
  it('drops to NAME_OVERLAP_FLOOR on fully disjoint non-empty sets', () => {
    expect(nameOverlapFactor(['lemonade'], ['honeycrisp'])).toBe(NAME_OVERLAP_FLOOR)
  })
  it('interpolates between FLOOR and 1.0 on partial overlap', () => {
    // |A ∩ B| = 1, |A ∪ B| = 3 → Jaccard = 1/3
    const f = nameOverlapFactor(['lemonade', 'up'], ['lemonade', 'honeycrisp'])
    expect(f).toBeCloseTo(NAME_OVERLAP_FLOOR + (1 - NAME_OVERLAP_FLOOR) * (1 / 3), 5)
  })
  it('differentiates Ayrloom Lemonade vs Ayrloom Honeycrisp end-to-end', () => {
    // The user-reported case: brand+category+size all match but the
    // distinguishing token differs. Both candidates were scoring
    // identically before nameOverlap; now the matching-flavor one
    // wins by ~2× on the residual factor.
    const catalog = profile({ brandNorm: 'Ayrloom', categoryNorm: 'Beverages',
      sizeGNorm: null, sizeMgNorm: 10, packCountNorm: 1, strainNorm: null,
      nameTokens: ['lemonade'] })
    const lemonadeFuzzy: FuzzyProfile = { ...catalog, nameTokens: ['lemonade'] }
    const honeycrispFuzzy: FuzzyProfile = { ...catalog, nameTokens: ['honeycrisp'] }
    const matching = scoreCatalogFuzzy(catalog, lemonadeFuzzy)
    const mismatching = scoreCatalogFuzzy(catalog, honeycrispFuzzy)
    expect(matching).toBeGreaterThan(mismatching)
    expect(matching / mismatching).toBeGreaterThan(1.5)
  })
})
