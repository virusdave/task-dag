# Customer Segmentation Analytics — design / epic plan

> Goal: let the operator slice customers into **segments** and understand
> how a segment behaves vs (a) the **whole** population and (b) the
> **rest** (population minus the segment). Segment scopes: **US / state /
> site**. The operator is *not* a CRM expert — the product must *guide*
> them to the questions worth asking, load fast, stay DB-cheap, and be
> mobile-first.
>
> Status: **design** (oracle-reviewed). No code landed yet.
> Companion: [`../../runbooks/helios-metrics-surface.md`](../../runbooks/helios-metrics-surface.md)
> (current metrics inventory) and
> [`../../sweed/marketing.md`](../../sweed/marketing.md) (segment RPCs).
> Related: virusdave/top-level#12 / FreshlyBakedNYC/automation#40
> (segment-cache infra already landed in migration 059).

---

## 1. What we already have (don't rebuild)

- **Segment cache** (migration `059_sweed_customer_segments.sql`):
  `sweed_customer_segments` (per-customer membership),
  `sweed_marketing_segments` (catalog w/ `total_customers`,
  `target_store_names[]`), plus refresh-highwater tables. Scope axis is
  `scope_dealer_id` (`210248` state / `210705` Midtown / `210249` Bronx)
  — exactly the US/state/site axis we want.
- **Two cohort-vs-peers UI patterns** to emulate: `budtenders`
  (leave-one-out lift + peer percentiles) and `catalog` (per-cohort
  median overlay).
- **Customer-grain bespoke surface**: the `customer-value` tab already
  works at customer/cohort grain — the natural first home for a segment
  lens.

## 2. Hard facts that constrain the design (verified in code)

1. **Segment membership coverage — solved by BULK `store.marketing.segment.get`.**
   Membership was originally cached per-customer via
   `store.customer.segment.list { id }` (one RPC per customer → only
   covers customers we happened to link). The efficient inverse exists:
   `store.marketing.segment.get { id: <segmentId> }` returns the FULL
   member list of a segment in ONE call. So whole-cache population is
   O(#segments) RPCs, not O(#customers). Implemented as
   `getSweedMarketingSegmentMembers` + `snapshotSegmentMembers` (bulk,
   authoritative per-segment replace) + `refreshSegmentMembershipBulk` +
   `scripts/refresh-segment-members-bulk.ts` (dry-run by default).
   STATUS: the response shape is not yet operator-verified (the seed
   segment was empty), so the parser is **fail-closed** and the bulk job
   is **manual/script-triggered, not auto-scheduled**, until
   `scripts/probe-sweed-segment-members.ts <id>` confirms the shape.
   Write-model rule: bulk-by-segment is the authoritative deleter; the
   per-customer details-page refresh is a positive overlay (must become
   delete-free once bulk is the primary populate path).
2. **Per-customer margin IS available** (earlier "blocked" note was
   stale — there is no `sweed_order_margin_mv` / `sweed_order_line_items`
   / `product_cost_history` dependency). Per-line wholesale cost comes
   from `sweed_package_snapshots` via
   `sweed_package_cost_as_of_or_earliest(dealer, inventory_item_id,
   pay_time)`, the same proven path the `margins.gross_margin_dollars`
   registry metric uses. Per-customer margin = sum over a customer's
   `sweed_order_items_flat` line items of (line revenue − qty × cost),
   joined on `sweed_orders.customer_id`. Convention: unknown cost = $0,
   canceled LINE items excluded. This now ships as a **margin money
   basis** on the Customer Value tab; segment value metrics can include
   margin from day one.
3. **Customer geography is best-effort** (VeriScan ID scans →
   `visitor_scan_links`), present only for scanned & linked customers.
4. **Guests can't be segment members** (`is_guest`, null `customer_id`).
   Behavioural comparisons must use **known customers only** as the
   denominator; guests count only toward contribution-share.
5. **The registry metric interface has no segment predicate.** Don't
   retrofit all 33 metrics. Build a dedicated segment endpoint + curated
   comparison cards.

### Verify before implementation (oracle flags)

- Is `sweed_orders.customer_id` globally unique or dealer-scoped? Joins
  to membership must carry scope if dealer-scoped.
- Are Sweed `segment_id`s globally unique across dealer contexts? If not,
  treat `(scope_dealer_id, segment_id)` as the key.
- Confirm whether any true **US-level** segments exist vs only
  state/site; add explicit `scope_level`/`scope_key` rather than
  inferring "non-site ⇒ state".

## 3. Comparison semantics

Always offer three populations, **known customers only** for behaviour:

```diagram
╭────────────────────────────────────────────────────────────╮
│  whole = segment ∪ rest        (context / contribution)     │
│  ┌──────────────┐  ┌────────────────────────────────────┐  │
│  │   segment    │  │   rest = whole − segment            │  │
│  │  (members)   │  │   (known non-members)               │  │
│  └──────────────┘  └────────────────────────────────────┘  │
╰────────────────────────────────────────────────────────────╯
```

- **Default headline delta = segment vs REST.** "Segment vs whole"
  understates differences when the segment is large (partial
  self-comparison). Show whole as context only.
- **Additive metrics** (sales, orders): `rest = whole − segment`.
- **Ratios** (basket, GM%, orders/customer, discount rate): recompute
  from summed numerator/denominator — never average or subtract
  pre-computed rates.
- **Scope matters (Simpson's paradox):** compare *within the selected
  site scope* by default; for state-level segments offer all-store /
  Bronx-only / Midtown-only.

## 4. Data model — daily facts + cached rollups (DB-cheap)

Principle: **never** join raw `sweed_orders` + items + membership on a
page load. Two layers:

**(a) Daily customer facts** (known customers only) — incremental,
refresh today/yesterday on ingest, enqueue ranges on backfill:

- `analytics_customer_day_facts` — PK `(business_date, dealer_id,
  customer_id)`: orders, first/returning orders, gross/net sales &
  receipts, discount, margin (per-line COGS via
  `sweed_package_cost_as_of_or_earliest`), fulfillment-type order
  counts, payment-type order counts, first/last order at.
- `analytics_site_day_facts` — PK `(business_date, dealer_id)`: world
  totals incl. guests, active known customers, guest-order share.
- `analytics_customer_category_day_facts` — adds `category_key` (P0 for
  affinity). Brand facts (`…_brand_day_facts`) in P1.

**(b) Segment window rollup cache** —
`analytics_segment_window_rollups` PK `(scope_key, segment_id, site_key,
window_key, from_date, to_date)`, storing a `payload jsonb`
(segment / worldKnown / worldAll / restKnown bundles + category /
fulfillment / payment / geo mixes + time series + `dataQuality`), plus
`cached_member_count`, `active_member_count`, `segment_membership_refreshed_at`,
`facts_refreshed_at`. Async-computed, read on page load = single indexed
lookup. Windows: 30/90/180/365d (default 90d).

**Indexes to add now** on the existing segment tables:
`(scope_dealer_id, segment_id, sweed_customer_id) WHERE enabled` and the
reverse `(sweed_customer_id, scope_dealer_id, segment_id)`.

Segment-vs-rest query shape (facts, not raw orders):

```sql
with members as (
  select distinct sweed_customer_id as customer_id
  from sweed_customer_segments
  where segment_id = $1 and scope_dealer_id = $2
    and coalesce(enabled, true)
)
select case when m.customer_id is not null then 'segment' else 'rest' end as pop,
       count(distinct f.customer_id) active, sum(f.orders) orders,
       sum(f.net_sales_dollars) net_sales, sum(f.discount_dollars) discount
from analytics_customer_day_facts f
left join members m on m.customer_id = f.customer_id
where f.business_date >= $3 and f.business_date < $4
  and f.dealer_id = any($5)
group by 1;
```

## 5. Surfaces — what to build, prioritized

### P0 — new pages
- **`/metrics/segments` — Segment index.** One card/row per segment:
  scope (US/state/site), type (static/dynamic), enabled, Sweed total vs
  cached members, active customers in window, **sales share, margin share,
  avg basket vs rest, orders/customer vs rest, top over-index category,
  data-coverage badge.** Default sort = **largest margin/opportunity**,
  not alphabetical.
- **`/metrics/segments/:scope/:segmentId` — Segment detail.** Scorecard
  (members, active, orders, net sales, avg basket, orders/customer,
  discount rate, returning mix, contribution share) + sections:
  Value · Retention · What they buy · How they shop · Where they come
  from · Data quality — each with a **"what to do next" action card**.

### P0 — light lens on existing tabs
- **`customer-value` tab**: add a segment selector → LTV histograms /
  spend percentiles / first→second conversion / retention for *segment
  vs rest*. Best fit (already customer-grain). Extend its bespoke
  endpoint, not the registry.
- **`essentials` / `sales` tabs**: a "Segment lens" drawer (not
  per-card retrofit) showing curated comparison cards.

### P1
- Segment **compare matrix** (segments × KPIs) — great for non-expert
  prioritization.
- Segment **affinity** (category/brand over-index vs rest), ranked by
  **materiality = segment_sales_in_group × |segment_mix − rest_mix|**, not
  raw lift. Brand affinity on `/metrics/brands` detail pages.

### P2
- Campaign / action measurement (pre/post, contacted-vs-not), only once
  Sweed send/redemption data exists, with hard "not causal" guardrails.

### Do NOT add a segment lens to (v1)
inventory, target, weather, budtenders, catalog scatter — not
customer-segment metrics; would mislead.

## 6. Mobile-first comparison UI

- **Sticky context bar**: segment · site scope · window · compare basis
  (rest/whole) · confidence badge.
- **Single-column scorecards**: big segment value, small "vs rest",
  delta/index badge, sample size. Example: `Avg basket $74.20 · vs rest
  $61.10 · +21% · 342 orders`.
- **100%-width horizontal bars** for mix metrics (segment vs rest);
  avoid dense tables on phones.
- **Index chips** for affinity (`1.4× vs rest`, `−8pp`, `$12.4k`).
- **Accordion sections**, each closed by an **action card** translating
  numbers into the next decision.
- Desktop = same components, 2–3 columns + the compare matrix.

## 7. Statistical guardrails (operator is non-expert)

- **Small samples**: `<10` active → suppress lift ("too small");
  `<30` active or `<100` orders → "directional only"; `<5` orders in a
  category/brand cell → hide/bucket.
- **Base-rate**: always show segment %, rest %, *and* absolute
  counts/sales + materiality rank; never sort by lift alone.
- **Segment-vs-whole self-comparison**: default delta = vs rest.
- **Guests**: known-customer denominator; show guest share separately.
- **Dynamic segments are current snapshots**: label "historical
  behaviour of customers *currently* in this segment"; only use
  `date_on_enter` for since-joining analysis after validating it.
- **Overlapping segments**: never sum segment rows as mutually
  exclusive; tooltip the overlap.
- **Seasonality / partial periods**: same window for all populations;
  mark in-progress periods; default 90d.
- **Causality**: say "over-indexes / associated with", never "caused /
  lifted" without a holdout.

## 8. Suggested sequencing

1. Verify the three open model questions (§2) + add segment-table
   indexes + (if needed) explicit `scope_level/scope_key`.
2. Background job: refresh membership for all active known customers;
   surface coverage.
3. Build `analytics_customer_day_facts` + `analytics_site_day_facts`
   (incremental) and the category facts.
4. Build `analytics_segment_window_rollups` async cache + read endpoint.
5. Ship `/metrics/segments` index + detail (P0), then the
   customer-value / essentials lenses.
6. P1 affinity + compare matrix; P2 campaign measurement.

## 9. When to graduate to the "advanced path"

Only if: segment-detail p95 > ~1s cached / ~3s cold, >~100 active
segments need ranking, arbitrary custom ranges become common, brand/
product affinity becomes a daily workflow, membership coverage gets high
enough for historical segment-state analysis, or campaign attribution
becomes real. Then: precompute `analytics_segment_day_facts` per
segment/site/day, customer-level historical segment snapshots, holdout/
control campaign measurement, and significance testing. **Not now** —
daily customer facts + cached window rollups is the right first
architecture for a two-store, DB-cheap deployment.
