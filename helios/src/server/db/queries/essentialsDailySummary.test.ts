import { describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'

import type { Queryable } from '../pool.js'
import { loadEssentialsDailySummary } from './essentialsDailySummary.js'

/**
 * Step-keyed mock: each query returns a canned result in the order
 * the implementation runs them. The order is:
 *   1. NY-day boundary (one row).
 *   2. orders header per dealer.
 *   3. margin per dealer.
 *   4. scans per site_slug.
 * The latter three run in parallel via Promise.all, but the mock
 * still dispatches them sequentially because it inspects the query
 * text to pick the right canned response — this keeps the test
 * order-agnostic (independent of which Promise.all branch lands
 * first under any given Node scheduler).
 */
function mockPool(canned: {
  dayRow: { startIso: string; endIso: string; nyDate: string }
  ordersRows: Array<{
    dealer_id: number
    new_purchases: number
    returning_purchases: number
    gross_receipts: number
    gross_sales: number
    net_sales: number
  }>
  marginRows: Array<{
    dealer_id: number
    priced_revenue: number
    priced_cogs: number
  }>
  scanRows: Array<{
    site_slug: string
    new_scans: number
    returning_scans: number
  }>
}): Queryable {
  return {
    async query<TResult extends QueryResultRow>(text: string, _params?: unknown[]) {
      const dispatch = (rows: unknown[]): QueryResult<TResult> => ({
        command: 'SELECT',
        fields: [],
        oid: 0,
        rowCount: rows.length,
        rows: rows as TResult[],
      })
      if (text.includes('to_char(now()')) {
        return dispatch([
          {
            start_iso: canned.dayRow.startIso,
            end_iso: canned.dayRow.endIso,
            ny_date: canned.dayRow.nyDate,
          },
        ])
      }
      if (text.includes('todays_orders')) {
        return dispatch(canned.ordersRows)
      }
      if (text.includes('todays_items')) {
        return dispatch(canned.marginRows)
      }
      if (text.includes('todays_scans')) {
        return dispatch(canned.scanRows)
      }
      throw new Error(`unexpected query in mockPool: ${text.slice(0, 80)}`)
    },
  }
}

describe('loadEssentialsDailySummary', () => {
  it('produces per-site rows + totals, aggregating GM% as a ratio not an average', async () => {
    const db = mockPool({
      dayRow: {
        startIso: '2026-06-03T04:00:00.000Z',
        endIso: '2026-06-03T17:30:00.000Z',
        nyDate: '2026-06-03',
      },
      ordersRows: [
        {
          dealer_id: 210249,
          new_purchases: 1,
          returning_purchases: 18,
          gross_receipts: 550.8,
          gross_sales: 487.4,
          net_sales: 487.4,
        },
        {
          dealer_id: 210705,
          new_purchases: 14,
          returning_purchases: 5,
          gross_receipts: 1113.25,
          gross_sales: 985.29,
          net_sales: 985.29,
        },
      ],
      marginRows: [
        // Bronx: 75% GM on $400; Midtown: 50% GM on $800 — the
        // average of the percentages (62.5%) is NOT what the totals
        // row should show. The correct aggregate ratio is
        // (300 + 400) / (400 + 800) = 700 / 1200 = 58.33%.
        { dealer_id: 210249, priced_revenue: 400, priced_cogs: 100 },
        { dealer_id: 210705, priced_revenue: 800, priced_cogs: 400 },
      ],
      scanRows: [
        { site_slug: 'bx', new_scans: 1, returning_scans: 10 },
        { site_slug: 'mh', new_scans: 17, returning_scans: 1 },
      ],
    })

    const result = await loadEssentialsDailySummary(db)

    expect(result.today.nyDate).toBe('2026-06-03')
    expect(result.sites).toHaveLength(2)
    expect(result.sites[0]).toMatchObject({
      siteKey: 'bronx',
      siteLabel: 'Bronx',
      newScans: 1,
      returningScans: 10,
      newPurchases: 1,
      returningPurchases: 18,
      grossReceiptsDollars: 550.8,
      grossSalesDollars: 487.4,
      netSalesDollars: 487.4,
      marginDollars: 300,
      gmPct: 0.75,
      marginCoverageDollars: 400,
    })
    expect(result.sites[1]).toMatchObject({
      siteKey: 'midtown',
      siteLabel: 'Midtown',
      newScans: 17,
      returningScans: 1,
      newPurchases: 14,
      returningPurchases: 5,
      grossReceiptsDollars: 1113.25,
      grossSalesDollars: 985.29,
      netSalesDollars: 985.29,
      marginDollars: 400,
      gmPct: 0.5,
      marginCoverageDollars: 800,
    })

    // Totals row — GM% is the aggregate ratio (58.33%), not the
    // per-site average (62.5%). Sums are exact (no float drift on
    // these specific inputs).
    expect(result.totals).toMatchObject({
      siteKey: 'totals',
      siteLabel: 'Totals',
      newScans: 18,
      returningScans: 11,
      newPurchases: 15,
      returningPurchases: 23,
      grossReceiptsDollars: 1664.05,
      grossSalesDollars: 1472.69,
      netSalesDollars: 1472.69,
      marginDollars: 700,
      marginCoverageDollars: 1200,
    })
    expect(result.totals.gmPct).not.toBeNull()
    expect(result.totals.gmPct!).toBeCloseTo(700 / 1200, 4)
  })

  it('returns gmPct = null on the totals row when no line items carry a known cost', async () => {
    const db = mockPool({
      dayRow: {
        startIso: '2026-06-03T04:00:00.000Z',
        endIso: '2026-06-03T05:00:00.000Z',
        nyDate: '2026-06-03',
      },
      ordersRows: [
        {
          dealer_id: 210249,
          new_purchases: 0,
          returning_purchases: 2,
          gross_receipts: 100,
          gross_sales: 90,
          net_sales: 90,
        },
      ],
      marginRows: [], // no priced line items today
      scanRows: [],
    })

    const result = await loadEssentialsDailySummary(db)
    expect(result.sites[0].gmPct).toBeNull()
    expect(result.sites[0].marginDollars).toBe(0)
    expect(result.totals.gmPct).toBeNull()
    expect(result.totals.marginDollars).toBe(0)
  })

  it('produces zero-valued rows for sites with no activity today', async () => {
    const db = mockPool({
      dayRow: {
        startIso: '2026-06-03T04:00:00.000Z',
        endIso: '2026-06-03T05:00:00.000Z',
        nyDate: '2026-06-03',
      },
      ordersRows: [],
      marginRows: [],
      scanRows: [],
    })

    const result = await loadEssentialsDailySummary(db)
    expect(result.sites).toHaveLength(2)
    for (const row of result.sites) {
      expect(row.newScans).toBe(0)
      expect(row.returningScans).toBe(0)
      expect(row.newPurchases).toBe(0)
      expect(row.returningPurchases).toBe(0)
      expect(row.grossSalesDollars).toBe(0)
      expect(row.gmPct).toBeNull()
    }
    expect(result.totals.newScans).toBe(0)
    expect(result.totals.grossSalesDollars).toBe(0)
    expect(result.totals.gmPct).toBeNull()
  })
})
