-- Migration 032: sweed_package_snapshots + ingest state
--
-- Adds the helios-owned versioned mirror of every Sweed package
-- (inventoryItemId), polled every 5 min during 08:00-02:00 ET. Backs
-- the worker added under FreshlyBakedNYC/automation#24 (sibling of #22,
-- unblocker for #21 — Business & Performance Metrics page tree).
--
-- Idempotent: the schema file uses `create ... if not exists` and
-- `create or replace` everywhere, so this migration is safe to re-run.

\echo 'Running migration 032: sweed_package_snapshots + ingest state...'

\i ../schema/sweedPackageSnapshots.sql

\echo 'Migration 032 complete.'
