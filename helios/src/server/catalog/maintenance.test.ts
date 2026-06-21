import { describe, expect, it } from 'vitest'

import type { CatalogMaintenancePackageLot } from '../../shared/contracts/api/catalogMaintenance.js'
import {
  classifyPackageBarcode,
  lotsNeedBarcode,
  packageLotIsActionable,
  rollUpVariantBarcode,
} from './maintenance.js'

/**
 * Build a package lot with sensible defaults (actionable, real barcode).
 * Override only what each case cares about.
 */
function lot(overrides: Partial<CatalogMaintenancePackageLot> = {}): CatalogMaintenancePackageLot {
  const inventoryBarcode = overrides.inventoryBarcode ?? '810171511027'
  const classified = classifyPackageBarcode(inventoryBarcode)
  return {
    itemId: 'item-1',
    externalTrackCode: '1A4120300000285000004845',
    stockLocationId: 1,
    stockLocationName: 'FOR SALE - Midtown',
    stockTypeId: 1,
    stockTypeName: 'Sellable',
    availableQty: 5,
    isForSale: true,
    isTradeSample: false,
    warehouseLocationCode: null,
    inventoryBarcode,
    packageBarcodeStatus: classified.status,
    packageBarcodeIssueReason: classified.reason,
    ...overrides,
  }
}

describe('classifyPackageBarcode', () => {
  it('treats null/empty/whitespace as missing', () => {
    expect(classifyPackageBarcode(null).status).toBe('missing')
    expect(classifyPackageBarcode('').status).toBe('missing')
    expect(classifyPackageBarcode('   ').status).toBe('missing')
  })

  it('treats the whole Sweed "25…" EAN-13 family as invalid', () => {
    for (const value of [
      '2500000000812',
      '2500000007552',
      '2500000026003', // top of the observed live range
      '  2500000012345  ',
      // Forward-proofing: the counter is an integer that keeps growing.
      // Once it rolls past 5 digits the suffix gains digits — these MUST
      // still be caught (the old `^25000000\d{5}$` would have missed them).
      '2500000112345', // 6-digit-counter neighbour, still the 25 family
      '2599999999998', // far-future counter, top of the 13-digit 25 block
    ]) {
      expect(classifyPackageBarcode(value).status, value).toBe('invalid')
    }
  })

  it('accepts real manufacturer barcodes, including other "2…" / date-coded values', () => {
    for (const value of [
      '810171511027', // UPC-A
      '852873008665',
      '9780251379520', // EAN-13
      '2025112110355', // date-coded, starts with 20 — NOT the 25 family
      '2315613336', // real "2…" prefix, not 25 / not 13 digits
      '250000007552', // only 12 digits — not the 13-digit 25 family
      '2400000012345', // 13-digit "24…" neighbour — wrong prefix
    ]) {
      expect(classifyPackageBarcode(value).status, value).toBe('ok')
    }
  })
})

describe('packageLotIsActionable', () => {
  it('requires for-sale, non-trade-sample, positive qty', () => {
    expect(packageLotIsActionable(lot())).toBe(true)
    expect(packageLotIsActionable(lot({ isForSale: false }))).toBe(false)
    expect(packageLotIsActionable(lot({ isTradeSample: true }))).toBe(false)
    expect(packageLotIsActionable(lot({ availableQty: 0 }))).toBe(false)
    expect(packageLotIsActionable(lot({ availableQty: null }))).toBe(false)
  })
})

describe('lotsNeedBarcode', () => {
  it('flags a variant when ANY actionable package has a missing/placeholder barcode', () => {
    // Real barcode on one package, Sweed placeholder on another package of
    // the same variant: the variant still needs work.
    const lots = [
      lot({ itemId: 'a', inventoryBarcode: '852873008665' }),
      lot({ itemId: 'b', inventoryBarcode: '2500000006234' }),
    ]
    expect(lotsNeedBarcode(lots)).toBe(true)
  })

  it('does not flag when all actionable packages have real barcodes', () => {
    const lots = [
      lot({ itemId: 'a', inventoryBarcode: '852873008665' }),
      lot({ itemId: 'b', inventoryBarcode: '810171511027' }),
    ]
    expect(lotsNeedBarcode(lots)).toBe(false)
  })

  it('ignores trade-sample / not-for-sale / zero-qty packages with bad barcodes', () => {
    const lots = [
      lot({ itemId: 'a', inventoryBarcode: '852873008665' }), // good, actionable
      lot({ itemId: 'b', inventoryBarcode: '', isTradeSample: true }),
      lot({ itemId: 'c', inventoryBarcode: '', isForSale: false }),
      lot({ itemId: 'd', inventoryBarcode: '', availableQty: 0 }),
    ]
    expect(lotsNeedBarcode(lots)).toBe(false)
  })

  it('returns false for an empty lot list', () => {
    expect(lotsNeedBarcode([])).toBe(false)
  })
})

describe('rollUpVariantBarcode', () => {
  it('is ok when no actionable package needs a barcode', () => {
    expect(rollUpVariantBarcode([lot()]).status).toBe('ok')
    expect(rollUpVariantBarcode([lot()]).reason).toBeNull()
  })

  it('reports missing when an actionable package has no barcode', () => {
    const roll = rollUpVariantBarcode([lot({ inventoryBarcode: '' })])
    expect(roll.status).toBe('missing')
    expect(roll.reason).toContain('1 package')
  })

  it('reports invalid (placeholder) when the only problem is a Sweed placeholder', () => {
    const roll = rollUpVariantBarcode([lot({ inventoryBarcode: '2500000006234' })])
    expect(roll.status).toBe('invalid')
    expect(roll.reason).toContain('Sweed placeholder')
  })

  it('prefers "missing" status and summarizes both kinds when mixed', () => {
    const roll = rollUpVariantBarcode([
      lot({ itemId: 'a', inventoryBarcode: '' }),
      lot({ itemId: 'b', inventoryBarcode: '2500000006234' }),
      lot({ itemId: 'c', inventoryBarcode: '852873008665' }),
    ])
    expect(roll.status).toBe('missing')
    expect(roll.reason).toContain('2 packages')
    expect(roll.reason).toContain('no barcode')
    expect(roll.reason).toContain('Sweed placeholder')
  })
})
