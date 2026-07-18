-- Inverse of 104: remove normalized vendor/brand data, including operator edits.
-- DESTRUCTIVE: use only after dependent code is rolled back and data loss accepted.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

drop table if exists vendor_brand_associations;
drop table if exists vendors;

commit;

\echo 'Migration 104 down complete.'
