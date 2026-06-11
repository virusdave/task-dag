// Tests for the no-sales plot-default / clamp resolver exported from
// CatalogAnalyticsTab. We build partial CatalogAnalyticsPoint records
// (the resolver only reads a small subset) and a minimal AxisCtx.
import { describe, expect, it } from 'vitest'
import type { CatalogAnalyticsPoint } from '../../../shared/contracts/index.js'
import {
  WEEKS_OF_SUPPLY_CAP,
  hasNoWindowSales,
  plotMetricValue,
  cohortKey,
  type AxisCtx,
} from './CatalogAnalyticsTab.js'

const pt = (over: Partial<CatalogAnalyticsPoint>): CatalogAnalyticsPoint =>
  ({
    inventoryItemId: 'iv-1',
    productName: '',
    categoryName: 'Flower',
    subcategoryName: 'Indoor',
    sizeLabel: '3.5g',
    // sales-driven default to null (the "no window sales" shape)
    unitsSold: null,
    revenueDollars: null,
    cogsDollars: null,
    marginDollars: null,
    marginDollarsPerUnit: null,
    gmPercent: null,
    avgUnitPriceDollars: null,
    otdUnitPriceDollars: null,
    salesVelocityUnitsPerDay: null,
    marginVelocityDollarsPerDay: null,
    invoiceCount: null,
    daysWithSales: null,
    // sales-independent inputs
    listPriceDollars: null,
    wholesaleCostDollars: null,
    currentQty: null,
    taxRatio: 1,
    unitSizeGrams: 3.5,
    unitSizeMg: null,
    marketPricePretaxDollars: null,
    ...over,
  }) as unknown as CatalogAnalyticsPoint

// A cohort whose key matches `pt(...)` defaults above.
const ctx = (over?: Partial<{ velocity: number; otd: number; gm: number }>): AxisCtx => {
  const k = cohortKey(pt({}))
  return {
    windowDays: 90,
    cohortMedians: new Map([
      [
        k,
        {
          velocityUnitsPerDay: over?.velocity ?? 2,
          effectiveOtdPriceDollars: over?.otd ?? 40,
          gmPercent: over?.gm ?? 50,
          marginPerUnitDollars: 12,
        },
      ],
    ]),
  }
}

describe('hasNoWindowSales', () => {
  it('true when units + revenue are null', () => {
    expect(hasNoWindowSales(pt({}))).toBe(true)
  })
  it('false once any sales field is present', () => {
    expect(hasNoWindowSales(pt({ unitsSold: 3, revenueDollars: 100 }))).toBe(false)
  })
})

describe('plotMetricValue — real values pass through (with clamps)', () => {
  it('returns the raw value when present', () => {
    const p = pt({ unitsSold: 5, revenueDollars: 100, gmPercent: 42 })
    expect(plotMetricValue('gmPercent', 42, p, ctx())).toBe(42)
  })
  it('clamps weeks-of-supply to 52 even when sales exist', () => {
    const p = pt({ unitsSold: 1, revenueDollars: 10 })
    expect(plotMetricValue('weeksOfSupplyOnHand', 9999, p, ctx())).toBe(WEEKS_OF_SUPPLY_CAP)
  })
  it('clamps sales-day coverage to [0,100]', () => {
    const p = pt({ unitsSold: 1, revenueDollars: 10 })
    expect(plotMetricValue('salesDayCoveragePercent', 150, p, ctx())).toBe(100)
  })
})

describe('plotMetricValue — no-sales defaults', () => {
  it('gmPercent → list GM% when list+cost present', () => {
    const p = pt({ listPriceDollars: 50, wholesaleCostDollars: 20 })
    // list GM% = (50-20)/50*100 = 60
    expect(plotMetricValue('gmPercent', null, p, ctx())).toBeCloseTo(60)
  })
  it('gmPercent → null (hidden) when cost missing', () => {
    const p = pt({ listPriceDollars: 50, wholesaleCostDollars: null })
    expect(plotMetricValue('gmPercent', null, p, ctx())).toBeNull()
  })
  it('marginVelocityDollarsPerDay → 0 (no movement)', () => {
    expect(plotMetricValue('marginVelocityDollarsPerDay', null, pt({}), ctx())).toBe(0)
  })
  it('salesVelocityUnitsPerDay / unitsSold / revenue / margin → 0', () => {
    const p = pt({})
    expect(plotMetricValue('salesVelocityUnitsPerDay', null, p, ctx())).toBe(0)
    expect(plotMetricValue('unitsSold', null, p, ctx())).toBe(0)
    expect(plotMetricValue('revenueDollars', null, p, ctx())).toBe(0)
    expect(plotMetricValue('marginDollars', null, p, ctx())).toBe(0)
  })
  it('avgUnitPrice → list price; otd → list × tax', () => {
    const p = pt({ listPriceDollars: 30, taxRatio: 1.2 })
    expect(plotMetricValue('avgUnitPriceDollars', null, p, ctx())).toBe(30)
    expect(plotMetricValue('otdUnitPriceDollars', null, p, ctx())).toBeCloseTo(36)
  })
  it('priceRealization → 100, discountDepth → 0 (sold at list)', () => {
    const p = pt({ listPriceDollars: 30 })
    expect(plotMetricValue('priceRealizationPercent', null, p, ctx())).toBe(100)
    expect(plotMetricValue('discountDepthPercent', null, p, ctx())).toBe(0)
  })
  it('weeks-of-supply → 52 with stock, 0 without, null when on-hand unknown', () => {
    expect(plotMetricValue('weeksOfSupplyOnHand', null, pt({ currentQty: 10 }), ctx())).toBe(52)
    expect(plotMetricValue('weeksOfSupplyOnHand', null, pt({ currentQty: 0 }), ctx())).toBe(0)
    expect(plotMetricValue('weeksOfSupplyOnHand', null, pt({ currentQty: null }), ctx())).toBeNull()
  })
  it('gmPercentIndex → listGM − cohortMedianGM', () => {
    const p = pt({ listPriceDollars: 50, wholesaleCostDollars: 20 }) // list GM 60
    expect(plotMetricValue('gmPercentIndex', null, p, ctx({ gm: 50 }))).toBeCloseTo(10)
  })
  it('velocityIndex → 0 when cohort has a positive median velocity', () => {
    expect(plotMetricValue('velocityIndex', null, pt({}), ctx({ velocity: 2 }))).toBe(0)
  })
  it('effectivePriceIndex → listOTD / cohort median OTD', () => {
    const p = pt({ listPriceDollars: 40, taxRatio: 1 })
    expect(plotMetricValue('effectivePriceIndex', null, p, ctx({ otd: 40 }))).toBeCloseTo(1)
  })
  it('totalGramsSold → 0 when size known; null when size unknown', () => {
    expect(plotMetricValue('totalGramsSoldWindow', null, pt({ unitSizeGrams: 3.5 }), ctx())).toBe(0)
    expect(
      plotMetricValue('totalGramsSoldWindow', null, pt({ unitSizeGrams: null }), ctx()),
    ).toBeNull()
  })
})

describe('plotMetricValue — sales-independent / non-defaultable stay null', () => {
  it('lab THC has no no-sales default', () => {
    expect(plotMetricValue('labThcPct', null, pt({}), ctx())).toBeNull()
  })
  it('market price has no no-sales default', () => {
    expect(plotMetricValue('marketPricePretaxDollars', null, pt({}), ctx())).toBeNull()
  })
  it('channel id aliases resolve (price → otd; salesVelocity → velocity)', () => {
    const p = pt({ listPriceDollars: 25, taxRatio: 1 })
    expect(plotMetricValue('price', null, p, ctx())).toBe(25)
    expect(plotMetricValue('salesVelocity', null, pt({}), ctx())).toBe(0)
  })
})
