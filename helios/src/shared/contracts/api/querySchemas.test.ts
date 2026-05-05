import { describe, expect, it } from 'vitest'

import { PricingReviewQuerySchema, PricingRunListQuerySchema, PricingScopePreviewQuerySchema } from './pricing.js'
import { ReviewLineItemListQuerySchema } from './review.js'

describe('query schemas', () => {
  it('normalizes blank GET form values for pricing filters', () => {
    expect(PricingReviewQuerySchema.parse({ approvalStatus: '', batchId: '', search: '' })).toEqual({
      approvalStatus: undefined,
      batchId: undefined,
      page: 1,
      pageSize: 50,
      search: undefined,
      showSuperseded: false,
    })

    expect(PricingRunListQuerySchema.parse({ search: '', status: '' })).toEqual({
      page: 1,
      pageSize: 25,
      search: undefined,
      status: undefined,
    })

  })

  it('parses boolean pricing selection filters from GET form values', () => {
    expect(PricingScopePreviewQuerySchema.parse({ liveBronxInventory: 'true', liveMidtownInventory: 'true', midtownEverReceived: 'true' })).toEqual({
      brand: undefined,
      category: undefined,
      liveBronxInventory: true,
      liveMidtownInventory: true,
      midtownEverReceived: true,
      scopeKind: 'full_catalog',
      search: undefined,
      subcategory: undefined,
    })
  })

  it('normalizes blank GET form values for the shared review queue filters', () => {
    expect(ReviewLineItemListQuerySchema.parse({ approvalStatus: '', proposalType: '', search: '' })).toEqual({
      approvalStatus: undefined,
      batchStatus: undefined,
      driftOnly: undefined,
      hasValidationIssues: undefined,
      page: 1,
      pageSize: 25,
      proposalType: undefined,
      search: undefined,
    })
  })
})
