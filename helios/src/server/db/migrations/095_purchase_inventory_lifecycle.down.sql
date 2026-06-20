-- Down migration for 095: drop the purchase inventory lifecycle tables
-- and revert the Lit Alerts enqueue_reason check to its pre-095 value
-- set (without 'purchase-lifecycle').
--
-- NOTE: reverting the enqueue_reason check will FAIL if any row in
-- pending_litalerts_refresh_queue still carries enqueue_reason =
-- 'purchase-lifecycle'. That is intentional — a down migration must not
-- silently corrupt or orphan live queue rows. Drain/relabel those rows
-- first if you truly need to roll back.

\set ON_ERROR_STOP on

\echo 'Reverting migration 095: purchase inventory lifecycle (L1)...'

begin;
set local lock_timeout = '5s';

drop table if exists purchase_inventory_lifecycle_items;
drop table if exists purchase_inventory_lifecycle_runs;

alter table pending_litalerts_refresh_queue
  drop constraint if exists pending_litalerts_refresh_queue_enqueue_reason_check;

alter table pending_litalerts_refresh_queue
  add constraint pending_litalerts_refresh_queue_enqueue_reason_check
  check (enqueue_reason in (
    'rolling',
    'proposal-source',
    'pending-purchase',
    'brand-alarm',
    'in-stock-alarm',
    'manual'
  ));

commit;

\echo 'Migration 095 reverted.'
