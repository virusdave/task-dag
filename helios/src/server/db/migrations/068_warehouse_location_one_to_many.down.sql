-- Down for 068: restore the 1-to-1 (dealer_id, location_code) primary key.
--
-- NOTE: this can only succeed if the data currently satisfies uniqueness on
-- (dealer_id, location_code). If 1-to-many assignments were made while 068
-- was live, deduplicate before running this. The forward migration is the
-- intended state; this down is provided for completeness.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

drop index if exists warehouse_location_assignments_dealer_location_idx;

alter table warehouse_location_assignments
  add constraint warehouse_location_assignments_pkey
  primary key (dealer_id, location_code);

commit;

\echo 'Migration 068 down complete.'
