-- warehouse_location_assignments
--
-- Helios's immediately-consistent record of the most recent warehouse
-- location <-> package assignment, written by the "Warehouse Locations"
-- packing page (POST /api/warehouse-locations/assign) AFTER the Sweed
-- `store.inventory.item.update.internaltrackcode` RPC succeeds.
--
-- Why a Helios-owned table when Sweed already stores internalTrackCode:
-- the per-package snapshot mirror (`sweed_package_snapshots`) lags by up
-- to one 5-minute poll, so a mirror-only "is this code already used?"
-- check cannot enforce the operator's 1-to-1 code<->package invariant
-- during a rapid shelf run. This table closes that window. The snapshot
-- mirror eventually ingests the same internalTrackCode, so this is a
-- freshness accelerator, not a competing source of truth.
--
-- Invariants:
--   * PRIMARY KEY (dealer_id, location_code)     -> a location code maps
--     to at most one package.
--   * UNIQUE      (dealer_id, inventory_item_id)  -> a package maps to at
--     most one location code (re-assign deletes the package's old row
--     then inserts the new one).
--
-- Created by migration 067_warehouse_location_assignments.sql.

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
