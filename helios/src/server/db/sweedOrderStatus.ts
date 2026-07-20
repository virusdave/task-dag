// ============================================================================
// Canonical Sweed order/line "is this a real transaction?" SQL predicates.
//
// THIS IS THE SINGLE SOURCE OF TRUTH. Do not re-implement the cancelled-order
// or cancelled-line predicate inline anywhere else — import from here. (We
// previously had ~4 hand-copied duplicates guarded only by "keep in sync"
// comments; they drifted and shipped multiple variants of the same bug where
// cancelled orders inflated lifetime-spend / order-count / receipts totals.)
//
// WHY THIS MATTERS
//   A fully-cancelled Sweed order is NOT a transaction. It must never count
//   toward order counts, sales/receipts dollars, basket size, averages, the
//   "Nth purchase" / first-vs-returning ordinal, or fulfillment / payment /
//   category splits. Sweed's feed nonetheless reports a non-zero header
//   subtotal / grand_total on cancelled orders, and cancellations are a large
//   fraction of orders (~18% observed), so omitting this guard silently and
//   materially inflates every header-grain rollup.
//
//   Default to EXCLUDING cancelled rows. Only include them when a metric
//   EXPLICITLY means to (e.g. "orders submitted regardless of completion",
//   "average cancelled order value", or a raw ingest/row-count diagnostic) —
//   and when you do, leave a comment saying so (see the static guard test
//   `sweedOrderStatus.guard.test.ts`).
//
// STATUS LIVES IN TWO PLACES, SPELLED DIFFERENTLY
//   * ORDER (header) grain:  invoice_status_name                    == 'Cancelled'
//   * LINE (item)  grain:    raw_item->'invoiceItemStatus'->>'name'  == 'Canceled'
//   (Yes, the header uses the British double-L and the line uses the American
//   single-L. Both are matched case-insensitively here against taxonomy drift.)
//
// PRE-STATUS / ALREADY-DRAINED ROWS
//   `coalesce(..., '')` keeps rows that carry NO status (pre-2026-05 orders or
//   rows whose envelope was drained before migration 106) INCLUDED. That is
//   intentional: we cannot prove they were cancelled, so we treat them as real.
//   New status values are persisted at ingest and survive raw_json draining.
//
// API
//   *PredicateSql() returns a bare boolean ("<expr> <> 'cancelled'") for use
//   inside CASE WHEN / ON / composed boolean contexts.
//   *Sql() returns the same prefixed with "and " for dropping into a WHERE.
// ============================================================================

function aliasPrefix(alias: string): string {
  return alias.length > 0 ? `${alias}.` : ''
}

/** Bare boolean: order (header) is not fully cancelled. `alias` is the
 *  `sweed_orders` table alias ('' for an unaliased `from sweed_orders`). */
export function nonCancelledOrderPredicateSql(alias = ''): string {
  const p = aliasPrefix(alias)
  return `lower(coalesce(${p}invoice_status_name, '')) <> 'cancelled'`
}

/** WHERE-clause form (leading `and `) of {@link nonCancelledOrderPredicateSql}. */
export function nonCancelledOrderSql(alias = ''): string {
  return `and ${nonCancelledOrderPredicateSql(alias)}`
}

/** Bare boolean: line (item) is not voided/cancelled. `alias` is the
 *  `sweed_order_items_flat` table alias (defaults to the common `f`). */
export function nonCancelledLinePredicateSql(alias = 'f'): string {
  const p = aliasPrefix(alias)
  return `lower(coalesce(${p}raw_item->'invoiceItemStatus'->>'name', '')) <> 'canceled'`
}

/** WHERE-clause form (leading `and `) of {@link nonCancelledLinePredicateSql}. */
export function nonCancelledLineSql(alias = 'f'): string {
  return `and ${nonCancelledLinePredicateSql(alias)}`
}
