import type { MetricCatalogFilterDimension } from '../../../shared/contracts/index.js'
import type { MetricDef } from '../types.js'
import {
  queryBasketSizeByCustomerType,
  queryBasketSizeByFulfillment,
  queryCategorySalesStackDollars,
  queryCategorySalesStackFraction,
  queryCustomerOriginMap,
  queryDeliveryOrderCountByZone,
  queryFirstVsReturning,
  queryFulfillmentOrderCount,
  queryFulfillmentSalesDollars,
  queryGrossReceiptsDollars,
  queryGrossSalesDollars,
  queryNetSalesDollars,
  queryPaymentOrderCount,
  queryPaymentSalesDollars,
} from './sweedOrdersQueries.js'
import {
  queryCategoryMarginStack,
  queryEffectiveGmPct,
  queryFulfillmentEffectiveGmPct,
  queryFulfillmentMarginDollars,
  queryGrossMarginDollars,
  queryInventoryCostDistribution,
  queryInventoryMisalignment,
  queryLowstockUpcomingOuts,
  queryMarginStackNewVsReturning,
  querySlowmoversCostAtRisk,
} from './sweedPackageSnapshotsQueries.js'
import {
  WEATHER_METRIC_SUPPORTED_AGGS,
  queryWeatherMarginVsHighTemp,
  queryWeatherMarginVsLowTemp,
  queryWeatherMarginVsPrecip,
} from './weatherQueries.js'
import { queryCashierTransactionsPerHour } from './cashierThroughputQueries.js'

// Every metric whose SQL has been wired through orderItemsCatalogFilterSql
// can honour all four catalog-scope filter dimensions.
const ALL_CATALOG_FILTERS: readonly MetricCatalogFilterDimension[] = [
  'category',
  'subcategory',
  'brand',
  'size',
]

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
    id: 'essentials.gross_sales',
    group: 'Essentials',
    title: 'Gross sales $ (ex-tax)',
    description:
      'Sum of pre-discount, pre-tax line totals per bucket. Computed as Sweed `subtotalAmount` + `grandTotalDiscountAmount` — i.e. what would have been billed before promos/discounts were applied, with sales tax excluded. Use this when you want to see how much business the store actually drove, regardless of how aggressive the discounting was.',
    series: [{ id: 'gross_sales', label: 'Gross sales $ (ex-tax)', colour: '#2ca02c' }],
    defaultAggregation: 'week',
    supportedAggregations: [...SUPPORTED],
    query: queryGrossSalesDollars,
  },
  {
    id: 'essentials.gross_receipts',
    group: 'Essentials',
    title: 'Gross receipts $ (incl. tax)',
    description:
      'Sum of `grand_total_dollars` per bucket — every dollar that came in, including tax collected and net of promos/discounts. This is the "money in the drawer" number; reconciliation friendly.',
    series: [{ id: 'gross_receipts', label: 'Gross receipts $ (incl. tax)', colour: '#1f77b4' }],
    defaultAggregation: 'week',
    supportedAggregations: [...SUPPORTED],
    query: queryGrossReceiptsDollars,
  },
  {
    id: 'essentials.net_sales',
    group: 'Essentials',
    title: 'Net sales $ (ex-tax, net of discounts)',
    description:
      'Sum of `subtotal_dollars` per bucket — the pre-tax line total after promos/discounts have already been applied. This is the "revenue you actually booked" number; the difference between Gross Sales and Net Sales is what discounting cost you.',
    series: [{ id: 'net_sales', label: 'Net sales $ (ex-tax, net of discounts)', colour: '#9467bd' }],
    defaultAggregation: 'week',
    supportedAggregations: [...SUPPORTED],
    query: queryNetSalesDollars,
  },
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
      'Average basket $ per completed order in the bucket, grouped by fulfillment type. Delivery orders are further split prepaid-vs-COD by payment method (aeropay = prepaid; cash / debit / credit = COD); pickup orders are split into "pickup (prepaid)" for aeropay and plain "pickup" for everything else. Kiosk and walk-in / pharmacy / pos / unknown fulfillment land in kiosk and in-store respectively.',
    series: [
      { id: 'delivery_prepaid', label: 'Delivery (prepaid)', colour: '#1f77b4' },
      { id: 'delivery_cod', label: 'Delivery (COD)', colour: '#aec7e8' },
      { id: 'kiosk', label: 'Kiosk', colour: '#2ca02c' },
      { id: 'pickup_prepaid', label: 'Pickup (prepaid)', colour: '#e377c2' },
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
      'Stacked count of completed orders per bucket, grouped by fulfillment type. Delivery and pickup are further split prepaid-vs-COD by payment method (aeropay = prepaid; everything else = COD / non-prepaid pickup); see basket.size_by_fulfillment for the full rule. Unknown / NULL fulfillment classifies as in-store.',
    series: [
      { id: 'delivery_prepaid', label: 'Delivery (prepaid)', colour: '#1f77b4' },
      { id: 'delivery_cod', label: 'Delivery (COD)', colour: '#aec7e8' },
      { id: 'kiosk', label: 'Kiosk', colour: '#2ca02c' },
      { id: 'pickup_prepaid', label: 'Pickup (prepaid)', colour: '#e377c2' },
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
      'Stacked sum of grand-total $ per bucket, grouped by fulfillment type. Delivery and pickup are further split prepaid-vs-COD by payment method (aeropay = prepaid; everything else = COD / non-prepaid pickup); see basket.size_by_fulfillment for the full rule.',
    series: [
      { id: 'delivery_prepaid', label: 'Delivery (prepaid)', colour: '#1f77b4' },
      { id: 'delivery_cod', label: 'Delivery (COD)', colour: '#aec7e8' },
      { id: 'kiosk', label: 'Kiosk', colour: '#2ca02c' },
      { id: 'pickup_prepaid', label: 'Pickup (prepaid)', colour: '#e377c2' },
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
    supportedCatalogFilters: ALL_CATALOG_FILTERS,
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
    supportedCatalogFilters: ALL_CATALOG_FILTERS,
  },
  // ---- Margin / COGS (P2 + P3) — backed by sweed_package_snapshots ----
  {
    id: 'margins.gross_margin_dollars',
    group: 'Margins',
    title: 'Gross margin $',
    description:
      'Sum(revenue - wholesale cost) across all line items in completed orders per bucket. Per-line cost from `sweed_package_snapshots` via `sweed_package_cost_as_of_or_earliest()` — falls back to the earliest known snapshot when no snapshot exists at or before the order date (the snapshot worker began running 2026-05-26 so pre-cutover orders use the first observed cost as the best-available approximation).',
    series: [{ id: 'gm_dollars', label: 'Gross margin $', colour: '#d62728' }],
    defaultAggregation: 'week',
    supportedAggregations: [...SUPPORTED],
    query: queryGrossMarginDollars,
    supportedCatalogFilters: ALL_CATALOG_FILTERS,
  },
  {
    id: 'margins.effective_gm_pct',
    group: 'Margins',
    title: 'Effective gross margin %',
    description:
      'sum(revenue - cogs) / sum(revenue) per bucket, restricted to line items with a known wholesale cost (excluded from BOTH numerator and denominator). With the earliest-snapshot fallback in effect, every package observed by Sweed contributes; only line items whose package was never seen by the snapshot worker are dropped.',
    series: [{ id: 'gm_pct', label: 'Effective GM %', colour: '#9467bd' }],
    defaultAggregation: 'week',
    supportedAggregations: [...SUPPORTED],
    query: queryEffectiveGmPct,
    supportedCatalogFilters: ALL_CATALOG_FILTERS,
  },
  {
    id: 'margins.stack_new_vs_returning',
    group: 'Margins',
    title: 'Gross margin $ — new vs returning customer',
    description:
      'Gross margin $ per bucket, stacked by first-time vs returning customer (same pin as acquisition.first_vs_returning). Guests counted as returning to keep the curve conservative.',
    series: [
      { id: 'first_time', label: 'First-time customer', colour: '#2ca02c' },
      { id: 'returning', label: 'Returning customer', colour: '#1f77b4' },
    ],
    defaultAggregation: 'week',
    supportedAggregations: [...SUPPORTED],
    query: queryMarginStackNewVsReturning,
    supportedCatalogFilters: ALL_CATALOG_FILTERS,
  },
  {
    id: 'category.margin_dollars_stack',
    group: 'Category distribution',
    title: 'Margin $ by category (stacked)',
    description:
      'Gross margin $ per bucket, stacked by the live `productCategory.name` on each line item. Categories outside the known six (Flower, Pre-Rolls, Edibles, Vapes, Concentrates, Accessories) — most often Beverages — land in "Other".',
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
    query: queryCategoryMarginStack,
    supportedCatalogFilters: ALL_CATALOG_FILTERS,
  },
  {
    id: 'fulfillment.margin_dollars',
    group: 'Fulfillment',
    title: 'Margin $ by fulfillment type',
    description:
      'Stacked sum of (revenue - wholesale cost) per bucket, grouped by fulfillment type. Delivery and pickup are further split prepaid-vs-COD by payment method (aeropay = prepaid; everything else = COD / non-prepaid pickup); see basket.size_by_fulfillment for the full rule. Cost lookups use the same `sweed_package_cost_as_of_or_earliest()` path as margins.gross_margin_dollars.',
    series: [
      { id: 'delivery_prepaid', label: 'Delivery (prepaid)', colour: '#1f77b4' },
      { id: 'delivery_cod', label: 'Delivery (COD)', colour: '#aec7e8' },
      { id: 'kiosk', label: 'Kiosk', colour: '#2ca02c' },
      { id: 'pickup_prepaid', label: 'Pickup (prepaid)', colour: '#e377c2' },
      { id: 'pickup', label: 'Pickup', colour: '#ff7f0e' },
      { id: 'in_store', label: 'In-store', colour: '#9467bd' },
    ],
    defaultAggregation: 'week',
    supportedAggregations: [...SUPPORTED],
    query: queryFulfillmentMarginDollars,
    supportedCatalogFilters: ALL_CATALOG_FILTERS,
  },
  {
    id: 'fulfillment.effective_gm_pct',
    group: 'Fulfillment',
    title: 'Effective GM % by fulfillment type',
    description:
      'One line per fulfillment type: sum(revenue - cogs) / sum(revenue) per bucket, restricted to line items with a known wholesale cost (excluded from BOTH numerator and denominator).',
    series: [
      { id: 'delivery_prepaid', label: 'Delivery (prepaid)', colour: '#1f77b4' },
      { id: 'delivery_cod', label: 'Delivery (COD)', colour: '#aec7e8' },
      { id: 'kiosk', label: 'Kiosk', colour: '#2ca02c' },
      { id: 'pickup_prepaid', label: 'Pickup (prepaid)', colour: '#e377c2' },
      { id: 'pickup', label: 'Pickup', colour: '#ff7f0e' },
      { id: 'in_store', label: 'In-store', colour: '#9467bd' },
    ],
    defaultAggregation: 'week',
    supportedAggregations: [...SUPPORTED],
    query: queryFulfillmentEffectiveGmPct,
    supportedCatalogFilters: ALL_CATALOG_FILTERS,
  },
  // ---- Inventory (P4) — backed by sweed_package_snapshots ----
  {
    id: 'inventory.cost_distribution',
    group: 'Inventory',
    title: 'On-hand inventory cost $ by category',
    description:
      'On-hand inventory cost (sum of `current_qty * wholesale_cost_dollars` over the latest snapshot per package as-of each bucket end), stacked by top-level category. Categories derived from the most-recent observation of each package on a sweed_orders line item — packages never observed in any order are dropped (they cannot be classified).',
    series: [
      { id: 'flower', label: 'Flower', colour: '#2ca02c' },
      { id: 'preroll', label: 'Pre-roll', colour: '#1f77b4' },
      { id: 'edible', label: 'Edible', colour: '#ff7f0e' },
      { id: 'vape', label: 'Vape', colour: '#9467bd' },
      { id: 'concentrate', label: 'Concentrate', colour: '#d62728' },
      { id: 'accessory', label: 'Accessory', colour: '#7f7f7f' },
    ],
    defaultAggregation: 'date',
    supportedAggregations: [...SUPPORTED],
    query: queryInventoryCostDistribution,
    supportedCatalogFilters: ALL_CATALOG_FILTERS,
  },
  {
    id: 'inventory.misalignment',
    group: 'Inventory',
    title: 'Inventory misalignment (SKU over/under-stock)',
    description:
      'Average across all packages (with positive on-hand and trailing-30d sell-through) of `(on_hand_cost / daily_cogs_run_rate) - 21`, where 21 days is the operator target supply. Positive = the average SKU is over-stocked relative to recent demand, negative = under-stocked. Per-SKU detail forthcoming via the table-mode renderer.',
    series: [{ id: 'deviation', label: '(on-hand / daily run-rate) − 21d target', colour: '#9467bd' }],
    defaultAggregation: 'date',
    supportedAggregations: [...SUPPORTED],
    query: queryInventoryMisalignment,
  },
  {
    id: 'slowmovers.cost_at_risk',
    group: 'Slow movers',
    title: 'Cost at risk (slow-moving SKUs)',
    description:
      'Aggregate on-hand wholesale cost $ for packages flagged as slow-moving (zero trailing-30d sales) OR within 30 days of expiration, observed at each bucket end. Per-SKU breakdown forthcoming via the table-mode renderer.',
    series: [{ id: 'cost_at_risk_dollars', label: 'Total cost at risk $', colour: '#d62728' }],
    defaultAggregation: 'date',
    supportedAggregations: [...SUPPORTED],
    query: querySlowmoversCostAtRisk,
  },
  {
    id: 'lowstock.upcoming_outs',
    group: 'Running low',
    title: 'Upcoming stock-outs (next 2-3 days)',
    description:
      'Expected margin loss $ per bucket from packages projected to run out in the next 2 days (or already out with positive trailing-21d sales). Per-package contribution = max(0, (2 - days_of_supply)) * trailing-21d daily margin. Per-SKU breakdown forthcoming via the table-mode renderer.',
    series: [{ id: 'expected_margin_loss_dollars', label: 'Expected margin loss $', colour: '#d62728' }],
    defaultAggregation: 'date',
    supportedAggregations: [...SUPPORTED],
    query: queryLowstockUpcomingOuts,
  },
  {
    id: 'weather.scatter_margin_vs_high_temp',
    group: 'Weather correlation',
    title: 'Margin $ vs daily high temperature',
    description:
      'Scatter: X = daily high °F (Open-Meteo ERA5 reanalysis, per-site ZIP); Y = daily margin $ (sum of grand_total − tax − discount from sweed_orders, joined on ET date). One dot per (site, day) at `date` aggregation; one dot per (site, week/month bucket) at coarser aggs (bucket-averaged on both axes). Sites: ZIP 10019 (Midtown) and 10458 (Bronx).',
    series: [
      { id: 'weather_value', label: 'Daily high °F', colour: '#d62728' },
      { id: 'margin_dollars', label: 'Daily margin $', colour: '#1f77b4' },
    ],
    defaultAggregation: 'date',
    supportedAggregations: [...WEATHER_METRIC_SUPPORTED_AGGS],
    chartType: 'scatter',
    query: queryWeatherMarginVsHighTemp,
  },
  {
    id: 'weather.scatter_margin_vs_low_temp',
    group: 'Weather correlation',
    title: 'Margin $ vs daily low temperature',
    description:
      'Scatter: X = daily low °F (Open-Meteo ERA5 reanalysis, per-site ZIP); Y = daily margin $. Same join semantics as weather.scatter_margin_vs_high_temp.',
    series: [
      { id: 'weather_value', label: 'Daily low °F', colour: '#1f77b4' },
      { id: 'margin_dollars', label: 'Daily margin $', colour: '#2ca02c' },
    ],
    defaultAggregation: 'date',
    supportedAggregations: [...WEATHER_METRIC_SUPPORTED_AGGS],
    chartType: 'scatter',
    query: queryWeatherMarginVsLowTemp,
  },
  {
    id: 'weather.scatter_margin_vs_precip',
    group: 'Weather correlation',
    title: 'Margin $ vs daily precipitation',
    description:
      'Scatter: X = daily precipitation in inches (Open-Meteo ERA5 reanalysis, per-site ZIP); Y = daily margin $. Same join semantics as weather.scatter_margin_vs_high_temp.',
    series: [
      { id: 'weather_value', label: 'Daily precipitation (in)', colour: '#9467bd' },
      { id: 'margin_dollars', label: 'Daily margin $', colour: '#ff7f0e' },
    ],
    defaultAggregation: 'date',
    supportedAggregations: [...WEATHER_METRIC_SUPPORTED_AGGS],
    chartType: 'scatter',
    query: queryWeatherMarginVsPrecip,
  },
  {
    id: 'cashier.transactions_per_hour',
    group: 'Cashier throughput',
    title: 'Transactions per cashier-hour',
    description:
      'Transactions per on-the-clock cashier-hour. Numerator: count of completed sweed_orders in the bucket. Denominator: sum over CLOSED drawer-shifts (sweed_drawer_shifts) of (drawer duration ∩ bucket) × count(sessions[].user.id) — i.e. every cashier listed in a drawer-shift\'s sessions[] is treated as on-the-clock for the entire drawer window, then apportioned across buckets the drawer overlaps. Open drawer-shifts are excluded until they close (final duration unknown). Operator-confirmed approximation (FreshlyBakedNYC/automation#27, 2026-05-26); a future v2 can use sweed_orders.cashier_user_id for exact per-transaction attribution.',
    series: [{ id: 'tx_per_hour', label: 'Transactions per cashier-hour', colour: '#1f77b4' }],
    defaultAggregation: 'date',
    supportedAggregations: [...SUPPORTED],
    query: queryCashierTransactionsPerHour,
  },
  {
    id: 'customers.origin_map',
    group: 'Customer origin',
    title: 'Customer origin by NYC borough',
    description:
      'Count of orders per bucket, classified by where the customer lives. Resolves each order through the addresses table (FreshlyBakedNYC/automation#25): prefers the customer\'s primary address from sweed_customer_addresses (kind=\'primary\'), falls back to the order\'s delivery address. Buckets by US Census county: Manhattan = New York Co., Brooklyn = Kings Co., Queens = Queens Co., Bronx = Bronx Co., Staten Island = Richmond Co.; any NJ county → "NJ"; everything else → "Other".',
    series: [
      { id: 'manhattan', label: 'Manhattan', colour: '#1f77b4' },
      { id: 'brooklyn', label: 'Brooklyn', colour: '#ff7f0e' },
      { id: 'queens', label: 'Queens', colour: '#2ca02c' },
      { id: 'bronx', label: 'Bronx', colour: '#d62728' },
      { id: 'staten_island', label: 'Staten Island', colour: '#9467bd' },
      { id: 'nj', label: 'NJ', colour: '#8c564b' },
      { id: 'other', label: 'Other', colour: '#7f7f7f' },
    ],
    defaultAggregation: 'week',
    supportedAggregations: [...SUPPORTED],
    query: queryCustomerOriginMap,
  },
  {
    id: 'delivery.order_count_by_zone',
    group: 'Delivery',
    title: 'Delivery order count by zone',
    description:
      'Count of delivery-typed orders per bucket, classified by the delivery destination address (via sweed_orders.delivery_address_id → addresses, see FreshlyBakedNYC/automation#25 A4). Buckets by US Census county: Manhattan = New York Co., Brooklyn = Kings Co., Queens = Queens Co., Bronx = Bronx Co., Staten Island = Richmond Co.; any NJ county → "NJ"; everything else → "Other".',
    series: [
      { id: 'manhattan', label: 'Manhattan', colour: '#1f77b4' },
      { id: 'brooklyn', label: 'Brooklyn', colour: '#ff7f0e' },
      { id: 'queens', label: 'Queens', colour: '#2ca02c' },
      { id: 'bronx', label: 'Bronx', colour: '#d62728' },
      { id: 'staten_island', label: 'Staten Island', colour: '#9467bd' },
      { id: 'nj', label: 'NJ', colour: '#8c564b' },
      { id: 'other', label: 'Other', colour: '#7f7f7f' },
    ],
    defaultAggregation: 'week',
    supportedAggregations: [...SUPPORTED],
    query: queryDeliveryOrderCountByZone,
  },
]

export const REAL_METRIC_IDS: ReadonlySet<string> = new Set(REAL_METRICS.map((m) => m.id))
