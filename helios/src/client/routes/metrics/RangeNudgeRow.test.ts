import { describe, expect, it } from 'vitest'

import { shiftRange, wouldExtendIntoFuture } from './RangeNudgeRow.js'

const DAY_MS = 24 * 60 * 60 * 1000

describe('shiftRange', () => {
  it('shifts both endpoints by the same delta (preserves width)', () => {
    const range = { fromMs: 1_000_000_000_000, toMs: 1_000_000_000_000 + 7 * DAY_MS }
    const next = shiftRange(range, -7)
    expect(next.fromMs).toBe(range.fromMs - 7 * DAY_MS)
    expect(next.toMs).toBe(range.toMs - 7 * DAY_MS)
    expect(next.toMs - next.fromMs).toBe(range.toMs - range.fromMs)
  })

  it('positive delta moves the window forward', () => {
    const range = { fromMs: 0, toMs: 7 * DAY_MS }
    const next = shiftRange(range, 30)
    expect(next.fromMs).toBe(30 * DAY_MS)
    expect(next.toMs).toBe(37 * DAY_MS)
  })

  it('back-and-forth nudges of equal magnitude return the original window', () => {
    const range = { fromMs: 1_700_000_000_000, toMs: 1_700_000_000_000 + 30 * DAY_MS }
    const back = shiftRange(shiftRange(shiftRange(range, -7), -7), -7)
    const forward = shiftRange(shiftRange(shiftRange(back, 7), 7), 7)
    expect(forward).toEqual(range)
  })

  it('width is exactly preserved across many random nudges', () => {
    let r = { fromMs: 1_500_000_000_000, toMs: 1_500_000_000_000 + 14 * DAY_MS }
    const originalWidth = r.toMs - r.fromMs
    const deltas = [-1, 7, -30, 90, -7, 30, -90, 1, -1, 1]
    for (const d of deltas) {
      r = shiftRange(r, d)
      expect(r.toMs - r.fromMs).toBe(originalWidth)
    }
  })
})

describe('wouldExtendIntoFuture', () => {
  const now = 1_700_000_000_000

  it('returns false for backward nudges regardless of window', () => {
    const range = { fromMs: now - 7 * DAY_MS, toMs: now }
    expect(wouldExtendIntoFuture(range, -1, now)).toBe(false)
    expect(wouldExtendIntoFuture(range, -90, now)).toBe(false)
  })

  it('returns true when a forward nudge would push toMs past now', () => {
    const range = { fromMs: now - 7 * DAY_MS, toMs: now }
    expect(wouldExtendIntoFuture(range, 1, now)).toBe(true)
    expect(wouldExtendIntoFuture(range, 7, now)).toBe(true)
    expect(wouldExtendIntoFuture(range, 90, now)).toBe(true)
  })

  it('returns false when a forward nudge keeps toMs at or before now', () => {
    const range = { fromMs: now - 14 * DAY_MS, toMs: now - 8 * DAY_MS }
    expect(wouldExtendIntoFuture(range, 1, now)).toBe(false)
    expect(wouldExtendIntoFuture(range, 7, now)).toBe(false)
    // Pushing 8d forward lands exactly at now — still allowed.
    expect(wouldExtendIntoFuture(range, 8, now)).toBe(false)
    // 9d crosses into the future.
    expect(wouldExtendIntoFuture(range, 9, now)).toBe(true)
  })
})
