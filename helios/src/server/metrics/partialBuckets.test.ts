import { describe, expect, it } from 'vitest'

import type { MetricAggregation } from '../../shared/contracts/index.js'
import { queryWithPartialBuckets } from './partialBuckets.js'
import type { MetricQueryArgs, MetricQueryFn, MetricRow } from './types.js'

// A trivial in-memory metric that returns `count * 1 per hour` of pretend
// data sorted into the requested buckets. Lets the test inject a known
// "raw event stream" and assert the wrapper's window-widening +
// extrapolation behaviour without a database.
function makeFakeQueryFromHourCounts(
  hourCounts: ReadonlyMap<string, number>, // key = ISO of UTC hour-start
): MetricQueryFn {
  return async (args: MetricQueryArgs): Promise<MetricRow[]> => {
    const from = args.from ?? new Date(0)
    const to = args.to ?? new Date(8640000000000000)
    // Bucket every event whose timestamp ∈ [from, to) under the bucket
    // start chosen by the agg. We only support 'date' and 'hour' here —
    // enough for the wrapper test.
    const buckets = new Map<string, number>()
    for (const [iso, n] of hourCounts) {
      const t = new Date(iso)
      if (t < from || t >= to) continue
      let bucketStart: Date
      if (args.agg === 'hour') {
        bucketStart = new Date(Math.floor(t.getTime() / 3_600_000) * 3_600_000)
      } else if (args.agg === 'date') {
        // NY-day bucket. For the test we treat the supplied hour ISO as
        // already in UTC; the test fixtures use UTC midnight, which
        // also happens to align with NY-midnight on 2026-06-03 (EDT).
        const d = new Date(t)
        d.setUTCHours(0, 0, 0, 0)
        bucketStart = d
      } else {
        // Categorical aggregations collapse to a single bucket at
        // the floor of `from`; the test only checks that the wrapper
        // passes through (no partial metadata), so the exact key is
        // irrelevant — pin it to `from`.
        bucketStart = new Date(from)
      }
      const key = bucketStart.toISOString()
      buckets.set(key, (buckets.get(key) ?? 0) + n)
    }
    const out: MetricRow[] = []
    for (const [t, value] of [...buckets].sort((a, b) => a[0].localeCompare(b[0]))) {
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
      args: baseArgs('hour', new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T03:00:00Z')),
      seriesIds: ['count'],
      asOf: new Date('2026-07-01T00:00:00Z'),
    })
    expect(out.map((r) => [r.t, r.count, r.partial])).toEqual([
      ['2026-06-01T00:00:00.000Z', 3, undefined],
      ['2026-06-01T01:00:00.000Z', 5, undefined],
      ['2026-06-01T02:00:00.000Z', 7, undefined],
    ])
  })

  it('marks a historical right edge as truncated when bucket is fully observable', async () => {
    // Window ends mid-bucket but `asOf` is well after the bucket end —
    // we can fetch the full natural bucket and mark it `truncated`.
    const events = new Map<string, number>([
      ['2026-06-01T00:00:00.000Z', 4],
      ['2026-06-01T01:00:00.000Z', 6],
      // Hour 2 is the partial bucket — its "true" total is 10, but the
      // displayed window cuts off at 02:30Z.
      ['2026-06-01T02:00:00.000Z', 10],
    ])
    const query = makeFakeQueryFromHourCounts(events)
    const out = await queryWithPartialBuckets({
      query,
      args: baseArgs('hour', new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T02:30:00Z')),
      seriesIds: ['count'],
      asOf: new Date('2026-07-01T00:00:00Z'),
    })
    const last = out[out.length - 1]!
    expect(last.t).toBe('2026-06-01T02:00:00.000Z')
    expect(last.partial).toBe('right')
    expect(last.partialKind).toBe('truncated')
    expect(last.count).toBe(10)
    // 30 min observed of 60 min = 0.5 coverage.
    expect(last.partialCoverage).toBeCloseTo(0.5)
  })

  it('extrapolates a right edge that crosses "now" via prior-bucket pace', async () => {
    // The current bucket (hour 02:00–03:00) has been observed for the
    // first 30 minutes — the fake query, which buckets by hour-start,
    // gives the whole hour's count back even on the partial query
    // (real metric SQL would only return the subset within [from, to)),
    // so we explicitly synthesise the "halfway through hour 02" reading
    // by giving hour 02 a count of 6 and hour 02-partial a count of 3:
    // half the prior bucket happened in the first 30 min, so x = 0.5,
    // current measured 3 → extrapolate 6.
    //
    // To make that work with the fake bucketer, we add two events at
    // different sub-hour timestamps and let `to` clip the bucket.
    const events = new Map<string, number>([
      ['2026-06-01T01:00:00.000Z', 4], // prior bucket, first 30 min (key=01:00 hour)
      ['2026-06-01T01:30:00.000Z', 4], // prior bucket, last 30 min
      ['2026-06-01T02:00:00.000Z', 5], // current bucket, first 30 min
      ['2026-06-01T02:30:00.000Z', 99], // current bucket, last 30 min — NOT observed yet
    ])
    const query = makeFakeQueryFromHourCounts(events)
    const out = await queryWithPartialBuckets({
      query,
      args: baseArgs('hour', new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T03:00:00Z')),
      seriesIds: ['count'],
      asOf: new Date('2026-06-01T02:30:00Z'), // "now" mid-bucket
    })
    const last = out[out.length - 1]!
    expect(last.t).toBe('2026-06-01T02:00:00.000Z')
    expect(last.partial).toBe('right')
    expect(last.partialKind).toBe('extrapolated')
    // Prior hour: first 30 min had 4 events, full hour had 8 → x = 0.5.
    // Current measured (first 30 min) = 5 → extrapolated = 5 / 0.5 = 10.
    expect(last.count).toBeCloseTo(10)
    expect(last.partialCoverage).toBeCloseTo(0.5)
  })

  it('falls back to uniform pro-rata when prior bucket has no data', async () => {
    const events = new Map<string, number>([
      ['2026-06-01T02:00:00.000Z', 5],
    ])
    const query = makeFakeQueryFromHourCounts(events)
    const out = await queryWithPartialBuckets({
      query,
      args: baseArgs('hour', new Date('2026-06-01T01:00:00Z'), new Date('2026-06-01T03:00:00Z')),
      seriesIds: ['count'],
      asOf: new Date('2026-06-01T02:30:00Z'),
    })
    const last = out[out.length - 1]!
    expect(last.t).toBe('2026-06-01T02:00:00.000Z')
    expect(last.partialKind).toBe('extrapolated')
    // Prior bucket value is 0 → fallback uniform pro-rata:
    // measured / frac = 5 / 0.5 = 10.
    expect(last.count).toBeCloseTo(10)
  })

  it('marks a left edge truncated and emits the full natural-bucket value', async () => {
    // Display window starts mid-bucket (01:30); natural hour-01 bucket
    // total is 8 (events at 01:00 and 01:30). The wrapper widens the
    // query to firstBucketStart and pulls the full 8.
    const events = new Map<string, number>([
      ['2026-06-01T01:00:00.000Z', 3],
      ['2026-06-01T01:30:00.000Z', 5],
      ['2026-06-01T02:00:00.000Z', 9],
      ['2026-06-01T03:00:00.000Z', 4],
    ])
    const query = makeFakeQueryFromHourCounts(events)
    const out = await queryWithPartialBuckets({
      query,
      args: baseArgs('hour', new Date('2026-06-01T01:30:00Z'), new Date('2026-06-01T04:00:00Z')),
      seriesIds: ['count'],
      asOf: new Date('2026-07-01T00:00:00Z'),
    })
    const first = out[0]!
    expect(first.t).toBe('2026-06-01T01:00:00.000Z')
    expect(first.partial).toBe('left')
    expect(first.partialKind).toBe('truncated')
    expect(first.count).toBe(8) // full hour, both events
    // Half the hour observed inside the window.
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
        ...baseArgs('total', new Date('2026-06-01T00:00:00Z'), new Date('2026-06-02T00:00:00Z')),
        agg: 'total' as MetricAggregation,
      },
      seriesIds: ['count'],
      asOf: new Date('2026-07-01T00:00:00Z'),
    })
    // Total aggregations don't have an edge concept; verify no partial
    // metadata leaked through.
    for (const row of out) {
      expect(row.partial).toBeUndefined()
      expect(row.partialKind).toBeUndefined()
    }
  })
})
