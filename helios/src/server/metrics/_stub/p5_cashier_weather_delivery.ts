import type { MetricDef } from '../types.js'
import { makeStubMetric } from './stubMetric.js'

// P5 metrics — cashier throughput + weather correlation + delivery sub-line.
// All STUBS — see ../_stub/stubMetric.ts and the P7 runbook.
//
// The weather.scatter_* metrics are spec'd as scatter plots (one dot
// per day, x = weather variable, y = margin $). The stub emits a
// daily margin-$ series; when the scatter chart type lands in the
// client and the NOAA ingest lands in the worker, the metric's
// `query` is rewritten to return one row per day with both axes
// populated as separate keys, and the chart wrapper picks the
// scatter renderer based on a flag on the MetricDef.

export const P5_METRICS: ReadonlyArray<MetricDef> = [
  makeStubMetric({
    id: 'cashier.transactions_per_hour',
    group: 'Cashier throughput',
    title: 'Transactions per cashier-hour',
    description:
      'Line chart: transactions per paid non-manager cashier-hour. Source: Sweed Shifts RPC for Cashier-role logins (non-manager filtered at the role level), joined with order timestamps. The cashier-level upsell-lift / statistical-significance breakdown is v2 — explicitly out of scope for the v1 framework epic.',
    series: [{ id: 'tx_per_hour', label: 'Transactions per cashier-hour', colour: '#1f77b4' }],
    defaultAggregation: 'date',
    range: { lo: 4, hi: 22 },
  }),

  makeStubMetric({
    id: 'weather.scatter_margin_vs_high_temp',
    group: 'Weather correlation',
    title: 'Margin $ vs daily high temperature',
    description:
      'Scatter (one dot per day): x = daily high °F at the per-site weather station, y = margin $. NOAA station list lives in helios config (NYC default: KLGA primary / KJFK fallback).',
    series: [{ id: 'margin_dollars', label: 'Daily margin $ (stub)', colour: '#d62728' }],
    defaultAggregation: 'date',
    range: { lo: 500, hi: 9_000 },
  }),

  makeStubMetric({
    id: 'weather.scatter_margin_vs_low_temp',
    group: 'Weather correlation',
    title: 'Margin $ vs daily low temperature',
    description: 'Scatter (one dot per day): x = daily low °F at the per-site weather station, y = margin $.',
    series: [{ id: 'margin_dollars', label: 'Daily margin $ (stub)', colour: '#1f77b4' }],
    defaultAggregation: 'date',
    range: { lo: 500, hi: 9_000 },
  }),

  makeStubMetric({
    id: 'weather.scatter_margin_vs_precip',
    group: 'Weather correlation',
    title: 'Margin $ vs daily precipitation',
    description: 'Scatter (one dot per day): x = daily precipitation (inches), y = margin $.',
    series: [{ id: 'margin_dollars', label: 'Daily margin $ (stub)', colour: '#9467bd' }],
    defaultAggregation: 'date',
    range: { lo: 500, hi: 9_000 },
  }),

  // delivery.order_count_by_zone is now a real metric backed by
  // sweed_orders.delivery_address_id → addresses joins (see
  // FreshlyBakedNYC/automation#25 A6, registered in
  // _real/realMetrics.ts).

  makeStubMetric({
    id: 'delivery.margin_pct',
    group: 'Delivery',
    title: 'Effective GM % — delivery vs non-delivery',
    description:
      'Two lines: effective gross margin % on delivery orders only, plus a comparison line for non-delivery orders. Surfaces whether delivery is cannibalising margin once driver / packaging / processing cost is in the picture.',
    series: [
      { id: 'delivery_gm_pct', label: 'Delivery GM %', colour: '#d62728' },
      { id: 'non_delivery_gm_pct', label: 'Non-delivery GM %', colour: '#7f7f7f' },
    ],
    defaultAggregation: 'week',
    range: { lo: 0.1, hi: 0.45 },
  }),
]
