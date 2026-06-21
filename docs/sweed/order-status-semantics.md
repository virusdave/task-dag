# Sweed order status semantics: cancelled, voided, returned

How Sweed order/line status works in our mirror, and the rule every agent
must follow when reading `sweed_orders` for any total, count, or average.

> TL;DR: **A cancelled order is not a transaction. Exclude cancelled
> orders/lines from every sum, count, average, ordinal, and split UNLESS the
> metric is *explicitly* about cancellations.** Do not hand-write the
> predicate — import the canonical helper from
> `helios/src/server/db/sweedOrderStatus.ts`.

## Why this doc exists

Sweed's order-list feed reports a **non-zero header `grand_total` /
`subtotal` on cancelled orders** (the customer cancelled, but the dollar
figures are still populated). Cancellations are a large fraction of orders
(~18% observed). So any query that does `sum(grand_total_dollars)` /
`count(*)` over `sweed_orders` without excluding cancelled rows silently and
materially inflates the result.

This was not a one-off. The exclusion predicate had been hand-copied into
~4 modules with "keep in sync" comments; they drifted, and multiple
customer-facing surfaces (the check-ins list, customer-details "Lifetime
spend / N invoices", the customers map) shipped the same omission — e.g. a
customer with one $207.31 order plus one cancelled order showed "2 invoices
/ $283.02". The dollar total being wrong is worse than the count being
wrong, because operators act on lifetime value.

## The data model

Status lives in two places, **spelled differently** (this trips people up):

| Grain | JSONB path | Cancelled value |
| --- | --- | --- |
| Order (header) | `sweed_orders.raw_json -> 'invoiceStatus' ->> 'name'` | `'Cancelled'` (British, double-L) |
| Line (item) | `raw_item -> 'invoiceItemStatus' ->> 'name'` | `'Canceled'` (American, single-L) |

- An order can be **fully cancelled** (header `Cancelled`) or have some
  **voided lines** inside an otherwise-live order (line `Canceled`).
- Both are matched **case-insensitively** against taxonomy drift.
- Orders predating the status field (pre-2026-05) carry no status; we
  `coalesce(..., '')` so they read as non-cancelled (we cannot prove they
  were cancelled, so we keep them).

## The rule

1. **Default: exclude cancelled.** Every total / count / average / "Nth
   purchase" ordinal / first-vs-returning split / fulfillment-payment-
   category split over `sweed_orders` (or `sweed_order_items_flat`) must
   exclude cancelled orders (and, at line grain, cancelled lines).
2. **Use the canonical helper — never re-implement the predicate.**
   `helios/src/server/db/sweedOrderStatus.ts` is the single source of truth:
   - `nonCancelledOrderSql(alias?)` / `nonCancelledOrderPredicateSql(alias?)`
     — header grain (clause form has a leading `and `; predicate form is
     bare for `CASE WHEN` / `ON`).
   - `nonCancelledLineSql(alias?)` / `nonCancelledLinePredicateSql(alias?)`
     — line grain over `sweed_order_items_flat`.
3. **Including cancelled requires an explicit opt-out.** A metric that
   genuinely wants cancellations in (e.g. "orders submitted regardless of
   completion", "average cancelled order value") must say so in a comment
   marker `sweed-cancelled-intentional: <reason>` next to the aggregate.
   That marker is recognised by the guard test (below).
4. **Put the predicate in the right place.** For an inner aggregate, add it
   to that subquery's `where`. For a `LEFT JOIN sweed_orders ... GROUP BY`,
   add it to the **`ON` clause**, so rows with only cancelled/no orders
   still appear with a zero count/spend instead of disappearing.

## Guardrail

`helios/src/server/db/sweedOrderStatus.guard.test.ts` is a static test
(part of `npm run check`) that fails the build if any server SQL template
sums an order-header dollar column (`grand_total_dollars` /
`subtotal_dollars`) over `sweed_orders` without the canonical helper, an
inline `invoiceStatus` predicate, or the `sweed-cancelled-intentional:`
opt-out marker. If you add a real-money rollup, the guard will remind you.

## Known gaps / caveats

- **Returns & refunds are NOT ingested yet.** There is no `sweed_returns` /
  `sweed_refunds` table; Helios only sees the original sale, so a refunded
  order still counts at full value. This is a separate data-source gap (see
  the `returns-refunds` missing-data card in
  `helios/src/server/budtenderAnalytics/budtenderAnalyticsQueries.ts`), not
  something the cancelled-order predicate covers. When refund ingest lands,
  "net of refunds" becomes its own exclusion concern.
- **`raw_json` drain durability.** The raw-json drain job
  (`configWorkersSweedOrdersRawJsonDrainJob`) nulls `sweed_orders.raw_json`
  for aged rows. After that, the status is unreadable and the row reads as
  non-cancelled (via `coalesce('')`). For orders newer than the drain
  horizon this is fine; for older drained orders the status is simply
  unknown. The durable fix is a normalised `sweed_orders.invoice_status_*`
  column populated at ingest and backfilled, with the helper preferring the
  column and falling back to `raw_json`; the drain must then preserve the
  column. This is a follow-up (needs a schema migration → operator
  approval).
