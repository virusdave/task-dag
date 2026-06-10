-- Migration 068: warehouse locations are 1-to-many with packages
--
-- A physical shelf location holds MANY packages (e.g. a product split across
-- a 4-pack and a 1-pack sitting in the same bin), so the old
-- PRIMARY KEY (dealer_id, location_code) — which forced one package per
-- location — is wrong. Drop it. A package still has at most ONE location,
-- so the UNIQUE (dealer_id, inventory_item_id) constraint stays and remains
-- the table's effective key.
--
-- Add a non-unique (dealer_id, location_code) index so "what packages are at
-- this location?" / shelf-map reads stay index-served.
--
-- Idempotent and data-preserving: only constraints/indexes change; existing
-- assignment rows are untouched.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

alter table warehouse_location_assignments
  drop constraint if exists warehouse_location_assignments_pkey;

create index if not exists warehouse_location_assignments_dealer_location_idx
  on warehouse_location_assignments (dealer_id, location_code);

commit;

\echo 'Migration 068 complete.'
