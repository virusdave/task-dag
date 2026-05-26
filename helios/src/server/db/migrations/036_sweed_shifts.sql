-- Migration 036: sweed_shifts + sweed_shifts_ingest_highwater
--                 (+ sweed_orders.cashier_user_id)
--
-- Adds the helios-owned mirror of historical Sweed cashier/employee
-- shifts plus the per-dealer highwater/backfill cursor row, and
-- adds the `cashier_user_id` column to `sweed_orders` so the
-- cashier-throughput metric can join orders to the shift that was
-- in progress when each invoice closed. Backs the worker added
-- under FreshlyBakedNYC/automation#27 (the cashier-throughput
-- unblocker under the #22 ingest umbrella; remaining blocker for
-- #21's P5).
--
-- Idempotent: the schema file uses `create ... if not exists` and
-- `alter table ... add column if not exists`, so this migration is
-- safe to re-run.

\echo 'Running migration 036: sweed_shifts + sweed_shifts_ingest_highwater + sweed_orders.cashier_user_id...'

\i ../schema/sweedShifts.sql

\echo 'Migration 036 complete.'
