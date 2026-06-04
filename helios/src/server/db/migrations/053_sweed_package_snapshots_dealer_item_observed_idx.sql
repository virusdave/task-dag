-- Composite covering index on `sweed_package_snapshots` for the
-- per-(dealer, inventory_item) latest-snapshot lookup pattern.
--
-- virusdave/top-level#12 / FreshlyBakedNYC/automation#40, phase D2.
--
-- The /admin/customers/check-ins list query and its cashier-tablet
-- twin both compute a per-customer "favorite category" / "favorite
-- product" by joining sweed_order_items_flat → latest snapshot per
-- (dealer_id, inventory_item_id), via:
--
--   select category_name, product_name
--     from sweed_package_snapshots
--    where dealer_id = $1 and inventory_item_id = $2
--    order by observed_at_max desc
--    limit 1
--
-- The existing PK `(dealer_id, inventory_item_id, observed_at_min)`
-- can constrain by the two equality columns but does not sort by
-- `observed_at_max`, so the planner has to fetch all snapshot
-- versions for that package and sort them in memory. Per-package
-- version history is typically small, but a heavy customer with
-- 3000 line items × dozens of snapshot versions each adds up.
--
-- This composite index lets the planner use a single index seek +
-- include payload, skipping the sort and the heap altogether for
-- this read pattern. Per-row cost drops from O(versions_per_pkg ×
-- heap_lookup) to O(1) buffer reads.
--
-- Cost shape: one additional btree to maintain on insert/update of
-- snapshots. The sweed_package_snapshots ingest job is the only
-- writer; current write rate is low (a handful of rows per minute
-- per dealer in steady state), and the include payload is tiny
-- (~50 bytes/row for two text columns), so the per-write overhead
-- is negligible.
--
-- Idempotent: `create index if not exists`. Concurrent so the
-- migration doesn't take an ACCESS EXCLUSIVE lock on the snapshots
-- table — at our current row counts this would only block writes
-- for a few seconds, but concurrent is the safe default.

\echo 'Running migration 053: sweed_package_snapshots_dealer_item_observed_idx...'

create index concurrently if not exists
  sweed_package_snapshots_dealer_item_observed_max_idx
  on sweed_package_snapshots (dealer_id, inventory_item_id, observed_at_max desc)
  include (category_name, product_name);

\echo 'Migration 053 complete.'
