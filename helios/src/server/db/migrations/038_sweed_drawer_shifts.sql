-- Migration 038: sweed_drawer_shifts + sweed_drawer_shift_sessions
--                 + sweed_drawer_shifts_ingest_highwater
--
-- Supersedes the v1 shape from migration 036 (`sweed_shifts` +
-- `sweed_shifts_ingest_highwater`). The v1 design was authored
-- against a guessed envelope for `store.sale.shift.list`; the first
-- live ingest after 036 (2026-05-26) revealed that the RPC actually
-- returns DRAWER / hardware-till shifts with a nested `sessions[]`
-- array of per-cashier users — NOT one row per per-employee shift.
--
-- Operator decision (FreshlyBakedNYC/automation#27, 2026-05-26):
-- use **Option A** — model the real envelope. The
-- `cashier.transactions_per_hour` metric backed by this layer
-- becomes a rough "transactions per on-the-clock cashier-hour"
-- approximation: a drawer-shift contributes `duration *
-- count(sessions[])` cashier-hours to its bucket. A future v2 can
-- use `sweed_orders.cashier_user_id` (added in 036, retained here)
-- to do exact per-cashier attribution.
--
-- This migration:
--   * Drops the v1 `sweed_shifts` and `sweed_shifts_ingest_highwater`
--     tables (safe — the v1 ingest only ever produced 0-row inserts
--     because of the envelope mismatch, so no historical data is at
--     risk).
--   * RETAINS `sweed_orders.cashier_user_id` from 036 — it's a real,
--     correctly-populated column the future v2 metric needs.
--   * Creates the new drawer-shift tables + per-dealer highwater.
--
-- Idempotent: `drop table if exists` plus the schema file's
-- `create ... if not exists`.

\echo 'Running migration 038: sweed_drawer_shifts + sweed_drawer_shift_sessions + sweed_drawer_shifts_ingest_highwater...'

drop table if exists sweed_shifts;
drop table if exists sweed_shifts_ingest_highwater;

\i ../schema/sweedDrawerShifts.sql

\echo 'Migration 038 complete.'
