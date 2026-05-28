-- Migration 040: covering indexes for the new /metrics/budtenders
-- analytics page (virusdave/top-level#7).
--
-- The page makes ONE backend round-trip to /api/budtender-analytics,
-- which runs two queries against sweed_orders (totals+daily, and the
-- per-cashier aggregate CTE) plus one join across
-- sweed_drawer_shifts × sweed_drawer_shift_sessions for cashier-hour
-- overlap.
--
-- The existing indexes on sweed_orders cover (pay_time) and
-- (dealer_id, pay_time), and on sweed_drawer_shift_sessions cover
-- (dealer_id, user_id). They're correct but not covering — every
-- aggregate row visit currently touches the heap to read
-- grand_total_dollars / subtotal_dollars / discount_dollars / etc.
-- At ~tens of thousands of rows over the 90-day default window this
-- shows up in EXPLAIN as the dominant cost.
--
-- These indexes are NOT a substitute for correctness — every metric
-- still derives from real, immediate row state. They just keep the
-- new endpoint snappy under the operator's "never silently stale,
-- but be aggressive on performance" mandate.
--
-- Idempotent: every CREATE INDEX uses `if not exists`. We do NOT
-- CONCURRENTLY here because the migration runner wraps each file in
-- a transaction; the table is small enough that a plain CREATE is
-- fine. Switch to CONCURRENTLY (and split into separate
-- non-transactional files) if/when the table grows past ~10M rows.

create index if not exists sweed_orders_budtender_range_cover_idx
  on sweed_orders (dealer_id, pay_time desc)
  include (
    cashier_user_id,
    customer_id,
    is_guest,
    first_time_for_customer,
    grand_total_dollars,
    subtotal_dollars,
    tax_dollars,
    discount_dollars,
    fulfillment_type,
    payment_method
  );

-- Cashier-pivoted scan for the per-cashier_agg CTE. Predicate index
-- on `cashier_user_id IS NOT NULL` keeps the index small (we don't
-- need unattributed rows here — the totals/daily query handles
-- them).
create index if not exists sweed_orders_budtender_cashier_range_cover_idx
  on sweed_orders (dealer_id, cashier_user_id, pay_time desc)
  include (
    customer_id,
    is_guest,
    first_time_for_customer,
    grand_total_dollars,
    subtotal_dollars,
    tax_dollars,
    discount_dollars,
    fulfillment_type,
    payment_method
  )
  where cashier_user_id is not null;

-- Same-customer baseline support — we partition by customer_id in
-- window functions over the orders CTE, so a covering index on
-- (dealer_id, customer_id, pay_time) lets the planner stream-sort
-- the relevant subset without touching the heap.
create index if not exists sweed_orders_budtender_customer_range_cover_idx
  on sweed_orders (dealer_id, customer_id, pay_time desc)
  include (
    cashier_user_id,
    grand_total_dollars,
    is_guest,
    first_time_for_customer,
    fulfillment_type,
    payment_method
  )
  where customer_id is not null;

-- Drawer-shift sessions are joined to drawer-shifts via
-- (dealer_id, sweed_shift_id) and grouped by user_id. The existing
-- (dealer_id, user_id) index handles the group-by; we add a small
-- covering index on the join key so the lookup into drawer-shifts
-- can avoid heap reads. Drawer-shifts itself already has
-- (dealer_id, open_date) and a partial index on close_date — both
-- exactly what the overlap predicate uses — so no further index
-- there.
create index if not exists sweed_drawer_shift_sessions_user_join_cover_idx
  on sweed_drawer_shift_sessions (dealer_id, sweed_shift_id)
  include (user_id);
