-- Migration 063: distributor-keyed brand aliases
--
-- Some distributors sell white-label product whose BRAND never appears
-- in the distributor product name (e.g. "Dumbo Electric LLC" ships
-- "Aloha Waves" edibles named "ALOHA BLUE HAWAIIAN", "MELON WAVE",
-- "KEY LIME", …). The pending-purchase parser keys brand resolution
-- off the product name, so it has no signal for the brand and the LLM
-- fallback ends up guessing the *distributor* as the brand.
--
-- This migration extends `pending_purchase_brand_aliases` so an alias
-- can be keyed on the DISTRIBUTOR name instead of the product name:
-- a new `alias_type = 'distributor'` whose `normalized_alias_value`
-- holds the normalized distributor name and whose `brand_profile_id`
-- points at the brand that distributor always carries. The generation
-- worker consults these distributor aliases first and pins the brand
-- deterministically (skipping the LLM) when one matches.
--
-- Two schema changes:
--   1. Widen the alias_type CHECK to allow 'distributor'.
--   2. Add a partial unique index so an *active/provisional* distributor
--      alias maps to exactly one brand profile (the prior table-level
--      unique was (brand_profile_id, alias_type, normalized_alias_value),
--      which would have allowed the same distributor to point at two
--      brands). A cross-brand distributor mapping is a configuration
--      error and the worker treats it as "ambiguous -> fall through".
--
-- Idempotent: drops/re-adds the named constraint and uses
-- `create unique index if not exists`, safe to re-run.

\set ON_ERROR_STOP on
\timing on

begin;
set local lock_timeout = '5s';

alter table pending_purchase_brand_aliases
  drop constraint if exists pending_purchase_brand_aliases_alias_type_check;

alter table pending_purchase_brand_aliases
  add constraint pending_purchase_brand_aliases_alias_type_check
  check (alias_type = any (array['exact'::text, 'prefix'::text, 'distributor'::text]));

create unique index if not exists pending_purchase_brand_aliases_distributor_active_uq
  on pending_purchase_brand_aliases (normalized_alias_value)
  where alias_type = 'distributor' and status in ('active', 'provisional');

commit;

\echo 'Migration 063 complete.'
