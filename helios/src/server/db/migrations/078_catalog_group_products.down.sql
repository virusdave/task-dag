-- Down for 078: drop the per-product live-state projection table.
--
-- Removes the catalog_group_products projection (Phase B;
-- FreshlyBakedNYC/automation#45 / virusdave/top-level#16). The table is a
-- pure derivative of catalog_groups.live_state_json, so dropping it loses
-- nothing that can't be rebuilt by re-running 078. NOTE: server code at
-- familyKeyVersion 2 reads this table for the review queue's size-aware
-- family grouping, so only run this down-migration after rolling the
-- server back to a build that does not depend on it.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

drop table if exists catalog_group_products;

commit;

\echo 'Migration 078 down complete.'
