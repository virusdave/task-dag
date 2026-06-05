-- D1a: enrich sweed_order_items_flat with typed product columns.
--
-- Helios DB-cost epic phase D1 (virusdave/top-level#11), step 1 of N.
--
-- Background: sweed_order_items_flat (migration 048) is the
-- materialised, 1:1 expansion of sweed_orders.raw_json->'items'. The
-- ingest job already tail-fills it in the same transaction as the
-- sweed_orders insert, and a live audit confirmed it is a faithful
-- mirror (0 skipped items, 0 qty-fallback rows, 0 row mismatches vs
-- raw_json). D1 migrates the request-time JSONB-unrolling readers in
-- catalog-analytics / metrics onto this table so they stop unrolling
-- sweed_orders.raw_json on every request (and so F5 can later drain
-- that blob).
--
-- The readers need two fields that are currently only inside the
-- raw_item blob:
--   * product id — lives at raw_item #>> '{product,id}' (e.g. 43709).
--     NOTE: this is NOT raw_item->>'productId' (that key does not
--     exist; the existing catalog_product_mapping join on
--     item->>'productId' is a pre-existing latent bug, preserved for
--     now and fixed separately under a flagged change).
--   * product category name — raw_item #>> '{productCategory,name}'.
--
-- This migration is purely ADDITIVE (nullable columns), so it is
-- safe to apply BEFORE the ingest-code deploy: existing code ignores
-- the new columns. The ingest job populates them going forward; this
-- file backfills the existing rows.
--
-- product_id is bigint (the domain treats product ids numerically,
-- e.g. sweed_package_current.product_id). A guarded regex cast keeps
-- ingest/backfill from ever failing on a non-numeric surprise.

\set ON_ERROR_STOP on
\timing on

-- (1) Add the columns (fast, metadata-only; brief ACCESS EXCLUSIVE).
begin;
set local lock_timeout = '5s';
alter table sweed_order_items_flat
  add column if not exists product_id            bigint,
  add column if not exists product_category_name text;
commit;

-- (2) Window-scan covering index. Several D1 readers filter by
-- (dealer_id, pay_time) and aggregate line fields without an
-- inventory_item_id predicate; the existing
-- (dealer_id, inventory_item_id, pay_time) index does not serve
-- those. CONCURRENTLY so we never take ACCESS EXCLUSIVE on the
-- live table. Must run outside a transaction block.
create index concurrently if not exists
  sweed_order_items_flat_dealer_pay_idx
  on sweed_order_items_flat (dealer_id, pay_time)
  include (inventory_item_id, invoice_id, qty, revenue,
           product_id, product_category_name);

-- (3) One-time backfill of existing rows from raw_item. Idempotent
-- (only touches rows still missing a value), so it is safe to re-run.
-- ~60k rows / small per-row work; bounded by lock_timeout so it
-- fails fast rather than wedging the concurrent ingest tail-fill.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '5min';
update sweed_order_items_flat f
   set product_id = case
         when nullif(f.raw_item #>> '{product,id}', '') ~ '^\d+$'
           then (f.raw_item #>> '{product,id}')::bigint
         else null
       end,
       product_category_name = nullif(f.raw_item #>> '{productCategory,name}', '')
 where f.product_id is null
    or f.product_category_name is null;
commit;

analyze sweed_order_items_flat;
