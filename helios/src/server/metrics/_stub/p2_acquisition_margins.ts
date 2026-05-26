import type { MetricDef } from '../types.js'
import { makeStubMetric } from './stubMetric.js'

// P2 metrics — Customer acquisition + Margins.
//
// These are STUBS. Per the runbook (docs/runbooks/helios-metrics.md),
// shipping a real-data implementation here requires either an orders
// ingest pipeline that materialises completed Sweed sales into a
// helios-owned table, OR a per-query `store.sale.invoice.list` RPC
// caller (slow + rate-limited but viable for low-traffic dashboards).
// When a real implementation lands, the entry in this file is rewritten
// in place — id / group / title / series stay the same so historical
// annotations and operator screenshots still line up.

export const P2_METRICS: ReadonlyArray<MetricDef> = [
  makeStubMetric({
    id: 'acquisition.first_vs_returning',
    group: 'Customer acquisition',
    title: 'New vs returning customer purchases',
    description:
      'Stacked count of completed orders per bucket, split by whether the buying customer had any prior completed order in our system. Pinned definition: "first-time on order O iff no prior completed order exists for the same Sweed customer_id".',
    series: [
      { id: 'first_time', label: 'First-time', colour: '#2ca02c' },
      { id: 'returning', label: 'Returning', colour: '#1f77b4' },
    ],
    defaultAggregation: 'week',
  }),

  makeStubMetric({
    id: 'margins.effective_gm_pct',
    group: 'Margins',
    title: 'Effective gross margin %',
    description:
      'Sum(line item price - wholesale cost) / sum(line item price) across completed orders in the bucket. Line items without a known wholesale cost are excluded from the denominator AND the numerator so unknown-cost items do not skew the ratio.',
    series: [{ id: 'gm_pct', label: 'Effective GM %', colour: '#9467bd' }],
    defaultAggregation: 'week',
    range: { lo: 0.15, hi: 0.45 },
  }),

  makeStubMetric({
    id: 'margins.gross_margin_dollars',
    group: 'Margins',
    title: 'Gross margin $',
    description:
      'Sum(line item price - wholesale cost) across completed orders in the bucket. Unknown-cost line items contribute 0 to the numerator.',
    series: [{ id: 'gm_dollars', label: 'Gross margin $', colour: '#d62728' }],
    defaultAggregation: 'week',
    range: { lo: 1_000, hi: 12_000 },
  }),

  makeStubMetric({
    id: 'margins.stack_new_vs_returning',
    group: 'Margins',
    title: 'Gross margin $ — new vs returning customer',
    description:
      'Same gross margin $ as margins.gross_margin_dollars, stacked by first-time vs returning customer (same first-time definition as acquisition.first_vs_returning).',
    series: [
      { id: 'first_time', label: 'First-time customer', colour: '#2ca02c' },
      { id: 'returning', label: 'Returning customer', colour: '#1f77b4' },
    ],
    defaultAggregation: 'week',
    range: { lo: 500, hi: 6_000 },
  }),
]
