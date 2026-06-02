import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import * as poolModule from '../../db/pool.js'
import { queryCustomerOriginMap, queryFirstVsReturning } from './sweedOrdersQueries.js'

/**
 * Regression tests for the bucket-key timezone round-trip.
 *
 * Two layers stack here:
 *  1. Original 2026-05-26 bug: SQL used to emit naked
 *     `date_trunc(...)` which node-postgres parsed as server-local
 *     time, mismatching the JS-side bucket key. Fix wrapped the trunc
 *     in `at time zone '...'` so the column comes back as
 *     `timestamptz`.
 *  2. 2026-06 retail-day fix: all calendar bucketing is now in
 *     America/New_York wall-clock so a sale at 22:30 ET on Wednesday
 *     lands in the Wednesday bucket, not the Thursday bucket. NY
 *     Monday-midnight in May (EDT) = `2026-05-18T04:00:00.000Z`
 *     (NOT 00:00Z). `hour` grain still buckets at UTC top-of-hour by
 *     design — see helios/src/server/metrics/bucketSelectSql.ts.
 *
 * These tests stub the pool with a result that mimics what Postgres
 * sends on the wire, and assert the bucketed merge produces a
 * non-zero value (i.e. that the bucket-key match succeeded).
 */
describe('sweed-orders metric queries — bucket-key timezone regression', () => {
  const originalTZ = process.env.TZ

  beforeEach(() => {
    // Simulate the production server timezone so we'd reproduce the
    // original bug if the SQL regressed back to naive timestamps.
    process.env.TZ = 'America/Panama'
  })
  afterEach(() => {
    process.env.TZ = originalTZ
    vi.restoreAllMocks()
  })

  it('queryFirstVsReturning attributes counts to the correct (NY-Monday) bucket', async () => {
    // The fixed SQL returns a timestamptz at NY-Monday-midnight, which
    // in May (EDT) is 04:00Z. node-postgres parses it as the correct
    // UTC instant regardless of server TZ.
    const fakePool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          { bucket_start: new Date('2026-05-18T04:00:00.000Z'), series_id: 'first_time', value: '7' },
          { bucket_start: new Date('2026-05-18T04:00:00.000Z'), series_id: 'returning', value: '42' },
        ],
      }),
    }
    vi.spyOn(poolModule, 'getPool').mockReturnValue(fakePool as unknown as ReturnType<typeof poolModule.getPool>)

    const data = await queryFirstVsReturning({
      sites: [],
      from: new Date('2026-05-18T04:00:00.000Z'),
      to: new Date('2026-05-25T04:00:00.000Z'),
      agg: 'week',
    })

    expect(data.length).toBeGreaterThan(0)
    const first = data.find((r) => r.t === '2026-05-18T04:00:00.000Z')
    expect(first, 'expected a row for the NY-Monday 2026-05-18 bucket').toBeDefined()
    // The merge must NOT have fallen through to defaultValue=0.
    expect(first!.first_time).toBe(7)
    expect(first!.returning).toBe(42)
  })

  it('new-vs-returning SQL computes "first ever purchase" at query time, NOT off the stored column', async () => {
    // Regression: the stored `first_time_for_customer` column is set
    // at ingest time by checking "does this customer have any prior
    // pay_time row right now?". Forward polling ingests in ascending
    // pay_time order so that check is correct — but the backfill loop
    // walks BACKWARDS (newest day to oldest). When backfill arrives at
    // a customer's earlier order AFTER forward polling has inserted a
    // later one, the EXISTS check sees no prior row (the existing row
    // has a LATER pay_time) and marks the backfilled row first_time=
    // true ALONGSIDE the previously-flagged later row. Two "firsts"
    // for the same customer. Operator confirmed mismatch with Sweed's
    // own "new customers / week" on 2026-05-26.
    //
    // The fix is to compute first-time-ness at QUERY time via NOT
    // EXISTS over the live table. This test guards that future
    // "simplifications" don't go back to reading the stored column.
    const captured: string[] = []
    const fakePool = {
      query: vi.fn().mockImplementation((sql: string) => {
        captured.push(sql)
        return Promise.resolve({ rows: [] })
      }),
    }
    vi.spyOn(poolModule, 'getPool').mockReturnValue(fakePool as unknown as ReturnType<typeof poolModule.getPool>)

    await queryFirstVsReturning({
      sites: [],
      from: new Date('2026-05-18T00:00:00.000Z'),
      to: new Date('2026-05-25T00:00:00.000Z'),
      agg: 'week',
    })

    const sql = captured[0]!
    expect(sql, 'must NOT read first_time_for_customer (backfill-corrupted)').not.toMatch(
      /first_time_for_customer/,
    )
    expect(sql, 'must compute first-time via NOT EXISTS at query time').toMatch(
      /not\s+exists\s*\(\s*select\s+1\s+from\s+sweed_orders\s+prior/i,
    )
  })

  it('SQL emitted by the helpers wraps date_trunc back into timestamptz at America/New_York', async () => {
    // Easiest way to inspect: spy the pool.query call.
    const captured: string[] = []
    const fakePool = {
      query: vi.fn().mockImplementation((sql: string) => {
        captured.push(sql)
        return Promise.resolve({ rows: [] })
      }),
    }
    vi.spyOn(poolModule, 'getPool').mockReturnValue(fakePool as unknown as ReturnType<typeof poolModule.getPool>)

    await queryFirstVsReturning({
      sites: [],
      from: new Date('2026-05-18T04:00:00.000Z'),
      to: new Date('2026-05-25T04:00:00.000Z'),
      agg: 'week',
    })

    expect(captured.length).toBeGreaterThan(0)
    const sql = captured[0]!
    // Guard against a future "cleanup" that drops the timezone wrap or
    // reverts the retail-day fix back to UTC. For week grain, the SQL
    // must wrap date_trunc(...) in a SECOND `at time zone
    // 'America/New_York'` so the column comes back as a timestamptz
    // matching the NY-Monday-midnight key produced by `walkBuckets`.
    const nyTzMatches = sql.match(/at time zone 'America\/New_York'/g) ?? []
    expect(
      nyTzMatches.length,
      'week-grain bucket_start must be wrapped with `at time zone America/New_York` to round-trip as timestamptz at the NY-Monday-midnight key',
    ).toBeGreaterThanOrEqual(2)
    // Guard against a regression where someone selects the naked
    // date_trunc(...) (no outer timezone wrap) into bucket_start.
    expect(sql).not.toMatch(/date_trunc\([^)]+\)\s+as\s+bucket_start/)
  })

  it('queryCustomerOriginMap SQL never selects so.id (no such column on sweed_orders)', async () => {
    // Regression: an earlier customers.origin_map rewrite added
    // `select so.id, ...` to the resolved CTE. sweed_orders has a
    // composite primary key (dealer_id, invoice_id) and no `id`
    // column, so the query crashed at runtime with
    //   500: column so.id does not exist
    // on every dashboard load that included this metric.
    // The fix drops `so.id` from the CTE projection (it was never
    // read by the outer aggregation).
    const captured: string[] = []
    const fakePool = {
      query: vi.fn().mockImplementation((sql: string) => {
        captured.push(sql)
        return Promise.resolve({ rows: [] })
      }),
    }
    vi.spyOn(poolModule, 'getPool').mockReturnValue(fakePool as unknown as ReturnType<typeof poolModule.getPool>)

    await queryCustomerOriginMap({
      sites: ['midtown'],
      from: new Date('2026-04-01T00:00:00.000Z'),
      to: new Date('2026-05-26T00:00:00.000Z'),
      agg: 'week',
    })

    expect(captured.length).toBeGreaterThan(0)
    // Strip SQL line comments before matching so an explanatory comment
    // containing the literal phrase "so.id" doesn't trip the guard.
    const sqlExecutable = captured[0]!.replace(/--[^\n]*/g, '')
    expect(sqlExecutable, 'sweed_orders has no `id` column — composite PK is (dealer_id, invoice_id)').not.toMatch(
      /\bso\.id\b/,
    )
  })
})

// -----------------------------------------------------------------
// bucketForAddress — NYC-borough + NJ bucketing of (county, state)
// pairs as returned by the US Census Geocoder (#25 A6).
// -----------------------------------------------------------------

import { bucketForAddress } from './sweedOrdersQueries.js'

describe('bucketForAddress — county/state → borough series', () => {
  it('maps the five NYC counties to their NYC borough series', () => {
    expect(bucketForAddress('New York', 'NY')).toBe('manhattan')
    expect(bucketForAddress('Kings', 'NY')).toBe('brooklyn')
    expect(bucketForAddress('Queens', 'NY')).toBe('queens')
    expect(bucketForAddress('Bronx', 'NY')).toBe('bronx')
    expect(bucketForAddress('Richmond', 'NY')).toBe('staten_island')
  })

  it("tolerates the Census 'X County' basename variant + case quirks", () => {
    expect(bucketForAddress('Kings County', 'NY')).toBe('brooklyn')
    expect(bucketForAddress('NEW YORK', 'ny')).toBe('manhattan')
    expect(bucketForAddress('  bronx  ', '  NY  ')).toBe('bronx')
  })

  it('buckets every NJ county (and just NJ-state when county is null) into nj', () => {
    expect(bucketForAddress('Bergen', 'NJ')).toBe('nj')
    expect(bucketForAddress('Hudson', 'nj')).toBe('nj')
    expect(bucketForAddress(null, 'NJ')).toBe('nj')
  })

  it('falls into other for non-NYC NY counties, other states, and missing data', () => {
    expect(bucketForAddress('Westchester', 'NY')).toBe('other')
    expect(bucketForAddress('Nassau', 'NY')).toBe('other')
    expect(bucketForAddress('New York', 'CT')).toBe('other')
    expect(bucketForAddress(null, null)).toBe('other')
    expect(bucketForAddress(null, 'CT')).toBe('other')
  })
})
