import type { MetricDef } from '../types.js'
import { defaultWindow, walkBuckets } from '../timeBuckets.js'

/**
 * `_demo.random_walk` — a P0 sanity-check metric.
 *
 * Returns a deterministic pseudo-random walk seeded from the bucket
 * timestamp, so the same window + aggregation always returns the
 * same data. Two series ("series_a", "series_b") let the chart
 * wrapper exercise multi-series rendering, hover-tooltip alignment,
 * and stacked rendering without needing to wait on real SQL.
 *
 * Deterministic by design — using `Math.random()` would make the
 * chart shimmer on every reload and would confuse the operator
 * during P1 chart-wrapper UI development.
 */
export const metric: MetricDef = {
  id: '_demo.random_walk',
  group: '_Demo',
  title: 'Demo: random walk (two series)',
  description:
    'Sanity-check metric: two deterministic pseudo-random walks. Use this to confirm multi-series rendering, hover tooltips, and stacking before pointing real metrics at real data.',
  series: [
    { id: 'series_a', label: 'Series A', colour: '#1f77b4' },
    { id: 'series_b', label: 'Series B', colour: '#ff7f0e' },
  ],
  defaultAggregation: 'date',
  supportedAggregations: ['total', 'month', 'week', 'date', 'hour'],
  query: async ({ from, to, agg }) => {
    const window = defaultWindow(from, to, agg)
    const buckets = walkBuckets(window.from, window.to, agg)
    let a = 50
    let b = 50
    return buckets.map((t) => {
      // Deterministic LCG seeded by the bucket epoch-second; gives
      // values in roughly `[-5, +5]` per step which keeps the walk
      // visually interesting without diverging fast.
      const seed = Math.floor(t.getTime() / 1000)
      const deltaA = (lcg(seed) % 1000) / 100 - 5
      const deltaB = (lcg(seed + 999983) % 1000) / 100 - 5
      a = clamp(a + deltaA, 0, 100)
      b = clamp(b + deltaB, 0, 100)
      return { t: t.toISOString(), series_a: round2(a), series_b: round2(b) }
    })
  },
}

/** A tiny LCG (Numerical Recipes constants). 32-bit unsigned output. */
function lcg(seed: number): number {
  // Math.imul keeps the intermediate product inside the 32-bit signed
  // range so we don't lose precision past 2**31.
  return ((Math.imul(seed | 0, 1664525) + 1013904223) >>> 0)
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
