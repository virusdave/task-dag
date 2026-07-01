import { describe, expect, it } from 'vitest'
import {
  RATIO_ZERO_FLOOR_CAP,
  ratioForward,
  ratioInverse,
  ratioTicks,
  ratioZeroFloor,
} from './catalogRatioAxis.js'

const fmtX = (v: number): string =>
  Math.abs(v) >= 10 ? `${v.toFixed(1)}×` : `${v.toFixed(2)}×`

describe('ratioForward', () => {
  it('maps the baseline 1.0 to 0', () => {
    expect(ratioForward(1)).toBe(0)
  })

  it('keeps values above 1 linear (r-1)', () => {
    expect(ratioForward(2)).toBe(1)
    expect(ratioForward(5)).toBe(4)
    expect(ratioForward(50)).toBe(49)
  })

  it('mirrors values below 1 via reciprocal into the negative', () => {
    expect(ratioForward(0.5)).toBeCloseTo(-1, 12)
    expect(ratioForward(1 / 3)).toBeCloseTo(-2, 12)
    expect(ratioForward(0.25)).toBeCloseTo(-3, 12)
  })

  it('is odd-symmetric about the baseline: t(r) === -t(1/r)', () => {
    for (const r of [1.25, 1.5, 2, 3, 4, 7, 10, 25]) {
      expect(ratioForward(r)).toBeCloseTo(-ratioForward(1 / r), 12)
    }
  })

  it('is C¹-continuous at the baseline (matching slopes, no kink)', () => {
    const eps = 1e-6
    const left = (ratioForward(1) - ratioForward(1 - eps)) / eps
    const right = (ratioForward(1 + eps) - ratioForward(1)) / eps
    expect(left).toBeCloseTo(1, 4)
    expect(right).toBeCloseTo(1, 4)
  })
})

describe('ratioInverse', () => {
  it('round-trips representative ratios', () => {
    for (const r of [0.25, 0.5, 2 / 3, 1, 1.5, 2, 4, 10]) {
      expect(ratioInverse(ratioForward(r))).toBeCloseTo(r, 12)
    }
  })
})

describe('ratioZeroFloor', () => {
  it('caps at the mirror of 0.2× when no low performers exist', () => {
    expect(ratioZeroFloor(null)).toBe(RATIO_ZERO_FLOOR_CAP)
    expect(ratioZeroFloor(0)).toBe(RATIO_ZERO_FLOOR_CAP)
    // a min transformed value of -1 (r=0.5) still floors at the cap
    expect(ratioZeroFloor(-1)).toBe(RATIO_ZERO_FLOOR_CAP)
  })

  it('sits below the smallest positive point (correct ordering)', () => {
    // r=0.1 → transformed -9; the zero floor must be strictly below it.
    const minT = ratioForward(0.1) // -9
    const floor = ratioZeroFloor(minT)
    expect(floor).toBeLessThan(minT)
    expect(floor).toBe(-10)
  })
})

describe('ratioTicks', () => {
  it('includes the 1.0× baseline tick when in view', () => {
    const ticks = ratioTicks(-2, 2, { format: fmtX })
    expect(ticks.some((t) => t.pos === 0 && t.label === '1.00×')).toBe(true)
  })

  it('labels are raw ratios, not transformed units', () => {
    const ticks = ratioTicks(-3, 3, { format: fmtX })
    const twoUp = ticks.find((t) => t.pos === 1)
    expect(twoUp?.label).toBe('2.00×')
    const half = ticks.find((t) => Math.abs(t.pos - -1) < 1e-9)
    expect(half?.label).toBe('0.50×')
  })

  it('emits reciprocal pairs symmetrically around the baseline', () => {
    const ticks = ratioTicks(-3, 3, { format: fmtX })
    const labels = new Set(ticks.map((t) => t.label))
    expect(labels.has('2.00×')).toBe(true)
    expect(labels.has('0.50×')).toBe(true)
    expect(labels.has('3.00×')).toBe(true)
  })

  it('stays within the requested tick budget', () => {
    const ticks = ratioTicks(-49, 49, { format: fmtX, maxTicks: 9 })
    expect(ticks.length).toBeLessThanOrEqual(9)
  })

  it('adds a "0×" sentinel tick when a zero floor is present and in range', () => {
    const ticks = ratioTicks(-10, 3, { format: fmtX, zeroFloor: -10 })
    expect(ticks[0]?.label).toBe('0×')
    expect(ticks[0]?.pos).toBe(-10)
  })

  it('omits the zero sentinel when its floor is outside the view', () => {
    const ticks = ratioTicks(-3, 3, { format: fmtX, zeroFloor: -10 })
    expect(ticks.some((t) => t.label === '0×')).toBe(false)
  })

  it('all tick positions lie within the requested window', () => {
    const ticks = ratioTicks(-2, 4, { format: fmtX })
    for (const t of ticks) {
      expect(t.pos).toBeGreaterThanOrEqual(-2)
      expect(t.pos).toBeLessThanOrEqual(4)
    }
  })
})
