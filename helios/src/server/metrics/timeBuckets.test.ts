import { describe, expect, it } from 'vitest'

import { defaultWindow, walkBuckets } from './timeBuckets.js'

describe('walkBuckets', () => {
  it('returns daily buckets aligned to UTC midnight', () => {
    const from = new Date('2025-01-01T10:00:00Z')
    const to = new Date('2025-01-04T00:00:00Z')
    const buckets = walkBuckets(from, to, 'date')
    expect(buckets.map((d) => d.toISOString())).toEqual([
      '2025-01-01T00:00:00.000Z',
      '2025-01-02T00:00:00.000Z',
      '2025-01-03T00:00:00.000Z',
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

  it('returns weekly buckets aligned to ISO-Monday', () => {
    // 2025-01-04 is a Saturday. The containing ISO week starts on
    // Monday 2024-12-30.
    const from = new Date('2025-01-04T00:00:00Z')
    const to = new Date('2025-01-20T00:00:00Z')
    const buckets = walkBuckets(from, to, 'week')
    expect(buckets[0]?.toISOString()).toBe('2024-12-30T00:00:00.000Z')
    expect(buckets.at(-1)?.toISOString()).toBe('2025-01-13T00:00:00.000Z')
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
