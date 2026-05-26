-- 029_catalog_litalerts_brand_overrides.sql
--
-- Manual catalog-brand ↔ LitAlerts-brand mapping overrides
-- (issue #20 follow-on). The default mapping is computed
-- heuristically in scripts/litalerts-brand-mapping-sanity.mts
-- (exact / case-insensitive / normalized / token-overlap tiers)
-- but the heuristic can't always pick the right LitAlerts brand
-- when our catalog name and the LitAlerts directory name diverge
-- (e.g. "Grass Roots" ↔ "Grassroots (Curaleaf)"). This table
-- stores the operator-confirmed mapping; lookups prefer it over
-- the heuristic and fall back when no override exists.
--
-- A null `litalerts_brand_id` is a legitimate operator state:
-- "I have reviewed this catalog brand and confirm there is no
-- LitAlerts equivalent (yet)". A missing row means "not yet
-- reviewed; the heuristic decides".

create table if not exists catalog_litalerts_brand_overrides (
  catalog_brand_name  text primary key,
  litalerts_brand_id  bigint,                       -- null = explicitly unmapped
  litalerts_brand_name text,                        -- denormalised for display when looking up by name later
  set_by_user_id      text,
  set_at              timestamptz not null default now(),
  notes               text
);

create index if not exists catalog_litalerts_brand_overrides_brand_idx
  on catalog_litalerts_brand_overrides (litalerts_brand_id);

comment on table catalog_litalerts_brand_overrides is
  'Operator-confirmed mapping from catalog_groups.brand_name → litalerts_brands.brand_id. Used by the Catalog → Market Data review surface and the pricing comp pivot to ground brand lookups in a single source of truth instead of name-similarity heuristics.';
