import { describe, expect, it, vi, afterEach } from 'vitest'

import * as poolModule from '../../db/pool.js'
import { queryCashierTransactionsPerHour } from './cashierThroughputQueries.js'

describe('cashier.transactions_per_hour real query', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('attributes ratios to the correct NY-midnight bucket and returns null in empty buckets', async () => {
    // Two buckets in the window; the SQL only returns rows for the
    // bucket that had drawer-shift coverage. The merge must:
    //   * surface the real ratio in the covered bucket
    //   * leave the uncovered bucket as null (NOT 0 — zero would
    //     suggest the store was open with no transactions, vs.
    //     unknown / no on-the-clock cashiers)
    //
    // Day grain buckets at NY-midnight. May 18 2026 is EDT → 04:00Z.
    const fakePool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          { bucket_start: new Date('2026-05-18T04:00:00.000Z'), value: '12.5' },
        ],
      }),
    }
    vi.spyOn(poolModule, 'getPool').mockReturnValue(fakePool as unknown as ReturnType<typeof poolModule.getPool>)

    const data = await queryCashierTransactionsPerHour({
      sites: [],
      from: new Date('2026-05-18T04:00:00.000Z'),
      to: new Date('2026-05-20T04:00:00.000Z'),
      agg: 'date',
    })

    expect(data.length).toBe(2)
    expect(data[0]).toEqual({ t: '2026-05-18T04:00:00.000Z', tx_per_hour: 12.5 })
    expect(data[1]).toEqual({ t: '2026-05-19T04:00:00.000Z', tx_per_hour: null })
  })

  it('returns null for the single bucket in the `total` collapse when no drawer-shifts exist', async () => {
    const fakePool = {
      query: vi.fn().mockResolvedValue({ rows: [{ value: null }] }),
    }
    vi.spyOn(poolModule, 'getPool').mockReturnValue(fakePool as unknown as ReturnType<typeof poolModule.getPool>)

    const data = await queryCashierTransactionsPerHour({
      sites: [],
      from: new Date('2026-05-18T00:00:00.000Z'),
      to: new Date('2026-05-20T00:00:00.000Z'),
      agg: 'total',
    })

    expect(data.length).toBeGreaterThan(0)
    expect(data[0]!.tx_per_hour).toBe(null)
  })

  it('returns null-only series when no sites resolve to dealers', async () => {
    const fakePool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }
    vi.spyOn(poolModule, 'getPool').mockReturnValue(fakePool as unknown as ReturnType<typeof poolModule.getPool>)

    const data = await queryCashierTransactionsPerHour({
      sites: ['nonexistent-site'],
      from: new Date('2026-05-18T00:00:00.000Z'),
      to: new Date('2026-05-20T00:00:00.000Z'),
      agg: 'date',
    })

    // The SQL should NOT have been hit when there are no dealers.
    expect(fakePool.query).not.toHaveBeenCalled()
    expect(data.every((r) => r.tx_per_hour === null)).toBe(true)
  })
})
