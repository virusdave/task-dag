import { describe, expect, it } from 'vitest'

import { PendingPurchaseCategoryListSchema } from './generatePendingPurchasePacketJob.js'

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
