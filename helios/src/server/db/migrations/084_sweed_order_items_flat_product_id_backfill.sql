-- Backfill the typed sweed_order_items_flat.product_id column for the
-- CRM Segment Analysis SUBCATEGORY affinity cut (virusdave/top-level#12).
--
-- WHY: migration 060 ADDED product_id (bigint, from raw_item #>>
-- '{product,id}') and the ingest tail-fill populates it for every
-- TOUCHED invoice going forward, but the one-time backfill in 060 did
-- not stick for the historical rows — a live audit found only 459 of
-- ~62.7k rows carried a typed product_id while raw_item #>> '{product,id}'
-- is present and numeric on 100% of rows. Subcategory affinity maps each
-- order line to catalog_groups.subcategory_name via
-- catalog_group_products(product_id) [indexed], so it needs the typed,
-- index-friendly column rather than a per-row JSON extraction on the hot
-- read path. This is the same guarded regex cast 060/ingest use, so the
-- value is identical to what ingest would write. Idempotent (only touches
-- rows still missing a value), so it is safe to re-run.

\set ON_ERROR_STOP on
\echo 'Running migration 084: backfill sweed_order_items_flat.product_id...'

begin;
set local lock_timeout = '10s';
set local statement_timeout = '5min';
update sweed_order_items_flat f
   set product_id = case
         when nullif(f.raw_item #>> '{product,id}', '') ~ '^\d+$'
           then (f.raw_item #>> '{product,id}')::bigint
         else null
       end
 where f.product_id is null
   and nullif(f.raw_item #>> '{product,id}', '') is not null;
commit;

analyze sweed_order_items_flat;

\echo 'Migration 084 complete.'
