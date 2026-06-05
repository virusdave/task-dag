import { describe, expect, it } from 'vitest'

import { advanceBucketStart, defaultWindow, walkBuckets } from './timeBuckets.js'

// NY uses EST (UTC-5) in winter and EDT (UTC-4) from the second Sunday
// of March through the first Sunday of November. All retail bucketing
// in helios is by the NYC **business day**, which rolls over at 08:00 ET
// (store open), NOT calendar midnight — see
// shared/contracts/domain/businessDay.ts. So date/week/month bucket
// starts are at 08:00 ET (= 13:00Z in winter / EST, 12:00Z in summer /
// EDT) on the business date, and a transaction before 08:00 ET belongs
// to the PREVIOUS business day. `hour` buckets remain on UTC top-of-hour
// by design — see the doc-comment on timeBuckets.ts for the rationale.

describe('walkBuckets', () => {
  it('returns daily buckets aligned to the 08:00-ET business day (winter / EST)', () => {
    // Inputs are arbitrary post-open instants inside the Jan-1, Jan-2,
    // Jan-3 business days. 08:00 ET in January = 13:00Z (EST = UTC-5).
    const from = new Date('2025-01-01T14:00:00Z') // 09:00 ET Jan 1
    const to = new Date('2025-01-04T13:00:00Z') // 08:00 ET Jan 4 (exclusive)
    const buckets = walkBuckets(from, to, 'date')
    expect(buckets.map((d) => d.toISOString())).toEqual([
      '2025-01-01T13:00:00.000Z',
      '2025-01-02T13:00:00.000Z',
      '2025-01-03T13:00:00.000Z',
    ])
  })

  it('rolls a pre-08:00-ET instant into the previous business day', () => {
    // 2025-01-02T10:00:00Z = 05:00 ET Jan 2, before the 08:00 open, so
    // it belongs to the Jan-1 business day (which started 08:00 ET Jan 1
    // = 13:00Z).
    const buckets = walkBuckets(
      new Date('2025-01-02T10:00:00Z'),
      new Date('2025-01-02T10:30:00Z'),
      'date',
    )
    expect(buckets).toEqual([new Date('2025-01-01T13:00:00.000Z')])
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

  it('returns weekly buckets aligned to the business-Monday 08:00 ET', () => {
    // 2025-01-04 (Saturday) → containing ISO week starts business-Monday
    // 2024-12-30. 08:00 ET in January = 13:00Z.
    const from = new Date('2025-01-04T00:00:00Z')
    const to = new Date('2025-01-20T13:00:00Z')
    const buckets = walkBuckets(from, to, 'week')
    expect(buckets[0]?.toISOString()).toBe('2024-12-30T13:00:00.000Z')
    expect(buckets.at(-1)?.toISOString()).toBe('2025-01-13T13:00:00.000Z')
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
    // 3:00 AM EDT. Business-day starts are at 08:00 ET, which is AFTER
    // the 02:00 transition: Mar-7 08:00 = 13:00Z (EST), Mar-8 08:00 =
    // 12:00Z (EDT), Mar-9 08:00 = 12:00Z (EDT).
    const from = new Date('2026-03-07T14:00:00Z') // 09:00 ET Mar 7
    const to = new Date('2026-03-10T12:00:00Z') // 08:00 ET Mar 10 (exclusive)
    const buckets = walkBuckets(from, to, 'date')
    expect(buckets.map((d) => d.toISOString())).toEqual([
      '2026-03-07T13:00:00.000Z',
      '2026-03-08T12:00:00.000Z',
      '2026-03-09T12:00:00.000Z',
    ])
  })

  it('handles the NY DST fall-back day correctly (would loop forever on naive +24h)', () => {
    // 2026-11-01 is the first Sunday of November → 2:00 AM EDT falls
    // back to 1:00 AM EST. Business-day starts are at 08:00 ET (after
    // the 02:00 transition): Oct-31 08:00 = 12:00Z (EDT), Nov-1 08:00 =
    // 13:00Z (EST), Nov-2 08:00 = 13:00Z (EST).
    const from = new Date('2026-10-31T13:00:00Z') // 09:00 ET Oct 31
    const to = new Date('2026-11-03T13:00:00Z') // 08:00 ET Nov 3 (exclusive)
    const buckets = walkBuckets(from, to, 'date')
    expect(buckets.map((d) => d.toISOString())).toEqual([
      '2026-10-31T12:00:00.000Z',
      '2026-11-01T13:00:00.000Z',
      '2026-11-02T13:00:00.000Z',
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
  it('spring-forward business day is 23 elapsed hours', () => {
    // Mar-7 08:00 ET = 13:00Z (EST); Mar-8 08:00 ET = 12:00Z (EDT). The
    // 02:00 spring-forward happens between them, so the business day is
    // only 23 elapsed hours.
    const mar7 = new Date('2026-03-07T13:00:00Z')
    const mar8 = advanceBucketStart(mar7, 'date')
    expect(mar8.toISOString()).toBe('2026-03-08T12:00:00.000Z')
    expect(mar8.getTime() - mar7.getTime()).toBe(23 * 60 * 60 * 1000)
  })

  it('fall-back business day is 25 elapsed hours', () => {
    // Oct-31 08:00 ET = 12:00Z (EDT); Nov-1 08:00 ET = 13:00Z (EST). The
    // 02:00 fall-back happens between them, so the business day is 25
    // elapsed hours.
    const oct31 = new Date('2026-10-31T12:00:00Z')
    const nov1 = advanceBucketStart(oct31, 'date')
    expect(nov1.toISOString()).toBe('2026-11-01T13:00:00.000Z')
    expect(nov1.getTime() - oct31.getTime()).toBe(25 * 60 * 60 * 1000)
  })

  it('month grain rolls forward to the 08:00-ET first-of-month boundary', () => {
    const may1 = new Date('2025-05-01T12:00:00Z') // 08:00 ET May 1 (EDT)
    const jun1 = advanceBucketStart(may1, 'month')
    expect(jun1.toISOString()).toBe('2025-06-01T12:00:00.000Z') // also EDT
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
