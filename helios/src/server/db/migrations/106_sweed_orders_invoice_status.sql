-- Migration 106: persist Sweed invoice status outside sweed_orders.raw_json.
--
-- pg_stat_statements showed the canonical cancellation predicate in thousands
-- of interactive queries. Reading the status from raw_json forces PostgreSQL
-- to fetch and inspect a large, drained-after-30-days envelope for one short
-- string. The typed column makes status durable before the envelope drain and
-- lets the existing dealer/time covering index serve those reads without a
-- heap visit.
--
-- Expand/deploy order:
--   1. Apply this additive migration and verify the sentinel.
--   2. Deploy the ingest/helper change that writes and reads the new column.
-- Old code ignores the new column, so the migration is safe to apply first.

\set ON_ERROR_STOP on
\timing on

\echo 'Running migration 106: sweed_orders invoice status projection...'

begin;
set local lock_timeout = '5s';

alter table sweed_orders
  add column if not exists invoice_status_name text;

commit;

-- Release the metadata-only ALTER's ACCESS EXCLUSIVE lock before scanning and
-- updating rows. The updates retain only ordinary row/table writer locks.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '2min';

-- Reassert migration 061's cashier backfill while the recent envelopes are
-- present. This makes the new column a durable proof that both projections
-- have run, allowing the old 30-second migration sentinel to stop rescanning
-- raw_json for recoverable cashier ids (25k+ calls in pg_stat_statements).
update sweed_orders
   set cashier_user_id = (raw_json->>'creatorId')::bigint
 where cashier_user_id is null
   and (raw_json->>'creatorType') = '1'
   and nullif(raw_json->>'creatorId', '') ~ '^\d+$';

-- Only the undrained recent tail can still supply status. Rows whose envelope
-- was already drained remain NULL and retain the existing "unknown means not
-- proven cancelled" behavior. The predicate never falls back to raw_json.
update sweed_orders
   set invoice_status_name = nullif(btrim(raw_json->'invoiceStatus'->>'name'), '')
 where invoice_status_name is null
   and raw_json is not null
   and nullif(btrim(raw_json->'invoiceStatus'->>'name'), '') is not null;

commit;

-- Build the replacement before dropping the old covering index, so reads keep
-- an efficient path throughout. CONCURRENTLY keeps writes available; these
-- statements intentionally run outside a transaction.
set lock_timeout = '5s';
set statement_timeout = '5min';

select 'drop index concurrently if exists sweed_orders_budtender_range_cover_v2_idx'
 where exists (
   select 1
     from pg_index i
     join pg_class c on c.oid = i.indexrelid
    where c.relname = 'sweed_orders_budtender_range_cover_v2_idx'
      and not i.indisvalid
 )
\gexec

create index concurrently if not exists
  sweed_orders_budtender_range_cover_v2_idx
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
    payment_method,
    invoice_status_name,
    invoice_id
  );

drop index concurrently if exists sweed_orders_budtender_range_cover_idx;

analyze sweed_orders;

reset lock_timeout;
reset statement_timeout;

\echo 'Migration 106 complete.'
