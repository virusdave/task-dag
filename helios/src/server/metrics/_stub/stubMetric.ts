import type { MetricDef, MetricRow, MetricQueryArgs } from '../types.js'
import { defaultWindow, walkBuckets } from '../timeBuckets.js'

/**
 * Stub metric factory.
 *
 * P1 ships the chart wrapper + page shell. P2-P6 each ship a group of
 * real-data metrics. Real-data metrics require either (a) a new Sweed
 * orders-ingest pipeline that materialises completed orders +
 * line-items + costs into a helios-owned table, or (b) inline
 * `store.sale.invoice.list` RPC calls per-query (slow, rate-limited).
 * Either route is its own multi-week piece of work and is tracked
 * as a separate sibling epic — see the P7 runbook for the cross-link.
 *
 * In the meantime, the registry exposes every spec'd metric id as a
 * **stub** that returns a deterministic synthetic series at the
 * requested bucket boundaries. The stub:
 *
 *   1. Lets operators see the full /metrics IA today (left-nav, chart
 *      frame, annotation surface, site filter + aggregation controls)
 *      without waiting on the data pipeline.
 *   2. Documents the exact `MetricDef` shape each real metric will
 *      have when it lands — same id, same `group`, same `series`,
 *      same `defaultAggregation`, same `supportedAggregations`. The
 *      data-side work is then strictly a body-of-`query` swap.
 *   3. Is unmistakeable in the UI: every stub carries
 *      "STUB: synthetic data — real-data SQL pending" in its
 *      description so a reviewer can't confuse it with a real
 *      metric. (The metric's title and series labels are the real
 *      production labels, so screenshots line up.)
 *
 * The synthetic data is a deterministic per-series random walk
 * seeded from the bucket epoch-second + a per-series salt. Same
 * window + agg = same bytes on the wire, so the chart doesn't shimmer
 * during P1 UI iteration.
 */
export function makeStubMetric(input: {
  readonly id: string
  readonly group: string
  readonly title: string
  /** Real-metric description (the stub prefix is appended automatically). */
  readonly description: string
  readonly series: ReadonlyArray<{ readonly id: string; readonly label: string; readonly colour?: string }>
  readonly defaultAggregation: MetricDef['defaultAggregation']
  readonly supportedAggregations?: MetricDef['supportedAggregations']
  /**
   * Pseudo-random walk range. Defaults to [0, 100]. Set to e.g.
   * { lo: 0, hi: 1, format: 'fraction' } for percentage / fraction
   * metrics that should look like ratios in the chart.
   */
  readonly range?: { lo: number; hi: number }
}): MetricDef {
  const range = input.range ?? { lo: 0, hi: 100 }
  const supported = input.supportedAggregations ?? ['total', 'month', 'week', 'date', 'hour']
  return {
    id: input.id,
    group: input.group,
    title: input.title,
    description: `STUB: synthetic data — real-data SQL pending. ${input.description}`,
    series: input.series.map((s) => ({ id: s.id, label: s.label, colour: s.colour })),
    defaultAggregation: input.defaultAggregation,
    supportedAggregations: supported,
    query: async (args: MetricQueryArgs): Promise<MetricRow[]> => {
      const window = defaultWindow(args.from, args.to, args.agg)
      const buckets = walkBuckets(window.from, window.to, args.agg)
      // One independent random-walk per series.
      const lastValues: number[] = input.series.map(
        (_, i) => range.lo + ((range.hi - range.lo) * (0.3 + 0.4 * (i / Math.max(1, input.series.length - 1)))),
      )
      return buckets.map((t) => {
        const row: Record<string, string | number | null> = { t: t.toISOString() }
        const seed = Math.floor(t.getTime() / 1000)
        input.series.forEach((s, i) => {
          const salt = hashCode(s.id) + i * 1009
          const step = ((lcg(seed + salt) % 1000) / 1000 - 0.5) * (range.hi - range.lo) * 0.08
          lastValues[i] = clamp(lastValues[i]! + step, range.lo, range.hi)
          row[s.id] = round2(lastValues[i]!)
        })
        return row as MetricRow
      })
    },
  }
}

function lcg(seed: number): number {
  return ((Math.imul(seed | 0, 1664525) + 1013904223) >>> 0)
}

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return h
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
