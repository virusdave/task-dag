import { describe, expect, it } from 'vitest'

import {
  normalizeUnitSizeGroup,
  PREROLL_SIZE_BUCKETS,
  type UnitSizeGroupInput,
} from './unitSizeGroup.js'

/** Build a preroll input from a raw gram value. */
function preroll(grams: number | null, mg: number | null = null): UnitSizeGroupInput {
  return {
    categoryName: 'Pre-Rolls',
    sizeLabel: mg != null ? `${mg}mg` : grams != null ? `${grams}g` : null,
    unitSizeGrams: grams,
    unitSizeMg: mg,
  }
}

describe('normalizeUnitSizeGroup — pre-roll bucketing', () => {
  it('folds the operator novelty examples 0.6g→0.5g and 1.1g→1.0g', () => {
    const half = normalizeUnitSizeGroup(preroll(0.6))
    expect(half.standardGrams).toBe(0.5)
    expect(half.sizeGroupKey).toBe('g:0.5')
    expect(half.sizeGroupLabel).toBe('0.5 g')
    expect(half.folded).toBe(true)
    expect(half.perJointGrams).toBe(0.6)

    const one = normalizeUnitSizeGroup(preroll(1.1))
    expect(one.standardGrams).toBe(1.0)
    expect(one.sizeGroupKey).toBe('g:1')
    expect(one.folded).toBe(true)
  })

  it('does not flag an exact-standard size as folded', () => {
    const g = normalizeUnitSizeGroup(preroll(0.5))
    expect(g.standardGrams).toBe(0.5)
    expect(g.folded).toBe(false)

    const g1 = normalizeUnitSizeGroup(preroll(1.0))
    expect(g1.standardGrams).toBe(1.0)
    expect(g1.folded).toBe(false)
  })

  it('does not flag an exact-standard mg-labeled size as folded', () => {
    const g = normalizeUnitSizeGroup(preroll(null, 500))
    expect(g.standardGrams).toBe(0.5)
    expect(g.folded).toBe(false)
  })

  it('flags a size exactly on a bucket lower edge as folded', () => {
    // 450mg is the [450,650) lower edge → 0.5 bucket, but coerced (0.45 != 0.5).
    const g = normalizeUnitSizeGroup(preroll(0.45))
    expect(g.standardGrams).toBe(0.5)
    expect(g.folded).toBe(true)
  })

  it('handles the confirmed live mg-labeled per-joint examples', () => {
    // Canna Cure 583.3mg per joint → 0.5 g bucket.
    const gg4 = normalizeUnitSizeGroup(preroll(null, 583.3))
    expect(gg4.standardGrams).toBe(0.5)
    expect(gg4.folded).toBe(true)
    expect(gg4.perJointGrams).toBeCloseTo(0.583, 3)

    // Canna Cure 416.7mg per joint → 0.35 g bucket.
    const runtz = normalizeUnitSizeGroup(preroll(null, 416.7))
    expect(runtz.standardGrams).toBe(0.35)
    expect(runtz.folded).toBe(true)

    // "700mg" cosmetic spelling of 0.7 g → 0.75 g bucket.
    const seven = normalizeUnitSizeGroup(preroll(null, 700))
    expect(seven.standardGrams).toBe(0.75)
    expect(seven.folded).toBe(true)
  })

  it('does NOT divide by pack count (per-joint size convention)', () => {
    // A 6x pack of 583.3mg joints must bucket on 0.583 g/joint, not 3.5g total
    // and not 0.097 g (583.3/6). The pack count is irrelevant to the input.
    const g = normalizeUnitSizeGroup(preroll(null, 583.3))
    expect(g.standardGrams).toBe(0.5)
  })

  it('applies the operator item-2 edit: 1.2 stays 1.0, 1.25 and 1.3 move to 1.5', () => {
    expect(normalizeUnitSizeGroup(preroll(1.2)).standardGrams).toBe(1.0)
    expect(normalizeUnitSizeGroup(preroll(1.25)).standardGrams).toBe(1.5)
    expect(normalizeUnitSizeGroup(preroll(1.3)).standardGrams).toBe(1.5)
  })

  it('folds rare tiny sizes (<0.30g) UP into 0.35g', () => {
    expect(normalizeUnitSizeGroup(preroll(0.1)).standardGrams).toBe(0.35)
    expect(normalizeUnitSizeGroup(preroll(0.2)).standardGrams).toBe(0.35)
    expect(normalizeUnitSizeGroup(preroll(0.25)).standardGrams).toBe(0.35)
    expect(normalizeUnitSizeGroup(preroll(0.1)).folded).toBe(true)
  })

  it('respects every half-open bucket boundary exactly (integer-mg comparison)', () => {
    const cases: Array<{ mg: number; expected: number | null }> = [
      { mg: 299, expected: 0.35 }, // below smallest → fold up
      { mg: 300, expected: 0.35 },
      { mg: 449, expected: 0.35 },
      { mg: 450, expected: 0.5 },
      { mg: 649, expected: 0.5 },
      { mg: 650, expected: 0.75 },
      { mg: 899, expected: 0.75 },
      { mg: 900, expected: 1.0 },
      { mg: 1249, expected: 1.0 },
      { mg: 1250, expected: 1.5 },
      { mg: 1749, expected: 1.5 },
      { mg: 1750, expected: 2.0 },
      { mg: 2249, expected: 2.0 },
      { mg: 2250, expected: 2.5 },
      { mg: 2749, expected: 2.5 },
      { mg: 2750, expected: null }, // at/above largest → pass through
    ]
    for (const { mg, expected } of cases) {
      const g = normalizeUnitSizeGroup(preroll(mg / 1000))
      expect(g.standardGrams, `${mg}mg`).toBe(expected)
    }
  })

  it('does not mis-bucket 0.3g due to float error (0.3*1000 !== 300 in IEEE)', () => {
    // Guards against the 0.3*1000===299.999… trap: must land in 0.35, not fold-up path oddities.
    const g = normalizeUnitSizeGroup(preroll(0.3))
    expect(g.standardGrams).toBe(0.35)
  })

  it('passes through large pre-roll sizes (>=2.75g) as their natural size', () => {
    const g = normalizeUnitSizeGroup(preroll(3))
    expect(g.standardGrams).toBeNull()
    expect(g.folded).toBe(false)
    expect(g.sizeGroupKey).toBe('g:3')
    expect(g.perJointGrams).toBe(3)
  })

  it('keeps a large pre-roll grouped identically whether labeled g or mg', () => {
    const asG = normalizeUnitSizeGroup(preroll(3))
    const asMg = normalizeUnitSizeGroup(preroll(null, 3000))
    expect(asG.sizeGroupKey).toBe(asMg.sizeGroupKey)
    expect(asMg.sizeGroupKey).toBe('g:3')
  })

  it('falls back to the natural key for a pre-roll with an unparseable size', () => {
    const g = normalizeUnitSizeGroup({
      categoryName: 'Pre-Rolls',
      sizeLabel: 'Each',
      unitSizeGrams: null,
      unitSizeMg: null,
    })
    expect(g.categoryNorm).toBe('preroll')
    expect(g.standardGrams).toBeNull()
    expect(g.sizeGroupKey).toBe('label:Each')
  })
})

describe('normalizeUnitSizeGroup — non-preroll pass-through', () => {
  it('keeps edible mg sizes natural (no folding)', () => {
    const g = normalizeUnitSizeGroup({
      categoryName: 'Edibles',
      sizeLabel: '10mg',
      unitSizeGrams: null,
      unitSizeMg: 10,
    })
    expect(g.categoryNorm).toBe('edible')
    expect(g.standardGrams).toBeNull()
    expect(g.folded).toBe(false)
    expect(g.sizeGroupKey).toBe('mg:10')
    expect(g.sizeGroupLabel).toBe('10 mg')
  })

  it('keeps flower gram sizes natural (3.5/7/14/28)', () => {
    for (const grams of [3.5, 7, 14, 28]) {
      const g = normalizeUnitSizeGroup({
        categoryName: 'Flower',
        sizeLabel: `${grams}g`,
        unitSizeGrams: grams,
        unitSizeMg: null,
      })
      expect(g.standardGrams).toBeNull()
      expect(g.folded).toBe(false)
      expect(g.sizeGroupKey).toBe(`g:${grams}`)
    }
  })

  it('keeps vape sizes natural (bucketing does not apply to vapes)', () => {
    const g = normalizeUnitSizeGroup({
      categoryName: 'Vapes',
      sizeLabel: '0.5g',
      unitSizeGrams: 0.5,
      unitSizeMg: null,
    })
    expect(g.categoryNorm).toBe('vape')
    expect(g.standardGrams).toBeNull()
    expect(g.sizeGroupKey).toBe('g:0.5')
  })

  it('passes through an unknown category unfolded (raw canonical form)', () => {
    const g = normalizeUnitSizeGroup({
      categoryName: 'Mystery Widgets',
      sizeLabel: '0.6g',
      unitSizeGrams: 0.6,
      unitSizeMg: null,
    })
    expect(g.categoryNorm).toBe('mystery widgets')
    expect(g.standardGrams).toBeNull()
    expect(g.sizeGroupKey).toBe('g:0.6')
  })

  it('handles a null category and null size gracefully', () => {
    const g = normalizeUnitSizeGroup({
      categoryName: null,
      sizeLabel: null,
      unitSizeGrams: null,
      unitSizeMg: null,
    })
    expect(g.categoryNorm).toBeNull()
    expect(g.standardGrams).toBeNull()
    expect(g.sizeGroupKey).toBe('label:(no size)')
    expect(g.sizeGroupLabel).toBe('(no size)')
  })
})

describe('PREROLL_SIZE_BUCKETS table', () => {
  it('is contiguous and matches the operator-approved standards', () => {
    expect(PREROLL_SIZE_BUCKETS.map((b) => b.standardGrams)).toEqual([
      0.35, 0.5, 0.75, 1.0, 1.5, 2.0, 2.5,
    ])
    // Each bucket's max is the next bucket's min (no gaps, no overlaps).
    for (let i = 1; i < PREROLL_SIZE_BUCKETS.length; i++) {
      expect(PREROLL_SIZE_BUCKETS[i]!.minMg).toBe(PREROLL_SIZE_BUCKETS[i - 1]!.maxMg)
    }
  })
})
