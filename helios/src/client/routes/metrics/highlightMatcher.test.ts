// Tests for small pure helpers exported from CatalogAnalyticsTab.
//
// We construct partial CatalogAnalyticsPoint records and cast to the real
// type; these helpers only read a small subset of point fields.
import { describe, expect, it } from 'vitest'
import type { CatalogAnalyticsPoint } from '../../../shared/contracts/index.js'
import { buildHighlightMatcher, cohortKey } from './CatalogAnalyticsTab.js'

const pt = (over: Partial<CatalogAnalyticsPoint>): CatalogAnalyticsPoint =>
  ({
    inventoryItemId: 'iv-1',
    productId: 'p-1',
    productName: '',
    productShortName: null,
    sku: null,
    brandName: null,
    distributorName: null,
    categoryName: null,
    subcategoryName: null,
    sizeLabel: null,
    packCount: null,
    unitSizeGrams: null,
    unitSizeMg: null,
    ...over,
  }) as unknown as CatalogAnalyticsPoint

describe('buildHighlightMatcher', () => {
  it('returns null for empty/whitespace queries', () => {
    expect(buildHighlightMatcher('')).toBeNull()
    expect(buildHighlightMatcher('   ')).toBeNull()
  })

  it('matches case-insensitive substring against brand', () => {
    const m = buildHighlightMatcher('GoodCo')
    expect(m).not.toBeNull()
    expect(m!(pt({ brandName: 'GoodCo Cannabis' }))).toBe(true)
    expect(m!(pt({ brandName: 'OtherBrand' }))).toBe(false)
  })

  it('matches case-insensitive substring against distributor', () => {
    const m = buildHighlightMatcher('Curaleaf')
    expect(m).not.toBeNull()
    expect(m!(pt({ distributorName: 'Curaleaf NY' }))).toBe(true)
    expect(m!(pt({ distributorName: 'Other Distributor' }))).toBe(false)
  })

  it('matches across category / subcategory / product name', () => {
    const m = buildHighlightMatcher('preroll')!
    expect(m(pt({ categoryName: 'Prerolls' }))).toBe(true)
    expect(m(pt({ subcategoryName: 'Infused Preroll' }))).toBe(true)
    expect(m(pt({ productName: 'Blue Dream Preroll 1g' }))).toBe(true)
    expect(m(pt({ categoryName: 'Flower' }))).toBe(false)
  })

  it('combines multiple whitespace-separated terms with AND', () => {
    const m = buildHighlightMatcher('blue dream 1g')!
    expect(
      m(
        pt({
          productName: 'Blue Dream',
          sizeLabel: '1g',
        }),
      ),
    ).toBe(true)
    expect(m(pt({ productName: 'Blue Dream', sizeLabel: '3.5g' }))).toBe(false)
    expect(m(pt({ productName: 'Sour Diesel', sizeLabel: '1g' }))).toBe(false)
  })

  it('synthesizes a pack label so "5-pack" / "1 per pkg" matches', () => {
    const m1 = buildHighlightMatcher('5-pack')!
    expect(m1(pt({ packCount: 5 }))).toBe(true)
    expect(m1(pt({ packCount: 1 }))).toBe(false)
    const m2 = buildHighlightMatcher('1 per pkg')!
    expect(m2(pt({ packCount: 1 }))).toBe(true)
    expect(m2(pt({ packCount: 5 }))).toBe(false)
  })

  it('matches against sku', () => {
    const m = buildHighlightMatcher('ABC123')!
    expect(m(pt({ sku: 'abc123-x' }))).toBe(true)
    expect(m(pt({ sku: 'xyz' }))).toBe(false)
  })
})

describe('cohortKey', () => {
  it('groups by category, subcategory, normalized gram unit size, and pack count', () => {
    expect(
      cohortKey(
        pt({
          categoryName: 'Flower',
          subcategoryName: 'Jar',
          sizeLabel: '3.50 g',
          unitSizeGrams: 3.5,
          packCount: 1,
        }),
      ),
    ).toBe('Flower|Jar|g:3.5|pack:1')
  })

  it('keeps different pack counts in different cohorts even when unit size matches', () => {
    const base = {
      categoryName: 'Prerolls',
      subcategoryName: 'Infused Preroll',
      unitSizeGrams: 0.5,
    }
    expect(cohortKey(pt({ ...base, packCount: 1 }))).not.toBe(
      cohortKey(pt({ ...base, packCount: 5 })),
    )
  })

  it('uses milligram unit size for edible cohorts', () => {
    expect(
      cohortKey(
        pt({
          categoryName: 'Edibles',
          subcategoryName: 'Gummies',
          sizeLabel: '10mg',
          unitSizeMg: 10,
          packCount: 10,
        }),
      ),
    ).toBe('Edibles|Gummies|mg:10|pack:10')
  })
})
