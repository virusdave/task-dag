-- Inverse of 106. Revert application code before running this file.
-- Restores the original covering index before removing the typed status.

\set ON_ERROR_STOP on
\timing on

set lock_timeout = '5s';
set statement_timeout = '5min';

select 'drop index concurrently if exists sweed_orders_budtender_range_cover_idx'
 where exists (
   select 1
     from pg_index i
     join pg_class c on c.oid = i.indexrelid
    where c.relname = 'sweed_orders_budtender_range_cover_idx'
      and not i.indisvalid
 )
\gexec

create index concurrently if not exists
  sweed_orders_budtender_range_cover_idx
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

drop index concurrently if exists sweed_orders_budtender_range_cover_v2_idx;

begin;
set local lock_timeout = '5s';
alter table sweed_orders drop column if exists invoice_status_name;
commit;

reset lock_timeout;
reset statement_timeout;

\echo 'Migration 106 down complete.'
