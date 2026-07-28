import { describe, expect, it } from 'vitest'

import { buildStructuredOverridePayload, readInitialDraftStructured } from './structuredOverrides.js'

const parsed = {
  editedStructuredFields: null,
  expectedCategory: 'Flower',
  expectedSubcategory: null,
  targetBrand: 'Dumbo',
  targetGroupName: 'Electric',
  targetPackCount: 1,
  targetSize: '1.5g',
  targetStrain: 'Blue Dream',
  targetVariantName: 'Blue Dream 1.5g',
  targetVariantTab: 'Blue Dream',
}

describe('buildStructuredOverridePayload', () => {
  it.each(['abc', '0', '1001', '2.5'])('rejects invalid pack count %s', (targetPackCount) => {
    expect(() => buildStructuredOverridePayload(parsed, {
      ...readInitialDraftStructured(parsed),
      targetPackCount,
    })).toThrow('Pack count must be a whole number from 1 through 1000.')
  })

  it('serializes a valid changed pack count', () => {
    expect(buildStructuredOverridePayload(parsed, {
      ...readInitialDraftStructured(parsed),
      targetPackCount: '2',
    })).toEqual({ targetPackCount: 2 })
  })
})
