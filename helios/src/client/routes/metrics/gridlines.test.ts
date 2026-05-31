import { describe, expect, it } from 'vitest'

import {
  bucketXTicks,
  crossMarkerPath,
  formatAxisValue,
  formatXTick,
  formatYTick,
  niceXTicks,
  niceYTicks,
  smoothedPath,
} from './gridlines.js'

describe('niceYTicks', () => {
  it('splits [0, 100] into round-number ticks (default targetCount=5)', () => {
    const { ticks, step } = niceYTicks(0, 100)
    expect(step).toBe(20)
    expect(ticks).toEqual([0, 20, 40, 60, 80, 100])
  })

  it('splits [0, 1] into 0.0/0.2/0.4/0.6/0.8/1.0 — the example from the operator spec', () => {
    const { ticks, step, fractionDigits } = niceYTicks(0, 1)
    expect(step).toBe(0.2)
    expect(fractionDigits).toBe(1)
    expect(ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1])
  })

  it('rounds out-of-range bounds so the first/last tick brackets the data', () => {
    const { ticks } = niceYTicks(3, 47, 5)
    // Step should be 10; ticks 0,10,20,30,40,50
    expect(ticks[0]).toBe(0)
    expect(ticks[ticks.length - 1]).toBe(50)
  })

  it('handles a tiny range without producing absurdly many ticks', () => {
    const { ticks } = niceYTicks(0.998, 1.002, 4)
    // Step should be 0.001; ticks 0.998, 0.999, 1.000, 1.001, 1.002
    expect(ticks.length).toBeLessThanOrEqual(8)
    expect(ticks[0]).toBeLessThanOrEqual(0.998)
    expect(ticks[ticks.length - 1]!).toBeGreaterThanOrEqual(1.002)
  })

  it('never emits a step whose least-significant digit is 3, 7, or 9', () => {
    // Sweep a bunch of (min, max) pairs; every emitted step must come from
    // {1, 2, 2.5, 5} × 10^k.
    const validBases = [1, 2, 2.5, 5, 10]
    for (let max = 1; max <= 1000; max += 7) {
      const { step } = niceYTicks(0, max, 5)
      if (step === 0) continue
      const mag = Math.pow(10, Math.floor(Math.log10(step)))
      const base = step / mag
      const ok = validBases.some((b) => Math.abs(b - base) < 1e-9)
      expect(ok, `bad step ${step} for max=${max} (base=${base})`).toBe(true)
    }
  })

  it('returns a degenerate single tick when min === max', () => {
    const { ticks } = niceYTicks(7, 7, 5)
    expect(ticks).toEqual([7])
  })

  // Regression: stepFractionDigits used to return 0 for step=2.5, causing
  // niceYTicks(0, 12) to emit [0, 3, 5, 8, 10, 13] — exactly the
  // "least-significant digit 3/7/9" outcome the operator forbade. Make
  // sure we keep enough decimal precision for the 2.5×10^k family.
  it('produces clean 2.5-step ticks for [0, 12] (regression: was 0/3/5/8/10/13)', () => {
    const { ticks, step, fractionDigits } = niceYTicks(0, 12)
    expect(step).toBe(2.5)
    expect(fractionDigits).toBe(1)
    expect(ticks).toEqual([0, 2.5, 5, 7.5, 10, 12.5])
  })

  it('produces clean 0.25-step ticks for [0, 1.2]', () => {
    const { ticks, step, fractionDigits } = niceYTicks(0, 1.2)
    expect(step).toBe(0.25)
    expect(fractionDigits).toBe(2)
    expect(ticks).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25])
  })

  it('produces clean 0.025-step ticks for [0, 0.12]', () => {
    const { ticks, step, fractionDigits } = niceYTicks(0, 0.12)
    expect(step).toBe(0.025)
    expect(fractionDigits).toBe(3)
    expect(ticks).toEqual([0, 0.025, 0.05, 0.075, 0.1, 0.125])
  })
})

describe('niceXTicks (numeric X-axis — peer of niceYTicks)', () => {
  // niceXTicks shares the underlying tick-generation math with niceYTicks
  // (same `{1, 2, 2.5, 5, 10} × 10^k` ladder; same `stepFractionDigits`
  // discipline). v1.4 V4'1 wires niceXTicks into the Budtender Advanced
  // and Catalog Analytics scatter renderers; this block protects the
  // helper from drifting away from niceYTicks via copy-paste edits.
  //
  // The 2.5 / 0.25 / 0.025 cases are the same regression the v1.2 R5
  // oracle review caught on niceYTicks ("least-significant digit must
  // be in {0, 2, 5}, never 3/7/9"). The plan calls them out explicitly
  // for niceXTicks too — see v1.4 EPIC §"data contract addenda" item 6.
  it('matches niceYTicks output for identical inputs (single shared math)', () => {
    for (const [min, max] of [
      [0, 100],
      [0, 1],
      [3, 47],
      [0.998, 1.002],
      [-50, 50],
    ] as const) {
      const x = niceXTicks(min, max)
      const y = niceYTicks(min, max)
      expect(x.step).toBe(y.step)
      expect(x.fractionDigits).toBe(y.fractionDigits)
      expect(x.ticks).toEqual(y.ticks)
    }
  })

  it('produces clean 2.5-step ticks for [0, 12] (regression: was 0/3/5/8/10/13)', () => {
    const { ticks, step, fractionDigits } = niceXTicks(0, 12)
    expect(step).toBe(2.5)
    expect(fractionDigits).toBe(1)
    expect(ticks).toEqual([0, 2.5, 5, 7.5, 10, 12.5])
  })

  it('produces clean 0.25-step ticks for [0, 1.2]', () => {
    const { ticks, step, fractionDigits } = niceXTicks(0, 1.2)
    expect(step).toBe(0.25)
    expect(fractionDigits).toBe(2)
    expect(ticks).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25])
  })

  it('produces clean 0.025-step ticks for [0, 0.12]', () => {
    const { ticks, step, fractionDigits } = niceXTicks(0, 0.12)
    expect(step).toBe(0.025)
    expect(fractionDigits).toBe(3)
    expect(ticks).toEqual([0, 0.025, 0.05, 0.075, 0.1, 0.125])
  })

  it('never emits a step whose least-significant digit is 3, 7, or 9', () => {
    // Same sweep as the niceYTicks coverage, extended to the X axis.
    const validBases = [1, 2, 2.5, 5, 10]
    for (let max = 1; max <= 1000; max += 7) {
      const { step } = niceXTicks(0, max, 5)
      if (step === 0) continue
      const mag = Math.pow(10, Math.floor(Math.log10(step)))
      const base = step / mag
      const ok = validBases.some((b) => Math.abs(b - base) < 1e-9)
      expect(ok, `bad step ${step} for max=${max} (base=${base})`).toBe(true)
    }
  })

  it('returns a degenerate single tick when min === max', () => {
    const { ticks } = niceXTicks(7, 7, 5)
    expect(ticks).toEqual([7])
  })
})

describe('formatYTick', () => {
  it('emits the same fractional precision as the step', () => {
    expect(formatYTick(0.2, 1)).toBe('0.2')
    expect(formatYTick(1, 1)).toBe('1.0')
    expect(formatYTick(0, 1)).toBe('0.0')
  })

  it('uses compact notation for thousands+', () => {
    expect(formatYTick(1500, 0)).toBe('1.5K')
    expect(formatYTick(1_250_000, 0)).toBe('1.25M')
  })

  it('emits plain integers when step is whole', () => {
    expect(formatYTick(42, 0)).toBe('42')
  })
})

describe('formatAxisValue (v1.4 V4\'1 — kind-aware tick formatter)', () => {
  describe('$', () => {
    it('renders whole-dollar values without cents', () => {
      expect(formatAxisValue(42, '$')).toBe('$42')
      expect(formatAxisValue(0, '$')).toBe('$0')
    })
    it('renders fractional dollar values with two decimals', () => {
      expect(formatAxisValue(42.5, '$')).toBe('$42.50')
    })
    it('renders sub-dollar values with two decimals', () => {
      expect(formatAxisValue(0.42, '$')).toBe('$0.42')
    })
    it('uses compact currency notation for $1k+', () => {
      // Intl.NumberFormat's compact currency renders differently per
      // locale; we just assert it begins with `$` and contains a
      // K/M magnitude marker so a locale-default tweak doesn't break
      // the test.
      expect(formatAxisValue(1500, '$')).toMatch(/^\$\d/)
      expect(formatAxisValue(1500, '$')).toMatch(/[KM]$/i)
      expect(formatAxisValue(1_250_000, '$')).toMatch(/M$/i)
    })
  })

  describe('int', () => {
    it('renders small integers as plain numerals', () => {
      expect(formatAxisValue(42, 'int')).toBe('42')
      expect(formatAxisValue(0, 'int')).toBe('0')
    })
    it('rounds non-integer inputs', () => {
      expect(formatAxisValue(42.6, 'int')).toBe('43')
    })
    it('uses compact notation for thousands+', () => {
      expect(formatAxisValue(1500, 'int')).toBe('1.5K')
      expect(formatAxisValue(1_250_000, 'int')).toBe('1.25M')
    })
  })

  describe('pct', () => {
    it('multiplies fraction by 100 and appends %', () => {
      expect(formatAxisValue(0.05, 'pct')).toBe('5.0%')
      expect(formatAxisValue(0.42, 'pct')).toBe('42.0%')
      expect(formatAxisValue(1, 'pct')).toBe('100.0%')
    })
    it('renders 0 as 0.0%', () => {
      expect(formatAxisValue(0, 'pct')).toBe('0.0%')
    })
    it('handles values > 1 (e.g. retention overshoot)', () => {
      expect(formatAxisValue(1.5, 'pct')).toBe('150.0%')
    })
  })

  describe('ratio', () => {
    it('renders ratios with a ×-suffix', () => {
      expect(formatAxisValue(1, 'ratio')).toBe('1.00×')
      expect(formatAxisValue(1.5, 'ratio')).toBe('1.50×')
      expect(formatAxisValue(0.75, 'ratio')).toBe('0.75×')
    })
    it('drops precision for larger ratios', () => {
      expect(formatAxisValue(12, 'ratio')).toBe('12.0×')
      expect(formatAxisValue(125, 'ratio')).toBe('125×')
    })
  })

  describe('minutes', () => {
    it('renders sub-hour as Nm', () => {
      expect(formatAxisValue(0, 'minutes')).toBe('0m')
      expect(formatAxisValue(12, 'minutes')).toBe('12m')
      expect(formatAxisValue(59, 'minutes')).toBe('59m')
    })
    it('renders single-hour as 1h with zero-padded minutes', () => {
      expect(formatAxisValue(60, 'minutes')).toBe('1h')
      expect(formatAxisValue(83, 'minutes')).toBe('1h 23m')
    })
    it('renders multi-hour same as single-hour', () => {
      expect(formatAxisValue(125, 'minutes')).toBe('2h 05m')
    })
    it('renders > 1 day as Nd HHh MMm', () => {
      expect(formatAxisValue(24 * 60 + 60 + 5, 'minutes')).toBe('1d 01h 05m')
    })
  })

  it('falls back to String(value) for non-finite inputs', () => {
    expect(formatAxisValue(Number.NaN, '$')).toBe('NaN')
    expect(formatAxisValue(Number.POSITIVE_INFINITY, 'int')).toBe('Infinity')
  })
})

describe('bucketXTicks', () => {
  const from = Date.UTC(2026, 4, 1) // 2026-05-01 UTC
  const oneDay = 24 * 60 * 60 * 1000

  it('places one tick per day for a 7-day visible window at agg=date', () => {
    const ticks = bucketXTicks({
      fromMs: from,
      toMs: from + 7 * oneDay,
      agg: 'date',
      targetCount: 8,
    })
    expect(ticks.length).toBe(8) // inclusive of both ends
    expect(ticks[0]).toBe(from)
    expect(ticks[ticks.length - 1]).toBe(from + 7 * oneDay)
  })

  it('skips to every-Nth-day when the window is wide enough that one-per-bucket would over-pack', () => {
    // 90-day window at date grain, target ~6 ticks → 16-day step
    const ticks = bucketXTicks({
      fromMs: from,
      toMs: from + 90 * oneDay,
      agg: 'date',
      targetCount: 6,
    })
    expect(ticks.length).toBeGreaterThan(2)
    expect(ticks.length).toBeLessThanOrEqual(10)
    // Step between consecutive ticks should be the same uniform stride.
    const step = ticks[1]! - ticks[0]!
    for (let i = 2; i < ticks.length; i += 1) {
      expect(ticks[i]! - ticks[i - 1]!).toBe(step)
    }
  })

  it('aligns week ticks to ISO Monday', () => {
    // Visible window spans 4 weeks; expect every tick to be a Monday UTC.
    const start = Date.UTC(2026, 4, 4) // 2026-05-04 is a Monday
    const ticks = bucketXTicks({
      fromMs: start,
      toMs: start + 28 * oneDay,
      agg: 'week',
      targetCount: 4,
    })
    for (const t of ticks) {
      const d = new Date(t)
      // JS getUTCDay: Sun=0..Sat=6. Monday = 1.
      expect(d.getUTCDay(), `tick ${d.toISOString()} not a Monday`).toBe(1)
    }
  })

  it('aligns month ticks to first-of-month', () => {
    const ticks = bucketXTicks({
      fromMs: Date.UTC(2025, 11, 15), // mid-Dec 2025
      toMs: Date.UTC(2026, 5, 15), // mid-Jun 2026
      agg: 'month',
      targetCount: 5,
    })
    for (const t of ticks) {
      const d = new Date(t)
      expect(d.getUTCDate(), `tick ${d.toISOString()} not first-of-month`).toBe(1)
    }
  })

  it('degrades to fewer-but-still-aligned ticks for a year-long hour-grain window', () => {
    // 1 year of hourly buckets is 8760 grain units. Even at target=8 the
    // old hardcoded 96-step ceiling would produce ~90 ticks; the
    // extended ladder should pick a much coarser step instead.
    const yearMs = 365 * oneDay
    const ticks = bucketXTicks({
      fromMs: from,
      toMs: from + yearMs,
      agg: 'hour',
      targetCount: 8,
    })
    expect(ticks.length).toBeLessThanOrEqual(16)
    expect(ticks.length).toBeGreaterThan(2)
  })

  it('returns an empty array for categorical aggregations', () => {
    for (const agg of ['total', 'dow', 'dom', 'dofortnight'] as const) {
      const ticks = bucketXTicks({
        fromMs: from,
        toMs: from + 30 * oneDay,
        agg,
      })
      expect(ticks).toEqual([])
    }
  })
})

describe('formatXTick', () => {
  it('emits MMM DD for date / week ticks within a single year', () => {
    const t = Date.UTC(2026, 4, 18)
    expect(formatXTick(t, 'date')).toMatch(/May 18/)
    expect(formatXTick(t, 'week')).toMatch(/May 18/)
  })

  it('emits YYYY MMM DD when the visible window straddles a year boundary', () => {
    const t = Date.UTC(2026, 0, 4)
    expect(formatXTick(t, 'date', { straddlesYear: true })).toBe('2026 Jan 04')
  })

  it('emits MMM YYYY for month ticks', () => {
    expect(formatXTick(Date.UTC(2026, 4, 1), 'month')).toBe('May 2026')
  })

  it('emits MM-DD HH:00 in UTC for hour ticks', () => {
    const t = Date.UTC(2026, 4, 18, 14)
    expect(formatXTick(t, 'hour')).toBe('05-18 14:00')
  })
})

describe('smoothedPath', () => {
  it('returns an empty string for no points', () => {
    expect(smoothedPath([])).toBe('')
  })

  it('returns a single M for one point', () => {
    expect(smoothedPath([{ x: 10, y: 20 }])).toBe('M10.00,20.00')
  })

  it('returns a straight M…L… line for two points', () => {
    expect(smoothedPath([{ x: 0, y: 0 }, { x: 10, y: 10 }])).toBe('M0.00,0.00 L10.00,10.00')
  })

  it('emits cubic Bezier segments between three or more points', () => {
    const d = smoothedPath([
      { x: 0, y: 0 },
      { x: 10, y: 5 },
      { x: 20, y: 0 },
    ])
    expect(d).toMatch(/^M0\.00,0\.00 C/)
    // One C segment per gap between adjacent points → 2 C segments for 3 points.
    const cCount = (d.match(/ C/g) ?? []).length
    expect(cCount).toBe(2)
  })

  it('passes through every input point (endpoints land exactly on the curve)', () => {
    // For Catmull-Rom-derived Beziers the curve interpolates through every
    // control point — the final coord of each C segment IS the next data
    // point. Assert the path ends at the last point.
    const d = smoothedPath([
      { x: 0, y: 0 },
      { x: 10, y: 5 },
      { x: 20, y: 0 },
      { x: 30, y: 7 },
    ])
    expect(d).toContain('30.00,7.00')
  })
})

describe('crossMarkerPath', () => {
  it('emits two crossed line segments centred on (x, y)', () => {
    expect(crossMarkerPath(10, 20, 3)).toBe('M7.00,17.00 L13.00,23.00 M13.00,17.00 L7.00,23.00')
  })

  it('defaults the arm length to 3 px', () => {
    expect(crossMarkerPath(0, 0)).toBe('M-3.00,-3.00 L3.00,3.00 M3.00,-3.00 L-3.00,3.00')
  })
})
