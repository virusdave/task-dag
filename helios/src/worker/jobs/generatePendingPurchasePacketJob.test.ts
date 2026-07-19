import { describe, expect, it } from 'vitest'

import type { ReconciledPendingPurchaseClassification } from '../pendingPurchases/reconcilePendingPurchaseDrafts.js'
import {
  downgradeExplicitBrandConflict,
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
