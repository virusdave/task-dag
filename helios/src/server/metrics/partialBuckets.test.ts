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

  it('overwrites left partial row with the full-bucket (T2") value and emits partialTangentPrev (T1") as the spline tangent', async () => {
    // Hour-1 events: 3 + 5 = 8 total; window starts at 01:30. Under
    // the 2026-06-04 spec the left partial row drops its measured
    // sub-window value and surfaces T2' (= 8, the full hour-1
    // completion) on its main series field so the spline's leftmost
    // knot lands on a real-world full-bucket value. T1' (the natural
    // hour-0 full bucket value, here 11) is attached as the hidden
    // tangent neighbour at `partialTangentPrev`.
    const events = new Map<string, number>([
      ['2026-06-01T00:00:00.000Z', 11], // hour 0 (T1')
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
    expect(first.count).toBe(8) // T2' — overwrites the measured 5
    expect(first.partialTangentPrev).toEqual({ count: 11 })
    expect(first.partialTangentPrevT).toBe('2026-06-01T00:00:00.000Z')
    expect(first.partialProjected).toBeUndefined()
    expect(first.partialProjectedT).toBeUndefined()
    expect(first.partialCoverage).toBeCloseTo(0.5)
  })

  it('emits partialTangentPrev = 0 when the prior bucket has no data', async () => {
    // Same shape as the previous test but with no hour-0 events at
    // all — the wrapper should still emit `partialTangentPrev` so
    // the client always has a tangent neighbour for the spline.
    const events = new Map<string, number>([
      ['2026-06-01T01:00:00.000Z', 3],
      ['2026-06-01T01:30:00.000Z', 5],
      ['2026-06-01T02:00:00.000Z', 9],
    ])
    const query = makeFakeQueryFromHourCounts(events)
    const out = await queryWithPartialBuckets({
      query,
      args: baseArgs(
        'hour',
        new Date('2026-06-01T01:30:00Z'),
        new Date('2026-06-01T03:00:00Z'),
      ),
      seriesIds: ['count'],
      asOf: new Date('2026-07-01T00:00:00Z'),
    })
    const first = out[0]!
    expect(first.partial).toBe('left')
    expect(first.count).toBe(8) // T2'
    expect(first.partialTangentPrev).toEqual({ count: 0 })
    expect(first.partialTangentPrevT).toBe('2026-06-01T00:00:00.000Z')
  })

  it('emits partialActualT on right-edge partials so the floating-actual dot lands at the observation moment', async () => {
    // Reuse the historical-right-edge scenario. The new contract
    // requires `partialActualT` to surface the moment of
    // observation (= effective right edge of the query window),
    // distinct from the bucket's start (= row.t) and end (=
    // partialProjectedT).
    const events = new Map<string, number>([
      ['2026-06-01T02:00:00.000Z', 3],
      ['2026-06-01T02:30:00.000Z', 7],
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
    expect(last.partial).toBe('right')
    expect(last.partialActualT).toBe('2026-06-01T02:30:00.000Z')
    expect(last.partialProjectedT).toBe('2026-06-01T03:00:00.000Z')
  })

  it('treats the in-progress bucket as the rightmost partial even when `to` is panned past `asOf` into the future', async () => {
    // Operator pans the chart window so `to` lies in the future
    // (e.g. shifts a 24h view forward by 22h, with `to = now + 22h`).
    // Without capping the bucket walk at observedRightThrough the
    // wrapper would have walked all the way to `to`, picked a
    // future bucket as the "rightmost" partial (with no data), and
    // rendered the genuine in-progress bucket (containing asOf) as
    // a plain interior knot — silently regressing the partial UX
    // exactly when the operator pans the chart.
    const events = new Map<string, number>([
      ['2026-06-01T01:00:00.000Z', 4],
      ['2026-06-01T01:30:00.000Z', 4],
      ['2026-06-01T02:00:00.000Z', 5], // first 30 min of hour 2 (cut by asOf)
    ])
    const query = makeFakeQueryFromHourCounts(events)
    const out = await queryWithPartialBuckets({
      query,
      args: baseArgs(
        'hour',
        new Date('2026-06-01T00:00:00Z'),
        new Date('2026-06-02T00:00:00Z'), // 22h past asOf
      ),
      seriesIds: ['count'],
      asOf: new Date('2026-06-01T02:30:00Z'),
    })
    // No future buckets past asOf.
    expect(out[out.length - 1]!.t).toBe('2026-06-01T02:00:00.000Z')
    const last = out[out.length - 1]!
    expect(last.partial).toBe('right')
    expect(last.partialKind).toBe('extrapolated')
    expect(last.count).toBe(5) // measured value (the floating actual)
    expect(last.partialProjected).toEqual({ count: 10 }) // pace-extrapolated
    expect(last.partialActualT).toBe('2026-06-01T02:30:00.000Z')
    expect(last.partialProjectedT).toBe('2026-06-01T03:00:00.000Z')
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
