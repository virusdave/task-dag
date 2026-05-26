import type { MetricDef } from '../types.js'
import { makeStubMetric } from './stubMetric.js'

// P4 metrics — inventory / slow movers / running low.
// All STUBS — see ../_stub/stubMetric.ts and the P7 runbook.
//
// `slowmovers.cost_at_risk` and `lowstock.upcoming_outs` are spec'd as
// "table-as-chart" panels that render inside the same MetricChart
// wrapper in table mode. The table-mode renderer is its own UX piece
// (P4 client-side work). The stub `query` still returns a row-per-SKU
// series so the operator can see the page-tree IA, but the actual
// table rendering is pending — when it lands, the metric stays in this
// registry untouched.

const INVENTORY_CATEGORY_SERIES = [
  { id: 'flower', label: 'Flower', colour: '#2ca02c' },
  { id: 'preroll', label: 'Pre-roll', colour: '#1f77b4' },
  { id: 'edible', label: 'Edible', colour: '#ff7f0e' },
  { id: 'vape', label: 'Vape', colour: '#9467bd' },
  { id: 'concentrate', label: 'Concentrate', colour: '#d62728' },
  { id: 'accessory', label: 'Accessory', colour: '#7f7f7f' },
] as const

export const P4_METRICS: ReadonlyArray<MetricDef> = [
  makeStubMetric({
    id: 'inventory.cost_distribution',
    group: 'Inventory',
    title: 'On-hand inventory cost $ by category',
    description: 'Stacked area: on-hand inventory cost $ at each bucket end, split by top-level category. Subcategory-expandable on click.',
    series: INVENTORY_CATEGORY_SERIES.map((s) => ({ ...s })),
    defaultAggregation: 'date',
    range: { lo: 5_000, hi: 80_000 },
  }),

  makeStubMetric({
    id: 'inventory.misalignment',
    group: 'Inventory',
    title: 'Inventory misalignment (SKU over/under-stock)',
    description:
      'Diverging bar at the latest bucket, ranked by `(on_hand_cost / 30d_cogs_run_rate) - target_ratio`. Positive = over-stocked, negative = under-stocked. Top 25 by absolute deviation.',
    // Stub renders as a single "signed deviation" series; the
    // table-mode renderer will project this into a horizontal bar at
    // the latest t.
    series: [{ id: 'deviation', label: '(on-hand / 30d run-rate) − target', colour: '#9467bd' }],
    defaultAggregation: 'date',
    range: { lo: -1.5, hi: 1.5 },
  }),

  makeStubMetric({
    id: 'slowmovers.cost_at_risk',
    group: 'Slow movers',
    title: 'Cost at risk (slow-moving SKUs)',
    description:
      'TABLE PANEL. Per-SKU cost-at-risk for items we have paid for (or have inbound POs for) that are not moving and/or are about to expire. Real-data columns: SKU, on-hand qty, unit cost, total cost-at-risk, retail value, days-of-supply at current sell-through, days-to-expiry. Stub emits the aggregate cost-at-risk dollars per bucket as a single series so the wire path is exercisable.',
    series: [{ id: 'cost_at_risk_dollars', label: 'Total cost at risk $', colour: '#d62728' }],
    defaultAggregation: 'date',
    range: { lo: 500, hi: 8_000 },
  }),

  makeStubMetric({
    id: 'lowstock.upcoming_outs',
    group: 'Running low',
    title: 'Upcoming stock-outs (next 2-3 days)',
    description:
      'TABLE PANEL. SKUs expected to run out in the next 2-3 days based on rolling sell-through, plus currently-out SKUs whose 21d turn-rate >= reorder qty (i.e. "we wish we were not out"). Expected-margin-loss $ column uses the trailing-21-day daily-margin run-rate per SKU. Stub emits the aggregate expected-margin-loss $ per bucket as a single series.',
    series: [{ id: 'expected_margin_loss_dollars', label: 'Expected margin loss $', colour: '#d62728' }],
    defaultAggregation: 'date',
    range: { lo: 50, hi: 1_500 },
  }),
]
