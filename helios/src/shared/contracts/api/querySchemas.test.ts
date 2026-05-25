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

  it('parses repeated GET-form arrays for pricing selection filters', () => {
    // PricingScopePreviewQuerySchema defaults: family expansion mode,
    // both sites selected, stockOnly + includePending true.
    expect(PricingScopePreviewQuerySchema.parse({
      brands: ['BrandA', 'BrandB'],
      categories: 'Flower',
      subcategories: [],
    })).toEqual({
      brands: ['BrandA', 'BrandB'],
      categories: ['Flower'],
      includePending: true,
      scopeKind: 'family_expansion_from_stock_or_pending',
      search: undefined,
      sites: ['bronx', 'midtown'],
      stockOnly: true,
      strict: false,
      subcategories: [],
    })
  })

  it("treats the string 'false' as the boolean false in pricing filters", () => {
    const parsed = PricingScopePreviewQuerySchema.parse({
      includePending: 'false',
      sites: ['bronx'],
      stockOnly: 'true',
      strict: 'false',
    })
    expect(parsed.includePending).toBe(false)
    expect(parsed.stockOnly).toBe(true)
    expect(parsed.strict).toBe(false)
    expect(parsed.sites).toEqual(['bronx'])
  })

  it('rejects unknown site keys', () => {
    expect(() => PricingScopePreviewQuerySchema.parse({ sites: ['queens'] })).toThrow()
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
