-- Down for 094: drop the prospective-classifier hint-bundle storage.
--
-- pending_purchase_hint_bundles + pending_purchase_hint_documents are the
-- Helios-side hint-bundle storage for the prospective pending-purchase
-- classifier (child FreshlyBakedNYC/automation#54 C2, parent
-- virusdave/top-level#33). Dropping them discards all stored hint material
-- (pasted menus / POs / operator notes) and any C3-extracted facts; only do
-- this in a full teardown/rollback of the hint-bundle brick. Drop the child
-- table first (it FKs the bundles).

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

drop table if exists pending_purchase_hint_documents;
drop table if exists pending_purchase_hint_bundles;

commit;

\echo 'Migration 094 down complete.'
