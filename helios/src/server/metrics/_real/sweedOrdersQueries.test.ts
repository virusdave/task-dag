import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import * as poolModule from '../../db/pool.js'
import { queryFirstVsReturning } from './sweedOrdersQueries.js'

/**
 * Regression test for the 2026-05-26 "all live metrics show zero" bug.
 *
 * Root cause: the SQL emitted by these helpers used to select
 * `date_trunc('week', pay_time at time zone 'UTC') as bucket_start`,
 * which is a `timestamp` WITHOUT time zone. node-postgres parses an
 * unzoned timestamp as **server-local time** when constructing the JS
 * `Date`. The helios server runs in America/Panama (UTC-05:00), so a
 * Postgres value of `2026-05-18 00:00:00` came back as
 * `2026-05-18T05:00:00.000Z`, which never matches the
 * `walkBuckets`-generated key `2026-05-18T00:00:00.000Z`. The merge
 * step in `runBucketedQuery` then fell through to defaultValue=0 for
 * every series in every bucket.
 *
 * Fix: wrap the trunc as `(date_trunc(...)) at time zone 'UTC'` so
 * the column comes back as a `timestamptz` that round-trips cleanly.
 *
 * This test stubs the pool with a result that mimics what Postgres
 * sends on the wire, and asserts the bucketed merge produces a
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

  it('queryFirstVsReturning attributes counts to the correct (UTC) bucket', async () => {
    // The fixed SQL returns a timestamptz at UTC. Simulate node-postgres
    // parsing that as a Date — for a timestamptz at midnight UTC, the
    // Date is exactly that instant regardless of server TZ.
    const fakePool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          { bucket_start: new Date('2026-05-18T00:00:00.000Z'), series_id: 'first_time', value: '7' },
          { bucket_start: new Date('2026-05-18T00:00:00.000Z'), series_id: 'returning', value: '42' },
        ],
      }),
    }
    vi.spyOn(poolModule, 'getPool').mockReturnValue(fakePool as unknown as ReturnType<typeof poolModule.getPool>)

    const data = await queryFirstVsReturning({
      sites: [],
      from: new Date('2026-05-18T00:00:00.000Z'),
      to: new Date('2026-05-25T00:00:00.000Z'),
      agg: 'week',
    })

    expect(data.length).toBeGreaterThan(0)
    const first = data.find((r) => r.t === '2026-05-18T00:00:00.000Z')
    expect(first, 'expected a row for the 2026-05-18 UTC bucket').toBeDefined()
    // The merge must NOT have fallen through to defaultValue=0.
    expect(first!.first_time).toBe(7)
    expect(first!.returning).toBe(42)
  })

  it('SQL emitted by the helpers wraps date_trunc back into timestamptz at UTC', async () => {
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
      from: new Date('2026-05-18T00:00:00.000Z'),
      to: new Date('2026-05-25T00:00:00.000Z'),
      agg: 'week',
    })

    expect(captured.length).toBeGreaterThan(0)
    const sql = captured[0]!
    // Guard against a future "cleanup" that drops the timezone wrap.
    // The fix wraps date_trunc(...) in a SECOND `at time zone 'UTC'` so
    // the column comes back as a timestamptz rather than a naive timestamp.
    // Match both occurrences:
    const tzMatches = sql.match(/at time zone 'UTC'/g) ?? []
    expect(tzMatches.length, 'bucket_start must be wrapped with `at time zone UTC` to round-trip as timestamptz').toBeGreaterThanOrEqual(2)
    // Guard against a regression where someone selects the naked
    // date_trunc(...) (no outer timezone wrap) into bucket_start.
    expect(sql).not.toMatch(/date_trunc\([^)]+\)\s+as\s+bucket_start/)
  })
})
