-- Inverse of 103: remove low-inventory physical-count audit history.
--
-- DESTRUCTIVE: this permanently drops every captured physical count and its
-- actor/Sweed-snapshot audit data. Use only after the capture code is rolled
-- back and with explicit operator acceptance of that data loss.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

drop table if exists low_inventory_physical_counts;

commit;

\echo 'Migration 103 down complete.'
