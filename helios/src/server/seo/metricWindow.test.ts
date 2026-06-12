import { describe, expect, it } from 'vitest'

import { MAX_SEO_WINDOW_DAYS, isWindowWithinCap, isoWindowDays } from './metricWindow.js'

describe('isoWindowDays', () => {
  it('counts whole days for a [start, end) window', () => {
    expect(isoWindowDays('2026-01-01', '2026-01-02')).toBe(1)
    expect(isoWindowDays('2026-01-01', '2026-01-31')).toBe(30)
  })

  it('is unaffected by DST transitions (computed in UTC)', () => {
    // US spring-forward (2026-03-08) and fall-back (2026-11-01) windows
    expect(isoWindowDays('2026-03-01', '2026-03-31')).toBe(30)
    expect(isoWindowDays('2026-10-25', '2026-11-08')).toBe(14)
  })
})

describe('isWindowWithinCap', () => {
  it('allows windows up to and including the cap', () => {
    const start = '2026-01-01'
    const end = new Date(Date.parse(`${start}T00:00:00Z`) + MAX_SEO_WINDOW_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10)
    expect(isoWindowDays(start, end)).toBe(MAX_SEO_WINDOW_DAYS)
    expect(isWindowWithinCap(start, end)).toBe(true)
  })

  it('rejects windows larger than the cap', () => {
    const start = '2026-01-01'
    const end = new Date(Date.parse(`${start}T00:00:00Z`) + (MAX_SEO_WINDOW_DAYS + 1) * 86_400_000)
      .toISOString()
      .slice(0, 10)
    expect(isWindowWithinCap(start, end)).toBe(false)
  })
})
