-- Migration 031: sweed_orders + sweed_orders_ingest_highwater
--
-- Adds the helios-owned mirror of completed Sweed retail invoices
-- plus the per-dealer highwater/backfill cursor row. Backs the
-- worker added under FreshlyBakedNYC/automation#22 (sibling /
-- unblocker for #21 — Business & Performance Metrics page tree).
--
-- Idempotent: the schema file uses `create ... if not exists`
-- everywhere, so this migration is safe to re-run.

\echo 'Running migration 031: sweed_orders + sweed_orders_ingest_highwater...'

\i ../schema/sweedOrders.sql

\echo 'Migration 031 complete.'
