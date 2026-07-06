import { describe, expect, it } from 'vitest'

import {
  familyBrandKey,
  groupFamilies,
  type FamilyExplorerVariant,
} from './familyExplorer.js'

let nextProductId = 1

function variant(overrides: Partial<FamilyExplorerVariant>): FamilyExplorerVariant {
  return {
    catalogGroupId: 100,
    productId: nextProductId++,
    name: 'Test',
    sku: null,
    brandName: 'Acme',
    categoryName: 'Pre-Rolls',
    subcategoryName: 'Infused',
    packCount: 1,
    sizeLabel: '1g',
    ...overrides,
  }
}

describe('familyBrandKey', () => {
  it('trims, lowercases, and collapses whitespace', () => {
    expect(familyBrandKey('  Acme   Farms ')).toBe('acme farms')
    expect(familyBrandKey('ACME FARMS')).toBe('acme farms')
  })

  it('maps blank / null to null', () => {
    expect(familyBrandKey('   ')).toBeNull()
    expect(familyBrandKey(null)).toBeNull()
  })
})

describe('groupFamilies — nonbrand mode', () => {
  it('merges variants of different brands into one family (brand ignored)', () => {
    const groups = groupFamilies(
      [
        variant({ brandName: 'Acme', categoryName: 'Flower', subcategoryName: 'Indica', sizeLabel: '3.5g' }),
        variant({ brandName: 'Zenith', categoryName: 'Flower', subcategoryName: 'Indica', sizeLabel: '3.5g' }),
      ],
      'nonbrand',
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.brandName).toBeNull()
    expect(groups[0]?.memberCount).toBe(2)
  })
})

describe('groupFamilies — brand mode', () => {
  it('splits the same product family by brand (case-insensitively)', () => {
    const groups = groupFamilies(
      [
        variant({ brandName: 'Acme', categoryName: 'Flower', subcategoryName: 'Indica', sizeLabel: '3.5g' }),
        variant({ brandName: 'acme', categoryName: 'Flower', subcategoryName: 'Indica', sizeLabel: '3.5g' }),
        variant({ brandName: 'Zenith', categoryName: 'Flower', subcategoryName: 'Indica', sizeLabel: '3.5g' }),
      ],
      'brand',
    )
    // Acme + acme collapse to one brand family; Zenith is its own.
    expect(groups).toHaveLength(2)
    const acme = groups.find((g) => familyBrandKey(g.brandName) === 'acme')
    expect(acme?.memberCount).toBe(2)
  })
})

describe('groupFamilies — preroll size-group folding wiring (T2 seam)', () => {
  it('folds 0.5g and 0.6g prerolls into one 0.5 g family', () => {
    const groups = groupFamilies(
      [
        variant({ categoryName: 'Pre-Rolls', subcategoryName: null, sizeLabel: '0.5g' }),
        variant({ categoryName: 'Pre-Rolls', subcategoryName: null, sizeLabel: '0.6g' }),
      ],
      'nonbrand',
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.sizeGroupKey).toBe('g:0.5')
    expect(groups[0]?.memberCount).toBe(2)
    const folded = groups[0]?.members.find((m) => m.sizeLabel === '0.6g')
    expect(folded?.folded).toBe(true)
  })

  it('joins an mg-labeled preroll into its gram-labeled equivalent family', () => {
    // "583.3mg" per-joint folds to the 0.5 g bucket, same as a "0.5g" preroll.
    const groups = groupFamilies(
      [
        variant({ categoryName: 'Pre-Rolls', subcategoryName: null, sizeLabel: '0.5g', packCount: 6 }),
        variant({ categoryName: 'Pre-Rolls', subcategoryName: null, sizeLabel: '583.3mg', packCount: 6 }),
      ],
      'nonbrand',
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.sizeGroupKey).toBe('g:0.5')
    expect(groups[0]?.memberCount).toBe(2)
  })
})

describe('groupFamilies — non-preroll categories keep natural size', () => {
  it('does NOT fold flower sizes into preroll buckets', () => {
    const groups = groupFamilies(
      [
        variant({ categoryName: 'Flower', subcategoryName: 'Indica', sizeLabel: '3.5g' }),
        variant({ categoryName: 'Flower', subcategoryName: 'Indica', sizeLabel: '7g' }),
      ],
      'nonbrand',
    )
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.sizeGroupKey).sort()).toEqual(['g:3.5', 'g:7'])
  })
})

describe('groupFamilies — pack count and null dims are distinct buckets', () => {
  it('separates families by pack count', () => {
    const groups = groupFamilies(
      [
        variant({ categoryName: 'Vapes', subcategoryName: 'Cart', sizeLabel: '1g', packCount: 1 }),
        variant({ categoryName: 'Vapes', subcategoryName: 'Cart', sizeLabel: '1g', packCount: 2 }),
      ],
      'nonbrand',
    )
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.packCount).sort()).toEqual([1, 2])
  })

  it('keeps null-subcategory variants in their own family', () => {
    const groups = groupFamilies(
      [
        variant({ categoryName: 'Flower', subcategoryName: 'Indica', sizeLabel: '3.5g' }),
        variant({ categoryName: 'Flower', subcategoryName: null, sizeLabel: '3.5g' }),
      ],
      'nonbrand',
    )
    expect(groups).toHaveLength(2)
  })

  it('keeps null-pack variants in their own family', () => {
    const groups = groupFamilies(
      [
        variant({ categoryName: 'Flower', subcategoryName: 'Indica', sizeLabel: '3.5g', packCount: 1 }),
        variant({ categoryName: 'Flower', subcategoryName: 'Indica', sizeLabel: '3.5g', packCount: null }),
      ],
      'nonbrand',
    )
    expect(groups).toHaveLength(2)
  })
})

describe('groupFamilies — unparseable size families surface first', () => {
  it('flags an unparseable size as sizeUnparsed and sorts it first', () => {
    const groups = groupFamilies(
      [
        variant({ categoryName: 'Flower', subcategoryName: 'Indica', sizeLabel: '3.5g' }),
        variant({ categoryName: 'Accessories', subcategoryName: 'Grinder', sizeLabel: 'Each' }),
      ],
      'nonbrand',
    )
    expect(groups[0]?.sizeUnparsed).toBe(true)
    expect(groups[0]?.categoryName).toBe('Accessories')
    const parsed = groups.find((g) => g.categoryName === 'Flower')
    expect(parsed?.sizeUnparsed).toBe(false)
  })
})

describe('groupFamilies — deterministic ordering', () => {
  it('produces identical output regardless of input order', () => {
    const input: FamilyExplorerVariant[] = [
      variant({ brandName: 'Zenith', categoryName: 'Flower', subcategoryName: 'Indica', sizeLabel: '3.5g' }),
      variant({ brandName: 'Acme', categoryName: 'Vapes', subcategoryName: 'Cart', sizeLabel: '1g' }),
      variant({ brandName: 'Acme', categoryName: 'Pre-Rolls', subcategoryName: null, sizeLabel: '0.5g' }),
    ]
    const forward = groupFamilies(input, 'brand').map((g) => g.familyKey)
    const reversed = groupFamilies([...input].reverse(), 'brand').map((g) => g.familyKey)
    expect(reversed).toEqual(forward)
  })
})
