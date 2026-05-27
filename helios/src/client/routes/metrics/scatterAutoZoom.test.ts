import { describe, expect, it } from 'vitest'

import { computeCompactDomain } from './scatterAutoZoom.js'

interface P {
  x: number
  y: number
}

function uniform(n: number, lo: number, hi: number, axis: 'x' | 'y'): P[] {
  const out: P[] = []
  for (let i = 0; i < n; i += 1) {
    const t = i / Math.max(1, n - 1)
    const v = lo + t * (hi - lo)
    out.push(axis === 'x' ? { x: v, y: 0 } : { x: 0, y: v })
  }
  return out
}

describe('computeCompactDomain', () => {
  it('returns null compact/full when there are no finite points', () => {
    const r = computeCompactDomain([])
    expect(r.compact).toBeNull()
    expect(r.full).toBeNull()
    expect(r.hiddenCount).toBe(0)
  })

  it('falls back to full extent when below minPoints', () => {
    const pts: P[] = uniform(5, 0, 10, 'x')
    const r = computeCompactDomain(pts)
    expect(r.compact?.xMin).toBeLessThanOrEqual(0)
    expect(r.compact?.xMax).toBeGreaterThanOrEqual(10)
    // No points hidden when compact == full.
    expect(r.hiddenCount).toBe(0)
  })

  it('falls back to full extent when minTrimPerTail blocks the trim', () => {
    // 30 points: p5 => floor(30*0.05) = 1 (< default minTrimPerTail of 3).
    const pts: P[] = uniform(30, 0, 100, 'x')
    const r = computeCompactDomain(pts)
    // compact should equal the padded full extent because trim is skipped.
    expect(r.hiddenCount).toBe(0)
    expect(r.compact?.xMin).toBeCloseTo(-5, 6)
    expect(r.compact?.xMax).toBeCloseTo(105, 6)
  })

  it('clips a single far X outlier on a 100-point dataset', () => {
    // 99 X values evenly spread in [0,10], plus one huge outlier at 1e6.
    const pts: P[] = uniform(99, 0, 10, 'x')
    pts.push({ x: 1e6, y: 0 })
    const r = computeCompactDomain(pts)
    expect(r.compact).not.toBeNull()
    // Compact x range should be near the [0,10] cluster, not anywhere
    // near the outlier.
    expect(r.compact!.xMax).toBeLessThan(20)
    expect(r.compact!.xMin).toBeGreaterThan(-1)
    // Full range should span the outlier.
    expect(r.full!.xMax).toBeGreaterThan(1e5)
    // The outlier should be counted as hidden.
    expect(r.hiddenCount).toBeGreaterThanOrEqual(1)
  })

  it('trims independently on x and y axes', () => {
    const pts: P[] = []
    for (let i = 0; i < 100; i += 1) {
      pts.push({ x: i, y: 100 - i })
    }
    pts.push({ x: 1e9, y: 5 }) // x outlier only
    pts.push({ x: 50, y: -1e9 }) // y outlier only
    const r = computeCompactDomain(pts)
    expect(r.compact!.xMax).toBeLessThan(1e5)
    expect(r.compact!.yMin).toBeGreaterThan(-1e5)
    expect(r.hiddenCount).toBeGreaterThanOrEqual(2)
  })

  it('honours fullDomain override when provided', () => {
    const pts: P[] = uniform(100, 0, 100, 'x')
    const externalFull = { xMin: -50, xMax: 200, yMin: -50, yMax: 200 }
    const r = computeCompactDomain(pts, { fullDomain: externalFull })
    expect(r.full).toEqual(externalFull)
  })

  it('handles all-identical column without producing zero-width range', () => {
    const pts: P[] = Array.from({ length: 50 }, () => ({ x: 7, y: 7 }))
    const r = computeCompactDomain(pts)
    expect(r.compact).not.toBeNull()
    expect(r.compact!.xMax).toBeGreaterThan(r.compact!.xMin)
    expect(r.compact!.yMax).toBeGreaterThan(r.compact!.yMin)
    expect(r.hiddenCount).toBe(0)
  })

  it('ignores non-finite points entirely', () => {
    const pts: P[] = [
      ...uniform(100, 0, 100, 'x'),
      { x: NaN, y: 0 },
      { x: Infinity, y: 5 },
      { x: 5, y: NaN },
    ]
    const r = computeCompactDomain(pts)
    expect(r.finiteCount).toBe(100)
    expect(r.compact).not.toBeNull()
    // Compact x is around [5, 95], padded — not affected by NaN/Infinity.
    expect(r.compact!.xMax).toBeLessThan(120)
  })

  it('clamps compact inside full', () => {
    const pts: P[] = uniform(100, 0, 100, 'x')
    const r = computeCompactDomain(pts)
    expect(r.compact!.xMin).toBeGreaterThanOrEqual(r.full!.xMin)
    expect(r.compact!.xMax).toBeLessThanOrEqual(r.full!.xMax)
    expect(r.compact!.yMin).toBeGreaterThanOrEqual(r.full!.yMin)
    expect(r.compact!.yMax).toBeLessThanOrEqual(r.full!.yMax)
  })
})
