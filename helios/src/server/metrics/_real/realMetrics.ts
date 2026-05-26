import type { MetricDef } from '../types.js'
import {
  queryBasketSizeByCustomerType,
  queryBasketSizeByFulfillment,
  queryCategorySalesStackDollars,
  queryCategorySalesStackFraction,
  queryCustomerOriginMap,
  queryFirstVsReturning,
  queryFulfillmentOrderCount,
  queryFulfillmentSalesDollars,
  queryPaymentOrderCount,
  queryPaymentSalesDollars,
} from './sweedOrdersQueries.js'
import {
  WEATHER_METRIC_SUPPORTED_AGGS,
  queryWeatherMarginVsHighTemp,
  queryWeatherMarginVsLowTemp,
  queryWeatherMarginVsPrecip,
} from './weatherQueries.js'

// ============================================================================
// Real-data MetricDefs. These swap one-for-one with stubs of the same id;
// see registry.ts for the override logic. Every entry mirrors the stub's
// (id, group, title, series, defaultAggregation, supportedAggregations) so
// historical annotations + screenshots still resolve.
//
// Coverage today (automation#22 R3+): header-only metrics that can be
// served directly from `sweed_orders`. Margin / category / SKU / cashier
// metrics still need line-item data (deferred to a follow-on epic) and
// remain stubs.
// ============================================================================

const SUPPORTED = ['total', 'month', 'week', 'date', 'hour'] as const

export const REAL_METRICS: ReadonlyArray<MetricDef> = [
  {
    id: 'acquisition.first_vs_returning',
    group: 'Customer acquisition',
    title: 'New vs returning customer purchases',
    description:
      'Stacked count of completed orders per bucket, split by whether the buying customer had any prior completed order in our system. Pinned definition: "first-time on order O iff no prior completed order exists for the same Sweed customer_id". Guests (no customer_id) count as returning to keep the curve conservative.',
    series: [
      { id: 'first_time', label: 'First-time', colour: '#2ca02c' },
      { id: 'returning', label: 'Returning', colour: '#1f77b4' },
    ],
    defaultAggregation: 'week',
    supportedAggregations: [...SUPPORTED],
    query: queryFirstVsReturning,
  },
  {
    id: 'basket.size_by_fulfillment',
    group: 'Basket size',
    title: 'Avg basket $ by fulfillment type',
    description:
      'Average basket $ per completed order in the bucket, grouped by fulfillment type (delivery prepaid, delivery COD, kiosk, pickup, in-store). Unknown / NULL fulfillment values are classified as in-store.',
    series: [
      { id: 'delivery_prepaid', label: 'Delivery (prepaid)', colour: '#1f77b4' },
      { id: 'delivery_cod', label: 'Delivery (COD)', colour: '#aec7e8' },
      { id: 'kiosk', label: 'Kiosk', colour: '#2ca02c' },
      { id: 'pickup', label: 'Pickup', colour: '#ff7f0e' },
      { id: 'in_store', label: 'In-store', colour: '#9467bd' },
    ],
    defaultAggregation: 'week',
    supportedAggregations: [...SUPPORTED],
    query: queryBasketSizeByFulfillment,
  },
  {
    id: 'basket.size_by_customer_type',
    group: 'Basket size',
    title: 'Avg basket $ by new vs returning customer',
    description:
      'Average basket $ per completed order in the bucket, split by first-time vs returning customer (same first-time definition as acquisition.first_vs_returning).',
    series: [
      { id: 'first_time', label: 'First-time', colour: '#2ca02c' },
      { id: 'returning', label: 'Returning', colour: '#1f77b4' },
    ],
    defaultAggregation: 'week',
    supportedAggregations: [...SUPPORTED],
    query: queryBasketSizeByCustomerType,
  },
  {
    id: 'fulfillment.order_count',
    group: 'Fulfillment',
    title: 'Order count by fulfillment type',
    description:
      'Stacked count of completed orders per bucket, grouped by fulfillment type. Unknown / NULL fulfillment values are classified as in-store.',
    series: [
      { id: 'delivery_prepaid', label: 'Delivery (prepaid)', colour: '#1f77b4' },
      { id: 'delivery_cod', label: 'Delivery (COD)', colour: '#aec7e8' },
      { id: 'kiosk', label: 'Kiosk', colour: '#2ca02c' },
      { id: 'pickup', label: 'Pickup', colour: '#ff7f0e' },
      { id: 'in_store', label: 'In-store', colour: '#9467bd' },
    ],
    defaultAggregation: 'week',
    supportedAggregations: [...SUPPORTED],
    query: queryFulfillmentOrderCount,
  },
  {
    id: 'fulfillment.sales_dollars',
    group: 'Fulfillment',
    title: 'Sales $ by fulfillment type',
    description:
      'Stacked sum of grand-total $ per bucket, grouped by fulfillment type.',
    series: [
      { id: 'delivery_prepaid', label: 'Delivery (prepaid)', colour: '#1f77b4' },
      { id: 'delivery_cod', label: 'Delivery (COD)', colour: '#aec7e8' },
      { id: 'kiosk', label: 'Kiosk', colour: '#2ca02c' },
      { id: 'pickup', label: 'Pickup', colour: '#ff7f0e' },
      { id: 'in_store', label: 'In-store', colour: '#9467bd' },
    ],
    defaultAggregation: 'week',
    supportedAggregations: [...SUPPORTED],
    query: queryFulfillmentSalesDollars,
  },
  {
    id: 'payment.order_count',
    group: 'Payment mix',
    title: 'Order count by payment method',
    description:
      'Stacked count of completed orders per bucket, grouped by payment method (cash, debit, credit, Aeropay, other).',
    series: [
      { id: 'cash', label: 'Cash', colour: '#2ca02c' },
      { id: 'debit', label: 'Debit', colour: '#1f77b4' },
      { id: 'credit', label: 'Credit', colour: '#d62728' },
      { id: 'aeropay', label: 'Aeropay', colour: '#9467bd' },
      { id: 'other', label: 'Other', colour: '#7f7f7f' },
    ],
    defaultAggregation: 'week',
    supportedAggregations: [...SUPPORTED],
    query: queryPaymentOrderCount,
  },
  {
    id: 'payment.sales_dollars',
    group: 'Payment mix',
    title: 'Sales $ by payment method',
    description:
      'Stacked sum of grand-total $ per bucket, grouped by payment method.',
    series: [
      { id: 'cash', label: 'Cash', colour: '#2ca02c' },
      { id: 'debit', label: 'Debit', colour: '#1f77b4' },
      { id: 'credit', label: 'Credit', colour: '#d62728' },
      { id: 'aeropay', label: 'Aeropay', colour: '#9467bd' },
      { id: 'other', label: 'Other', colour: '#7f7f7f' },
    ],
    defaultAggregation: 'week',
    supportedAggregations: [...SUPPORTED],
    query: queryPaymentSalesDollars,
  },
  {
    id: 'category.sales_stack_dollars',
    group: 'Category distribution',
    title: 'Sales $ by category (stacked)',
    description:
      'Stacked sales $ per bucket, summed from per-line `subtotalAmount` and binned on the live `productCategory.name`. Categories outside the known six (Flower, Pre-Rolls, Edibles, Vapes, Concentrates, Accessories) — most often Beverages — land in "Other".',
    series: [
      { id: 'flower', label: 'Flower', colour: '#2ca02c' },
      { id: 'preroll', label: 'Pre-roll', colour: '#1f77b4' },
      { id: 'edible', label: 'Edible', colour: '#ff7f0e' },
      { id: 'vape', label: 'Vape', colour: '#9467bd' },
      { id: 'concentrate', label: 'Concentrate', colour: '#d62728' },
      { id: 'accessory', label: 'Accessory', colour: '#7f7f7f' },
      { id: 'other', label: 'Other', colour: '#bcbd22' },
    ],
    defaultAggregation: 'week',
    supportedAggregations: [...SUPPORTED],
    query: queryCategorySalesStackDollars,
  },
  {
    id: 'category.sales_stack_fraction',
    group: 'Category distribution',
    title: 'Sales mix by category (100% stacked)',
    description:
      'Stacked sales-fraction per bucket: each series is `sum(subtotalAmount) / sum(subtotalAmount across all categories)`. Sums to 1.0 in non-empty buckets, 0 in empty buckets. Same category binning as category.sales_stack_dollars.',
    series: [
      { id: 'flower', label: 'Flower', colour: '#2ca02c' },
      { id: 'preroll', label: 'Pre-roll', colour: '#1f77b4' },
      { id: 'edible', label: 'Edible', colour: '#ff7f0e' },
      { id: 'vape', label: 'Vape', colour: '#9467bd' },
      { id: 'concentrate', label: 'Concentrate', colour: '#d62728' },
      { id: 'accessory', label: 'Accessory', colour: '#7f7f7f' },
      { id: 'other', label: 'Other', colour: '#bcbd22' },
    ],
    defaultAggregation: 'week',
    supportedAggregations: [...SUPPORTED],
    query: queryCategorySalesStackFraction,
  },
  {
    id: 'weather.scatter_margin_vs_high_temp',
    group: 'Weather correlation',
    title: 'Margin $ vs daily high temperature',
    description:
      'One row per (site, day): daily high °F (Open-Meteo ERA5 reanalysis, per-site ZIP) and daily margin $ (sum of grand_total − tax − discount from sweed_orders, joined on ET date). At week / month aggregation both axes collapse to bucket averages. Sites: ZIP 10019 (Midtown) and 10458 (Bronx).',
    series: [
      { id: 'weather_value', label: 'Daily high °F', colour: '#d62728' },
      { id: 'margin_dollars', label: 'Daily margin $', colour: '#1f77b4' },
    ],
    defaultAggregation: 'date',
    supportedAggregations: [...WEATHER_METRIC_SUPPORTED_AGGS],
    query: queryWeatherMarginVsHighTemp,
  },
  {
    id: 'weather.scatter_margin_vs_low_temp',
    group: 'Weather correlation',
    title: 'Margin $ vs daily low temperature',
    description:
      'One row per (site, day): daily low °F (Open-Meteo ERA5 reanalysis, per-site ZIP) and daily margin $. Same join semantics as weather.scatter_margin_vs_high_temp.',
    series: [
      { id: 'weather_value', label: 'Daily low °F', colour: '#1f77b4' },
      { id: 'margin_dollars', label: 'Daily margin $', colour: '#2ca02c' },
    ],
    defaultAggregation: 'date',
    supportedAggregations: [...WEATHER_METRIC_SUPPORTED_AGGS],
    query: queryWeatherMarginVsLowTemp,
  },
  {
    id: 'weather.scatter_margin_vs_precip',
    group: 'Weather correlation',
    title: 'Margin $ vs daily precipitation',
    description:
      'One row per (site, day): daily precipitation (inches, Open-Meteo ERA5 reanalysis, per-site ZIP) and daily margin $. Same join semantics as weather.scatter_margin_vs_high_temp.',
    series: [
      { id: 'weather_value', label: 'Daily precipitation (in)', colour: '#9467bd' },
      { id: 'margin_dollars', label: 'Daily margin $', colour: '#ff7f0e' },
    ],
    defaultAggregation: 'date',
    supportedAggregations: [...WEATHER_METRIC_SUPPORTED_AGGS],
    query: queryWeatherMarginVsPrecip,
  },
  {
    id: 'customers.origin_map',
    group: 'Customer origin',
    title: 'Delivery origin by NYC borough',
    description:
      'Count of delivery orders per bucket, classified into NYC borough by the delivery ZIP (Manhattan 100-102, Bronx 104, Queens 110/111/113/114/116, Brooklyn 112). Staten Island and non-NYC ZIPs fall into "Other".',
    series: [
      { id: 'manhattan', label: 'Manhattan', colour: '#1f77b4' },
      { id: 'brooklyn', label: 'Brooklyn', colour: '#ff7f0e' },
      { id: 'queens', label: 'Queens', colour: '#2ca02c' },
      { id: 'bronx', label: 'Bronx', colour: '#d62728' },
      { id: 'other', label: 'Other', colour: '#7f7f7f' },
    ],
    defaultAggregation: 'week',
    supportedAggregations: [...SUPPORTED],
    query: queryCustomerOriginMap,
  },
]

export const REAL_METRIC_IDS: ReadonlySet<string> = new Set(REAL_METRICS.map((m) => m.id))
