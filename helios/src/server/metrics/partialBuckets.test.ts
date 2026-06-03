import { describe, expect, it } from 'vitest'

import type { MetricAggregation } from '../../shared/contracts/index.js'
import { queryWithPartialBuckets } from './partialBuckets.js'
import type { MetricQueryArgs, MetricQueryFn, MetricRow } from './types.js'

// A trivial in-memory metric. Sums hour-bucketed counts within the
// requested `[from, to)` and returns one row per touched bucket.
// Lets us inject a known "raw event stream" and assert the wrapper's
// base-vs-projected behaviour without a database.
function makeFakeQueryFromHourCounts(
  hourCounts: ReadonlyMap<string, number>, // key = ISO of UTC hour-start
): MetricQueryFn {
  return async (args: MetricQueryArgs): Promise<MetricRow[]> => {
    const from = args.from ?? new Date(0)
    const to = args.to ?? new Date(8640000000000000)
    const buckets = new Map<string, number>()
    for (const [iso, n] of hourCounts) {
      const t = new Date(iso)
      if (t < from || t >= to) continue
      let bucketStart: Date
      if (args.agg === 'hour') {
        bucketStart = new Date(Math.floor(t.getTime() / 3_600_000) * 3_600_000)
      } else if (args.agg === 'date') {
        const d = new Date(t)
        d.setUTCHours(0, 0, 0, 0)
        bucketStart = d
      } else {
        bucketStart = new Date(from)
      }
      const key = bucketStart.toISOString()
      buckets.set(key, (buckets.get(key) ?? 0) + n)
    }
    const out: MetricRow[] = []
    for (const [t, value] of [...buckets].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      out.push({ t, count: value })
    }
    return out
  }
}

function baseArgs(
  agg: MetricAggregation,
  from: Date,
  to: Date,
): MetricQueryArgs {
  return {
    sites: [],
    from,
    to,
    agg,
  }
}

describe('queryWithPartialBuckets', () => {
  it('passes through when window is bucket-aligned', async () => {
    const events = new Map<string, number>([
      ['2026-06-01T00:00:00.000Z', 3],
      ['2026-06-01T01:00:00.000Z', 5],
      ['2026-06-01T02:00:00.000Z', 7],
    ])
    const query = makeFakeQueryFromHourCounts(events)
    const out = await queryWithPartialBuckets({
      query,
      args: baseArgs(
        'hour',
        new Date('2026-06-01T00:00:00Z'),
        new Date('2026-06-01T03:00:00Z'),
      ),
      seriesIds: ['count'],
      asOf: new Date('2026-07-01T00:00:00Z'),
    })
    expect(out.map((r) => [r.t, r.count, r.partial])).toEqual([
      ['2026-06-01T00:00:00.000Z', 3, undefined],
      ['2026-06-01T01:00:00.000Z', 5, undefined],
      ['2026-06-01T02:00:00.000Z', 7, undefined],
    ])
  })

  it('keeps the measured value on the row + emits full-bucket as partialProjected for a historical right edge', async () => {
    // Hour-2 events: 3 in the first 30 min, 7 in the last 30 min →
    // 10 total, but the displayed window cuts off at 02:30. The
    // actual measured value the chart should plot is 3; the dashed
    // projected endpoint should be 10.
    const events = new Map<string, number>([
      ['2026-06-01T00:00:00.000Z', 4],
      ['2026-06-01T01:00:00.000Z', 6],
      ['2026-06-01T02:00:00.000Z', 3], // first 30 min of hour 2
      ['2026-06-01T02:30:00.000Z', 7], // last 30 min of hour 2
    ])
    const query = makeFakeQueryFromHourCounts(events)
    const out = await queryWithPartialBuckets({
      query,
      args: baseArgs(
        'hour',
        new Date('2026-06-01T00:00:00Z'),
        new Date('2026-06-01T02:30:00Z'),
      ),
      seriesIds: ['count'],
      asOf: new Date('2026-07-01T00:00:00Z'),
    })
    const last = out[out.length - 1]!
    expect(last.t).toBe('2026-06-01T02:00:00.000Z')
    expect(last.partial).toBe('right')
    expect(last.partialKind).toBe('truncated')
    expect(last.count).toBe(3)
    expect(last.partialProjected).toEqual({ count: 10 })
    expect(last.partialCoverage).toBeCloseTo(0.5)
  })

  it('keeps measured + emits pace-projected for an extrapolated right edge crossing "now"', async () => {
    // Prior hour: 4 + 4 = 8, half observed at minute 30 → x = 0.5.
    // Current hour: 5 observed in first 30 min, 99 will land later →
    // measured = 5; projected = 5 / 0.5 = 10.
    const events = new Map<string, number>([
      ['2026-06-01T01:00:00.000Z', 4],
      ['2026-06-01T01:30:00.000Z', 4],
      ['2026-06-01T02:00:00.000Z', 5],
      ['2026-06-01T02:30:00.000Z', 99],
    ])
    const query = makeFakeQueryFromHourCounts(events)
    const out = await queryWithPartialBuckets({
      query,
      args: baseArgs(
        'hour',
        new Date('2026-06-01T00:00:00Z'),
        new Date('2026-06-01T03:00:00Z'),
      ),
      seriesIds: ['count'],
      asOf: new Date('2026-06-01T02:30:00Z'),
    })
    const last = out[out.length - 1]!
    expect(last.t).toBe('2026-06-01T02:00:00.000Z')
    expect(last.partial).toBe('right')
    expect(last.partialKind).toBe('extrapolated')
    expect(last.count).toBe(5) // measured value stays on the row
    expect(last.partialProjected).toEqual({ count: 10 })
    expect(last.partialCoverage).toBeCloseTo(0.5)
  })

  it('falls back to uniform pro-rata projection when prior bucket has no data', async () => {
    const events = new Map<string, number>([
      ['2026-06-01T02:00:00.000Z', 5],
    ])
    const query = makeFakeQueryFromHourCounts(events)
    const out = await queryWithPartialBuckets({
      query,
      args: baseArgs(
        'hour',
        new Date('2026-06-01T01:00:00Z'),
        new Date('2026-06-01T03:00:00Z'),
      ),
      seriesIds: ['count'],
      asOf: new Date('2026-06-01T02:30:00Z'),
    })
    const last = out[out.length - 1]!
    expect(last.t).toBe('2026-06-01T02:00:00.000Z')
    expect(last.partialKind).toBe('extrapolated')
    expect(last.count).toBe(5)
    expect(last.partialProjected).toEqual({ count: 10 }) // 5 / 0.5
  })

  it('keeps measured + emits full-bucket projection for a truncated left edge', async () => {
    // Hour-1 events: 3 + 5 = 8 total; window starts at 01:30, so the
    // measured value the chart shows is 5 (the [01:30, 02:00) sub-
    // window). The dashed projected endpoint should be 8.
    const events = new Map<string, number>([
      ['2026-06-01T01:00:00.000Z', 3],
      ['2026-06-01T01:30:00.000Z', 5],
      ['2026-06-01T02:00:00.000Z', 9],
      ['2026-06-01T03:00:00.000Z', 4],
    ])
    const query = makeFakeQueryFromHourCounts(events)
    const out = await queryWithPartialBuckets({
      query,
      args: baseArgs(
        'hour',
        new Date('2026-06-01T01:30:00Z'),
        new Date('2026-06-01T04:00:00Z'),
      ),
      seriesIds: ['count'],
      asOf: new Date('2026-07-01T00:00:00Z'),
    })
    const first = out[0]!
    expect(first.t).toBe('2026-06-01T01:00:00.000Z')
    expect(first.partial).toBe('left')
    expect(first.partialKind).toBe('truncated')
    expect(first.count).toBe(5) // measured value (only the [01:30,02:00) part)
    expect(first.partialProjected).toEqual({ count: 8 })
    expect(first.partialCoverage).toBeCloseTo(0.5)
  })

  it('passes through for categorical aggregations (total / dow / dom / dofortnight)', async () => {
    const events = new Map<string, number>([
      ['2026-06-01T00:00:00.000Z', 1],
      ['2026-06-01T01:00:00.000Z', 2],
    ])
    const query = makeFakeQueryFromHourCounts(events)
    const out = await queryWithPartialBuckets({
      query,
      args: {
        ...baseArgs(
          'total',
          new Date('2026-06-01T00:00:00Z'),
          new Date('2026-06-02T00:00:00Z'),
        ),
        agg: 'total' as MetricAggregation,
      },
      seriesIds: ['count'],
      asOf: new Date('2026-07-01T00:00:00Z'),
    })
    for (const row of out) {
      expect(row.partial).toBeUndefined()
      expect(row.partialKind).toBeUndefined()
      expect(row.partialProjected).toBeUndefined()
    }
  })
})
