import { describe, expect, it } from 'vitest'

import { buildContinuousScale, continuumColour } from './continuousScale.js'

describe('buildContinuousScale', () => {
  it('returns null-mapping for degenerate samples (n < 2 or all-equal)', () => {
    const empty = buildContinuousScale([], 'higher')
    expect(empty.toFraction(0)).toBeNull()

    const single = buildContinuousScale([42], 'higher')
    expect(single.min).toBe(42)
    expect(single.max).toBe(42)
    expect(single.toFraction(42)).toBeNull()

    const flat = buildContinuousScale([7, 7, 7, 7], 'higher')
    expect(flat.toFraction(7)).toBeNull()
  })

  it('uses linear scale on data drawn from a uniform distribution', () => {
    // A clean uniform sample on [0, 100], 200 points spread evenly.
    const values: number[] = []
    for (let i = 0; i < 200; i++) values.push((i * 100) / 199)
    const scale = buildContinuousScale(values, 'higher')
    expect(scale.mode).toBe('linear')
    expect(scale.toFraction(0)).toBeCloseTo(0, 4)
    expect(scale.toFraction(50)).toBeCloseTo(0.5, 2)
    expect(scale.toFraction(100)).toBeCloseTo(1, 4)
  })

  it('uses rank stretch on a clearly non-uniform (gaussian-ish) sample', () => {
    // Deterministic bell-shaped sample around 50 with stddev ~5.
    const values: number[] = []
    for (let i = 0; i < 400; i++) {
      const u = (i + 1) / 401
      // Probit approximation via Box-Mueller-ish symmetric form:
      const z = Math.SQRT2 * inverseErf(2 * u - 1)
      values.push(50 + z * 5)
    }
    const scale = buildContinuousScale(values, 'higher')
    expect(scale.mode).toBe('rank')
    // Median value → ~0.5.
    expect(scale.toFraction(50)).toBeGreaterThan(0.45)
    expect(scale.toFraction(50)).toBeLessThan(0.55)
    // 1 stddev above median → ~0.84 (the gaussian Φ(1) ≈ 0.8413).
    const f = scale.toFraction(55)
    expect(f).not.toBeNull()
    expect(f!).toBeGreaterThan(0.75)
    expect(f!).toBeLessThan(0.92)
  })

  it('flips the mapping when betterDirection is "lower"', () => {
    const values: number[] = []
    for (let i = 0; i < 200; i++) values.push((i * 100) / 199)
    const lower = buildContinuousScale(values, 'lower')
    // min is "good" when lower-is-better → near 1.
    expect(lower.toFraction(0)).toBeCloseTo(1, 4)
    expect(lower.toFraction(100)).toBeCloseTo(0, 4)
    expect(lower.toFraction(50)).toBeCloseTo(0.5, 2)
  })

  it('clamps below-min / above-max queries to the empirical extremes', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const scale = buildContinuousScale(values, 'higher')
    expect(scale.toFraction(-100)).toBe(scale.toFraction(1))
    expect(scale.toFraction(9999)).toBe(scale.toFraction(10))
  })

  it('returns null for null / non-finite inputs even with a healthy scale', () => {
    const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    const scale = buildContinuousScale(values, 'higher')
    expect(scale.toFraction(null)).toBeNull()
    expect(scale.toFraction(undefined)).toBeNull()
    expect(scale.toFraction(Number.NaN)).toBeNull()
    expect(scale.toFraction(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('continuumColour', () => {
  it('returns neutral grey for null / NaN', () => {
    expect(continuumColour(null)).toBe('#bdbdbd')
    expect(continuumColour(Number.NaN)).toBe('#bdbdbd')
  })

  it('produces a green-leaning HSL at p=1 ("good")', () => {
    const c = continuumColour(1)
    expect(c).toMatch(/^hsl\(120/)
  })

  it('produces a red-leaning HSL at p=0 ("bad")', () => {
    const c = continuumColour(0)
    expect(c).toMatch(/^hsl\(0\.0/)
  })

  it('produces a low-saturation neutral around p=0.5', () => {
    const c = continuumColour(0.5)
    // hue ~60 (orange/yellow), saturation < 35%
    const m = c.match(/^hsl\(([0-9.]+), ([0-9.]+)%/)
    expect(m).not.toBeNull()
    const hue = Number(m![1])
    const sat = Number(m![2])
    expect(hue).toBeGreaterThan(50)
    expect(hue).toBeLessThan(70)
    expect(sat).toBeLessThan(35)
  })

  it('clamps p outside [0,1] to the extreme colours', () => {
    expect(continuumColour(-1)).toBe(continuumColour(0))
    expect(continuumColour(5)).toBe(continuumColour(1))
  })
})

// Crude inverse-erf used by the gaussian-sample test. Accurate enough
// to put 99% of synthesized values inside ±3σ of the target mean
// while keeping the helper dependency-free.
function inverseErf(x: number): number {
  const a = 0.147
  const ln = Math.log(1 - x * x)
  const t = 2 / (Math.PI * a) + ln / 2
  return Math.sign(x) * Math.sqrt(Math.sqrt(t * t - ln / a) - t)
}
