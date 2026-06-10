-- Down for 067: drop the warehouse location assignments table.
--
-- This only drops Helios's freshness-accelerator record. The authoritative
-- location values live in Sweed (`internalTrackCode`) and are mirrored by
-- `sweed_package_snapshots`, so dropping this table loses no source data.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

drop table if exists warehouse_location_assignments;

commit;

\echo 'Migration 067 down complete.'
