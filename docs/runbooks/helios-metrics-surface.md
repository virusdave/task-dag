# Helios metrics surface — current inventory

> **Why this file exists.** Agents kept re-discovering "what metrics pages
> and metrics do we even have?" from scratch. This is the **map of the
> territory**: every metrics page, tab, route, registry metric, bespoke
> analytics surface, and the data grain / source table behind each. Keep
> it current when you add or remove a tab / metric.
>
> Companion docs:
> - [`helios-metrics.md`](./helios-metrics.md) — the **how-to** runbook for
>   *adding* a registry metric (MetricDef authoring, SQL idioms, grants,
>   real-vs-stub status). This file is the **what-exists** inventory.
> - [`../helios/customer-segmentation/EPIC_PLAN.md`](../helios/customer-segmentation/EPIC_PLAN.md)
>   — the segment-analytics design that builds on this surface.

Verified against code at commit `a7c38c7` (June 2026). File paths are
relative to `helios/src/`.

---

## 1. Routes

| Route | Page | Notes |
|---|---|---|
| `/metrics` | `MetricsLayoutPage` → default tab `essentials` | tabbed shell |
| `/metrics/:tabId` | `MetricsLayoutPage` | tab resolved from `:tabId` |
| `/metrics/brands` | `MetricsEntityIndexPage` (brands) | entity index |
| `/metrics/brands/:brandId` | `MetricsEntityDetailPage` (brand) | entity detail |
| `/metrics/distributors` | `MetricsEntityIndexPage` (distributors) | entity index |
| `/metrics/distributors/:distributorName` | `MetricsEntityDetailPage` (distributor) | entity detail |

Client tab files live in `client/routes/metrics/`. The tab registry that
drives the shell is `METRICS_TABS` in
`client/routes/metrics/MetricsLayoutPage.tsx`.

---

## 2. Tabs

Each tab declares an access `grant` (see `shared/domain/metricGrants.ts`:
`explore`, `reordering`, `staff`). Tabs are either **registry-driven**
(render a list of `MetricDef`s from the server metric registry) or
**bespoke** (own their full UI + a dedicated endpoint).

| Tab id | Label | Kind | Grant | What it shows |
|---|---|---|---|---|
| `essentials` | Essentials | registry | explore | gross/net sales & receipts, margin $, effective GM%, new-vs-returning mix |
| `sales` | Sales & ops | registry | explore | time-series orders, margin, basket, payment mix, category distribution, cashier throughput |
| `inventory` | Inventory | bespoke (`InventoryProcurementTab`) | reordering | reorder queue, distributor baskets, exit/liquidate, mix drift. One `/api/inventory-procurement` fetch |
| `customer-value` | Customer value | bespoke (`CustomerValueTab`) | explore | 4 LTV histograms + cohort retention curves. Basis: gross sales \| margin $ |
| `budtenders` | Budtender performance | bespoke (`BudtenderPerformanceTab`) | staff | per-cashier KPIs/leaderboard/upsell lift + Advanced scatter w/ peer percentiles + leave-one-out lift |
| `catalog` | Catalog analytics | bespoke (`CatalogAnalyticsTab`) | explore | per-variant scatter suite + cohort-median overlay |
| `target` | Target tracking | bespoke (`TargetTrackingTab`) | explore | break-even progress per period |
| `scatter` | Scatter analytics | registry (scatter chartType) | explore | weather-correlation scatter (more to follow) |

> Two tabs already implement **cohort-vs-peers comparison patterns** worth
> emulating for segment analytics:
> - **`budtenders`** → peer percentile colouring + *leave-one-out* lift
>   (cashier vs everyone-but-this-cashier).
> - **`catalog`** → per-cohort median overlay; cohort = `cohortKey()` =
>   category × subcategory × unit-size × pack
>   (`shared/domain/catalogCohort.ts`, `buildCatalogCohortKey`).

---

## 3. Registry metrics (33)

Source of truth: `server/metrics/_real/realMetrics.ts`, registered via
`server/metrics/registry.ts`. Query interface
(`server/metrics/types.ts` `MetricQueryArgs`):
`{ sites, from, to, agg, categoryIds?, subcategoryIds?, brandIds?, sizes?, selection? }`.
**There is no per-customer / per-segment predicate** in this interface
today — segment comparison requires either a membership-id join on
`sweed_orders.customer_id` or running each query twice (segment vs rest).
See the segmentation epic plan.

| Group | Metric ids |
|---|---|
| acquisition | `acquisition.first_vs_returning` |
| basket | `basket.size_by_customer_type`, `basket.size_by_fulfillment` |
| cashier | `cashier.transactions_per_hour` |
| category | `category.margin_dollars_stack`, `category.sales_stack_dollars`, `category.sales_stack_fraction` |
| customers | `customers.origin_map` |
| delivery | `delivery.order_count_by_zone` |
| essentials | `essentials.gross_receipts`, `essentials.gross_sales`, `essentials.net_receipts`, `essentials.net_sales` |
| fulfillment | `fulfillment.effective_gm_pct`, `fulfillment.margin_dollars`, `fulfillment.order_count`, `fulfillment.sales_dollars` |
| inventory | `inventory.cost_distribution`, `inventory.misalignment` |
| inventory_cost | `inventory_cost.for_sale_by_category`, `inventory_cost.for_sale_vs_not`, `inventory_cost.sales_vs_sellable_inventory` |
| lowstock | `lowstock.upcoming_outs` |
| margins | `margins.effective_gm_pct`, `margins.gross_margin_dollars`, `margins.stack_new_vs_returning`, `margins.stack_new_vs_returning_region` |
| payment | `payment.order_count`, `payment.sales_dollars` |
| slowmovers | `slowmovers.cost_at_risk` |
| weather | `weather.scatter_margin_vs_high_temp`, `weather.scatter_margin_vs_low_temp`, `weather.scatter_margin_vs_precip` |

For real-vs-stub status of each, see `helios-metrics.md` §"P2-P6 status".

---

## 4. Bespoke analytics endpoints

| Tab | Client | Server route | Query module |
|---|---|---|---|
| customer-value | `CustomerValueTab.tsx` | `server/routes/customerValueAnalytics.ts` | `server/customerValueAnalytics/customerValueAnalyticsQueries.ts` |
| budtenders | `BudtenderPerformanceTab.tsx` | `server/routes/budtenderAnalytics.ts` | `server/budtenderAnalytics/budtenderAnalyticsQueries.ts` |
| inventory | `InventoryProcurementTab.tsx` | `/api/inventory-procurement` | (procurement queries) |
| catalog | `CatalogAnalyticsTab.tsx` | catalog analytics route | per-variant scatter queries |
| (geography) | `customers.origin_map` metric | `server/routes/customersMap.ts` | `server/db/queries/customersMapQueries.ts` |

---

## 5. Data grain & customer / geography model

- **No customer master table.** Customer identity = `sweed_orders.customer_id`
  (`bigint`, nullable; `is_guest` flag, `first_time_for_customer`). Order
  header columns: `dealer_id`, `invoice_id`, `pay_time`, `grand_total_dollars`,
  `subtotal/tax/discount_dollars`, `fulfillment_type`, `payment_method`,
  `delivery_zip`, `raw_json`. Line items: `sweed_order_items_flat`,
  `sweed_purchases`. Schema: `server/db/schema/sweedOrders.sql` (migration 031).
- **Sites / dealers:** Bronx `210249`, Midtown `210705`; state/all-stores
  scope dealer `210248`. Client site keys: `bronx`, `midtown`.
- **Customer geography** comes from **VeriScan ID scans**, not order
  addresses: `visitor_scans` (`state`, `postal_code`, document `address_id`)
  linked to customers via `visitor_scan_links` (`dealer_id`,
  `sweed_customer_id`). `customers.origin_map` /
  `customersMapQueries.ts` reads visitor-scan document addresses. `orders`
  also carry `delivery_zip` (delivery only). Home state/zip is therefore
  best-effort, present only for ID-scanned & linked customers.
- **Per-customer margin is NOT available today.** `sweed_order_margin_mv`
  was planned (v1.4 V4'2) but never landed — it needs the
  `sweed_order_line_items` + `product_cost_history` ingest, which is not
  live on the prod warehouse. Customer-value margin cards are gated off
  until that ingest lands. Order-grain margin metrics
  (`margins.*`, `fulfillment.margin_dollars`) compute from
  `sweed_order_items_flat` + package-snapshot COGS instead.

---

## 6. Customer SEGMENTS (already cached from Sweed)

Migration `059_sweed_customer_segments.sql` already caches Sweed's own
marketing segments (virusdave/top-level#12 / FreshlyBakedNYC/automation#40):

| Table | Grain | Purpose |
|---|---|---|
| `sweed_customer_segments` | (customer, scope_dealer, segment) | per-customer membership; columns: `segment_id/name`, `segment_type_id/name`, `scope_dealer_id`, `enabled`, `date_on_enter` |
| `sweed_customer_segments_refresh` | per customer | refresh highwater (pending/ok/failed, `segment_count`) |
| `sweed_marketing_segments` | per segment | segment catalog: `total_customers`, `scope_dealer_id`, `target_store_names[]` |
| `sweed_marketing_segments_refresh` | singleton | catalog refresh highwater |

- **Scope axis** = `scope_dealer_id`: `210248` state/all-stores,
  `210705` Midtown, `210249` Bronx → maps onto the operator's
  US/state/site segment scopes.
- **Membership is cached, not complete.** Per-customer membership is
  pulled from the expensive Sweed RPC `store.customer.segment.list`
  (pooled token) only on link / manual refresh — never on page load.
  So the cache covers refreshed customers only; coverage must be surfaced
  before trusting segment-vs-population comparisons.
- Segment RPC reference: [`../sweed/marketing.md`](../sweed/marketing.md).

See the [segmentation epic plan](../helios/customer-segmentation/EPIC_PLAN.md)
for how this surface gets a "segment lens".
