import { describe, expect, it, vi } from 'vitest'

import type { ReconciledPendingPurchaseClassification } from '../pendingPurchases/reconcilePendingPurchaseDrafts.js'
import {
  buildPendingPurchaseAllowedTaxonomy,
  collectPendingPurchaseLiveBrands,
  downgradeExplicitBrandConflict,
  PendingPurchaseBrandListSchema,
  PendingPurchaseCategoryListSchema,
} from './generatePendingPurchasePacketJob.js'

describe('PendingPurchaseCategoryListSchema', () => {
  // Regression: the prospective-classifier generate path (C8a) parses the
  // Sweed `store.product.category.list` response. That RPC returns a BARE
  // ARRAY; the original object-only schema threw a raw ZodError
  // ("expected object, received array") on the first prod run of the path
  // (packet-generation job for PO 159659). Both shapes must now normalize to
  // an array, mirroring the sibling helpers in configWorkersCatalogRefreshJob
  // and applyPendingPurchaseRequestJob.
  const bareArray = [
    { name: 'Flower', subcategories: [{ name: 'Indoor' }, { name: 'Outdoor' }] },
    { name: 'Pre-Rolls', subcategories: [{ name: 'Infused' }] },
  ]

  it('accepts the bare-array shape the RPC actually returns', () => {
    const parsed = PendingPurchaseCategoryListSchema.parse(bareArray)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]?.subcategories.map((s) => s.name)).toEqual(['Indoor', 'Outdoor'])
  })

  it('still accepts the wrapped { data: [...] } shape', () => {
    const parsed = PendingPurchaseCategoryListSchema.parse({ data: bareArray })
    expect(parsed).toEqual(bareArray)
  })

  it('defaults omitted subcategories to an empty array', () => {
    const parsed = PendingPurchaseCategoryListSchema.parse([{ name: 'Edibles' }])
    expect(parsed[0]?.subcategories).toEqual([])
  })

  it('normalizes both empty shapes to an empty array (the loader enforces non-empty)', () => {
    expect(PendingPurchaseCategoryListSchema.parse([])).toEqual([])
    expect(PendingPurchaseCategoryListSchema.parse({})).toEqual([])
  })
})

describe('buildPendingPurchaseAllowedTaxonomy', () => {
  it('allows only explicitly enabled categories and subcategories', () => {
    expect(buildPendingPurchaseAllowedTaxonomy(PendingPurchaseCategoryListSchema.parse([
      {
        enabled: true,
        name: 'Flower',
        subcategories: [
          { enabled: true, name: 'Infused' },
          { enabled: false, name: 'Disabled Flower Type' },
          { name: 'Unknown Flower Type' },
        ],
      },
      { enabled: false, name: 'Edibles', subcategories: [{ enabled: true, name: 'Gummies' }] },
      { name: 'Vapes', subcategories: [] },
    ]))).toEqual({ categories: ['Flower'], subcategories: ['Infused'] })
  })

  it('fails closed when enabled state is absent', () => {
    expect(() => buildPendingPurchaseAllowedTaxonomy(
      PendingPurchaseCategoryListSchema.parse([{ name: 'Flower', subcategories: [] }]),
    )).toThrow('explicitly mark any supported pending-purchase category as enabled')
  })
})

describe('PendingPurchaseBrandListSchema', () => {
  const brands = [
    { id: 88, name: 'Dabbar', enabled: true },
    { id: 89, name: 'DEAD - Old Brand', enabled: false },
  ]

  it('accepts the bare-array live Sweed response', () => {
    expect(PendingPurchaseBrandListSchema.parse(brands)).toEqual(brands)
  })

  it('accepts the wrapped response shape', () => {
    expect(PendingPurchaseBrandListSchema.parse({ data: brands })).toEqual(brands)
  })

  it('collects every clamped page and filters disabled or retired brands', async () => {
    const fetchPage = async (page: number) => {
      if (page <= 3) {
        return Array.from({ length: 50 }, (_unused, index) => ({
          id: ((page - 1) * 50) + index + 1,
          name: `Brand ${((page - 1) * 50) + index + 1}`,
          enabled: true,
        }))
      }
      return page === 4
        ? [
            { id: 151, name: 'Dabbar', enabled: true },
            { id: 152, name: 'DEAD - Retired', enabled: true },
            { id: 153, name: 'Disabled', enabled: false },
          ]
        : []
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await collectPendingPurchaseLiveBrands(fetchPage)
      expect(result).toHaveLength(151)
      expect(result.at(-1)).toEqual({ sweedBrandId: 151, brandName: 'Dabbar' })
    } finally {
      warn.mockRestore()
    }
  })

  it('stops safely when Sweed repeats a full page', async () => {
    const page = Array.from({ length: 200 }, (_unused, index) => ({
      id: index + 1,
      name: `Brand ${index + 1}`,
      enabled: true,
    }))
    let calls = 0
    const result = await collectPendingPurchaseLiveBrands(async () => {
      calls += 1
      return page
    })
    expect(result).toHaveLength(200)
    expect(calls).toBe(2)
  })
})

describe('downgradeExplicitBrandConflict', () => {
  it('preserves the override and surfaces confirmed reuse plus a conflicting exact pin', () => {
    const classification: ReconciledPendingPurchaseClassification = {
      rowKey: 'bronx:dp-1',
      distributorProductId: 'dp-1',
      distributorProductName: 'Pinned raw name',
      actionType: 'mapping-only',
      catalogAction: 'Map existing product.',
      mappingStatus: 'mapped_variant_ready_for_link',
      targetBrand: 'Existing Brand',
      targetCategory: 'Flower',
      targetSubcategory: null,
      targetGroupName: 'Existing Group',
      targetVariantName: 'Existing Variant',
      targetVariantTab: 'Flower',
      targetStrainName: null,
      targetSize: '3.5g',
      targetPackCount: 1,
      reuseProductId: 101,
      reuseProductName: 'Existing Variant',
      reuseGroupId: 11,
      validatedReuseSnapshot: {
        productId: 101,
        productName: 'Existing Variant',
        groupId: 11,
        brand: 'Existing Brand',
        category: 'Flower',
        subcategory: null,
        groupName: 'Existing Group',
        variantTab: 'Flower',
        strain: null,
        size: '3.5g',
        packCount: 1,
      },
      suggestionCandidates: [{ productId: 101, productName: 'Existing Variant', score: 0.9 }],
      reviewFlags: [],
      notes: null,
      confidence: 0.95,
      rationale: 'Existing link matched.',
      citedHintIds: [],
      warningFlags: [],
    }

    const result = downgradeExplicitBrandConflict({
      classification,
      explicitBrand: 'Operator Brand',
      catalogAction: 'Review the conflict.',
      additionalCandidates: [{ productId: 202, productName: 'Exact Pin Variant', score: null }],
    })

    expect(result).toMatchObject({
      actionType: 'needs-review',
      mappingStatus: 'needs_review',
      targetBrand: 'Operator Brand',
      reuseProductId: null,
      reuseProductName: null,
      reuseGroupId: null,
      validatedReuseSnapshot: null,
    })
    expect(result.suggestionCandidates).toEqual([
      { productId: 101, productName: 'Existing Variant', score: null },
      { productId: 202, productName: 'Exact Pin Variant', score: null },
    ])
  })
})
