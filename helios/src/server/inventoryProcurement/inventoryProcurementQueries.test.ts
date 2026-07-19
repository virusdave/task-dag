import { describe, expect, it } from 'vitest'

import {
  applyOrderQuantityTerms,
  deriveOrderCostEconomics,
} from './inventoryProcurementQueries.js'

describe('vendor order quantity terms', () => {
  it('does not apply the legacy 5/10 approximation to a mapped vendor without a case size', () => {
    expect(applyOrderQuantityTerms({
      rawRecommendedQty: 3,
      vendorMapped: true,
      caseSizeUnits: null,
    })).toEqual({ quantity: 3, source: 'vendor_no_case_size' })
  })

  it('rounds to an explicit vendor case size when one becomes available', () => {
    expect(applyOrderQuantityTerms({
      rawRecommendedQty: 26,
      vendorMapped: true,
      caseSizeUnits: 25,
    })).toEqual({ quantity: 50, source: 'vendor_case_size' })
  })

  it('retains the documented 5-unit / 10-unit fallback only for unmapped brands', () => {
    expect(applyOrderQuantityTerms({
      rawRecommendedQty: 3,
      vendorMapped: false,
      caseSizeUnits: null,
    })).toEqual({ quantity: 10, source: 'unmapped_brand_fallback' })
    expect(applyOrderQuantityTerms({
      rawRecommendedQty: 12,
      vendorMapped: false,
      caseSizeUnits: null,
    })).toEqual({ quantity: 15, source: 'unmapped_brand_fallback' })
  })
})

describe('server order-cost derivation', () => {
  it('preserves unknown cost instead of manufacturing zero-cost margin economics', () => {
    expect(deriveOrderCostEconomics({
      avgUnitPrice: 30,
      unitCostCurrent: null,
      recommendedQty: 12,
    })).toEqual({
      unitMargin: null,
      gmPct: null,
      recommendedCost: 0,
      recommendedCostKnown: false,
    })
  })

  it('derives margin and extended cost only from a known unit cost', () => {
    expect(deriveOrderCostEconomics({
      avgUnitPrice: 30,
      unitCostCurrent: 10,
      recommendedQty: 12,
    })).toEqual({
      unitMargin: 20,
      gmPct: 2 / 3,
      recommendedCost: 120,
      recommendedCostKnown: true,
    })
  })
})
