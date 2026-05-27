// Tests for `buildHighlightMatcher` exported from CatalogAnalyticsTab.
//
// We construct partial CatalogAnalyticsPoint records and cast to the
// real type for the matcher — the matcher only reads the text-y
// fields (brand/category/subcategory/size/product/sku/packCount).
import { describe, expect, it } from 'vitest'
import type { CatalogAnalyticsPoint } from '../../../shared/contracts/index.js'
import { buildHighlightMatcher } from './CatalogAnalyticsTab.js'

const pt = (over: Partial<CatalogAnalyticsPoint>): CatalogAnalyticsPoint =>
  ({
    inventoryItemId: 'iv-1',
    productId: 'p-1',
    productName: '',
    productShortName: null,
    sku: null,
    brandName: null,
    categoryName: null,
    subcategoryName: null,
    sizeLabel: null,
    packCount: null,
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
