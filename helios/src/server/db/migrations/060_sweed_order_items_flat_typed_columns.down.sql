-- Inverse of D1a (060): drop the typed product columns and the
-- window-scan index from sweed_order_items_flat.
--
-- Safe to run only after every reader that uses product_id /
-- product_category_name has been reverted to the raw_json path.

\set ON_ERROR_STOP on
\timing on

drop index concurrently if exists sweed_order_items_flat_dealer_pay_idx;

begin;
set local lock_timeout = '5s';
alter table sweed_order_items_flat
  drop column if exists product_id,
  drop column if exists product_category_name;
commit;
