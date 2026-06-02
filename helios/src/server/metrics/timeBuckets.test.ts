import { describe, expect, it } from 'vitest'

import { advanceBucketStart, defaultWindow, walkBuckets } from './timeBuckets.js'

// NY uses EST (UTC-5) in winter and EDT (UTC-4) from the second Sunday
// of March through the first Sunday of November. All retail bucketing
// in helios is in America/New_York calendar time, so date/week/month
// boundaries are at NY-midnight (= 05:00Z winter, 04:00Z summer).
// `hour` buckets remain on UTC top-of-hour by design — see the
// doc-comment on timeBuckets.ts for the rationale.

describe('walkBuckets', () => {
  it('returns daily buckets aligned to NY midnight (winter / EST)', () => {
    // Inputs are arbitrary instants inside NY-Jan-1, NY-Jan-2, NY-Jan-3.
    // NY midnight in January = 05:00Z because EST = UTC-5.
    const from = new Date('2025-01-01T10:00:00Z')
    const to = new Date('2025-01-04T00:00:00Z')
    const buckets = walkBuckets(from, to, 'date')
    expect(buckets.map((d) => d.toISOString())).toEqual([
      '2025-01-01T05:00:00.000Z',
      '2025-01-02T05:00:00.000Z',
      '2025-01-03T05:00:00.000Z',
    ])
  })

  it('returns hourly buckets aligned to UTC hour boundaries', () => {
    const from = new Date('2025-01-01T10:30:00Z')
    const to = new Date('2025-01-01T13:00:00Z')
    const buckets = walkBuckets(from, to, 'hour')
    expect(buckets.map((d) => d.toISOString())).toEqual([
      '2025-01-01T10:00:00.000Z',
      '2025-01-01T11:00:00.000Z',
      '2025-01-01T12:00:00.000Z',
    ])
  })

  it('returns weekly buckets aligned to NY-Monday midnight', () => {
    // 2025-01-04 (Saturday) → containing NY ISO week starts NY-Monday
    // 2024-12-30. NY midnight in January = 05:00Z.
    const from = new Date('2025-01-04T00:00:00Z')
    const to = new Date('2025-01-20T05:00:00Z')
    const buckets = walkBuckets(from, to, 'week')
    expect(buckets[0]?.toISOString()).toBe('2024-12-30T05:00:00.000Z')
    expect(buckets.at(-1)?.toISOString()).toBe('2025-01-13T05:00:00.000Z')
  })

  it('returns a single bucket for total/dow/dom/dofortnight', () => {
    const from = new Date('2025-03-15T10:00:00Z')
    const to = new Date('2025-06-15T10:00:00Z')
    for (const agg of ['total', 'dow', 'dom', 'dofortnight'] as const) {
      const buckets = walkBuckets(from, to, agg)
      expect(buckets).toHaveLength(1)
    }
  })

  it('caps runaway walks at 20k buckets', () => {
    const from = new Date('2000-01-01T00:00:00Z')
    const to = new Date('2030-01-01T00:00:00Z')
    const buckets = walkBuckets(from, to, 'hour')
    expect(buckets.length).toBeLessThanOrEqual(20_000)
  })

  it('handles the NY DST spring-forward day correctly', () => {
    // 2026-03-08 is the second Sunday of March → 2:00 AM EST jumps to
    // 3:00 AM EDT. Day boundaries: NY-Mar-7 midnight = 05:00Z (EST),
    // NY-Mar-8 midnight = 05:00Z (still EST — clock change hasn't
    // happened yet at midnight), NY-Mar-9 midnight = 04:00Z (EDT).
    const from = new Date('2026-03-07T05:00:00Z')
    const to = new Date('2026-03-10T04:00:00Z')
    const buckets = walkBuckets(from, to, 'date')
    expect(buckets.map((d) => d.toISOString())).toEqual([
      '2026-03-07T05:00:00.000Z',
      '2026-03-08T05:00:00.000Z',
      '2026-03-09T04:00:00.000Z',
    ])
  })

  it('handles the NY DST fall-back day correctly (would loop forever on naive +24h)', () => {
    // 2026-11-01 is the first Sunday of November → 2:00 AM EDT falls
    // back to 1:00 AM EST. Day boundaries: NY-Oct-31 midnight = 04:00Z
    // (EDT), NY-Nov-1 midnight = 04:00Z (still EDT at midnight,
    // before the change), NY-Nov-2 midnight = 05:00Z (EST). A naive
    // "add 24h then re-floor in NY" walker stalls on Nov 1 → Nov 2
    // because 04:00Z + 24h = 04:00Z next day, which is still inside
    // NY-Nov-1; this regression test catches that.
    const from = new Date('2026-10-31T04:00:00Z')
    const to = new Date('2026-11-03T05:00:00Z')
    const buckets = walkBuckets(from, to, 'date')
    expect(buckets.map((d) => d.toISOString())).toEqual([
      '2026-10-31T04:00:00.000Z',
      '2026-11-01T04:00:00.000Z',
      '2026-11-02T05:00:00.000Z',
    ])
  })

  it('hourly buckets preserve both real 01:00 NY hours on the fall-back Sunday', () => {
    // 01:00 EDT = 05:00Z; 01:00 EST = 06:00Z. Both are real,
    // distinct hours; the customers who bought at each one should be
    // bucketed separately.
    const from = new Date('2026-11-01T04:00:00Z')
    const to = new Date('2026-11-01T08:00:00Z')
    const buckets = walkBuckets(from, to, 'hour')
    expect(buckets.map((d) => d.toISOString())).toEqual([
      '2026-11-01T04:00:00.000Z',
      '2026-11-01T05:00:00.000Z',
      '2026-11-01T06:00:00.000Z',
      '2026-11-01T07:00:00.000Z',
    ])
  })
})

describe('advanceBucketStart', () => {
  it('spring-forward day is 23 elapsed hours', () => {
    const mar8NyMidnight = new Date('2026-03-08T05:00:00Z')
    const mar9NyMidnight = advanceBucketStart(mar8NyMidnight, 'date')
    expect(mar9NyMidnight.toISOString()).toBe('2026-03-09T04:00:00.000Z')
    expect(mar9NyMidnight.getTime() - mar8NyMidnight.getTime()).toBe(23 * 60 * 60 * 1000)
  })

  it('fall-back day is 25 elapsed hours', () => {
    const nov1NyMidnight = new Date('2026-11-01T04:00:00Z')
    const nov2NyMidnight = advanceBucketStart(nov1NyMidnight, 'date')
    expect(nov2NyMidnight.toISOString()).toBe('2026-11-02T05:00:00.000Z')
    expect(nov2NyMidnight.getTime() - nov1NyMidnight.getTime()).toBe(25 * 60 * 60 * 1000)
  })

  it('month grain rolls forward to NY-first-of-month midnight', () => {
    const may1Ny = new Date('2025-05-01T04:00:00Z') // EDT
    const jun1Ny = advanceBucketStart(may1Ny, 'month')
    expect(jun1Ny.toISOString()).toBe('2025-06-01T04:00:00.000Z') // also EDT
  })
})

describe('defaultWindow', () => {
  it('uses now as the upper bound when `to` is null', () => {
    const before = Date.now()
    const window = defaultWindow(null, null, 'date')
    const after = Date.now()
    expect(window.to.getTime()).toBeGreaterThanOrEqual(before)
    expect(window.to.getTime()).toBeLessThanOrEqual(after)
  })

  it('derives `from` from `to` minus the aggregation default span', () => {
    const to = new Date('2025-06-01T00:00:00Z')
    const window = defaultWindow(null, to, 'date')
    const days = (window.to.getTime() - window.from.getTime()) / (24 * 60 * 60 * 1000)
    expect(days).toBe(90)
  })

  it('honours explicit `from` even when `to` is missing', () => {
    const from = new Date('2025-01-01T00:00:00Z')
    const window = defaultWindow(from, null, 'date')
    expect(window.from.toISOString()).toBe('2025-01-01T00:00:00.000Z')
  })
})
