import { describe, expect, it } from 'vitest'

import {
  computeMarketGate,
  computePriceGate,
  computeProductsWithOnFloorStock,
  evaluateItemQuarantine,
  evaluateItemReleased,
  isForSaleStockLocationName,
  PRICE_EQUALITY_TOLERANCE_DOLLARS,
  type LiveLot,
} from './purchaseInventoryLifecycleGates.js'

describe('isForSaleStockLocationName', () => {
  it('treats only "for sale …" prefixes as sellable', () => {
    expect(isForSaleStockLocationName('FOR SALE - Sales Floor')).toBe(true)
    expect(isForSaleStockLocationName('for sale - back')).toBe(true)
    expect(isForSaleStockLocationName('  For Sale - X  ')).toBe(true)
  })

  it('treats not-for-sale / inspection rooms as non-sellable', () => {
    expect(isForSaleStockLocationName('NOT FOR SALE - Hold for Dave inspection')).toBe(false)
    expect(isForSaleStockLocationName('Quarantine')).toBe(false)
    expect(isForSaleStockLocationName('Reception')).toBe(false)
    expect(isForSaleStockLocationName(null)).toBe(false)
    expect(isForSaleStockLocationName(undefined)).toBe(false)
  })
})

describe('evaluateItemQuarantine', () => {
  const expected = { inventoryItemId: 'item-1', metrcTag: 'TAG-1' }

  it('flags a positive-qty lot still in a FOR SALE room as NOT quarantined', () => {
    const verdict = evaluateItemQuarantine(expected, [
      { inventoryItemId: 'item-1', metrcTag: 'TAG-1', qty: 5, stockLocationName: 'FOR SALE - Sales Floor' },
    ])
    expect(verdict.quarantined).toBe(false)
    expect(verdict.currentQty).toBe(5)
    expect(verdict.stockLocation).toBe('FOR SALE - Sales Floor')
  })

  it('treats a positive-qty lot in a NOT-FOR-SALE room as quarantined', () => {
    const verdict = evaluateItemQuarantine(expected, [
      {
        inventoryItemId: 'item-1',
        metrcTag: 'TAG-1',
        qty: 5,
        stockLocationName: 'NOT FOR SALE - Hold for Dave inspection',
      },
    ])
    expect(verdict.quarantined).toBe(true)
  })

  it('matches by METRC tag when the inventory item id changed across a move', () => {
    const verdict = evaluateItemQuarantine(expected, [
      { inventoryItemId: 'item-99', metrcTag: 'TAG-1', qty: 3, stockLocationName: 'Quarantine' },
    ])
    expect(verdict.quarantined).toBe(true)
    expect(verdict.currentQty).toBe(3)
  })

  it('treats a gone / zero-qty lot as quarantined (not sellable)', () => {
    expect(evaluateItemQuarantine(expected, []).quarantined).toBe(true)
    expect(
      evaluateItemQuarantine(expected, [
        { inventoryItemId: 'item-1', metrcTag: 'TAG-1', qty: 0, stockLocationName: 'FOR SALE - Sales Floor' },
      ]).quarantined,
    ).toBe(true)
  })

  it('flags as sellable if ANY positive-qty matching lot is for sale (split lots)', () => {
    const verdict = evaluateItemQuarantine(expected, [
      { inventoryItemId: 'item-1', metrcTag: 'TAG-1', qty: 2, stockLocationName: 'Quarantine' },
      { inventoryItemId: 'item-1', metrcTag: 'TAG-1', qty: 1, stockLocationName: 'FOR SALE - Sales Floor' },
    ])
    expect(verdict.quarantined).toBe(false)
  })
})

describe('computeMarketGate', () => {
  it('is ready only when every expected product has a fresh observation', () => {
    expect(computeMarketGate([1, 2, 3], new Set([1, 2, 3]))).toEqual({
      pendingProductIds: [],
      ready: true,
    })
    expect(computeMarketGate([1, 2, 3], new Set([1, 3]))).toEqual({
      pendingProductIds: [2],
      ready: false,
    })
  })

  it('is not ready when there are no expected products', () => {
    expect(computeMarketGate([], new Set())).toEqual({ pendingProductIds: [], ready: false })
  })
})

describe('computePriceGate', () => {
  it('verifies when every product is approved and live matches within 1¢', () => {
    const result = computePriceGate([
      { productId: 1, approvedPriceDollars: 24.99, livePriceDollars: 24.99 },
      { productId: 2, approvedPriceDollars: 50, livePriceDollars: 50.009 },
    ])
    expect(result.verified).toBe(true)
    expect(result.unapprovedProductIds).toEqual([])
    expect(result.unverifiedProductIds).toEqual([])
  })

  it('flags unapproved products separately from unverified ones', () => {
    const result = computePriceGate([
      { productId: 1, approvedPriceDollars: null, livePriceDollars: 24.99 },
      { productId: 2, approvedPriceDollars: 50, livePriceDollars: 48 },
      { productId: 3, approvedPriceDollars: 10, livePriceDollars: null },
    ])
    expect(result.verified).toBe(false)
    expect(result.unapprovedProductIds).toEqual([1])
    expect(result.unverifiedProductIds).toEqual([2, 3])
  })

  it('treats a difference clearly above the tolerance as not settled', () => {
    const result = computePriceGate([
      { productId: 1, approvedPriceDollars: 10, livePriceDollars: 10 + 2 * PRICE_EQUALITY_TOLERANCE_DOLLARS },
    ])
    expect(result.unverifiedProductIds).toEqual([1])
  })

  it('treats a sub-cent difference as settled (matches waitForProductPrice)', () => {
    const result = computePriceGate([
      { productId: 1, approvedPriceDollars: 10, livePriceDollars: 10.005 },
    ])
    expect(result.verified).toBe(true)
  })

  it('is not verified with no products', () => {
    expect(computePriceGate([]).verified).toBe(false)
  })
})

describe('evaluateItemReleased', () => {
  const expected = { inventoryItemId: 'item-1', metrcTag: 'TAG-1' }

  it('reports released + sellable when the matching lot is positive-qty in a FOR SALE room', () => {
    const verdict = evaluateItemReleased(expected, [
      { inventoryItemId: 'item-1', metrcTag: 'TAG-1', qty: 7, stockLocationName: 'FOR SALE - Sales Floor' },
    ])
    expect(verdict.released).toBe(true)
    expect(verdict.sellable).toBe(true)
    expect(verdict.currentQty).toBe(7)
    expect(verdict.stockLocation).toBe('FOR SALE - Sales Floor')
  })

  it('is NOT released while a positive-qty matching lot is still in a not-for-sale room', () => {
    const verdict = evaluateItemReleased(expected, [
      {
        inventoryItemId: 'item-1',
        metrcTag: 'TAG-1',
        qty: 4,
        stockLocationName: 'NOT FOR SALE - Hold for Dave inspection',
      },
    ])
    expect(verdict.released).toBe(false)
    expect(verdict.sellable).toBe(false)
  })

  it('is NOT released when some matching lots are sellable but one is still quarantined', () => {
    const verdict = evaluateItemReleased(expected, [
      { inventoryItemId: 'item-1', metrcTag: 'TAG-1', qty: 2, stockLocationName: 'FOR SALE - Sales Floor' },
      { inventoryItemId: 'item-9', metrcTag: 'TAG-1', qty: 1, stockLocationName: 'Quarantine' },
    ])
    expect(verdict.released).toBe(false)
    // A sellable lot exists even though not all are sellable yet.
    expect(verdict.sellable).toBe(true)
  })

  it('treats a gone / zero-qty lot as released (nothing left on the floor unpriced)', () => {
    const verdict = evaluateItemReleased(expected, [])
    expect(verdict.released).toBe(true)
    expect(verdict.sellable).toBe(false)
    expect(verdict.currentQty).toBe(0)
  })

  it('matches by METRC tag when the inventory item id changed across the move', () => {
    const verdict = evaluateItemReleased(expected, [
      { inventoryItemId: 'item-77', metrcTag: 'TAG-1', qty: 3, stockLocationName: 'FOR SALE - Back' },
    ])
    expect(verdict.released).toBe(true)
    expect(verdict.sellable).toBe(true)
  })
})

describe('computeProductsWithOnFloorStock', () => {
  it('returns only the products that currently have positive-qty FOR SALE stock', () => {
    const byProduct = new Map<number, LiveLot[]>([
      [1, [{ inventoryItemId: 'a', metrcTag: null, qty: 5, stockLocationName: 'FOR SALE - Sales Floor' }]],
      [2, [{ inventoryItemId: 'b', metrcTag: null, qty: 5, stockLocationName: 'Quarantine' }]],
      [3, [{ inventoryItemId: 'c', metrcTag: null, qty: 0, stockLocationName: 'FOR SALE - Sales Floor' }]],
      // 4 has no live lots at all.
    ])
    expect(computeProductsWithOnFloorStock([1, 2, 3, 4], byProduct)).toEqual([1])
  })

  it('returns an empty list when nothing is on the floor', () => {
    expect(computeProductsWithOnFloorStock([1, 2], new Map())).toEqual([])
  })
})
