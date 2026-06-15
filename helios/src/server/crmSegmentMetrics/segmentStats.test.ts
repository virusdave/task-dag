import { describe, expect, it } from 'vitest'

import {
  benjaminiHochberg,
  confidenceLabel,
  normalCdf,
  proportionSampleOk,
  twoProportionTest,
  twoSidedPFromZ,
  welchTest,
} from './segmentStats.js'

describe('normalCdf / twoSidedPFromZ', () => {
  it('matches known normal landmarks', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6)
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3)
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3)
  })

  it('z=1.96 ⇒ two-sided p≈0.05', () => {
    expect(twoSidedPFromZ(1.96)).toBeCloseTo(0.05, 2)
  })
})

describe('twoProportionTest', () => {
  it('computes lift/index and a significant p for a clear difference', () => {
    // 42% vs 18% buyers, healthy n.
    const r = twoProportionTest(420, 1000, 180, 1000)
    expect(r.segmentRate).toBeCloseTo(0.42, 6)
    expect(r.restRate).toBeCloseTo(0.18, 6)
    expect(r.deltaPp).toBeCloseTo(0.24, 6)
    expect(r.index).toBeCloseTo(0.42 / 0.18, 4)
    expect(r.pValue).not.toBeNull()
    expect(r.pValue!).toBeLessThan(0.001)
  })

  it('returns nulls on a zero denominator', () => {
    const r = twoProportionTest(0, 0, 5, 100)
    expect(r.segmentRate).toBeNull()
    expect(r.z).toBeNull()
    expect(r.pValue).toBeNull()
  })
})

describe('proportionSampleOk', () => {
  it('rejects tiny groups', () => {
    expect(proportionSampleOk(5, 10, 5, 200)).toBe(false)
  })
  it('rejects when an expected cell is too small', () => {
    // nSeg ok but only 1 success in segment.
    expect(proportionSampleOk(1, 50, 25, 200)).toBe(false)
  })
  it('accepts healthy, balanced groups', () => {
    expect(proportionSampleOk(120, 300, 80, 400)).toBe(true)
  })
})

describe('welchTest', () => {
  it('flags a clear mean separation', () => {
    const r = welchTest(74.2, 400, 300, 61.1, 380, 900)
    expect(r.delta).toBeCloseTo(13.1, 6)
    expect(r.index).toBeCloseTo(74.2 / 61.1, 4)
    expect(r.pValue).not.toBeNull()
    expect(r.pValue!).toBeLessThan(0.01)
  })
})

describe('benjaminiHochberg', () => {
  it('returns monotone q-values and passes nulls through', () => {
    const q = benjaminiHochberg([0.001, 0.04, 0.2, null])
    expect(q[3]).toBeNull()
    // q-values are non-null for the real p's and bounded by 1.
    expect(q[0]).not.toBeNull()
    expect(q[0]!).toBeLessThanOrEqual(q[1]!)
    expect(q[1]!).toBeLessThanOrEqual(q[2]!)
    expect(q[2]!).toBeLessThanOrEqual(1)
  })

  it('all-null input yields all-null output', () => {
    expect(benjaminiHochberg([null, null])).toEqual([null, null])
  })
})

describe('confidenceLabel', () => {
  it('gates on sample size first', () => {
    expect(confidenceLabel(0.001, false)).toBe('too_small')
    expect(confidenceLabel(null, true)).toBe('too_small')
  })
  it('maps q thresholds', () => {
    expect(confidenceLabel(0.04, true)).toBe('strong')
    expect(confidenceLabel(0.08, true)).toBe('notable')
    expect(confidenceLabel(0.3, true)).toBe('directional')
  })
})
