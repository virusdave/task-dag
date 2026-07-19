import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

// Covers both pure basket construction and the server-rendered operator board.
import type { InventoryProcurementResponse, InventorySkuRow } from '../../../shared/contracts/index.js'
import {
  BASKET_CSV_HEADER,
  basketCsvRows,
  buildVendorBaskets,
  csvCell,
  VendorBasketsView,
} from './InventoryProcurementTab.js'

function sku(overrides: Partial<InventorySkuRow> = {}): InventorySkuRow {
  return {
    dealerId: 1,
    siteKey: 'bronx',
    siteLabel: 'Bronx',
    productId: 101,
    productName: 'Product',
    productSku: 'SKU-1',
    categoryName: 'Flower',
    subcategoryName: null,
    brandName: 'Brand One',
    listPrice: 30,
    lifetimeUnitsSold: 10,
    lifetimeSoldRevenue: 300,
    vendorId: 9,
    vendorName: 'Canonical Vendor',
    vendorTargetDaysOnHand: 18,
    vendorMinimumOrderDollars: 500,
    caseSizeUnits: null,
    quantityRuleSource: 'vendor_no_case_size',
    distributorName: 'Distributor A',
    distributorNames: ['Distributor A'],
    physicalUnits: 0,
    heldUnits: 0,
    sellableUnits: 0,
    onHandCost: 0,
    unitCostCurrent: 10,
    packageCount: 0,
    hiddenStock: false,
    firstReceivedAt: null,
    avgInventoryAgeDays: null,
    nearestExpiration: null,
    daysToNearestExpiration: null,
    expiringUnits60: 0,
    expiringCost60: 0,
    snapshotAgeHours: 1,
    units7: 7,
    units28: 28,
    units90: 90,
    revenueWindow: 840,
    marginWindow: 560,
    avgUnitPrice: 30,
    unitMargin: 20,
    gmPct: 2 / 3,
    lastSaleAt: '2026-07-18T12:00:00.000Z',
    velocity: 1,
    forecastDailyUnits: 1,
    daysSupply: 0,
    projectedStockoutAt: '2026-07-19T12:00:00.000Z',
    leadTimeDays: 7,
    cadenceDays: 14,
    reorderPointDays: 9,
    targetCoverDays: 18,
    recommendedQty: 10,
    recommendedCost: 100,
    recommendedCostKnown: true,
    orderByDate: '2026-07-12T12:00:00.000Z',
    coverageAfterSnappedOrderDays: 10,
    minOrderOvershootsTarget: false,
    suppressedRecommendedQty: null,
    lostMarginPerDay: 20,
    expectedMarginLossBeforeReplenishment: 180,
    reorderPriorityScore: 80,
    deadweightScore: 0,
    confidenceScore: 1,
    reorderFactors: [],
    deadweightFactors: [],
    recentSeller: true,
    outRegretted: true,
    doNotReorder: false,
    action: 'order_now',
    ...overrides,
  }
}

function response(skus: InventorySkuRow[]): InventoryProcurementResponse {
  return {
    asOf: '2026-07-19T12:00:00.000Z',
    generatedAt: '2026-07-19T12:00:00.000Z',
    params: { windowDays: 28, defaultLeadDays: 7, sites: ['bronx'] },
    summary: {
      skuCount: skus.length,
      totalOnHandCost: 0,
      outRegrettedCount: skus.length,
      outRegrettedLostMarginPerDay: 40,
      soonOutCount: skus.length,
      recommendedOrderCostTotal: 200,
      recommendedOrderCostComplete: true,
      deadweightCapital: 0,
      zeroVelocityCapital: 0,
      expiringSoonCost: 0,
      lowConfidenceCount: 0,
    },
    skus,
    distributors: [
      { dealerId: 1, siteKey: 'bronx', distributorName: 'Distributor A', leadTimeDays: 7, cadenceDays: 14, lastDeliveryDate: null, poCount: 2 },
      { dealerId: 1, siteKey: 'bronx', distributorName: 'Distributor B', leadTimeDays: 7, cadenceDays: 10, lastDeliveryDate: null, poCount: 3 },
    ],
    categoryOverhang: [],
    methodology: [],
  }
}

describe('vendor baskets', () => {
  it('groups one vendor across distributor fulfillment and evaluates its basket minimum', () => {
    const baskets = buildVendorBaskets(response([
      sku(),
      sku({
        productId: 102,
        productName: 'Second product',
        distributorName: 'Distributor B',
        distributorNames: ['Distributor B'],
      }),
    ]))

    expect(baskets).toHaveLength(1)
    expect(baskets[0]).toMatchObject({
      vendorName: 'Canonical Vendor',
      vendorMapped: true,
      distributorNames: ['Distributor A', 'Distributor B'],
      minimumOrderDollars: 500,
      minimumGapDollars: 300,
      basketCost: 200,
      guidance: 'order_now',
    })
  })

  it('labels unmapped-brand fallback terms in the CSV', () => {
    const baskets = buildVendorBaskets(response([
      sku({
        vendorId: null,
        vendorName: null,
        vendorTargetDaysOnHand: null,
        vendorMinimumOrderDollars: null,
        quantityRuleSource: 'unmapped_brand_fallback',
      }),
    ]))
    const rows = basketCsvRows(baskets)

    expect(BASKET_CSV_HEADER).toContain('Vendor')
    expect(BASKET_CSV_HEADER).toContain('Fulfillment distributor')
    expect(BASKET_CSV_HEADER).toContain('Case size units')
    expect(rows[0]).toContain('Brand One (vendor unmapped)')
    expect(rows[0]).toContain('Fallback: 5-unit multiple / 10-unit minimum')
  })

  it('retains urgent quantity guidance when cost and minimum status are unknown', () => {
    const baskets = buildVendorBaskets(response([
      sku({ unitCostCurrent: null, recommendedCost: 0, recommendedCostKnown: false }),
    ]))

    expect(baskets).toHaveLength(1)
    expect(baskets[0]).toMatchObject({
      guidance: 'order_now',
      basketCostKnown: false,
      minimumGapDollars: null,
      basketUnits: 10,
    })
    expect(basketCsvRows(baskets)[0]).toContain('')
  })

  it('uses per-line distributor timing and suppresses synthetic vendor cadence', () => {
    const data = response([
      sku(),
      sku({
        productId: 102,
        productName: 'Second product',
        distributorName: 'Distributor B',
        distributorNames: ['Distributor B'],
      }),
    ])
    data.distributors[0] = { ...data.distributors[0]!, leadTimeDays: 2, cadenceDays: 7 }
    data.distributors[1] = { ...data.distributors[1]!, leadTimeDays: 20, cadenceDays: 30 }
    const basket = buildVendorBaskets(data)[0]!

    expect(basket.cadenceDays).toBeNull()
    expect(basket.waitDays).toBeNull()
    expect(basket.lines.map((line) => line.lossIfOrderNow).sort((a, b) => a - b)).toEqual([40, 400])
  })

  it('suppresses aggregate cadence when one of multiple distributors has no stats', () => {
    const basket = buildVendorBaskets(response([
      sku({
        distributorName: null,
        distributorNames: ['Distributor A', 'Untracked Distributor'],
      }),
    ]))[0]!

    expect(basket.distributorNames).toEqual(['Distributor A', 'Untracked Distributor'])
    expect(basket.cadenceDays).toBeNull()
    expect(basket.waitDays).toBeNull()
    expect(basket.economicsKnown).toBe(false)
    expect(basket.lines[0]?.economicsKnown).toBe(false)
    expect(basketCsvRows([basket]).at(0)?.at(-1)).toBe('')
  })

  it('does not let an excluded urgent deadweight line make the basket urgent', () => {
    const basket = buildVendorBaskets(response([
      sku({ daysSupply: 20, outRegretted: false, reorderPriorityScore: 60 }),
      sku({
        productId: 102,
        doNotReorder: true,
        outRegretted: true,
        action: 'liquidate_now',
      }),
    ]))[0]!

    expect(basket.lines).toHaveLength(1)
    expect(basket.excludedLines).toHaveLength(1)
    expect(basket.urgentCount).toBe(0)
    expect(basket.outRegrettedCount).toBe(0)
    expect(basket.guidance).toBe('wait')
  })

  it('does not show fallback timing economics for an excluded line with ambiguous fulfillment', () => {
    const basket = buildVendorBaskets(response([
      sku(),
      sku({
        productId: 102,
        reorderPriorityScore: 10,
        outRegretted: false,
        daysSupply: 20,
        distributorName: null,
        distributorNames: ['Distributor A', 'Untracked Distributor'],
      }),
    ]))[0]!

    expect(basket.excludedLines).toHaveLength(1)
    expect(basket.excludedLines[0]?.economicsKnown).toBe(false)
    expect(basket.excludedLines[0]?.excludeReason).toContain('early-order value unavailable')
    expect(basket.excludedLines[0]?.excludeReason).not.toContain('$')
  })

  it('neutralizes formula-leading external strings in CSV cells', () => {
    expect(csvCell('=HYPERLINK("bad")')).toBe("\"'=HYPERLINK(\"\"bad\"\")\"")
    expect(csvCell('+SUM(1,2)')).toBe("\"'+SUM(1,2)\"")
    expect(csvCell('ordinary')).toBe('ordinary')
  })

  it('renders an accessible compact vendor summary with separate timing and minimum status', () => {
    const html = renderToStaticMarkup(
      <VendorBasketsView
        data={response([sku()])}
        expandedSku={null}
        onToggleExpand={() => undefined}
        sites={new Set(['bronx'])}
      />,
    )

    expect(html).toContain('Vendor order board')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('ORDER NOW')
    expect(html).toContain('$400 short of $500 minimum')
    expect(html).toContain('inv-proc-basket-mobile-summary')
    expect(html).toContain('Distributor A')
  })
})
