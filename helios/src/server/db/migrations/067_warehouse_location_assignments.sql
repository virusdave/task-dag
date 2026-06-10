-- Migration 067: warehouse location assignments
--
-- Backs the "Warehouse Locations" packing page. When an operator scans
-- the package living in a physical shelf location, Helios writes that
-- location string into the package's Sweed `internalTrackCode`. Sweed is
-- the source of truth, but the per-package snapshot mirror
-- (`sweed_package_snapshots`, polled every 5 min) lags by up to a poll
-- cycle. That lag makes a mirror-only "is this location already used?"
-- check unsound during a rapid shelf run.
--
-- This table is Helios's own immediately-consistent record of the most
-- recent assignment per (dealer, location) and per (dealer, package). It
-- is written AFTER the Sweed RPC succeeds and is used to:
--   * enforce 1-to-1 location<->package codes without waiting for the
--     snapshot to catch up (operator rule: inventory codes are 1-1),
--   * drop a just-assigned package off the audit list instantly,
--   * show occupied locations during a shelf run.
-- The snapshot mirror eventually agrees (it ingests internalTrackCode),
-- so this table is a freshness accelerator, not a divergent source.
--
-- Invariants:
--   * PRIMARY KEY (dealer_id, location_code)        -> a location code is
--     held by at most one package.
--   * UNIQUE      (dealer_id, inventory_item_id)     -> a package holds at
--     most one location code (re-assigning replaces the prior row).
--
-- Idempotent: `create table if not exists`.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

create table if not exists warehouse_location_assignments (
  dealer_id          bigint not null,
  location_code      text   not null,
  inventory_item_id  text   not null,
  metrc_tag          text,
  product_name       text,
  assigned_by_user_id bigint,
  assigned_at        timestamptz not null default now(),

  primary key (dealer_id, location_code),
  unique (dealer_id, inventory_item_id)
);

commit;

\echo 'Migration 067 complete.'
