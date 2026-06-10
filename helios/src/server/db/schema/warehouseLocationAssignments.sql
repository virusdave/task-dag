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
-- Invariants (after migration 068):
--   * UNIQUE (dealer_id, inventory_item_id) -> a package maps to at most one
--     location code (upsert on this key when (re)assigning). This is the
--     table's effective key.
--   * A location code maps to MANY packages (1-to-many): co-located packages
--     such as a product split across a 4-pack and a 1-pack in one bin all
--     carry the same code. The (dealer_id, location_code) index is therefore
--     a plain lookup index, NOT unique.
--
-- Created by migration 067_warehouse_location_assignments.sql; the
-- (dealer_id, location_code) primary key was dropped and the lookup index
-- added by migration 068_warehouse_location_one_to_many.sql.

create table if not exists warehouse_location_assignments (
  dealer_id          bigint not null,
  location_code      text   not null,
  inventory_item_id  text   not null,
  metrc_tag          text,
  product_name       text,
  assigned_by_user_id bigint,
  assigned_at        timestamptz not null default now(),

  unique (dealer_id, inventory_item_id)
);

create index if not exists warehouse_location_assignments_dealer_location_idx
  on warehouse_location_assignments (dealer_id, location_code);
