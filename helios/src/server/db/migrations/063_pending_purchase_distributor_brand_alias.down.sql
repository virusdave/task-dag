-- Down for 063: drop the distributor alias support.
--
-- Removes the partial unique index and narrows the alias_type CHECK
-- back to ('exact','prefix'). This will FAIL if any rows still use
-- alias_type='distributor'; retire/delete those first:
--   delete from pending_purchase_brand_aliases where alias_type='distributor';

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

drop index if exists pending_purchase_brand_aliases_distributor_active_uq;

alter table pending_purchase_brand_aliases
  drop constraint if exists pending_purchase_brand_aliases_alias_type_check;

alter table pending_purchase_brand_aliases
  add constraint pending_purchase_brand_aliases_alias_type_check
  check (alias_type = any (array['exact'::text, 'prefix'::text]));

commit;

\echo 'Migration 063 down complete.'
