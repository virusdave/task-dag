import type { MetricDef, MetricRow, MetricQueryArgs } from '../types.js'

/**
 * Missing-data metric factory.
 *
 * Every metric in the parent epic's spec is registered as a `MetricDef`
 * so the operator can see what /metrics tracks. Metrics whose underlying
 * ingest pipeline isn't wired up yet are produced with this factory.
 *
 * Hard rule (per operator directive 2026-05-26): **we do not make data
 * up**. There is no synthetic random walk, no flat line, no demo series.
 * The query returns an empty time series. The dashboard renders these as
 * explicit "MISSING DATA" placeholder cards (see `MetricsLayoutPage.tsx`
 * and the `dataStatus: 'pending'` flag set by the registry), so a viewer
 * can never confuse a stubbed metric with real business signal.
 *
 * The metric metadata (id, group, title, series, default/supported
 * aggregations) is the real production metadata — when the ingest lands,
 * the data-side work is strictly a `query` swap into `_real/`.
 */
export function makeStubMetric(input: {
  readonly id: string
  readonly group: string
  readonly title: string
  readonly description: string
  readonly series: ReadonlyArray<{ readonly id: string; readonly label: string; readonly colour?: string }>
  readonly defaultAggregation: MetricDef['defaultAggregation']
  readonly supportedAggregations?: MetricDef['supportedAggregations']
  /**
   * Kept in the signature so the existing per-metric files don't churn,
   * but ignored — no synthetic data is generated regardless of range.
   */
  readonly range?: { lo: number; hi: number }
}): MetricDef {
  const supported = input.supportedAggregations ?? ['total', 'month', 'week', 'date', 'hour']
  return {
    id: input.id,
    group: input.group,
    title: input.title,
    description: input.description,
    series: input.series.map((s) => ({ id: s.id, label: s.label, colour: s.colour })),
    defaultAggregation: input.defaultAggregation,
    supportedAggregations: supported,
    // No data. Ever. The dashboard renders missing-data metrics as
    // placeholders without calling this query, but anyone hitting the
    // raw API endpoint will see an empty time series rather than
    // synthetic numbers.
    query: async (_args: MetricQueryArgs): Promise<MetricRow[]> => [],
  }
}
