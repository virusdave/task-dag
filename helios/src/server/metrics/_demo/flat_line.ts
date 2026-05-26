import type { MetricDef } from '../types.js'
import { defaultWindow, walkBuckets } from '../timeBuckets.js'

/**
 * `_demo.flat_line` — a P0 sanity-check metric.
 *
 * Returns a constant value at every bucket boundary in the requested
 * window. It has no SQL dependency so it can be exercised end-to-end
 * before any real data wiring lands. The chart should render a
 * perfectly horizontal line whose height never changes regardless of
 * site filter, aggregation, or window.
 *
 * The `value` series is intentionally not 1.0 — using `42` makes it
 * easy to confirm with a screenshot that we're seeing the demo and
 * not a real metric whose data happens to be flat.
 */
export const metric: MetricDef = {
  id: '_demo.flat_line',
  group: '_Demo',
  title: 'Demo: flat line (constant 42)',
  description:
    'Sanity-check metric: returns a constant value at every bucket. Use this to confirm the /metrics page tree is wired up end-to-end before pointing real metrics at real data.',
  series: [{ id: 'value', label: 'Constant value', colour: '#888888' }],
  defaultAggregation: 'date',
  supportedAggregations: ['total', 'month', 'week', 'date', 'hour'],
  query: async ({ from, to, agg }) => {
    const window = defaultWindow(from, to, agg)
    return walkBuckets(window.from, window.to, agg).map((t) => ({
      t: t.toISOString(),
      value: 42,
    }))
  },
}
