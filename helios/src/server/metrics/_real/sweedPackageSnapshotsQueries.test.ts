import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import * as poolModule from '../../db/pool.js'
import {
  queryCategoryMarginStack,
  queryEffectiveGmPct,
  queryFulfillmentEffectiveGmPct,
  queryFulfillmentMarginDollars,
  queryGrossMarginDollars,
  queryInventoryCostDistribution,
  queryMarginStackNewVsReturning,
} from './sweedPackageSnapshotsQueries.js'

/**
 * Unit tests for the COGS / margin / inventory query helpers added
 * under automation#24. We stub the pg pool to return shaped result
 * sets and assert (a) the bucket-key merge attributes values to the
 * correct UTC bucket (the same regression the orders queries had on
 * 2026-05-26), (b) the SQL emitted joins through
 * `sweed_package_cost_as_of_or_earliest`, and (c) margin calculation
 * uses revenue - cogs correctly.
 */
describe('sweed-package-snapshot metric queries', () => {
  const originalTZ = process.env.TZ

  beforeEach(() => {
    process.env.TZ = 'America/Panama'
  })
  afterEach(() => {
    process.env.TZ = originalTZ
    vi.restoreAllMocks()
  })

  function mockPool(returnRows: unknown[], captureSql?: (sql: string) => void) {
    const fakePool = {
      query: vi.fn().mockImplementation((sql: string) => {
        captureSql?.(sql)
        return Promise.resolve({ rows: returnRows })
      }),
    }
    vi.spyOn(poolModule, 'getPool').mockReturnValue(fakePool as unknown as ReturnType<typeof poolModule.getPool>)
    return fakePool
  }

  it('queryGrossMarginDollars attributes (revenue - cogs) to the correct UTC bucket', async () => {
    mockPool([
      { bucket_start: new Date('2026-05-18T00:00:00.000Z'), series_id: 'gm_dollars', revenue: '1000.00', cogs: '550.00' },
    ])
    const rows = await queryGrossMarginDollars({
      sites: [],
      from: new Date('2026-05-18T00:00:00.000Z'),
      to: new Date('2026-05-25T00:00:00.000Z'),
      agg: 'week',
    })
    const target = rows.find((r) => r.t === '2026-05-18T00:00:00.000Z')
    expect(target, 'expected bucket row to merge by ISO key').toBeDefined()
    expect(target!.gm_dollars).toBe(450)
  })

  it('queryEffectiveGmPct returns null on empty buckets (not zero)', async () => {
    mockPool([])
    const rows = await queryEffectiveGmPct({
      sites: [],
      from: new Date('2026-05-18T00:00:00.000Z'),
      to: new Date('2026-05-25T00:00:00.000Z'),
      agg: 'week',
    })
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.gm_pct).toBeNull()
    }
  })

  it('queryEffectiveGmPct computes ratio = (revenue - cogs) / revenue', async () => {
    mockPool([
      { bucket_start: new Date('2026-05-18T00:00:00.000Z'), series_id: 'gm_pct', revenue: '1000', cogs: '450' },
    ])
    const rows = await queryEffectiveGmPct({
      sites: [],
      from: new Date('2026-05-18T00:00:00.000Z'),
      to: new Date('2026-05-25T00:00:00.000Z'),
      agg: 'week',
    })
    const target = rows.find((r) => r.t === '2026-05-18T00:00:00.000Z')
    expect(target!.gm_pct).toBeCloseTo(0.55, 4)
  })

  it('queryMarginStackNewVsReturning fills both first_time / returning series', async () => {
    mockPool([
      { bucket_start: new Date('2026-05-18T00:00:00.000Z'), series_id: 'first_time', revenue: '500', cogs: '200' },
      { bucket_start: new Date('2026-05-18T00:00:00.000Z'), series_id: 'returning', revenue: '800', cogs: '400' },
    ])
    const rows = await queryMarginStackNewVsReturning({
      sites: [],
      from: new Date('2026-05-18T00:00:00.000Z'),
      to: new Date('2026-05-25T00:00:00.000Z'),
      agg: 'week',
    })
    const target = rows.find((r) => r.t === '2026-05-18T00:00:00.000Z')
    expect(target!.first_time).toBe(300)
    expect(target!.returning).toBe(400)
  })

  it('queryCategoryMarginStack bins live category names into the declared series', async () => {
    mockPool([
      { bucket_start: new Date('2026-05-18T00:00:00.000Z'), cat_value: 'pre-rolls', revenue: '500', cogs: '200' },
      { bucket_start: new Date('2026-05-18T00:00:00.000Z'), cat_value: 'flower', revenue: '800', cogs: '400' },
      { bucket_start: new Date('2026-05-18T00:00:00.000Z'), cat_value: 'beverages', revenue: '100', cogs: '60' },
    ])
    const rows = await queryCategoryMarginStack({
      sites: [],
      from: new Date('2026-05-18T00:00:00.000Z'),
      to: new Date('2026-05-25T00:00:00.000Z'),
      agg: 'week',
    })
    const target = rows.find((r) => r.t === '2026-05-18T00:00:00.000Z')!
    expect(target.preroll).toBe(300)
    expect(target.flower).toBe(400)
    // beverages → 'other' bucket
    expect(target.other).toBe(40)
    // unmentioned categories default to 0
    expect(target.vape).toBe(0)
  })

  it('queryFulfillmentMarginDollars bins live fulfillment values into the declared series', async () => {
    mockPool([
      { bucket_start: new Date('2026-05-18T00:00:00.000Z'), fulfillment_value: 'kiosk order', revenue: '500', cogs: '200' },
      { bucket_start: new Date('2026-05-18T00:00:00.000Z'), fulfillment_value: 'walk-in sale', revenue: '300', cogs: '150' },
    ])
    const rows = await queryFulfillmentMarginDollars({
      sites: [],
      from: new Date('2026-05-18T00:00:00.000Z'),
      to: new Date('2026-05-25T00:00:00.000Z'),
      agg: 'week',
    })
    const target = rows.find((r) => r.t === '2026-05-18T00:00:00.000Z')!
    expect(target.kiosk).toBe(300)
    expect(target.in_store).toBe(150)
    expect(target.delivery_prepaid).toBe(0)
  })

  it('queryFulfillmentEffectiveGmPct returns null for series with zero revenue', async () => {
    mockPool([
      { bucket_start: new Date('2026-05-18T00:00:00.000Z'), fulfillment_value: 'kiosk order', revenue: '500', cogs: '200' },
    ])
    const rows = await queryFulfillmentEffectiveGmPct({
      sites: [],
      from: new Date('2026-05-18T00:00:00.000Z'),
      to: new Date('2026-05-25T00:00:00.000Z'),
      agg: 'week',
    })
    const target = rows.find((r) => r.t === '2026-05-18T00:00:00.000Z')!
    expect(target.kiosk).toBeCloseTo(0.6, 4)
    expect(target.pickup).toBeNull()
  })

  it('SQL emitted by margin queries calls sweed_package_cost_as_of_or_earliest and bucket-trunc wraps to UTC timestamptz', async () => {
    const captured: string[] = []
    mockPool([], (sql) => captured.push(sql))
    await queryGrossMarginDollars({
      sites: [],
      from: new Date('2026-05-18T00:00:00.000Z'),
      to: new Date('2026-05-25T00:00:00.000Z'),
      agg: 'week',
    })
    expect(captured.length).toBeGreaterThan(0)
    const sql = captured[0]!
    expect(sql).toContain('sweed_package_cost_as_of_or_earliest(')
    expect(sql).toContain("jsonb_array_elements(so.raw_json->'items')")
    const tzMatches = sql.match(/at time zone 'UTC'/g) ?? []
    expect(tzMatches.length, 'bucket_start must be wrapped `at time zone UTC` to round-trip as timestamptz').toBeGreaterThanOrEqual(2)
  })

  it('queryInventoryCostDistribution clamps bucket-end to now() so the current bucket queries the live snapshot state', async () => {
    // Two-query flow: (1) per-package category lookup, (2) per-bucket
    // snapshot lookup. We assert it issues the snapshot lookup with
    // a timestamp ≤ now() (i.e. the bucket-end clamping kicked in
    // for the latest bucket).
    const observedTimestamps: string[] = []
    const fakePool = {
      query: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
        if (sql.includes('jsonb_array_elements')) {
          return Promise.resolve({ rows: [{ dealer_id: '1', inventory_item_id: 'pkg-A', category_value: 'flower' }] })
        }
        // snapshot lookup
        observedTimestamps.push(String(params[1]))
        return Promise.resolve({ rows: [{ dealer_id: '1', inventory_item_id: 'pkg-A', current_qty: '10', wholesale_cost_dollars: '5' }] })
      }),
    }
    vi.spyOn(poolModule, 'getPool').mockReturnValue(fakePool as unknown as ReturnType<typeof poolModule.getPool>)

    const now = new Date()
    // Last bucket-start is today's UTC midnight; expected end-clamp = now
    const from = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
    const rows = await queryInventoryCostDistribution({
      sites: [],
      from,
      to: now,
      agg: 'date',
    })
    expect(rows.length).toBeGreaterThan(0)
    // The flower series should pick up the qty * cost = 50 on every bucket
    expect(rows[rows.length - 1]!.flower).toBe(50)
    // Every observed snapshot-lookup timestamp must be <= now()
    for (const ts of observedTimestamps) {
      expect(new Date(ts).getTime()).toBeLessThanOrEqual(now.getTime() + 1000)
    }
  })
})
