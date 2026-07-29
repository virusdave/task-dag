import { describe, expect, it } from 'vitest'

import { applyCatalogCreationConventions } from './pendingPurchaseCatalogConventions.js'

describe('applyCatalogCreationConventions', () => {
  it('removes brand/category aliases and size metadata while retaining the salient variant', () => {
    expect(applyCatalogCreationConventions({
      brand: 'Freshly Baked',
      brandAliases: ['FB'],
      category: 'Pre-Rolls',
      groupName: 'FB Pre-Roll Cosmic Dream 2pk .5g',
      packCount: 2,
      size: '0.5g',
      strainName: 'Cosmic Dream',
      variantName: 'Freshly Baked PR Cosmic Dream .5g',
    })).toEqual({
      groupName: 'Cosmic Dream',
      issues: [],
      variantName: 'Cosmic Dream',
      variantTab: '2x 0.5g',
    })
  })

  it('uses exactly the unit size as the single-unit tab', () => {
    expect(applyCatalogCreationConventions({
      brand: 'Fernway',
      category: 'Vapes',
      groupName: 'Berry Haze',
      packCount: 1,
      size: '1.0g',
      variantName: 'Berry Haze',
    }).variantTab).toBe('1.0g')
  })

  it('adds a distinct salient variant to the group name without duplicating it', () => {
    const first = applyCatalogCreationConventions({
      brand: 'Fernway',
      category: 'Vapes',
      groupName: 'Traveler',
      packCount: 1,
      size: '1g',
      variantName: 'Berry Haze',
    })
    expect(first.groupName).toBe('Traveler - Berry Haze')
    expect(applyCatalogCreationConventions({
      brand: 'Fernway',
      category: 'Vapes',
      groupName: first.groupName,
      packCount: 1,
      size: '1g',
      variantName: 'Berry Haze',
    }).groupName).toBe('Traveler - Berry Haze')
  })

  it('fails safely when structural fields are missing', () => {
    const result = applyCatalogCreationConventions({
      brand: 'Fernway',
      category: 'Vapes',
      groupName: 'Fernway Vapes 1g',
      packCount: null,
      size: null,
      variantName: null,
    })
    expect(result.variantTab).toBeNull()
    expect(result.issues).toEqual(expect.arrayContaining([
      'catalog creation requires a unit size',
      'catalog creation requires a positive integer pack count',
      'catalog creation requires a salient variant name separate from size and pack metadata',
    ]))
  })
})
