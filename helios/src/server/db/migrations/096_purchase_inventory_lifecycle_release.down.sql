-- Down migration for 096: drop the L2 release columns and revert the
-- runs state CHECK to its L1 value set (no release_in_progress/released).
--
-- NOTE: reverting the state check will FAIL if any run is currently in
-- 'release_in_progress' or 'released'. That is intentional — a down
-- migration must not silently strand a row in a state the constraint
-- forbids. Move such runs back to 'priced_verified' (or 'blocked') first
-- if you truly need to roll back.

\set ON_ERROR_STOP on

\echo 'Reverting migration 096: purchase inventory lifecycle release (L2)...'

begin;
set local lock_timeout = '5s';

alter table purchase_inventory_lifecycle_items
  drop column if exists release_transfer_attempted_at,
  drop column if exists release_transferred_at,
  drop column if exists release_verified_at,
  drop column if exists release_stock_location,
  drop column if exists release_stock_location_id,
  drop column if exists release_stock_type_id,
  drop column if exists release_current_qty,
  drop column if exists release_last_error;

alter table purchase_inventory_lifecycle_runs
  drop column if exists release_target_location_id,
  drop column if exists release_target_location_name,
  drop column if exists release_target_stock_type_id,
  drop column if exists release_requested_at,
  drop column if exists released_at,
  drop column if exists release_attempt_id,
  drop column if exists release_lease_expires_at,
  drop column if exists release_last_error;

alter table purchase_inventory_lifecycle_runs
  drop constraint if exists purchase_inventory_lifecycle_runs_state_check;

alter table purchase_inventory_lifecycle_runs
  add constraint purchase_inventory_lifecycle_runs_state_check
  check (state in (
    'not_started',
    'awaiting_receive_to_quarantine',
    'quarantined',
    'market_refresh_pending',
    'market_ready',
    'pricing_pending',
    'awaiting_price_approval',
    'price_apply_pending',
    'priced_verified',
    'blocked'
  ));

commit;

\echo 'Migration 096 reverted.'
