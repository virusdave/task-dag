import type { MetricDef } from '../types.js'
import { makeStubMetric } from './stubMetric.js'

// P3 metrics — basket / category / fulfillment / payment.
// All STUBS — see ../_stub/stubMetric.ts and the P7 runbook.

const FULFILLMENT_SERIES = [
  { id: 'delivery_prepaid', label: 'Delivery (prepaid)', colour: '#1f77b4' },
  { id: 'delivery_cod', label: 'Delivery (COD)', colour: '#aec7e8' },
  { id: 'kiosk', label: 'Kiosk', colour: '#2ca02c' },
  { id: 'pickup', label: 'Pickup', colour: '#ff7f0e' },
  { id: 'in_store', label: 'In-store', colour: '#9467bd' },
] as const

const PAYMENT_SERIES = [
  { id: 'cash', label: 'Cash', colour: '#2ca02c' },
  { id: 'debit', label: 'Debit', colour: '#1f77b4' },
  { id: 'credit', label: 'Credit', colour: '#d62728' },
  { id: 'aeropay', label: 'Aeropay', colour: '#9467bd' },
  { id: 'other', label: 'Other', colour: '#7f7f7f' },
] as const

// Category names are placeholders that match the menu's current top-level
// taxonomy; the real-data SQL re-derives these from
// `store.product.category.list` so renames flow through without touching
// the registry.
const CATEGORY_SERIES = [
  { id: 'flower', label: 'Flower', colour: '#2ca02c' },
  { id: 'preroll', label: 'Pre-roll', colour: '#1f77b4' },
  { id: 'edible', label: 'Edible', colour: '#ff7f0e' },
  { id: 'vape', label: 'Vape', colour: '#9467bd' },
  { id: 'concentrate', label: 'Concentrate', colour: '#d62728' },
  { id: 'accessory', label: 'Accessory', colour: '#7f7f7f' },
] as const

export const P3_METRICS: ReadonlyArray<MetricDef> = [
  // ----- Basket size -----
  makeStubMetric({
    id: 'basket.size_by_fulfillment',
    group: 'Basket size',
    title: 'Avg basket $ by fulfillment type',
    description:
      'Grouped bar: average basket $ per completed order in the bucket, grouped by fulfillment type (delivery prepaid, delivery COD, kiosk, pickup, in-store).',
    series: FULFILLMENT_SERIES.map((s) => ({ ...s })),
    defaultAggregation: 'week',
    range: { lo: 40, hi: 180 },
  }),

  makeStubMetric({
    id: 'basket.size_by_customer_type',
    group: 'Basket size',
    title: 'Avg basket $ by new vs returning customer',
    description: 'Grouped bar: average basket $ per completed order in the bucket, split by first-time vs returning customer.',
    series: [
      { id: 'first_time', label: 'First-time', colour: '#2ca02c' },
      { id: 'returning', label: 'Returning', colour: '#1f77b4' },
    ],
    defaultAggregation: 'week',
    range: { lo: 30, hi: 200 },
  }),

  // ----- Category distribution -----
  makeStubMetric({
    id: 'category.sales_stack_dollars',
    group: 'Category distribution',
    title: 'Sales $ by category (stacked)',
    description:
      'Stacked area: sales $ per bucket, split by top-level category. Operators can click a category in the stack to re-render with the clicked category split into subcategories (see P3 category-expand spec).',
    series: CATEGORY_SERIES.map((s) => ({ ...s })),
    defaultAggregation: 'week',
    range: { lo: 200, hi: 4_000 },
  }),

  makeStubMetric({
    id: 'category.sales_stack_fraction',
    group: 'Category distribution',
    title: 'Sales mix by category (100% stacked)',
    description:
      'Stacked area normalised to 100%: fraction of sales $ per bucket coming from each top-level category. Subcategory-expandable on click.',
    series: CATEGORY_SERIES.map((s) => ({ ...s })),
    defaultAggregation: 'week',
    range: { lo: 0, hi: 1 },
  }),

  makeStubMetric({
    id: 'category.margin_dollars_stack',
    group: 'Category distribution',
    title: 'Margin $ by category (stacked)',
    description: 'Stacked area: gross margin $ per bucket, split by top-level category. Subcategory-expandable on click.',
    series: CATEGORY_SERIES.map((s) => ({ ...s })),
    defaultAggregation: 'week',
    range: { lo: 100, hi: 1_500 },
  }),

  // ----- Fulfillment & payment breakdown -----
  makeStubMetric({
    id: 'fulfillment.order_count',
    group: 'Fulfillment & payment',
    title: 'Order count by fulfillment type',
    description: 'Stacked area: completed-order count per bucket, split by fulfillment type.',
    series: FULFILLMENT_SERIES.map((s) => ({ ...s })),
    defaultAggregation: 'week',
    range: { lo: 5, hi: 250 },
  }),

  makeStubMetric({
    id: 'fulfillment.sales_dollars',
    group: 'Fulfillment & payment',
    title: 'Sales $ by fulfillment type',
    description: 'Stacked area: sales $ per bucket, split by fulfillment type.',
    series: FULFILLMENT_SERIES.map((s) => ({ ...s })),
    defaultAggregation: 'week',
    range: { lo: 200, hi: 6_000 },
  }),

  makeStubMetric({
    id: 'fulfillment.margin_dollars',
    group: 'Fulfillment & payment',
    title: 'Margin $ by fulfillment type',
    description: 'Stacked area: gross margin $ per bucket, split by fulfillment type.',
    series: FULFILLMENT_SERIES.map((s) => ({ ...s })),
    defaultAggregation: 'week',
    range: { lo: 50, hi: 1_800 },
  }),

  makeStubMetric({
    id: 'fulfillment.effective_gm_pct',
    group: 'Fulfillment & payment',
    title: 'Effective GM % by fulfillment type',
    description: 'One line per fulfillment type: effective gross margin % per bucket.',
    series: FULFILLMENT_SERIES.map((s) => ({ ...s })),
    defaultAggregation: 'week',
    range: { lo: 0.1, hi: 0.45 },
  }),

  makeStubMetric({
    id: 'payment.order_count',
    group: 'Fulfillment & payment',
    title: 'Order count by payment method',
    description: 'Stacked area: completed-order count per bucket, split by payment method.',
    series: PAYMENT_SERIES.map((s) => ({ ...s })),
    defaultAggregation: 'week',
    range: { lo: 5, hi: 200 },
  }),

  makeStubMetric({
    id: 'payment.sales_dollars',
    group: 'Fulfillment & payment',
    title: 'Sales $ by payment method',
    description: 'Stacked area: sales $ per bucket, split by payment method.',
    series: PAYMENT_SERIES.map((s) => ({ ...s })),
    defaultAggregation: 'week',
    range: { lo: 100, hi: 5_000 },
  }),
]
