import { describe, expect, it } from 'vitest'

import {
  computeLineYRange,
  resolveYAxisBaseline,
} from './yAxisBaseline.js'

describe('resolveYAxisBaseline', () => {
  it('honours an explicit per-chart choice regardless of page default', () => {
    expect(resolveYAxisBaseline('zero', 'data')).toBe('zero')
    expect(resolveYAxisBaseline('zero', 'per-chart')).toBe('zero')
    expect(resolveYAxisBaseline('data', 'zero')).toBe('data')
    expect(resolveYAxisBaseline('data', 'per-chart')).toBe('data')
  })

  it('inherits the page default when the chart defers', () => {
    expect(resolveYAxisBaseline('page', 'zero')).toBe('zero')
    expect(resolveYAxisBaseline('page', 'data')).toBe('data')
  })

  it("falls back to float ('data') when chart defers and page imposes no policy", () => {
    expect(resolveYAxisBaseline('page', 'per-chart')).toBe('data')
  })
})

describe('computeLineYRange', () => {
  it("floats to the data range with 5% padding under 'data'", () => {
    const { yMin, yMax } = computeLineYRange(10, 20, 'data')
    expect(yMin).toBeCloseTo(9.5, 6) // 10 - 0.05*10
    expect(yMax).toBeCloseTo(20.5, 6) // 20 + 0.05*10
  })

  it("does NOT include zero under 'data' for an all-positive series", () => {
    const { yMin } = computeLineYRange(100, 200, 'data')
    expect(yMin).toBeGreaterThan(0)
  })

  it("extends an all-positive range down to a flush zero under 'zero'", () => {
    const { yMin, yMax } = computeLineYRange(100, 200, 'zero')
    expect(yMin).toBe(0) // flush, no padding past zero
    expect(yMax).toBeCloseTo(200 + 0.05 * 200, 6) // top still padded
  })

  it("extends an all-negative range up to a flush zero under 'zero'", () => {
    const { yMin, yMax } = computeLineYRange(-200, -100, 'zero')
    expect(yMax).toBe(0) // flush at the top
    expect(yMin).toBeCloseTo(-200 - 0.05 * 200, 6) // bottom padded
  })

  it("pads both ends when zero is interior to the data range under 'zero'", () => {
    const { yMin, yMax } = computeLineYRange(-50, 50, 'zero')
    const span = 100
    expect(yMin).toBeCloseTo(-50 - 0.05 * span, 6)
    expect(yMax).toBeCloseTo(50 + 0.05 * span, 6)
  })

  it('collapses non-finite extents to [0, 1]', () => {
    expect(computeLineYRange(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 'data')).toEqual({
      yMin: 0,
      yMax: 1,
    })
  })

  it('expands a degenerate flat range by ±1', () => {
    expect(computeLineYRange(5, 5, 'data')).toEqual({ yMin: 4, yMax: 6 })
  })

  it("expands a flat all-positive range to include zero under 'zero'", () => {
    // lo=hi=5 → after zero-extend lo=0, hi=5 → padded top only
    const { yMin, yMax } = computeLineYRange(5, 5, 'zero')
    expect(yMin).toBe(0)
    expect(yMax).toBeCloseTo(5 + 0.05 * 5, 6)
  })
})
